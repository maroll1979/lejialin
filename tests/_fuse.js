// 多因子方向融合 + 做市商视角 + K 线缩放：切出 app.js 的纯计算段（无 DOM 依赖）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');

const indStart = src.indexOf('/* ============================ 结构 · 量能 · 波动');
const indEnd = src.indexOf('// 打分模型：以趋势跟随为主');
const hStart = src.indexOf('/* ============================ 多空筹码热力图');
const hEnd = src.indexOf('/* --- 绘制 --- */');
const kvStart = src.indexOf('/* 可视区间：默认贴住最右侧');
const kvEnd = src.indexOf('function draw() {');
[['indStart', indStart], ['indEnd', indEnd], ['hEnd', hEnd], ['kvStart', kvStart], ['kvEnd', kvEnd]]
  .forEach(([k, v]) => { if (v < 0) throw new Error('切分点未找到: ' + k); });

// slice(0,indEnd) 含基础指标（sma/ema/rsi/macd/boll/atr）+ 结构/量能/多因子段；
// 再拼热力图段（liqPools/magnetBands/liqSignal/finishHeat）与可视区间段（kvRange/kvReset）
const code = src.slice(0, indEnd) + '\n' +
  src.slice(hStart, hEnd) + '\n' +
  src.slice(kvStart, kvEnd);

global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.fetch = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
const _store = {};
global.localStorage = {
  getItem: k => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
};

const EXPORT = '\n;module.exports={obv,obvFeat,zigzag,structFeat,bollFeat,macdFeat,fuseSignal,mmView,' +
  'fuseIndep,FUSE_GROUP,FUSE_RHO,FUSE_INDEP_FULL,FUSE_MIN_INDEP,' +
  'sweepTendency,sweepLabel,SWEEP_CALIB,SWEEP_TENDENCY_NOTE,CONF_NOTE,INDEP_NOTE,' +
  'kvRange,kvReset,FUSE_W,S,SYM_LIST,SYMS,clamp,fmt,boll,macd,atr,sma,ema,liqSignal,finishHeat,liqPools,magnetBands,' +
  'liqZones,heatScaleOf,kdj,kdjFeat};';
const m = {};
new Function('module', 'exports', code + EXPORT)(m, {});
const X = m.exports;
const { obv, obvFeat, zigzag, structFeat, bollFeat, macdFeat, fuseSignal, mmView, kvRange, kvReset, FUSE_W, S } = X;
const { clamp, fmt, SYM_LIST, liqZones, atr, kdj, kdjFeat } = X;
const { fuseIndep, FUSE_GROUP, FUSE_RHO, FUSE_INDEP_FULL, FUSE_MIN_INDEP } = X;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => {
  c ? (pass++, console.log('  ✓ ' + msg))
    : (fail++, console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')));
};
const H = t => console.log('\n' + t);

/* ---------- 造 K 线：可控趋势 + 可控成交量 ---------- */
function mkBars(n, opt = {}) {
  const { px = 30000, drift = 0.0006, noise = 0.0022, volTrend = 0, seed = 7 } = opt;
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647 - 0.5; };
  const bars = [];
  let p = px;
  for (let i = 0; i < n; i++) {
    const o = p;
    const d = drift + rnd() * noise * 2;
    p = o * (1 + d);
    const h = Math.max(o, p) * (1 + Math.abs(rnd()) * noise * 0.5);
    const l = Math.min(o, p) * (1 - Math.abs(rnd()) * noise * 0.5);
    // volTrend>0：涨的量比跌的大（量价配合）；<0 反之
    const up = p >= o;
    const base = 1000 * (1 + volTrend * (up ? 0.9 : -0.9));
    bars.push({ t: 1700000000000 + i * 3600000, o, h, l, c: p, v: Math.max(50, base * (0.7 + Math.abs(rnd()))) });
  }
  return bars;
}
// 造一个「阶梯上升」结构：确保 zigzag 找到 HH/HL
function mkStair(n, step = 0.012) {
  const bars = [];
  let p = 30000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const phase = i % 10;
    p = o * (1 + (phase < 6 ? step * 0.35 : -step * 0.22));   // 6 涨 4 跌 → 净上升
    const h = Math.max(o, p) * 1.0015, l = Math.min(o, p) * 0.9985;
    bars.push({ t: 1700000000000 + i * 3600000, o, h, l, c: p, v: 1000 + (p >= o ? 300 : -100) });
  }
  return bars;
}
// 分段造 K 线：每段给固定涨跌幅与成交量，用来构造量价背离
function mkSeg(segs) {
  const bars = []; let p = 30000, k = 0;
  for (const s of segs) {
    for (let i = 0; i < s.n; i++) {
      const o = p; p = o * (1 + s.d);
      bars.push({ t: 1700000000000 + (k++) * 3600000, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: s.v });
    }
  }
  return bars;
}
// 造清算热力图（与 _liq.js 同源：rows 含 long/short）
function mkHeat(px, opt = {}) {
  const { upBias = 1, dnBias = 1, span = 0.06 } = opt;
  const N = 61, step = (px * span * 2) / N;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const p = px - px * span + i * step;
    const d = Math.abs(p - px) / (px * span);
    const base = Math.exp(-d * 2.2) * 1000;
    rows.push({
      p,
      long: p < px ? base * dnBias : base * 0.3,
      short: p > px ? base * upBias : base * 0.3,
    });
  }
  return X.finishHeat ? X.finishHeat({
    rows, step, pLo: rows[0].p, pHi: rows[N - 1].p, mid: px, netBias: 0,
  }) : { rows, step, pLo: rows[0].p, pHi: rows[N - 1].p, mid: px, netBias: 0 };
}

