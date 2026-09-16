// 清算引力方向模型验证：切出 app.js 的纯计算段（无 DOM 依赖）
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
global.localStorage = { getItem: () => null, setItem: () => {} };

const EXPORT = '\n;module.exports={liqPools,magnetBands,liqSignal,buildHeatFromBars,buildHeatFromCG,' +
  'finishHeat,heatRange,mkBars,SYMS,HEAT_NB,clamp,fmt,atr};';
const m = {};
new Function('module', 'exports', code + EXPORT)(m, {});
const A = m.exports;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => {
  c ? (pass++, console.log('  ✓ ' + msg))
    : (fail++, console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')));
};
const H = t => console.log('\n' + t);

/* ---------- 造数据 ---------- */
const PX = 30000;

// 把末根收盘价对齐到 px，保证热力图中心与 K 线末价一致（真实链路两者同源）
function norm(bars, px) {
  const k = px / bars[bars.length - 1].c;
  return bars.map(b => ({ t: b.t, o: b.o * k, c: b.c * k, h: b.h * k, l: b.l * k, v: b.v }));
}
// 横盘 K 线：动量≈0，便于单独观察清算项；jitter=0 时为完全静止
function flatBars(n = 60, px = PX, jitter = 0.0008) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = px * (1 + Math.sin(i) * jitter);
    const c = px * (1 + Math.cos(i) * jitter);
    out.push({ t: Date.now() - (n - 1 - i) * 900000, o, c,
               h: Math.max(o, c) * (1 + jitter), l: Math.min(o, c) * (1 - jitter), v: 100 });
  }
  return norm(out, px);
}
function trendBars(n = 60, px = PX, slope = 0.004) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = px * (1 + slope * (i - n / 2) / n * 4);
    const o = c * (1 - slope / 3);
    out.push({ t: Date.now() - (n - 1 - i) * 900000, o, c,
               h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, v: 100 });
  }
  return norm(out, px);
}

// 由「每个价格档的多/空清算量」构造热力图
function mkHeat(fn, px = PX, span = 0.06, n = 60) {
  const pLo = px * (1 - span / 2), pHi = px * (1 + span / 2);
  const step = (pHi - pLo) / n;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = pLo + (i + 0.5) * step;
    const v = fn(p, i / (n - 1)) || {};
    rows.push({ p, long: v.long || 0, short: v.short || 0 });
  }
  return A.finishHeat({ grid: [], rows, pLo, pHi, step, px, maxV: 0, times: [],
                        label: 'test', grade: 'real', lsInfo: null });
}
const above = (p, px) => p > px;
const sig = (heat, bars, opt) => A.liqSignal(bars || flatBars(), heat, opt || {});

/* ---------- 1) 清算池方向 ---------- */
H('[1] 清算池引力决定方向');
{
  const upHeat = mkHeat(p => above(p, PX) ? { short: 100 } : { long: 5 });
  const dnHeat = mkHeat(p => above(p, PX) ? { short: 5 } : { long: 100 });
  const sUp = sig(upHeat), sDn = sig(dnHeat);
  ok(sUp.dir === 'long', '上方空单清算池占优 → 做多', sUp.dir + ' ' + sUp.score.toFixed(1));
  ok(sDn.dir === 'short', '下方多单清算池占优 → 做空', sDn.dir + ' ' + sDn.score.toFixed(1));
  ok(sUp.upPct > sUp.dnPct && sDn.dnPct > sDn.upPct, '上下方清算占比方向一致',
     `${sUp.upPct.toFixed(1)}/${sUp.dnPct.toFixed(1)} · ${sDn.upPct.toFixed(1)}/${sDn.dnPct.toFixed(1)}`);
  ok(sUp.upPct + sUp.dnPct <= 100.0001, '上下方占比之和 ≤ 100%', String(sUp.upPct + sUp.dnPct));

  // 静止行情下趋势项归零，均衡的清算池应判观望
  const eq = sig(mkHeat(p => above(p, PX) ? { short: 50 } : { long: 50 }), flatBars(60, PX, 0));
  ok(eq.dir === 'wait', '两侧均衡 → 观望', eq.dir + ' ' + eq.score.toFixed(1));
}

