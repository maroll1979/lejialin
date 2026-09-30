/* ============================================================================
 * volprofile.js — 从 K 线重建流动性结构（历史回放用的代理）
 * ============================================================================
 *
 * 【为什么必须有一个代理】
 *   方案 A 要做「信号 × 流动性结构」的历史回放，但历史订单簿根本拿不到：
 *     · Gate 的 order_book 只有「当下」一份快照，没有历史版本；
 *     · liq_orders 只能回溯 1 小时（超了直接 INVALID_PARAM_VALUE）；
 *     · 币安/OKX/Bybit 的合约接口在本机不可达。
 *   所以历史任何时点的真实挂单结构都是不可观测的。要回放，只能用能回溯的
 *   代理变量 —— 这里用 **Volume Profile（成交量分布）**。
 *
 * 【代理是怎么算的】
 *   把窗口内每根 K 线的成交量，按 [low, high] 均匀摊到价格格上，得到
 *   「过去 N 小时里，每个价位一共成交了多少」。注意这是**成交**不是**挂单**。
 *
 * 【★ 语义差别（别把它当成订单簿）】
 *     订单簿薄带 = 这个价位 **没人挂单**  → 未来穿过去的阻力小
 *     VP   薄带 = 这个价位 **没成交过**  → 历史上价格不愿意在这儿停留
 *   两者都指向「阻力小」，但不等价。差别有多大由 liq-proxy-check.js 量化；
 *   如果吻合度太差，本模块的结论只能算「成交量分布」而非「挂单结构」。
 *
 * 【算法继承 band-proto.js v2，三个坑都已经踩过】
 *   1) 薄带必须**分侧**找（上下在价格上互斥，合成会选到无意义的集合）
 *   2) 稀疏度基线用**非零格的中位数**，不能用均值（少量巨墙会抬高均值，
 *      把均匀的普通挂单误判成稀薄）
 *   3) 窗口太窄 = 在挑噪声（12% 视野是实测下来的折中）
 * ========================================================================== */
'use strict';

/* ---------------------------------------------------------------- 构建 */
/**
 * 把 [from, to) 区间的 K 线摊成 BINS 格成交量分布。
 * @param s     Series {t,o,h,l,c,v,n}
 * @param range 可选 {lo,hi} 固定视野（不给则自动取窗口内 min low / max high）
 * @returns {lo,hi,step,bins,vol,nbars} 或 null（区间退化 / 空）
 */
function buildProfile(s, from, to, BINS, range) {
  from = Math.max(0, from | 0); to = Math.min(s.n, to | 0);
  if (to - from < 1) return null;
  let lo = Infinity, hi = -Infinity;
  if (range && range.hi > range.lo) {
    /* 固定视野：用于和另一个结构（如真实订单簿）投影到同一区间做对比。
       注意此时成交量不再守恒 —— 落在视野外的部分被丢弃，
       这正是我们要的：只比较这一价位区间内的相对分布。 */
    lo = range.lo; hi = range.hi;
  } else {
    for (let i = from; i < to; i++) {
      if (s.l[i] < lo) lo = s.l[i];
      if (s.h[i] > hi) hi = s.h[i];
    }
  }
  if (!(hi > lo)) return null;
  /* 视野稍微放宽，避免最高/最低价正好卡在边界导致最后一格溢出 */
  const pad = (hi - lo) * 1e-9;
  lo -= pad; hi += pad;
  const step = (hi - lo) / BINS;
  const vol = new Float64Array(BINS);
  for (let i = from; i < to; i++) {
    const l = s.l[i], h = s.h[i], v = s.v[i];
    if (!(v > 0) || !(h >= l)) continue;
    let i0 = Math.floor((l - lo) / step), i1 = Math.floor((h - lo) / step);
    if (i0 < 0) i0 = 0;
    if (i1 > BINS - 1) i1 = BINS - 1;
    if (i1 < i0) i1 = i0;
    /* 均匀摊分：一根 K 线覆盖 k 格就每格得 v/k。
       比「全给收盘价」更能反映区间内的真实成交分布。 */
    const per = v / (i1 - i0 + 1);
    for (let k = i0; k <= i1; k++) vol[k] += per;
  }
  return { lo: lo, hi: hi, step: step, bins: BINS, vol: vol, nbars: to - from };
}

