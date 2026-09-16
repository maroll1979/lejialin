/* ===================== 四周期融合决策（唯一总决策） =====================
 * 之前四个周期各算各的：顶部「做市商结论」跟随当前选中的周期，模拟盘则用设置里的
 * 单个周期（默认 1h）。于是会出现「15 分钟做多、4 小时做空，模拟盘却照着 1 小时开多」
 * 这种自相矛盾的结果 —— 四周期只被展示，没有被融合。
 *
 * 这里把四层做成一条必须逐层通过的流水线，任何一层不过就没有总决策：
 *   4h  趋势层 —— 定方向：只允许顺 4h 趋势做；4h 无方向则整体观望
 *   1h  机会层 —— 定位置：1h 必须与 4h 同向且合成分够强，不同向就是噪音不是机会
 *   30m 回调层 —— 定时机：追在 30m 极值上不算回调，等回撤进结构内再谈进场
 *   15m 触发层 —— 定发令：15m 同向才扣扳机；15m 处于扫单模式则等扫单收回
 *
 * 输出只有一份：mtfDecision().bias。页面顶部结论与模拟盘开仓都只认它，
 * 不再各自读一个周期的结论。
 *
 * 关于「一致度」：它是参与评分的因子里同方向因子的占比，不是胜率。
 * 关于扫单评分：下面的固定公式没有历史样本校准，因此界面只展示成
 * 「扫单倾向 高 / 中 / 低」，不再显示百分比 —— 见 sweepTendency()。
 * 四层一致度同样不是胜率：4h / 1h / 30m / 15m 是同一份成交数据的不同聚合，
 * 四层同向说明「这段行情在各尺度上方向一致」，不构成四份独立验证 —— 见 MTF_CONF_NOTE。
 */

/* 四层一致度的口径说明：权重按层给（趋势层最高），但四层读的是同一标的不同聚合周期的
 * K 线 —— 4h 里就含着 1h、30m、15m 的成交，所以四层同向只是「各尺度方向一致」，
 * 不是四份相互独立的证据，更不是胜率。 */
const MTF_CONF_NOTE = '四层一致度 = 通过层的加权一致性，衡量 4h / 1h / 30m / 15m 四层是否同向；'
  + '它不是胜率，也不代表未来盈利概率 —— 四层是同一份成交数据的不同聚合，同源，'
  + '四层同向不等于四份独立验证。';

/* ===== MTF-PIPE-START =====
 * 纯计算段：不碰 DOM、不碰网络，输入是各周期已算好的 view，单测直接吃这一段。 */
const MTF_TFS = ['4h', '1h', '30m', '15m'];
const MTF_TREND_TF = '4h';         // 趋势层
const MTF_SETUP_TF = '1h';         // 机会层
const MTF_PULL_TF = '30m';         // 回调层
const MTF_TRIG_TF = '15m';         // 触发层
const MTF_MIN_BARS = 40;
const MTF_SETUP_MIN_SCORE = 20;    // 机会层：1h 合成分门槛（低于此视为噪音）
const MTF_PB_SHALLOW = 0.12;       // 回撤浅于此 = 追高 / 追低，等回调
const MTF_PB_DEEP = 0.82;          // 回撤深于此 = 已到结构另一端，需 15m 强确认

const MTF_LABEL = { '15m': '15 分钟', '30m': '30 分钟', '1h': '1 小时', '4h': '4 小时' };

/* 扫单倾向分级见 07-fusion.js 的 sweepTendency() —— 放在那里是因为概率值由 mmView 产出，
 * 而多因子段的单元测试只抽取到融合段为止，依赖必须就地可得。 */

/* 回调层：判断当前是「回撤到位」还是「追在极值上」。
 * 以最近 look 根的摆动区间为标尺：做多看从高点回落多少，做空看从低点反弹多少。
 * 回撤 < 12% → 贴着极值，进场就是追；回撤 > 82% → 已经跌/涨到区间另一端，
 * 那不是回调而是转势，必须让 15m 给出更强的确认。 */
function mtfPullback(bars, bias, look) {
  const n = bars.length;
  const k = Math.min(look || 48, n);
  const seg = bars.slice(n - k);
  let hi = -Infinity, lo = Infinity;
  for (const b of seg) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  const px = bars[n - 1].c;
  const span = hi - lo;
  if (!(span > 0)) return { state: 'ok', retrace: 0, hi, lo, px, span: 0, bars: k };
  const raw = bias === 'long' ? (hi - px) / span : (px - lo) / span;
  const retrace = clamp(raw, 0, 1);
  const state = retrace < MTF_PB_SHALLOW ? 'extension' : retrace > MTF_PB_DEEP ? 'deep' : 'ok';
  return { state, retrace, hi, lo, px, span, bars: k };
}

