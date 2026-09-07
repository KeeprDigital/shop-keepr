import { connect } from '@tursodatabase/database';
const mode = process.argv[2]; const n = Number(process.argv[3]);
const db = await connect(':memory:');
try {
  if (mode === 'params') {
    const q = `SELECT ${Array.from({length:n},(_,i)=>`?${i+1}`).join(',')}`;
    await db.prepare(q).all(Array.from({length:n},(_,i)=>i));
  } else if (mode === 'compound') {
    await db.prepare(Array.from({length:n},()=>'SELECT 1').join(' UNION ALL ')).all();
  } else {
    await db.prepare(`SELECT '${'a'.repeat(n)}' AS x`).all();
  }
  console.log('OK');
} catch(e){ console.log('FAIL: '+String(e.message??e).slice(0,90)); }
