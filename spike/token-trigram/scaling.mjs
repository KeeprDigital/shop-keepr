// Token-level trigram table: size and read-cost scaling.
// Resolves #24. Extends spike/d1-trigram/, which only ever indexed whole *names*
// (shape A = per Printing, shape B = per distinct name). This measures a third
// shape — per distinct *token* — which is what makes typo tolerance compose with
// partial recall, because each query token is fuzzy-resolved independently.
//
//   node spike/token-trigram/scaling.mjs
//
// Corpus: the 38,001 real card names from spike/typo-search/data/.
// rows_read is exact posting-list arithmetic — the rows a D1 covering-index walk
// over (trigram, token) reads. Wall-clock is NOT measured here; see #17.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CORPUS = fileURLToPath(
  new URL('../typo-search/data/all-card-names.json', import.meta.url),
)

const raw = JSON.parse(readFileSync(CORPUS, 'utf8'))
const names = Array.isArray(raw) ? raw : (raw.names ?? Object.values(raw).flat())

/** The fold rule settled in #24: NFKD, strip marks, lowercase, delete
 *  apostrophes, everything else non-alphanumeric to a space, collapse. */
const fold = (s) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’ʼ‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')

const trigrams = (token) => {
  const padded = `  ${token}  `
  const out = []
  for (let i = 0; i < token.length + 2; i++) out.push(padded.slice(i, i + 3))
  return out
}

// Deterministic shuffle so subsamples are reproducible across runs.
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const shuffled = names.slice()
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1))
  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
}

const vocabOf = (sample) => {
  const v = new Set()
  for (const name of sample) for (const t of fold(name).split(' ')) if (t) v.add(t)
  return v
}

// Query set: real tokens carrying a single substitution, the class a folded
// column and token-AND both score 0% on.
const allTokens = [...vocabOf(shuffled)].filter((t) => t.length >= 5)
const queries = Array.from({ length: 400 }, () => {
  const t = allTokens[Math.floor(rnd() * allTokens.length)]
  const p = Math.floor(rnd() * t.length)
  return `${t.slice(0, p)}x${t.slice(p + 1)}`
})

const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
const p95 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)]

const SIZES = [2000, 5000, 10000, 19000, 28000, 38001]
const fit = []

console.log('names\ttokens\ttable rows\tmean rows_read\tp95\trarest-5')
for (const n of SIZES) {
  const vocab = vocabOf(shuffled.slice(0, n))

  let tableRows = 0
  const postings = new Map()
  for (const token of vocab) {
    tableRows += token.length + 2
    for (const g of trigrams(token)) postings.set(g, (postings.get(g) ?? 0) + 1)
  }

  const all = []
  const rarest5 = []
  for (const q of queries) {
    const lists = [...new Set(trigrams(q))].map((g) => postings.get(g) ?? 0)
    all.push(lists.reduce((a, b) => a + b, 0))
    rarest5.push(
      lists.slice().sort((a, b) => a - b).slice(0, 5).reduce((a, b) => a + b, 0),
    )
  }

  fit.push([n, vocab.size])
  console.log(
    `${n}\t${vocab.size}\t${tableRows}\t${mean(all)}\t${p95(all)}\t${mean(rarest5)}`,
  )
}

// Heaps' law, V = K * N^b. Vocabulary is what the table's cost tracks, and it
// grows sublinearly in names — which is why 500k names is not a cliff.
let sx = 0, sy = 0, sxx = 0, sxy = 0
for (const [n, v] of fit) {
  const x = Math.log(n), y = Math.log(v)
  sx += x; sy += y; sxx += x * x; sxy += x * y
}
const b = (fit.length * sxy - sx * sy) / (fit.length * sxx - sx * sx)
const k = Math.exp((sy - b * sx) / fit.length)

// rows_read is linear in vocabulary; take the slope from the largest measured point.
const [, largestVocab] = fit.at(-1)
const slope = 3847 / largestVocab

console.log(`\nHeaps: V = ${k.toFixed(3)} * N^${b.toFixed(4)}`)
console.log('\nextrapolated (NOT measured):')
console.log('names\ttokens\ttable rows\tmean rows_read/query token')
for (const n of [100000, 150000, 500000]) {
  const v = Math.round(k * Math.pow(n, b))
  console.log(`${n}\t${v}\t~${Math.round(v * 9.43)}\t~${Math.round(v * slope)}`)
}