/* 流水线本体。V 的形状：
 *   { '4h': {bias,mode,score,conf,px,atr,ok}, '1h': {...}, '30m': {...}, '15m': {...} }
 * 每一层都只接收上一层的结论，任何一层否决就立即返回，不再往下走。 */
function mtfPipeline(V, opt) {
  const o = opt || {};
  const minScore = o.minScore == null ? MTF_SETUP_MIN_SCORE : o.minScore;
  const V4 = V[MTF_TREND_TF], V1 = V[MTF_SETUP_TF], V30 = V[MTF_PULL_TF], V15 = V[MTF_TRIG_TF];
  const L = MTF_LABEL;
  const missing = [];
  const layers = {};
  const reasons = [];

  const done = (ok, bias, stage, extra) => Object.assign({
    ok, bias, stage, trendDir: layers.trend ? layers.trend.bias : null,
    mode: (V15 && V15.mode) || (V1 && V1.mode) || 'stand',
    conf: ok ? mtfConf(layers) : 0,
    missing, degraded: missing.length > 0, layers, reasons,
  }, extra || {});

  /* ---- 第 1 层：4h 定趋势 ---- */
  if (!V4) {
    missing.push(MTF_TREND_TF);
    reasons.push(`缺少 ${L[MTF_TREND_TF]} 数据，无法定趋势 —— 不给结论`);
    return done(false, 'wait', 'none');
  }
  if (V4.bias !== 'long' && V4.bias !== 'short') {
    layers.trend = { tf: MTF_TREND_TF, bias: 'wait', pass: false, view: V4 };
    reasons.push(`${L[MTF_TREND_TF]}趋势层为观望（合成分 ${Math.round(V4.score || 0)}）—— 趋势未确立，整体不做`);
    return done(false, 'wait', 'none');
  }
  layers.trend = {
    tf: MTF_TREND_TF, bias: V4.bias, pass: true, mode: V4.mode,
    score: V4.score, conf: V4.conf, px: V4.px,
  };
  const dir = V4.bias;
  const dirTxt = dir === 'long' ? '做多' : '做空';
  reasons.push(`${L[MTF_TREND_TF]}趋势层判定方向：${dirTxt}（${V4.mode === 'sweep' ? '处于扫单结构，取扫完后要去的方向' : V4.mode === 'follow' ? '顺势' : '因子分歧'}，合成分 ${Math.round(V4.score || 0)}）`);

  /* ---- 第 2 层：1h 筛选机会 ---- */
  if (!V1) {
    missing.push(MTF_SETUP_TF);
    reasons.push(`缺少 ${L[MTF_SETUP_TF]} 数据，无法筛选机会 —— 不给结论`);
    return done(false, 'wait', 'none');
  }
  if (V1.bias !== dir) {
    layers.setup = { tf: MTF_SETUP_TF, bias: V1.bias, pass: false, score: V1.score, view: V1 };
    reasons.push(`${L[MTF_SETUP_TF]}机会层方向为${V1.bias === 'long' ? '做多' : V1.bias === 'short' ? '做空' : '观望'}，`
      + `与 ${L[MTF_TREND_TF]}趋势（${dirTxt}）${V1.bias === 'wait' ? '不一致（无明确方向）' : '相反'} —— 不是机会，本档不做`);
    return done(false, 'wait', 'trend');
  }
  if (Math.abs(V1.score || 0) < minScore) {
    layers.setup = { tf: MTF_SETUP_TF, bias: V1.bias, pass: false, score: V1.score, view: V1 };
    reasons.push(`${L[MTF_SETUP_TF]}机会层合成分 ${Math.round(V1.score || 0)}，低于门槛 ${minScore} —— 方向对但力度不够`);
    return done(false, 'wait', 'trend');
  }
  layers.setup = { tf: MTF_SETUP_TF, bias: V1.bias, pass: true, mode: V1.mode, score: V1.score, conf: V1.conf, px: V1.px };
  reasons.push(`${L[MTF_SETUP_TF]}机会层确认：方向一致，合成分 ${Math.round(V1.score || 0)}（${V1.mode === 'sweep' ? '扫单结构' : V1.mode === 'follow' ? '顺势' : '观望'}）`);

  /* ---- 第 3 层：30m 观察回调 ---- */
  if (!V30) {
    missing.push(MTF_PULL_TF);
    reasons.push(`缺少 ${L[MTF_PULL_TF]} 数据，回调层降级为通过（结论可信度下降）`);
    layers.pullback = { tf: MTF_PULL_TF, pass: true, state: 'n/a', degraded: true };
  } else {
    const pb = V30.pull || mtfPullback(V30.bars, dir);
    layers.pullback = { tf: MTF_PULL_TF, pass: pb.state !== 'extension', state: pb.state, retrace: pb.retrace, hi: pb.hi, lo: pb.lo, px: pb.px };
    const pct = Math.round((pb.retrace || 0) * 100);
    if (pb.state === 'extension') {
      reasons.push(`${L[MTF_PULL_TF]}回调层：${dir === 'long' ? '价格仍贴着区间高点' : '价格仍贴着区间低点'}（回撤仅 ${pct}%）—— 这是追价不是回调，等回撤进结构再进`);
      return done(false, 'wait', 'setup');
    }
    if (pb.state === 'deep') {
      reasons.push(`${L[MTF_PULL_TF]}回调层：回撤已达 ${pct}%，接近区间${dir === 'long' ? '下' : '上'}沿 —— 更像是转势而非回调，需要 ${L[MTF_TRIG_TF]}给出强确认`);
    } else {
      reasons.push(`${L[MTF_PULL_TF]}回调层：回撤 ${pct}%，处于结构内的合理回调区`);
    }
  }

  /* ---- 第 4 层：15m 触发进场 ---- */
  if (!V15) {
    missing.push(MTF_TRIG_TF);
    reasons.push(`缺少 ${L[MTF_TRIG_TF]} 数据，无法确认触发 —— 本档不发令`);
    return done(false, 'wait', 'pullback');
  }
  const deep = layers.pullback && layers.pullback.state === 'deep';
  const needStrong = deep || (V15.bias === dir && Math.abs(V15.score || 0) >= minScore);
  if (V15.bias !== dir) {
    layers.trigger = { tf: MTF_TRIG_TF, bias: V15.bias, pass: false, score: V15.score, view: V15 };
    reasons.push(`${L[MTF_TRIG_TF]}触发层方向为${V15.bias === 'long' ? '做多' : V15.bias === 'short' ? '做空' : '观望'}，`
      + `与总方向（${dirTxt}）不一致 —— 不发令`);
    return done(false, 'wait', 'pullback');
  }
  if (deep && Math.abs(V15.score || 0) < minScore * 1.5) {
    layers.trigger = { tf: MTF_TRIG_TF, bias: V15.bias, pass: false, score: V15.score, view: V15 };
    reasons.push(`${L[MTF_TRIG_TF]}触发层力度 ${Math.round(V15.score || 0)} 不足以确认深回调（需 ≥ ${Math.round(minScore * 1.5)}）—— 不发令`);
    return done(false, 'wait', 'pullback');
  }
  layers.trigger = { tf: MTF_TRIG_TF, bias: V15.bias, pass: true, mode: V15.mode, score: V15.score, conf: V15.conf, px: V15.px };
  reasons.push(`${L[MTF_TRIG_TF]}触发层发令：方向一致，合成分 ${Math.round(V15.score || 0)}，`
    + (V15.mode === 'sweep' ? '但处于扫单结构，需价格进入扫单带收回后才进场' : '可直接进场'));

  return done(true, dir, 'trigger', {
    need: V15.mode === 'sweep' ? 'sweep' : null,
    sweep: (V15.mm && V15.mm.sweep) ? {
      lo: Math.min(V15.mm.sweep.lo, V15.mm.sweep.hi),
      hi: Math.max(V15.mm.sweep.lo, V15.mm.sweep.hi),
      p: V15.mm.sweep.p, dp: V15.dp, score: V15.mm.sweep.score,
    } : null,
    strong: !!needStrong,
  });
}

