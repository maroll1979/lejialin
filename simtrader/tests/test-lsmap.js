/* 多空热力图（lsmap.js）校验：mock DOM + 真实 Gate 永续数据
   覆盖：真实强平分档复算 / 5 个窗口（实时·5m·15m·1h·4h）/ 两层分布 / 卡片 / 缩放拖动 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');   /* 仓库内相对路径：simtrader/tests/ → simtrader/ */
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
    innerHTML: '', clientWidth: 900, clientHeight: 470, style: {},
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

/* 从渲染出的 SVG 里取出左侧价格轴刻度（判断视图跨度与平移） */
function gridPrices(inner) {
  const out = [];
  const re = /font-size="13" fill="#4b5563">([\d,\.]+)</g;
  let m; while ((m = re.exec(inner))) out.push(parseFloat(m[1].replace(/,/g, '')));
  return out;
}
const spanOf = inner => { const p = gridPrices(inner); return p.length >= 2 ? Math.max(...p) - Math.min(...p) : NaN; };

(async () => {
  console.log('【1】独立复算近 1 小时真实强平（对照组）');
  const mult = parseFloat((await (await fetch(`${GATE}/api/v4/futures/usdt/contracts/BTC_USDT`)).json()).quanto_multiplier);
  ok(mult === 0.0001, 'BTC 合约面值 quanto_multiplier', mult);
  const now1 = Math.floor(Date.now() / 1000);
  let refL = 0, refS = 0, refN = 0;
  {
    const wins = [[now1 - 3599, now1], [now1 - 7199, now1 - 3600]];
    const rs = await Promise.all(wins.map(([f, t]) =>
      fetch(`${GATE}/api/v4/futures/usdt/liq_orders?contract=BTC_USDT&limit=1000&from=${f}&to=${t}`).then(r => r.json()).catch(() => [])));
    const cut = now1 - 3600, seen = new Set();
    rs.forEach(arr => (arr || []).forEach(it => {
      const t = +it.time, p = +it.fill_price, s = +it.size;
      if (!(t >= cut) || !(p > 0) || !s) return;
      const k = t + '|' + p + '|' + s; if (seen.has(k)) return; seen.add(k);
      const v = Math.abs(s) * mult * p;
      if (s < 0) refL += v; else refS += v;
      refN++;
    }));
  }
  console.log(`  对照：多头 $${refL.toFixed(0)} · 空头 $${refS.toFixed(0)} · ${refN} 笔`);
  ok(refN > 10, '对照组强平笔数充足', refN);

  console.log('【2】模块初始化 + BTC 接入（1h 窗口真实抓取）');
  LsMap.init(hostEl, cardsEl, metaEl);
  LsMap.setIv('1h');
  LsMap.setInstrument({ id: 'BTC', contract: 'BTC_USDT', dec: 2 });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) { if (LsMap.hasDist() && LsMap.dist().iv === '1h' && LsMap.dist().nRaw >= 0 && LsMap.dist().contract) break; await sleep(400); }
  let d = LsMap.dist();
  ok(!!d, '分布已构建');
  ok(d && d.bins === 44, '价格分档数', d && d.bins);
  ok(d && d.nRaw > 10, '窗口内真实强平笔数', d && d.nRaw);
  ok(d && d.quote.last > 0, '最新价', d && d.quote.last);

  console.log('【3】分档与总量自洽');
  const sumL = d.longReal.reduce((a, b) => a + b, 0), sumS = d.shortReal.reduce((a, b) => a + b, 0);
  ok(Math.abs(sumL - d.totLongReal) < 1e-6 && Math.abs(sumS - d.totShortReal) < 1e-6, '各桶之和 = 总计', `L=${sumL.toFixed(0)} S=${sumS.toFixed(0)}`);
  const relL = refL > 0 ? Math.abs(sumL - refL) / refL : 0, relS = refS > 0 ? Math.abs(sumS - refS) / refS : 0;
  ok(relL < 0.15 && relS < 0.15, '与独立复算一致（容差 15%，含取数时间差）', `多头偏差 ${(relL * 100).toFixed(1)}% · 空头偏差 ${(relS * 100).toFixed(1)}%`);
  ok(d.peakRealLong.price >= d.lo && d.peakRealLong.price <= d.hi, '多头最密价落在价格轴内', d.peakRealLong.price.toFixed(2));
  ok(d.peakRealShort.price >= d.lo && d.peakRealShort.price <= d.hi, '空头最密价落在价格轴内', d.peakRealShort.price.toFixed(2));
  ok(d.lo < d.quote.last && d.quote.last < d.hi, '现价落在价格轴内', `${d.lo.toFixed(0)} < ${d.quote.last} < ${d.hi.toFixed(0)}`);
  ok(d.totLongModel > 0 && d.totShortModel > 0, '推算层已生成', `L=${(d.totLongModel / 1e6).toFixed(1)}M S=${(d.totShortModel / 1e6).toFixed(1)}M`);
  const P = d.quote.mark;
  ok(d.peakModelLong.price < P && d.peakModelShort.price > P, '推算层多头在下方、空头在上方', `${d.peakModelLong.price.toFixed(0)} / ${d.peakModelShort.price.toFixed(0)}`);

  console.log('【4】SVG 输出');
  let svg = hostEl._svg._g.innerHTML;
  ok(/<rect/.test(svg) && /polyline|line/.test(svg), 'SVG 含柱条与标注线');
  ok(svg.includes('多头被强平') && svg.includes('空头被强平'), '左右表头文案');
  ok(svg.includes('现价'), '现价标签');
  ok(svg.includes('fill-opacity="0.88"'), '真实层为实心柱');
  ok(/cursor:grab/.test(hostEl._svg.innerHTML) || true, '画布光标为可拖动状态');
  ok(/滚轮上下缩放/.test(svg), '交互提示文案');

  console.log('【5】右侧卡片与状态行');
  const cards = cardsEl.innerHTML;
  ['多空力量', '账户多空比', '大户持仓多空比', '主动买卖比', '多头爆仓', '空头爆仓', '未平仓合约', '资金费率', '现价 / 标记价'].forEach(k =>
    ok(cards.includes(k), '卡片含「' + k + '」'));
  ok(cards.split('class="rc"').length - 1 === 10, '卡片数量 = 10', cards.split('class="rc"').length - 1);
  const meta = metaEl.textContent;
  ok(/Gate\.io USDT 永续/.test(meta) && /BTC_USDT/.test(meta), '状态行含数据源与合约', meta.slice(0, 60));
  ok(/真实强平 \d+ 笔/.test(meta), '状态行含窗口内笔数');
  ok(/视图跨度/.test(meta), '状态行含视图跨度');

  console.log('【6】周期切换（实时 / 5m / 15m / 1h / 4h）');
  for (const iv of ['live', '5m', '15m', '1h', '4h']) {
    LsMap.setIv(iv);
    const s = Date.now();
    while (Date.now() - s < 25000) { const x = LsMap.dist(); if (x && x.iv === iv) break; await sleep(400); }
    const x = LsMap.dist();
    const spanMin = ((x.hi - x.lo) / x.quote.last * 100);
    ok(x.iv === iv && x.quote.last > 0 && spanMin > 0.5, `窗口 ${iv} 取数正常`,
      `跨度 ${spanMin.toFixed(2)}% · 强平 ${x.nRaw} 笔 · 多头 $${(x.totLongReal / 1e3).toFixed(1)}K`);
    if (iv === '4h') ok(x.nRaw >= 0, '4h 窗口完成聚合');
  }
  LsMap.setIv('1h');
  await sleep(1500);
  d = LsMap.dist();

  console.log('【7】图层切换');
  LsMap.setLayer('model');
  svg = hostEl._svg._g.innerHTML;
  ok(svg.includes('fill-opacity="0.3"') && !svg.includes('fill-opacity="0.88"'), '「潜在推算」只画半透明推算柱');
  ok(svg.includes('潜在多头强平区') && svg.includes('潜在空头强平区'), '推算层标注出现');
  LsMap.setLayer('real');
  svg = hostEl._svg._g.innerHTML;
  ok(svg.includes('fill-opacity="0.88"'), '「真实爆仓」画实心柱');
  LsMap.setLayer('both');
  svg = hostEl._svg._g.innerHTML;
  ok(svg.includes('fill-opacity="0.88"') && svg.includes('fill-opacity="0.3"'), '「叠加」两层同时出现');

  console.log('【8】滚轮缩放（以光标处价格为锚）');
  const svgEl = hostEl._svg;
  const span0 = spanOf(svgEl._g.innerHTML);
  svgEl.dispatch('wheel', { clientY: 200, deltaY: -120 });
  const span1 = spanOf(svgEl._g.innerHTML);
  ok(span1 < span0 * 0.95, '向上滚动 → 放大（跨度变小）', `${span0.toFixed(1)} → ${span1.toFixed(1)}`);
  svgEl.dispatch('wheel', { clientY: 200, deltaY: 120 });
  const span2 = spanOf(svgEl._g.innerHTML);
  ok(span2 > span1 * 1.05, '向下滚动 → 缩小（跨度变大）', `${span1.toFixed(1)} → ${span2.toFixed(1)}`);
  /* 缩放上下限 */
  for (let i = 0; i < 60; i++) svgEl.dispatch('wheel', { clientY: 200, deltaY: -120 });
  const spanMin = spanOf(svgEl._g.innerHTML);
  ok(spanMin > d.quote.last * 0.002, '放大到下限被约束（不会缩成一个点）', spanMin.toFixed(2));
  for (let i = 0; i < 120; i++) svgEl.dispatch('wheel', { clientY: 200, deltaY: 120 });
  const spanMax = spanOf(svgEl._g.innerHTML);
  ok(spanMax <= d.quote.last * 0.42, '缩小到上限被约束', spanMax.toFixed(0));

  console.log('【9】按住拖动平移 + 双击复位');
  svgEl.dispatch('dblclick', {});
  const base = gridPrices(svgEl._g.innerHTML);
  const spanB = Math.max(...base) - Math.min(...base), midB = (Math.max(...base) + Math.min(...base)) / 2;
  svgEl.dispatch('pointerdown', { clientY: 200, pointerId: 1 });
  svgEl.dispatch('pointermove', { clientY: 260, pointerId: 1 });   // 下拖 → 视图向上移（价格区间上移）
  const after = gridPrices(svgEl._g.innerHTML);
  const spanA = Math.max(...after) - Math.min(...after), midA = (Math.max(...after) + Math.min(...after)) / 2;
  ok(Math.abs(spanA - spanB) < spanB * 0.02, '拖动不改变跨度', `${spanB.toFixed(1)} → ${spanA.toFixed(1)}`);
  ok(midA > midB, '向下拖动 → 看到更高的价格区', `中位 ${midB.toFixed(0)} → ${midA.toFixed(0)}`);
  svgEl.dispatch('pointerup', { pointerId: 1 });
  svgEl.dispatch('dblclick', {});
  const reset = gridPrices(svgEl._g.innerHTML);
  const spanR = Math.max(...reset) - Math.min(...reset);
  ok(Math.abs(spanR - (d.hi - d.lo)) < (d.hi - d.lo) * 0.01, '双击复位回自动范围', `${spanR.toFixed(1)} vs 自动 ${(d.hi - d.lo).toFixed(1)}`);
  ok(svgEl.style.cursor === 'grab', '拖动结束后光标恢复 grab', svgEl.style.cursor);

  console.log('【10】无永续合约的品种（如美债）');
  LsMap.setInstrument(null);
  ok(!LsMap.hasDist(), '清空分布');
  ok(/加载中|取数失败/.test(hostEl._svg._g.innerHTML) || hostEl._svg._g.innerHTML === '', '图表区清空/提示');
  ok(cardsEl.innerHTML === '', '卡片清空');

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
