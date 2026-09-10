// Drives the deployed spike Worker through every measurement and records the
// results as JSON. Run from this directory:
//
//   SPIKE_URL=https://… SPIKE_TOKEN=… node drive.mjs [stage…]
//
// Stages: ping hold probes search trigram. Default: all. Results accumulate in
// results/<stage>.json so a stage can be re-run alone.
import { mkdirSync, writeFileSync } from 'node:fs'

const URL_ = process.env.SPIKE_URL
const TOKEN = process.env.SPIKE_TOKEN
if (!URL_ || !TOKEN) throw new Error('SPIKE_URL and SPIKE_TOKEN required')
mkdirSync('results', { recursive: true })

const stages = process.argv.slice(2)
const want = (s) => stages.length === 0 || stages.includes(s)

async function call(path, init = {}) {
  const t = performance.now()
  const res = await fetch(URL_ + path, { ...init, headers: { 'x-spike-token': TOKEN, ...(init.headers ?? {}) } })
  const ms = Math.round(performance.now() - t)
  const body = await res.json().catch(() => ({ error: 'non-json', status: res.status }))
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
  console.log(`${path.padEnd(70)} ${String(ms).padStart(6)} ms`)
  return { ...body, _clientMs: ms }
}

const save = (stage, data) => writeFileSync(`results/${stage}.json`, JSON.stringify(data, null, 2))

/** Split a (concurrency × iterations) run across requests so no request exceeds ~600 subrequests. */
async function stampede(mode, concurrency, iterations, extra = '') {
  const perReq = Math.max(1, Math.min(iterations, Math.floor(500 / concurrency)))
  const parts = []
  for (let done = 0; done < iterations; done += perReq) {
    const n = Math.min(perReq, iterations - done)
    parts.push(await call(`/hold/stampede?mode=${mode}&concurrency=${concurrency}&iterations=${n}${extra}`))
  }
  const successes = new Set(parts.flatMap((p) => p.distinctSuccesses))
  return {
    mode,
    concurrency,
    iterations,
    requests: parts.length,
    distinctSuccesses: [...successes].sort((a, b) => a - b),
    oversellIterations: parts.reduce((a, p) => a + p.oversellIterations, 0),
    oversells: parts.flatMap((p) => p.oversells),
    statementMsMedian: parts.map((p) => p.statementMs.median),
    statementMsP95: parts.map((p) => p.statementMs.p95),
    iterationMsMedian: parts.map((p) => p.iterationMs.median),
  }
}

if (want('ping')) {
  const pings = []
  for (let i = 0; i < 7; i++) pings.push(await call('/ping'))
  save('ping', { colo: pings[0].colo, country: pings[0].country, clientRttMs: pings.map((p) => p._clientMs) })
}

if (want('hold')) {
  const out = {}
  await call('/hold/reset?onHand=1')
  out.negativeControl = await (async () => {
    const parts = []
    for (let i = 0; i < 10; i++) parts.push(await call('/hold/naive?concurrency=25&iterations=5'))
    return {
      concurrency: 25,
      iterations: 50,
      distinctSuccesses: [...new Set(parts.flatMap((p) => p.distinctSuccesses))].sort((a, b) => a - b),
      oversellIterations: parts.reduce((a, p) => a + p.oversellIterations, 0),
    }
  })()
  out.direct = []
  for (const c of [2, 10, 50, 200]) out.direct.push(await stampede('direct', c, 50))
  out.batch25 = await stampede('batch', 25, 50)
  await call('/hold/reset?onHand=5')
  out.partialQty = await stampede('direct', 3, 50, '&qty=2&onHand=5')
  await call('/hold/reset?onHand=7')
  out.mixed = await call('/hold/mixed?iterations=50')

  // External HTTP concurrency: 25 requests fired from this machine, each its own Worker invocation.
  await call('/hold/reset?onHand=1')
  const successCounts = []
  const colos = new Set()
  let oversellIterations = 0
  const reserveMs = []
  for (let iteration = 0; iteration < 50; iteration++) {
    await call('/hold/truncate')
    const now = Date.now()
    const bodies = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        fetch(`${URL_}/hold/reserve`, {
          method: 'POST',
          headers: { 'x-spike-token': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ itemId: 'sku-1', basketId: `basket-${i}`, quantity: 1, now }),
        }).then((r) => r.json()),
      ),
    )
    const granted = bodies.filter((b) => b.granted).length
    for (const b of bodies) { colos.add(b.colo); reserveMs.push(b.ms) }
    const { rows } = await call('/hold/count')
    successCounts.push(granted)
    if (granted !== 1 || rows !== 1) oversellIterations++
  }
  reserveMs.sort((a, b) => a - b)
  out.http25 = {
    concurrency: 25,
    iterations: 50,
    distinctSuccesses: [...new Set(successCounts)].sort((a, b) => a - b),
    oversellIterations,
    colos: [...colos],
    reserveMsInWorker: { median: reserveMs[Math.floor(reserveMs.length / 2)], p95: reserveMs[Math.floor(reserveMs.length * 0.95)], max: reserveMs.at(-1) },
  }
  out.batchCases = await call('/hold/batch-cases')
  save('hold', out)
}

if (want('partial')) {
  await call('/hold/reset?onHand=5')
  save('hold-partial', await stampede('direct', 3, 50, '&qty=2&onHand=5'))
}

if (want('probes')) {
  const out = { batch: [], statementBytes: [] }
  for (const n of [1000, 5000, 20000, 50000, 100000]) {
    const r = await call(`/probe/batch?n=${n}`).catch((e) => ({ n, ok: false, error: String(e.message) }))
    out.batch.push(r)
    if (!r.ok) break
  }
  for (const b of [99000, 100000, 100001]) out.statementBytes.push(await call(`/probe/stmt-bytes?bytes=${b}`))
  save('probes', out)
}

if (want('search')) {
  const out = {}
  out.schema = await call('/search/schema', { method: 'POST' })
  // The #14 shape: one Workflow step per page, one batch() per page.
  out.seedPages = []
  const PAGE = 20_000
  for (let from = 0; from < 150_000; from += PAGE) {
    out.seedPages.push(await call(`/search/seed?from=${from}&to=${from + PAGE}`, { method: 'POST' }))
  }
  out.detailPages = []
  for (let from = 0; from < 150_000; from += 10_000) {
    out.detailPages.push(await call(`/search/detail?from=${from}&to=${from + 10_000}`, { method: 'POST' }))
  }
  out.stockA = await call('/search/stock?store=store-001&skus=4000', { method: 'POST' })
  out.stockB = await call('/search/stock?store=store-002&skus=60000', { method: 'POST' })
  out.indexes = await call('/search/indexes', { method: 'POST' })
  out.fts = await call('/search/fts', { method: 'POST' })
  out.denorm = await call('/search/denorm', { method: 'POST' })
  out.measure = await call('/search/measure')
  out.reseed = await call('/search/reseed', { method: 'POST' })
  out.size = await call('/size')
  save('search', out)
}

if (want('trigram')) {
  const out = {}
  out.build = await call('/trigram/build', { method: 'POST' })
  out.measure = await call('/trigram/measure?n=200')
  out.size = await call('/size')
  save('trigram', out)
}

console.log('done')
