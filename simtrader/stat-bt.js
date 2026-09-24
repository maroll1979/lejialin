/* 逐笔 R 的统计显著性：均值 / 标准差 / t 值（毛利、手续费、净利分开算）
   用法：node stat-bt.js BTCUSDT */
const S = require('./strategy.js');
const sym = process.argv[2] || 'BTCUSDT';

function stat(arr) {
  const n = arr.length;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  const sd = Math.sqrt(v);
  const se = sd / Math.sqrt(n);
  return { n, m, sd, se, t: m / se };
}

(async () => {
  const r = await S.backtest(sym, 5, { onPhase: () => {} });
  const g = stat(r.trades.map(t => t.grossR));
  const f = stat(r.trades.map(t => t.feeR));
  const net = stat(r.trades.map(t => t.r));
  const line = (s, name) => console.log(
    `${name.padEnd(9)} 均值 ${(s.m >= 0 ? '+' : '') + s.m.toFixed(4)}R · 标准差 ${s.sd.toFixed(3)}` +
    ` · 标准误 ${s.se.toFixed(4)} · t = ${s.t.toFixed(2)}   (n=${s.n})`);
  console.log(`\n===== ${sym} · 5 年逐笔 R 统计 =====`);
  line(g, '毛利/笔');
  line(f, '手续费/笔');
  line(net, '净利/笔');
  console.log(`平均止损宽度 ${(r.avgRiskPct * 100).toFixed(2)}%`);
  console.log(`手续费/毛利 = ${(f.m / g.m).toFixed(2)} 倍 → 毛利要 ≥ ${f.m.toFixed(4)}R/笔 才盈亏平衡（现 ${g.m.toFixed(4)}，缺口 ${(f.m - g.m).toFixed(4)}）`);
  console.log(`若全用限价 maker（0.10% → 0.04% 一来回）：手续费降到 ${(f.m * 0.4).toFixed(4)}R/笔 → 净 ${(g.m - f.m * 0.4).toFixed(4)}R/笔`);
  console.log(`若止损宽度放大到 ${((r.avgRiskPct * 1.5) * 100).toFixed(2)}%（手续费同比例下降）：净 ${(g.m - f.m / 1.5).toFixed(4)}R/笔`);
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