/* ============================================================ */
H('[1] OBV 与量能');
{
  const b = mkBars(120, { drift: 0.002, volTrend: 0.6 });
  const o = obv(b);
  ok(o.length === b.length, 'OBV 长度与 K 线一致', o.length + '/' + b.length);
  ok(o[0] === 0, 'OBV 起点为 0');
  const f = obvFeat(b);
  ok(isFinite(f.s) && f.s >= -1 && f.s <= 1, 'OBV 方向分在 [-1,1]', String(f.s));
  ok(f.s > 0, '价涨量增 → OBV 偏多', fmt(f.s, 3));

  const dn = mkBars(120, { drift: -0.002, volTrend: -0.6, seed: 21 });
  const fd = obvFeat(dn);
  ok(fd.s < 0, '价跌量增 → OBV 偏空', fmt(fd.s, 3));

  /* 顶背离必须长成「涨 → 回撤 → 再创新高」的两段式：单调上涨的序列里
   * 「前一个高点」就是上一根，OBV 每根都在加正成交量，永远不可能出现量能不跟。 */
  const dv = mkSeg([
    { n: 30, d: 0.004, v: 2000 },    // 第一段上涨：放量
    { n: 20, d: -0.004, v: 800 },    // 回撤：缩量
    { n: 30, d: 0.005, v: 500 },     // 第二段创新高：量能明显跟不上
  ]);
  const fv = obvFeat(dv);
  ok(fv.bear === true, '价格新高但量能不跟 → 识别为顶背离', 'bear=' + fv.bear);
  ok(fv.s < 0.35, '顶背离把 OBV 分从 0.77 拉回到弱多头区间', fmt(fv.s, 3));

  // 空数据不崩
  ok(obvFeat([]).s === 0 && obv([]).length === 0, '空 K 线不崩');
  ok(isFinite(obvFeat(mkBars(3)).s), '极短 K 线不崩');
}

H('[2] ZigZag 与 K 线结构');
{
  const up = mkStair(150);
  const zu = zigzag(up, 0.02);
  ok(zu.length >= 3, '上升阶梯识别出多个摆动点', zu.length + ' 个');
  ok(zu.every(p => p.t === 'H' || p.t === 'L'), '摆动点只含 H/L');
  ok(zu.every((p, i) => i === 0 || p.i !== zu[i - 1].i), '摆动点索引不重复');
  const su = structFeat(up);
  ok(su.trend === 'up', '阶梯上升 → 结构判定为上升', su.trend);
  ok(su.s > 0, '上升结构得分为正', fmt(su.s, 3));
  ok(su.swingHi > su.swingLo, '摆动高点 > 摆动低点');

  // 反转：把上升序列倒过来当下降
  const dnBars = mkStair(150, -0.012);
  const sd = structFeat(dnBars);
  ok(sd.trend === 'down', '阶梯下降 → 结构判定为下降', sd.trend);
  ok(sd.s < 0, '下降结构得分为负', fmt(sd.s, 3));

  // 横盘
  // 横盘：两个不可通约的频率叠加，避免出现「振幅恒定 → 高低点并列」的退化序列
  //（那种序列的 HH / LH 由浮点误差决定，今天是 up 明天可能就是 down）
  let p = 30000; const flat = [];
  for (let i = 0; i < 120; i++) {
    const o = p;
    p = 30000 * (1 + Math.sin(i / 5) * 0.0045 + Math.sin(i / 1.9) * 0.0018);
    flat.push({ t: 1700000000000 + i * 3600000, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 1000 });
  }
  const sf = structFeat(flat);
  ok(['range', 'contract', 'expand'].includes(sf.trend), '横盘 → 结构非趋势', sf.trend);

  ok(structFeat(mkBars(5)).trend === 'range', '极短 K 线结构 = range');
  ok(zigzag([], 0.02).length === 0, '空 K 线 zigzag 为空');
  // BOS：价格站上所有摆动高点
  const hi = Math.max.apply(null, mkStair(100).map(b => b.h));
  const b2 = mkStair(100); b2[b2.length - 1].c = hi * 1.05; b2[b2.length - 1].h = hi * 1.06;
  const s2 = structFeat(b2);
  ok(s2.bos === 'up', '收盘站上摆动高点 → BOS 向上', String(s2.bos));
}

H('[3] BOLL 与 MACD 特征');
{
  const b = mkBars(150, { drift: 0.003 });
  const bf = bollFeat(b);
  ok(bf.pb >= 0 && bf.pb <= 1, '%B 在 [0,1]', fmt(bf.pb, 3));
  ok(bf.rank >= 0 && bf.rank <= 1, '带宽分位在 [0,1]', fmt(bf.rank, 3));
  ok(bf.B && bf.B.up.length === b.length, 'BOLL 序列长度对齐');
  ok(bf.s > 0, '强势上行 → BOLL 偏多', fmt(bf.s, 3));

  // 价格打到上轨之上 → %B > 1 被夹到 1
  const b2 = mkBars(150, { drift: 0.0005 });
  b2[b2.length - 1].c = b2[b2.length - 1].c * 1.08;
  ok(bollFeat(b2).pb > 0.9, '价格远超中轨 → %B 接近 1', fmt(bollFeat(b2).pb, 3));

  // 挤压：最后 40 根波动收敛。注意必须从上一根收盘价接力起算，
  // 直接用原序列的 o 会让相邻两根仍随机跳 ±0.4%，20 根窗口根本不收敛。
  const b3 = mkBars(150, { drift: 0, noise: 0.004, seed: 3 });
  let q0 = b3[109].c;
  for (let i = 110; i < 150; i++) {
    const o = q0; q0 = o * (1 + 0.00002);
    b3[i] = { t: b3[i].t, o, h: Math.max(o, q0) * 1.0002, l: Math.min(o, q0) * 0.9998, c: q0, v: 1000 };
  }
  const bf3 = bollFeat(b3);
  ok(bf3.squeeze === true, '末端波动收敛 → 判定为挤压', 'rank=' + fmt(bf3.rank, 3));
  ok(Math.abs(bf3.s) < 0.5, '挤压时方向分被压低', fmt(bf3.s, 3));

  const mf = macdFeat(mkBars(150, { drift: 0.003 }));
  ok(mf.s > 0, '上行 → MACD 偏多', fmt(mf.s, 3));
  ok([-1, 0, 1].includes(mf.cross), '金叉死叉取值为 -1/0/1', String(mf.cross));
  const md = macdFeat(mkBars(150, { drift: -0.003, seed: 11 }));
  ok(md.s < 0, '下行 → MACD 偏空', fmt(md.s, 3));
  ok(isFinite(macdFeat(mkBars(5)).s), '极短 K 线 MACD 不崩');
}

