/* ============================================================
   多周期交易系统 v2.1 · 可编程规则基线（第 1–14 节）
   ------------------------------------------------------------
   4H  Macro Regime ·  只做背景，不参与评分（只改开仓门槛 70/75/85）
   1H  Primary Trend · 主趋势 / 趋势质量         20 分
   30m Transition    · 趋势衰竭 / 状态切换       25 分
   15m Setup         · 反转准备 / 背离 / 假突破  30 分
   5m  Trigger       · CHOCH / Retest / BOS      25 分
   ------------------------------------------------------------
   核心原则：周期不是民主投票，而是层级状态机。
   禁止「多周期同权投票 + 指标金叉后开仓」。
   评分只解决「质量」，Gate 解决「是否允许开仓」，两者同时满足才出信号。
   ⚠ 第 15 条（v2.2 全参数表 / JSON-Pine 输出）本次不做。
   ============================================================ */
(function (root, factory) {
  const S = (typeof module !== 'undefined' && module.exports) ? require('./strategy.js') : root.Strategy;
  const api = factory(S);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.V21 = api;
})(typeof window !== 'undefined' ? window : globalThis, function (S) {
  'use strict';

  const TF_SEC = S.TF_SEC;
  const aggregate = S.aggregate;
  const toSeries = S.toSeries;
  const tailObjects = S.tailObjects;
  const buildMap = S.buildMap;
  const buildClosedMap = S.buildClosedMap;
  const msSeries = S.msSeries;
  const msReplay = S.msReplay;
  const msCopy = S.msCopy;
  const defaultTpsl = S.defaultTpsl;
  const FEE_RATE = 0.001;                 // 与 strategy.js 一致（市价 Taker 单边）

  function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function nn(v) { return v == null || !isFinite(v) ? 0 : v; }

  function Ring(n) { this.n = n; this.a = new Float64Array(n); this.c = 0; this.len = 0; }
  Ring.prototype.push = function (v) { this.a[this.c] = v; this.c = (this.c + 1) % this.n; if (this.len < this.n) this.len++; };
  Ring.prototype.get = function (k) {
    if (k < 0 || k >= this.len) return NaN;
    return this.a[(this.c - 1 - k + this.n * 2) % this.n];
  };
  /* 定长环 + 滑动和（OBV 窗口 / 成交量均值用） */
  function SumRing(n) { this.n = n; this.a = new Float64Array(n); this.c = 0; this.len = 0; this.sum = 0; }
  SumRing.prototype.push = function (v) {
    if (this.len === this.n) this.sum -= this.a[this.c];
    this.a[this.c] = v; this.c = (this.c + 1) % this.n; if (this.len < this.n) this.len++;
    this.sum += v;
  };

  /* ============================================================
     常量
     ============================================================ */
  const WS_P = 14;                 // Wilder 周期（ATR / DI / ADX / RSI）
  const KDJ_N = 9, KDJ_HI = 75, KDJ_LO = 25;
  const BOLL_N = 20;
  const LOOK = 30;                 // 背离 lookback
  const HIST_WIN = 40;             // close / rsi / dif / obv 回看窗口
  const OBV_WIN = 200;             // 滚动 OBV 窗口
  const VOL_WIN = 120;             // RVOL 基准窗口
  const PIV = 2;                   // pivot 左右窗口（与 5m 结构引擎同一口径）
  const DIV_KEEP = 16, DIV_VALID = 40;   // 背离有效期（根）：16 根内满分，40 根后失效
  const FB_KEEP = 8, FB_VALID = 20;      // 假突破有效期
  const STRUCT_FRESH = 12;               // HL / LH 雏形新鲜度上限（根）

  /* 七状态机（第 4 节 30m Transition） */
  const ST = { STRONG_BEAR: -3, BEAR: -2, BEAR_EXH: -1, TRANSITION: 0, BULL_EXH: 1, BULL: 2, STRONG_BULL: 3 };
  const ST_NAME = {
    '-3': 'Strong Bear', '-2': 'Bear', '-1': 'Bear Exhaustion', '0': 'Transition',
    '1': 'Bull Exhaustion', '2': 'Bull', '3': 'Strong Bull',
  };
  /* 4H Macro Regime */
  const REG = { BEAR: -1, RANGE: 0, BULL: 1 };
  const REG_NAME = { '-1': 'Bear', '0': 'Range', '1': 'Bull' };

  /* 第 7 节门槛 + 第 8 节 Setup 下限 */
  const TH_WITH = 70, TH_RANGE = 75, TH_AGAINST = 85;
  const SETUP_MIN = 18, SETUP_MIN_CT = 22;
  const CHASE_ATR = 1.5;           // 离 5m 突破位超过 1.5 ATR 视为追价

  /* ============================================================
     VStream：一份实现供 4H / 1H / 30m / 15m 共用
     所有价格差一律 ÷ Wilder ATR(14) 归一（多周期多品种共用同一套阈值）
     ============================================================ */
  function VStream() { this.reset(); }
  VStream.prototype.reset = function () {
    this.n = 0;
    this.prevHigh = null; this.prevLow = null; this.prevClose = null;
    this.e12 = null; this.e26 = null; this.dea = null; this.hist = null;
    this.tSum = 0; this.pSum = 0; this.mSum = 0; this.atr = null;
    this.adxV = null; this.dxSum = 0; this.dxCn = 0; this.adx = null;
    this.ag = 0; this.al = 0; this.rsi = 50;
    this.k = 50; this.d = 50;
    this.khh = new Ring(KDJ_N); this.kll = new Ring(KDJ_N);
    this.buf = new Ring(BOLL_N);
    this.obvR = new SumRing(OBV_WIN);
    this.vR = new SumRing(VOL_WIN);
    this.cR = new Ring(HIST_WIN); this.hR = new Ring(HIST_WIN); this.lR = new Ring(HIST_WIN);
    this.rsiR = new Ring(HIST_WIN); this.difR = new Ring(HIST_WIN); this.obvHR = new Ring(HIST_WIN);
    this.histR = new Ring(8); this.adxR = new Ring(24); this.atrR = new Ring(24);
    this.e12R = new Ring(8); this.e26R = new Ring(12);
    this.hw = new Ring(PIV * 2 + 1); this.lw = new Ring(PIV * 2 + 1);
    this.phP = 0; this.phI = -1; this.phPrevP = 0; this.phT = -1;
    this.plP = 0; this.plI = -1; this.plPrevP = 0; this.plT = -1;
    /* pivot 处的指标值（背离判定用） */
    this.plR = 0; this.plD = 0; this.plO = 0;
    this.plPrevR = 0; this.plPrevD = 0; this.plPrevO = 0;
    this.phR = 0; this.phD = 0; this.phO = 0;
    this.phPrevR = 0; this.phPrevD = 0; this.phPrevO = 0;
    /* 背离状态（带有效期，保证跨层能遇上 5m 扳机） */
    this.divB = { r: 0, m: 0, o: 0, i: -1 };
    this.divS = { r: 0, m: 0, o: 0, i: -1 };
    this.fbB = { v: 0, i: -1 }; this.fbS = { v: 0, i: -1 };
    this.dun = 0; this.dunDir = 0; this.wasExtreme = false; this.runLen = 0; this.runDir = 0;
    this.brkDnIdx = -1; this.brkDnLvl = 0; this.brkUpIdx = -1; this.brkUpLvl = 0;
    this.out = null;
  };

  /* 事件有效期衰减：keep 根内满分，之后线性淡出到 valid */
  function fade(i, at, keep, valid) {
    if (at == null || at < 0) return 0;
    const d = i - at;
    if (d < 0) return 0;
    if (d <= keep) return 1;
    if (d >= valid) return 0;
    return 1 - (d - keep) / (valid - keep);
  }

  VStream.prototype.push = function (open, high, low, close, volume) {
    const i = this.n++;
    const vol = volume || 0;
    const o = this.out || (this.out = {});

    /* --- EMA（首根取自身，与 app.js 同初始化） --- */
    this.e12 = this.e12 == null ? close : close * (2 / 13) + this.e12 * (11 / 13);
    this.e26 = this.e26 == null ? close : close * (2 / 27) + this.e26 * (25 / 27);

    /* --- Wilder TR / DM / ATR / ADX（与 strategy.js SignalStream 同式） --- */
    let tr, dp, dm;
    if (i === 0) { tr = high - low; dp = 0; dm = 0; }
    else {
      const upM = high - this.prevHigh, dnM = this.prevLow - low;
      dp = (upM > dnM && upM > 0) ? upM : 0;
      dm = (dnM > upM && dnM > 0) ? dnM : 0;
      tr = Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose));
    }
    let A = null, adx0 = null, diPv = null, diMv = null;
    if (i < WS_P) { this.tSum += tr; this.pSum += dp; this.mSum += dm; }
    else {
      if (i === WS_P) { this.tSum += tr; this.pSum += dp; this.mSum += dm; }
      else {
        this.tSum = this.tSum - this.tSum / WS_P + tr;
        this.pSum = this.pSum - this.pSum / WS_P + dp;
        this.mSum = this.mSum - this.mSum / WS_P + dm;
      }
      A = this.tSum / WS_P;
      diPv = this.tSum > 0 ? 100 * this.pSum / this.tSum : 0;
      diMv = this.tSum > 0 ? 100 * this.mSum / this.tSum : 0;
      const dsum = diPv + diMv;
      const dx = dsum > 0 ? 100 * Math.abs(diPv - diMv) / dsum : 0;
      if (this.adxV == null) {
        this.dxSum += dx; this.dxCn++;
        if (this.dxCn >= WS_P) { this.adxV = this.dxSum / WS_P; adx0 = this.adxV; }
      } else { this.adxV = (this.adxV * (WS_P - 1) + dx) / WS_P; adx0 = this.adxV; }
    }
    const atr = A;
    this.adxR.push(adx0 == null ? NaN : adx0);
    this.atrR.push(atr == null ? NaN : atr);

    /* --- MACD --- */
    const dif = this.e12 - this.e26;
    this.dea = this.dea == null ? dif : dif * (2 / 10) + this.dea * (8 / 10);
    const hist = dif - this.dea;
    const h1v = this.histR.len >= 1 ? this.histR.get(0) : 0;
    const h2v = this.histR.len >= 2 ? this.histR.get(1) : 0;

    /* --- RSI（Wilder） --- */
    if (i > 0) {
      const ch = close - this.prevClose;
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= WS_P) { this.ag += g; this.al += l; if (i === WS_P) { this.ag /= WS_P; this.al /= WS_P; } }
      else { this.ag = (this.ag * (WS_P - 1) + g) / WS_P; this.al = (this.al * (WS_P - 1) + l) / WS_P; }
      this.rsi = (this.ag + this.al) > 0 ? 100 * this.ag / (this.ag + this.al) : 50;
    }

    /* --- KDJ(9,3,3) 钝化状态机 --- */
    this.khh.push(high); this.kll.push(low);
    if (this.khh.len === KDJ_N) {
      let hh = -Infinity, ll = Infinity;
      for (let q = 0; q < KDJ_N; q++) { const a = this.khh.get(q); const b = this.kll.get(q); if (a > hh) hh = a; if (b < ll) ll = b; }
      const rsv = hh === ll ? 50 : (close - ll) / (hh - ll) * 100;
      this.k = (2 / 3) * this.k + (1 / 3) * rsv;
      this.d = (2 / 3) * this.d + (1 / 3) * this.k;
    }
    const Dv = this.d;
    const inZone = Dv > KDJ_HI || Dv < KDJ_LO;
    const zoneDir = Dv > KDJ_HI ? 1 : -1;
    if (inZone) {
      if (this.dunDir === zoneDir) this.dun++; else { this.dun = 1; this.dunDir = zoneDir; }
      this.wasExtreme = true;
    } else {
      if (this.wasExtreme) { this.runLen = this.dun; this.runDir = this.dunDir; }
      this.dun = 0; this.dunDir = 0; this.wasExtreme = false;
    }

    /* --- BOLL(20,2) --- */
    this.buf.push(close);
    let mid = null, sd = null, up = null, lo = null, z = null, bwRank = null;
    if (this.buf.len === BOLL_N) {
      let s = 0; for (let x = 0; x < BOLL_N; x++) s += this.buf.get(x);
      mid = s / BOLL_N;
      let ss = 0; for (let x = 0; x < BOLL_N; x++) { const dd = this.buf.get(x) - mid; ss += dd * dd; }
      sd = Math.sqrt(ss / BOLL_N);
      up = mid + 2 * sd; lo = mid - 2 * sd;
      z = sd > 0 ? (close - mid) / sd : 0;
    }

    /* --- 滚动 OBV（最近 OBV_WIN 根的带符号成交量之和） --- */
    let delta = 0;
    if (i > 0) { if (close > this.prevClose) delta = vol; else if (close < this.prevClose) delta = -vol; }
    this.obvR.push(delta);
    const obvW = this.obvR.sum;

    /* --- RVOL --- */
    this.vR.push(vol);
    const rvol = (this.vR.len >= 20 && this.vR.sum > 0) ? vol / (this.vR.sum / this.vR.len) : 1;

    /* --- 回看窗口极值（先扫描历史，再落当前根，保证配对） --- */
    const L = Math.min(LOOK, this.cR.len);
    let hiC = -Infinity, hiR = NaN, hiD = NaN, hiO = NaN;
    let loC = Infinity, loR = NaN, loD = NaN, loO = NaN;
    for (let q = 0; q < L; q++) {
      const cq = this.cR.get(q), rq = this.rsiR.get(q), dq = this.difR.get(q), oq = this.obvHR.get(q);
      if (cq > hiC) { hiC = cq; hiR = rq; hiD = dq; hiO = oq; }
      if (cq < loC) { loC = cq; loR = rq; loD = dq; loO = oq; }
    }
    /* 前 20 根高低点（假突破判定用） */
    let sHi = -Infinity, sLo = Infinity;
    const L2 = Math.min(20, this.hR.len);
    for (let q = 0; q < L2; q++) { const a = this.hR.get(q), b = this.lR.get(q); if (a > sHi) sHi = a; if (b < sLo) sLo = b; }

    /* --- 假突破：跌破前 20 根低点 / 突破前 20 根高点后快速收回 --- */
    let falseDn = 0, falseUp = 0;
    if (isFinite(sLo) && low < sLo) { this.brkDnIdx = i; this.brkDnLvl = sLo; }
    if (isFinite(sHi) && high > sHi) { this.brkUpIdx = i; this.brkUpLvl = sHi; }
    const vAvg = this.vR.len > 0 ? this.vR.sum / this.vR.len : 0;
    if (this.brkDnIdx >= 0 && i - this.brkDnIdx <= 8 && close > this.brkDnLvl) {
      falseDn = 1;
      /* 假跌破质量：收回幅度 + 是否放量拒绝 */
      const rec = (close - this.brkDnLvl) / (atr || (this.brkDnLvl * 0.001));
      this.fbB.v = 2 + 2 * clamp01(rec / 0.8) + (rvol >= 1.6 ? 0.6 : 0);
      this.fbB.v = clampN(this.fbB.v, 0, 4);
      this.fbB.i = i;
    }
    if (this.brkUpIdx >= 0 && i - this.brkUpIdx <= 8 && close < this.brkUpLvl) {
      falseUp = 1;
      const rec = (this.brkUpLvl - close) / (atr || (this.brkUpLvl * 0.001));
      this.fbS.v = 2 + 2 * clamp01(rec / 0.8) + (rvol >= 1.6 ? 0.6 : 0);
      this.fbS.v = clampN(this.fbS.v, 0, 4);
      this.fbS.i = i;
    }

    /* --- pivot（fractal，中心根 = i−PIV，右侧窗口走完才确认） --- */
    this.hw.push(high); this.lw.push(low);
    if (this.hw.len === PIV * 2 + 1) {
      const W = PIV * 2 + 1;
      let isPH = true, isPL = true;
      const hc = this.hw.get(PIV), lc = this.lw.get(PIV);
      for (let q = 0; q < W; q++) {
        if (q === PIV) continue;
        if (this.hw.get(q) >= hc) isPH = false;
        if (this.lw.get(q) <= lc) isPL = false;
      }
      /* pivot 中心根 = i-PIV；此刻 ring 尚未落当前根，故 get(PIV-1) 即该根指标值 */
      const rAt = this.rsiR.len > PIV ? this.rsiR.get(PIV - 1) : this.rsi;
      const dAt = this.difR.len > PIV ? this.difR.get(PIV - 1) : dif;
      const oAt = this.obvHR.len > PIV ? this.obvHR.get(PIV - 1) : obvW;

      if (isPL) {
        if (this.plI >= 0 && lc < this.plPrevP) {
          /* 价格更低低点 → 检查三个指标是否不确认（底背离） */
          const mR = rAt - this.plPrevR;                                   // RSI 点差
          const mD = atr > 0 ? (dAt - this.plPrevD) / atr : 0;              // DIF 差（ATR 归一）
          const mO = vAvg > 0 ? (oAt - this.plPrevO) / (vAvg * 4) : 0;      // OBV 差（成交量归一）
          if (mR > 0) this.divB.r = 5 * clamp01(0.4 + mR / 6);
          if (mD > 0) this.divB.m = 5 * clamp01(0.4 + mD / 0.15);
          if (mO > 0) this.divB.o = 5 * clamp01(0.4 + mO / 1.2);
          if (mR > 0 || mD > 0 || mO > 0) this.divB.i = i;
        }
        this.plPrevP = this.plP; this.plPrevR = this.plR; this.plPrevD = this.plD; this.plPrevO = this.plO;
        this.plP = lc; this.plI = i - PIV; this.plT = i;
        this.plR = rAt; this.plD = dAt; this.plO = oAt;
      }
      if (isPH) {
        if (this.phI >= 0 && hc > this.phPrevP) {
          const mR = this.phPrevR - rAt;
          const mD = atr > 0 ? (this.phPrevD - dAt) / atr : 0;
          const mO = vAvg > 0 ? (this.phPrevO - oAt) / (vAvg * 4) : 0;
          if (mR > 0) this.divS.r = 5 * clamp01(0.4 + mR / 6);
          if (mD > 0) this.divS.m = 5 * clamp01(0.4 + mD / 0.15);
          if (mO > 0) this.divS.o = 5 * clamp01(0.4 + mO / 1.2);
          if (mR > 0 || mD > 0 || mO > 0) this.divS.i = i;
        }
        this.phPrevP = this.phP; this.phPrevR = this.phR; this.phPrevD = this.phD; this.phPrevO = this.phO;
        this.phP = hc; this.phI = i - PIV; this.phT = i;
        this.phR = rAt; this.phD = dAt; this.phO = oAt;
      }
    }
    const HH = (this.phI >= 0 && this.phPrevP > 0) ? this.phP > this.phPrevP : false;
    const LH = (this.phI >= 0 && this.phPrevP > 0) ? this.phP < this.phPrevP : false;
    const HL = (this.plI >= 0 && this.plPrevP > 0) ? this.plP > this.plPrevP : false;
    const LL = (this.plI >= 0 && this.plPrevP > 0) ? this.plP < this.plPrevP : false;
    const hlFresh = this.plT >= 0 && (i - this.plT) <= STRUCT_FRESH;
    const lhFresh = this.phT >= 0 && (i - this.phT) <= STRUCT_FRESH;
    /* 背离有效分（带淡出） */
    const fB = fade(i, this.divB.i, DIV_KEEP, DIV_VALID);
    const fS = fade(i, this.divS.i, DIV_KEEP, DIV_VALID);
    const dvB = { r: this.divB.r * fB, m: this.divB.m * fB, o: this.divB.o * fB, f: fB };
    const dvS = { r: this.divS.r * fS, m: this.divS.m * fS, o: this.divS.o * fS, f: fS };
    const fbBv = this.fbB.v * fade(i, this.fbB.i, FB_KEEP, FB_VALID);
    const fbSv = this.fbS.v * fade(i, this.fbS.i, FB_KEEP, FB_VALID);

    /* --- 落环 --- */
    this.difR.push(dif); this.rsiR.push(this.rsi); this.obvHR.push(obvW);
    this.histR.push(hist); this.cR.push(close); this.hR.push(high); this.lR.push(low);
    this.e12R.push(this.e12); this.e26R.push(this.e26);

    /* --- ATR 归一量 --- */
    const okA = atr != null && atr > 0;
    const e12_5 = this.e12R.len >= 6 ? this.e12R.get(5) : this.e12;
    const e26_5 = this.e26R.len >= 6 ? this.e26R.get(5) : this.e26;
    const e26_10 = this.e26R.len >= 11 ? this.e26R.get(10) : this.e26;
    const slopeF = okA ? (this.e12 - e12_5) / atr : 0;
    const slopeS = okA ? (this.e26 - e26_5) / atr : 0;
    const slopeS10 = okA ? (this.e26 - e26_10) / atr : 0;
    const dev = okA ? (this.e12 - this.e26) / atr : 0;
    const histN = okA ? hist / atr : 0;
    const h1N = okA ? (hist - h1v) / atr : 0;
    const h2N = okA ? (hist - 2 * h1v + h2v) / atr : 0;
    const adx6 = this.adxR.len >= 7 ? this.adxR.get(6) : NaN;
    const adxSpd = (adx0 == null || !isFinite(adx6)) ? 0 : clampN((adx0 - adx6) / 6, -1, 1);
    let adxMax = NaN, atrMax = NaN;
    const LA = Math.min(24, this.adxR.len), LT = Math.min(24, this.atrR.len);
    for (let q = 0; q < LA; q++) { const a = this.adxR.get(q); if (isFinite(a) && (!(adxMax > -Infinity) || a > adxMax)) adxMax = a; }
    for (let q = 0; q < LT; q++) { const a = this.atrR.get(q); if (isFinite(a) && (!(atrMax > -Infinity) || a > atrMax)) atrMax = a; }
    const rsi4 = this.rsiR.len >= 5 ? this.rsiR.get(4) : this.rsi;
    const rng = high - low;
    const lowShadow = rng > 0 ? (Math.min(open, close) - low) / rng : 0;
    const upShadow = rng > 0 ? (high - Math.max(open, close)) / rng : 0;

    /* --- 快照 --- */
    o.i = i; o.atr = atr || 0; o.close = close; o.high = high; o.low = low; o.vol = vol;
    o.e12 = this.e12; o.e26 = this.e26; o.dev = dev; o.slopeF = slopeF; o.slopeS = slopeS; o.slopeS10 = slopeS10;
    o.dif = dif; o.dea = this.dea; o.hist = hist; o.histN = histN; o.h1N = h1N; o.h2N = h2N;
    o.adx = adx0; o.diP = diPv; o.diM = diMv; o.adxSpd = adxSpd;
    o.adxMax = isFinite(adxMax) ? adxMax : null; o.atrMax = isFinite(atrMax) ? atrMax : null;
    o.rsi = this.rsi; o.rsiSlope = (this.rsi - rsi4) / 4;
    o.k = this.k; o.d = Dv; o.dun = this.dun; o.dunDir = this.dunDir;
    o.runLen = this.runLen; o.runDir = this.runDir; o.wasExtreme = this.wasExtreme;
    o.mid = mid; o.sd = sd; o.up = up; o.lo = lo; o.z = z; o.bwRank = bwRank;
    o.obvW = obvW; o.rvol = rvol;
    o.hiC = isFinite(hiC) ? hiC : null; o.hiR = isFinite(hiR) ? hiR : null;
    o.hiD = isFinite(hiD) ? hiD : null; o.hiO = isFinite(hiO) ? hiO : null;
    o.loC = isFinite(loC) ? loC : null; o.loR = isFinite(loR) ? loR : null;
    o.loD = isFinite(loD) ? loD : null; o.loO = isFinite(loO) ? loO : null;
    o.falseDn = falseDn; o.falseUp = falseUp;
    o.HH = HH; o.HL = HL; o.LH = LH; o.LL = LL;
    o.hlFresh = hlFresh; o.lhFresh = lhFresh;
    o.dvB = dvB; o.dvS = dvS; o.fbBv = fbBv; o.fbSv = fbSv;
    o.phP = this.phI >= 0 ? this.phP : null; o.plP = this.plI >= 0 ? this.plP : null;
    o.plT = this.plT; o.phT = this.phT;
    o.lowShadow = lowShadow; o.upShadow = upShadow;
    this.prevHigh = high; this.prevLow = low; this.prevClose = close;
    return o;
  };

  function vCopy(x) {
    const out = {};
    for (const k in x) out[k] = x[k];
    return out;
  }

  /* ============================================================
     第 3 节 · 1H Primary Trend（20 分）
     EMA 6 / MACD 4 / ADX 3 / RSI 2 / Market Structure 5
     ============================================================ */
  function scoreTrend(x) {
    const okA = x.atr > 0;
    const mUp = clamp01(Math.min(x.slopeF, x.slopeS) / 0.6);
    const mDn = clamp01(Math.min(-x.slopeF, -x.slopeS) / 0.6);
    /* EMA Trend 0-6（多空各自按自己的方向取斜率，否则空头侧的幅度项恒为 0） */
    const emaUp = x.e12 > x.e26 && x.slopeF > 0 && x.slopeS > 0;
    const emaDn = x.e12 < x.e26 && x.slopeF < 0 && x.slopeS < 0;
    const emaL = emaUp ? 3 + 3 * mUp : (x.e12 > x.e26 && x.slopeF > 0 ? 2 * clamp01(x.slopeF / 0.6) : 0);
    const emaS = emaDn ? 3 + 3 * mDn : (x.e12 < x.e26 && x.slopeF < 0 ? 2 * clamp01(-x.slopeF / 0.6) : 0);
    /* MACD Direction 0-4 */
    const macUp = x.dif > x.dea && x.h1N > 0;
    const macDn = x.dif < x.dea && x.h1N < 0;
    const macdL = macUp ? 2 + 2 * clamp01(x.h1N / 0.06) : (x.dif > x.dea ? 1 : 0);
    const macdS = macDn ? 2 + 2 * clamp01(-x.h1N / 0.06) : (x.dif < x.dea ? 1 : 0);
    /* ADX Quality 0-3（下降时降低趋势分） */
    const adxOkL = x.adx != null && x.adx >= 25 && x.diP > x.diM;
    const adxOkS = x.adx != null && x.adx >= 25 && x.diM > x.diP;
    const dec = x.adxSpd < 0 ? 0.6 : 1;
    const adxL = adxOkL ? clampN((1.5 + 1.5 * clamp01((x.adx - 25) / 20)) * dec, 0, 3) : 0;
    const adxS = adxOkS ? clampN((1.5 + 1.5 * clamp01((x.adx - 25) / 20)) * dec, 0, 3) : 0;
    /* RSI Zone 0-2 */
    const rsiL = x.rsi > 50 ? 1 + clamp01((x.rsi - 50) / 25) : (x.rsi > 45 ? 0.4 : 0);
    const rsiS = x.rsi < 50 ? 1 + clamp01((50 - x.rsi) / 25) : (x.rsi < 55 ? 0.4 : 0);
    /* Market Structure 0-5 */
    let msL = (x.HH ? 2 : 0) + (x.HL ? 2 : 0);
    let msS = (x.LH ? 2 : 0) + (x.LL ? 2 : 0);
    if (x.HH && x.HL) msL += 1; else if (msL > 0) msL += 0.5;
    if (x.LH && x.LL) msS += 1; else if (msS > 0) msS += 0.5;
    msL = clampN(msL, 0, 5); msS = clampN(msS, 0, 5);
    const at = okA;   // ATR 未就绪时分数自然趋 0（各分项已含归一化）
    const L = at ? clampN(emaL + macdL + adxL + rsiL + msL, 0, 20) : 0;
    const Sp = at ? clampN(emaS + macdS + adxS + rsiS + msS, 0, 20) : 0;
    return {
      long: L, short: Sp,
      ema: emaL, emaS: emaS, macd: macdL, macdS: macdS,
      adx: adxL, adxS: adxS, rsi: rsiL, rsiS: rsiS, ms: msL, msS: msS,
    };
  }

  /* ============================================================
     第 4 节 · 30m Transition（25 分）
     「原趋势是否正在失去优势」——不要求已反转。
     多头分 = 空头衰竭程度；空头分 = 多头衰竭程度。
     ============================================================ */
  function scoreTransition(x) {
    const okA = x.atr > 0;
    /* ① MACD Histogram 一阶变化 0-5 */
    let h1L = 0, h1S = 0;
    if (x.hist < 0 && x.h1N > 0) h1L = 2.5 + 2.5 * clamp01(x.h1N / 0.06);
    else if (x.hist > 0) h1L = 2.5;                       // 已转正：过渡完成，但不算衰竭
    if (x.hist > 0 && x.h1N < 0) h1S = 2.5 + 2.5 * clamp01(-x.h1N / 0.06);
    else if (x.hist < 0) h1S = 2.5;
    /* ② MACD Acceleration（二阶变化）0-4 */
    const acL = x.h2N > 0 ? 4 * clamp01(0.25 + x.h2N / 0.05) : 0;
    const acS = x.h2N < 0 ? 4 * clamp01(0.25 + (-x.h2N) / 0.05) : 0;
    /* ③ ADX Decay 0-4 */
    const adxDec = (x.adxMax != null && x.adx != null) ? (x.adxMax - x.adx) : 0;
    const decL = (x.adxMax != null && x.adxMax > 22 && adxDec > 1.5) ? 4 * clamp01(adxDec / 9) : 0;
    const decS = decL;                                     // ADX 衰减本身无方向，双向都算衰竭
    /* ④ RSI / KDJ 脱离钝化 0-3 */
    let exL = 0, exS = 0;
    if (x.rsi < 32 && x.rsiSlope > 0) exL = 3;
    else if (x.rsi < 40 && x.rsiSlope > 0) exL = 1.5;
    if (x.runLen >= 3 && x.runDir < 0 && x.d > KDJ_LO) exL = Math.max(exL, 2.5);
    if (x.rsi > 68 && x.rsiSlope < 0) exS = 3;
    else if (x.rsi > 60 && x.rsiSlope < 0) exS = 1.5;
    if (x.runLen >= 3 && x.runDir > 0 && x.d < KDJ_HI) exS = Math.max(exS, 2.5);
    /* ⑤ Volume Climax 0-3（极端放量后价格不再有效创新低/高） */
    const noNewLo = !(x.loC != null && x.close < x.loC);
    const noNewHi = !(x.hiC != null && x.close > x.hiC);
    const vcRaw = x.rvol >= 2.5 ? 1 : clamp01((x.rvol - 1.5) / 1.0);
    const vcL = vcRaw * (noNewLo ? 3 : 1.2);
    const vcS = vcRaw * (noNewHi ? 3 : 1.2);
    /* ⑥ OBV 背离 0-3（pivot 口径，带有效期） */
    const obvL = 3 * clamp01(x.dvB ? x.dvB.o / 5 : 0);
    const obvS = 3 * clamp01(x.dvS ? x.dvS.o / 5 : 0);
    /* ⑦ ATR / 波动衰竭 0-3 */
    let atL = 0, atS = 0;
    if (x.atrMax != null && x.atr != null && x.atrMax > 0) {
      const con = 1 - x.atr / x.atrMax;
      if (con > 0.10) { atL = 3 * clamp01(con / 0.30); atS = atL; }
    }
    if (x.lowShadow > 0.40) atL = clampN(atL + 1, 0, 3);   // 长下影 / 拒绝增多
    if (x.upShadow > 0.40) atS = clampN(atS + 1, 0, 3);

    const L = okA ? clampN(h1L + acL + decL + exL + vcL + obvL + atL, 0, 25) : 0;
    const Sp = okA ? clampN(h1S + acS + decS + exS + vcS + obvS + atS, 0, 25) : 0;

    /* 七状态机 */
    const bull = x.e12 > x.e26 && x.dif > x.dea;
    const bear = x.e12 < x.e26 && x.dif < x.dea;
    const strong = x.adx != null && x.adx > 30 && x.adxSpd > 0;
    let state;
    if (bear) state = strong ? ST.STRONG_BEAR : (L >= 12 ? ST.BEAR_EXH : ST.BEAR);
    else if (bull) state = strong ? ST.STRONG_BULL : (Sp >= 12 ? ST.BULL_EXH : ST.BULL);
    else state = ST.TRANSITION;

    return {
      long: L, short: Sp, state: state,
      h1: h1L, h1S: h1S, ac: acL, acS: acS, dec: decL, decS: decS,
      ex: exL, exS: exS, vc: vcL, vcS: vcS, obv: obvL, obvS: obvS, atr: atL, atrS: atS,
    };
  }

  /* ============================================================
     第 5 节 · 15m Reversal Setup（30 分）
     多头分 = Bottom Setup；空头分 = Top Setup。
     ============================================================ */
  function scoreSetup(x) {
    const okA = x.atr > 0;
    const dvB = x.dvB || { r: 0, m: 0, o: 0, f: 0 };
    const dvS = x.dvS || { r: 0, m: 0, o: 0, f: 0 };
    /* ① RSI Divergence 0-5（pivot 口径：价格 LL 而 RSI 不确认） */
    const rsiL = clampN(dvB.r, 0, 5);
    const rsiS = clampN(dvS.r, 0, 5);
    /* ② MACD Divergence 0-5 */
    const macL = clampN(dvB.m, 0, 5);
    const macS = clampN(dvS.m, 0, 5);
    /* ③ Histogram Acceleration 0-4 */
    const acL = x.hist < 0 && x.h1N > 0 ? 4 * clamp01(0.25 + x.h1N / 0.05)
      : (x.hist > 0 && x.h1N > 0 ? 2 : 0);
    const acS = x.hist > 0 && x.h1N < 0 ? 4 * clamp01(0.25 + (-x.h1N) / 0.05)
      : (x.hist < 0 && x.h1N < 0 ? 2 : 0);
    /* ④ OBV / CVD Divergence 0-5 */
    const obvL = clampN(dvB.o, 0, 5);
    const obvS = clampN(dvS.o, 0, 5);
    /* ⑤ False Breakdown / Breakout 0-4（带有效期） */
    const fbL = clampN(x.fbBv || 0, 0, 4);
    const fbS = clampN(x.fbSv || 0, 0, 4);
    /* ⑥ HL / LH 雏形 0-3（新鲜度 12 根内） */
    const hlL = (x.HL && x.hlFresh) ? 3 : (x.HL ? 1.5 : 0);
    const lhS = (x.LH && x.lhFresh) ? 3 : (x.LH ? 1.5 : 0);
    /* ⑦ VWAP / BOLL Extreme 0-2 */
    const bxL = x.z != null ? (x.z <= -2 ? 2 : x.z <= -1.5 ? 1 : 0) : 0;
    const bxS = x.z != null ? (x.z >= 2 ? 2 : x.z >= 1.5 ? 1 : 0) : 0;
    /* ⑧ Volume Climax 0-2 */
    const vcL = (x.rvol >= 2.2 && x.lowShadow > 0.35) ? 2 : (x.rvol >= 2.2 ? 1 : 0);
    const vcS = (x.rvol >= 2.2 && x.upShadow > 0.35) ? 2 : (x.rvol >= 2.2 ? 1 : 0);

    const L = okA ? clampN(rsiL + macL + acL + obvL + fbL + hlL + bxL + vcL, 0, 30) : 0;
    const Sp = okA ? clampN(rsiS + macS + acS + obvS + fbS + lhS + bxS + vcS, 0, 30) : 0;
    return {
      long: L, short: Sp,
      rsi: rsiL, rsiS: rsiS, mac: macL, macS: macS, ac: acL, acS: acS,
      obv: obvL, obvS: obvS, fb: fbL, fbS: fbS, hl: hlL, hlS: lhS,
      bx: bxL, bxS: bxS, vc: vcL, vcS: vcS,
    };
  }

  /* ============================================================
     第 2 节 · 4H Macro Regime（不计分，只改门槛）
     ============================================================ */
  function macroRegime(x) {
    const upStruct = (x.HH ? 1 : 0) + (x.HL ? 1 : 0);
    const dnStruct = (x.LH ? 1 : 0) + (x.LL ? 1 : 0);
    if (x.slopeS10 > 0.25 && upStruct >= 1 && upStruct >= dnStruct) return REG.BULL;
    if (x.slopeS10 < -0.25 && dnStruct >= 1 && dnStruct >= upStruct) return REG.BEAR;
    return REG.RANGE;
  }

  /* ============================================================
     逐根跑一遍 → 只保留打分数组（不存快照，省内存）
     ============================================================ */
  function tfScores(s) {
    const n = s.n, st = new VStream();
    const tL = new Float32Array(n), tS = new Float32Array(n);
    const rL = new Float32Array(n), rS = new Float32Array(n);
    const stt = new Int8Array(n);
    const uL = new Float32Array(n), uS = new Float32Array(n);
    const reg = new Int8Array(n);
    let last = null;
    for (let i = 0; i < n; i++) {
      const x = st.push(s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]);
      const a = scoreTrend(x), b = scoreTransition(x), c = scoreSetup(x);
      tL[i] = a.long; tS[i] = a.short;
      rL[i] = b.long; rS[i] = b.short; stt[i] = b.state;
      uL[i] = c.long; uS[i] = c.short;
      reg[i] = macroRegime(x);
      last = x;
    }
    return { n: n, tL: tL, tS: tS, rL: rL, rS: rS, stt: stt, uL: uL, uS: uS, reg: reg, last: last };
  }
  /* 只看最后一根（实盘面板用） */
  function tfLast(s) {
    const n = s.n, st = new VStream();
    let x = null, a = null, b = null, c = null, rg = 0;
    for (let i = 0; i < n; i++) {
      x = st.push(s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]);
      a = scoreTrend(x); b = scoreTransition(x); c = scoreSetup(x); rg = macroRegime(x);
    }
    return { x: vCopy(x || {}), trend: a, trans: b, setup: c, reg: rg };
  }

  /* ============================================================
     第 7 / 8 / 13 节 · 100 分总评 + Long / Short Gate
     ============================================================ */
  function thresholdFor(reg, dir) {
    if (reg === REG.RANGE) return TH_RANGE;
    return (reg === dir) ? TH_WITH : TH_AGAINST;
  }

  /* 单点判定。p 为各层取值（已按回测/实盘口径取好索引） */
  function decideAt(p, opt) {
    opt = opt || {};
    const chain = opt.chain || 'gate';        // gate(v2.1 §13) | choch | choch-rt | full
    const chaseATR = opt.chaseATR == null ? CHASE_ATR : opt.chaseATR;
    const longScore = p.tL + p.rL + p.uL + p.trigL;
    const shortScore = p.tS + p.rS + p.uS + p.trigS;
    let lThr = thresholdFor(p.reg, 1);
    let sThr = thresholdFor(p.reg, -1);
    if (opt.thrOverride != null) { lThr = opt.thrOverride; sThr = opt.thrOverride; }   // 阈值扫描用
    if (opt.thrAdj) { lThr += opt.thrAdj; sThr += opt.thrAdj; }
    const lCt = p.reg === REG.BEAR;           // 逆 4H 做多
    const sCt = p.reg === REG.BULL;
    const lSetupMin = lCt ? SETUP_MIN_CT : SETUP_MIN;
    const sSetupMin = sCt ? SETUP_MIN_CT : SETUP_MIN;

    /* 5m 结构链（bit0 CHOCH / bit1 Retest / bit2 BOS） */
    const lC = (p.lsf & 1) > 0, lR = (p.lsf & 2) > 0, lB = (p.lsf & 4) > 0;
    const sC = (p.ssf & 1) > 0, sR = (p.ssf & 2) > 0, sB = (p.ssf & 4) > 0;
    const lChain = chain === 'choch' ? lC
      : chain === 'choch-rt' ? (lC && lR)
        : chain === 'full' ? (lC && lR && lB)
          : (lC && (lR || lB));
    const sChain = chain === 'choch' ? sC
      : chain === 'choch-rt' ? (sC && sR)
        : chain === 'full' ? (sC && sR && sB)
          : (sC && (sR || sB));

    const g = {
      setup: p.uL >= lSetupMin,
      chain: lChain,
      notStrong: p.st1 !== ST.STRONG_BEAR,
      needExh: (p.st1 !== ST.BEAR) || (p.st30 === ST.BEAR_EXH || p.st30 === ST.TRANSITION),
      noChase: !(p.lLvl > 0 && p.atr5 > 0 && Math.abs(p.c5 - p.lLvl) > chaseATR * p.atr5),
    };
    const gs = {
      setup: p.uS >= sSetupMin,
      chain: sChain,
      notStrong: p.st1 !== ST.STRONG_BULL,
      needExh: (p.st1 !== ST.BULL) || (p.st30 === ST.BULL_EXH || p.st30 === ST.TRANSITION),
      noChase: !(p.sLvl > 0 && p.atr5 > 0 && Math.abs(p.c5 - p.sLvl) > chaseATR * p.atr5),
    };
    const longGate = g.setup && g.chain && g.notStrong && g.needExh && g.noChase;
    const shortGate = gs.setup && gs.chain && gs.notStrong && gs.needExh && gs.noChase;
    const long = longGate && longScore >= lThr;
    const short = shortGate && shortScore >= sThr;
    return {
      long: long, short: short,
      longScore: longScore, shortScore: shortScore,
      lThr: lThr, sThr: sThr,
      lGate: longGate, sGate: shortGate,
      g: g, gs: gs,
      lCt: lCt, sCt: sCt,
      lSetupMin: lSetupMin, sSetupMin: sSetupMin,
    };
  }

  /* ============================================================
     构建：聚合成 15m / 30m / 1H / 4H，跑四层评分 + 5m 结构
     opt.live=true → 实盘口径（粗周期用「进行中」那一根）
            false → 回测口径（只用已收线那一根，无未来函数）
     ============================================================ */
  function build(s5, opt) {
    opt = opt || {};
    const C = opt.cache || null;
    const T = opt.tfs || {};      /* 实盘面板可传入各周期真实 K线（样本比从 5m 聚合更长） */
    const s15 = C ? C.s15 : (T.s15 || aggregate(s5, TF_SEC['15m']));
    const s30 = C ? C.s30 : (T.s30 || aggregate(s5, TF_SEC['30m']));
    const s1h = C ? C.s1h : (T.s1h || aggregate(s5, TF_SEC['1h']));
    const s4h = C ? C.s4h : (T.s4h || aggregate(s5, TF_SEC['4h']));
    const v15 = C ? C.v15 : tfScores(s15);
    const v30 = C ? C.v30 : tfScores(s30);
    const v1h = C ? C.v1h : tfScores(s1h);
    const v4h = C ? C.v4h : tfScores(s4h);
    const ms = C ? C.ms : msSeries(s5);
    const m15 = opt.live ? buildMap(s5.t, s15.t) : buildClosedMap(s5.t, s15.t, TF_SEC['5m'], TF_SEC['15m']);
    const m30 = opt.live ? buildMap(s5.t, s30.t) : buildClosedMap(s5.t, s30.t, TF_SEC['5m'], TF_SEC['30m']);
    const m1h = opt.live ? buildMap(s5.t, s1h.t) : buildClosedMap(s5.t, s1h.t, TF_SEC['5m'], TF_SEC['1h']);
    const m4h = opt.live ? buildMap(s5.t, s4h.t) : buildClosedMap(s5.t, s4h.t, TF_SEC['5m'], TF_SEC['4h']);
    return {
      s15: s15, s30: s30, s1h: s1h, s4h: s4h,
      v15: v15, v30: v30, v1h: v1h, v4h: v4h, ms: ms,
      m15: m15, m30: m30, m1h: m1h, m4h: m4h,
      live: !!opt.live,
    };
  }

  /* 找信号：Gate + 分数门槛同时满足；用「由无到有」的跃变沿，一次结构只开一次 */
  function findSignals(s5, V, opt) {
    opt = opt || {};
    const out = [];
    let onL = false, onS = false;
    const P = {};
    for (let i = 1; i < s5.n; i++) {
      const j15 = V.m15[i], j30 = V.m30[i], j1h = V.m1h[i], j4h = V.m4h[i];
      if (j15 < 0 || j30 < 0 || j1h < 0 || j4h < 0) { onL = false; onS = false; continue; }
      P.tL = V.v1h.tL[j1h]; P.tS = V.v1h.tS[j1h];
      P.rL = V.v30.rL[j30]; P.rS = V.v30.rS[j30];
      P.st1 = V.v1h.stt[j1h]; P.st30 = V.v30.stt[j30];
      P.uL = V.v15.uL[j15]; P.uS = V.v15.uS[j15];
      P.reg = V.v4h.reg[j4h];
      P.trigL = V.ms.lsc[i]; P.trigS = V.ms.ssc[i];
      P.lsf = V.ms.lsf[i]; P.ssf = V.ms.ssf[i];
      P.lLvl = V.ms.llv[i]; P.sLvl = V.ms.slv[i];
      P.c5 = s5.c[i]; P.atr5 = V.ms.atr[i];
      const d = decideAt(P, opt);
      if (d.long && !onL) {
        out.push({
          i: i, dir: 'long', score: d.longScore, thr: d.lThr, reg: P.reg,
          st1: P.st1, st30: P.st30, setup: P.uL, trig: P.trigL,
          t: P.tL, r: P.rL, u: P.uL, chain: P.lsf,
        });
      }
      if (d.short && !onS) {
        out.push({
          i: i, dir: 'short', score: d.shortScore, thr: d.sThr, reg: P.reg,
          st1: P.st1, st30: P.st30, setup: P.uS, trig: P.trigS,
          t: P.tS, r: P.rS, u: P.uS, chain: P.ssf,
        });
      }
      onL = d.long; onS = d.short;
    }
    return out;
  }

  /* 实盘：给一段 5m K线数组，直接算「当前」这一根的判定 */
  function decideNow(candles, opt) {
    opt = opt || {};
    const n = candles.length;
    const s5 = toSeries(candles.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    })));
    const V = build(s5, { live: true, cache: opt.cache, tfs: opt.tfs });
    const i = n - 1;
    const ms = msReplay(candles);
    const j15 = V.m15[i], j30 = V.m30[i], j1h = V.m1h[i], j4h = V.m4h[i];
    if (j15 < 0 || j30 < 0 || j1h < 0 || j4h < 0) return null;
    const P = {
      tL: V.v1h.tL[j1h], tS: V.v1h.tS[j1h],
      rL: V.v30.rL[j30], rS: V.v30.rS[j30],
      st1: V.v1h.stt[j1h], st30: V.v30.stt[j30],
      uL: V.v15.uL[j15], uS: V.v15.uS[j15],
      reg: V.v4h.reg[j4h],
      trigL: ms.lsc[i], trigS: ms.ssc[i],
      lsf: ms.lsf[i], ssf: ms.ssf[i],
      lLvl: ms.llv[i], sLvl: ms.slv[i],
      c5: s5.c[i], atr5: ms.atr[i],
    };
    const d = decideAt(P, opt);
    const msSnap = msCopy(ms.last || {});
    return {
      i: i, d: d, P: P, reg: P.reg, regName: REG_NAME[P.reg],
      st1: P.st1, st1Name: ST_NAME[P.st1], st30: P.st30, st30Name: ST_NAME[P.st30],
      v15: tfLast(V.s15), v30: tfLast(V.s30), v1h: tfLast(V.s1h), v4h: tfLast(V.s4h),
      ms: msSnap, atr5: P.atr5, c5: P.c5,
      V: V, s5: s5,
    };
  }

  /* ============================================================
     模拟（含 MAE / MFE，供第 14 条统计）
     ============================================================ */
  function simulate(s5, trig, V, opt) {
    opt = opt || {};
    const tpslFn = opt.tpslFn || defaultTpsl;
    const maxHold = opt.maxHold || 2016;
    const trades = [];
    let skipped = 0;
    for (let k = 0; k < trig.length; k++) {
      const tg = trig[k];
      if (tg.i + 1 >= s5.n) { skipped++; continue; }
      const entry = s5.o[tg.i + 1];
      if (!(entry > 0)) { skipped++; continue; }
      const j1h = V.m1h[tg.i];
      if (j1h < 30) { skipped++; continue; }
      const plan = tpslFn(tailObjects(V.s1h, j1h, 300), '1h', s5.c[tg.i]);
      if (!plan) { skipped++; continue; }
      const side = tg.dir === 'long' ? plan.long : plan.short;
      if (!side || !(side.risk > 0)) { skipped++; continue; }
      const stop = side.stop, tp1 = side.tp1, tp2 = side.tp2;
      const dirSign = tg.dir === 'long' ? 1 : -1;

      let exitPx = null, how = '', holdT = 0, done1 = false, r1 = 0;
      let mae = 0, mfe = 0;
      for (let j = tg.i + 1; j < s5.n && j <= tg.i + maxHold; j++) {
        const hi = s5.h[j], lo = s5.l[j];
        const adv = dirSign > 0 ? (lo - entry) : (entry - hi);
        const fav = dirSign > 0 ? (hi - entry) : (entry - lo);
        if (-adv > mae) mae = -adv;
        if (fav > mfe) mfe = fav;
        const hitStop = dirSign > 0 ? (lo <= stop) : (hi >= stop);
        const hitTp1 = dirSign > 0 ? (hi >= tp1) : (lo <= tp1);
        const hitTp2 = dirSign > 0 ? (hi >= tp2) : (lo <= tp2);
        if (hitStop) { exitPx = dirSign > 0 ? Math.min(stop, s5.o[j]) : Math.max(stop, s5.o[j]); how = done1 ? '止损（半仓）' : '止损'; holdT = j - tg.i - 1; break; }
        if (!done1 && hitTp1) { done1 = true; r1 = tp1; }
        if (done1 && hitTp2) { exitPx = tp2; how = '止盈二'; holdT = j - tg.i - 1; break; }
        if (j === Math.min(s5.n - 1, tg.i + maxHold)) { exitPx = s5.c[j]; how = '超时平仓'; holdT = j - tg.i - 1; break; }
      }
      if (exitPx == null) { skipped++; continue; }

      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) { skipped++; continue; }
      let gross, fee;
      if (how === '止损') {
        gross = (exitPx - entry) * dirSign;
        fee = (entry + exitPx) * FEE_RATE;
      } else {
        gross = 0.5 * (r1 - entry) * dirSign + 0.5 * (exitPx - entry) * dirSign;
        fee = entry * FEE_RATE + 0.5 * r1 * FEE_RATE + 0.5 * exitPx * FEE_RATE;
        if (how === '超时平仓') { gross = (exitPx - entry) * dirSign; fee = (entry + exitPx) * FEE_RATE; }
      }
      const net = gross - fee;
      trades.push({
        i: tg.i, time: s5.t[tg.i + 1], dir: tg.dir, entry: entry, stop: stop, tp1: tp1, tp2: tp2,
        exit: exitPx, how: how, hold: holdT, risk: risk,
        pnl: net, r: net / risk, grossR: gross / risk, feeR: fee / risk,
        win: net > 0, maeR: mae / risk, mfeR: mfe / risk,
        score: tg.score || 0, thr: tg.thr || 0, reg: tg.reg == null ? 0 : tg.reg,
        st1: tg.st1 == null ? 0 : tg.st1, st30: tg.st30 == null ? 0 : tg.st30,
        setup: tg.setup || 0, trig: tg.trig || 0, chain: tg.chain || 0,
      });
    }
    return { trades: trades, skipped: skipped };
  }

  /* 第 14 条要求的统计量 */
  function stats(trades, s5) {
    const n = trades.length;
    const wins = trades.filter(t => t.win).length;
    const sum = (f) => trades.reduce((a, t) => a + f(t), 0);
    const totalR = sum(t => t.r), grossR = sum(t => t.grossR), feeR = sum(t => t.feeR);
    const gw = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    const mean = n ? totalR / n : 0;
    const sd = n > 1 ? Math.sqrt(sum(t => (t.r - mean) * (t.r - mean)) / (n - 1)) : 0;
    const se = n > 1 ? sd / Math.sqrt(n) : 0;
    const t = se > 0 ? mean / se : 0;
    /* 权益曲线（固定风险法：每笔风险 = 权益 2%） */
    let eq = 10000, peak = 10000, maxDD = 0, cons = 0, maxCons = 0;
    for (let i = 0; i < n; i++) {
      eq *= (1 + 0.02 * trades[i].r);
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd;
      if (trades[i].win) cons = 0; else { cons++; if (cons > maxCons) maxCons = cons; }
    }
    const spanDays = s5.n > 1 ? (s5.t[s5.n - 1] - s5.t[0]) / 86400 : 0;
    const years = spanDays / 365;
    return {
      count: n, wins: wins, losses: n - wins,
      winRate: n ? wins / n : 0,
      totalR: totalR, avgR: mean, sd: sd, se: se, t: t,
      grossAvg: n ? grossR / n : 0, feeAvg: n ? feeR / n : 0,
      profitFactor: gl < 0 ? gw / Math.abs(gl) : (gw > 0 ? Infinity : 0),
      expectancy: mean,
      maxDD: maxDD, maxConsLoss: maxCons,
      avgHoldBars: n ? sum(t => t.hold) / n : 0,
      avgHoldHours: n ? sum(t => t.hold) / n * 5 / 60 : 0,
      avgMaeR: n ? sum(t => t.maeR) / n : 0,
      avgMfeR: n ? sum(t => t.mfeR) / n : 0,
      finalEq: eq, annRet: years > 0 ? Math.pow(eq / 10000, 1 / years) - 1 : 0,
      years: years, spanDays: spanDays,
      perDay: spanDays > 0 ? n / spanDays : 0,
    };
  }

  /* 按 4H 环境分组（第 14 条第二阶段） */
  function byRegime(trades) {
    const g = { with: [], range: [], against: [] };
    trades.forEach(t => {
      if (t.dir === 'long') g[t.reg === 1 ? 'with' : t.reg === 0 ? 'range' : 'against'].push(t);
      else g[t.reg === -1 ? 'with' : t.reg === 0 ? 'range' : 'against'].push(t);
    });
    return g;
  }

  /* 时效性：v2.1 信号相对旧信号提前多少根 5m（第 14 条重点指标） */
  function leadStats(newTrig, oldTrig, winBars) {
    winBars = winBars || 96;                 // 8 小时内视为「同一波」
    let hit = 0, leadSum = 0;
    for (let k = 0; k < oldTrig.length; k++) {
      const o = oldTrig[k];
      let best = -1;
      for (let m = 0; m < newTrig.length; m++) {
        const q = newTrig[m];
        if (q.dir !== o.dir) continue;
        const d = o.i - q.i;
        if (d >= 0 && d <= winBars) { if (best < 0 || d < best) best = d; }
        if (q.i > o.i) break;
      }
      if (best >= 0) { hit++; leadSum += best; }
    }
    return {
      oldCount: oldTrig.length, covered: hit,
      coverRate: oldTrig.length ? hit / oldTrig.length : 0,
      avgLeadBars: hit ? leadSum / hit : 0,
      avgLeadMin: hit ? leadSum / hit * 5 : 0,
    };
  }

  /* 假信号比例：CHOCH → Retest → BOS 各段失败率（第 14 条重点指标） */
  function chainStats(ms, maxWait) {
    maxWait = maxWait || S.MS_RETEST_MAX + 6;
    const n = ms.n;
    let choch = 0, toRetest = 0, toBos = 0;
    let chochS = 0, toRetestS = 0, toBosS = 0;
    let pend = -1, pendS = -1, gotR = false, gotRS = false;
    for (let i = 1; i < n; i++) {
      const cL = (ms.lsf[i] & 1) > 0, pL = (ms.lsf[i - 1] & 1) > 0;
      const cS = (ms.ssf[i] & 1) > 0, pS = (ms.ssf[i - 1] & 1) > 0;
      if (cL && !pL) { choch++; if (pend < 0) { pend = i; gotR = false; } }
      if (pend >= 0) {
        if (!gotR && (ms.lsf[i] & 2) > 0) { toRetest++; gotR = true; }
        if ((ms.lsf[i] & 4) > 0) { toBos++; pend = -1; }
        else if (i - pend > maxWait) pend = -1;
      }
      if (cS && !pS) { chochS++; if (pendS < 0) { pendS = i; gotRS = false; } }
      if (pendS >= 0) {
        if (!gotRS && (ms.ssf[i] & 2) > 0) { toRetestS++; gotRS = true; }
        if ((ms.ssf[i] & 4) > 0) { toBosS++; pendS = -1; }
        else if (i - pendS > maxWait) pendS = -1;
      }
    }
    const C = choch + chochS, R = toRetest + toRetestS, B = toBos + toBosS;
    return {
      choch: C, retest: R, bos: B,
      retestFail: C ? 1 - R / C : 0,
      bosFail: R ? 1 - B / R : 0,
      chochBosFail: C ? 1 - B / C : 0,
      perDay: 0,
    };
  }

  return {
    VStream: VStream, Ring: Ring, SumRing: SumRing,
    TF_SEC: TF_SEC, ST: ST, ST_NAME: ST_NAME, REG: REG, REG_NAME: REG_NAME,
    TH_WITH: TH_WITH, TH_RANGE: TH_RANGE, TH_AGAINST: TH_AGAINST,
    SETUP_MIN: SETUP_MIN, SETUP_MIN_CT: SETUP_MIN_CT, CHASE_ATR: CHASE_ATR,
    scoreTrend: scoreTrend, scoreTransition: scoreTransition, scoreSetup: scoreSetup,
    macroRegime: macroRegime,
    tfScores: tfScores, tfLast: tfLast,
    thresholdFor: thresholdFor, decideAt: decideAt,
    build: build, findSignals: findSignals, decideNow: decideNow,
    simulate: simulate, stats: stats, byRegime: byRegime,
    leadStats: leadStats, chainStats: chainStats,
    vCopy: vCopy, msReplay: msReplay, msCopy: msCopy,
  };
});
