// 热力图算法验证：切出 app.js 中的纯计算段（无 DOM 依赖）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const cutA = src.indexOf('/* ============================ K 线绘制');
const hStart = src.indexOf('/* ============================ 多空筹码热力图');
const hEnd = src.indexOf('/* --- 绘制 --- */');
if (cutA < 0 || hStart < 0 || hEnd < 0) throw new Error('切分点未找到');
const code = src.slice(0, cutA) + '\n' + src.slice(hStart, hEnd);

global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};
global.fetch = () => Promise.reject(new Error('no net'));
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };

const EXPORT = '\n;module.exports={heatRange,buildHeatFromBars,buildHeatFromCG,finishHeat,fetchCoinglassLiq,' +
  'num,mkBars,SYMS,HEAT_NB,HEAT_NT,clamp,fmt};';
// CG_KEY 在模块加载时读取，测不同 key 状态需重新加载一份实例
function load(cgKey) {
  global.localStorage = {
    getItem: k => (k === 'mb_cgkey' ? (cgKey || null) : null),
    setItem: () => {},
  };
  const m = {};
  new Function('module', 'exports', code + EXPORT)(m, {});
  return m.exports;
}
const A = load(null);

// heatColor 在绘制段（被切掉），单独取出并注入依赖
const hcSrc = src.slice(src.indexOf('function heatColor'), src.indexOf('function drawHeat'));
const heatColor = new Function('clamp', hcSrc + ';return heatColor;')(A.clamp);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? '  → ' + extra : ''))); };

/* ---------- 造数据 ---------- */
function mkBars(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i);
    const w = Math.abs(c) * 0.004;
    out.push({ t: Date.now() - (n - 1 - i) * 900000, o: c * (1 - 0.001), c, h: c + w, l: c - w, v: 100 + i % 7 });
  }
  return out;
}
const mkUp = n => mkBars(n, i => 100 * Math.pow(1.004, i));
const mkDn = n => mkBars(n, i => 100 * Math.pow(0.996, i));
const mkFlat = n => mkBars(n, () => 100);

// 按筹码加权的重心价格
const ctrOf = (h, key) => {
  let s = 0, m = 0;
  for (const r of h.rows) { s += r[key] * r.p; m += r[key]; }
  return m > 0 ? s / m : h.px;
};

const scanNaN = h => {
  if (!h) return 'null';
  const bad = [];
  if (!isFinite(h.px) || !isFinite(h.pLo) || !isFinite(h.pHi) || !isFinite(h.step) || !isFinite(h.maxV)) bad.push('scalar');
  for (const r of h.rows) if (!isFinite(r.p) || !isFinite(r.long) || !isFinite(r.short)) { bad.push('rows'); break; }
  for (const row of h.grid) for (const c of row) if (!isFinite(c.l) || !isFinite(c.s)) { bad.push('grid'); break; }
  if (!isFinite(h.longPct) || !isFinite(h.shortPct) || !isFinite(h.netBias)) bad.push('stats');
  if (!isFinite(h.longBand.lo) || !isFinite(h.longBand.hi)) bad.push('band');
  return bad.join(',') || null;
};

console.log('\n[1] 价格区间 heatRange');
{
  const [lo, hi] = A.heatRange(100, 90, 110);
  ok(lo < 100 && hi > 100, '现价落在区间内', `${lo.toFixed(2)}–${hi.toFixed(2)}`);
  const span1 = (hi - lo) / 100;
  ok(span1 >= 0.029 && span1 <= 0.161, '跨度限制在 3%–16%', (span1 * 100).toFixed(1) + '%');
  const [l2, h2] = A.heatRange(100, 50, 150);
  ok((h2 - l2) / 100 <= 0.161, '极端 K 线区间被收缩到 16% 内', ((h2 - l2) / 100 * 100).toFixed(1) + '%');
  const [l3, h3] = A.heatRange(100, 99.9, 100.1);
  ok((h3 - l3) / 100 >= 0.029, '极窄 K 线区间被放大到至少 3%', ((h3 - l3) / 100 * 100).toFixed(1) + '%');
  const [l4, h4] = A.heatRange(100, 100, 100);
  ok(isFinite(l4) && isFinite(h4) && h4 > l4, '零波动不产生非法区间');
}