H('[4] 多因子融合：清算图不能单独定方向');
{
  const bars = mkBars(200, { drift: 0.003, volTrend: 0.5 });   // 技术面明确向上
  const px = bars[bars.length - 1].c;
  S.heats = {}; S.quotes = {};

  // A) 无清算图 → 结构 22 / MACD 16 / OBV 14 / BOLL 14 重分配
  const F0 = fuseSignal('BTC', '1h', bars);
  ok(F0.liq === null, '无清算数据时 liq 因子为空');
  ok(F0.contrib.length === 5, '无清算数据时技术面 5 个因子（结构/MACD/OBV/BOLL/KDJ）', F0.contrib.length + '');
  ok(F0.dir === 'long', '技术面全多头 → 方向做多', F0.dir + ' ' + fmt(F0.score, 1));
  const w0 = F0.contrib.reduce((a, x) => a + x.w, 0);
  ok(w0 === 78, '无清算时技术面权重合计 78（22+16+14+14+12）', String(w0));

  // B) 关键回归：清算图满仓看空(-34)，技术面全多头(+66) → 结果必须仍为做多
  S.heats['BTC'] = { '1h': mkHeat(px, { upBias: 0.02, dnBias: 6 }) };   // 下方多单清算极厚 → 引力向下
  const F1 = fuseSignal('BTC', '1h', bars);
  ok(F1.contrib.length === 6, '有清算数据时 6 项（技术 5 + 清算修正 1）');
  ok(F1.liq.score < -20, '清算因子确实强烈偏空', fmt(F1.liq.score, 1));
  ok(F1.dir === 'long', '清算图看空但技术面全多头 → 最终仍做多（清算图不能独裁）', F1.dir + ' 合成=' + fmt(F1.score, 1));
  ok(F1.score < F0.score, '加入反向清算因子后合成分被拉低', fmt(F1.score, 1) + ' < ' + fmt(F0.score, 1));

  // C) 反向：清算图满仓看多(+34)，技术面全空头 → 结果必须仍为做空
  const dnBars = mkBars(200, { drift: -0.003, volTrend: -0.5, seed: 33 });
  const dpx = dnBars[dnBars.length - 1].c;
  S.heats['ETH'] = { '1h': mkHeat(dpx, { upBias: 6, dnBias: 0.02 }) };
  const F2 = fuseSignal('ETH', '1h', dnBars);
  ok(F2.liq.score > 20, '清算因子确实强烈偏多', fmt(F2.liq.score, 1));
  ok(F2.dir === 'short', '清算图看多但技术面全空头 → 最终仍做空', F2.dir + ' 合成=' + fmt(F2.score, 1));

  // D) 清算图权重确实只有 34
  ok(FUSE_W.liq === 34, '清算图权重为 34（不主导）', String(FUSE_W.liq));
  ok(FUSE_W.st + FUSE_W.macd + FUSE_W.obv + FUSE_W.boll === 66, '其余四项合计 66');

  // E) 一致度：全同向时 100%
  ok(Math.abs(F0.conf - 1) < 0.001, '全部同向 → 一致度 100%', fmt(F0.conf, 3));
  ok(F1.conf < 1, '出现反向因子 → 一致度下降', fmt(F1.conf, 3));

  // F) 贡献之和 = 合成分 / (0.62+0.38*conf)
  const sum = F1.contrib.reduce((a, x) => a + x.c, 0);
  ok(Math.abs(sum - F1.raw) < 0.01, '各因子贡献之和 = 原始合成分', fmt(sum, 2) + ' vs ' + fmt(F1.raw, 2));

  // G) 分数范围与健壮性
  [F0, F1, F2].forEach((F, i) => {
    ok(F.score >= -100 && F.score <= 100, '合成分在 [-100,100] #' + i, fmt(F.score, 1));
    ok(['long', 'short', 'wait'].includes(F.dir), '方向取值合法 #' + i, F.dir);
    ok(!F.contrib.some(x => !isFinite(x.s) || !isFinite(x.c)), '贡献值无 NaN #' + i);
  });
  ok(isFinite(fuseSignal('BTC', '1h', mkBars(5)).score), '极短 K 线融合不崩');
}

