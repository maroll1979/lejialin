/* ============================ 指标 ============================ */
const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
function ema(a, n) {
  const k = 2 / (n + 1), out = []; let prev = null;
  for (const v of a) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}
function rsi(closes, n = 14) {
  const out = Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= n) { d > 0 ? g += d : l -= d; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function macd(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  return { dif, dea, hist: dif.map((v, i) => (v - dea[i]) * 2) };
}
function boll(closes, n = 20, k = 2) {
  const m = sma(closes, n), up = [], dn = [], wd = [];
  for (let i = 0; i < closes.length; i++) {
    if (m[i] == null) { up.push(null); dn.push(null); wd.push(null); continue; }
    const sl = closes.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(sl.reduce((a, x) => a + (x - m[i]) ** 2, 0) / n);
    up.push(m[i] + k * sd); dn.push(m[i] - k * sd); wd.push((2 * k * sd) / m[i] * 100);
  }
  return { mid: m, up, dn, wd };
}
/* ATR（Wilder 平滑）。
 * 坑：递推的是「n 项之和」s，输出才是 s/n。原写法 s=(s*(n-1)+tr)/n 少了 tr 该乘的 n，
 *     稳态时解出 s=tr → ATR=tr/n，把 ATR 整整低估 n 倍（实测 14 倍）。
 *     后果是止损位窄到离谱、建议仓位被顶到 60% 上限。 */
function atr(bars, n = 14) {
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  const out = []; let s = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < n) { s += tr[i]; out.push(i === n - 1 ? s / n : null); }
    else { s = s - s / n + tr[i]; out.push(s / n); }
  }
  return out;
}

/* ============================ 结构 · 量能 · 波动（做市商视角四件套） ============================ */
/* 说明：这四个因子与清算热力图共同决定方向。清算图只回答「流动性堆在哪」，
 * 结构回答「市场现在处在什么形态」，MACD 回答「动能往哪边走」，OBV 回答「量能认不认」，
 * BOLL 回答「波动是压缩还是扩张」。少任何一个都容易把「扫流动性」误判成「趋势启动」。 */

function obv(bars) {
  if (!bars.length) return [];                 // 空 K 线不该凭空产出第一个 0 点
  const o = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    o.push(o[i - 1] + (d > 0 ? bars[i].v : d < 0 ? -bars[i].v : 0));
  }
  return o;
}
function idxExt(bars, s, e, key, wantHigh) {
  let k = s;
  for (let i = s + 1; i < e; i++) {
    if (wantHigh ? bars[i][key] > bars[k][key] : bars[i][key] < bars[k][key]) k = i;
  }
  return k;
}

/* OBV 特征：累积量的绝对值没有意义，只取「相对自身波动的斜率」与「对均线的偏离」；
 * 再叠加顶/底背离（价格新高新低而量能不跟随 = 拉抬/砸盘缺乏承接）。 */
function obvFeat(bars) {
  const n = bars.length, i = n - 1;
  const o = obv(bars), m = sma(o, 30);
  if (i < 6) return { s: 0, slope: 0, above: 0, bear: false, bull: false, line: o, ma: m };
  const w = o.slice(Math.max(0, i - 59), i + 1);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length) || 1;
  const slope = (o[i] - o[Math.max(0, i - 10)]) / sd;
  const above = m[i] != null ? (o[i] - m[i]) / sd : 0;

  let bear = false, bull = false;
  // look 必须够长：三段式背离（涨 / 回撤 / 再创新高）的第一个高点天然落在 n 的 1/3 处，
  // 取 0.6n 会把窗口外的前一个高点漏掉，导致形态再标准也判不出来。
  const look = Math.min(120, Math.max(12, Math.floor(n * 0.85)));
  if (n > 25) {
    const seg = Math.max(4, Math.floor(look / 3));
    const a1 = n - look, a2 = Math.min(n, n - look + seg * 2), b1 = Math.max(a2, n - seg);
    if (a2 > a1 && b1 < n) {
      const hiA = idxExt(bars, a1, a2, 'h', true), hiB = idxExt(bars, b1, n, 'h', true);
      const loA = idxExt(bars, a1, a2, 'l', false), loB = idxExt(bars, b1, n, 'l', false);
      bear = bars[hiB].h > bars[hiA].h && o[hiB] < o[hiA];   // 价创新高，量能不跟 → 顶背离
      bull = bars[loB].l < bars[loA].l && o[loB] > o[loA];   // 价创新低，量能不跟 → 底背离
    }
  }
  let s = Math.tanh(slope * 0.8) * 0.62 + Math.tanh(above * 0.9) * 0.38;
  if (bear) s -= 0.5;                     // 确认背离要压得住「OBV 仍在走高」的表面读数
  if (bull) s += 0.5;
  return { s: clamp(s, -1, 1), slope, above, bear, bull, line: o, ma: m };
}