console.log('\n[2] buildHeatFromBars 基本结构');
{
  const h = A.buildHeatFromBars(mkUp(80), 100, null, 't', 'est');
  ok(!!h, '返回非空');
  ok(h.rows.length === A.HEAT_NB, `价格档数 = ${A.HEAT_NB}`);
  ok(h.grid.length === A.HEAT_NT || h.grid.length === 80, '时间列数正确', 'got ' + h.grid.length);
  ok(h.grid.every(r => r.length === A.HEAT_NB), '每列档数一致');
  ok(scanNaN(h) === null, '无 NaN/Infinity', scanNaN(h) || '');
  ok(h.px >= h.pLo && h.px <= h.pHi, '现价在绘制区间内');
  ok(h.maxV > 0, '最大强度 > 0');
  ok(h.rows.every(r => r.long >= 0 && r.short >= 0), '筹码量非负');
}

console.log('\n[3] 多空结构语义');
{
  // 几何分配决定「谁在上谁在下」：多头筹码为低位买入区，空头筹码为高位卖出区
  const up = A.buildHeatFromBars(mkUp(80), 100 * Math.pow(1.004, 79), null, 't', 'est');
  const dn = A.buildHeatFromBars(mkDn(80), 100 * Math.pow(0.996, 79), null, 't', 'est');
  ok(up && dn, '两条序列均构建成功');
  ok(ctrOf(up, 'long') < ctrOf(up, 'short'), '上涨序列：多头筹码重心低于空头',
    `L=${ctrOf(up, 'long').toFixed(2)} S=${ctrOf(up, 'short').toFixed(2)}`);
  ok(ctrOf(dn, 'long') < ctrOf(dn, 'short'), '下跌序列：多头筹码重心同样低于空头',
    `L=${ctrOf(dn, 'long').toFixed(2)} S=${ctrOf(dn, 'short').toFixed(2)}`);
  ok(up.longBand.lo < up.shortBand.hi, '多头清算带位于空头清算带下方',
    `L[${up.longBand.lo.toFixed(2)},${up.longBand.hi.toFixed(2)}] S[${up.shortBand.lo.toFixed(2)},${up.shortBand.hi.toFixed(2)}]`);
  ok(Math.abs(up.longPct + up.shortPct - 100) < 0.01, '多空占比合计 100%');
  const flat = A.buildHeatFromBars(mkFlat(80), 100, null, 't', 'est');
  ok(Math.abs(flat.netBias) < 60, '横盘不出现极端偏向', 'netBias=' + flat.netBias.toFixed(1));
  // 中性 CLV（收盘居中）应给出接近 50/50 的买卖力量
  ok(Math.abs(up.netBias) < 40, '中性收盘位置 → 买卖力量接近均衡', 'netBias=' + up.netBias.toFixed(1));
}

console.log('\n[4] 多空持仓比校准');
{
  const base = A.buildHeatFromBars(mkUp(80), 100 * Math.pow(1.004, 79), null, 't', 'est');
  const bull = A.buildHeatFromBars(mkUp(80), 100 * Math.pow(1.004, 79), { ls: 3.0, tk: null }, 't', 'semi');
  const bear = A.buildHeatFromBars(mkUp(80), 100 * Math.pow(1.004, 79), { ls: 0.33, tk: null }, 't', 'semi');
  ok(bull.longPct > base.longPct, '多空比 3.0 → 多头占比提升',
    `${base.longPct.toFixed(1)}% → ${bull.longPct.toFixed(1)}%`);
  ok(bear.longPct < base.longPct, '多空比 0.33 → 多头占比下降',
    `${base.longPct.toFixed(1)}% → ${bear.longPct.toFixed(1)}%`);
  // 校准前向 50% 收缩 0.65：真实多空比长期偏多，全额校准会让方向永远看空
  const expBull = 0.5 + (0.75 - 0.5) * 0.65, expBear = 0.5 + (0.33 / 1.33 - 0.5) * 0.65;
  ok(Math.abs(bull.longPct / 100 - expBull) < 0.04, '多空比 3.0 校准到收缩后的 ~66%',
    bull.longPct.toFixed(1) + '% / 期望 ' + (expBull * 100).toFixed(1) + '%');
  ok(Math.abs(bear.longPct / 100 - expBear) < 0.04, '多空比 0.33 校准到收缩后的 ~34%',
    bear.longPct.toFixed(1) + '% / 期望 ' + (expBear * 100).toFixed(1) + '%');
  ok(bull.netBias > 0 && bear.netBias < 0, '净偏向随真实多空比翻转',
    `${bull.netBias.toFixed(1)} / ${bear.netBias.toFixed(1)}`);
  ok(scanNaN(bull) === null && scanNaN(bear) === null, '校准后无 NaN');
  // 校准不应改变几何结构
  ok(ctrOf(bull, 'long') < ctrOf(bull, 'short'), '校准后多头筹码仍在下方');
}