H('[5] 做市商视角结论');
{
  const bars = mkBars(200, { drift: 0.003, volTrend: 0.5 });
  const px = bars[bars.length - 1].c;
  S.heats = { BTC: { '1h': mkHeat(px, { upBias: 0.02, dnBias: 6 }) } };  // 流动性在下方，技术面在上方
  S.quotes = {};
  const V = mmView('BTC', '1h', bars);
  ok(['follow', 'sweep', 'stand'].includes(V.mode), '结论模式合法', V.mode);
  ok(V.mode === 'sweep', '流动性在下、结构在上 → 判定为扫单后反转', V.mode);
  ok(V.liqSide === 'down', '识别流动性偏下方', String(V.liqSide));
  ok(V.techSide === 'up', '识别技术面偏上方', String(V.techSide));
  ok(V.bias === 'long', '扫单情形下最终偏向取技术侧（做多）', V.bias);
  ok(V.sweep && V.sweep.side === 'down', '扫单目标在下方（先扫多单止损）', V.sweep && V.sweep.side);
  ok(V.sweep.score > 0.3 && V.sweep.score < 0.95, '扫单评分（相对评分，非概率）在合理区间', fmt(V.sweep.score, 3));
  ok(V.sweep.prob === undefined, '扫单不再暴露名为 prob 的字段（避免被当概率渲染）', String(V.sweep.prob));
  ok(V.sweep.tendency && ['high','mid','low'].includes(V.sweep.tendency.level), '扫单带出档位对象', JSON.stringify(V.sweep.tendency));
  ok(V.reasons.length >= 4, '给出至少 4 条依据（流动性/结构/动能/量能/波动）', V.reasons.length + '');
  ok(V.reasons.every(r => typeof r === 'string' && r.length > 0), '依据均为非空字符串');
  ok(!V.reasons.some(r => /NaN|undefined/.test(r)), '依据无 NaN / undefined');

  // 同向 → follow
  S.heats = { BTC: { '1h': mkHeat(px, { upBias: 6, dnBias: 0.02 }) } };
  const V2 = mmView('BTC', '1h', bars);
  ok(V2.mode === 'follow', '流动性与技术面同向 → 顺势', V2.mode);
  ok(V2.bias === 'long', '顺势情形偏向做多', V2.bias);
  ok(V2.sweep === null, '顺势时无扫单目标');

  // 无清算数据 → 退化为纯技术
  S.heats = {};
  const V3 = mmView('BTC', '1h', bars);
  ok(V3.liqSide === null, '无清算数据时流动性侧为空');
  ok(['follow', 'stand'].includes(V3.mode), '无清算数据时不会误判为扫单', V3.mode);
  ok(V3.reasons.some(r => /无清算数据/.test(r)), '依据中写明无清算数据');

  // 横盘 + 挤压 → stand。用均值回归过程造真正的震荡：纯正弦波在任何端点上
  // 局部都长得像一段趋势（200 根 / 周期 37 根的波，末段必然在往上或往下走）。
  const flat = [];
  let fp = 30000;
  for (let i = 0; i < 200; i++) {
    const o = fp;
    fp = o + (30000 - o) * 0.12 + 30000 * Math.sin(i * 2.3) * 0.0016;
    flat.push({ t: 1700000000000 + i * 3600000, o, h: Math.max(o, fp) * 1.0008, l: Math.min(o, fp) * 0.9992, c: fp, v: 1000 });
  }
  S.heats = { BTC: { '1h': mkHeat(fp, { upBias: 1, dnBias: 1 }) } };
  const V4 = mmView('BTC', '1h', flat);
  ok(V4.bias === 'wait' || V4.mode === 'stand' || Math.abs(V4.F.score) < 25,
     '横盘时不做强方向判断', V4.mode + ' ' + V4.bias + ' ' + fmt(V4.F.score, 1));

  // 五品种全跑通
  SYM_LIST.forEach(s => {
    const b = mkBars(150, { drift: 0.001, seed: s.id.length + 5 });
    S.heats = { [s.id]: { '1h': mkHeat(b[b.length - 1].c, { upBias: 2, dnBias: 1 }) } };
    const v = mmView(s.id, '1h', b);
    ok(isFinite(v.F.score) && ['long', 'short', 'wait'].includes(v.bias),
       `[${s.id}] 做市商结论可产出`, v.mode + '/' + v.bias);
  });
  S.heats = {};
}

H('[6] K 线可视区间（缩放 / 平移）');
{
  const n = 500;
  kvReset();
  let r = kvRange(n);
  ok(r.cnt === 130, '默认可见 130 根', String(r.cnt));
  ok(r.i1 === n - 1, '默认贴住最新一根', String(r.i1));
  ok(r.i0 === n - 130, '默认左端 = n - 130', String(r.i0));

  S.kvCount = 50;
  r = kvRange(n);
  ok(r.cnt === 50 && r.i1 === n - 1, '缩小到 50 根仍贴右', r.i0 + '~' + r.i1);

  S.kvEnd = 200;                       // 向左拉回看历史
  r = kvRange(n);
  ok(r.i1 === 200 && r.i0 === 151, '指定右端 → 区间 [151,200]', r.i0 + '~' + r.i1);

  S.kvEnd = 10;                        // 越过左边界，应被夹住
  r = kvRange(n);
  ok(r.i0 === 0 && r.i1 === 49, '右端越界时夹到最左端', r.i0 + '~' + r.i1);

  S.kvEnd = 9999;
  r = kvRange(n);
  ok(r.i1 === n - 1, '右端超出 n 时夹到 n-1', String(r.i1));

  S.kvCount = 9999;
  r = kvRange(n);
  ok(r.cnt === n, '可见根数上限 = K 线总根数', String(r.cnt));
  ok(r.i0 === 0, '放大到全部时左端为 0', String(r.i0));

  S.kvCount = 1;
  r = kvRange(n);
  ok(r.cnt === 15, '可见根数下限 15 根', String(r.cnt));

  S.kvCount = 0;
  r = kvRange(n);
  ok(r.cnt >= 15, '非法 count(0) 被夹到下限', String(r.cnt));

  kvReset();
  ok(S.kvCount === 130 && S.kvEnd === null, '复位恢复默认视野');
  // 数据不足一屏
  r = kvRange(40);
  ok(r.i0 === 0 && r.i1 === 39, 'K 线不足 130 根时全部显示', r.i0 + '~' + r.i1);
}

