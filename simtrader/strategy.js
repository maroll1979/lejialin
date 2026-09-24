/* ============================================================
   strategy.js · 开单逻辑与回测引擎
   ------------------------------------------------------------
   开单逻辑（用户定义）：
     1h  → 判定大方向（long / short / wait）
     15m / 5m → 共振入场：两者必须同时与 1h 同向，
                且至少一个「刚刚」从 观望/反向 翻转过来（严格共振沿）
                翻转那一刻触发一次买入/卖出报警，之后不再重复
   回测：5 年真实 5m K线 → 聚合 15m/1h → 三周期信号序列
         → 共振沿入场 → 看板同款止盈止损出场 → 统计
   ============================================================ */
(function (global) {
  'use strict';

  const GATE = 'https://api.gateio.ws';
  const BINANCE = 'https://data-api.binance.vision';
  const FUT_PAIR = {
    BTCUSDT: 'BTC_USDT', ETHUSDT: 'ETH_USDT', BNBUSDT: 'BNB_USDT',
    XAUUSDT: 'XAU_USDT', PAXGUSDT: 'PAXG_USDT',
  };
  /* 回测用的现货源：Gate 永续免费接口有「最近 10000 根」硬上限（5m 只够约 35 天），
     做不了 5 年；币安现货 RESTful 无 Key、无此限制，5m 数据可回溯到 2017 年。
     XAU 在币安没有现货对，用同为「1 金衡盎司黄金」的 PAXG 代替（口径需在界面标注）。 */
  const SPOT_PAIR = {
    BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', BNBUSDT: 'BNBUSDT',
    XAUUSDT: 'PAXGUSDT', PAXGUSDT: 'PAXGUSDT',
  };
  const SRC_NAME = { binance: '币安现货', gate: 'Gate.io 永续' };
  /* 各源单次请求根数上限：Gate 单段 2000、全局仅最近 10000；币安现货单段 1000、无全局上限 */
  const SRC_LIMIT = { binance: 1000, gate: 2000 };
  const GATE_MAX_POINTS = 10000;
  const TF_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  /* 八因子权重（与 app.js SIG_W 逐字一致，和为 1.00） */
  const SIG_W = { trend: 0.15, macd: 0.14, adx: 0.13, rsi: 0.11, kdj: 0.10, boll: 0.10, obv: 0.13, vol: 0.14 };
  /* 与看板实盘窗口保持一致：app.js 的 runSignals → ensureCandles → fetchKlines(sym, tf, 200)，
     即 computeSignal 拿到的是最近 200 根 K 线。OBV 在其中是「从窗口第一根开始累加」的，
     不是全历史累加 —— 回测若不窗口化，OBV 会累积成天文数字使 obvV 因子失真、与实盘口径不一致。
     EMA/RSI/KDJ/BOLL 则相反：它们有记忆衰减，200 根后「全历史累积」与「200 根窗口重算」等价，
     故这些因子直接全程累积（一致性由 tests/test-strategy.js 逐根对照量化）。 */
  const OBV_WIN = 200;
  const FEE_RATE = 0.001;      // 市价 Taker 费率（与 app.js FEE_TAKER 一致）

  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* EMA20 首项权重 (19/21)^(N−1)：递推公式里的常数 */
  const W0 = Math.pow(19 / 21, OBV_WIN - 1);

  /* 直接按真实公式重算 obvEma 与加权和 S。
     只在窗口未满（前 199 根）与刚满那一根调用，成本 O(n²) 但总量仅约 4 万次。 */
  function recalcObv(st) {
    const n = st.bN, k = 2 / 21;
    const volA = st.vb[st.bHead], pdA = st.pb[st.bHead];
    let prev = volA;                                   // ov[0] = volA + P[a] − P[a] = volA
    let S = 0;
    const w0 = Math.pow(19 / 21, n - 1);
    for (let p = 0; p < n; p++) {
      const idx = (st.bHead + p) % OBV_WIN;
      const ovp = volA + st.pb[idx] - pdA;
      if (p > 0) prev = ovp * k + prev * (1 - k);
      S += (p === 0 ? w0 : k * Math.pow(19 / 21, n - 1 - p)) * st.pb[idx];
    }
    st.S = S;
    return prev;
  }

  /* 定长环缓冲：get(k) 取「第 k 新」的值（k=0 → 最近 push 的那根） */
  function Ring(n) { this.n = n; this.a = new Float64Array(n); this.c = 0; this.len = 0; }
  Ring.prototype.push = function (v) { this.a[this.c] = v; this.c = (this.c + 1) % this.n; if (this.len < this.n) this.len++; };
  Ring.prototype.get = function (k) {
    if (k < 0 || k >= this.len) return NaN;
    return this.a[(this.c - 1 - k + this.n * 2) % this.n];
  };

  /* ============================================================
     流式信号引擎 —— 与 app.js computeSignal 的「八因子」公式严格一致，
     但改成 O(1)/O(小窗口) 增量，用于对几十万根 K 线逐根求方向。
     因子口径见 app.js 顶部注释（斜率 / 一阶二阶 / 带宽分位 / z-score /
     钝化时长 / RVOL / 结构位放量），全部以 Wilder ATR(14) 归一。
     一致性由 tests/test-strategy.js 与逐点重算逐根对照验证。
     ============================================================ */
  const KDJ_HI = 75, KDJ_LO = 25;
  const SIG_LOOK = { div: 30, struct: 20, rvol: 120 };
  const WS_P = 14;                                     // Wilder 周期（ATR / DI / ADX 共用）

  function SignalStream() { this.reset(); }

  SignalStream.prototype.reset = function () {
    this.n = 0;
    this.e9 = null; this.e21 = null; this.e12 = null; this.e26 = null; this.dea = null;
    this.prevHist = null; this.prevClose = null;
    this.prevHigh = null; this.prevLow = null;
    /* 注意：KDJ 的 D 必须叫 kdd，不能叫 pd —— pd 已被 OBV 前缀和占用，
       两者同名会互相覆盖（表现为第 9 根起 OBV 突然失真）。 */
    this.pk = 50; this.kdd = 50; this.prevK = null; this.prevD = null;
    this.ag = 0; this.al = 0; this.rsiVal = null;
    this.buf = [];                                   // BOLL 最近 20 根收盘
    this.hbuf = []; this.lbuf = [];                  // KDJ 最近 9 根高低
    /* OBV：实盘语义是「取最近 200 根，重算整条 ov 序列，再对其取 EMA20 / 判背离」。
       窗口每滑动一根，整条 ov 序列都要重算 —— 只累加单个当前值是复现不了的
       （实测 obvEma 会差出几十万，obvV 因子偏差 0.13）。
       这里用「全局前缀和 P + EMA 加权和递推」精确复现：
         ov_p = vol[a] + (P[a+p] − P[a])，a 为窗口首根
         S_i  = Σ_p w'_p·P[a+p]，w'_0=(19/21)^199，w'_p=(2/21)(19/21)^(199−p)
         S_i+1 = (19/21)·[S_i + w'_0·delta_{i−198}] + (2/21)·P[i+1]     ← O(1) 递推
         obvEma = vol[a] + S_i − P[a]
       背离 / 新高新低确认需要窗口内最近 30 根的 ov，也按同一公式现算（O(30)）。 */
    this.obv = 0; this.obvEma = null;
    this.vb = new Float64Array(OBV_WIN);             // 窗口内 volume
    this.cb = new Float64Array(OBV_WIN);             // 窗口内 close
    this.pb = new Float64Array(OBV_WIN);             // 窗口内 prefixD
    this.bN = 0; this.bHead = 0; this.pd = 0; this.S = 0;
    /* Wilder TR/DM/ATR/ADX(14) —— 与 app.js wilderSeries 同式 */
    this.tSum = 0; this.pSum = 0; this.mSum = 0;
    this.adxV = null; this.dxSum = 0; this.dxCn = 0;
    /* 因子窗口环 */
    this.e9r = new Ring(6); this.e21r = new Ring(6);
    this.histR = new Ring(3); this.difR = new Ring(31);
    this.rsiR = new Ring(31); this.adxR = new Ring(7);
    this.bwR = new Ring(120);                        // 带宽历史（算分位用）
    this.hR = new Ring(20); this.lR = new Ring(20);  // 结构位
    this.vR = new Ring(120); this.vSum = 0; this.vN = 0;   // RVOL 基准
    this.curUp = null; this.curLo = null;            // 上一根的布林上下轨
    /* KDJ 钝化状态机（与 app.js kdjReplay 同义） */
    this.dun = 0; this.dunDir = 0; this.wasExtreme = false; this.runLen = 0; this.runDir = 0;
    this.dir = 'wait'; this.prevDir = 'wait'; this.score = 0; this.raw = 0; this.clear = false;
  };

  /* 本轮 close 已落 OBV 环：winClose(0)=本根，winClose(k)=前 k 根 */
  SignalStream.prototype.winClose = function (k) {
    return this.cb[(this.bHead + this.bN - 1 - k + OBV_WIN * 2) % OBV_WIN];
  };
  /* 本轮 ov（窗口口径的 OBV）序列：ovAt(0)=本根 */
  SignalStream.prototype.ovAt = function (k) {
    const volA = this.vb[this.bHead], pdA = this.pb[this.bHead];
    return volA + this.pb[(this.bHead + this.bN - 1 - k + OBV_WIN * 2) % OBV_WIN] - pdA;
  };

  /* 喂入一根 K 线，返回当根信号 {dir, score, raw, clear} */
  SignalStream.prototype.push = function (open, high, low, close, volume) {
    const i = this.n++;
    const vol = volume || 0;

    /* --- EMA（与 app.js ema() 同初始化：首根取自身） --- */
    this.e9 = this.e9 == null ? close : close * (2 / 10) + this.e9 * (8 / 10);
    this.e21 = this.e21 == null ? close : close * (2 / 22) + this.e21 * (20 / 22);
    this.e12 = this.e12 == null ? close : close * (2 / 13) + this.e12 * (11 / 13);
    this.e26 = this.e26 == null ? close : close * (2 / 27) + this.e26 * (25 / 27);

    /* --- Wilder TR / DM / ATR / ADX（与 app.js wilderSeries 逐字同式） --- */
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
    this.adxR.push(adx0 == null ? NaN : adx0);
    this.prevHigh = high; this.prevLow = low;

    /* --- MACD --- */
    const dif = this.e12 - this.e26;
    this.dea = this.dea == null ? dif : dif * (2 / 10) + this.dea * (8 / 10);
    const hist = dif - this.dea;
    this.difR.push(dif);
    this.histR.push(hist);

    /* --- OBV 环：必须先落环，后面的量价因子与背离都要读它 --- */
    let delta = 0;
    if (i > 0) { if (close > this.prevClose) delta = vol; else if (close < this.prevClose) delta = -vol; }
    this.pd += delta;                                  // 全局前缀和 P[i]
    const volA0 = this.vb[this.bHead], pdA0 = this.pb[this.bHead];
    if (this.bN >= OBV_WIN) {
      const idx1 = (this.bHead + 1) % OBV_WIN;
      const dA1 = this.pb[idx1] - pdA0;                // delta_{i−198}，须在覆盖前取
      this.vb[this.bHead] = vol; this.cb[this.bHead] = close; this.pb[this.bHead] = this.pd;
      this.bHead = idx1;
      this.S = (19 / 21) * (this.S + W0 * dA1) + (2 / 21) * this.pd;
    } else {
      this.vb[this.bN] = vol; this.cb[this.bN] = close; this.pb[this.bN] = this.pd;
      this.bN++;
    }
    const volA = this.vb[this.bHead], pdA = this.pb[this.bHead];
    this.obv = volA + this.pd - pdA;
    /* 窗口未满、或刚满（此时需初始化递推用的 S）→ 按真实公式重算；之后走 O(1) 递推 */
    this.obvEma = (this.bN < OBV_WIN || this.S === 0) ? recalcObv(this) : volA + this.S - pdA;

    const okA = A != null && A > 0;

    /* ① 趋势因子 · EMA —— 斜率 + 快慢线距离变化 + 价格与 EMA 偏离 */
    this.e9r.push(this.e9); this.e21r.push(this.e21);
    const k5 = Math.min(5, i);
    const e9_5 = this.e9r.get(k5), e21_5 = this.e21r.get(k5);
    const devA = okA ? (this.e9 - this.e21) / A : 0;
    const devA5 = okA ? (e9_5 - e21_5) / A : 0;
    const slopeA = okA ? (this.e9 - e9_5) / A : 0;
    const pDevA = okA ? (close - this.e21) / A : 0;
    const trend = clampN(0.34 * clampN(slopeA / 1.6, -1, 1)
      + 0.24 * clampN(devA / 2.0, -1, 1)
      + 0.18 * clampN((devA - devA5) / 0.8, -1, 1)
      + 0.24 * clampN(pDevA / 2.0, -1, 1), -1, 1);

    /* ② 动能因子 · MACD —— Histogram 值 + 一阶变化 + 二阶加速度 + 背离 */
    const h1v = i >= 1 ? this.histR.get(1) : 0;
    const h2v = i >= 2 ? this.histR.get(2) : 0;
    const hvN = okA ? hist / A : 0;
    const h1N = okA ? (hist - h1v) / A : 0;
    const h2N = okA ? (hist - 2 * h1v + h2v) / A : 0;
    /* 窗口内 close（OBV 环）与 DIF 环上的背离 */
    let bHiC = -Infinity, bHiO = -Infinity, bLoC = Infinity, bLoO = Infinity;
    for (let q = 1; q <= SIG_LOOK.div; q++) {
      if (q >= this.bN || q >= this.difR.len) break;
      const cq = this.winClose(q), dq = this.difR.get(q);
      if (cq > bHiC) bHiC = cq;
      if (dq > bHiO) bHiO = dq;
      if (cq < bLoC) bLoC = cq;
      if (dq < bLoO) bLoO = dq;
    }
    const mdvg = (close > bHiC && dif < bHiO) ? -1 : (close < bLoC && dif > bLoO) ? 1 : 0;
    const macdV = clampN(0.45 * clampN(hvN / 0.6, -1, 1)
      + 0.22 * clampN(h1N / 0.12, -1, 1)
      + 0.15 * clampN(h2N / 0.10, -1, 1)
      + 0.30 * mdvg, -1, 1);

    /* ③ 趋向因子 · ADX —— 绝对强度（连续映射，非阈值）+ 连续上升/下降速度 */
    const adx6v = this.adxR.len >= 7 ? this.adxR.get(6) : NaN;
    const adxStr = adx0 == null ? 0 : clampN((adx0 - 12) / 28, 0, 1);
    const adxSpd = (adx0 == null || !isFinite(adx6v)) ? 0 : clampN((adx0 - adx6v) / 6, -1, 1);
    const adxDir = diPv == null ? 0 : (diPv > diMv ? 1 : diPv < diMv ? -1 : 0);
    const adxV = clampN(adxDir * adxStr * (0.62 + 0.19 * (adxSpd + 1)), -1, 1);

    /* ④ 摆动因子 · KDJ(9,3,3) —— 只取 K/D/J 值，完全不看金叉/死叉 */
    this.hbuf.push(high); this.lbuf.push(low);
    if (this.hbuf.length > 9) { this.hbuf.shift(); this.lbuf.shift(); }
    let K = null, D = null, J = null;
    if (this.hbuf.length === 9) {
      let hh = -Infinity, ll = Infinity;
      for (let x = 0; x < 9; x++) {
        if (this.hbuf[x] > hh) hh = this.hbuf[x];
        if (this.lbuf[x] < ll) ll = this.lbuf[x];
      }
      const rsv = hh === ll ? 50 : (close - ll) / (hh - ll) * 100;
      this.pk = (2 / 3) * this.pk + rsv / 3;
      this.kdd = (2 / 3) * this.kdd + this.pk / 3;
      K = this.pk; D = this.kdd; J = 3 * this.pk - 2 * this.kdd;
    }
    /* 钝化状态机：打分要用「含当前根的连续钝化根数」与「上一根是否在极端区」 */
    const prevInZone = this.wasExtreme, prevDun = this.dun, prevDunDir = this.dunDir;
    let dunNow = this.dun, dunDirNow = this.dunDir, runLenNow = this.runLen, runDirNow = this.runDir;
    let kdjV = 0, kdjTxt = '常态区';
    if (D != null) {
      const inZone = D > KDJ_HI || D < KDJ_LO;
      const d0 = D > KDJ_HI ? 1 : -1;
      if (inZone) { if (dunDirNow === d0) dunNow++; else { dunDirNow = d0; dunNow = 1; } }
      else { if (dunDirNow !== 0) { runLenNow = dunNow; runDirNow = dunDirNow; } dunNow = 0; dunDirNow = 0; }
      if (inZone && dunNow >= 5) {
        kdjV = dunDirNow * Math.min(1, 0.15 + (dunNow - 4) / 8) * 0.85;      // 钝化 = 趋势未竭 → 顺势
        kdjTxt = (dunDirNow > 0 ? '超买' : '超卖') + '钝化 ' + dunNow + ' 根（趋势未竭）';
      } else if (!inZone && prevInZone && prevDun >= 3) {
        kdjV = -prevDunDir * Math.min(0.9, 0.45 + prevDun * 0.05);           // 刚脱离极端区 → 反向
        kdjTxt = '脱离' + (prevDunDir > 0 ? '超买' : '超卖') + '区（钝化 ' + prevDun + ' 根后衰竭）';
      } else if (inZone) {
        kdjTxt = (dunDirNow > 0 ? '超买' : '超卖') + '钝化 ' + dunNow + ' 根（未成势）';
      }
      this.wasExtreme = inZone; this.dun = dunNow; this.dunDir = dunDirNow;
      this.runLen = runLenNow; this.runDir = runDirNow;
    }
    this.prevK = K; this.prevD = D;

    /* ⑤ 摆动因子 · RSI(14) Wilder 平滑 —— 区域 + 斜率 + 背离 + 脱离极端区
       （i<14 时 r[i] 为 null → 取 50，与 app.js `r[i] ?? 50` 一致） */
    let rv = 50;
    if (i > 0) {
      const ch = close - this.prevClose;
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= 14) {
        this.ag += g / 14; this.al += l / 14;
        if (i === 14) this.rsiVal = this.al === 0 ? 100 : 100 - 100 / (1 + this.ag / this.al);
      } else {
        this.ag = (this.ag * 13 + g) / 14; this.al = (this.al * 13 + l) / 14;
        this.rsiVal = this.al === 0 ? 100 : 100 - 100 / (1 + this.ag / this.al);
      }
      if (this.rsiVal != null) rv = this.rsiVal;
    }
    const rsiZone = clampN((rv - 50) / 28, -1, 1);
    const rv4 = this.rsiR.len >= 4 ? this.rsiR.get(3) : rv;      // rsi[i−4]
    const rsiSlope = clampN((rv - rv4) / 4 / 2.5, -1, 1);
    let rMin = Infinity, rMax = -Infinity;
    for (let k = 0; k < 6; k++) {
      if (k >= this.rsiR.len) break;
      const v = this.rsiR.get(k);
      if (v < rMin) rMin = v;
      if (v > rMax) rMax = v;
    }
    let rHiP = -Infinity, rHiR = -Infinity, rLoP = Infinity, rLoR = Infinity;
    for (let q = 1; q <= SIG_LOOK.div; q++) {
      if (q - 1 >= this.rsiR.len || q >= this.bN) break;
      const pq = this.winClose(q), iq = this.rsiR.get(q - 1);
      if (pq > rHiP) rHiP = pq;
      if (iq > rHiR) rHiR = iq;
      if (pq < rLoP) rLoP = pq;
      if (iq < rLoR) rLoR = iq;
    }
    const rdvg = (close > rHiP && rv < rHiR) ? -1 : (close < rLoP && rv > rLoR) ? 1 : 0;
    const rsiExit = (rMin < 30 && rv >= 32) ? 1 : (rMax > 70 && rv <= 68) ? -1 : 0;
    const rsiV = clampN(0.25 * rsiZone + 0.25 * rsiSlope + 0.25 * rdvg + 0.25 * rsiExit, -1, 1);
    this.rsiR.push(rv);

    /* ⑥ 通道因子 · BOLL(20,2) —— Band Width 分位 + z-score + 假突破后回归 */
    this.buf.push(close); if (this.buf.length > 20) this.buf.shift();
    let bollV = 0, z = null, sd = null, up = null, lo = null, mid = null, bwRank = null, fbrk = 0;
    if (this.buf.length === 20) {
      let s = 0; for (let x = 0; x < 20; x++) s += this.buf[x];
      mid = s / 20;
      let ss = 0; for (let x = 0; x < 20; x++) { const d = this.buf[x] - mid; ss += d * d; }
      sd = Math.sqrt(ss / 20);
      up = mid + 2 * sd; lo = mid - 2 * sd;
      if (mid > 0) {
        const bw = (up - lo) / mid;
        this.bwR.push(bw);
        let cnt = 0;
        for (let x = 0; x < this.bwR.len; x++) if (this.bwR.a[x] <= bw) cnt++;
        bwRank = this.bwR.len > 0 ? cnt / this.bwR.len : null;
      }
      if (sd > 0) {
        z = (close - mid) / sd;
        let v = -clampN(z / 2.4, -1, 1) * 0.55;                  // z-score 均值回归
        /* 带宽分位调制：极度收口（变盘临近）时回归不可靠 → 打折；开口扩张 → 放大 */
        if (bwRank != null) v *= (bwRank < 0.2 ? 0.70 : bwRank > 0.8 ? 1.12 : 1);
        /* 假突破后回归：当根破轨收回，或上一根收在轨外而本根收回 → 强反向 */
        const falseUp = (high > up && close < up) || (this.curUp != null && this.prevClose > this.curUp && close < up);
        const falseDn = (low < lo && close > lo) || (this.curLo != null && this.prevClose < this.curLo && close > lo);
        if (falseUp) { v = -0.9; fbrk = -1; }
        else if (falseDn) { v = 0.9; fbrk = 1; }
        bollV = clampN(v, -1, 1);
      }
    }
    this.curUp = up; this.curLo = lo;

    /* ⑦ 量价因子 · OBV —— 是否确认价格新高/新低（不看绝对数值） */
    let hiC = -Infinity, hiO = -Infinity, loC = Infinity, loO = Infinity;
    for (let q = 1; q <= SIG_LOOK.div; q++) {
      if (q >= this.bN) break;
      const cq = this.winClose(q), oq = this.ovAt(q);
      if (cq > hiC) hiC = cq;
      if (oq > hiO) hiO = oq;
      if (cq < loC) loC = cq;
      if (oq < loO) loO = oq;
    }
    const newHi = close > hiC, newLo = close < loC;
    let obvV = 0, obvTxt = '无新高/新低（弱参考）', obvState = 0;
    if (newHi && this.obv >= hiO) { obvV = 1; obvState = 1; obvTxt = '量价同步新高（确认）'; }
    else if (newHi && this.obv < hiO) { obvV = -0.8; obvState = 1; obvTxt = '价新高但 OBV 未确认（顶背离）'; }
    else if (newLo && this.obv <= loO) { obvV = -1; obvState = -1; obvTxt = '量价同步新低（确认）'; }
    else if (newLo && this.obv > loO) { obvV = 0.8; obvState = -1; obvTxt = '价新低但 OBV 未确认（底背离）'; }
    else obvV = clampN((this.obv - this.obvEma) / (Math.abs(this.obvEma) + 1e-9) * 2, -0.35, 0.35);
    const dvg = (newHi && this.obv < hiO) ? -1 : (newLo && this.obv > loO) ? 1 : 0;
    const rel = (this.obv - this.obvEma) / (Math.abs(this.obvEma) + 1e-9);

    /* ⑧ 量能因子 · Volume —— RVOL + climax + 结构位放量（不看简单放量） */
    const rvol = (this.vN > 0 && this.vSum > 0) ? vol / (this.vSum / this.vN) : 1;
    let sHi = -Infinity, sLo = Infinity;
    for (let k = 0; k < SIG_LOOK.struct; k++) {
      if (k >= this.hR.len) break;
      const hq = this.hR.get(k), lq = this.lR.get(k);
      if (hq > sHi) sHi = hq;
      if (lq < sLo) sLo = lq;
    }
    const rng = high - low;
    const barPos = rng > 0 ? (close - low) / rng : 0.5;
    const nearHi = isFinite(sHi) && high >= sHi;
    const nearLo = isFinite(sLo) && low <= sLo;
    let volV = 0, volTxt = '常态量';
    if (rvol >= 1.4 && nearHi) { volV = 0.85; volTxt = '结构位放量向上突破'; }
    else if (rvol >= 1.4 && nearLo) { volV = -0.85; volTxt = '结构位放量向下破位'; }
    else if (rvol >= 3 && barPos < 0.34) { volV = 0.60; volTxt = '抛售高潮（量能尖峰＋收在下沿）'; }
    else if (rvol >= 3 && barPos > 0.66) { volV = -0.60; volTxt = '买入高潮（量能尖峰＋收在上沿）'; }
    else if (rvol >= 1.4) volTxt = '放量但不在结构位（不给方向）';
    else if (rvol < 0.6) volTxt = '缩量';

    /* --- 合成与两道闸门（与 app.js computeSignal 完全一致） --- */
    const raw = trend * SIG_W.trend + macdV * SIG_W.macd + adxV * SIG_W.adx + rsiV * SIG_W.rsi
      + kdjV * SIG_W.kdj + bollV * SIG_W.boll + obvV * SIG_W.obv + volV * SIG_W.vol;
    const strength = Math.max(Math.abs(trend), Math.abs(macdV), Math.abs(adxV), Math.abs(rsiV),
      Math.abs(kdjV), Math.abs(bollV), Math.abs(obvV), Math.abs(volV));
    const trendLocked = Math.abs(devA) >= 0.30;
    const th = trendLocked ? 0.20 : 0.32;
    let clear = strength >= 0.5 && Math.abs(raw) >= th;
    let score = clear ? raw : raw * 0.5;
    let rawOut = raw;
    let dir = clear ? (raw >= th ? 'long' : raw <= -th ? 'short' : 'wait') : 'wait';
    /* 预热期（与 app.js 的 60 根下限一致）不产生方向，避免回测开头出现假信号 */
    if (i < 59) { clear = false; score = 0; rawOut = 0; dir = 'wait'; }

    this.prevClose = close; this.prevHist = hist;
    this.hR.push(high); this.lR.push(low);
    if (this.vR.len >= SIG_LOOK.rvol) this.vSum -= this.vR.get(SIG_LOOK.rvol - 1);
    this.vR.push(vol); this.vSum += vol; this.vN = this.vR.len;
    this.prevDir = this.dir; this.dir = dir; this.score = score; this.raw = rawOut; this.clear = clear;
    /* 因子明细（供 tests 逐因子对照使用，开销可忽略） */
    this.f = {
      trend: trend, macd: macdV, adx: adxV, rsi: rsiV, kdj: kdjV, boll: bollV, obv: obvV, vol: volV,
      th: th, rv: rv, dif: dif, dea: this.dea, hist: hist,
      obvRaw: this.obv, obvEma: this.obvEma, dvg: dvg, rel: rel,
      adxRaw: adx0, diP: diPv, diM: diMv, rvol: rvol, z: z, atr: A, devA: devA,
    };
    return { dir: dir, score: score, raw: rawOut, clear: clear, f: this.f };
  };

  /* 对整段序列跑流式，返回方向数组（Uint8Array：0=wait 1=long 2=short）与分数数组 */
  function dirSeries(s) {
    const n = s.n, st = new SignalStream();
    const dirs = new Uint8Array(n), scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = st.push(s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]);
      dirs[i] = r.dir === 'long' ? 1 : r.dir === 'short' ? 2 : 0;
      scores[i] = r.score;
    }
    return { dirs: dirs, scores: scores };
  }

  /* ============================================================
     列式序列工具（省内存：5 年 5m 约 52 万根）
     ============================================================ */
  function toSeries(rows) {
    const n = rows.length;
    const s = { n: n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      s.t[i] = r.time; s.o[i] = r.open; s.h[i] = r.high; s.l[i] = r.low; s.c[i] = r.close; s.v[i] = r.volume || 0;
    }
    return s;
  }
  /* 由细粒度聚合出粗粒度（5m → 15m / 1h），按自然时间对齐 */
  function aggregate(src, sec) {
    const rows = [];
    let cur = -1;
    for (let i = 0; i < src.n; i++) {
      const t = Math.floor(src.t[i] / sec) * sec;
      if (t !== cur) {
        cur = t;
        rows.push({ time: t, open: src.o[i], high: src.h[i], low: src.l[i], close: src.c[i], volume: src.v[i] });
      } else {
        const k = rows.length - 1;
        if (src.h[i] > rows[k].high) rows[k].high = src.h[i];
        if (src.l[i] < rows[k].low) rows[k].low = src.l[i];
        rows[k].close = src.c[i];
        rows[k].volume += src.v[i];
      }
    }
    return toSeries(rows);
  }
  /* 取末尾 len 根，转成 app.js 习惯的对象数组（喂给 tpSlPlan / computeSignal） */
  function tailObjects(s, endIdx, len) {
    const from = Math.max(0, endIdx - len + 1), out = [];
    for (let i = from; i <= endIdx; i++) {
      out.push({ time: s.t[i], open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i], volume: s.v[i] });
    }
    return out;
  }
  /* 基序列索引 → 粗周期序列索引（取 <= 基时间的最后一根）
     注意：得到的是「包含该 5m 的那一根」，它可能尚未走完 ——
     实盘看板用的就是这根（时效优先），但回测用它会有未来函数，
     回测必须改用下面的 buildClosedMap。 */
  function buildMap(baseT, tfT) {
    const m = new Int32Array(baseT.length);
    let j = -1;
    for (let i = 0; i < baseT.length; i++) {
      while (j + 1 < tfT.length && tfT[j + 1] <= baseT[i]) j++;
      m[i] = j;
    }
    return m;
  }
  /* 基序列索引 → 「截至该 5m 收盘时已完整收线」的粗周期序列索引。
     5m 收盘时刻 = t + baseSec；粗周期收线时刻 = tfT[j] + tfSec。
     若 5m 收盘 >= 粗周期收线，则这根粗 K 线已经走完，可用；否则只能用上一根。
     这是回测唯一无未来函数的取法。 */
  function buildClosedMap(baseT, tfT, baseSec, tfSec) {
    const m = new Int32Array(baseT.length);
    let j = -1;
    for (let i = 0; i < baseT.length; i++) {
      while (j + 1 < tfT.length && tfT[j + 1] <= baseT[i]) j++;
      if (j < 0) { m[i] = -1; continue; }
      m[i] = (baseT[i] + baseSec >= tfT[j] + tfSec) ? j : j - 1;
    }
    return m;
  }
  /* 时间对齐到周期起点 */
  function alignTime(t, tf) { const sec = TF_SEC[tf] || 300; return Math.floor(t / sec) * sec; }

  /* ============================================================
     共振沿触发检测
     dirs: 0=wait 1=long 2=short
     ============================================================ */
  const DIR_NAME = ['wait', 'long', 'short'];

  /* 单点判定：给三周期「当前 / 上一根」方向，返回是否触发 */
  function triggerAt(d1h, d15, d5, p1h, p15, p5) {
    if (d1h === 0) return 0;                     // 1h 无方向 → 不开仓
    if (d15 !== d1h || d5 !== d1h) return 0;     // 15m / 5m 必须同时与 1h 同向
    const flip15 = (p15 !== d1h);                // 15m 刚从其他状态翻过来
    const flip5 = (p5 !== d1h);                  // 5m 刚从其他状态翻过来
    if (!flip15 && !flip5) return 0;             // 两者都早已同向 → 不是新触发（避免重复报警）
    return d1h === 1 ? 1 : 2;                    // 1=买入 2=卖出
  }

  /* 在已对齐的序列上批量找触发点（实盘口径：粗周期用「进行中」的那一根） */
  function findTriggers(d5, d15, d1h, m15, m1h) {
    const out = [];
    for (let i = 1; i < d5.length; i++) {
      const j15 = m15[i], j1h = m1h[i];
      if (j15 < 1 || j1h < 1) continue;
      const k = triggerAt(d1h[j1h], d15[j15], d5[i], d1h[j1h - 1], d15[j15 - 1], d5[i - 1]);
      if (k) out.push({ i: i, dir: k === 1 ? 'long' : 'short' });
    }
    return out;
  }
  /* 回测口径：粗周期只用「已收线」的那一根。
     由于已收线的 15m/1h 在整组内保持不变，若照搬 triggerAt 的「上一根」
     比较，同一组内的每根 5m 都会重复触发；故改为判定
     「三周期共振状态由未共振 → 共振」的跃变沿，一次共振只响一次。 */
  function findTriggersClosed(d5, d15, d1h, mc15, mc1h) {
    const out = [];
    let prev = false;
    for (let i = 1; i < d5.length; i++) {
      const j15 = mc15[i], j1h = mc1h[i];
      let on = false;
      if (j15 >= 0 && j1h >= 0) {
        const a = d1h[j1h];
        on = a !== 0 && d15[j15] === a && d5[i] === a;
      }
      if (on && !prev) out.push({ i: i, dir: d1h[mc1h[i]] === 1 ? 'long' : 'short' });
      prev = on;
    }
    return out;
  }

  /* ============================================================
     历史数据分页拉取
     两个数据源的约束（本机实测 2026-09）：
       Gate 永续  /api/v4/futures/usdt/candlesticks
         · limit 与 from/to 互斥，不能同时给
         · 单次返回上限 2000 根
         · **全局只保留最近 10000 根**：5m ≈ 35 天、15m ≈ 104 天、1h ≈ 416 天
           （超出报 INVALID_PARAM_VALUE "Candlestick too long ago"）
         → 只适合近端数据，做不了 5 年 5m
       Binance 现货 /api/v3/klines
         · startTime/endTime（毫秒）+ limit，单次上限 1000 根
         · 无全局回溯限制，BTC 5m 可到 2017-08
         → 5 年 5m（约 52.6 万根）唯一可行源
     ============================================================ */
  async function fetchSeg(contract, interval, from, to, timeout) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout || 15000) : null;
    try {
      const url = `${GATE}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&from=${from}&to=${to}`;
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error((j && j.message) || '返回格式异常');
      return j.map(a => ({ time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c, volume: +a.v }));
    } finally { if (timer) clearTimeout(timer); }
  }

  /* 币安现货 klines：返回 [openTimeMs, o, h, l, c, v, closeTimeMs, ...] */
  async function fetchBnSeg(symbol, interval, fromMs, toMs, timeout) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout || 15000) : null;
    try {
      const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${fromMs}&endTime=${toMs}&limit=1000`;
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error((j && j.msg) || '返回格式异常');
      return j.map(a => ({
        time: Math.floor(a[0] / 1000), open: +a[1], high: +a[2], low: +a[3], close: +a[4], volume: +a[5],
      }));
    } finally { if (timer) clearTimeout(timer); }
  }

  async function poolMap(tasks, limit, onDone) {
    const out = new Array(tasks.length);
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        const i = idx++;
        try { out[i] = await tasks[i](); } catch (e) { out[i] = null; }
        if (onDone) onDone(i + 1, tasks.length);
      }
    }
    const n = Math.min(limit || 6, tasks.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return out;
  }

  /* 拉取 years 年的 interval K线（升序、去重）
     opt.src: 'binance'（默认，现货，历史深）| 'gate'（永续，仅最近 10000 根） */
  async function fetchHistory(sym, interval, years, opt) {
    opt = opt || {};
    const sec = TF_SEC[interval];
    if (!sec) throw new Error('不支持的周期：' + interval);
    const src = opt.src || 'binance';
    const nowSec = Math.floor(Date.now() / 1000);
    const to = Math.floor(nowSec / sec) * sec;
    const per = SRC_LIMIT[src] || 1000;
    let from = to - Math.round(years * 365 * 24 * 3600);
    let market, capped = false;

    if (src === 'gate') {
      /* Gate 只能给最近 10000 根，超出部分必然失败 —— 直接截断，别白跑几百个请求 */
      const maxSpan = GATE_MAX_POINTS * sec;
      if (to - from > maxSpan) { from = to - maxSpan; capped = true; }
      market = FUT_PAIR[sym];
      if (!market) throw new Error('无 Gate 永续合约：' + sym);
    } else {
      market = SPOT_PAIR[sym];
      if (!market) throw new Error('币安现货无对应交易对：' + sym);
    }

    const segSec = per * sec;
    const segs = [];
    for (let t = from; t < to; t += segSec) segs.push([t, Math.min(t + segSec - 1, to)]);

    let done = 0;
    const parts = await poolMap(segs.map(([a, b]) => async () => {
      /* 失败重试 2 次，避免偶发网络抖动让整轮回退 */
      for (let k = 0; k < 3; k++) {
        try {
          return src === 'gate'
            ? await fetchSeg(market, interval, a, b, 15000)
            : await fetchBnSeg(market, interval, a * 1000, b * 1000 + 999, 15000);
        } catch (e) { if (k === 2) return null; await new Promise(r => setTimeout(r, 400 * (k + 1))); }
      }
      return null;
    }), opt.concurrency || (src === 'gate' ? 6 : 8), () => { done++; if (opt.onProgress) opt.onProgress(done / segs.length); });

    const map = new Map();
    let failed = 0;
    parts.forEach(p => {
      if (!p) { failed++; return; }
      p.forEach(r => { if (r.time > 0 && r.close > 0) map.set(r.time, r); });
    });
    const rows = Array.from(map.values()).sort((x, y) => x.time - y.time);
    return {
      rows: rows, series: toSeries(rows), segTotal: segs.length, segFailed: failed,
      from: from, to: to, src: src, srcName: SRC_NAME[src], market: market,
      capped: capped, cappedDays: GATE_MAX_POINTS * sec / 86400,
    };
  }

  /* ============================================================
     回测
     tpslFn(candles, tf, price) → 看板的 tpSlPlan（保证与实盘口径一致）
     ============================================================ */
  function defaultTpsl(candles, tf, price) {
    /* 兜底：仅在 app.js 未注入 tpSlPlan 时使用（ATR 止损 + 2R/3.2R 止盈） */
    const closes = candles.map(c => c.close);
    const px = price || closes[closes.length - 1];
    let a = 0;
    for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      a += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    a /= 13;
    if (!(a > 0)) return null;
    const risk = 1.8 * a;
    return {
      dir: 'long', px: px, atr: a,
      long: { stop: px - risk, risk: risk, tp1: px + risk, tp2: px + 2 * risk },
      short: { stop: px + risk, risk: risk, tp1: px - risk, tp2: px - 2 * risk },
    };
  }

  function backtestCore(s5, opt) {
    const tpslFn = opt.tpslFn || defaultTpsl;
    const maxHold = opt.maxHold || 2016;          // 最多持仓 2016 根 5m（7 天），超时按市价平
    const onProgress = opt.onProgress || function () {};

    onProgress(0, '聚合 15m / 1h');
    const s15 = aggregate(s5, TF_SEC['15m']);
    const s1h = aggregate(s5, TF_SEC['1h']);

    onProgress(0.1, '计算三周期信号序列');
    const r5 = dirSeries(s5), r15 = dirSeries(s15), r1h = dirSeries(s1h);
    /* 回测必须用「已收线」映射：buildMap 给出的是包含当前 5m 的那根 15m/1h，
       它尚未走完，用它的 high/low/close 等于偷看未来（未来函数）。
       opt.live=true 可切回实盘口径做对照。 */
    const m15 = opt.live ? buildMap(s5.t, s15.t) : buildClosedMap(s5.t, s15.t, TF_SEC['5m'], TF_SEC['15m']);
    const m1h = opt.live ? buildMap(s5.t, s1h.t) : buildClosedMap(s5.t, s1h.t, TF_SEC['5m'], TF_SEC['1h']);

    onProgress(0.5, '寻找共振入场点');
    const trig = opt.live
      ? findTriggers(r5.dirs, r15.dirs, r1h.dirs, m15, m1h)
      : findTriggersClosed(r5.dirs, r15.dirs, r1h.dirs, m15, m1h);

    onProgress(0.6, '逐笔模拟出场');
    const trades = [];
    let skipped = 0;
    for (let k = 0; k < trig.length; k++) {
      const tg = trig[k];
      if (tg.i + 1 >= s5.n) { skipped++; continue; }         // 序列末尾，无从入场
      /* 入场价用触发后的下一根开盘价，避免用到「未来」那根的收盘价 */
      const entry = s5.o[tg.i + 1];
      if (!(entry > 0)) { skipped++; continue; }
      const j1h = m1h[tg.i];
      if (j1h < 30) { skipped++; continue; }             // 1h 样本不足，算不出止损止盈
      const plan = tpslFn(tailObjects(s1h, j1h, 300), '1h', s5.c[tg.i]);
      if (!plan) { skipped++; continue; }
      const side = tg.dir === 'long' ? plan.long : plan.short;
      if (!side || !(side.risk > 0)) { skipped++; continue; }
      const stop = side.stop, tp1 = side.tp1, tp2 = side.tp2;
      const dirSign = tg.dir === 'long' ? 1 : -1;

      /* 扫描后续 K 线：先到止损还是先到止盈（同一根同时触及 → 保守按止损） */
      let exitPx = null, how = '', holdT = 0, done1 = false, r1 = 0, r2 = 0;
      for (let j = tg.i + 1; j < s5.n && j <= tg.i + maxHold; j++) {
        const hi = s5.h[j], lo = s5.l[j];
        const hitStop = dirSign > 0 ? (lo <= stop) : (hi >= stop);
        const hitTp1 = dirSign > 0 ? (hi >= tp1) : (lo <= tp1);
        const hitTp2 = dirSign > 0 ? (hi >= tp2) : (lo <= tp2);
        if (hitStop) { exitPx = dirSign > 0 ? Math.min(stop, s5.o[j]) : Math.max(stop, s5.o[j]); how = done1 ? '止损（半仓）' : '止损'; holdT = j - tg.i - 1; break; }
        if (!done1 && hitTp1) { done1 = true; r1 = tp1; }
        if (done1 && hitTp2) { exitPx = tp2; how = '止盈二'; holdT = j - tg.i - 1; break; }
        if (j === Math.min(s5.n - 1, tg.i + maxHold)) {
          exitPx = s5.c[j]; how = '超时平仓'; holdT = j - tg.i - 1; break;
        }
      }
      if (exitPx == null) { skipped++; continue; }

      /* 收益（按 R 倍数，1R = 入场到止损的距离） */
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) { skipped++; continue; }
      let gross, fee;
      if (how === '止损') {
        gross = (exitPx - entry) * dirSign;
        fee = (entry + exitPx) * FEE_RATE;
      } else if (how === '止损（半仓）') {
        /* 已有一半在 tp1 止盈，剩余一半止损 */
        gross = 0.5 * (r1 - entry) * dirSign + 0.5 * (exitPx - entry) * dirSign;
        fee = entry * FEE_RATE + 0.5 * r1 * FEE_RATE + 0.5 * exitPx * FEE_RATE;
      } else if (how === '止盈二') {
        gross = 0.5 * (r1 - entry) * dirSign + 0.5 * (exitPx - entry) * dirSign;
        fee = entry * FEE_RATE + 0.5 * r1 * FEE_RATE + 0.5 * exitPx * FEE_RATE;
      } else {
        gross = (exitPx - entry) * dirSign;
        fee = (entry + exitPx) * FEE_RATE;
      }
      const net = gross - fee;
      trades.push({
        time: s5.t[tg.i + 1], dir: tg.dir, entry: entry, stop: stop, tp1: tp1, tp2: tp2,
        exit: exitPx, how: how, hold: holdT, risk: risk,
        pnl: net, r: net / risk,
        grossR: gross / risk, feeR: fee / risk,
        win: net > 0,
      });
      if (k % 200 === 0) onProgress(0.6 + 0.35 * k / Math.max(1, trig.length), '模拟第 ' + (k + 1) + ' / ' + trig.length + ' 笔');
    }

    onProgress(0.98, '统计');
    return summarize(trades, s5, trig.length, skipped);
  }

  function summarize(trades, s5, trigCount, skipped) {
    const n = trades.length;
    const wins = trades.filter(t => t.win).length;
    const losses = n - wins;
    const totalR = trades.reduce((a, t) => a + t.r, 0);
    /* 拆分「策略本身的钱」和「被手续费吃掉的钱」，便于判断亏损来源 */
    const grossR = trades.reduce((a, t) => a + (t.grossR || 0), 0);
    const feeR = trades.reduce((a, t) => a + (t.feeR || 0), 0);
    const avgFeeR = n ? feeR / n : 0;
    const grossWin = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const grossLoss = trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);

    /* 权益曲线：固定风险法 —— 每笔风险 = 当前权益的 2%，按 R 结算 */
    let eq = 10000, peak = 10000, maxDD = 0, ddStart = null, ddEnd = null;
    const curve = [];
    for (let i = 0; i < n; i++) {
      eq *= (1 + 0.02 * trades[i].r);
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > maxDD) { maxDD = dd; ddEnd = trades[i].time; }
      curve.push({ time: trades[i].time, eq: eq });
    }
    /* 最大回撤区间起点 */
    if (maxDD > 0 && curve.length) {
      let pk = 10000;
      for (let i = 0; i < curve.length; i++) {
        if (curve[i].eq > pk) { pk = curve[i].eq; ddStart = curve[i].time; }
      }
    }
    const spanDays = s5.n > 1 ? (s5.t[s5.n - 1] - s5.t[0]) / 86400 : 0;
    const years = spanDays / 365;
    const finalEq = curve.length ? curve[curve.length - 1].eq : 10000;
    const annRet = years > 0 ? Math.pow(finalEq / 10000, 1 / years) - 1 : 0;
    const avgHold = n ? trades.reduce((a, t) => a + t.hold, 0) / n : 0;
    const longs = trades.filter(t => t.dir === 'long');
    const shorts = trades.filter(t => t.dir === 'short');

    return {
      trades: trades, curve: curve,
      count: n, wins: wins, losses: losses,
      winRate: n ? wins / n : 0,
      totalR: totalR, avgR: n ? totalR / n : 0,
      grossR: grossR, feeR: feeR, avgFeeR: avgFeeR,
      avgRiskPct: n ? trades.reduce((a, t) => a + t.risk / t.entry, 0) / n : 0,
      profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? Infinity : 0),
      maxDD: maxDD, ddStart: ddStart, ddEnd: ddEnd,
      finalEq: finalEq, annRet: annRet,
      years: years, spanDays: spanDays,
      avgHoldBars: avgHold, avgHoldHours: avgHold * 5 / 60,
      longCount: longs.length, longWin: longs.filter(t => t.win).length,
      shortCount: shorts.length, shortWin: shorts.filter(t => t.win).length,
      trigCount: trigCount, skipped: skipped,
      bars: s5.n,
      from: s5.n ? s5.t[0] : null, to: s5.n ? s5.t[s5.n - 1] : null,
    };
  }

  async function backtest(sym, years, opt) {
    opt = opt || {};
    const onPhase = opt.onPhase || function () {};
    onPhase('fetch', 0, '拉取 ' + years + ' 年 5m K线（分段并发）');
    const h = await fetchHistory(sym, '5m', years, {
      src: opt.src || 'binance',
      onProgress: p => onPhase('fetch', p * 0.6, '拉取中 ' + Math.round(p * 100) + '%'),
    });
    if (!h.rows.length) throw new Error('未取到历史 K线');
    onPhase('calc', 0.6, '共 ' + h.rows.length + ' 根，开始计算');
    const res = backtestCore(h.series, {
      tpslFn: opt.tpslFn, maxHold: opt.maxHold, live: opt.live,
      onProgress: (p, txt) => onPhase('calc', 0.6 + 0.4 * p, txt),
    });
    res.live = !!opt.live;
    res.segTotal = h.segTotal; res.segFailed = h.segFailed;
    res.src = h.src; res.srcName = h.srcName; res.market = h.market;
    res.capped = h.capped; res.cappedDays = h.cappedDays;
    onPhase('done', 1, '完成');
    return res;
  }

  const api = {
    GATE: GATE, BINANCE: BINANCE, FUT_PAIR: FUT_PAIR, SPOT_PAIR: SPOT_PAIR,
    SRC_NAME: SRC_NAME, GATE_MAX_POINTS: GATE_MAX_POINTS,
    TF_SEC: TF_SEC, DIR_NAME: DIR_NAME,
    SignalStream: SignalStream,
    dirSeries: dirSeries,
    aggregate: aggregate,
    toSeries: toSeries,
    tailObjects: tailObjects,
    buildMap: buildMap,
    buildClosedMap: buildClosedMap,
    alignTime: alignTime,
    triggerAt: triggerAt,
    findTriggers: findTriggers,
    findTriggersClosed: findTriggersClosed,
    fetchSeg: fetchSeg,
    fetchBnSeg: fetchBnSeg,
    fetchHistory: fetchHistory,
    backtestCore: backtestCore,
    backtest: backtest,
    summarize: summarize,
    defaultTpsl: defaultTpsl,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Strategy = api;
})(typeof window !== 'undefined' ? window : globalThis);