/* 总可信度：四层里通过的层各占一份权重，趋势层权重最高。
 * 它是「四层一致性」的度量，不是胜率 —— 界面上必须这么标注。 */
function mtfConf(layers) {
  const w = [['trend', 0.4], ['setup', 0.3], ['pullback', 0.1], ['trigger', 0.2]];
  let s = 0, sum = 0;
  for (const [k, wt] of w) {
    const l = layers[k];
    if (!l) continue;
    sum += wt;
    if (l.pass) s += wt * (0.55 + 0.45 * clamp((l.conf != null ? l.conf : 60) / 100, 0, 1));
  }
  return sum > 0 ? Math.round(clamp(s / sum, 0, 1) * 100) : 0;
}
/* ===== MTF-PIPE-END ===== */

/* 取某一周期已算好的结论视图。数据不足返回 null（调用方据此判断缺失）。 */
function mtfViewOf(sym, tf) {
  const d = (S.klines[sym] || {})[tf];
  if (!d || !d.bars || d.bars.length < MTF_MIN_BARS) return null;
  const T = mmTradeOf(sym, tf, d.bars);
  return {
    tf, bars: d.bars, ok: true,
    bias: T.bias, mode: T.mode, score: T.score, conf: T.conf,
    atr: T.atr, px: T.px, dp: T.dp, sl: T.sl, tp1: T.tp1, tp2: T.tp2,
    mm: T.mm, T,
  };
}

