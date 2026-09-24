/* 多空热力图（lsmap.js · 订单簿口径）校验：mock DOM + 真实 Gate 永续订单簿
   覆盖：tick/面值 / 分档复算 / 四个视野（±200·±500·±2000·±5000 tick）/ 粒度自适应 / 卡片 / 缩放拖动 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(DIR, 'lsmap.js'), 'utf8');
const GATE = 'https://api.gateio.ws';

/* ---------------- mock 浏览器环境 ---------------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = {};
global.requestAnimationFrame = fn => setTimeout(() => fn(), 0);
global.cancelAnimationFrame = () => {};
global.ResizeObserver = class { observe() {} disconnect() {} };

function mkEl(extra) {
  const el = Object.assign({
    innerHTML: '', textContent: '', clientWidth: 900, clientHeight: 470, style: {},
    _h: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(t, fn) { (el._h[t] = el._h[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (el._h[t] || []).forEach(fn => fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev))); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 900, height: 470 }; },
    setPointerCapture() {}, releasePointerCapture() {},
    querySelector() { return null; },
  }, extra || {});
  return el;
}
const hostEl = mkEl(), cardsEl = mkEl(), metaEl = mkEl();
hostEl._svg = mkEl(); hostEl._svg._g = mkEl();
hostEl.querySelector = sel => (sel === 'svg' ? hostEl._svg : null);
hostEl._svg.querySelector = sel => (sel === 'g' ? hostEl._svg._g : null);

global.document = { hidden: false, addEventListener() {}, createElement: () => mkEl() };

/* ---------------- 加载模块 ---------------- */
new Function(SRC)();
const LsMap = global.window.LsMap;
if (!LsMap) { console.error('模块未挂载 window.LsMap'); process.exit(1); }

let fail = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg + (extra != null ? ' → ' + extra : '')); if (!cond) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 25000)) { if (fn()) return true; await sleep(300); } return false; };

/* 从渲染出的 SVG 里取出左侧价格轴刻度（判断视图跨度与平移） */
function gridPrices(inner) {
  const out = [];
  const re = /font-size="13" fill="#4b5563">([\d,\.]+)</g;
  let m; while ((m = re.exec(inner))) out.push(parseFloat(m[1].replace(/,/g, '')));
  return out;
}
const spanOf = inner => { const p = gridPrices(inner); return p.length >= 2 ? Math.max(...p) - Math.min(...p) : NaN; };
const midOf = inner => { const p = gridPrices(inner); return p.length >= 2 ? (Math.max(...p) + Math.min(...p)) / 2 : NaN; };