console.log('\n[5] 异常输入健壮性');
{
  ok(A.buildHeatFromBars([], 100, null, 't', 'est') === null, '空 bars → null');
  ok(A.buildHeatFromBars(mkBars(3, i => 100 + i), 100, null, 't', 'est') === null, '少于 5 根 → null');
  ok(A.buildHeatFromBars(mkBars(60, () => 100), 0, null, 't', 'est') === null, '现价 0 → null');
  ok(A.buildHeatFromBars(mkBars(60, () => 100), NaN, null, 't', 'est') === null, '现价 NaN → null');

  const zero = A.buildHeatFromBars(mkBars(60, i => 100 + i * 0.01).map(b => ({ ...b, v: 0 })), 100.5, null, 't', 'est');
  ok(zero !== null, '零成交量不返回 null');
  ok(scanNaN(zero) === null, '零成交量无 NaN');
  ok(zero.maxV === 0, '零成交量 maxV = 0');

  const flatPx = A.buildHeatFromBars(mkBars(60, () => 100).map(b => ({ ...b, h: 100, l: 100, o: 100, c: 100 })), 100, null, 't', 'est');
  ok(flatPx && scanNaN(flatPx) === null, '价格全等不崩溃');

  const wide = A.buildHeatFromBars(mkBars(60, i => 100 + Math.sin(i) * 40), 140, null, 't', 'est');
  ok(wide && scanNaN(wide) === null, '现价偏离 K 线区间不崩溃');
}

console.log('\n[6] Coinglass 清算记录构建');
{
  const mk = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
  const std = mk(60, i => ({ price: 100 + (i % 20) * 0.5, volUsd: 1e6 + i * 1000, time: Date.now() - (60 - i) * 3600000, side: i % 2 ? 'L' : 'S' }));
  const h = A.buildHeatFromCG(std, 105);
  ok(!!h, '标准字段构建成功');
  ok(scanNaN(h) === null, '无 NaN');
  ok(h.grade === 'real', '标记为真实数据');
  ok(h.label.includes('CoinGlass'), '标签为 CoinGlass');

  const longHeavy = A.buildHeatFromCG(mk(40, i => ({ price: 100 + i * 0.1, volUsd: 1e6, side: 'LONG' })), 102);
  ok(longHeavy.longPct > 90, '全 LONG 记录 → 多头占比 ~100%', longHeavy.longPct.toFixed(1) + '%');
  const shortHeavy = A.buildHeatFromCG(mk(40, i => ({ price: 100 + i * 0.1, volUsd: 1e6, side: 'SHORT' })), 102);
  ok(shortHeavy.shortPct > 90, '全 SHORT 记录 → 空头占比 ~100%', shortHeavy.shortPct.toFixed(1) + '%');

  const noSide = A.buildHeatFromCG(mk(30, i => ({ price: 100 + i * 0.1, volUsd: 1e6 })), 102);
  ok(noSide && Math.abs(noSide.longPct - 50) < 1, '无 side 字段 → 多空均分', noSide.longPct.toFixed(1) + '%');

  const far = A.buildHeatFromCG(mk(30, i => ({ price: i % 2 ? 50 : 500, volUsd: 1e6, side: 'L' })), 100);
  ok(far && scanNaN(far) === null, '极端价格被 clamp 到区间内不崩溃');

  ok(A.buildHeatFromCG([], 100) === null, '空记录 → null');
  ok(A.buildHeatFromCG(mk(10, i => ({ price: 100 + i, volUsd: 1 })), 0) === null, '现价 0 → null');

  const t = A.buildHeatFromCG(mk(50, i => ({ price: 100 + (i % 10), volUsd: 1e6, side: 'L', time: 1700000000000 + i * 3600000 })), 104);
  ok(t.times.length === t.grid.length, '时间轴列数与网格一致');
  ok(t.times.every(x => isFinite(x)), '时间轴无 NaN');
}

