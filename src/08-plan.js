/* ============================ 交易计划：入场 / 止损 / 止盈 ============================ */
/* 做市商结论落地成四个可执行价位。价位不是拍脑袋的倍数，全部来自上面识别出的价格带：
 *   入场 = 回踩/反抽不破的挂单区（entryBand，现价顺方向一侧 0.15~0.9 ATR）
 *   止损 = 失效带（failBand）远端再让出 0.15 ATR —— 扫到带内是剧本，穿出带外不收回才算错
 *   止盈①= 顺方向第一清算带的近端（流动性被吃穿的位置，最容易成交）
 *   止盈②= 该带远端再上浮 0.35 ATR；若还有更远的同侧带，取更远那条的带心
 * 全部价位最后统一做一次单调性收敛：做多必须 sl < entry.lo ≤ entry.hi < tp1 < tp2，
 * 做空全部反向。否则会出现「止损比止盈还远」这种荒谬结果。
 *
 * forceBias：四周期融合决策调用时传入。总决策的方向可能与本周期自己的结论不同，
 * 此时价位必须按总方向重算（bands 也按总方向取），否则会出现
 * 「总决策做空、止损却放在多头结构上方」的错位。强制方向时本周期的 sweep 剧本不再适用，
 * 直接置空 —— 那套「先扫再掉头」的前提就是本周期自己的流动性背离。 */
function mmTrade(symId, tfKey, bars, F0, forceBias) {
  const M = mmView(symId, tfKey, bars, F0);
  const s = SYMS[symId], dp = s.dp, px = M.px, a = M.atr;
  const bias = forceBias || M.bias;
  const forced = !!forceBias && forceBias !== M.bias;
  if (forced) { M.sweep = null; M.mode = forceBias === 'wait' ? 'stand' : 'follow'; }

  const eb = M.entryBand;
  const ebOK = eb && isFinite(eb.lo) && isFinite(eb.hi) && eb.hi > eb.lo;
  let entryLo = ebOK ? eb.lo : px - a * 0.25;
  let entryHi = ebOK ? eb.hi : px + a * 0.25;
  const entryMid = (entryLo + entryHi) / 2;

  const tb = M.targetBand, fb = M.failBand;
  let sl = null, tp1 = null, tp2 = null, slWhy = '', tp1Why = '', tp2Why = '';

  if (bias === 'long' || bias === 'short') {
    const up = bias === 'long';
    if (up) {
      sl = fb ? fb.lo - a * 0.15 : px - a * 1.8;
      slWhy = fb ? '跌穿下方多单清算带视为失效' : '无清算带，按 1.8 ATR 兜底';
      const farUp = (M.zUp || []).filter(z => z.lo > px).sort((x, y) => x.mid - y.mid);
      tp1 = tb ? tb.lo : px + a * 1.8;
      tp1Why = tb ? '上方空单止损带近端' : '无清算带，按 1.8 ATR 兜底';
      tp2 = tb ? tb.hi + a * 0.35 : px + a * 3.2;
      tp2Why = tb ? '上方空单止损带远端外扩' : '无清算带，按 3.2 ATR 兜底';
      if (farUp.length > 1 && farUp[1].mid > tp2) {
        tp2 = farUp[1].mid; tp2Why = '第二条上方清算带带心';
      }
    } else {
      sl = fb ? fb.hi + a * 0.15 : px + a * 1.8;
      slWhy = fb ? '涨穿上方空单清算带视为失效' : '无清算带，按 1.8 ATR 兜底';
      const farDn = (M.zDn || []).filter(z => z.hi < px).sort((x, y) => y.mid - x.mid);
      tp1 = tb ? tb.hi : px - a * 1.8;
      tp1Why = tb ? '下方多单止损带近端' : '无清算带，按 1.8 ATR 兜底';
      tp2 = tb ? tb.lo - a * 0.35 : px - a * 3.2;
      tp2Why = tb ? '下方多单止损带远端外扩' : '无清算带，按 3.2 ATR 兜底';
      if (farDn.length > 1 && farDn[1].mid < tp2) {
        tp2 = farDn[1].mid; tp2Why = '第二条下方清算带带心';
      }
    }
  } else {
    // 观望：不给单边价位，只给上下边界，避免用户照着一个「方向未定」的结论下单
    sl = px - a * 1.6; tp1 = px + a * 1.6; tp2 = px + a * 2.8;
    slWhy = tp1Why = tp2Why = '方向未定，仅为 ATR 边界参考，不构成下单依据';
  }

  /* 单调收敛。顺序不能省：先保证止损在入场外侧，再保证止盈在入场内侧之外，
   * 最后才拉开 TP1/TP2 的间距 —— 反过来做会出现「修正止损时把止盈也带歪」。 */
  if (bias === 'long') {
    if (!(sl < entryLo)) sl = Math.min(entryLo - a * 0.6, px - a * 1.2);
    if (!(tp1 > entryHi)) tp1 = Math.max(entryHi + a * 0.8, px + a * 1.2);
    if (!(tp2 > tp1 * 1.0001)) tp2 = tp1 + Math.max(a * 1.0, (tp1 - px) * 0.6);
  } else if (bias === 'short') {
    if (!(sl > entryHi)) sl = Math.max(entryHi + a * 0.6, px + a * 1.2);
    if (!(tp1 < entryLo)) tp1 = Math.min(entryLo - a * 0.8, px - a * 1.2);
    if (!(tp2 < tp1 * 0.9999)) tp2 = tp1 - Math.max(a * 1.0, (px - tp1) * 0.6);
  }

  const risk = Math.abs(entryMid - sl);
  const rew1 = Math.abs(tp1 - entryMid);
  const rr = risk > 1e-9 ? rew1 / risk : null;
  const riskPct = px > 0 ? risk / px * 100 : 0;
  // 建议保证金占比：单笔最大亏损锁定在本金 1.2% 以内（未加杠杆口径），再夹到 5%~60%
  const posPct = clamp(1.2 / Math.max(0.08, riskPct) * 1.0, 5, 60);
  const tfLab = (TF_MAP[tfKey] || {}).label || tfKey;

  return {
    bias, mode: M.mode, px, atr: a, dp, conf: M.conf, score: M.F.score,
    confInd: M.confInd, nEff: M.nEff, nEffAll: M.nEffAll,
    entry: { lo: entryLo, hi: entryHi, mid: entryMid },
    sl, tp1, tp2, rr, riskPct, posPct,
    slWhy, tp1Why, tp2Why,
    slPct: (sl / px - 1) * 100, tp1Pct: (tp1 / px - 1) * 100, tp2Pct: (tp2 / px - 1) * 100,
    entryPctLo: (entryLo / px - 1) * 100, entryPctHi: (entryHi / px - 1) * 100,
    hold: tfLab + ' × 3~8 根',
    mm: M,
  };
}

