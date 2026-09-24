/* 止盈止损精度校验（对应 PDF 审计「需要先改的两件事」）：
   1) maxAtrK 是最终风险的硬上限，ATR 回退分支同样受约束
   2) 三套盈亏比口径同时存在且关系正确：参考价 ≤ 预计入场价，扣费净 ≤ 入场价
   3) 综合方案带归一化权重明细
   数据用真实 Gate 永续 K 线。 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');

/* ---- mock 浏览器环境（同 test-liq-app.js） ---- */
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
global.requestAnimationFrame = fn => setTimeout(() => fn(), 0);
global.ResizeObserver = class { observe() {} };
const elStore = {};
const mkEl = id => (elStore[id] || (elStore[id] = {
  id, style: {}, innerHTML: '', textContent: '', dataset: {},
  appendChild() {}, addEventListener() {}, querySelectorAll: () => [],
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  clientWidth: 900, clientHeight: 420,
}));
global.document = {
  querySelector: s => mkEl(s), querySelectorAll: () => [],
  createElement: () => mkEl('tmp'), addEventListener() {}, body: mkEl('body'),
  getElementById: id => mkEl('#' + id),
};
global.window = { addEventListener() {}, LiqMap: null };
global.LightweightCharts = {
  createChart: () => ({
    addCandlestickSeries: () => ({ setData() {}, priceToCoordinate: () => 100 }),
    addLineSeries: () => ({ setData() {} }),
    addHistogramSeries: () => ({ setData() {} }),
    timeScale: () => ({ fitContent() {}, getVisibleLogicalRange: () => null, subscribeVisibleTimeRangeChange() {} }),
    applyOptions() {}, remove() {},
  }),
};

let fail = 0;
const ok = (c, m, x) => { console.log((c ? '  PASS ' : '  FAIL ') + m + (x != null ? ' → ' + x : '')); if (!c) fail++; };

/* ---- 把 app.js 的内部函数暴露出来 ---- */
const src = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')
  + '\n;return { tpSlPlan, tpSlSummary, TPSL_CFG, rrAtEntry, rrNetOf, FEE_MARKET_RATE, FEE_TAKER, FEE_MAKER };';
const API = new Function('document', 'window', 'localStorage', 'fetch', 'WebSocket', 'requestAnimationFrame', 'ResizeObserver', 'LightweightCharts', src)(
  global.document, global.window, global.localStorage, global.fetch, function () {}, global.requestAnimationFrame, global.ResizeObserver, global.LightweightCharts
);