/* 唯一的总决策入口。页面顶部结论与模拟盘开仓都调它。
 * 四个周期各算一次 mmTrade 不便宜，按「各周期最后一根 K 线」做键缓存 5 秒，
 * 避免 renderMtf / renderMM / 模拟盘在同一次刷新里重复算四遍。 */
let _mtfCache = { key: '', at: 0, val: null };
function mtfDecision(sym) {
  const ds = MTF_TFS.map(tf => (S.klines[sym] || {})[tf]);
  const key = sym + '|' + ds.map(d => (d && d.bars && d.bars.length)
    ? d.bars.length + ':' + d.bars[d.bars.length - 1].t : 'x').join(',');
  const t = now();
  if (_mtfCache.key === key && t - _mtfCache.at < 5000) return _mtfCache.val;
  const V = {};
  for (const tf of MTF_TFS) {
    const v = mtfViewOf(sym, tf);
    if (v) V[tf] = v;
  }
  const val = mtfPipeline(V);
  _mtfCache.key = key; _mtfCache.at = t; _mtfCache.val = val;
  return val;
}

/* 总决策 + 可执行价位。价位取自「执行周期」（默认 1h）：
 * 15m 的 ATR 太窄、4h 太宽，1h 的结构风险距离最适合当止损基准。
 * 关键：方向强制为总决策的方向 —— 执行周期自己若是反的，价位必须按总方向重算，
 * 否则就会出现「总决策做空、价位却是做多结构」的错位。 */
function mtfPlan(sym, execTf) {
  const dec = mtfDecision(sym);
  const tf = execTf || MTF_SETUP_TF;
  const d = (S.klines[sym] || {})[tf];
  let plan = null;
  if (d && d.bars && d.bars.length >= MTF_MIN_BARS) {
    /* 总决策观望时也必须强制观望。否则价位会沿用本周期自己的方向，
     * 又变成「顶部写观望、下面却给出一整套做多价位」的错位。 */
    plan = mmTrade(sym, tf, d.bars, null,
      (dec.bias === 'long' || dec.bias === 'short') ? dec.bias : 'wait');
    /* 两个「一致度」不是一个东西，必须分开存，不能互相覆盖：
     *   plan.conf    = 本周期五因子的因子一致度（mmTrade 已算好，保留原值）
     *   plan.mtfConf = 四周期流水线的四层一致度（未通过时为 0 —— 那不是「0% 把握」，
     *                   而是「四层没走完，谈不上一致」，界面要显示成「—」而不是 0%）
     * 之前把 plan.conf 直接改成 dec.conf，结果观望时结论区出现「因子一致度 0%、
     * 独立口径 71%」这种自相矛盾的显示。 */
    plan.mtfConf = dec.conf;
    plan.mtf = { stage: dec.stage, ok: dec.ok, need: dec.need, sweep: dec.sweep, conf: dec.conf };
  }
  return { dec, plan, tf, px: d && d.bars && d.bars.length ? d.bars[d.bars.length - 1].c : null };
}

/* 端到端测试访问（app.js 在严格模式下求值，内部函数不会自动挂到 window） */
if (typeof window !== 'undefined') {
  window.mtfPipeline = mtfPipeline;
  window.mtfPullback = mtfPullback;
  window.mtfDecision = mtfDecision;
  window.mtfPlan = mtfPlan;
  window.mtfViewOf = mtfViewOf;
  window.sweepTendency = sweepTendency;
}

/* 一句话概括流水线状态，用于界面与单据标注。 */
function mtfStageTxt(dec) {
  if (!dec) return '—';
  const map = {
    none: '未通过趋势层', trend: '趋势通过 · 机会未过',
    setup: '机会通过 · 等回调', pullback: '回调到位 · 等触发', trigger: '四层全通过',
  };
  return map[dec.stage] || '—';
}