/* ZigZag 摆动点：先用 3 根分形（左右各 3 根的最高/最低）找候选，再用幅度阈值确认反向。
 * 纯幅度法对阈值极敏感：取 1~1.5 倍 ATR 时实测 150 根 K 线能出 149 个「摆动点」，结构完全失真。 */
function zigzag(bars, pct) {
  const n = bars.length, k = 3;
  if (n < k * 2 + 3) return [];
  const raw = [];
  for (let i = k; i < n - k; i++) {
    let isH = true, isL = true;
    // 左侧严格、右侧非严格：价格常见「等高 / 等低」并列，两侧都严格会把所有候选都判死。
    // 右侧取非严格 → 并列时归属最右边那根（更贴近当下）。
    for (let j = i - k; j <= i + k && (isH || isL); j++) {
      if (j === i) continue;
      if (j < i) {
        if (bars[j].h > bars[i].h) isH = false;
        if (bars[j].l < bars[i].l) isL = false;
      } else {
        if (bars[j].h >= bars[i].h) isH = false;
        if (bars[j].l <= bars[i].l) isL = false;
      }
    }
    if (isH) raw.push({ i, p: bars[i].h, t: 'H' });
    else if (isL) raw.push({ i, p: bars[i].l, t: 'L' });
  }
  const out = [];
  let pend = null;
  for (const p of raw) {
    const last = out.length ? out[out.length - 1] : null;
    if (!last) { out.push(p); continue; }
    if (last.t === p.t) {                                   // 同向 → 更新极值
      if (last.t === 'H' ? p.p > last.p : p.p < last.p) out[out.length - 1] = p;
      continue;
    }
    if (!pend || (last.t === 'H' ? p.p < pend.p : p.p > pend.p)) pend = p;   // 反向 → 追更极端
    if (Math.abs(pend.p - last.p) / last.p >= pct) { out.push(pend); pend = null; }
  }
  return out;
}

/* K 线结构：HH/HL = 上升；LH/LL = 下降；上破最近摆动高点 = BOS 转多；下破最近摆动低点 = BOS 转空；
 * 结构反向突破 = CHoCH（趋势可能切换，是做市商最爱用来「扫流动性」的位置）。 */
function structFeat(bars) {
  const n = bars.length, i = n - 1;
  const c = bars.map(b => b.c), px = c[i];
  if (n < 12) return { s: 0, trend: 'range', bos: null, choch: null, pts: [], swingHi: null, swingLo: null, lastH: null, lastL: null, atr: 0 };
  const A = atr(bars), a = A[i] > 0 ? A[i] : px * 0.004;
  // 分形已滤掉单根噪声，阈值只需过滤小幅震荡
  const pct = clamp(a / px * 1.5, 0.004, 0.05);
  const pts = zigzag(bars, pct);
  const hs = pts.filter(p => p.t === 'H'), ls = pts.filter(p => p.t === 'L');
  const lastH = hs.length ? hs[hs.length - 1] : null;
  const lastL = ls.length ? ls[ls.length - 1] : null;
  /* HH/HL/LH/LL 必须「显著」才算数：直接用大小比较会把浮点噪声当成突破。
   * 实测一条纯横盘序列的高点 30188 → 30192（差 0.013%）也会被判成 HH，进而读出上升趋势。
   * 容差取最近一段摆动幅度的 1/4（摆动幅度大则容差大），并用 ATR 兜底。 */
  const span = hs.length && ls.length ? Math.abs(lastH.p - lastL.p) : 0;
  const tol = Math.max(span * 0.25, a * 0.6);
  const HH = hs.length >= 2 && hs[hs.length - 1].p - hs[hs.length - 2].p > tol;
  const LH = hs.length >= 2 && hs[hs.length - 2].p - hs[hs.length - 1].p > tol;
  const HL = ls.length >= 2 && ls[ls.length - 1].p - ls[ls.length - 2].p > tol;
  const LL = ls.length >= 2 && ls[ls.length - 2].p - ls[ls.length - 1].p > tol;

  let trend = 'range';
  if (HH && HL) trend = 'up';
  else if (LH && LL) trend = 'down';
  else if (HH && LL) trend = 'expand';
  else if (LH && HL) trend = 'contract';

  let bos = null;
  if (lastH && px > lastH.p) bos = 'up';
  if (lastL && px < lastL.p) bos = 'down';
  let choch = null;
  if (trend === 'down' && bos === 'up') choch = 'bull';
  if (trend === 'up' && bos === 'down') choch = 'bear';

  let s = trend === 'up' ? 0.55 : trend === 'down' ? -0.55 : 0;
  if (bos === 'up') s += 0.3; else if (bos === 'down') s -= 0.3;
  if (choch === 'bull') s += 0.25; else if (choch === 'bear') s -= 0.25;
  const swingHi = hs.length ? Math.max.apply(null, hs.map(p => p.p)) : null;
  const swingLo = ls.length ? Math.min.apply(null, ls.map(p => p.p)) : null;
  // 连续项：价格在摆动区间中的位置，避免只有离散档位导致分数跳变
  if (swingHi != null && swingLo != null && swingHi > swingLo) s += ((px - swingLo) / (swingHi - swingLo) - 0.5) * 0.5;

  /* 摆动点不足时退回线性回归斜率。
   * 单边不回撤的连续阳线 / 阴线没有分形（最高价单调、最低价单调，一个摆动点都找不到），
   * 直接返回 0 会让「最强的一段趋势」在模型里完全没有声音 —— 没有结构不等于没有方向。 */
  if (hs.length < 2 || ls.length < 2) {
    const w = Math.min(n, 24);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = 0; j < w; j++) { const y = c[n - w + j]; sx += j; sy += y; sxx += j * j; sxy += j * y; }
    const den = w * sxx - sx * sx;
    const sl = den ? (w * sxy - sx * sy) / den : 0;        // 每根 K 线的平均价格变化
    const t = clamp(Math.tanh((sl * w) / (a * 2.5)), -1, 1); // 窗口总位移 / ATR
    trend = t > 0.2 ? 'up' : t < -0.2 ? 'down' : 'range';
    s = t * 0.6;
    if (trend === 'range') s = t * 0.35;
  }

  return { s: clamp(s, -1, 1), trend, bos, choch, pts: pts.slice(-6), hs, ls, lastH, lastL, swingHi, swingLo, atr: a };
}