H('[7] 价格带区间（做市商板块核心输出）');
{
  /* 回归点：第一版把「所有高于阈值的连续档」并成一条带，宽度达 142 个 ATR，
   * 等于把半张热力图涂满，完全失去定位意义。这里用宽度上限把它钉死。 */
  const bars = mkBars(200, { drift: 0.003, volTrend: 0.5 });
  const px = bars[bars.length - 1].c;
  /* 上下两侧都要有峰：upBias 压到 0.02 时上方几乎没有清算密度，
   * 阈值下根本找不到峰，此时「没有上方带」是正确结果而不是 bug。 */
  const heat = mkHeat(px, { upBias: 2.5, dnBias: 6 });
  const atrV = atr(bars)[bars.length - 1];
  const Z = liqZones(heat, px, atrV);

  ok(Array.isArray(Z), 'liqZones 返回数组');
  ok(Z.length > 0, '有清算数据时至少识别出一段价格带', Z.length + ' 段');
  ok(Z.every(z => z.hi > z.lo), '每段的 hi > lo');
  ok(Z.every(z => !(z.lo < px && z.hi > px)),
     '任何一段都不跨现价（跨现价的带已在现价处切成上下两半）',
     Z.filter(z => z.lo < px && z.hi > px).map(z => fmt(z.lo, 1) + '~' + fmt(z.hi, 1)).join(' | '));
  ok(Z.every(z => z.atrW > 0 && z.atrW < 30),
     '带宽落在 (0, 30) ATR，不出现「半张图一条带」的退化',
     Z.map(z => fmt(z.atrW, 1)).join(' / '));
  ok(Z.every(z => isFinite(z.lo) && isFinite(z.hi) && isFinite(z.mid) && isFinite(z.v)
    && isFinite(z.mass) && isFinite(z.dpct) && isFinite(z.score)), '每段字段无 NaN');
  ok(Z.every(z => z.v >= 0 && z.v <= 1 && z.mass >= 0 && z.mass <= 1), '强度 / 质量归一到 [0,1]');
  ok(Z.every((z, i) => i === 0 || Z[i - 1].score >= z.score), '按 score 降序（强且近的排前面）');
  ok(Z.some(z => z.lo > px), '识别出上方带（空单止损区）');
  ok(Z.some(z => z.hi < px), '识别出下方带（多单止损区）');
  ok(Z.every(z => Math.abs(z.dpct) < 20), '带中心距现价百分比在合理量级', Z.map(z => fmt(z.dpct, 2)).join(' / '));

  // 空 / 坏输入不崩
  ok(liqZones(null, px, atrV).length === 0, 'heat 为空 → 返回空数组');
  ok(liqZones({ rows: [] }, px, atrV).length === 0, 'rows 为空 → 返回空数组');
  ok(liqZones({ rows: heat.rows, step: 0 }, px, atrV).length === 0, 'step=0 → 返回空数组');
  ok(liqZones(heat, px, 0).length >= 0, 'atr=0 时不崩（内部退化为 px*0.004）');

  /* --- 四个操作带 --- */
  S.heats = { BTC: { '1h': heat } }; S.quotes = {};
  const V = mmView('BTC', '1h', bars);
  ok(V.mode === 'sweep' && V.sweep, '扫单场景构造成功', V.mode);
  ok(Array.isArray(V.bands) && V.bands.length >= 3, '输出至少 3 个操作带', V.bands.length + ' 个');
  const kinds = V.bands.map(b => b.kind);
  ok(new Set(kinds).size === kinds.length, '操作带 kind 不重复', kinds.join(','));
  ok(kinds.includes('sweep') && kinds.includes('fail') && kinds.includes('entry'),
     '含先扫 / 失效 / 挂单三类带', kinds.join(','));
  ok(V.bands.every(b => isFinite(b.lo) && isFinite(b.hi) && isFinite(b.mid)
    && isFinite(b.v) && isFinite(b.atrW) && isFinite(b.dpct)), '操作带字段无 NaN');
  ok(V.bands.every(b => b.hi >= b.lo), '操作带 lo <= hi');
  // 关键回归：扫单带与失效带曾经是同一条带（「扫到即失效」与「扫到是剧本」语义打架）
  const sw = V.bands.find(b => b.kind === 'sweep'), fl = V.bands.find(b => b.kind === 'fail');
  ok(sw && fl && Math.abs(fl.mid - sw.mid) > 1e-9,
     '扫单模式下的失效带已外扩，不再与扫单带重合',
     sw && fl ? `sweep ${fmt(sw.lo, 1)}~${fmt(sw.hi, 1)} / fail ${fmt(fl.lo, 1)}~${fmt(fl.hi, 1)}` : '缺带');
  ok(sw && (sw.side === 'down' ? fl.hi <= sw.lo + 1e-9 : fl.lo >= sw.hi - 1e-9),
     '失效带贴在扫单带的远端外侧', sw && `${sw.side} / fail ${fmt(fl.lo, 1)}~${fmt(fl.hi, 1)}`);
  // dpct 必须带符号：曾经被 sweep.dpct（距离绝对值）覆盖，下方带却显示成 +0.98%
  ok(V.bands.every(b => Math.abs((b.mid / V.px - 1) * 100 - b.dpct) < 0.02),
     '每个操作带的 dpct 与 mid 相对现价的偏离一致（符号正确）',
     V.bands.map(b => b.kind + ':' + fmt(b.dpct, 2)).join(' '));
  const eb = V.bands.find(b => b.kind === 'entry');
  ok(eb && eb.atrW > 0.5 && eb.atrW < 1.2, '挂单带宽度约 0.75 ATR', eb && fmt(eb.atrW, 2));
  // 失效带不能与挂单带重叠：否则「回踩挂单」和「逻辑失效」成了同一件事
  ok(eb && fl && (fl.hi <= eb.lo + 1e-9 || fl.lo >= eb.hi - 1e-9),
     '失效带整体位于挂单区之外，不与挂单带重叠',
     eb && fl ? `entry ${fmt(eb.lo, 1)}~${fmt(eb.hi, 1)} / fail ${fmt(fl.lo, 1)}~${fmt(fl.hi, 1)}` : '缺带');
  const tb = V.bands.find(b => b.kind === 'target');
  ok(!tb || Math.abs(tb.mid - V.px) > 0, '目标带不与现价重合', tb && fmt(tb.dpct, 2));
  ok(eb && ((V.bias === 'long' && eb.hi <= V.px + 1e-9) || (V.bias === 'short' && eb.lo >= V.px - 1e-9)),
     '挂单带位于现价的顺方向一侧（做多挂下方 / 做空挂上方）',
     eb && `${fmt(eb.lo, 1)}~${fmt(eb.hi, 1)} @ ${V.bias}`);
  ok(V.zones.length > 0 && V.zUp.length + V.zDn.length > 0, '上下方带列表非空',
     `up ${V.zUp.length} / dn ${V.zDn.length}`);
  ok(V.zUp.every(z => z.lo > px) && V.zDn.every(z => z.hi < px), '上方带严格在现价之上、下方带严格在现价之下');
  ok(V.reasons.some(r => /清算带/.test(r)), '依据文案里写出清算带区间', V.reasons[0]);
  ok(!V.reasons.some(r => /NaN|undefined/.test(r)), '依据文案无 NaN / undefined');

  // 无清算数据 → 只有挂单带，不崩
  S.heats = {};
  const V0 = mmView('BTC', '1h', bars);
  ok(V0.zones.length === 0, '无清算数据时无价格带');
  ok(V0.bands.length <= 1 && V0.bands.every(b => b.kind === 'entry'), '无清算数据时只剩挂单带',
     V0.bands.map(b => b.kind).join(','));
  S.heats = {};
}

