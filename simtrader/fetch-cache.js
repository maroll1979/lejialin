/* 5m 历史缓存：避免每轮实验重复拉 80s */
const fs = require('fs');
const path = require('path');
const S = require('./strategy.js');

const DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function file(sym, years) { return path.join(DIR, `bt_${sym}_${years}y_5m.json`); }

async function get(sym, years, opt) {
  opt = opt || {};
  const f = file(sym, years);
  if (!opt.force && fs.existsSync(f)) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(`[cache] ${sym} ${years}y 命中 ${raw.rows.length} 根`);
    return raw.rows;
  }
  const t0 = Date.now();
  const h = await S.fetchHistory(sym, '5m', years, {
    src: 'binance',
    onProgress: p => process.stdout.write(`\r[fetch] ${(p * 100).toFixed(1)}%   `),
  });
  const rows = h.rows;
  fs.writeFileSync(f, JSON.stringify({ sym, years, rows }));
  console.log(`\n[fetch] ${sym} ${years}y ${rows.length} 根 · ${((Date.now() - t0) / 1000).toFixed(1)}s → ${f}`);
  return rows;
}

module.exports = { get, file, DIR };

if (require.main === module) {
  const sym = process.argv[2] || 'BTCUSDT';
  const y = Number(process.argv[3] || 5);
  get(sym, y).then(r => console.log('done', r.length)).catch(e => { console.error(e); process.exit(1); });
}