/* BOLL：%B 位置在「带宽越宽」时趋势意义越强；带宽挤压时方向未定，主动压低权重 */
function bollFeat(bars) {
  const c = bars.map(b => b.c), i = c.length - 1;
  const B = boll(c, 20, 2);
  const mid = B.mid[i], up = B.up[i], dn = B.dn[i], wd = B.wd[i];
  if (mid == null || !(up > dn)) return { s: 0, pb: 0.5, wd: null, rank: 0.5, squeeze: false, B };
  const pb = clamp((c[i] - dn) / (up - dn), 0, 1);
  const ws = B.wd.slice(Math.max(0, i - 119), i + 1).filter(v => v != null).sort((x, y) => x - y);
  const rank = ws.length > 1 ? clamp(ws.filter(v => v <= wd).length / ws.length, 0, 1) : 0.5;
  // 挤压必须「分位低」且「绝对宽度也确实窄」：只判分位会把波动率的缓慢下行误判成挤压
  //（实测 200 根稳定上行序列带宽从 9.1 缓慢降到 6.3，分位只有 0.075，但那根本不是盘整）。
  const med = ws.length ? ws[Math.floor(ws.length / 2)] : wd;
  const squeeze = rank < 0.22 && wd < med * 0.75;
  let s = (pb - 0.5) * 2 * (0.45 + 0.55 * rank);
  if (squeeze) s *= 0.45;
  return { s: clamp(s, -1, 1), pb, wd, rank, squeeze, mid, up, dn, B };
}

/* MACD：柱 / DIF / DEA 统一按「价格的百分比」归一 —— 跨品种可比，且不会被单根噪声翻转。
 * 只取 hist（旧写法按 ATR 归一）会出问题：150 根稳定下行序列在末段一次噪声金叉就能给出 +0.32，
 * 因为此时 hist 只有 22 而 DIF/DEA 在 -373/-384，hist 被 ATR 尺度放大成了主导项。
 * 故把慢变量「DIF/DEA 的零轴位置」也纳入，并把归一尺度换成价格百分比。 */