H('[8] KDJ 因子（第五个技术面维度）');
{
  const up = mkBars(120, { drift: 0.004, noise: 0.0012, seed: 11 });
  const dn = mkBars(120, { drift: -0.004, noise: 0.0012, seed: 13 });
  const flat = mkBars(120, { drift: 0, noise: 0.0008, seed: 17 });

  const fu = kdjFeat(up), fd = kdjFeat(dn), ff = kdjFeat(flat);

  ok(fu.s > 0.2, '强势上涨 → KDJ 偏多', fmt(fu.s, 3) + ' K=' + fmt(fu.k, 1));
  ok(fd.s < -0.2, '强势下跌 → KDJ 偏空', fmt(fd.s, 3) + ' K=' + fmt(fd.k, 1));
  ok(Math.abs(ff.s) < Math.abs(fu.s), '横盘的多空强度弱于单边上涨',
     'flat ' + fmt(ff.s, 3) + ' vs up ' + fmt(fu.s, 3));

  // 值域与位置关系：J = 3K - 2D，恒等式必须成立
  [fu, fd, ff].forEach((f, i) => {
    ok(Math.abs(f.j - (3 * f.k - 2 * f.d)) < 1e-6, `样本 ${i} 满足 J = 3K - 2D`,
       `J=${fmt(f.j, 4)} 3K-2D=${fmt(3 * f.k - 2 * f.d, 4)}`);
    ok(f.s >= -1 && f.s <= 1, `样本 ${i} 因子分落在 [-1,1]`, fmt(f.s, 3));
  });

  // 单边上涨末端必然钝化在超买区，这是 KDJ 的固有特性，不是 bug
  ok(fu.k > 50, '上涨样本 K 值位于中轴上方', fmt(fu.k, 1));
  ok(fd.k < 50, '下跌样本 K 值位于中轴下方', fmt(fd.k, 1));

  // 原始序列：K/D 必须在 [0,100] 内（RSV 归一决定），长度与输入一致
  const seq = kdj(up);
  ok(seq.K.length === up.length && seq.D.length === up.length && seq.J.length === up.length,
     'KDJ 序列长度与 K 线一致');
  ok(seq.K.every(v => v >= 0 && v <= 100), 'K 值恒在 [0,100]');
  ok(seq.D.every(v => v >= 0 && v <= 100), 'D 值恒在 [0,100]');

  // 交叉方向：K 上穿 D 记 +1，下穿记 -1，无交叉记 0
  ok([-1, 0, 1].includes(fu.cross) && [-1, 0, 1].includes(fd.cross), '交叉标记只取 -1/0/1');

  // 坏输入：空数组、1 根、全平 K 线（最高=最低，RSV 分母为 0）
  let crashed = null;
  try {
    kdjFeat([]); kdjFeat(mkBars(1));
    kdjFeat([{ t: 1, o: 10, h: 10, l: 10, c: 10, v: 1 }]);
    kdj([]);
  } catch (e) { crashed = e; }
  ok(!crashed, 'KDJ 对空 / 单根 / 一字 K 线不抛异常', crashed && crashed.message);

  const flatOne = kdjFeat([{ t: 1, o: 10, h: 10, l: 10, c: 10, v: 1 }]);
  ok(isFinite(flatOne.s) && isFinite(flatOne.k), '一字 K 线返回有限值',
     `s=${flatOne.s} k=${flatOne.k}`);

  // 融入融合层：KDJ 必须真的出现在因子列表里，且权重为 12
  S.heats = {}; S.quotes = {};
  const F = fuseSignal('BTC', '1h', up);
  const kdItem = F.contrib.find(x => x.k === 'kdj');
  ok(!!kdItem, 'KDJ 出现在融合因子列表中');
  ok(kdItem && kdItem.w === 12, 'KDJ 权重为 12', kdItem && String(kdItem.w));
  ok(F.kd && isFinite(F.kd.s), '融合结果带回 KDJ 明细');
  // 技术五因子权重合计 78，且 KDJ 的贡献不为 0（说明它真的参与了打分）
  const wsum = F.contrib.filter(x => x.k !== 'liq').reduce((a, x) => a + x.w, 0);
  ok(wsum === 78, '技术五因子权重合计 78', String(wsum));
  ok(kdItem && Math.abs(kdItem.c) > 0, 'KDJ 对技术面基准有非零贡献', kdItem && fmt(kdItem.c, 2));
  S.heats = {};
}

