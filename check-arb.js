const db = require('better-sqlite3')('arb-data.db', { readonly: true });

console.log('=== schema version ===');
console.log('user_version:', db.pragma('user_version', { simple: true }));

console.log('\n=== table row counts ===');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
for (const { name } of tables) {
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get();
    console.log(`${name}: ${r.c}`);
  } catch (e) {
    console.log(`${name}: ERR ${e.message}`);
  }
}

console.log('\n=== price_snapshots latest 5 (if any) ===');
try {
  console.table(db.prepare(`SELECT timestamp, exchange, symbol, price FROM price_snapshots ORDER BY timestamp DESC LIMIT 5`).all());
} catch (e) { console.log('ERR', e.message); }

console.log('\n=== spread_events latest 10 (if any) ===');
try {
  console.table(db.prepare(`SELECT timestamp, symbol, buy_exchange, sell_exchange, spread_pct, net_spread_pct FROM spread_events ORDER BY timestamp DESC LIMIT 10`).all());
} catch (e) { console.log('ERR', e.message); }