/* ---------------------------------------------------------------- 结构 */
/** POC：成交最密集的那一格 */
function pocOf(arr) {
  let i = 0;
  for (let k = 1; k < arr.length; k++) if (arr[k] > arr[i]) i = k;
  return i;
}

/** 价值区：从 POC 向两侧贪心扩张到 target 占比（Market Profile 标准做法） */
function valueArea(arr, target) {
  const tot = arr.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return null;
  let poc = pocOf(arr), lo = poc, hi = poc, acc = arr[poc];
  while (lo > 0 || hi < arr.length - 1) {
    const dv = lo > 0 ? arr[lo - 1] : -1;
    const uv = hi < arr.length - 1 ? arr[hi + 1] : -1;
    if (dv < 0 && uv < 0) break;
    if (dv >= uv) { lo--; acc += arr[lo]; } else { hi++; acc += arr[hi]; }
    if (acc / tot >= target) break;
  }
  return { lo: lo, hi: hi, poc: poc, acc: acc, share: acc / tot };
}

/**
 * 最薄带：在 [from, to] 上滑宽度为 win 的窗口，找总成交最小的那一段。
 * 稀疏度 sparsity = 窗口均值 / **非零格中位数**（越小越真薄）。
 */
function thinBand(arr, from, to, win) {
  const a = Math.max(0, from | 0), b = Math.min(arr.length - 1, to | 0);
  if (b - a + 1 < win) return null;
  const nz = [];
  for (let i = a; i <= b; i++) if (arr[i] > 0) nz.push(arr[i]);
  nz.sort((x, y) => x - y);
  let baseline = 0;
  if (nz.length) {
    const m = nz.length >> 1;
    baseline = (nz.length % 2) ? nz[m] : (nz[m - 1] + nz[m]) / 2;
  }
  let pre = 0;
  for (let i = a; i < a + win; i++) pre += arr[i];
  let best = { lo: a, hi: a + win - 1, sum: pre };
  for (let i = a + 1; i + win - 1 <= b; i++) {
    pre += arr[i + win - 1] - arr[i - 1];
    if (pre < best.sum) best = { lo: i, hi: i + win - 1, sum: pre };
  }
  best.avg = best.sum / win;
  best.sparsity = baseline > 0 ? best.avg / baseline : 1;
  best.baseline = baseline;
  return best;
}

/* ---------------------------------------------------------------- 特征 */
/** 格索引 → 该格中心价 */
const binPx = (prof, i) => prof.lo + (i + 0.5) * prof.step;

/**
 * 在给定现价下抽取结构特征。
 * @param prof  buildProfile 的产物
 * @param price 现价（用入场价，不要用信号那根的收盘）
 * @param opt   {winPct=0.12, vaShare=0.70, anchor='price'|'poc'}
 *
 * anchor 的区别：
 *   'price' —— 从**现价**往上/往下找薄带（决策视角：我站在这儿，哪边好走）
 *   'poc'   —— 从 **POC** 往上/往下找（Market Profile 原义）
 * 默认 'price'，因为回放关心的是入场点之后的路径。
 */