H('[9] 全局健壮性');
{
  const bad = [mkBars(1), mkBars(2), mkBars(5), mkBars(20)];
  let crashed = null;
  try {
    bad.forEach(b => {
      const px = b[b.length - 1].c;
      S.heats = { BTC: { '1h': mkHeat(px) } };
      fuseSignal('BTC', '1h', b);
      mmView('BTC', '1h', b);
      structFeat(b); obvFeat(b); bollFeat(b); macdFeat(b);
    });
  } catch (e) { crashed = e; }
  ok(!crashed, '短 K 线全流程不抛异常', crashed && crashed.message);
  S.heats = {};
}

H('[10] 因子同源折减：多个指标一致 ≠ 多份独立证据');
{
  /* 直接喂表态因子给 fuseIndep，验证「组内第 2、3、4 个因子几乎不再增加信息」。 */
  const mk = ks => ks.map(k => ({ k, s: 0.5 }));
  const e1 = fuseIndep(mk(['st']));
  const e2 = fuseIndep(mk(['st', 'macd']));
  const e3 = fuseIndep(mk(['st', 'macd', 'boll']));
  const e4 = fuseIndep(mk(['st', 'macd', 'boll', 'kdj']));
  ok(Math.abs(e1 - 1) < 1e-9, '1 个价格因子 = 1.00 份独立证据', fmt(e1, 3));
  ok(e2 > 1.25 && e2 < 1.35, '2 个价格同源因子 ≈ 1.30 份（不是 2 份）', fmt(e2, 3));
  ok(e3 > e2 && e3 < 1.45, '3 个 ≈ 1.39 份', fmt(e3, 3));
  ok(e4 > e3 && e4 < 1.50, '4 个 ≈ 1.42 份（第四个几乎不增加信息）', fmt(e4, 3));
  ok(Math.abs(fuseIndep(mk(['st', 'obv'])) - 2) < 1e-9, '价格 + 量能 = 2 份（不同源，可叠加）',
    fmt(fuseIndep(mk(['st', 'obv'])), 3));
  ok(Math.abs(fuseIndep(mk(['st', 'macd', 'boll', 'kdj', 'obv', 'liq'])) - (e4 + 2)) < 1e-9,
    '价格四因子 + OBV + 清算 ≈ 3.42 份（六因子 ≠ 六份证据）');
  ok(FUSE_GROUP.st === 'px' && FUSE_GROUP.macd === 'px' && FUSE_GROUP.boll === 'px' && FUSE_GROUP.kdj === 'px',
    '结构 / MACD / BOLL / KDJ 同属 px 同源组');
  ok(FUSE_GROUP.obv === 'vol' && FUSE_GROUP.liq === 'flow', 'OBV（成交量）与清算（热力图）各属独立来源');
  ok(FUSE_RHO.px >= 0.6, 'px 组相关系数取高值（同源程度高）', String(FUSE_RHO.px));

  /* 同源多数票压不过不同源反对票：4 个价格因子同向 + 量能反向，
   * 原始一致度 4/5 = 80%，独立口径 1.42/(1.42+1) ≈ 59%。 */
  const nAll = fuseIndep(mk(['st', 'macd', 'boll', 'kdj', 'obv']));
  const nAgree = fuseIndep(mk(['st', 'macd', 'boll', 'kdj']));
  const confInd = nAgree / nAll;
  ok(confInd > 0.55 && confInd < 0.62, '独立口径一致度 ≈ 59%，明显低于原始 80%', fmt(confInd, 3));
  ok(nAll / 5 < 0.5, '5 个表态因子折算后不足 2.5 份独立证据', fmt(nAll, 3));
  ok(FUSE_MIN_INDEP > e2, '证据门槛高于「2 个价格同源因子」的 1.30 份 —— 只靠 MACD+KDJ 不给方向',
    FUSE_MIN_INDEP + ' > ' + fmt(e2, 3));

  /* 只有价格同源四因子同向（无量能 / 流动性佐证）时拿不到满额加成。 */
  const depth = clamp(nAgree / FUSE_INDEP_FULL, 0, 1);
  ok(depth > 0.6 && depth < 0.7, '独立证据深度 ≈ 0.64 → 加成打折', fmt(depth, 3));
  ok(0.6 + 0.4 * 1 * depth < 0.9, '同源四因子全同向的加成系数 < 0.9（堆同源指标涨不上去）',
    fmt(0.6 + 0.4 * depth, 3));

  /* 清算修正：幅度上限 32%，且永远改不了技术面基准的符号。 */
  const upB = mkBars(200, { drift: 0.003, volTrend: 0.5, seed: 77 });
  const upx = upB[upB.length - 1].c;
  S.heats = { BTC: { '1h': mkHeat(upx, { upBias: 0.02, dnBias: 6 }) } };
  const Fu = fuseSignal('BTC', '1h', upB);
  ok(Math.abs(Fu.liqAdj) <= 0.32 + 1e-9, '清算修正幅度不超过 ±32%', fmt(Fu.liqAdj, 3));
  ok((Fu.base > 0) === (Fu.raw > 0), '清算修正翻不了技术面基准的符号（多头仍为正）',
    fmt(Fu.base, 1) + ' → ' + fmt(Fu.raw, 1));
  ok(Fu.nEff > 0 && Fu.nEff <= Fu.nEffAll + 1e-9, '同向独立证据数不超过表态证据总数',
    fmt(Fu.nEff, 3) + ' ≤ ' + fmt(Fu.nEffAll, 3));
  ok(Fu.confInd <= Fu.conf + 1e-9, '独立口径一致度不高于原始口径（同源折减只会降低）',
    fmt(Fu.confInd, 3) + ' ≤ ' + fmt(Fu.conf, 3));
  ok(Fu.confMult >= 0.6 && Fu.confMult <= 1, '一致性加成系数在 0.6~1.0', fmt(Fu.confMult, 3));
  ok(Math.abs(Fu.score - clamp(Fu.raw * Fu.confMult, -100, 100)) < 1e-6, '合成分 = 原始分 × 加成系数',
    fmt(Fu.score, 2));
  S.heats = {};

  /* 源码守卫：这几处一旦被改回「按因子个数投票」，同源折减就失效了。 */
  ok(/const FUSE_GROUP\s*=/.test(src), '存在同源分组常量 FUSE_GROUP');
  ok(/nEffAll < FUSE_MIN_INDEP/.test(src), '证据门槛按独立口径判定（不是按因子个数）');
  ok(/0\.6 \+ 0\.4 \* confInd \* indepDepth/.test(src), '加成系数按独立口径 × 证据深度给');
  ok(/fuseIndep\(act\)/.test(src), '表态因子先折算成有效独立证据数');
}