console.log('\n[7] Coinglass 接口解析（mock）');
(async () => {
  const AK = load('test-key-123');         // 带 Key 的实例
  const call = async payload => {
    global.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    try { return { data: await AK.fetchCoinglassLiq('BTC') }; }
    catch (e) { return { err: e.message }; }
  };

  let r = await call({ code: '0', msg: 'success', data: Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, volUsd: 1e6, side: 'L', time: Date.now() })) });
  ok(r.data && r.data.length === 10, '标准响应解析出 10 条', r.err || '');
  ok(r.data && r.data[0].side === 'long' && r.data[0].vol === 1e6, 'side/vol 归一化正确',
    r.data ? JSON.stringify(r.data[0]) : '');

  r = await call({ code: '0', data: { list: Array.from({ length: 8 }, (_, i) => ({ p: 100 + i, usd: 1e6, direction: 'SHORT' })) } });
  ok(r.data && r.data.length === 8 && r.data[0].side === 'short', 'data.list 嵌套 + 变体字段解析', r.err || String(r.data && r.data[0].side));

  r = await call({ code: '30001', msg: 'API key missing' });
  ok(!!r.err && /key missing/i.test(r.err), '错误码被抛出', String(r.err));

  r = await call({ code: '0', data: [{ price: 100, volUsd: 1 }] });
  ok(!!r.err && /不足/.test(r.err), '记录不足 5 条时报错', String(r.err));

  r = await call({ code: '0', data: 'unexpected' });
  ok(!!r.err && /无法解析/.test(r.err), '结构异常时报错', String(r.err));

  r = await call({ code: '0', data: Array.from({ length: 10 }, (_, i) => ({ price: null, volUsd: 1, side: 'L' })) });
  ok(!!r.err && /不足/.test(r.err), '价格非法记录被过滤', String(r.err));

  global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ code: '0', data: [] }) });
  try { await A.fetchCoinglassLiq('BTC'); ok(false, '无 Key 应报错'); }
  catch (e) { ok(/Key/.test(e.message), '未配置 Key 时报错', e.message); }

  // UKOIL 无币安永续映射；XAUUSD 已有 XAUUSDT 永续，故不再用黄金做此用例
  try { await AK.fetchCoinglassLiq('UKOIL'); ok(false, '非合约品种应报错'); }
  catch (e) { ok(/映射/.test(e.message), '非合约品种报错', e.message); }

  console.log('\n[8] 全景 NaN 扫描（5 品种 × 4 周期）');
  let bad = 0, cnt = 0;
  for (const s of Object.values(A.SYMS)) {
    for (const tf of ['15m', '30m', '1h', '4h']) {
      const bars = A.mkBars(s.id, tf, 100).bars;
      const h = A.buildHeatFromBars(bars, 100, { ls: 1.2, tk: 0.9 }, 't', 'semi');
      cnt++;
      if (!h || scanNaN(h)) bad++;
    }
  }
  ok(bad === 0, `${cnt} 组合全部无 NaN`, bad + ' 个异常');

  console.log('\n[9] 配色约定：多=绿 / 空=红');
  const rgb = s => (s.match(/\d+/g) || []).map(Number);
  const cLong  = rgb(heatColor(1, 1));
  const cShort = rgb(heatColor(-1, 1));
  const cFlat  = rgb(heatColor(0, 1));
  ok(cLong[1] > cLong[0], '净偏多渲染为绿色（G>R）', `rgb(${cLong})`);
  ok(cShort[0] > cShort[1], '净偏空渲染为红色（R>G）', `rgb(${cShort})`);
  ok(cFlat[1] >= cFlat[0], '中性格不出现红色', `rgb(${cFlat})`);
  ok(cLong[0] < 120 && cShort[1] < 120, '强信号色足够饱和（与白底可区分）',
     `long rgb(${cLong}) / short rgb(${cShort})`);

  ok(/\[H\.longBand, '#12a150', '多头密集'\]/.test(src), '多头密集带标线为绿色');
  ok(/\[H\.shortBand, '#e13b3b', '空头密集'\]/.test(src), '空头密集带标线为红色');
  ok(/if \(sw > 0\) \{ hctx\.fillStyle = 'rgba\(225,59,59,\.72\)'/.test(src), '右侧分布条：空头（左）为红色');
  ok(/if \(lw > 0\) \{ hctx\.fillStyle = 'rgba\(18,161,80,\.72\)'/.test(src), '右侧分布条：多头（右）为绿色');
  ok(/绿色＝多头筹码/.test(src) && /红色＝空头筹码/.test(src), '热力图说明文案与配色一致');

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
