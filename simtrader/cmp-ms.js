/* 第 6 节（5m 市场结构触发）多配置对比：旧共振沿 vs 严格/宽松 vs 最低结构分
   用法：node cmp-ms.js BTCUSDT [YEARS] */
const S = require('./strategy.js');
const sym = process.argv[2] || 'BTCUSDT';
const years = +(process.argv[3] || 5);

const CONFIGS = [
  { key: '旧口径·三周期共振沿', opt: { msMode: false } },
  { key: '严格 CHOCH+RT+BOS', opt: { ms: { loose: false, minScore: 0 } } },
  { key: '严格 · 结构分≥16', opt: { ms: { loose: false, minScore: 16 } } },
  { key: '严格 · 结构分≥19', opt: { ms: { loose: false, minScore: 19 } } },
  { key: '严格 · 结构分≥22', opt: { ms: { loose: false, minScore: 22 } } },
  { key: '宽松 核心≥2', opt: { ms: { loose: true, minScore: 0 } } },
  { key: '宽松 核心≥2 · 分≥16', opt: { ms: { loose: true, minScore: 16 } } },
  { key: '严格 + 5m方向同向(AND)', opt: { ms: { loose: false, minScore: 0, andDir: true } } },
];

function stat(a) {
  const n = a.length; if (n < 2) return { n: n, m: n ? a[0] : 0, sd: 0, t: 0 };
  const m = a.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (n - 1));
  return { n: n, m: m, sd: sd, t: sd ? m / (sd / Math.sqrt(n)) : 0 };
}

(async () => {
  console.log(`拉取 ${sym} ${years} 年 5m K线…`);
  const h = await S.fetchHistory(sym, '5m', years, { src: 'binance', onProgress: () => {} });
  console.log(`共 ${h.rows.length} 根（${(h.rows.length * 5 / 1440).toFixed(0)} 天）\n`);

  const rows = [];
  let cache = null;
  for (const c of CONFIGS) {
    const t0 = Date.now();
    const r = S.backtestCore(h.series, Object.assign({ cache: cache, onProgress: () => {} }, c.opt));
    if (!cache) cache = r.cache;
    const g = stat(r.trades.map(t => t.grossR));
    const f = stat(r.trades.map(t => t.feeR));
    rows.push({ cfg: c.key, r: r, g: g, f: f, sec: (Date.now() - t0) / 1000 });
    console.log(`${c.key.padEnd(24)} 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log('\n' + '='.repeat(112));
  console.log(`${sym} · ${years} 年 · 出场用 defaultTpsl（与 run-bt5y.js 同口径）`);
  console.log('='.repeat(112));
  const H = ['配置', '笔数', '胜率', '累计R', 'R/笔', '毛利R', '毛利/笔', 't(毛利)', '手续费/笔', '止损宽', '结构事件'];
  console.log(H[0].padEnd(24) + H.slice(1).map(s => s.padStart(11)).join(''));
  console.log('-'.repeat(112));
  for (const x of rows) {
    const r = x.r;
    console.log(
      x.cfg.padEnd(24) +
      String(r.count).padStart(11) +
      ((r.winRate * 100).toFixed(1) + '%').padStart(11) +
      r.totalR.toFixed(0).padStart(11) +
      r.avgR.toFixed(3).padStart(11) +
      r.grossR.toFixed(0).padStart(11) +
      x.g.m.toFixed(4).padStart(11) +
      x.g.t.toFixed(2).padStart(11) +
      x.f.m.toFixed(4).padStart(11) +
      ((r.avgRiskPct * 100).toFixed(2) + '%').padStart(11) +
      String(r.msEvCount).padStart(11));
  }

  /* 分档表现（以「严格 · 结构分≥0」那组为例） */
  const base = rows[1].r;
  console.log('\n【结构总分分档表现（严格档，n = 成交笔数）】');
  console.log('分数段'.padEnd(12) + '笔数'.padStart(8) + '胜率'.padStart(10) + '毛利/笔'.padStart(12) + '净/笔'.padStart(12));
  base.msBands.forEach(b => {
    if (!b.n) return;
    console.log(`${b.lo}-${b.hi === 26 ? 25 : b.hi - 1}`.padEnd(12) +
      String(b.n).padStart(8) +
      ((b.winRate * 100).toFixed(1) + '%').padStart(10) +
      b.grossAvg.toFixed(4).padStart(12) +
      b.avgR.toFixed(4).padStart(12));
  });
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