function structureAt(prof, price, opt) {
  if (!prof) return null;
  opt = opt || {};
  const winPct = opt.winPct || 0.12;
  const vaShare = opt.vaShare || 0.70;
  const anchor = opt.anchor || 'price';
  const vol = prof.vol, bins = prof.bins, step = prof.step, lo = prof.lo;

  const poc = pocOf(vol);
  const pocPx = binPx(prof, poc);
  const va = valueArea(vol, vaShare);
  if (!va) return null;

  const row = Math.max(0, Math.min(bins - 1, Math.floor((price - lo) / step)));
  const winW = Math.max(2, Math.round(bins * winPct));
  const aRow = anchor === 'poc' ? poc : row;
  const up = thinBand(vol, Math.min(bins - 1, aRow + 1), bins - 1, winW);
  const dn = thinBand(vol, 0, Math.max(0, aRow - 1), winW);

  const vaLo = lo + va.lo * step, vaHi = lo + (va.hi + 1) * step;
  const span = vaHi - vaLo;
  return {
    /* 绝对价位 */
    pocPx: pocPx,
    vaLo: vaLo,
    vaHi: vaHi,
    vaWidth: span / price,
    upLo: up ? lo + up.lo * step : null,
    upHi: up ? lo + (up.hi + 1) * step : null,
    dnLo: dn ? lo + dn.lo * step : null,
    dnHi: dn ? lo + (dn.hi + 1) * step : null,
    /* 相对量（跨品种/跨价位可比） */
    dPoc: (price - pocPx) / price,                       // >0 现价在 POC 上方
    posVA: span > 0 ? (price - vaLo) / span : 0,         // 0=VA下沿 1=VA上沿
    /* 现价在整个窗口视野中的位置 0=窗口最低 1=窗口最高。
       ★ 为什么单独要它：现价贴在窗口顶部时，「上方」根本不足一个薄带窗口，
         薄带特征会返回 null —— 但「贴顶」本身就是最有信息量的事实（追高），
         不能因为算不出薄带就丢掉这批样本。 */
    posSpan: (price - prof.lo) / (prof.hi - prof.lo),
    upDist: up ? (binPx(prof, (up.lo + up.hi) / 2) - price) / price : null,
    dnDist: dn ? (price - binPx(prof, (dn.lo + dn.hi) / 2)) / price : null,
    upSp: up ? up.sparsity : null,                      // 上方稀疏度（越小越薄）
    dnSp: dn ? dn.sparsity : null,
    /* 方向化合成：>0 表示「上方比下方薄」 */
    thinBias: (up && dn) ? (dn.sparsity - up.sparsity) : null,
    /* 诊断用 */
    _row: row, _pocRow: poc, _win: winW, _nbars: prof.nbars, _anchor: anchor
  };
}

/**
 * 把结构特征按持仓方向翻成「对我有利为正」。
 *   thinEdge  薄带方向：做多时希望上方薄（好突破），做空反之
 *   cheapEdge 便宜度  ：做多时希望现价在 POC 下方（没追高）
 *   roomEdge  目标方向薄带到现价的距离
 *   guardEdge 止损方向薄带到现价的距离（越大 = 止损方向越不容易被打穿）
 * 后两个不预设符号好坏 —— 近了是「好走」还是「要跌破」，由回放数据说话。
 */
function directional(f, dir) {
  if (!f) return null;
  const long = dir === 1;
  return {
    thinEdge: f.thinBias === null ? null : (long ? f.thinBias : -f.thinBias),
    cheapEdge: long ? -f.dPoc : f.dPoc,
    roomEdge: long ? f.upDist : f.dnDist,
    guardEdge: long ? f.dnDist : f.upDist,
    /* 低位度：做多时现价越靠近窗口底部越好（没追高） */
    posSpanEdge: long ? (1 - f.posSpan) : f.posSpan,
    posVA: f.posVA,
    vaWidth: f.vaWidth
  };
}

/* ---------------------------------------------------------------- 工具 */
/** 取 tEnd 之前（不含）最近的 wBars 根 1m 的索引区间 —— 严格杜绝未来函数 */
function windowBefore(s, tEnd, wBars) {
  /* s.t 升序，找最后一个 t < tEnd 的索引 */
  let lo = 0, hi = s.n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.t[m] < tEnd) lo = m + 1; else hi = m; }
  const to = lo;                       // [0, to) 全部严格早于 tEnd
  return { from: Math.max(0, to - wBars), to: to };
}

module.exports = {
  buildProfile: buildProfile,
  pocOf: pocOf,
  valueArea: valueArea,
  thinBand: thinBand,
  structureAt: structureAt,
  directional: directional,
  binPx: binPx,
  windowBefore: windowBefore
};