(async () => {
  console.log('\n【1】扣费净盈亏比公式对照');
  // 手算：入场 100，止损 98，止盈 102，费率 0.1%
  // 亏损 = 2 + (100+98)*0.001 = 2.198；盈利 = 2 - (100+102)*0.001 = 1.798
  const net = API.rrNetOf(100, 98, 102, 0.001);
  const expect = (2 - 0.202) / (2 + 0.198);
  ok(Math.abs(net - expect) < 1e-9, '净盈亏比 = (价差−开平仓费) ÷ (价差+开平仓费)', `${net.toFixed(4)} ≈ ${expect.toFixed(4)}`);
  ok(Math.abs(API.rrAtEntry(100, 98, 102) - 1) < 1e-9, '入场价口径盈亏比 = 2/2 = 1.00', API.rrAtEntry(100, 98, 102).toFixed(4));
  ok(net < 1, '扣费后净盈亏比低于名义 1:1（费用吃掉一部分）', net.toFixed(3));
  // PDF 截图例子：参考价 2719.54，入场区中点 2722.67，止损 2729.99，止盈一 2709.09
  const refRR = Math.abs(2709.09 - 2719.54) / Math.abs(2729.99 - 2719.54);
  const entRR = API.rrAtEntry(2722.67, 2729.99, 2709.09);
  ok(Math.abs(refRR - 1.0) < 0.02, '截图参考价口径 ≈ 1:1.00', refRR.toFixed(2));
  ok(Math.abs(entRR - 1.86) < 0.06, '换成入场区中点口径 ≈ 1:1.86（与 PDF 一致）', entRR.toFixed(2));

  console.log('\n【2】真实 K 线：硬上限与三口径');
  const GATE = 'https://api.gateio.ws';
  for (const [tf, contract] of [['15m', 'ETH_USDT'], ['4h', 'ETH_USDT'], ['1h', 'BTC_USDT']]) {
    const iv = tf;
    const url = `${GATE}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${iv}&limit=200`;
    const r = await fetch(url, { cache: 'no-store' });
    const rows = await r.json();
    const candles = rows.map(x => ({ time: +x.t, open: +x.o, high: +x.h, low: +x.l, close: +x.c })).sort((a, b) => a.time - b.time);
    if (candles.length < 60) { console.log('  跳过（K线不足）'); continue; }
    const px = candles[candles.length - 1].close;
    const p = API.tpSlPlan(candles, tf, px);
    if (!p) { console.log(`  ${tf} ${contract}: 无方案`); continue; }
    const cfg = API.TPSL_CFG[tf];
    const cap = cfg.maxAtrK * p.atr;
    ok(p.long.risk <= cap + 1e-6, `${tf} ${contract} 多头风险 ≤ ${cfg.maxAtrK}×ATR 硬上限`, `${p.long.risk.toFixed(3)} ≤ ${cap.toFixed(3)}`);
    ok(p.short.risk <= cap + 1e-6, `${tf} ${contract} 空头风险 ≤ ${cfg.maxAtrK}×ATR 硬上限`, `${p.short.risk.toFixed(3)} ≤ ${cap.toFixed(3)}`);
    for (const side of ['long', 'short']) {
      const s = p[side];
      ok(s.rr1Entry >= s.rr1 - 1e-6, `${tf} ${side} 入场价口径 ≥ 参考价口径`, `${s.rr1Entry.toFixed(2)} ≥ ${s.rr1.toFixed(2)}`);
      ok(s.rr1Net <= s.rr1Entry + 1e-6, `${tf} ${side} 扣费净口径 ≤ 入场价口径`, `${s.rr1Net.toFixed(2)} ≤ ${s.rr1Entry.toFixed(2)}`);
      ok(Math.abs(s.entry - (s.entryLo + s.entryHi) / 2) < 1e-9, `${tf} ${side} 预计入场价 = 入场区中点`, s.entry.toFixed(2));
      ok(isFinite(s.rr1Net), `${tf} ${side} 净盈亏比是有限值`, s.rr1Net.toFixed(3));
    }
  }

  console.log('\n【3】综合方案带归一化权重');
  const url = `${GATE}/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=15m&limit=200`;
  const c15 = (await (await fetch(url, { cache: 'no-store' })).json())
    .map(x => ({ time: +x.t, open: +x.o, high: +x.h, low: +x.l, close: +x.c })).sort((a, b) => a.time - b.time);
  const px = c15[c15.length - 1].close;
  const plans = ['15m', '30m', '1h', '4h'].map(tf => API.tpSlPlan(c15, tf, px)).filter(Boolean);
  const sum = API.tpSlSummary(plans, px, { qtyStep: 0.001, dec: 2, short: 'ETH' });
  ok(!!sum, '生成综合方案');
  if (sum) {
    ok(Array.isArray(sum.weights) && sum.weights.length > 0, '综合方案带权重明细', JSON.stringify(sum.weights.map(w => `${w.tf}:${(w.w * 100).toFixed(0)}%`)));
    const wsum = sum.weights.reduce((s, w) => s + w.w, 0);
    ok(Math.abs(wsum - 1) < 1e-6, '权重之和归一化到 1', wsum.toFixed(6));
    ok(sum.rr1Net <= sum.rr1 + 1e-6, '综合净盈亏比 ≤ 名义盈亏比', `${sum.rr1Net.toFixed(2)} ≤ ${sum.rr1.toFixed(2)}`);
    ok(isFinite(sum.rr1Net) && isFinite(sum.rr2Net), '综合净盈亏比为有限值', `${sum.rr1Net.toFixed(2)} / ${sum.rr2Net.toFixed(2)}`);
  }

  console.log(fail ? `\n❌ 失败 ${fail} 项` : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