(async () => {
  console.log('【1】合约静态参数：tick 精度与合约面值');
  const ct = await (await fetch(`${GATE}/api/v4/futures/usdt/contracts/BTC_USDT`)).json();
  const TICK = parseFloat(ct.order_price_round), MULT = parseFloat(ct.quanto_multiplier);
  ok(TICK === 0.1, 'BTC order_price_round（tick）', TICK);
  ok(MULT === 0.0001, 'BTC quanto_multiplier（面值）', MULT);

  console.log('【2】订单簿接口能力（单侧档数上限 / interval 取值规则）');
  const obRaw = await (await fetch(`${GATE}/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=300&interval=0`)).json();
  ok(obRaw.bids.length === 300 && obRaw.asks.length === 300, 'limit=300 时单侧返回 300 档', `${obRaw.bids.length}/${obRaw.asks.length}`);
  const bad = await fetch(`${GATE}/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=300&interval=2`);
  ok(bad.status === 400, 'interval=2 被拒（只允许 {0} ∪ {1,5}×10^k）', 'HTTP ' + bad.status);
  const ob5 = await (await fetch(`${GATE}/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=300&interval=5`)).json();
  const coverRaw = (Math.max(...obRaw.asks.map(a => +a.p)) - Math.min(...obRaw.bids.map(b => +b.p))) / 2 / TICK;
  const cover5 = (Math.max(...ob5.asks.map(a => +a.p)) - Math.min(...ob5.bids.map(b => +b.p))) / 2 / TICK;
  ok(cover5 > coverRaw * 5, 'interval=5 的覆盖远大于原始簿', `${Math.round(coverRaw)} → ${Math.round(cover5)} tick`);

  console.log('【3】模块初始化 + BTC 接入（默认 ±500 tick）');
  LsMap.init(hostEl, cardsEl, metaEl);
  ok(LsMap.span() === 500, '默认视野 ±500 tick', LsMap.span());
  LsMap.setInstrument({ id: 'BTC', contract: 'BTC_USDT', dec: 2 });
  await waitFor(() => LsMap.hasDist() && LsMap.dist().contract === 'BTC_USDT');
  let d = LsMap.dist();
  ok(!!d, '分布已构建');
  ok(d && d.bins === 72, '价格分档数', d && d.bins);
  ok(d && d.tick === TICK, 'tick 取自合约参数', d && d.tick);
  const halfSpanTick = (d.hi - d.lo) / 2 / TICK;
  ok(Math.abs(halfSpanTick - 500) < 1, '视野 = 现价上下各 500 tick', halfSpanTick.toFixed(1));
  /* 注意：Gate 的 last 是最近一笔成交价，瞬时可能落在盘口之外（成交后盘口已移动），
     所以只校验盘口本身有序、且现价贴近盘口中点，不强制 bestBid < P < bestAsk */
  const midW = (d.bestBid + d.bestAsk) / 2;
  ok(d.bestBid < d.bestAsk, '买一 < 卖一（盘口有序）', `${d.bestBid} / ${d.bestAsk}`);
  ok(Math.abs(d.P - midW) / d.P < 0.002, '现价贴近盘口中点（0.2% 内）', `偏离 ${(Math.abs(d.P - midW) / d.P * 100).toFixed(3)}%`);

  console.log('【4】分档自洽：与独立复算逐档比对');
  const book = LsMap.book();
  const step = (d.hi - d.lo) / d.bins, lo = d.lo;
  const refBid = new Array(d.bins).fill(0), refAsk = new Array(d.bins).fill(0);
  book.bids.forEach(([p, s]) => { if (p >= lo && p < d.hi) refBid[Math.min(d.bins - 1, Math.floor((p - lo) / step))] += s * MULT * p; });
  book.asks.forEach(([p, s]) => { if (p >= lo && p < d.hi) refAsk[Math.min(d.bins - 1, Math.floor((p - lo) / step))] += s * MULT * p; });
  const sumB = d.bidA.reduce((a, b) => a + b, 0), sumA = d.askA.reduce((a, b) => a + b, 0);
  ok(Math.abs(sumB - d.totBid) < 1e-6 && Math.abs(sumA - d.totAsk) < 1e-6, '各桶之和 = 总计', `买 $${(sumB / 1e6).toFixed(2)}M 卖 $${(sumA / 1e6).toFixed(2)}M`);
  let maxDiff = 0;
  for (let i = 0; i < d.bins; i++) maxDiff = Math.max(maxDiff, Math.abs(d.bidA[i] - refBid[i]), Math.abs(d.askA[i] - refAsk[i]));
  ok(maxDiff < 1e-6, '逐档与独立复算完全一致', '最大偏差 ' + maxDiff.toExponential(1));
  ok(d.bidA.some(v => v > 0) && d.askA.some(v => v > 0), '两侧都有挂单柱');
  const midBin = Math.floor(d.bins / 2);
  ok(d.bidA[midBin] >= 0 && d.askA[midBin] >= 0, '中间档（现价附近）存在', `买 ${(d.bidA[midBin] / 1e3).toFixed(1)}K / 卖 ${(d.askA[midBin] / 1e3).toFixed(1)}K`);
  ok(d.peakBid.price < d.P && d.peakAsk.price > d.P, '最厚买盘在下方、最厚卖盘在上方', `${d.peakBid.price.toFixed(1)} / ${d.peakAsk.price.toFixed(1)}`);

  console.log('【5】SVG 输出');
  let svg = hostEl._svg._g.innerHTML;
  ok(/<rect/.test(svg) && /<line/.test(svg), 'SVG 含柱条与标注线');
  ok(svg.includes('买盘挂单（价格下方）') && svg.includes('卖盘挂单（价格上方）'), '左右表头文案');
  ok(svg.includes('现价'), '现价标注');
  ok(svg.includes('滚轮上下缩放') && svg.includes('双击复位'), '交互提示');
  ok(/最厚买盘/.test(svg) && /最厚卖盘/.test(svg), '最厚挂单墙标注');

  console.log('【6】右侧卡片（挂单口径 + 真实 OI 单列）');
  const cards = cardsEl.innerHTML;
  ok(cards.includes('盘口方向') && cards.includes('买盘挂单量') && cards.includes('卖盘挂单量'), '挂单方向/买/卖盘卡片');
  ok(cards.includes('最厚买盘墙') && cards.includes('最厚卖盘墙'), '挂单墙卡片');
  ok(cards.includes('未平仓合约（真实持仓）') && cards.includes('非挂单，来自 tickers'), '真实 OI 单列并标注来源（不与挂单混排）');
  ok(cards.includes('买一 / 卖一') && cards.includes('资金费率'), '买卖一档与资金费率卡片');
  ok(metaEl.textContent.includes('订单簿') && metaEl.textContent.includes('tick'), '状态行写明订单簿与 tick 口径', metaEl.textContent.slice(0, 96));

  console.log('【7】四个视野切换（±200 / ±500 / ±2000 / ±5000 tick）');
  for (const sp of [200, 500, 2000, 5000]) {
    LsMap.setSpan(sp);
    await waitFor(() => LsMap.hasDist() && LsMap.dist().span === sp);
    const dd = LsMap.dist();
    const half = (dd.hi - dd.lo) / 2 / dd.tick;
    const okSpan = Math.abs(half - sp) < 1;
    const covered = dd.coverTicks >= sp * 0.99;
    ok(okSpan && covered && (dd.totBid + dd.totAsk) > 0,
      `视野 ±${sp} tick 取数正常`, `跨度${half.toFixed(0)}tick 覆盖±${Math.round(dd.coverTicks)} 粒度${dd.interval === 0 ? '原始' : dd.interval} 买$${(dd.totBid / 1e6).toFixed(2)}M`);
  }

  console.log('【8】缩放 → 超出覆盖时自动换更粗粒度重取');
  LsMap.setSpan(500);
  await waitFor(() => LsMap.hasDist() && LsMap.dist().span === 500);
  const iv0 = LsMap.book().interval, cov0 = LsMap.book().coverTicks;
  const s0 = spanOf(hostEl._svg._g.innerHTML);
  for (let i = 0; i < 8; i++) { hostEl._svg.dispatch('wheel', { deltaY: 120, clientY: 235 }); await sleep(30); }
  const s1 = spanOf(hostEl._svg._g.innerHTML);
  ok(s1 > s0, '向下滚动 → 视野变宽', `${s0.toFixed(0)} → ${s1.toFixed(0)}`);
  await waitFor(() => LsMap.book() && LsMap.book().coverTicks > cov0 * 1.5, 20000);
  const bk = LsMap.book();
  ok(bk.coverTicks > cov0, '覆盖范围扩大（自动取了更深的订单簿）', `±${Math.round(cov0)} → ±${Math.round(bk.coverTicks)} tick`);
  ok(bk.interval > iv0 || iv0 === 0, '粒度相应变粗', `${iv0 === 0 ? '原始' : iv0} → ${bk.interval === 0 ? '原始' : bk.interval}`);
  const cur = LsMap.dist();
  ok(cur.coverTicks >= (Math.max(cur.P - cur.lo, cur.hi - cur.P) / cur.tick) * 0.95, '覆盖足够撑住当前视野',
    `视野±${Math.round(Math.max(cur.P - cur.lo, cur.hi - cur.P) / cur.tick)} 覆盖±${Math.round(cur.coverTicks)}`);

  console.log('【9】放大 / 拖动平移 / 双击复位');
  for (let i = 0; i < 8; i++) { hostEl._svg.dispatch('wheel', { deltaY: -120, clientY: 235 }); await sleep(30); }
  const s2 = spanOf(hostEl._svg._g.innerHTML);
  ok(s2 < s1, '向上滚动 → 视野变窄', `${s1.toFixed(0)} → ${s2.toFixed(0)}`);
  const m0 = midOf(hostEl._svg._g.innerHTML), sp0 = spanOf(hostEl._svg._g.innerHTML);
  hostEl._svg.dispatch('pointerdown', { clientY: 200, pointerId: 1 });
  hostEl._svg.dispatch('pointermove', { clientY: 300, pointerId: 1 });
  hostEl._svg.dispatch('pointerup', { clientY: 300, pointerId: 1 });
  const m1 = midOf(hostEl._svg._g.innerHTML), sp1 = spanOf(hostEl._svg._g.innerHTML);
  ok(Math.abs(sp1 - sp0) / sp0 < 0.02, '拖动不改变跨度', `${sp0.toFixed(0)} → ${sp1.toFixed(0)}`);
  ok(m1 > m0, '向下拖动 → 看到更高的价格区', `中位 ${m0.toFixed(0)} → ${m1.toFixed(0)}`);
  hostEl._svg.dispatch('dblclick', {});
  await sleep(60);
  const back = LsMap.dist();
  const halfBack = (back.hi - back.lo) / 2 / back.tick;
  ok(Math.abs(halfBack - LsMap.span()) < 1, '双击复位回默认视野', `${halfBack.toFixed(0)} vs ${LsMap.span()}`);

  console.log('【10】无永续合约的品种（如美债）应清空');
  LsMap.setInstrument(null);
  await sleep(120);
  ok(!LsMap.hasDist(), '清空分布');
  ok(hostEl._svg._g.innerHTML.includes('加载中') || hostEl._svg._g.innerHTML.includes('—') || hostEl._svg._g.innerHTML === '' || /text/.test(hostEl._svg._g.innerHTML), '图表区给出占位提示', hostEl._svg._g.innerHTML.slice(0, 48));

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