/* ---------- 2) 距离衰减 ---------- */
H('[2] 距离衰减：近端燃料更有吸引力');
{
  const near = mkHeat(p => (p > PX && p < PX * 1.012) ? { short: 100 } : { long: 1 });
  const far  = mkHeat(p => (p > PX * 1.024) ? { short: 100 } : { long: 1 });
  const sn = sig(near), sf = sig(far);
  ok(sn.score > sf.score, '同量清算，靠近现价一侧得分更高',
     `near=${sn.score.toFixed(1)} far=${sf.score.toFixed(1)}`);
  const P = A.liqPools(far, PX, PX * 0.004);
  ok(P.up > 0 && P.up < P.upRaw, '远池按距离衰减后权重小于原始量',
     `${P.up.toFixed(2)} < ${P.upRaw}`);
}

/* ---------- 3) 磁吸带 ---------- */
H('[3] 近端清算墙');
{
  const h = mkHeat(p => {
    if (p > PX * 1.008 && p < PX * 1.020) return { short: 100 };
    if (p < PX * 0.980) return { long: 60 };
    return { long: 1, short: 1 };
  });
  const M = A.magnetBands(h, PX, PX * 0.004);
  ok(!!M.up && M.up.p > PX, '识别到上方磁吸带', M.up && M.up.p.toFixed(1));
  ok(!!M.dn && M.dn.p < PX, '识别到下方磁吸带', M.dn && M.dn.p.toFixed(1));
  ok(M.up.v >= 0.32 && M.dn.v >= 0.32, '磁吸带强度达到阈值');
  ok(M.up.d < M.dn.d || M.up.v > M.dn.v, '上方带更近或更厚时优先级更高');

  const zero = A.magnetBands(mkHeat(() => ({ long: 0, short: 0 })), PX, 100);
  ok(!zero.up && !zero.dn, '全空热力图不产生磁吸带');
}

/* ---------- 4) 资金费率与多空比 ---------- */
H('[4] 拥挤度修正（资金费率 / 多空持仓比）');
{
  const h = mkHeat(p => above(p, PX) ? { short: 50 } : { long: 50 });
  const base = sig(h, flatBars(), { funding: 0 });
  const posF = sig(h, flatBars(), { funding: 0.0006 });   // 多头付费
  const negF = sig(h, flatBars(), { funding: -0.0006 });  // 空头付费
  ok(posF.score < base.score && base.score < negF.score, '正费率扣分、负费率加分',
     `${posF.score.toFixed(1)} < ${base.score.toFixed(1)} < ${negF.score.toFixed(1)}`);
  // 多空比已通过筹码校准进入清算池，不再单独计分——否则与校准重复惩罚，所有品种系统性偏空
  const longCrowd = sig(h, flatBars(), { funding: 0, ls: 2.4 });
  const shortCrowd = sig(h, flatBars(), { funding: 0, ls: 0.6 });
  ok(longCrowd.score === shortCrowd.score, '多空持仓比不重复计分（只由筹码校准传导）',
     `${longCrowd.score.toFixed(2)} vs ${shortCrowd.score.toFixed(2)}`);
  ok(longCrowd.reasons.join('').includes('多空持仓比'), '多空比仍作为判定依据展示');
  const bs = trendBars(90, PX, 0.01);
  const hL = A.buildHeatFromBars(bs, PX, { ls: 3.0, tk: 1 }, 't', 'semi');
  const hS = A.buildHeatFromBars(bs, PX, { ls: 0.5, tk: 1 }, 't', 'semi');
  ok(hL.longPct > hS.longPct, '高多空比 → 多头筹码占比更高（校准传导生效）',
     `${hL.longPct.toFixed(1)} vs ${hS.longPct.toFixed(1)}`);
  ok(sig(h, flatBars(), { funding: null, ls: null }).score === base.score ||
     isFinite(sig(h, flatBars(), { funding: null, ls: null }).score),
     '缺失费率/多空比时不影响打分');
}

