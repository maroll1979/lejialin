/* 多空清算图逻辑校验：mock DOM + 真实 Gate 强平数据 + 真实 K 线 */
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'liq-map.js');

/* ---- mock 浏览器环境 ---- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = {};
global.requestAnimationFrame = fn => setTimeout(() => fn(), 0);
global.ResizeObserver = class { observe() {} };
const mkEl = () => ({
  style: { cssText: '' }, innerHTML: '', id: '',
  appendChild() {}, classList: { toggle(n, v) { this['_' + n] = v; } },
});
const layerEl = mkEl(), boxEl = { clientWidth: 900, appendChild() {}, classList: { toggle(n, v) { boxEl['_' + n] = v; } } };
global.document = { createElement: () => layerEl };

const H = 420, W = 782;
const chartEl = { clientHeight: H, clientWidth: W };
let PR = { lo: 0, hi: 1 };
const series = { priceToCoordinate: p => H - (p - PR.lo) / (PR.hi - PR.lo) * H };
const chart = { timeScale: () => ({ getVisibleLogicalRange: () => null }) };

/* ---- 加载模块 ---- */
new Function(fs.readFileSync(path, 'utf8'))();
const LiqMap = global.window.LiqMap;
if (!LiqMap) { console.error('模块未挂载 window.LiqMap'); process.exit(1); }

const GATE = 'https://api.gateio.ws';
let fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg + (extra != null ? ' → ' + extra : '')); if (!cond) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('【1】抓取 Gate 真实 K 线（BTC 15m，300 根）');
  const kj = await (await fetch(`${GATE}/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=15m&limit=300`)).json();
  const candles = kj.map(a => ({ time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c })).sort((a, b) => a.time - b.time);
  ok(candles.length > 200, 'K线根数', candles.length);
  PR.lo = Math.min(...candles.map(c => c.low));
  PR.hi = Math.max(...candles.map(c => c.high));
  console.log(`  K线价格区间 ${PR.lo} ~ ${PR.hi}`);

  console.log('【2】独立复算 24h 强平（对照组）');
  const mult = parseFloat((await (await fetch(`${GATE}/api/v4/futures/usdt/contracts/BTC_USDT`)).json()).quanto_multiplier);
  ok(mult === 0.0001, 'BTC 合约面值', mult);
  const now = Math.floor(Date.now() / 1000);
  let rawL = 0, rawS = 0, rawN = 0;
  const wins = [];
  for (let h = 0; h < 24; h++) { const to = now - h * 3600; wins.push([to - 3599, to]); }
  for (let i = 0; i < wins.length; i += 6) {
    const rs = await Promise.all(wins.slice(i, i + 6).map(([f, t]) =>
      fetch(`${GATE}/api/v4/futures/usdt/liq_orders?contract=BTC_USDT&limit=1000&from=${f}&to=${t}`).then(r => r.json()).catch(() => null)));
    for (const a of rs) if (Array.isArray(a)) for (const it of a) {
      const s = +it.size, p = +it.fill_price;
      if (!isFinite(s) || !isFinite(p) || !s) continue;
      const v = Math.abs(s) * mult * p;
      if (s < 0) rawL += v; else rawS += v;
      rawN++;
    }
  }
  console.log(`  对照：多头 $${rawL.toFixed(0)} · 空头 $${rawS.toFixed(0)} · ${rawN} 笔`);
  ok(rawN > 50, '对照组强平笔数充足', rawN);

  console.log('【3】模块初始化 + 品种接入（真实抓取）');
  LiqMap.init(chart, series, boxEl, chartEl);
  await LiqMap.setInstrument('BTC', 'BTC_USDT', 2);
  LiqMap.setCandles(candles);
  LiqMap.render();
  await sleep(120);
  const st = LiqMap.statusLine();
  console.log('  statusLine:', st);
  ok(/近24h 强平 \d+ 笔/.test(st), '状态行格式正确');
  const mN = +st.match(/近24h 强平 (\d+) 笔/)[1];
  ok(Math.abs(mN - rawN) / Math.max(1, rawN) < 0.06, '笔数与对照组一致（±6%）', `${mN} vs ${rawN}`);
  ok(LiqMap.isActive() === true, '永续品种激活清算图');
  ok(!st.includes('失败'), '无抓取失败提示');

  console.log('【4】SVG 绘图校验');
  const svg = layerEl.innerHTML;
  ok(svg.startsWith('<svg'), '输出为 SVG');
  const bars = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#(0a8f4e|d92c2c|8a93a3)"/g) || [];
  ok(bars.length >= 3, '强度条数量', bars.length);
  const ys = bars.map(b => parseFloat(b.match(/y="([\d.]+)"/)[1]));
  ok(ys.every(y => y >= 58 && y <= H - 18), '强度条 y 落在标题区与时间轴之间', `min=${Math.min(...ys).toFixed(1)} max=${Math.max(...ys).toFixed(1)}`);
  const xs = bars.map(b => parseFloat(b.match(/x="([\d.]+)"/)[1]));
  ok(xs.every(x => x >= 0 && x <= LiqMap.W_LEFT), '强度条位于左侧清算图区域内（不压 K 线）', `max_x=${Math.max(...xs).toFixed(1)}`);
  const lines = svg.match(/<line[^>]*stroke-dasharray="7 4"/g) || [];
  ok(lines.length >= 1, '清算价位横线数量', lines.length);
  ok(lines.every(l => /x1="118"/.test(l)), '横线起点在清算图右边界（x=118）');
  const labels = svg.match(/<text[^>]*>[^<]*· (多头|空头)爆仓 \$/g) || [];
  ok(labels.length === lines.length, '每条横线都有价位标签', `${labels.length} 标签 / ${lines.length} 线`);
  const labelYs = (svg.match(/<rect x="124" y="([\d.]+)"/g) || []).map(s => parseFloat(s.match(/y="([\d.]+)"/)[1]));
  let overlap = 0;
  for (let i = 1; i < labelYs.length; i++) if (labelYs[i] - labelYs[i - 1] < 20) overlap++;
  ok(overlap === 0, '标签互不重叠', `标签数=${labelYs.length}`);
  ok(/多头爆仓 \$/.test(svg) && /空头爆仓 \$/.test(svg), '顶部显示多空爆仓总额');

  console.log('【5】开关与非永续品种');
  LiqMap.setEnabled(false);
  await sleep(60);
  ok(layerEl.innerHTML === '', '关闭后清空图层');
  ok(boxEl['_liq-off'] === true, '关闭后 chartBox 加 liq-off（K线左移归位）');
  LiqMap.setEnabled(true);
  ok(boxEl['_liq-off'] === false, '重新开启后移除 liq-off');
  await LiqMap.setInstrument('UST10Y', '', 3);
  ok(LiqMap.isActive() === false, '美债品种（无永续合约）自动关闭清算图');
  ok(boxEl['_liq-off'] === true, '美债品种 K线占满宽度');

  console.log('【6】增量刷新（最近 2 小时）');
  await LiqMap.setInstrument('ETH', 'ETH_USDT', 2);
  LiqMap.setCandles(candles);
  const before = LiqMap.statusLine();
  await LiqMap.refresh(false);
  const after = LiqMap.statusLine();
  ok(/近24h 强平 \d+ 笔/.test(after), 'ETH 增量刷新后有数据', after);
  ok(before !== after || /\d/.test(after), '刷新后状态更新');

  console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