function macdFeat(bars) {
  const c = bars.map(b => b.c), i = c.length - 1;
  const M = macd(c), A = atr(bars);
  const a = A[i] > 0 ? A[i] : c[i] * 0.004;
  const h = M.hist[i], dif = M.dif[i], dea = M.dea[i];
  if (!isFinite(h) || !isFinite(dif) || !isFinite(dea)) return { s: 0, hist: 0, dif: 0, dea: 0, cross: 0, above0: 0, lvl: 0, M };
  let cross = 0;
  for (let k = Math.max(1, i - 4); k <= i; k++) {
    if (M.dif[k - 1] <= M.dea[k - 1] && M.dif[k] > M.dea[k]) cross = 1;
    if (M.dif[k - 1] >= M.dea[k - 1] && M.dif[k] < M.dea[k]) cross = -1;
  }
  const above0 = dif > 0 && dea > 0 ? 1 : dif < 0 && dea < 0 ? -1 : 0;
  const sc = Math.max(c[i] * 0.01, a * 0.6);            // 归一尺度：价格 1%，极低波动时退回 ATR
  const hn = Math.tanh(h / sc);
  const dn = Math.tanh(dif / sc), en = Math.tanh(dea / sc);
  const lvl = (dn + en) / 2;                            // 零轴位置（慢变量）
  const slope = isFinite(M.hist[i - 2]) ? Math.tanh((h - M.hist[i - 2]) / sc) : 0;
  const s = clamp(hn * 0.34 + slope * 0.14 + cross * 0.2 + lvl * 0.32, -1, 1);
  return { s, hist: h, dif, dea, cross, above0, lvl, M };
}

/* KDJ（9,3,3）：RSV 取 n 根内收盘价在最高/最低区间中的位置，再做两次 1/3 平滑得 K、D。
 * 初值按惯例取 50。注意平滑系数是 1/m（K = 2/3·K' + 1/3·RSV），不是 EMA 的 2/(n+1)。 */
function kdj(bars, n = 9, m1 = 3, m2 = 3) {
  const K = [], D = [], J = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i >= n - 1) {
      let hh = -Infinity, ll = Infinity;
      for (let t = i - n + 1; t <= i; t++) { if (bars[t].h > hh) hh = bars[t].h; if (bars[t].l < ll) ll = bars[t].l; }
      const rsv = hh > ll ? (bars[i].c - ll) / (hh - ll) * 100 : 50;
      k = (k * (m1 - 1) + rsv) / m1;
      d = (d * (m2 - 1) + k) / m2;
    }
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return { K, D, J };
}

/* KDJ 因子：位置 + 交叉 + 极端修正。
 * 关键取舍：KDJ 是摆动指标，单边趋势里会长期钝化在超买/超卖区，
 * 所以「位置项」权重给到 0.46 而不是只看金叉死叉 —— 钝化本身也是趋势强的一种体现。
 * 但 J 值突破 100 / 跌破 0 是实打实的透支信号，此时对顺势方向反向扣分。 */
function kdjFeat(bars) {
  const i = bars.length - 1;
  const K = kdj(bars);
  const k = K.K[i], d = K.D[i], j = K.J[i];
  if (!isFinite(k) || !isFinite(d) || !isFinite(j))
    return { s: 0, k: 50, d: 50, j: 50, cross: 0, zone: 'mid', K };
  let cross = 0;
  for (let t = Math.max(1, i - 4); t <= i; t++) {
    if (K.K[t - 1] <= K.D[t - 1] && K.K[t] > K.D[t]) cross = 1;
    if (K.K[t - 1] >= K.D[t - 1] && K.K[t] < K.D[t]) cross = -1;
  }
  const pos = clamp((k - 50) / 40, -1, 1);           // ±40 点饱和，避免钝化区数值爆炸
  const zone = k >= 80 ? 'over' : k <= 20 ? 'under' : (k > 50 ? 'upper' : 'lower');

  /* 交叉项：与位置项同向时全额计入，反向时只算 55%。
   * 原因：单边市里 KDJ 长期钝化在极端区并反复出现反向交叉 —— 一路暴跌时 K 值贴在 0 附近，
   * 随便一根小反弹就金叉。若不打折，「最强的一段下跌」里 KDJ 会持续给出看多信号，
   * 与其他四个趋势口径的因子长期背离。 */
  const cw = (cross * pos >= 0) ? 0.34 : 0.34 * 0.55;
  const core = pos * 0.46 + cross * cw;
  let s = core;

  // 低位金叉 / 高位死叉是有效确认，但 K<20 / K>80 属于钝化区，那里的交叉基本是噪音，不加分
  if (cross === 1 && k > 20 && k < 35) s += 0.12;
  if (cross === -1 && k < 80 && k > 65) s -= 0.12;

  /* J 突破 100 / 跌破 0 = 动能透支。处理方式是「削弱当前方向的强度」而不是「反向给分」 ——
   * 透支只意味着这段趋势走不远，不意味着它现在就掉头。 */
  if (j > 100 || j < 0) s *= 0.72;

  // 超买区金叉 / 超卖区死叉可信度打折
  if (k >= 80 && cross === 1) s *= 0.8;
  if (k <= 20 && cross === -1) s *= 0.8;

  // 兜底：上述修正不允许把「位置 + 交叉」的核心结论翻号
  if (core !== 0 && s * core < 0) s = core * 0.5;

  return { s: clamp(s, -1, 1), k, d, j, cross, zone, K };
}