/* 与 analyzeOf 同口径的缓存：draw() 每次 mousemove 都会重绘，不能每帧重算一遍 mmView。 */
const _tdCache = new Map();
function mmTradeOf(sym, tf, bars) {
  const key = sym + '|' + tf + '|' + bars.length + '|' + bars[bars.length - 1].c;
  if (!_tdCache.has(key)) {
    if (_tdCache.size > 64) _tdCache.clear();
    _tdCache.set(key, mmTrade(sym, tf, bars));
  }
  return _tdCache.get(key);
}

// 打分模型：以趋势跟随为主，RSI/布林仅作修正与过热提示，避免两类逻辑互相抵消
function analyze(bars) {
  const c = bars.map(b => b.c);
  const i = c.length - 1;
  const R = rsi(c), M = macd(c), B = boll(c), A = atr(bars);
  const ma7 = sma(c, 7), ma25 = sma(c, 25), ma99 = sma(c, 99);
  const KD = kdj(bars);                       // 第五个技术面维度：KDJ(9,3,3)，供图表副图与图例读数
  const px = c[i], a = A[i] || px * 0.004;
  const atrPct = a / px * 100;

  let sc = 0;
  const Rv = R[i] ?? 50;

  // 1) 均线排列 ±25：趋势的主干
  const up25 = ma25[i] != null && px > ma25[i];
  const dn25 = ma25[i] != null && px < ma25[i];
  if (ma25[i] != null && ma99[i] != null) {
    if (px > ma25[i] && ma25[i] > ma99[i]) sc += 25;
    else if (px < ma25[i] && ma25[i] < ma99[i]) sc -= 25;
    else sc += up25 ? 10 : dn25 ? -10 : 0;
  }

  // 2) 动量 ±22：用 ATR 归一化，保证跨品种可比
  const mom = i >= 10 ? (px / c[i - 10] - 1) * 100 : 0;
  const norm = atrPct > 0 ? mom / (atrPct * Math.sqrt(10)) : 0;
  sc += clamp(norm * 7, -22, 22);

  // 3) MACD ±18
  const hv = M.hist[i], hp = M.hist[i - 1];
  if (hv != null && hp != null) {
    if (hv > 0 && hp <= 0) sc += 18;
    else if (hv < 0 && hp >= 0) sc -= 18;
    else sc += hv > 0 ? 7 : -7;
  }

  // 4) RSI 位置 ±15：延续方向给分，极端过热才反向修正
  sc += clamp((Rv - 50) / 50 * 15, -15, 15);
  if (Rv > 80) sc -= 6; else if (Rv < 20) sc += 6;

  // 5) 布林 ±10：仅在未获趋势确认时提示回归
  if (B.dn[i] != null && B.up[i] != null) {
    if (px < B.dn[i] && Rv < 45) sc += 10;
    else if (px > B.up[i] && Rv > 55) sc -= 10;
  }

  sc = clamp(sc, -100, 100);
  const dir = sc > 22 ? 'long' : sc < -22 ? 'short' : 'wait';
  const sgn = dir === 'short' ? -1 : 1;

  return {
    dir, score: sc, strength: Math.abs(sc), px, rsi: Rv, macdH: hv, atr: a, atrPct,
    bollW: B.wd[i], mom, ma7: ma7[i], ma25: ma25[i], ma99: ma99[i],
    entryLo: px - a * 0.25, entryHi: px + a * 0.25,
    sl: px - sgn * a * 1.6, tp: px + sgn * a * 3.2,
    posPct: clamp(1.0 / (1.6 * atrPct) * 10, 5, 60),
    ind: { rsi: R, macd: M, boll: B, atr: A, ma7, ma25, ma99, kdj: KD },
  };
}

// 重绘（含十字光标）时复用指标结果，避免每次 mousemove 重算
const _anCache = new Map();
function analyzeOf(sym, tf, bars) {
  const key = sym + '|' + tf + '|' + bars.length + '|' + bars[bars.length - 1].c;
  if (!_anCache.has(key)) _anCache.set(key, analyze(bars));
  return _anCache.get(key);
}