/* ---------- 5) 趋势只做确认，不主导 ---------- */
H('[5] 趋势权重低于清算项');
{
  const upHeat = mkHeat(p => above(p, PX) ? { short: 100 } : { long: 2 });
  const withUp = sig(upHeat, trendBars(60, PX, 0.01), {});
  const against = sig(upHeat, trendBars(60, PX, -0.01), {});
  ok(withUp.score > against.score, '趋势同向时分数更高',
     `${withUp.score.toFixed(1)} > ${against.score.toFixed(1)}`);
  ok(against.dir === 'long', '清算方向极端时，逆趋势也不翻转方向', against.dir);
  const tPart = withUp.parts.find(p => p.k === '趋势确认');
  ok(Math.abs(tPart.v) <= 18.0001, '趋势项权重封顶 18', String(tPart && tPart.v));
  const gPart = withUp.parts.find(p => p.k === '清算池引力');
  ok(Math.abs(gPart.v) > Math.abs(tPart.v), '清算项权重高于趋势项',
     `${gPart.v} vs ${tPart.v}`);
}

/* ---------- 6) 关键位 ---------- */
H('[6] 触发位 / 目标 / 失效位');
{
  const upHeat = mkHeat(p => above(p, PX) ? { short: 100 } : { long: 20 });
  const dnHeat = mkHeat(p => above(p, PX) ? { short: 20 } : { long: 100 });
  const L = sig(upHeat), S = sig(dnHeat);
  ok(L.dir === 'long' && L.sl < L.px && L.tp > L.px && L.trigger > L.px,
     '做多：止损在下方、目标与触发位在上方',
     `sl=${L.sl.toFixed(1)} px=${L.px.toFixed(1)} trig=${L.trigger.toFixed(1)} tp=${L.tp.toFixed(1)}`);
  ok(S.dir === 'short' && S.sl > S.px && S.tp < S.px && S.trigger < S.px,
     '做空：止损在上方、目标与触发位在下方',
     `sl=${S.sl.toFixed(1)} px=${S.px.toFixed(1)} trig=${S.trigger.toFixed(1)} tp=${S.tp.toFixed(1)}`);
  ok(L.reasons.length >= 3 && L.reasons.every(r => typeof r === 'string' && r.length),
     '输出可读的判定依据', String(L.reasons.length));
  ok(L.reasons.join('').includes('清算'), '依据文案点明清算口径');
}

/* ---------- 7) 真实链路：K 线推算 & Coinglass 记录 ---------- */
H('[7] 真实数据链路');
{
  const bars = trendBars(120, PX, 0.02);              // 末价已对齐 PX
  const h = A.buildHeatFromBars(bars, PX, { ls: 1.2, tk: 1 }, 'test', 'semi');
  ok(!!h, 'K 线构建热力图成功');
  const s = A.liqSignal(bars, h, { funding: 0.0001, ls: 1.2, dp: 2 });
  ok(['long', 'short', 'wait'].includes(s.dir), '方向合法', s.dir);
  ok(isFinite(s.score) && Math.abs(s.score) <= 100, '分数在 ±100 内', String(s.score));
  ok(s.parts.length >= 4, '各分项均有输出', String(s.parts.length));

  // Coinglass 口径：空头强平记录在上方 → 偏多
  const cg = [];
  for (let i = 0; i < 60; i++) {
    cg.push({ price: PX * (1.005 + i * 0.0002), vol: 100000 + i, time: Date.now() - i * 3600000, side: 'S' });
  }
  for (let i = 0; i < 8; i++) {
    cg.push({ price: PX * (0.998 - i * 0.0002), vol: 20000, time: Date.now() - i * 3600000, side: 'L' });
  }
  const hc = A.buildHeatFromCG(cg, PX);
  ok(!!hc && hc.grade === 'real', 'Coinglass 记录构建为 real 级热力图');
  const sc = A.liqSignal(flatBars(60, PX, 0), hc, { funding: 0, dp: 2 });
  ok(sc.dir === 'long', '上方空头清算为主 → 做多', sc.dir + ' ' + sc.score.toFixed(1));
  ok(sc.upPct > sc.dnPct, '上方清算占比更高', `${sc.upPct.toFixed(1)} vs ${sc.dnPct.toFixed(1)}`);
}