// ============================================================
// [11] 扫单「倾向」不得显示成概率（固定公式无样本校准）
// ============================================================
{
  const { sweepTendency, sweepLabel, SWEEP_CALIB, SWEEP_TENDENCY_NOTE } = X;
  console.log('\n[11] 扫单倾向：未校准只给档位');
  ok(typeof sweepLabel === 'function', 'sweepLabel 是唯一的对外展示入口');
  ok(SWEEP_CALIB && SWEEP_CALIB.calibrated === false, '默认处于未校准状态', JSON.stringify(SWEEP_CALIB));
  ok(SWEEP_CALIB.minSample >= 100, '设置了样本量门槛', SWEEP_CALIB.minSample);

  const lv = [0.80, 0.62, 0.50, 0.45, 0.20].map(p => sweepLabel(p));
  ok(lv[0].level === 'high' && lv[0].txt === '高', '高分 → 档位「高」', lv[0].txt);
  ok(lv[1].level === 'high', '阈值 0.62 归入高档', lv[1].txt);
  ok(lv[2].level === 'mid' && lv[2].txt === '中', '中分 → 档位「中」', lv[2].txt);
  ok(lv[4].level === 'low' && lv[4].txt === '低', '低分 → 档位「低」', lv[4].txt);
  ok(lv.every(t => !/%/.test(t.txt)), '未校准时任何档位都不显示百分比', lv.map(t => t.txt).join('/'));
  ok(lv.every(t => t.calib === false), '未校准时 calib 标记为 false');
  ok([0, 0.3, 0.62, 1, null, undefined].every(p => !/%/.test(sweepLabel(p).txt)),
    '边界值（0 / 1 / null）也不会输出百分比');

  // 校准后的行为：凑够样本 + 有实测频率表，才允许给概率
  const bak = JSON.parse(JSON.stringify(SWEEP_CALIB));
  SWEEP_CALIB.calibrated = true; SWEEP_CALIB.sample = 50; SWEEP_CALIB.byLevel = { high: 0.71, mid: 0.5, low: 0.2 };
  ok(sweepLabel(0.8).txt === '高' && sweepLabel(0.8).calib === false, '样本量不足 → 仍然只给档位', sweepLabel(0.8).txt);
  SWEEP_CALIB.sample = 300;
  ok(sweepLabel(0.8).txt === '71%' && sweepLabel(0.8).calib === true, '样本足够且已校准 → 才给实测频率', sweepLabel(0.8).txt);
  ok(sweepLabel(0.2).txt === '20%', '低档也走实测频率表', sweepLabel(0.2).txt);
  SWEEP_CALIB.calibrated = bak.calibrated; SWEEP_CALIB.sample = bak.sample; SWEEP_CALIB.byLevel = bak.byLevel;
  ok(sweepLabel(0.8).txt === '高', '还原校准状态后回到档位显示');

  ok(/不是概率|未经历史样本校准/.test(SWEEP_TENDENCY_NOTE), '说明文案明确「不是概率」');

  // 源码守卫：不许再把扫单分值叫 prob / 渲染成百分比
  ok(!/\.sweep\.prob\b/.test(src), '源码不再引用 sweep.prob（字段已改名 score）');
  ok(!/扫单概率/.test(src), '源码不再出现「扫单概率」字样');
  ok(!/const prob\s*=/.test(src), '扫单计算段不再用 prob 命名变量');
  ok(/const score = clamp\(0\.32/.test(src), '扫单分值变量命名为 score（钳位只用于排序）');
  ok(/sweepLabel\(/.test(src), '渲染层统一走 sweepLabel 出口');
}

console.log('\n==============================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