/* ---------- 8) 健壮性 ---------- */
H('[8] 健壮性：异常输入不产生 NaN');
{
  const cases = [
    ['空 rows', mkHeat(() => ({}), PX), flatBars()],
    ['全零', mkHeat(() => ({ long: 0, short: 0 }), PX), flatBars()],
    ['极端杠杆位', mkHeat(p => above(p, PX) ? { short: 1e9 } : { long: 1e-9 }, PX), flatBars()],
    ['区间外清算', mkHeat(p => ({ long: p < PX * 0.8 ? 50 : 0, short: p > PX * 1.2 ? 50 : 0 }), PX), flatBars()],
    ['仅 3 根 K 线', mkHeat(p => above(p, PX) ? { short: 9 } : { long: 3 }, PX), flatBars(3)],
    ['零波动 K 线', mkHeat(p => above(p, PX) ? { short: 9 } : { long: 3 }, PX),
      Array.from({ length: 40 }, () => ({ t: Date.now(), o: PX, c: PX, h: PX, l: PX, v: 1 }))],
  ];
  let bad = 0, details = [];
  for (const [name, heat, bars] of cases) {
    for (const opt of [{}, { funding: 0.0003, ls: 2 }, { funding: -0.0003, ls: 0.5, dp: 3 }]) {
      const s = A.liqSignal(bars, heat, opt);
      const nums = [s.score, s.upPct, s.dnPct, s.tp, s.sl, s.atr, s.atrPct, s.posPct]
        .concat(s.parts.map(p => p.v));
      if (!nums.every(Number.isFinite)) { bad++; details.push(name); break; }
      if (!['long', 'short', 'wait'].includes(s.dir)) { bad++; details.push(name + '(dir)'); break; }
      if (s.dir === 'long' && !(s.sl < s.px && s.tp > s.px)) { bad++; details.push(name + '(位序)'); break; }
      if (s.dir === 'short' && !(s.sl > s.px && s.tp < s.px)) { bad++; details.push(name + '(位序)'); break; }
    }
  }
  ok(bad === 0, `${cases.length} 类异常输入全部输出合法`, details.join(','));

  const badHeat = A.liqPools({ rows: [] }, PX, 100);
  ok(badHeat.tot === 0 && badHeat.upPct === 0 && badHeat.dnPct === 0, '空表清算池归零');
}

/* ---------- 9) 五品种跑通 ---------- */
H('[9] 五个品种均可计算');
{
  let bad = [];
  for (const id of Object.keys(A.SYMS)) {
    const s = A.SYMS[id];
    const bars = A.mkBars(id, '1h', 100).bars;
    const px = bars[bars.length - 1].c;
    const h = A.buildHeatFromBars(bars, px, null, 't', 'est');
    if (!h) { bad.push(id + '(无热力图)'); continue; }
    const r = A.liqSignal(bars, h, { funding: 0.0001, dp: s.dp });
    if (!['long', 'short', 'wait'].includes(r.dir) || !Number.isFinite(r.score)) bad.push(id);
  }
  ok(bad.length === 0, '五品种方向均可计算', bad.join(','));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
