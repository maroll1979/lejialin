/* ============================================================
   SimTrader · 多品种模拟交易终端（模拟盘 · 仅手动下单）
   数据源：Gate.io USDT 永续行情 / 美国财政部国债收益率
   ============================================================ */

/* ---------- 交易平台（多平台实时比价）
   primary=true 的平台为「主源」：其价格参与限价单撮合、强平与盈亏计算；
   其余平台价格仅作参考比价，不参与任何成交判定。 */
const VENUES = [
  { key: 'gate',     name: 'Gate.io', cn: 'Gate·永续', primary: true },
  { key: 'okx',      name: 'OKX',      cn: '欧易' },
  { key: 'coinbase', name: 'Coinbase', cn: 'Coinbase' },
  { key: 'bitstamp', name: 'Bitstamp', cn: 'Bitstamp' },
];

/* ---------- 品种配置 ---------- */
const INSTRUMENTS = [
  { id: 'BTC',   name: '比特币 BTC/USDT', short: 'BTC',   sym: 'BTCUSDT',      type: 'crypto', dec: 2,  qtyStep: 0.0001,
    venues: { gate: 'BTCUSDT', okx: 'BTC-USDT', coinbase: 'BTC-USD', bitstamp: 'btcusdt' } },
  { id: 'ETH',   name: '以太坊 ETH/USDT', short: 'ETH',   sym: 'ETHUSDT',      type: 'crypto', dec: 2,  qtyStep: 0.001,
    venues: { gate: 'ETHUSDT', okx: 'ETH-USDT', coinbase: 'ETH-USD', bitstamp: 'ethusdt' } },
  { id: 'BNB',   name: '币安币 BNB/USDT', short: 'BNB',   sym: 'BNBUSDT',      type: 'crypto', dec: 2,  qtyStep: 0.01,
    venues: { gate: 'BNBUSDT', okx: 'BNB-USDT', coinbase: 'BNB-USD' } },
  /* 黄金用 XAUUSDT 黄金永续（直接挂钩伦敦金）；取不到时退到 PAXGUSDT 永续，
     两者都是 Gate 的 USDT 永续合约，口径不变，见 SYM_FALLBACK */
  { id: 'GOLD',  name: '纽约黄金 XAU/USD', short: '黄金', sym: 'XAUUSDT',      type: 'gold',   dec: 2,  qtyStep: 0.001,
    venues: { gate: 'XAUUSDT', okx: 'PAXG-USDT', coinbase: 'PAXG-USD' } },
  { id: 'UST2Y',  name: '美债2年收益率',   short: '美2Y',  type: 'ust', tenor: '2 Yr',  dec: 3, qtyStep: 1, source: '美国财政部' },
  { id: 'UST5Y',  name: '美债5年收益率',   short: '美5Y',  type: 'ust', tenor: '5 Yr',  dec: 3, qtyStep: 1, source: '美国财政部' },
  { id: 'UST10Y', name: '美债10年收益率',  short: '美10Y', type: 'ust', tenor: '10 Yr', dec: 3, qtyStep: 1, source: '美国财政部' },
];
const TFS = ['5m', '15m', '1h'];
const TF_NAME = { '5m': '5分钟', '15m': '15分钟', '1h': '1小时' };
/* 角色分工（第 6 节）：1h 定大方向，15m 共振确认，5m 只做市场结构扳机（不参与方向投票） */
const TF_ROLE = { '5m': '结构扳机', '15m': '共振确认', '1h': '方向' };

const FEE = 0.001;            // 兼容旧引用（=市价 Taker 费率）
const FEE_TAKER = 0.001;      // 市价单手续费 0.10%
const FEE_MAKER = 0.0005;     // 限价单手续费 0.05%
const MMR = 0.005;            // 维持保证金率（用于计算强平价）
const LEVERS = [1, 10, 20, 50];          // 简化窗口：去掉 2x / 3x / 5x，只保留 1x / 10x / 20x / 50x
const LEVER_DEFAULT = 10;

/* ---------- 右上角刷新档位
   仅控制「行情/分析数据」的刷新节奏（K线、信号、涨跌热力矩阵、成交热力图、止盈止损方案）。
   实时价格轮询（5s）与逐笔成交撮合/强平检查不随档位变化 —— 它们是交易核心，
   变慢会导致限价单触发与强平风控失效。 */
const REFRESH_LEVELS = [
  { id: 'realtime', name: '实时',   sigMs: 60000,  flowMs: 15000,  priceMs: 5000 },
  { id: 'm5',       name: '5分钟',  sigMs: 300000, flowMs: 300000, priceMs: 5000 },
  { id: 'm10',      name: '10分钟', sigMs: 600000, flowMs: 600000, priceMs: 5000 },
  { id: 'm30',      name: '30分钟', sigMs: 1800000, flowMs: 1800000, priceMs: 5000 },
];
const REFRESH_KEY = 'simtrader_refresh_v1';
function rfLevel() { return REFRESH_LEVELS.find(l => l.id === state.refreshLevel) || REFRESH_LEVELS[0]; }

/* ---------- 止盈止损区间参数（按周期分别设定）
   atrK     ：ATR 止损倍数（周期越大，容忍的正常波动越大）
   maxAtrK  ：单笔最大风险上限（以 ATR 倍数计，防止结构止损过远）
   look     ：结构高低点取样根数
   rr       ：止盈目标的风险回报倍数（用于推导止盈1/2/3）
   w        ：该周期在综合结论中的权重
   riskPct  ：单笔风险预算（占总权益比例，用于反推建议数量） */
const TPSL_CFG = {
  '5m':  { atrK: 0.90, maxAtrK: 1.6, look: 16, rr: [1.0, 2.0, 3.0], w: 0.26 },
  '15m': { atrK: 1.20, maxAtrK: 2.0, look: 20, rr: [1.0, 2.0, 3.0], w: 0.30 },
  '1h':  { atrK: 1.80, maxAtrK: 2.4, look: 30, rr: [1.0, 2.0, 3.2], w: 0.44 },
};   /* 1h 是方向周期，权重最高；权重和 = 1.00 */
const TPSL_RISK_BUDGET = 0.02;   // 单笔风险预算 = 总权益的 2%

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
function fmt(v, dec = 2) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function ts(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000); }
function upDownClass(v) { return v > 0 ? 'txt-up' : v < 0 ? 'txt-down' : ''; }
function upDownColor(v) { return v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)'; }
function fmtPct(v) { return (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%'; }

/* ---------- 技术指标 ---------- */
function ema(vals, p) {
  const k = 2 / (p + 1), out = [];
  let prev;
  vals.forEach((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(prev); });
  return out;
}
function sma(vals, p) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < p - 1) { out.push(null); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += vals[j];
    out.push(s / p);
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) { ag += g / p; al += l / p; if (i === p) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const dif = closes.map((_, i) => ef[i] - es[i]);
  const dea = ema(dif, sig);
  return { dif, dea, hist: dif.map((d, i) => d - dea[i]) };
}
function boll(closes, p = 20, m = 2) {
  const mid = sma(closes, p);
  const up = [], lo = [], sd = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); sd.push(null); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += Math.pow(closes[j] - mid[i], 2);
    const d = Math.sqrt(s / p);
    sd.push(d); up.push(mid[i] + m * d); lo.push(mid[i] - m * d);
  }
  return { mid, up, lo, sd };
}

/* KDJ(9,3,3)：RSV → K（2/3 前值 + 1/3 新值）→ D（对 K 同样平滑）→ J = 3K − 2D */
function kdj(candles, n = 9, m1 = 3, m2 = 3) {
  const k = [], d = [], j = [];
  let pk = 50, pd = 50;
  for (let i = 0; i < candles.length; i++) {
    if (i < n - 1) { k.push(null); d.push(null); j.push(null); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let x = i - n + 1; x <= i; x++) {
      if (candles[x].high > hh) hh = candles[x].high;
      if (candles[x].low < ll) ll = candles[x].low;
    }
    const rsv = hh === ll ? 50 : (candles[i].close - ll) / (hh - ll) * 100;
    pk = (m1 - 1) / m1 * pk + rsv / m1;
    pd = (m2 - 1) / m2 * pd + pk / m2;
    k.push(pk); d.push(pd); j.push(3 * pk - 2 * pd);
  }
  return { k, d, j };
}

/* OBV 能量潮：涨计 +量、跌计 −量、平计 0，逐根累加 */
function obv(candles) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i].volume || 0;
    if (i > 0) {
      const c = candles[i].close, pv = candles[i - 1].close;
      if (c > pv) acc += v; else if (c < pv) acc -= v;
    } else acc = v;
    out.push(acc);
  }
  return out;
}

/* 量价背离：价创新高而 OBV 未创新高 → 顶背离(-1)；价创新低而 OBV 未创新低 → 底背离(+1) */
function obvDivergence(candles, look = 30) {
  if (!candles || candles.length < 12) return 0;
  const ov = obv(candles);
  const seg = candles.slice(-look), sv = ov.slice(-look);
  const n = seg.length;
  let hiC = -Infinity, hiO = -Infinity, loC = Infinity, loO = Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (seg[i].close > hiC) hiC = seg[i].close;
    if (sv[i] > hiO) hiO = sv[i];
    if (seg[i].close < loC) loC = seg[i].close;
    if (sv[i] < loO) loO = sv[i];
  }
  const lastC = seg[n - 1].close, lastO = sv[n - 1];
  if (lastC > hiC && lastO < hiO) return -1;    // 顶背离：上涨无量，警惕反转
  if (lastC < loC && lastO > loO) return 1;     // 底背离：下跌无量，跌势衰竭
  return 0;
}

/* 布林扩展：%B（价格在通道中的相对位置）+ 带宽 + 带宽历史分位（收口/开口） */
function bollExt(closes, p = 20, m = 2) {
  const b = boll(closes, p, m);
  const i = closes.length - 1;
  const bw = closes.map((_, x) => (b.mid[x] == null || !b.mid[x]) ? null : (b.up[x] - b.lo[x]) / b.mid[x]);
  const hist = bw.slice(Math.max(0, bw.length - 120), i + 1).filter(v => v != null && isFinite(v));
  const cur = bw[i];
  const bwRank = (cur == null || !hist.length) ? null : hist.filter(v => v <= cur).length / hist.length;
  const pb = (b.up[i] != null && b.up[i] !== b.lo[i]) ? (closes[i] - b.lo[i]) / (b.up[i] - b.lo[i]) : null;
  return {
    ...b, bw, pb, bwRank,
    squeeze: bwRank != null && bwRank < 0.25,     // 波动压缩 → 容易被扫损，需给止损缓冲
    expand: bwRank != null && bwRank > 0.78,      // 波动扩张 → 止损需跟随放大
  };
}

/* ATR% 在自身近 120 根中的分位（判断当前波动处于历史高位还是低位） */
function atrRank(candles, p = 14, look = 120) {
  if (!candles || candles.length < p + 20) return null;
  const n = candles.length;
  const series = [];
  for (let i = p; i < n; i++) {
    const seg = candles.slice(Math.max(0, i - p), i + 1);
    let a = 0;
    for (let x = 1; x < seg.length; x++) {
      const c = seg[x], pv = seg[x - 1];
      a += Math.max(c.high - c.low, Math.abs(c.high - pv.close), Math.abs(c.low - pv.close));
    }
    a /= (seg.length - 1);
    const c0 = candles[i].close;
    if (c0 > 0) series.push(a / c0);
  }
  if (series.length < 10) return null;
  const hist = series.slice(-look);
  const cur = hist[hist.length - 1];
  return hist.filter(v => v <= cur).length / hist.length;
}

/* Wilder 波动/趋向序列：ATR(14) + DI± + ADX(14)
   递推式（与流式引擎逐字一致，勿改）：
     前 p 根累加 → i=p 起  S = S − S/p + x
     ATR = TR14/p ；DI± = 100×DM±14/TR14 ；DX = 100×|DI+−DI−|/(DI++DI−)
     ADX 首值 = 前 p 个 DX 的均值，之后  ADX = (ADX×(p−1) + DX)/p
   ATR 是后面所有因子的量纲基准（把价格差统一成「几个 ATR」，跨周期跨品种可比）。 */
function wilderSeries(candles, p = 14) {
  const n = candles.length;
  const atr = [], diP = [], diM = [], adx = [];
  let tSum = 0, pSum = 0, mSum = 0, adxV = null, dxSum = 0, dxCnt = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i], pv = i > 0 ? candles[i - 1] : null;
    let tr, dp, dm;
    if (!pv) { tr = c.high - c.low; dp = 0; dm = 0; }
    else {
      const upM = c.high - pv.high, dnM = pv.low - c.low;
      dp = (upM > dnM && upM > 0) ? upM : 0;
      dm = (dnM > upM && dnM > 0) ? dnM : 0;
      tr = Math.max(c.high - c.low, Math.abs(c.high - pv.close), Math.abs(c.low - pv.close));
    }
    if (i < p) { tSum += tr; pSum += dp; mSum += dm; atr.push(null); diP.push(null); diM.push(null); adx.push(null); continue; }
    if (i === p) { tSum += tr; pSum += dp; mSum += dm; }
    else { tSum = tSum - tSum / p + tr; pSum = pSum - pSum / p + dp; mSum = mSum - mSum / p + dm; }
    atr.push(tSum / p);
    const dpv = tSum > 0 ? 100 * pSum / tSum : 0;
    const dmv = tSum > 0 ? 100 * mSum / tSum : 0;
    diP.push(dpv); diM.push(dmv);
    const sum = dpv + dmv;
    const dx = sum > 0 ? 100 * Math.abs(dpv - dmv) / sum : 0;
    if (adxV == null) { dxSum += dx; dxCnt++; if (dxCnt >= p) { adxV = dxSum / p; adx.push(adxV); } else adx.push(null); }
    else { adxV = (adxV * (p - 1) + dx) / p; adx.push(adxV); }
  }
  return { atr, diP, diM, adx };
}

/* 通用背离判定（表里：MACD 看背离、RSI 看背离、OBV 看是否确认价格新高/新低）
   窗口 = 截至 i 的前 look 根（不含 i 自身）；价新高而指标未新高 → −1（顶背离），
   价新低而指标未新低 → +1（底背离），否则 0。 */
function divergenceAt(prices, inds, i, look) {
  const from = Math.max(0, i - look);
  let hiC = -Infinity, hiO = -Infinity, loC = Infinity, loO = Infinity;
  for (let x = from; x < i; x++) {
    if (inds[x] == null || prices[x] == null) continue;
    if (prices[x] > hiC) hiC = prices[x];
    if (inds[x] > hiO) hiO = inds[x];
    if (prices[x] < loC) loC = prices[x];
    if (inds[x] < loO) loO = inds[x];
  }
  const c = prices[i], o = inds[i];
  if (c == null || o == null || !isFinite(hiC)) return 0;
  if (c > hiC && o < hiO) return -1;
  if (c < loC && o > loO) return 1;
  return 0;
}

/* KDJ 钝化状态机（表里：不要看金叉/死叉，要看「钝化持续时间 + 脱离极端区」）
   钝化（D 连续停在 >75 或 <25）= 强趋势特征，顺势；脱离极端区 = 原方向动能耗尽，反向。
   把这段抽成纯函数，是为了让 app.js 与 strategy.js 的流式状态机逐字对齐。 */
const KDJ_HI = 75, KDJ_LO = 25;
function kdjReplay(kd, i) {
  let dun = 0, dunDir = 0, wasExtreme = false, runLen = 0, runDir = 0;
  const from = Math.max(0, i - 400);
  for (let x = from; x <= i; x++) {
    const D = kd.d[x];
    const inZone = D != null && (D > KDJ_HI || D < KDJ_LO);
    const d0 = (D != null && D > KDJ_HI) ? 1 : -1;
    if (x === i) {
      /* 当前根：dun/dunDir 需含当前根；runLen/runDir 在「刚脱离」时取上一段的长度 */
      if (inZone) {
        const same = dunDir === d0;
        return { inZone: true, dun: same ? dun + 1 : 1, dunDir: d0, wasExtreme: wasExtreme, runLen: runLen, runDir: runDir, k: kd.k[x], d: D, j: kd.j[x] };
      }
      return {
        inZone: false, dun: 0, dunDir: 0, wasExtreme: wasExtreme,
        runLen: wasExtreme ? dun : runLen, runDir: wasExtreme ? dunDir : runDir,
        k: kd.k[x], d: D, j: kd.j[x],
      };
    }
    if (inZone) { if (dunDir === d0) dun++; else { dunDir = d0; dun = 1; } }
    else { if (dunDir !== 0) { runLen = dun; runDir = dunDir; } dun = 0; dunDir = 0; }
    wasExtreme = inZone;
  }
  return null;
}
/* 钝化 → 顺势分；刚脱离极端区 → 反向分（单根事件） */
function kdjScore(st) {
  if (st == null) return { v: 0, txt: '—' };
  if (st.inZone && st.dun >= 5) {
    return { v: st.dunDir * Math.min(1, 0.15 + (st.dun - 4) / 8) * 0.85, txt: (st.dunDir > 0 ? '超买' : '超卖') + '钝化 ' + st.dun + ' 根（趋势未竭）' };
  }
  if (!st.inZone && st.wasExtreme && st.runLen >= 3) {
    return { v: -st.runDir * Math.min(0.9, 0.45 + st.runLen * 0.05), txt: '脱离' + (st.runDir > 0 ? '超买' : '超卖') + '区（钝化 ' + st.runLen + ' 根后衰竭）' };
  }
  if (st.inZone) return { v: 0, txt: (st.dunDir > 0 ? '超买' : '超卖') + '钝化 ' + st.dun + ' 根（未成势）' };
  return { v: 0, txt: '常态区' };
}

function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ---------- 信号引擎（八因子打分 · 按「指标推荐关注方式」重构） ----------
   设计原则 —— 逐条落实「不要只看」那一栏：
     · EMA   → 不看单次金叉/死叉，改看 斜率 + 快慢线距离及其变化 + 价格与 EMA 偏离
     · MACD  → 不看是否大于/小于 0，改看 Histogram 值 + 一阶变化 + 二阶加速度 + 背离
     · ADX   → 不看单个阈值，改看 绝对强度（连续映射）+ 连续上升/下降速度
     · RSI   → 不看超买超卖本身，改看 区域 + 斜率 + 背离 + 脱离极端区
     · KDJ   → 不看金叉/死叉，改看 钝化持续时间 + 脱离极端区
     · BOLL  → 不看触碰上下轨，改看 Band Width 分位 + z-score + 假突破后回归
     · OBV   → 不看绝对数值，改看 是否确认价格新高/新低（确认 or 背离）
     · Volume→ 不看简单放量，改看 RVOL + climax + 结构位放量
   量纲统一：价格差一律除以 Wilder ATR(14)，变成「几个 ATR」，
   这样 5m / 15m / 1h 与 BTC / ETH / 黄金可以共用同一套阈值。 */
const SIG_W = { trend: 0.15, macd: 0.14, adx: 0.13, rsi: 0.11, kdj: 0.10, boll: 0.10, obv: 0.13, vol: 0.14 };
const SIG_LOOK = { div: 30, struct: 20, rvol: 120 };

function computeSignal(candles) {
  const n = candles.length;
  if (n < 60) return null;
  const closes = candles.map(c => c.close);
  const i = n - 1, last = closes[i];

  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const m = macd(closes), r = rsi(closes), bx = bollExt(closes);
  const kd = kdj(candles);
  const ws = wilderSeries(candles);
  const A = ws.atr[i];                                  // 量纲基准
  const okA = A != null && A > 0;
  const ov = obv(candles), oma = ema(ov, 20);
  const k5 = Math.max(0, i - 5);

  // ① 趋势因子 · EMA —— 斜率 + 快慢线距离变化 + 价格与 EMA 偏离
  const devA = okA ? (e9[i] - e21[i]) / A : 0;          // 快慢线距离（单位：ATR）
  const devA5 = okA ? (e9[k5] - e21[k5]) / A : 0;
  const slopeA = okA ? (e9[i] - e9[k5]) / A : 0;        // EMA9 斜率（5 根，单位：ATR）
  const pDevA = okA ? (last - e21[i]) / A : 0;          // 价格与 EMA21 偏离（单位：ATR）
  const trend = clampN(0.34 * clampN(slopeA / 1.6, -1, 1)
    + 0.24 * clampN(devA / 2.0, -1, 1)
    + 0.18 * clampN((devA - devA5) / 0.8, -1, 1)
    + 0.24 * clampN(pDevA / 2.0, -1, 1), -1, 1);

  // ② 动能因子 · MACD —— Histogram 值 + 一阶变化 + 二阶加速度 + 背离
  const h0 = m.hist[i], h1 = m.hist[i - 1], h2 = m.hist[i - 2];
  const hvN = okA ? h0 / A : 0;
  const h1N = okA ? (h0 - h1) / A : 0;
  const h2N = okA ? (h0 - 2 * h1 + h2) / A : 0;         // 二阶差分 = 加速度
  const mdvg = divergenceAt(closes, m.dif, i, SIG_LOOK.div);
  const macdV = clampN(0.45 * clampN(hvN / 0.6, -1, 1)
    + 0.22 * clampN(h1N / 0.12, -1, 1)
    + 0.15 * clampN(h2N / 0.10, -1, 1)
    + 0.30 * mdvg, -1, 1);
  const macdCross = (m.dif[i] > m.dea[i] && m.dif[i - 1] <= m.dea[i - 1]) ? 1
    : (m.dif[i] < m.dea[i] && m.dif[i - 1] >= m.dea[i - 1]) ? -1 : 0;

  // ③ 趋向因子 · ADX —— 绝对强度（连续映射，非阈值）+ 连续上升/下降速度
  const adx0 = ws.adx[i], adx6 = ws.adx[Math.max(0, i - 6)];
  const diP = ws.diP[i], diM = ws.diM[i];
  const adxStr = adx0 == null ? 0 : clampN((adx0 - 12) / 28, 0, 1);
  const adxSpd = (adx0 == null || adx6 == null) ? 0 : clampN((adx0 - adx6) / 6, -1, 1);
  const adxDir = diP == null ? 0 : (diP > diM ? 1 : diP < diM ? -1 : 0);
  /* ADX 连续走强 → 趋势可信度放大到 1.0；连续走弱 → 衰减到 0.62 */
  const adxV = clampN(adxDir * adxStr * (0.62 + 0.19 * (adxSpd + 1)), -1, 1);

  // ④ 摆动因子 · RSI —— 区域 + 斜率 + 背离 + 脱离极端区（不看超买超卖本身）
  const rv = r[i] ?? 50;
  const rvPrev = r[Math.max(0, i - 4)] ?? 50;
  const rsiZone = clampN((rv - 50) / 28, -1, 1);
  const rsiSlope = clampN((rv - rvPrev) / 4 / 2.5, -1, 1);
  const rdvg = divergenceAt(closes, r, i, SIG_LOOK.div);
  let rMin = Infinity, rMax = -Infinity;
  for (let x = Math.max(0, i - 6); x < i; x++) {
    const v = r[x]; if (v == null) continue;
    if (v < rMin) rMin = v;
    if (v > rMax) rMax = v;
  }
  const rsiExit = (rMin < 30 && rv >= 32) ? 1 : (rMax > 70 && rv <= 68) ? -1 : 0;   // 脱离极端区
  const rsiV = clampN(0.25 * rsiZone + 0.25 * rsiSlope + 0.25 * rdvg + 0.25 * rsiExit, -1, 1);

  // ⑤ 摆动因子 · KDJ —— 钝化持续时间 + 脱离极端区（完全不看金叉/死叉）
  const st = kdjReplay(kd, i);
  const kSc = kdjScore(st);
  const kdjV = kSc.v, kdjTxt = kSc.txt;
  const K = st ? st.k : null, D = st ? st.d : null, J = st ? st.j : null;

  // ⑥ 通道因子 · BOLL —— Band Width 分位 + z-score + 假突破后回归（不看触碰上下轨）
  const mid = bx.mid[i], sdv = bx.sd[i], up = bx.up[i], lo = bx.lo[i];
  const z = (sdv != null && sdv > 0) ? (last - mid) / sdv : null;
  let bollV = 0, fbrk = 0;
  if (z != null) {
    let v = -clampN(z / 2.4, -1, 1) * 0.55;                 // z-score 均值回归倾向
    // 带宽分位调制：极度收口时回归不可靠（变盘临近），开口扩张时回归更可靠
    if (bx.bwRank != null) v *= (bx.bwRank < 0.2 ? 0.70 : bx.bwRank > 0.8 ? 1.12 : 1);
    // 假突破后回归：当根上影破上轨收回，或上一根收在轨外而本根收回 → 强反向
    const pUp = i > 0 ? bx.up[i - 1] : null, pLo = i > 0 ? bx.lo[i - 1] : null;
    const falseUp = (candles[i].high > up && last < up) || (pUp != null && closes[i - 1] > pUp && last < up);
    const falseDn = (candles[i].low < lo && last > lo) || (pLo != null && closes[i - 1] < pLo && last > lo);
    if (falseUp) { v = -0.9; fbrk = -1; }
    else if (falseDn) { v = 0.9; fbrk = 1; }
    bollV = clampN(v, -1, 1);
  }

  // ⑦ 量价因子 · OBV —— 是否确认价格新高/新低（不看绝对数值）
  let hiC = -Infinity, hiO = -Infinity, loC = Infinity, loO = Infinity;
  for (let x = Math.max(0, i - SIG_LOOK.div); x < i; x++) {
    if (closes[x] > hiC) hiC = closes[x];
    if (ov[x] > hiO) hiO = ov[x];
    if (closes[x] < loC) loC = closes[x];
    if (ov[x] < loO) loO = ov[x];
  }
  const newHi = last > hiC, newLo = last < loC;
  let obvV = 0, obvTxt = '无新高/新低（弱参考）', obvState = 0;
  if (newHi && ov[i] >= hiO) { obvV = 1; obvState = 1; obvTxt = '量价同步新高（确认）'; }
  else if (newHi && ov[i] < hiO) { obvV = -0.8; obvState = 1; obvTxt = '价新高但 OBV 未确认（顶背离）'; }
  else if (newLo && ov[i] <= loO) { obvV = -1; obvState = -1; obvTxt = '量价同步新低（确认）'; }
  else if (newLo && ov[i] > loO) { obvV = 0.8; obvState = -1; obvTxt = '价新低但 OBV 未确认（底背离）'; }
  else obvV = clampN((ov[i] - oma[i]) / (Math.abs(oma[i]) + 1e-9) * 2, -0.35, 0.35);
  const dvg = (newHi && ov[i] < hiO) ? -1 : (newLo && ov[i] > loO) ? 1 : 0;

  // ⑧ 量能因子 · Volume —— RVOL + climax + 结构位放量（不看简单放量）
  const cVol = candles[i].volume || 0;
  let vSum = 0, vCnt = 0;
  for (let x = Math.max(0, i - SIG_LOOK.rvol); x < i; x++) { vSum += candles[x].volume || 0; vCnt++; }
  const rvol = (vCnt > 0 && vSum > 0) ? cVol / (vSum / vCnt) : 1;
  let hi20 = -Infinity, lo20 = Infinity;
  for (let x = Math.max(0, i - SIG_LOOK.struct); x < i; x++) {
    if (candles[x].high > hi20) hi20 = candles[x].high;
    if (candles[x].low < lo20) lo20 = candles[x].low;
  }
  const rng = candles[i].high - candles[i].low;
  const barPos = rng > 0 ? (last - candles[i].low) / rng : 0.5;
  const nearHi = isFinite(hi20) && candles[i].high >= hi20;
  const nearLo = isFinite(lo20) && candles[i].low <= lo20;
  let volV = 0, volTxt = '常态量';
  if (rvol >= 1.4 && nearHi) { volV = 0.85; volTxt = '结构位放量向上突破'; }
  else if (rvol >= 1.4 && nearLo) { volV = -0.85; volTxt = '结构位放量向下破位'; }
  else if (rvol >= 3 && barPos < 0.34) { volV = 0.60; volTxt = '抛售高潮（量能尖峰＋收在下沿）'; }
  else if (rvol >= 3 && barPos > 0.66) { volV = -0.60; volTxt = '买入高潮（量能尖峰＋收在上沿）'; }
  else if (rvol >= 1.4) volTxt = '放量但不在结构位（不给方向）';
  else if (rvol < 0.6) volTxt = '缩量';

  const raw = trend * SIG_W.trend + macdV * SIG_W.macd + adxV * SIG_W.adx + rsiV * SIG_W.rsi
    + kdjV * SIG_W.kdj + bollV * SIG_W.boll + obvV * SIG_W.obv + volV * SIG_W.vol;

  /* 方向判定两道闸门（与上一版同构，阈值不变以保证前后可比）：
     ① 主导因子：八因子各给一点同向分也能凑过阈值，故要求至少一个因子明确表态；
     ② 趋势门槛：EMA9/21 距离 < 0.30 ATR 视为震荡，此时摆动指标噪音大，
        需更强分数才认定方向成立（阈值 0.20 → 0.32）。 */
  const strength = Math.max(Math.abs(trend), Math.abs(macdV), Math.abs(adxV), Math.abs(rsiV),
    Math.abs(kdjV), Math.abs(bollV), Math.abs(obvV), Math.abs(volV));
  const trendLocked = Math.abs(devA) >= 0.30;
  const th = trendLocked ? 0.20 : 0.32;
  const clear = strength >= 0.5 && Math.abs(raw) >= th;
  const score = clear ? raw : raw * 0.5;      // 方向不成立 → 分数向中性收敛
  const dir = clear ? (raw >= th ? 'long' : raw <= -th ? 'short' : 'wait') : 'wait';
  const label = !clear ? '观望'
    : score >= 0.5 ? '强烈买入' : score >= th ? '买入'
      : score > -th ? '观望' : score > -0.5 ? '卖出' : '强烈卖出';
  const kind = !clear ? 'neutral' : score >= th ? 'buy' : score > -th ? 'neutral' : 'sell';
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  return {
    score, label, kind, dir, clear, raw, th, trendLocked,
    // 因子原值（供测试逐因子对照，也给"为什么是这个方向"留痕）
    fac: { trend, macd: macdV, adx: adxV, rsi: rsiV, kdj: kdjV, boll: bollV, obv: obvV, vol: volV },
    detail: [
      ['趋势 EMA9/21', `斜率 ${sgn(slopeA)}ATR · 距离 ${sgn(devA)}ATR`, trend],
      ['动能 MACD柱', `值 ${sgn(hvN)}ATR · 加速度 ${h2N >= 0 ? '+' : '−'}${Math.abs(h2N).toFixed(3)}${mdvg ? (mdvg < 0 ? ' · 顶背离' : ' · 底背离') : ''}`, macdV],
      ['趋向 ADX(14)', adx0 == null ? '—' : `${adx0.toFixed(0)} · ${adxSpd > 0.05 ? '走强' : adxSpd < -0.05 ? '走弱' : '走平'} · ${adxDir > 0 ? 'DI+ 占优' : adxDir < 0 ? 'DI− 占优' : '多空均衡'}`, adxV],
      ['摆动 RSI(14)', `${rv.toFixed(0)} · 斜率 ${sgn(rsiSlope * 2.5)}${rdvg ? (rdvg < 0 ? ' · 顶背离' : ' · 底背离') : ''}${rsiExit ? (rsiExit > 0 ? ' · 脱离超卖' : ' · 脱离超买') : ''}`, rsiV],
      ['摆动 KDJ(9,3,3)', kdjTxt, kdjV],
      ['通道 BOLL(20)', `z ${z == null ? '—' : z.toFixed(2)} · 带宽分位 ${bx.bwRank == null ? '—' : (bx.bwRank * 100).toFixed(0) + '%'}${fbrk ? (fbrk < 0 ? ' · 上轨假突破' : ' · 下轨假突破') : ''}`, bollV],
      ['量价 OBV', obvTxt, obvV],
      ['量能 VOL', `RVOL ${rvol.toFixed(2)} · ${volTxt}`, volV],
    ],
    // 指标快照（供指标面板与止盈止损优化使用）
    ind: {
      k: K, d: D, j: J, kdjTxt, kdjDun: st ? st.dun : 0, kdjInZone: st ? st.inZone : false,
      dif: m.dif[i], dea: m.dea[i], hist: h0, hist1: h1N, hist2: h2N, macdCross, mdvg,
      rsi: rv, rsiZone, rsiSlope, rdvg, rsiExit,
      adx: adx0, adxStr, adxSpeed: adxSpd, diP, diM,
      pb: bx.pb, bw: bx.bw[i], bwRank: bx.bwRank, squeeze: bx.squeeze, expand: bx.expand,
      sd: sdv, z, fbrk,
      bUp: up, bMid: mid, bLo: lo,
      obv: ov[i], obvMa: oma[i], dvg, obvTxt, obvState,
      rvol, volTxt, atr: A, devA, slopeA, pDevA,
    },
  };
}
const SIG_COLOR = { '强烈买入': 'var(--up)', '买入': 'var(--up)', '观望': 'var(--muted)', '卖出': 'var(--down)', '强烈卖出': 'var(--down)' };

/* ============================================================
   数据接入层
   目标：任何单点网络故障都不该导致「页面空白 / 抓不到数据」。
   四道防线 —— 超时 → 重试 → 换源 → 缓存兜底。
   ============================================================ */

/* ---------- 网络层：超时 + 重试 + 退避 ----------
   裸 fetch 在网络被墙（TCP 黑洞）时会无限挂起：请求既不通也不报错，
   页面只能一直停在加载态 —— 这是「抓不到数据」最常见也最容易被忽略的原因。
   这里强制给每个请求设上限，超时候快速失败并转下一源。 */
const NET = { timeout: 4500, retries: 0, backoff: 350, budget: 12000 };
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
class NetError extends Error {
  constructor(msg, kind) { super(msg); this.name = 'NetError'; this.kind = kind || 'net'; }
}
async function netFetch(url, opt = {}) {
  const timeout = opt.timeout != null ? opt.timeout : NET.timeout;
  const retries = opt.retries != null ? opt.retries : NET.retries;
  let last;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(NET.backoff * Math.pow(2, i - 1) + Math.random() * 200);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    try {
      if (ctl) timer = setTimeout(() => ctl.abort(), timeout);
      const init = ctl ? Object.assign({}, opt.init, { signal: ctl.signal }) : opt.init;
      const res = await fetch(url, init);
      if (!res.ok) throw new NetError('HTTP ' + res.status, 'http');
      return res;
    } catch (e) {
      last = (e && e.name === 'AbortError') ? new NetError('请求超时 ' + timeout + 'ms', 'timeout') : e;
    } finally { if (timer) clearTimeout(timer); }
  }
  throw last;
}
async function netJson(url, opt) { const r = await netFetch(url, opt); return await r.json(); }
async function netText(url, opt) { const r = await netFetch(url, opt); return await r.text(); }

/* ---------- 源健康度：按实测延迟与成功率动态排序 ----------
   境外接口的可达性会随时间、网络环境变化（域名被污染、TCP 被 reset 都是常态），
   把主源写死，就会在某一天突然全挂。这里记录每个源的成功/失败与最近延迟，
   每次取源都按「健康分」排序，失败的源自动沉底，恢复后又能浮上来。 */
const SRC_KEY = 'simtrader_src_v1';
function loadSrcHealth() { try { return JSON.parse(localStorage.getItem(SRC_KEY) || '{}') || {}; } catch (e) { return {}; } }
const SRC_HEALTH = loadSrcHealth();
function saveSrcHealth() { try { localStorage.setItem(SRC_KEY, JSON.stringify(SRC_HEALTH)); } catch (e) {} }
function srcOf(key) { return SRC_HEALTH[key] || (SRC_HEALTH[key] = { ok: 0, fail: 0, ms: 0, lastOk: 0 }); }
function srcRecord(key, ok, ms) {
  const h = srcOf(key);
  if (ok) { h.ok++; h.ms = ms ? (h.ms ? Math.round(h.ms * 0.6 + ms * 0.4) : ms) : h.ms; h.lastOk = Date.now(); h.fail = Math.max(0, h.fail - 1); }
  else { h.fail++; h.lastFail = Date.now(); }
  saveSrcHealth();
}
/* 健康分：越小越优先。失败率重罚（×100000），延迟作为次要排序项 */
function srcScore(key) {
  const h = srcOf(key), n = h.ok + h.fail;
  return (n ? h.fail / n : 0) * 100000 + (h.ms || 4000);
}
/* 手动锁定主源：用户指定的源永远排在最前（存 localStorage，跨会话生效） */
const PIN_KEY = 'simtrader_pin_v1';
function loadPin() { try { return localStorage.getItem(PIN_KEY) || ''; } catch (e) { return ''; } }
function savePin(k) { try { k ? localStorage.setItem(PIN_KEY, k) : localStorage.removeItem(PIN_KEY); } catch (e) {} }
let srcPinned = loadPin();
function setSrcPinned(k) { srcPinned = k || ''; savePin(srcPinned); }
function orderedSources(list) {
  return list.slice().sort((a, b) => {
    if (srcPinned) {
      if (a.key === srcPinned) return -1;
      if (b.key === srcPinned) return 1;
    }
    /* 永续永远排在现货前面：即使现货更快更稳，也不能因为「快」就把永续价换成现货价 */
    const ka = a.kind === 'perp' ? 0 : 1, kb = b.kind === 'perp' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return srcScore(a.key) - srcScore(b.key);
  });
}
/* 换源时的进度回调：让界面能显示「正在尝试备用源」，
   否则用户在十几秒的等待里根本不知道系统是卡死了还是在工作。 */
let netHint = null;
async function trySources(sources, kind, label, fn) {
  const t0 = Date.now();
  let last;
  const list = orderedSources(sources);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (i > 0) {
      if (Date.now() - t0 > NET.budget) break;      // 总预算耗尽 → 快速失败，不再无意义地等
      if (netHint) netHint(`主源无响应，正在尝试 ${s.name}…`);
    }
    const r0 = Date.now();
    try {
      const out = await fn(s);
      srcRecord(s.key, true, Date.now() - r0);
      if (i > 0 && netHint) netHint('');             // 换源成功后清空提示
      return out;
    } catch (e) { srcRecord(s.key, false); last = e; }
  }
  throw last || new NetError(label + '：全部数据源均不可用', 'all');
}

/* ---------- 持久化快照缓存：最后一道防线 ----------
   只要成功取到过一次数据，就写一份到 localStorage。
   之后即便所有源都挂掉，页面仍能显示「上次成功的数据」而不是空白，
   并明确标注数据时间，避免把陈旧数据误当成实时行情。 */
/* 快照键升到 v2：v1 存的是现货口径数据，改版为永续基准后不应再拿旧快照兜底 */
const SNAP_KEY = 'simtrader_snap_v3';   // v3：品种代码换为 XAUUSDT 后旧快照口径不一致，直接作废
const SNAP_MAX = 40;          // 最多保留 40 份快照，超出按时间淘汰最旧的
function snapStore() { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '{}') || {}; } catch (e) { return {}; } }
function snapSave(key, data) {
  try {
    const s = snapStore();
    s[key] = { data, ts: Date.now() };
    const ks = Object.keys(s);
    if (ks.length > SNAP_MAX) {
      ks.sort((a, b) => (s[a].ts || 0) - (s[b].ts || 0));
      ks.slice(0, ks.length - SNAP_MAX).forEach(k => delete s[k]);
    }
    localStorage.setItem(SNAP_KEY, JSON.stringify(s));
  } catch (e) { /* 配额不足时静默放弃，不影响主流程 */ }
}
function snapLoad(key) {
  try { const s = snapStore(); return s[key] || null; } catch (e) { return null; }
}
/* 把 K 线压缩后再存：坐标取整、价格保留 8 位有效精度，减少 60% 以上体积 */
function slimCandles(c) {
  return c.map(x => [x.time, +(+x.open).toFixed(8), +(+x.high).toFixed(8), +(+x.low).toFixed(8), +(+x.close).toFixed(8), +(+x.volume).toFixed(4)]);
}
function fatCandles(c) {
  return (c || []).map(a => ({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] }));
}
function staleText(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

/* ---------- 行情源：Gate.io USDT 永续（单一数据源） ----------
   K线、实时价、24小时涨跌、逐笔成交与实时推送，全部只走 Gate.io 的 USDT 永续合约，
   不再抓任何现货行情，也不再回退到其他交易所 —— 口径统一，界面所见即永续价。 */
const GATE_HOST = 'https://api.gateio.ws';
/* 品种代码 → Gate.io USDT 永续合约（均已实测可取数） */
const GATE_FUT_PAIR = {
  BTCUSDT: 'BTC_USDT', ETHUSDT: 'ETH_USDT', BNBUSDT: 'BNB_USDT',
  XAUUSDT: 'XAU_USDT',          // 黄金永续（直接挂钩伦敦金）
  PAXGUSDT: 'PAXG_USDT',        // 黄金代币永续，仅作 XAU 取不到时的同口径备用
};
/* 备用代码：主代码取不到时换成这个再试一次，仍在 Gate 永续口径内（XAU → PAXG） */
const SYM_FALLBACK = { XAUUSDT: 'PAXGUSDT' };

/* Gate.io USDT 永续源（本终端唯一行情源） */
const GATE_FUT_SOURCE = {
  key: 'gate_perp', name: 'Gate·永续', host: GATE_HOST, kind: 'perp',
  /* 健康探测地址：必须是带 CORS 头的公开接口。
     /futures/usdt/time 会返回 400 且不带 Access-Control-Allow-Origin，
     浏览器端会被 CORS 拦掉、把数据源误判为不可用，故改用合约详情接口 */
  pingUrl: GATE_HOST + '/api/v4/futures/usdt/contracts/BTC_USDT',
  async klines(sym, tf, limit) {
    const pair = GATE_FUT_PAIR[sym];
    if (!pair) throw new NetError('Gate.io 无此永续合约 ' + sym, 'unsupported');
    const j = await netJson(`${GATE_HOST}/api/v4/futures/usdt/candlesticks?contract=${pair}&interval=${tf}&limit=${limit}`);
    if (!Array.isArray(j) || !j.length) throw new NetError('K线为空', 'empty');
    return j.map(a => ({ time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c, volume: +a.v }))
            .sort((x, y) => x.time - y.time);
  },
  async prices(syms) {
    const out = {};
    await Promise.all(syms.map(async s => {
      const pair = GATE_FUT_PAIR[s]; if (!pair) return;
      try {
        const j = await netJson(`${GATE_HOST}/api/v4/futures/usdt/tickers?contract=${pair}`);
        if (j && j[0] && +j[0].last > 0) out[s] = +j[0].last;
      } catch (e) { /* 单个合约失败不影响其他 */ }
    }));
    if (!Object.keys(out).length) throw new NetError('价格为空', 'empty');
    return out;
  },
  async dayChange(syms) {
    const out = {};
    await Promise.all(syms.map(async s => {
      const pair = GATE_FUT_PAIR[s]; if (!pair) return;
      try {
        const j = await netJson(`${GATE_HOST}/api/v4/futures/usdt/tickers?contract=${pair}`);
        if (j && j[0] && j[0].change_percentage != null) out[s] = +j[0].change_percentage;
      } catch (e) { /* 同上 */ }
    }));
    if (!Object.keys(out).length) throw new NetError('涨跌为空', 'empty');
    return out;
  },
  async aggTrades(sym, opt) {
    const pair = GATE_FUT_PAIR[sym]; if (!pair) throw new NetError('unsupported', 'unsupported');
    opt = opt || {};
    let q = `contract=${pair}&limit=${opt.limit || 1000}`;
    if (opt.endTime != null) q += `&to=${Math.floor(opt.endTime / 1000)}`;
    const j = await netJson(`${GATE_HOST}/api/v4/futures/usdt/trades?${q}`);
    return (j || []).map(t => ({ T: Math.round(+(t.create_time_ms != null ? t.create_time_ms : t.create_time * 1000)), p: t.price, q: t.size }));
  },
  async ticker24h(sym) {
    const pair = GATE_FUT_PAIR[sym]; if (!pair) throw new NetError('unsupported', 'unsupported');
    const j = await netJson(`${GATE_HOST}/api/v4/futures/usdt/tickers?contract=${pair}`);
    const last = j && j[0] ? +j[0].last : NaN, pct = j && j[0] ? +j[0].change_percentage : NaN;
    return { lastPrice: last, openPrice: isFinite(last) && isFinite(pct) ? last / (1 + pct / 100) : null };
  },
};

/* 唯一数据源：Gate.io USDT 永续。没有备线、没有现货兜底 —— 取不到就是取不到，宁可显示离线快照也不换口径 */
const KLINE_SOURCES = [GATE_FUT_SOURCE];

/* 当前生效的数据源（供界面显示）：kline=主行情源，ust=美债源，degraded=正在显示离线快照 */
const dataSrc = { kline: '—', klineKey: '', price: '—', ust: '—', lastOk: 0, degraded: false, staleTs: 0 };

/* 代码级回退：主代码在某个源上取不到时，换成备用代码再试一次
   （黄金永续 XAUUSDT 拿不到 → 退回黄金代币 PAXGUSDT 拿现货价）
   只作用于当前这个源，不会打乱「永续优先」的源链顺序 */
async function callSym(fn, sym, a, b) {
  try {
    return await fn(sym, a, b);
  } catch (e) {
    const alt = SYM_FALLBACK[sym];
    if (!alt) throw e;
    return await fn(alt, a, b);
  }
}
/* 整批请求版本：把需要回退的代码换成备用代码重取，再把结果键名映射回原代码 */
async function callSyms(fn, syms, a) {
  try {
    return await fn(syms, a);
  } catch (e) {
    const mapped = syms.map(x => SYM_FALLBACK[x] || x);
    if (mapped.join(',') === syms.join(',')) throw e;
    const out = await fn(mapped, a);
    const back = {};
    syms.forEach((x, i) => { const v = out[mapped[i]]; if (v != null) back[x] = v; });
    if (!Object.keys(back).length) throw e;
    return back;
  }
}

/* 逐笔成交 / 24h 行情：同样走「永续优先、现货兜底」的整条源链 */
async function srcFetch(kind, label, fn) {
  return await trySources(KLINE_SOURCES, kind, label, fn);
}
async function fetchKlines(symbol, interval, limit = 300, endTime) {
  return await trySources(KLINE_SOURCES, 'kline', 'K线', async s => {
    const c = await callSym((x, tf, n) => s.klines(x, tf, n), symbol, interval, limit);
    const out = endTime ? c.filter(x => x.time * 1000 <= endTime) : c;
    if (!out.length) throw new NetError('K线为空', 'empty');
    dataSrc.kline = s.name; dataSrc.klineKey = s.key; dataSrc.lastOk = Date.now();
    return out;
  });
}
async function fetchPrices(symbols) {
  return await trySources(KLINE_SOURCES, 'price', '实时价格', async s => {
    const o = await callSyms(x => s.prices(x), symbols);
    if (!Object.keys(o).length) throw new NetError('价格为空', 'empty');
    dataSrc.price = s.name;
    return o;
  });
}
async function fetchDayChange(symbols) {
  return await trySources(KLINE_SOURCES, 'price', '24小时涨跌', async s => await callSyms(x => s.dayChange(x), symbols));
}

/* ---------- 源探测 ----------
   只有一个源（Gate.io 永续），探测的作用是把实测延迟写进健康度并显示到状态条上。 */
async function probeSources() {
  await Promise.all(KLINE_SOURCES.map(async s => {
    const t0 = Date.now();
    try {
      await netJson(s.pingUrl, { timeout: 6000, retries: 0 });
      srcRecord(s.key, true, Date.now() - t0);
    } catch (e) { srcRecord(s.key, false); }
  }));
  renderDataSource();
}

/* ---------- 数据源状态条 ----------
   把「数据到底来自哪里、快不快、是不是过期缓存」直接摆在用户眼前。
   行情类页面最忌讳的是数据悄悄不动了而界面看起来一切正常。 */
/* 当前源固定为 Gate.io USDT 永续 —— 只有一个源，不存在永续/现货混用的可能 */
function srcKindText() {
  return 'Gate.io 永续';
}
function renderDataSource() {
  const dot = $('#dsDot'), name = $('#dsName'), msEl = $('#dsMs');
  if (!dot || !name) return;
  const cur = KLINE_SOURCES.find(s => s.key === dataSrc.klineKey);
  const h = cur ? srcOf(cur.key) : null;
  let cls, txt, sub = '';
  if (dataSrc.degraded) {
    cls = 'stale'; txt = '离线快照';
    sub = dataSrc.staleTs ? staleText(dataSrc.staleTs) + '更新' : '';
  } else if (cur) {
    cls = 'ok'; txt = cur.name;
    sub = h && h.ms ? h.ms + 'ms' : '';
  } else { cls = 'warn'; txt = '连接中…'; }
  dot.className = 'ds-dot ' + cls;
  name.textContent = txt;
  if (msEl) msEl.textContent = sub;
  const ctl = $('#dsCtl');
  if (ctl) ctl.classList.toggle('degraded', !!dataSrc.degraded);
  if (ctl && ctl.classList.contains('open')) renderDsMenu();
}
function renderDsMenu() {
  const box = $('#dsList');
  if (!box) return;
  box.innerHTML = orderedSources(KLINE_SOURCES).map(s => {
    const h = srcOf(s.key), n = h.ok + h.fail;
    const rate = n ? Math.round(h.ok / n * 100) : null;
    const st = !n ? 'unknown' : rate >= 80 ? 'ok' : rate >= 40 ? 'warn' : 'bad';
    const meta = !n ? '尚未测试' : (h.ms ? h.ms + 'ms · ' : '') + '成功率 ' + rate + '%';
    return `<button class="ds-item${s.key === dataSrc.klineKey ? ' cur' : ''}${s.key === srcPinned ? ' pinned' : ''}" data-src="${s.key}">
      <span class="ds-dot ${st}"></span>
      <span class="ds-iname">${s.name}</span>
      <span class="ds-imeta">${meta}</span>
      <span class="ds-iact">${s.key === srcPinned ? '已锁定' : '锁定'}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.src;
    setSrcPinned(srcPinned === k ? '' : k);
    const nm = (KLINE_SOURCES.find(s => s.key === k) || {}).name || k;
    toast(srcPinned ? '已锁定主源 ' + nm + ' · 正在重新加载' : '已恢复自动择优');
    renderDsMenu();
    refreshAll(true);
  }));
  const foot = $('#dsFoot');
  if (foot) foot.textContent = dataSrc.degraded
    ? '所有数据源当前不可达，正在显示本地缓存的上次成功数据，仅供参考。'
    : '默认按「成功率 + 实测延迟」自动择优，某个源失败会立即切换下一个。';
}
function initDataSourceCtl() {
  const ctl = $('#dsCtl'), btn = $('#dsBtn');
  if (!ctl || !btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctl.classList.toggle('open');
    if (ctl.classList.contains('open')) renderDsMenu();
  });
  document.addEventListener('click', (e) => { if (!ctl.contains(e.target)) ctl.classList.remove('open'); });
  renderDataSource();
}
/* ---------- 多平台实时比价 ----------
   同一品种并行取 Gate.io 永续（主源）/ OKX / Coinbase / Bitstamp 的实时价。
   主源只有一个：Gate.io USDT 永续；其余平台直连公开 REST，仅作比价参考。
   注意：Bitstamp 对不存在的交易对会回退返回「数组」格式，这里显式丢弃，避免污染比价。 */
/* 第三方平台（OKX / Coinbase / Bitstamp）比价请求：
   超时收紧到 5 秒 —— 它们只用于比价展示，不该拖慢主流程。 */
async function jFetch(url, timeout) {
  const res = await netFetch(url, { timeout: timeout || 5000, retries: 0 });
  return await res.json();
}
/* 单个平台报价：契约统一 —— 无论网络错误、HTTP 错误、格式异常还是价格无效，
   一律返回 null，绝不抛出。这样调用方（尤其直接调用时）不会因为单个平台挂掉而中断。 */
async function fetchVenueQuote(key, sym) {
  try {
    if (key === 'gate') {
      const t = await srcFetch('kline', '24小时行情', s => callSym(x => s.ticker24h(x), sym));
      const px = +t.lastPrice;
      return px > 0 ? { px, open24h: +t.openPrice } : null;
    }
    if (key === 'okx') {
      const j = await jFetch('https://www.okx.com/api/v5/market/ticker?instId=' + sym);
      const d = j && j.data && j.data[0];
      const px = d && +d.last;
      return px > 0 ? { px, open24h: +d.open24h } : null;
    }
    if (key === 'coinbase') {
      const j = await jFetch('https://api.exchange.coinbase.com/products/' + sym + '/ticker');
      const px = j && +j.price;
      return px > 0 ? { px, open24h: null } : null;   // Coinbase ticker 不含 24h 开盘价
    }
    if (key === 'bitstamp') {
      const j = await jFetch('https://www.bitstamp.net/api/v2/ticker/' + sym + '/');
      if (Array.isArray(j)) return null;              // 无此交易对时的回退格式
      const px = j && +j.last;
      return px > 0 ? { px, open24h: j.open_24 != null ? +j.open_24 : null } : null;
    }
  } catch (e) { /* 单个平台失败 → 视为无报价 */ }
  return null;
}
/* 取某品种全平台报价 → { gate:{px,open24h}, okx:{...}, ... }（失败平台不出现在结果里） */
async function fetchVenueQuotes(inst) {
  if (!inst.venues) return null;
  const keys = Object.keys(inst.venues);
  const arr = await Promise.all(keys.map(async k => {
    try { return [k, await fetchVenueQuote(k, inst.venues[k])]; } catch (e) { return [k, null]; }
  }));
  const out = {}; let n = 0;
  arr.forEach(([k, q]) => { if (q && q.px > 0) { out[k] = q; n++; } });
  return n ? out : null;
}
/* 多平台比价缓存：比价格行情更新慢一些（默认 20 秒），避免高频打第三方接口 */
const VENUE_TTL = 20000;
async function ensureVenueQuotes(inst, force) {
  const ts = state.venueTs[inst.id] || 0;
  if (!force && state.venueQuotes[inst.id] && Date.now() - ts < VENUE_TTL) return state.venueQuotes[inst.id];
  const q = await fetchVenueQuotes(inst);
  if (q) { state.venueQuotes[inst.id] = q; state.venueTs[inst.id] = Date.now(); }
  return q || state.venueQuotes[inst.id] || null;
}

/* ---------- 美债收益率（多源降级 + 缓存兜底） ----------
   注意：财政部 fiscaldata JSON API 的日收益率曲线数据集已下架（全部路径 404），
   因此主源改为官网 CSV 直连 —— 实测返回 CORS: *，可浏览器直连，且是官方一手数据。 */
const UST_CACHE = { data: null, ts: 0, src: '' };
const UST_CSV = y => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
const UST_MIN_BARS = 200;                 // 至少要这么多交易日才够算指标
async function fetchTreasuryYields() {
  if (UST_CACHE.data && Date.now() - UST_CACHE.ts < 30 * 60 * 1000) return UST_CACHE.data;
  const y = new Date().getFullYear();

  // 源1：财政部官网 CSV 直连（当年 + 上年拼接，保证历史长度足够）
  try {
    const texts = [];
    for (const yy of [y, y - 1]) {
      texts.push(await netText(UST_CSV(yy), { timeout: 9000 }));
      const probe = mergeTreasuryCSV(texts);
      if (probe && probe.ust10Y.series.length >= UST_MIN_BARS) break;
    }
    const out = mergeTreasuryCSV(texts);
    if (out && out.ust10Y.series.length) { commitUst(out, '美国财政部官网'); return out; }
  } catch (e) { /* 降级 */ }

  // 源2：fiscaldata JSON API（数据集若恢复则自动优先于缓存）
  try {
    const url = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/daily_treasury_par_yield_curve_rates?sort=-record_date&page[size]=400';
    const j = await netJson(url, { timeout: 9000 });
    const recs = (j && j.data) || [];
    if (recs.length) {
      const out = parseFiscal(recs);
      if (out) { commitUst(out, '美国财政部 API'); return out; }
    }
  } catch (e) { /* 降级 */ }

  // 源3：本地快照缓存（保证断网也不空白，界面会标注为离线数据）
  const snap = snapLoad('ust:all');
  if (snap && snap.data && snap.data.ust10Y && snap.data.ust10Y.series.length) {
    UST_CACHE.data = snap.data; UST_CACHE.ts = snap.ts; UST_CACHE.src = '本地缓存';
    dataSrc.ust = '本地缓存'; dataSrc.degraded = true; dataSrc.staleTs = snap.ts;
    return snap.data;
  }
  throw new NetError('美债数据源暂不可用（财政部接口维护中，且无本地缓存）', 'all');
}
function commitUst(out, src) {
  UST_CACHE.data = out; UST_CACHE.ts = Date.now(); UST_CACHE.src = src;
  dataSrc.ust = src; dataSrc.degraded = false; dataSrc.staleTs = 0;
  snapSave('ust:all', out);
}
/* 多份年度 CSV 合并：去重 + 按日期升序 */
function mergeTreasuryCSV(texts) {
  const all = { ust2Y: { dates: [], series: [] }, ust5Y: { dates: [], series: [] }, ust10Y: { dates: [], series: [] } };
  const seen = {};
  texts.forEach(t => {
    const p = parseTreasuryCSV(t);
    if (!p) return;
    ['ust2Y', 'ust5Y', 'ust10Y'].forEach(k => {
      for (let i = 0; i < p[k].dates.length; i++) {
        const d = p[k].dates[i];
        if (seen[k + d]) continue;
        seen[k + d] = 1;
        all[k].dates.push(d); all[k].series.push(p[k].series[i]);
      }
    });
  });
  ['ust2Y', 'ust5Y', 'ust10Y'].forEach(k => {
    const z = all[k].dates.map((d, i) => [d, all[k].series[i]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    all[k].dates = z.map(x => x[0]); all[k].series = z.map(x => x[1]);
  });
  return all.ust10Y.series.length ? all : null;
}
function parseFiscal(recs) {
  // 数据集有两种可能结构：长表（security_desc+rate）或宽表（record_date + "2 Yr" 列）
  const out = { ust2Y: { dates: [], series: [] }, ust5Y: { dates: [], series: [] }, ust10Y: { dates: [], series: [] } };
  if (recs[0] && recs[0].security_desc !== undefined) {
    const map = { '2 Yr': 'ust2Y', '5 Yr': 'ust5Y', '10 Yr': 'ust10Y' };
    recs.forEach(r => {
      const key = map[r.security_desc];
      const rate = r.rate !== undefined ? +r.rate : (r.avg_interest_rate_amt !== undefined ? +r.avg_interest_rate_amt : NaN);
      if (key && !isNaN(rate)) { out[key].dates.unshift(r.record_date); out[key].series.unshift(rate); }
    });
  } else if (recs[0] && recs[0]['10 Yr'] !== undefined) {
    recs.forEach(r => {
      const d = r.record_date;
      [['2 Yr', 'ust2Y'], ['5 Yr', 'ust5Y'], ['10 Yr', 'ust10Y']].forEach(([col, key]) => {
        const v = +r[col];
        if (!isNaN(v)) { out[key].dates.unshift(d); out[key].series.unshift(v); }
      });
    });
  } else return null;
  return out.ust10Y.series.length ? out : null;
}
/* 日期归一化：财政部 CSV 用 MM/DD/YYYY，fiscaldata 用 YYYY-MM-DD，统一成 ISO */
function normDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return t;
}
function parseTreasuryCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const idx = { date: header.indexOf('Date'), y2: header.indexOf('2 Yr'), y5: header.indexOf('5 Yr'), y10: header.indexOf('10 Yr') };
  if (idx.y10 < 0) return null;
  const out = { ust2Y: { dates: [], series: [] }, ust5Y: { dates: [], series: [] }, ust10Y: { dates: [], series: [] } };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(s => s.trim().replace(/"/g, ''));
    const d = normDate(c[idx.date]); if (!d) continue;
    const push = (ci, key) => { if (ci >= 0 && c[ci] && !isNaN(+c[ci])) { out[key].dates.unshift(d); out[key].series.unshift(+c[ci]); } };
    push(idx.y2, 'ust2Y'); push(idx.y5, 'ust5Y'); push(idx.y10, 'ust10Y');
  }
  return out.ust10Y.series.length ? out : null;
}
// 美债：日频 → 合成到三周期视图（相同信号，备注日频）
async function fetchUstKlines(inst, tf) {
  const all = await fetchTreasuryYields();
  const d = all[inst.id.toLowerCase()];
  return d.dates.map((dt, i) => {
    const t = Math.floor(new Date(dt + 'T00:00:00Z').getTime() / 1000);
    const v = d.series[i];
    return { time: t, open: v, high: v, low: v, close: v, volume: 0 };
  });
}

/* ---------- 状态 ---------- */
/* 5m 市场结构参数（第 6 节）：档位 / 最低结构分 / 是否要求 5m 方向同向 —— 持久化 */
function msCfg(k, dflt) {
  try { return localStorage.getItem('simtrader_ms_' + k) || dflt; } catch (e) { return dflt; }
}

const state = {
  current: 'BTC',
  tf: '15m',
  candles: {},
  prices: {},          // 实时价格
  prevPrices: {},
  dayChange: {},       // 24h 涨跌幅
  signals: {},         // tf -> signal
  venueQuotes: {},     // 品种 -> { gate:{px,open24h}, okx:{...}, ... } 多平台实时比价
  venueTs: {},         // 品种 -> 比价缓存时间戳
  tfCandles: null,     // { _inst, 5m:[], 15m:[], 1h:[] } 各周期真实K线
  tpsl: null,          // 当前品种的多周期止盈止损方案
  triggers: [],        // 开单逻辑触发点 [{time, dir, sc}]，画在 K 线上
  ms: null,            // { res, snap } 5m 市场结构快照（第 6 节）
  msMode: msCfg('mode', 'strict'),   // strict=CHOCH+回踩+BOS 全满足 / loose=核心≥2
  msMin: +msCfg('min', '0') || 0,    // 最低结构分（0 = 不限）
  msAnd: msCfg('and', '0') === '1',  // true 时附加要求 5m 方向也同向
  _lastAlert: '',      // 已报警的触发点 key（避免同一触发反复弹窗）
  _btRunning: false, _btResult: null,   // 回测运行状态
  tpOv: loadTpOv(),    // "品种:周期" -> { stop?, tp1?, tp2? } 手动微调覆盖值（持久化）
  cacheTs: {},         // 各品种各周期K线缓存时间戳
  orderType: 'market', // market | limit
  lever: LEVER_DEFAULT,  // 杠杆倍数（简化档位：1x / 10x / 20x / 50x）
  ticks: {},           // 品种 -> 近 2 分钟真实成交价序列 [{p,t,s}]，用于限价单撮合
  tickSeq: 0,          // 成交采样自增序号（委托以序号为触发起点）
  wsAlive: false,      // 逐笔行情推送是否已连接
  refreshLevel: loadRefreshLevel(),  // 右上角刷新档位（realtime/m5/m10/m30）
  refreshTimers: [],   // 当前档位下的定时器句柄（切档时统一清理）
  nextRefreshAt: 0,    // 下一次自动刷新的时间戳（用于倒计时显示）
  chart: null,
  candleSeries: null,
  ema9Series: null,
  ema21Series: null,
  acct: loadAcct(),
};
const SYM_MAP = {};
INSTRUMENTS.forEach(i => { if (i.sym) SYM_MAP[i.sym] = i.id; });
function uid() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function freshAcct() { return { cash: 100000, positions: [], orders: [], history: [] }; }
function loadAcct() {
  try {
    const s = JSON.parse(localStorage.getItem('simtrader_acct_v1'));
    if (s && typeof s.cash === 'number') return normalizeAcct(s);
  } catch (e) {}
  return freshAcct();
}
/* 兼容旧版账户结构（补全 id / side / margin / orders） */
function normalizeAcct(s) {
  const a = {
    cash: +s.cash || 0, positions: [],
    orders: Array.isArray(s.orders) ? s.orders : [],
    history: Array.isArray(s.history) ? s.history : [],
  };
  (s.positions || []).forEach(p => {
    const qty = +p.qty || 0; if (qty <= 0) return;
    const entry = +p.entry || 0;
    a.positions.push({
      id: p.id || uid(), inst: p.inst, side: p.side || 'long', qty, entry,
      margin: p.margin != null ? +p.margin : qty * entry / (+p.lev || 1),
      time: p.time || Date.now(),
    });
  });
  return a;
}
function saveAcct() { localStorage.setItem('simtrader_acct_v1', JSON.stringify(state.acct)); }
/* 刷新档位持久化（读档失败或非法值一律回落「实时」） */
function loadRefreshLevel() {
  try {
    const v = localStorage.getItem(REFRESH_KEY);
    if (v && REFRESH_LEVELS.some(l => l.id === v)) return v;
  } catch (e) {}
  return 'realtime';
}
function saveRefreshLevel() { try { localStorage.setItem(REFRESH_KEY, state.refreshLevel); } catch (e) {} }
function instOf(id) { return INSTRUMENTS.find(x => x.id === id); }
function lastPrice(id) { return state.prices[id] ?? null; }

/* ---------- 真实成交价采样（限价单撮合依据）----------
   记录每一笔观测到的真实成交价（WebSocket 逐笔推送优先，轮询兜底），
   限价单只有在这条真实价格轨迹“走到”委托价时才撮合成交。
   每条采样带自增序号 seq，委托以下单时刻的 seq 为起点，
   因此下单之前出现过的价位不会触发成交（杜绝“挂单即成交”）。 */
function observeTrade(id, price, t) {
  if (!(price > 0)) return;
  const now = t || Date.now();
  let arr = state.ticks[id];
  if (!arr) arr = state.ticks[id] = [];
  arr.push({ p: price, t: now, s: ++state.tickSeq });
  if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  while (arr.length && now - arr[0].t > 120000) arr.shift(); // 只保留近 2 分钟
}
/* 自序号 sinceSeq（含之后）以来该品种的真实成交区间，并合并最新价 */
function tradedRangeSince(id, sinceSeq) {
  const px = lastPrice(id);
  let hi = px == null ? -Infinity : px, lo = px == null ? Infinity : px;
  const arr = state.ticks[id] || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const x = arr[i];
    if ((x.s || 0) <= (sinceSeq || 0)) break;
    if (x.p > hi) hi = x.p;
    if (x.p < lo) lo = x.p;
  }
  return { hi, lo, n: arr.length };
}

/* ---------- 保证金 / 盈亏计算 ---------- */
function posDir(p) { return p.side === 'long' ? 1 : -1; }
function posNotional(p) { return p.qty * p.entry; }
function posLev(p) { return p.margin > 0 ? posNotional(p) / p.margin : 1; }
function posPnl(p, pr) { return pr == null ? null : (pr - p.entry) * p.qty * posDir(p); }
function posRoi(p, pr) { const v = posPnl(p, pr); return v == null || !p.margin ? null : v / p.margin; }
function liqPrice(p) { return p.entry - posDir(p) * (p.margin / p.qty) * (1 - MMR); }
function orderLiq(entry, lev, isLong) { return entry - (isLong ? 1 : -1) * (entry / lev) * (1 - MMR); }
function posMarginUsed() { return (state.acct.positions || []).reduce((s, p) => s + p.margin, 0); }
function frozenMargin() { return (state.acct.orders || []).reduce((s, o) => s + (o.kind === 'open' ? o.margin : 0) + (o.frozenFee || 0), 0); }
function acctEquity() {
  let eq = state.acct.cash + frozenMargin();
  state.acct.positions.forEach(p => { eq += p.margin + (posPnl(p, lastPrice(p.inst)) || 0); });
  return eq;
}
function maxQtyFor(price, lev, feeRate, avail) { return avail / (price * (1 / lev + feeRate)); }
function roundStep(v, step) { return Math.max(step, Math.round(Math.floor(v / step + 1e-9) * step * 1e8) / 1e8); }
function pendCloseQty(posId) {
  return (state.acct.orders || []).filter(o => o.kind === 'close' && o.posId === posId).reduce((s, o) => s + o.qty, 0);
}

/* ---------- 二次确认弹窗 ---------- */
function confirmDialog(opt) {
  return new Promise(resolve => {
    const mask = $('#modalMask'), box = $('#modalBox'), warn = $('#mdWarn'), body = $('#mdBody');
    $('#mdTitle').textContent = opt.title || '请确认操作';
    $('#mdIcon').textContent = opt.icon || '?';
    body.innerHTML = (opt.rows ? opt.rows.map(r =>
      `<div class="md-row"><span class="k">${r.k}</span><span class="v ${r.cls || ''}">${r.v}</span></div>`).join('') : '')
      + (opt.bodyHtml || '');
    if (opt.warn) { warn.textContent = opt.warn; warn.classList.add('show'); } else warn.classList.remove('show');
    const yes = $('#mdYes'), no = $('#mdNo');
    yes.textContent = opt.yesText || '是 · 确认';
    no.textContent = opt.noText || '否 · 取消';
    const style = opt.btnStyle || 'accent';
    const isDanger = opt.danger === true;   // 破坏性操作（撤单/重置）固定红色，与方向色解耦
    yes.style.background = style === 'up' ? 'var(--up)' : style === 'down' ? 'var(--down)' : (isDanger ? 'var(--down)' : 'var(--accent)');
    box.classList.toggle('danger', isDanger);
    mask.classList.add('show');
    if (opt.onRender) { try { opt.onRender(body); } catch (e) {} }

    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      mask.classList.remove('show');
      yes.onclick = no.onclick = mask.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish({ ok: false }); }
      if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); yes.click(); }
    };
    yes.onclick = () => {
      if (opt.validate) { const err = opt.validate(body); if (err) { warn.textContent = err; warn.classList.add('show'); return; } }
      finish({ ok: true, data: opt.collect ? opt.collect(body) : null });
    };
    no.onclick = () => finish({ ok: false });
    mask.onclick = (e) => { if (e.target === mask) finish({ ok: false }); };
    document.addEventListener('keydown', onKey);
  });
}
async function confirmYes(opt) { const r = await confirmDialog(opt); return !!(r && r.ok); }

/* ---------- 品种速览条 ---------- */
/* 品种的平台来源标签：美债为单一官方来源，加密与黄金为 Gate.io 永续主源 + N 家比价平台 */
function venueTagOf(inst) {
  if (inst.source) return inst.source;
  const n = inst.venues ? Object.keys(inst.venues).length : 0;
  return n ? `Gate 永续 · ${n}平台` : '—';
}
function renderWatchlist() {
  const box = $('#watchlist');
  box.innerHTML = INSTRUMENTS.map(i => `
    <div class="wl-item ${i.id === state.current ? 'active' : ''}" data-id="${i.id}">
      <div class="nm">${i.name}</div>
      <div class="pr" id="wl-pr-${i.id}">—</div>
      <div class="cg" id="wl-cg-${i.id}"></div>
      <div class="vn" id="wl-vn-${i.id}">${venueTagOf(i)}</div>
    </div>`).join('');
  box.querySelectorAll('.wl-item').forEach(el => el.addEventListener('click', () => selectInstrument(el.dataset.id)));
}
function updateWatchlist() {
  INSTRUMENTS.forEach(i => {
    const p = lastPrice(i.id);
    const prEl = $(`#wl-pr-${i.id}`), cgEl = $(`#wl-cg-${i.id}`);
    if (prEl && p != null) prEl.textContent = i.type === 'ust' ? fmt(p, 2) + '%' : fmt(p, i.dec);
    if (cgEl) {
      const chg = state.dayChange[i.id];
      if (chg != null) { cgEl.textContent = fmtPct(chg); cgEl.style.color = upDownColor(chg); }
    }
    const vnEl = $(`#wl-vn-${i.id}`);
    if (vnEl) {
      const qs = state.venueQuotes[i.id];
      if (i.source) vnEl.textContent = i.source;
      else {
        const n = qs ? Object.keys(qs).length : (i.venues ? Object.keys(i.venues).length : 0);
        vnEl.textContent = n ? `Gate 永续 · ${n}平台` : '—';
      }
    }
  });
}

/* ---------- 主图 ---------- */
function initChart() {
  const chart = LightweightCharts.createChart($('#chart'), {
    layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#4b5563', fontSize: 15 },
    grid: { vertLines: { color: '#f0f2f5' }, horzLines: { color: '#f0f2f5' } },
    rightPriceScale: { borderColor: '#e3e8ef' },
    /* 时间轴：放大/缩小都留足余量，方便看清局部细节或整体走势 */
    timeScale: {
      borderColor: '#e3e8ef', timeVisible: true, secondsVisible: false,
      minBarSpacing: 0.2, maxBarSpacing: 60,      // 最大可缩放范围（0.2 看全局 / 60 看单根）
      rightOffset: 3,
      lockVisibleTimeRangeOnResize: true,          // 窗口尺寸变化不重置缩放
    },
    crosshair: { mode: 0 },
    watermark: { visible: false },     // 视觉去噪：隐藏图表库水印
    /* 交互：滚轮缩放（上下滚动）、按住拖动平移、双指/价格轴拖动缩放 */
    handleScroll: {
      mouseWheel: true,        // Shift+滚轮 / 触控板横向 → 左右平移
      pressedMouseMove: true,  // 按住鼠标左右拖动 → 平移
      horzTouchDrag: true, vertTouchDrag: true,
    },
    handleScale: {
      mouseWheel: true,        // 鼠标上下滚动 → 缩放
      pinch: true,
      axisPressedMouseMove: { time: true, price: true },  // 拖动时间轴/价格轴 → 缩放
      axisDoubleClickReset: true,                          // 双击轴 → 复位
    },
    kineticScroll: { mouse: true, touch: true },
  });
  state.chart = chart;
  state.candleSeries = chart.addCandlestickSeries({
    /* 涨绿跌红（与 --up/--down 保持一致） */
    upColor: '#0a8f4e', downColor: '#d92c2c', borderUpColor: '#0a8f4e', borderDownColor: '#d92c2c',
    wickUpColor: '#0a8f4e', wickDownColor: '#d92c2c',
  });
  state.ema9Series = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'EMA9', priceLineVisible: false });
  state.ema21Series = chart.addLineSeries({ color: '#2563eb', lineWidth: 1, title: 'EMA21', priceLineVisible: false });
  new ResizeObserver(() => chart.applyOptions({ width: $('#chart').clientWidth, height: $('#chart').clientHeight })).observe($('#chart'));
  /* 多空清算图（Gate 永续强平）：K线左侧强度条 + 清算价位横线，随缩放/平移重绘 */
  if (window.LiqMap) {
    window.LiqMap.init(chart, state.candleSeries, $('#chartBox'), $('#chart'));
    try { chart.timeScale().subscribeVisibleTimeRangeChange(() => window.LiqMap.render()); } catch (e) {}
  }
  /* 缩放 / 复位按钮（滚轮与拖动由图表库原生提供） */
  const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
  bind('#zoomIn', () => zoomChart(1 / 1.5));
  bind('#zoomOut', () => zoomChart(1.5));
  bind('#zoomReset', () => resetChartZoom());
  /* 清算图统计窗口：24h / 3天 / 7天 */
  const winBox = $('#liqWin');
  if (winBox) {
    const savedWin = window.LiqMap ? window.LiqMap.windowHours() : 24;
    winBox.querySelectorAll('[data-liqwin]').forEach(b => {
      b.classList.toggle('active', +b.dataset.liqwin === savedWin);
      b.addEventListener('click', () => {
        const h = +b.dataset.liqwin;
        winBox.querySelectorAll('[data-liqwin]').forEach(x => x.classList.toggle('active', x === b));
        if (window.LiqMap) window.LiqMap.setWindow(h);
        paintLiqStat();
      });
    });
  }
  /* 多空热力图（订单簿口径）：初始化 + 视野按钮（±200/±500/±2000/±5000 tick） */
  if (window.LsMap) {
    window.LsMap.init($('#lsChart'), $('#lsCards'), $('#lsMeta'));
    const spBox = $('#lsSpan');
    if (spBox) {
      spBox.querySelectorAll('[data-lsspan]').forEach(b => {
        b.classList.toggle('active', +b.dataset.lsspan === window.LsMap.span());
        b.addEventListener('click', () => {
          spBox.querySelectorAll('[data-lsspan]').forEach(x => x.classList.toggle('active', x === b));
          window.LsMap.setSpan(+b.dataset.lsspan);
        });
      });
    }
    const rBtn = $('#lsReset');
    if (rBtn) rBtn.addEventListener('click', () => window.LsMap.resetView());
  }
}

/* 以当前视图中心为锚点缩放（factor < 1 放大，> 1 缩小） */
function zoomChart(factor) {
  if (!state.chart) return;
  const ts = state.chart.timeScale();
  let lr = null;
  try { lr = ts.getVisibleLogicalRange(); } catch (e) {}
  if (!lr || !isFinite(lr.from) || !isFinite(lr.to)) return;
  const span = Math.max(6, Math.min(3000, (lr.to - lr.from) * factor));
  const mid = (lr.from + lr.to) / 2;
  try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch (e) {}
}
function resetChartZoom() {
  if (!state.chart) return;
  try { state.chart.timeScale().fitContent(); } catch (e) {}
}
/* 键盘微调：↑↓ 放大/缩小、←→ 左右平移（输入框内不接管），配合滚轮与拖动一起用 */
function bindChartHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const mm = document.getElementById('modalMask');
    if (mm && mm.classList.contains('show')) return;
    if (!state.chart) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); zoomChart(1 / 1.25); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); zoomChart(1.25); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ts = state.chart.timeScale();
      let lr = null;
      try { lr = ts.getVisibleLogicalRange(); } catch (err) {}
      if (!lr) return;
      e.preventDefault();
      const span = lr.to - lr.from, step = span * 0.12 * (e.key === 'ArrowLeft' ? -1 : 1);
      try { ts.setVisibleLogicalRange({ from: lr.from + step, to: lr.to + step }); } catch (err) {}
    }
  });
}
async function loadChart(force) {
  const inst = instOf(state.current);
  const note = $('#chartNote');
  try {
    note.textContent = '加载K线中…';
    let candles;
    if (inst.type === 'ust') {
      candles = await ensureCandles(inst, state.tf, !!force);
      note.textContent = `美债收益率为日频官方数据，三周期视图显示同一日线序列`;
      if (candles.length > 260) candles = candles.slice(-260);
    } else {
      candles = force ? await fetchKlines(inst.sym, state.tf, 300) : await ensureCandles(inst, state.tf);
      note.textContent = `数据源：${srcKindText()} · ${TF_NAME[state.tf]}K线 · 黄金取 XAUUSDT 黄金永续`;
    }
    state.candles[state.current + '_' + state.tf] = candles;
    state.cacheTs[state.current + '_' + state.tf] = Date.now();   // 同步缓存时间戳，避免紧接着重复拉取
    if (candles.length && candles[candles.length - 1].close) {
      const p = candles[candles.length - 1].close;
      if (state.prices[inst.id] == null) { state.prices[inst.id] = p; }
    }
    paintChart(candles);
    await runSignals(candles, force);     // 等待信号/止盈止损算完，保证「刷新完成」时数据确实已更新
    renderVolumeProfile(candles);
    refreshVolumeProfile(true);
    note.textContent += ' · 绿涨红跌';
    /* 全源失败、正在显示本地快照时必须说清楚，避免把陈旧数据当成实时行情 */
    if (dataSrc.degraded) {
      note.textContent += ` · ⚠ 网络不可用，显示 ${staleText(dataSrc.staleTs)}的离线快照`;
      note.classList.add('stale');
    } else { note.classList.remove('stale'); }
    renderDataSource();
  } catch (e) {
    note.textContent = 'K线加载失败：' + e.message;
    note.classList.add('stale');
  }
}
function paintChart(candles) {
  const inst = instOf(state.current);
  state.candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  state.ema9Series.setData(candles.map((c, i) => ({ time: c.time, value: e9[i] })).filter(x => x.value));
  state.ema21Series.setData(candles.map((c, i) => ({ time: c.time, value: e21[i] })).filter(x => x.value));
  /* 只在「首次加载 / 换品种 / 换周期」时自适应铺满；之后的数据刷新保留用户当前的缩放与拖动位置 */
  const fitKey = state.current + '|' + state.tf;
  if (state.chartFitKey !== fitKey) {
    state.chartFitKey = fitKey;
    state.chart.timeScale().fitContent();
  }
  if (window.LiqMap) { window.LiqMap.setCandles(candles); window.LiqMap.render(); }   // 清算图随 K 线重绘
}

/* ============================================================
   第 6 节 · 5m 市场结构触发（0–25 分）
   ------------------------------------------------------------
   5m 不再参与方向投票，只回答「现在能不能扣扳机」：
     Swing Low 0-3 · Higher Low 0-5 · CHOCH 0-7 · Retest Hold 0-4 · BOS 0-6
   触发口径：setup_valid AND choch AND retest_hold AND bos（严格档）
             核心条件 ≥2（宽松档，即图中「避免假信号」的下限）
   结构算法全部在 strategy.js 的 MsStream，本文件只做展示与参数下发，
   因此实盘与回测用的是**同一份实现**（不存在两套公式各自跑偏的问题）。
   ============================================================ */
function msOpts() {
  return { loose: state.msMode === 'loose', minScore: +state.msMin || 0, andDir: !!state.msAnd };
}
/* 结构当前处于哪一步（状态条与面板共用） */
function msStageText(s) {
  if (!s) return '数据不足';
  const long = s.lScore >= s.sScore;
  const stg = long ? s.lStage : s.sStage;
  const core = long ? s.lCore : s.sCore;
  if (stg >= 3) return '结构确认（BOS 完成）';
  if (stg === 2) return '已回踩守住 · 等 BOS';
  if (stg === 1) return '已 CHOCH · 等回踩';
  return core > 0 ? '结构建设中' : '等结构（无有效 CHOCH）';
}

/* 开单逻辑：1h 定方向 + 15m 共振 + 5m 市场结构触发 */
function updateResonance() {
  const st = window.Strategy;
  const sub = $('#sigSub');
  state.triggers = [];
  state.ms = null;
  if (!st) { if (sub) sub.textContent = '三周期独立计算 · 依据真实K线 · 绿涨红跌'; return; }

  const c5 = state.candles[state.current + '_5m'];
  const c15 = state.candles[state.current + '_15m'];
  const c1h = state.candles[state.current + '_1h'];
  const s1 = state.signals || {};

  /* 5m 市场结构：喂入真实 5m K 线逐根重放（与回测同式） */
  let ms = null, snap = null;
  try {
    if (c5 && c5.length >= 60 && typeof st.msReplay === 'function') {
      ms = st.msReplay(c5);
      snap = ms.last ? st.msCopy(ms.last) : null;
    }
  } catch (e) { ms = null; snap = null; }
  state.ms = { res: ms, snap: snap };

  if (!c5 || !c15 || !c1h || c5.length < 60 || c15.length < 60 || c1h.length < 60) {
    if (sub) sub.textContent = 'K线不足，等待加载…';
    renderMsPanel();
    return;
  }
  try {
    const S5 = st.toSeries(c5), S15 = st.toSeries(c15), S1h = st.toSeries(c1h);
    const r5 = st.dirSeries(S5), r15 = st.dirSeries(S15), r1h = st.dirSeries(S1h);
    const m15 = st.buildMap(S5.t, S15.t), m1h = st.buildMap(S5.t, S1h.t);
    const list = ms
      ? st.findTriggersMs(r5.dirs, r15.dirs, r1h.dirs, m15, m1h, ms, msOpts())
      : st.findTriggers(r5.dirs, r15.dirs, r1h.dirs, m15, m1h);
    state.triggers = list.map(t => ({ time: S5.t[t.i], dir: t.dir, sc: t.sc || 0 }));
  } catch (e) { state.triggers = []; }

  /* 顶部状态条：1h 方向 / 15m 共振 / 5m 结构扳机 */
  if (sub) {
    const dTxt = d => (d === 'long' ? '多' : d === 'short' ? '空' : '观望');
    const d1h = s1['1h'] ? s1['1h'].dir : 'wait';
    const d15 = s1['15m'] ? s1['15m'].dir : 'wait';
    const evLast = ms ? (ms.ev[ms.n - 1] || ms.evL[ms.n - 1]) : 0;
    const msTxt = evLast ? (evLast === 1 ? '▲ 触发多头扳机' : '▼ 触发空头扳机') : msStageText(snap);
    const aligned = d1h !== 'wait' && d15 === d1h;
    sub.textContent = `1h ${dTxt(d1h)}（定方向） · 15m ${dTxt(d15)}（共振） · 5m ${msTxt}`
      + ` → ${aligned ? '方向已共振' : '未共振'}`
      + (snap ? ` · 结构分 多${snap.lScore.toFixed(0)} / 空${snap.sScore.toFixed(0)}` : '');
  }

  paintTriggers();
  renderMsPanel();
  alertResonance(c5);
}

/* ---------- 5m 市场结构面板（第 6 节 · 0–25 分） ---------- */
function renderMsPanel() {
  const box = $('#msPanel');
  if (!box) return;
  const ms = state.ms;
  const s = ms && ms.snap;
  const N = window.Strategy && window.Strategy.MS_SCORE_MAX ? window.Strategy.MS_SCORE_MAX : 25;
  if (!s) {
    box.innerHTML = `<div class="ms-head"><span class="ms-title">5m 市场结构触发 · <b>0 / ${N}</b></span></div>
      <div class="ms-empty">结构计算中…（需 5m K线加载完成）</div>`;
    return;
  }
  /* 取分数更高的一侧作为「当前结构」，并标出方向 */
  const long = s.lScore >= s.sScore;
  const tot = long ? s.lScore : s.sScore;
  const stg = long ? s.lStage : s.sStage;
  const core = long ? s.lCore : s.sCore;
  const lvl = long ? s.lLvl : s.sLvl;
  const dir = long ? '多头结构' : '空头结构';
  const dirTone = long ? 'up' : 'down';
  const items = long
    ? [
      ['Swing Low 成立', s.lSwing, 3, '已确认 pivot low 的新鲜度'],
      ['Higher Low', s.lHL, 5, '新回踩低点高于上一个有效 Swing Low'],
      ['Bullish CHOCH', s.lChoch, 7, '收盘突破最近一个有效 Lower High'],
      ['Retest Hold', s.lRetest, 4, '回踩突破位未失守'],
      ['Bullish BOS', s.lBos, 6, '再破结构高点，确认结构延续'],
    ]
    : [
      ['Swing High 成立', s.sSwing, 3, '已确认 pivot high 的新鲜度'],
      ['Lower High', s.sHL, 5, '新反弹高点低于上一个有效 Swing High'],
      ['Bearish CHOCH', s.sChoch, 7, '收盘跌破最近一个有效 Higher Low'],
      ['Retest Hold', s.sRetest, 4, '反抽结构位未失守'],
      ['Bearish BOS', s.sBos, 6, '再破结构低点，确认结构延续'],
    ];
  const strict = (long ? s.lEv : s.sEv) > 0
    || (stg >= 3);
  const looseOk = core >= 2;
  const pass = state.msMode === 'loose' ? looseOk : core >= 3;

  const rows = items.map(it => {
    const pct = Math.round(it[1] / it[2] * 100);
    return `<div class="ms-row">
      <span class="ms-n">${it[0]}</span>
      <span class="ms-bar"><i style="width:${pct}%" class="${long ? 'up' : 'down'}"></i></span>
      <span class="ms-s ${it[1] > 0 ? (long ? 'up' : 'down') : ''}">${it[1] ? '+' + it[1].toFixed(1) : '0'}<em>/${it[2]}</em></span>
      <span class="ms-t">${it[3]}</span>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="ms-head">
      <span class="ms-title">5m 市场结构触发（第 6 节）· <b class="${dirTone}">${tot.toFixed(1)} / ${N}</b>
        <em class="ms-dir ${dirTone}">${dir}</em></span>
      <span class="ms-ctrl">
        <label>档位
          <select id="msMode">
            <option value="strict"${state.msMode !== 'loose' ? ' selected' : ''}>严格（CHOCH+回踩+BOS）</option>
            <option value="loose"${state.msMode === 'loose' ? ' selected' : ''}>宽松（核心≥2）</option>
          </select>
        </label>
        <label>最低结构分
          <select id="msMin">
            ${[0, 13, 16, 19, 22].map(v => `<option value="${v}"${(+state.msMin || 0) === v ? ' selected' : ''}>${v ? '≥' + v : '不限'}</option>`).join('')}
          </select>
        </label>
        <label class="ms-chk"><input type="checkbox" id="msAnd"${state.msAnd ? ' checked' : ''}> 5m 方向也要同向</label>
      </span>
    </div>
    <div class="ms-body">
      <div class="ms-rows">${rows}</div>
      <div class="ms-side">
        <div class="ms-kv"><span>当前阶段</span><b>${msStageText(s)}</b></div>
        <div class="ms-kv"><span>核心条件</span><b class="${core >= 2 ? 'up' : ''}">${core} / 3</b></div>
        <div class="ms-kv"><span>CHOCH 结构位</span><b>${lvl ? fmt(lvl, instOf(state.current).dec) : '—'}</b></div>
        <div class="ms-kv"><span>5m ATR(14) <em>设单依据</em></span><b>${s.atr ? fmt(s.atr, instOf(state.current).type === 'ust' ? 3 : instOf(state.current).dec) : '—'}</b></div>
        <div class="ms-verdict ${pass ? 'on' : 'off'}">${pass
          ? (state.msMode === 'loose' ? '宽松档已满足（核心 ≥2）' : '严格档已满足 —— 允许扣扳机')
          : (state.msMode === 'loose' ? '核心条件不足 2 个 · 不开仓' : '三核心未齐（缺 ' + (3 - core) + ' 项）· 不开仓')}</div>
        <div class="ms-note">5m <b>不判断大趋势</b>，只负责扣扳机；方向由 1h 定、15m 共振确认。
          结构全部程序化：pivot 用固定 fractal 窗口，且<b>只在右侧窗口走完后</b>才确认，避免偷看未来。</div>
      </div>
    </div>`;
  bindMsCtrl();
}

/* 结构面板上的参数控件（模式 / 最低分 / AND 叠加） */
function bindMsCtrl() {
  const mode = $('#msMode'), min = $('#msMin'), and = $('#msAnd');
  if (mode && !mode._b) {
    mode._b = 1;
    mode.addEventListener('change', () => {
      state.msMode = mode.value;
      try { localStorage.setItem('simtrader_ms_mode', mode.value); } catch (e) {}
      updateResonance();
    });
  }
  if (min && !min._b) {
    min._b = 1;
    min.addEventListener('change', () => {
      state.msMin = +min.value || 0;
      try { localStorage.setItem('simtrader_ms_min', String(state.msMin)); } catch (e) {}
      updateResonance();
    });
  }
  if (and && !and._b) {
    and._b = 1;
    and.addEventListener('change', () => {
      state.msAnd = and.checked ? 1 : 0;
      try { localStorage.setItem('simtrader_ms_and', state.msAnd ? '1' : '0'); } catch (e) {}
      updateResonance();
    });
  }
}

/* 把触发点画成 K 线上的标记（同一根 K 线多次触发只保留最后一次） */
function paintTriggers() {
  if (!state.candleSeries || typeof state.candleSeries.setMarkers !== 'function') return;
  const st = window.Strategy;
  if (!st) return;
  /* 只画落在当前图表数据范围内的触发点：越界的时间会让整个 setMarkers 失效 */
  const bars = state.candles[state.current + '_' + state.tf] || [];
  if (!bars.length) return;
  const t0 = bars[0].time, t1 = bars[bars.length - 1].time;
  const seen = new Map();
  (state.triggers || []).forEach(t => {
    const tt = st.alignTime(t.time, state.tf);
    if (tt < t0 || tt > t1) return;
    seen.set(tt, t.dir);
  });
  const marks = [];
  seen.forEach((dir, time) => {
    const isLong = dir === 'long';
    marks.push({
      time: time,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#0a8f4e' : '#d92c2c',
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: isLong ? '买入' : '卖出',
      size: 2,
    });
  });
  marks.sort((a, b) => a.time - b.time);
  try { state.candleSeries.setMarkers(marks); } catch (e) { /* 图表库版本不支持则跳过 */ }
}

/* 最新一根刚触发 → 弹报警（同一触发只报一次） */
function alertResonance(c5) {
  const trig = state.triggers;
  if (!trig || !trig.length) return;
  const last = trig[trig.length - 1];
  const lastBar = c5[c5.length - 1].time;
  if (last.time < lastBar) return;                       // 不是最新一根 → 只是历史标记，不报警
  const key = state.current + '|' + last.time + '|' + last.dir;
  if (state._lastAlert === key) return;
  state._lastAlert = key;

  const inst = instOf(state.current);
  const isLong = last.dir === 'long';
  const p1h = (state.tpsl && state.tpsl.plans) ? state.tpsl.plans.find(p => p.tf === '1h') : null;
  const side = p1h ? (isLong ? p1h.long : p1h.short) : null;
  const sc = last.sc ? ` · 结构分 ${last.sc.toFixed(1)}/25` : '';
  let msg = (isLong ? '🟢 买入信号' : '🔴 卖出信号') + ` · ${inst.short}：1h 定方向，15m 共振，5m 市场结构触发（${state.msMode === 'loose' ? '宽松·核心≥2' : '严格·CHOCH+回踩+BOS'}）` + sc;
  if (side) msg += ` · 参考止损 ${fmt(side.stop, inst.dec)} / 止盈一 ${fmt(side.tp1, inst.dec)} / 止盈二 ${fmt(side.tp2, inst.dec)}`;
  toast(msg);
}

/* ---------- 开单逻辑回测 ---------- */
function setBtProg(txt) { const el = $('#btProg'); if (el) el.textContent = txt; }
function bindBacktest() {
  const btn = $('#btRun');
  if (!btn || !window.Strategy) return;
  btn.addEventListener('click', async () => {
    if (state._btRunning) return;
    const inst = instOf(state.current);
    if (!inst.sym) { setBtProg('该品种无对应可回测的交易对'); return; }
    state._btRunning = true;
    btn.disabled = true;
    btn.textContent = '回测中…';
    const bar = $('#btBar');
    if (bar) bar.style.width = '0%';
    try {
      const res = await window.Strategy.backtest(inst.sym, 5, {
        tpslFn: tpSlPlan,
        ms: msOpts(),
        onPhase: (ph, p, txt) => {
          setBtProg(txt);
          if (bar) bar.style.width = Math.max(2, Math.round(p * 100)) + '%';
        },
      });
      state._btResult = res;
      renderBacktest(res, inst);
      setBtProg(`完成 · ${res.count} 笔交易 · ${res.bars.toLocaleString('en-US')} 根 5m K线`);
    } catch (e) {
      setBtProg('回测失败：' + (e && e.message ? e.message : e));
    } finally {
      state._btRunning = false;
      btn.disabled = false;
      btn.textContent = '开始回测（5 年）';
    }
  });
}
function renderBacktest(r, inst) {
  const cards = $('#btCards'), list = $('#btList'), note = $('#btNote');
  if (!cards) return;
  const dec = inst.dec, P = v => fmt(v, dec), pct = v => (v * 100).toFixed(1) + '%';
  const cls = v => (v >= 0 ? 'txt-up' : 'txt-down');
  const pf = r.profitFactor === Infinity ? '∞' : (r.profitFactor || 0).toFixed(2);
  cards.innerHTML = `
    <div class="rc"><span class="k">交易笔数</span><b>${r.count}</b><small>多 ${r.longCount}（胜 ${r.longWin}） / 空 ${r.shortCount}（胜 ${r.shortWin}）</small></div>
    <div class="rc"><span class="k">胜率</span><b class="${r.winRate >= 0.5 ? 'txt-up' : 'txt-down'}">${pct(r.winRate)}</b><small>盈 ${r.wins} / 亏 ${r.losses}</small></div>
    <div class="rc"><span class="k">累计收益</span><b class="${cls(r.totalR)}">${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)}R</b><small>平均 ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R / 笔</small></div>
    <div class="rc"><span class="k">最大回撤</span><b class="txt-down">${pct(r.maxDD)}</b><small>固定风险 2% / 笔</small></div>
    <div class="rc"><span class="k">盈亏因子</span><b>${pf}</b><small>毛利 ÷ 毛损</small></div>
    <div class="rc"><span class="k">年化</span><b class="${cls(r.annRet)}">${r.annRet >= 0 ? '+' : ''}${(r.annRet * 100).toFixed(1)}%</b><small>${r.years.toFixed(1)} 年</small></div>
    <div class="rc"><span class="k">平均持仓</span><b>${r.avgHoldHours.toFixed(1)} 小时</b><small>${r.avgHoldBars.toFixed(0)} 根 5m</small></div>
    <div class="rc"><span class="k">样本区间</span><b>${r.spanDays.toFixed(0)} 天</b><small>${ts(r.from * 1000).slice(0, 10)} → ${ts(r.to * 1000).slice(0, 10)}</small></div>
    <div class="rc"><span class="k">5m 结构触发</span><b>${(r.msEvCount || 0).toLocaleString('en-US')}</b><small>${(r.msEvPerDay || 0).toFixed(2)} 次/天（未过 1h·15m 滤网）</small></div>
    <div class="rc"><span class="k">入场时结构分</span><b>${(r.msAvgScore || 0).toFixed(1)} / 25</b><small>${r.msLoose ? '宽松档（核心≥2）' : '严格档（CHOCH+回踩+BOS）'}${r.msMinScore ? ' · 底线 ≥' + r.msMinScore : ''}</small></div>
    <div class="rc"><span class="k">结构分底线</span><b>${r.msMinScore ? '≥' + r.msMinScore : '不限'}</b><small>${r.msAndDir ? '且 5m 方向须同向' : '不附加 5m 方向条件'}</small></div>`;

  const rows = (r.trades || []).slice(-24).reverse().map(t => {
    const howCls = t.how === '止损' || t.how === '止损（半仓）' ? 'txt-down' : 'txt-up';
    return `<div class="bt-row">
      <span>${ts(t.time * 1000).slice(5, 16)}</span>
      <b class="${t.dir === 'long' ? 'txt-up' : 'txt-down'}">${t.dir === 'long' ? '买入' : '卖出'}</b>
      <span>${P(t.entry)}</span><span>${P(t.stop)}</span><span>${P(t.tp2)}</span>
      <span class="${howCls}">${t.how}</span>
      <b class="${cls(t.r)}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R</b>
    </div>`;
  }).join('');
  if (list) {
    list.innerHTML = rows
      ? `<div class="bt-lhead"><span>时间</span><span>方向</span><span>入场</span><span>止损</span><span>止盈二</span><span>出场</span><span>盈亏</span></div>${rows}
         <div class="bt-lfoot">仅显示最近 ${Math.min(24, r.trades.length)} 笔 / 共 ${r.count} 笔</div>`
      : '<div class="bt-empty">样本内没有触发任何开单信号</div>';
  }
  if (note) {
    const srcLine = r.src === 'binance'
      ? `K线来源 <b>币安现货 ${r.market} 5m</b>（分段 ${r.segTotal} 次，失败 ${r.segFailed}）。
         Gate.io 永续免费接口只保留<b>最近 10000 根</b>（5m 仅约 ${r.cappedDays ? r.cappedDays.toFixed(0) : 35} 天），
         做不了 5 年，故长周期回测改用币安现货；实盘信号仍走 Gate 永续，两者存在<b>基差</b>（通常 &lt;0.1%，对 ATR 百分比止损影响可忽略）。`
      : `K线来源 <b>Gate.io 永续 ${r.market} 5m</b>（分段 ${r.segTotal} 次，失败 ${r.segFailed}）${r.capped ? `，该源上限最近 10000 根 ≈ ${r.cappedDays.toFixed(0)} 天，已自动截断` : ''}。`;
    note.innerHTML = `<b>数据源</b>：${srcLine}
      <br><b>口径</b>：入场 = 1h 定方向 + 15m 共振 + 5m 市场结构触发（CHOCH + 回踩守住 + BOS，严格档），
      一次共振只开一次仓；回测中 1h/15m 只取<b>已收线</b>的 K 线（避免未来函数），
      按<b>下一根 5m 开盘价</b>成交；出场 = 看板同款止盈止损（1h 方案：ATR 止损 + 止盈一/二分批），
      同一根 K 线内同时触及止盈与止损时<b>保守按止损计</b>；已扣 <b>0.10%</b> 市价手续费（开平各一次）。
      <b>R</b> = 净收益 ÷ 入场到止损的距离。权益曲线按「每笔风险 = 当前权益 2%」滚动。
      <br><b>盈亏拆解</b>：毛利 <b class="${r.grossR >= 0 ? 'txt-up' : 'txt-down'}">${r.grossR >= 0 ? '+' : ''}${r.grossR.toFixed(1)}R</b>（${(r.grossR / Math.max(1, r.count)).toFixed(3)}R/笔）
      − 手续费 <b class="txt-down">${(-r.feeR).toFixed(1)}R</b>（${r.avgFeeR.toFixed(3)}R/笔）
      = 净 ${r.totalR.toFixed(1)}R；平均止损宽度约为入场价的 <b>${(r.avgRiskPct * 100).toFixed(2)}%</b>。
      ${msBandHtml(r)}
      <br><b>提醒</b>：这是历史统计，<b>不代表未来收益</b>；滑点、资金费率与深度不足造成的成交偏差均未计入，实盘结果会更差。`;
  }
}

/* 结构总分分档表现（判断「分越高是否越值得开」） */
function msBandHtml(r) {
  const b = r.msBands || [];
  const rows = b.filter(x => x.n).map(x => `<div class="msb-row">
      <span>${x.lo}–${x.hi === 26 ? 25 : x.hi - 1}</span>
      <span>${x.n}</span>
      <span>${(x.winRate * 100).toFixed(1)}%</span>
      <b class="${x.grossAvg >= 0 ? 'txt-up' : 'txt-down'}">${x.grossAvg >= 0 ? '+' : ''}${x.grossAvg.toFixed(4)}</b>
      <b class="${x.avgR >= 0 ? 'txt-up' : 'txt-down'}">${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(4)}</b>
    </div>`).join('');
  if (!rows) return '';
  return `<br><b>结构总分分档</b>（看「分越高是否越值得开」）：
    <div class="msb-head"><span>分数段</span><span>笔数</span><span>胜率</span><span>毛利/笔</span><span>净/笔</span></div>${rows}`;
}

/* ---------- 信号 ---------- */
/* force=true 时强制重新拉取四个周期的K线（用于右上角刷新/定时刷新），
   否则沿用内存中的K线缓存（切品种、切周期时使用）。 */
async function runSignals(existingCandles, force) {
  const inst = instOf(state.current);
  const box = $('#sigMatrix'), det = $('#sigDetail'), hint = $('#sigHint');
  try {
    let results = {};
    const byTf = { _inst: state.current };
    if (inst.type === 'ust') {
      let candles = existingCandles && existingCandles.length ? existingCandles : null;
      if (!candles) candles = await ensureCandles(inst, state.tf, !!force);
      if (candles.length > 260) candles = candles.slice(-260);
      const sig = computeSignal(candles);
      TFS.forEach(tf => { results[tf] = sig; byTf[tf] = candles; });  // 美债为日频，三周期共用同一序列
    } else {
      await Promise.all(TFS.map(async tf => {
        try {
          let c = state.candles[state.current + '_' + tf];
          if (!c || state.current !== state._sigInst || force) c = await ensureCandles(inst, tf, !!force);
          results[tf] = computeSignal(c);
          state.candles[state.current + '_' + tf] = c;
          byTf[tf] = c;
        } catch (e) { results[tf] = null; }
      }));
    }
    state._sigInst = state.current;
    state.signals = results;
    state.tfCandles = byTf;
    computeTpSl();       // 依据三周期真实K线推导止盈止损区间（先算，报警里要带止损止盈）
    updateResonance();   // 开单逻辑：1h 定方向 + 15m 共振 + 5m 结构触发 → K线标记 + 报警
    renderSigCards();    // K线图下方三格交易提示（信号 + 入场区 + 止损止盈 + 一键填入）
    renderIndPanel();    // 指标全景（KDJ / MACD / 布林 / OBV / RSI / ATR）
    renderTpOvPanel();   // 止盈止损手动微调面板
    const cur = results[state.tf];
    det.innerHTML = cur ? cur.detail.map(d => `<div class="row"><span>${d[0]}</span><b>${d[1]}</b></div>`).join('')
      : '<div class="empty">暂无足够数据计算指标</div>';
    if (cur) {
      hint.style.display = '';                 // 修复：此前一旦置为 none 就再也不会恢复显示
      hint.className = 'sig-hint ' + cur.kind;
      if (cur.kind === 'buy') hint.textContent = `📈 提示：${TF_NAME[state.tf]}级别信号偏多（${cur.label}），可关注手动买入机会`;
      else if (cur.kind === 'sell') hint.textContent = `📉 提示：${TF_NAME[state.tf]}级别信号偏空（${cur.label}），注意持仓风险或考虑卖出`;
      else hint.textContent = `⏸ 提示：${TF_NAME[state.tf]}级别信号中性（观望），建议等待方向明确`;
    } else { hint.className = 'sig-hint'; hint.style.display = 'none'; }
    renderTpSl();
  } catch (e) {
    det.innerHTML = `<div class="empty">信号计算失败：${e.message}</div>`;
    renderTpSl(); renderIndPanel(); renderTpOvPanel();
  }
}

/* ---------- K线图下方：三周期交易提示（三个独立格子，整齐排列） ----------
   每格承载一个周期（5分钟 / 15分钟 / 1小时）的完整交易提示：
   信号方向与评分 · 参考入场区 · 止损 · 止盈一 / 止盈二 · 盈亏比 · ATR · 一键填入
   「用此方案」只把参数填进下单面板，不会自动下单，仍需手动点击并二次确认。 */
function renderSigCards() {
  const box = $('#sigMatrix');
  if (!box) return;
  const inst = instOf(state.current);
  const dec = inst.dec;
  const px = lastPrice(inst.id);
  const t = state.tpsl;
  const isUst = inst.type === 'ust';
  const P = v => (v == null ? '—' : fmt(v, dec) + (isUst ? ' %' : ''));
  const planOf = tf => (t && t.inst === state.current) ? t.plans.find(x => x.tf === tf) : null;
  /* 右侧百分比按「持仓方向」折算，而不是单纯的价格方向距离：
     做空时价格下跌才是盈利，所以止损（在上方）显示负值、止盈（在下方）显示正值。 */
  const dTxt = (v, dir) => {
    if (v == null || px == null || !px) return '';
    let d = (v - px) / px * 100;
    if (dir === 'short') d = -d;
    return `<small class="${d >= 0 ? 'txt-up' : 'txt-down'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</small>`;
  };

  box.innerHTML = TFS.map(tf => {
    const s = state.signals[tf];
    const p = planOf(tf);
    const active = tf === state.tf;
    if (!s) {
      return `<div class="sc-card${active ? ' active' : ''}">
        <div class="sc-top"><span class="sc-tf">${TF_NAME[tf]}</span><span class="sc-score">—</span></div>
        <div class="sc-sig wait">数据不足</div>
        <div class="sc-rows"><div class="sc-r"><span>提示</span><b>等待K线加载…</b></div></div>
      </div>`;
    }
    const kind = s.kind;                                   // buy | sell | wait
    const isWait = p && p.dir === 'wait';
    const cls = isWait ? 'wait' : (kind === 'buy' ? 'up' : kind === 'sell' ? 'down' : 'wait');
    const score = (s.score >= 0 ? '+' : '') + s.score.toFixed(2);
    const rows = [];
    if (isWait) {
      rows.push(`<div class="sc-r"><span>震荡区间</span><b>${P(p.swLow)} ~ ${P(p.swHigh)}</b></div>`);
      rows.push(`<div class="sc-r"><span>操作建议</span><b>区间高抛低吸</b></div>`);
    } else if (p) {
      rows.push(`<div class="sc-r"><span>入场区</span><b>${P(p.entryLo)} ~ ${P(p.entryHi)}</b></div>`);
      rows.push(`<div class="sc-r"><span>预计入场</span><b>${P(p.entry)}</b><small>盈亏比按此价计</small></div>`);
      const mk = f => (p.ovF && p.ovF[f]) ? '<i class="ov-dot" title="手动微调值">✎</i>' : '';
      rows.push(`<div class="sc-r"><span>止损${mk('stop')}</span><b class="txt-down">${P(p.stop)}</b>${dTxt(p.stop, p.dir)}</div>`);
      rows.push(`<div class="sc-r"><span>止盈一${mk('tp1')}</span><b class="txt-up">${P(p.tp1)}</b>${dTxt(p.tp1, p.dir)}</div>`);
      rows.push(`<div class="sc-r"><span>止盈二${mk('tp2')}</span><b class="txt-up">${P(p.tp2)}</b>${dTxt(p.tp2, p.dir)}</div>`);
    } else {
      rows.push(`<div class="sc-r"><span>提示</span><b>止损止盈计算中…</b></div>`);
    }
    const meta = [];
    if (p) meta.push(`ATR ${(p.atrPct * 100).toFixed(2)}%`);
    if (p && p.dir !== 'wait') {
      const e = p.rr1Entry == null ? p.rr1 : p.rr1Entry;
      const n = p.rr1Net == null ? 0 : p.rr1Net;
      meta.push(`盈亏比 <b>1:${e.toFixed(1)}</b><small>（参考价 1:${p.rr1.toFixed(1)} · 扣费净 1:${n.toFixed(1)}）</small>`);
    }
    return `<div class="sc-card ${cls}${active ? ' active' : ''}">
      <div class="sc-top">
        <span class="sc-tf">${TF_NAME[tf]}</span>
        <span class="sc-score ${cls}">${score}</span>
      </div>
      <div class="sc-sig ${cls}">${isWait ? '观望 · 震荡' : s.label}</div>
      <div class="sc-rows">${rows.join('')}</div>
      <div class="sc-foot">
        <span class="sc-meta">${meta.join(' · ')}</span>
        <button class="btn-xs" data-use="${tf}" title="按该周期方案填入限价委托价与数量（仍需二次确认）">用此方案</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => applyTpSlPlan(b.dataset.use)));
}

/* ---------- 实时价格轮询（兜底） ---------- */
const MAIN_SYMS = INSTRUMENTS.filter(i => i.sym).map(i => i.sym);
async function pollPrices() {
  try {
    const prices = await fetchPrices(MAIN_SYMS);
    const symMap = SYM_MAP;
    Object.entries(prices).forEach(([sym, p]) => {
      const id = symMap[sym];
      if (!id) return;
      state.prevPrices[id] = state.prices[id];
      state.prices[id] = p;
      observeTrade(id, p);              // 轮询价格同样计入真实成交轨迹
    });
    // 24h 涨跌幅（走独立的多源降级，与主价格源解耦）
    try {
      const chg = await fetchDayChange(MAIN_SYMS);
      Object.entries(chg).forEach(([sym, v]) => {
        const id = symMap[sym];
        if (id && !isNaN(v)) state.dayChange[id] = v;
      });
    } catch (e) { /* 24h 涨跌只是辅助展示，失败不影响主流程 */ }
    setConnState(true);
  } catch (e) {
    setConnState(false);
  }
  // 美债最新值（低频）
  fetchTreasuryYields().then(d => {
    INSTRUMENTS.filter(i => i.type === 'ust').forEach(i => {
      const s = d[i.id.toLowerCase()];
      if (s && s.series.length) {
        const v = s.series[s.series.length - 1];
        state.prices[i.id] = v; observeTrade(i.id, v);
      }
    });
  }).catch(() => {});
  consumeTicks();
  updatePricePanel(); updateWatchlist(); renderPositions(); renderEst();
  renderTpSl();
  updateSigFromPrice();
  renderDataSource();      // 数据来自哪个源、是否降级为离线快照
}
function setConnState(ok) {
  const el = $('#connStatus'); if (!el) return;
  if (state.wsAlive) { el.className = 'conn ok'; el.innerHTML = '<span class="dot"></span>实时逐笔行情已连接'; return; }
  el.className = 'conn ' + (ok ? 'ok' : 'bad');
  el.innerHTML = ok ? '<span class="dot"></span>行情连接正常（轮询模式）' : '<span class="dot"></span>行情连接中断，重试中…';
}

/* ---------- 实时逐笔成交推送（WebSocket，限价单撮合的实时数据源） ----------
   推送必须与当前主源同口径：K线、下单、强平都用永续价，实时成交就不能混进现货价，
   否则限价单会被另一个市场的成交价误触发。所以推送地址跟着主源走。 */
const WS_GATE_PERP = ['wss://fx-ws.gateio.ws/v4/ws/usdt'];
let wsConn = null, wsPlan = null, wsHostIdx = 0, wsRetryN = 0, wsRetryTimer = null,
    wsManuallyClosed = false, wsPingTimer = null;

/* 只有一条路：Gate.io USDT 永续成交推送，与 K线/下单/强平同口径 */
function wsPlanFor() {
  return { type: 'gate', market: 'futures', host0: WS_GATE_PERP[0], hosts: WS_GATE_PERP };
}
function wsStreamUrl(plan) { return plan.hosts[wsHostIdx]; }
function gateWsChannel() { return 'futures.trades'; }
function gateContracts() {
  return INSTRUMENTS.filter(i => i.sym && GATE_FUT_PAIR[i.sym]).map(i => GATE_FUT_PAIR[i.sym]);
}
/* 单笔成交落账：价格进状态、参与撮合与强平 */
function applyTick(id, p) {
  if (state.prices[id] !== p) state.prevPrices[id] = state.prices[id];
  state.prices[id] = p;
  observeTrade(id, p);
  consumeTicks();                    // 每一笔真实成交都立刻参与限价单撮合
  uiDirty = true;
}
function connectTradeStream() {
  if (typeof WebSocket === 'undefined') return;   // 环境不支持则退回轮询
  const plan = wsPlanFor();
  wsPlan = plan;
  let url;
  try { url = wsStreamUrl(plan); } catch (e) { scheduleWsRetry(); return; }
  try { wsConn = new WebSocket(url); } catch (e) { scheduleWsRetry(); return; }
  wsConn.onopen = () => {
    state.wsAlive = true; wsRetryN = 0; setConnState(true);
    try {
      wsConn.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000), channel: gateWsChannel(),
        event: 'subscribe', payload: gateContracts(),
      }));
    } catch (e) {}
    clearInterval(wsPingTimer);                   // Gate 需要客户端心跳保活
    wsPingTimer = setInterval(() => {
      if (wsConn && wsConn.readyState === 1) {
        try { wsConn.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' })); } catch (e) {}
      }
    }, 25000);
  };
  wsConn.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    const res = d && (d.result || (d.data && d.data.result));
    if (!Array.isArray(res)) return;
    res.forEach(t => {
      const key = t.contract || t.currency_pair;
      if (!key) return;
      const sym = Object.keys(GATE_FUT_PAIR).find(k => GATE_FUT_PAIR[k] === key);
      const id = sym ? SYM_MAP[sym] : null;
      const p = parseFloat(t.price);
      if (!id || !(p > 0)) return;
      applyTick(id, p);
    });
  };
  wsConn.onerror = () => {};
  wsConn.onclose = () => {
    state.wsAlive = false;
    clearInterval(wsPingTimer);
    if (!wsManuallyClosed) scheduleWsRetry();
  };
}
function scheduleWsRetry() {
  if (wsRetryTimer) return;
  wsRetryN++;
  if (wsRetryN > 3 && wsPlan) wsHostIdx = (wsHostIdx + 1) % wsPlan.hosts.length;
  const delay = Math.min(30000, 2000 * wsRetryN);
  wsRetryTimer = setTimeout(() => { wsRetryTimer = null; connectTradeStream(); }, delay);
}

/* 撮合 + 强平（每一笔成交推送都触发），UI 刷新限流到 1 秒一次 */
let uiDirty = false;
function consumeTicks() {
  const ordChanged = checkPendingOrders();
  const liqChanged = checkLiquidation();
  if (ordChanged || liqChanged) {
    saveAcct(); renderPositions(); renderOrders(); updatePricePanel(); renderEst();
  }
}
function startTickLoops() {
  setInterval(() => {                  // 逐笔推送下的界面节流刷新
    if (state.wsAlive && (state.acct.orders || []).length) renderOrders(); // 刷新“还差多少才触发”
    if (!uiDirty) return; uiDirty = false;
    updatePricePanel(); updateWatchlist(); renderPositions();
    renderTpSl();                      // 止盈止损提示随实时价格刷新距离与状态
  }, 1000);
}
function updatePricePanel() {
  const inst = instOf(state.current);
  const p = lastPrice(inst.id);
  $('#instName').textContent = inst.name;
  const srcTag = $('#instSrcTag');
  if (srcTag) srcTag.textContent = venueTagOf(inst);
  const vm = $('#venueMain');
  if (vm) vm.textContent = inst.type === 'ust' ? '美国财政部' : 'Gate.io 永续';
  $('#bigPrice').textContent = p == null ? '—' : (inst.type === 'ust' ? fmt(p, 3) + ' %' : fmt(p, inst.dec));
  const chg = state.dayChange[inst.id];
  const box = $('#chgBox');
  if (chg != null) { box.innerHTML = `${fmtPct(chg / 100)}<div style="font-size:11px;color:var(--muted)">24小时涨跌</div>`; box.style.color = upDownColor(chg); }
  else box.innerHTML = inst.type === 'ust' ? '<div style="font-size:11px;color:var(--muted)">日频数据</div>' : '—';
  $('#updateTime').textContent = '更新于 ' + ts(Date.now());
  renderVenueList();
  // 资金面板
  $('#cashVal').textContent = fmt(state.acct.cash, 2) + ' USDT';
  $('#equityVal').textContent = fmt(acctEquity(), 2) + ' USDT';
  $('#marginVal').textContent = fmt(posMarginUsed() + frozenMargin(), 2) + ' USDT';
  $('#freeVal').textContent = fmt(state.acct.cash, 2) + ' USDT';
}

/* ---------- 多平台实时价格对比（区分来源平台与价差） ----------
   幂等渲染：把「上次渲染的签名」记在容器自身的 dataset 上（而非模块级变量），
   这样即使容器被外部清空/重建，也不会出现「签名相同但 DOM 是空的」而不重绘的问题。 */
function renderVenueList() {
  const box = $('#venueList');
  if (!box) return;
  const inst = instOf(state.current);
  const sigOf = (box.dataset && box.dataset.vsig) || '';

  if (inst.type === 'ust') {
    if (sigOf === 'ust' && box.innerHTML) return;
    if (box.dataset) box.dataset.vsig = 'ust';
    box.innerHTML = `<div class="vn-empty">美债收益率为 <b>美国财政部</b> 单一官方来源（日频），无多平台报价</div>`;
    return;
  }
  const qs = state.venueQuotes[inst.id];
  const rows = qs ? VENUES.filter(v => qs[v.key]).map(v => ({
    v, q: qs[v.key], diff: (qs[v.key].px - qs.gate.px) / qs.gate.px * 100,
    chg: qs[v.key].open24h ? (qs[v.key].px - qs[v.key].open24h) / qs[v.key].open24h * 100 : null,
  })) : [];
  if (!rows.length) {
    if (sigOf === 'loading' && box.innerHTML) return;
    if (box.dataset) box.dataset.vsig = 'loading';
    box.innerHTML = `<div class="vn-empty">多平台比价加载中…（Gate.io 永续 / OKX / Coinbase / Bitstamp）</div>`;
    return;
  }
  const sig = state.current + '|' + rows.map(r => r.v.key + ':' + r.q.px).join(',');
  if (sig === sigOf && box.innerHTML) return;      // 签名一致且 DOM 仍在 → 跳过重绘
  if (box.dataset) box.dataset.vsig = sig;

  const sorted = rows.slice().sort((a, b) => a.q.px - b.q.px);       // 价格由低到高
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const spread = (hi.q.px - lo.q.px) / lo.q.px * 100;
  const dec = inst.dec;
  const rowHtml = sorted.map(r => {
    const isMain = r.v.primary;
    const dtxt = isMain ? '—' : `${r.diff > 0 ? '+' : ''}${r.diff.toFixed(3)}%`;
    const dcls = isMain ? 'vn-df' : (r.diff > 0 ? 'txt-up' : 'txt-down');
    return `<div class="vn-row ${isMain ? 'primary' : ''}">
      <span class="vn-nm">${r.v.name}${isMain ? '<small>主源</small>' : ''}</span>
      <span class="vn-px">${fmt(r.q.px, dec)}</span>
      <span class="vn-cg ${r.chg == null ? '' : (r.chg >= 0 ? 'txt-up' : 'txt-down')}">${r.chg == null ? '—' : fmtPct(r.chg / 100)}</span>
      <span class="vn-df ${dcls}">${dtxt}</span>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="vn-head"><span>平台</span><span>实时价</span><span>24h</span><span>vs主源</span></div>
    ${rowHtml}
    <div class="vn-bar">跨平台价差 <b>${spread.toFixed(3)}%</b> · 最低 <b>${lo.v.name}</b> ${fmt(lo.q.px, dec)} · 最高 <b>${hi.v.name}</b> ${fmt(hi.q.px, dec)}</div>
    <div class="vn-note">仅 <b>Gate.io 永续主源</b>价格参与限价撮合与强平；其余平台仅作比价参考</div>`;
}
/* 刷新当前品种的多平台比价（仅取当前品种，避免一次打 16 个第三方接口） */
async function refreshVenues(force) {
  const inst = instOf(state.current);
  if (!inst.venues) { renderVenueList(); return; }
  try { await ensureVenueQuotes(inst, !!force); } catch (e) { /* 保留旧数据 */ }
  renderVenueList();
  updateWatchlist();
}

function updateSigFromPrice() { /* 实时价主要刷新图表最后蜡烛与持仓盈亏，信号按周期重算 */ }

/* ---------- 下单：市价 / 限价 · 杠杆 · 二次确认 ---------- */
function renderLeverBtns() {
  const box = $('#leverBtns');
  if (!LEVERS.includes(state.lever)) state.lever = LEVER_DEFAULT;   // 档位精简后兜底，避免无高亮
  box.innerHTML = LEVERS.map(l => `<button data-lev="${l}" class="${l === state.lever ? 'active' : ''}">${l}x</button>`).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.lever = +b.dataset.lev; renderLeverBtns(); renderEst();
  }));
}
function setOrderType(t) {
  state.orderType = t;
  document.querySelectorAll('#orderType button').forEach(x => x.classList.toggle('active', x.dataset.ot === t));
  $('#limitPriceRow').style.display = t === 'limit' ? 'flex' : 'none';
  $('#limitTip').style.display = t === 'limit' ? 'block' : 'none';
  if (t === 'limit') { const p = lastPrice(state.current); $('#orderPrice').value = p == null ? '' : +p.toFixed(instOf(state.current).dec); }
  renderEst();
}
function renderEst() {
  const box = $('#orderEst');
  const inst = instOf(state.current);
  const px = lastPrice(inst.id);
  if (px == null) { box.innerHTML = '等待行情…'; return; }
  const type = state.orderType, lev = state.lever;
  const feeRate = type === 'limit' ? FEE_MAKER : FEE_TAKER;
  const ordP = type === 'limit' ? (parseFloat($('#orderPrice').value) || px) : px;
  const avail = state.acct.cash;
  const maxQ = maxQtyFor(ordP, lev, feeRate, avail);
  const qty = parseFloat($('#orderQty').value) || 0;
  // 限价单：提示触发方向与距离（只挂单，不立即成交）
  let limitTip = '';
  if (type === 'limit') {
    const diff = (ordP - px) / px * 100;
    if (Math.abs(diff) < 1e-9) limitTip = ' <span class="txt-warn">委托价 = 现价，无法挂单：买入须低于现价、卖出须高于现价</span>';
    else if (diff < 0) limitTip = ` · 买入方向可挂：需行情跌至 ${pxText(inst, ordP)}（还差 ${Math.abs(diff).toFixed(2)}%）才成交`;
    else limitTip = ` · 卖出方向可挂：需行情涨至 ${pxText(inst, ordP)}（还差 ${Math.abs(diff).toFixed(2)}%）才成交`;
  }
  if (!qty || qty <= 0) {
    box.innerHTML = `可用 <b>${fmt(avail, 2)}</b> USDT · ${lev}x 下最多约可开 <b>${fmt(roundStep(maxQ, inst.qtyStep), 4)}</b> ${inst.short}
      <br>市价 0.10% / 限价 0.05% 手续费 · 强平价：多 <b>${fmt(orderLiq(ordP, lev, true), inst.dec)}</b> · 空 <b>${fmt(orderLiq(ordP, lev, false), inst.dec)}</b>${limitTip}`;
    return;
  }
  const notional = qty * ordP, margin = notional / lev, fee = notional * feeRate;
  const okTxt = margin + fee <= avail + 1e-9 ? '' : ' <span class="txt-down">（超出可用余额）</span>';
  box.innerHTML = `名义价值 <b>${fmt(notional, 2)}</b> · 保证金 <b>${fmt(margin, 2)}</b> · 手续费 <b>${fmt(fee, 2)}</b> USDT${okTxt}
    <br>预估强平价：多 <b>${fmt(orderLiq(ordP, lev, true), inst.dec)}</b> · 空 <b>${fmt(orderLiq(ordP, lev, false), inst.dec)}</b>${limitTip}`;
}
function pxText(inst, v) { return v == null ? '—' : fmt(v, inst.dec) + (inst.type === 'ust' ? ' %' : ''); }

function openPosition(inst, side, qty, price, margin) {
  const exist = state.acct.positions.find(p => p.inst === inst.id && p.side === side);
  if (exist) {
    exist.entry = (exist.entry * exist.qty + price * qty) / (exist.qty + qty);
    exist.qty += qty; exist.margin += margin;
    exist.time = Date.now();
  } else {
    state.acct.positions.push({ id: uid(), inst: inst.id, side, qty, entry: price, margin, time: Date.now() });
  }
}

/* 平仓结算（支持部分平仓，按比例释放保证金） */
function settleClose(pos, qty, price, feeRate, tag) {
  const dir = posDir(pos);
  const relMargin = pos.margin * (qty / pos.qty);
  const pnl = (price - pos.entry) * qty * dir;
  const fee = qty * price * feeRate;
  state.acct.cash += relMargin + pnl - fee;
  state.acct.history.unshift({
    inst: pos.inst, side: dir > 0 ? '平多' : '平空', qty, price,
    amount: qty * price, pnl: pnl - fee, fee, time: Date.now(), tag: tag || '',
  });
  pos.qty -= qty; pos.margin -= relMargin;
  if (pos.qty <= 1e-9) {
    state.acct.positions = state.acct.positions.filter(x => x !== pos);
    state.acct.orders = state.acct.orders.filter(o => o.posId !== pos.id);
  }
  return { pnl: pnl - fee, relMargin };
}

async function doOrder(side) {
  const inst = instOf(state.current);
  const px = lastPrice(inst.id);
  if (px == null) { toast('暂无实时价格，无法下单'); return; }

  const type = state.orderType, lev = state.lever;
  const isBuy = side === 'buy';
  const qty = parseFloat($('#orderQty').value);
  const ordPrice = type === 'limit' ? parseFloat($('#orderPrice').value) : px;

  if (!qty || qty <= 0) { toast('请先输入下单数量（可用 25%/50%/75%/100% 快捷设置）'); return; }
  if (type === 'limit' && (!ordPrice || ordPrice <= 0)) { toast('限价单请先输入委托价格'); return; }
  if (type === 'limit' && Math.abs(ordPrice - px) / px > 0.5) { toast('委托价与现价偏离超过 50%，请检查价格'); return; }

  const feeRate = type === 'limit' ? FEE_MAKER : FEE_TAKER;
  const avail = state.acct.cash;

  // ★ 限价单核心规则：一律挂单等待，绝不立即成交。
  //   必须挂在行情尚未到达的一侧，之后由实时成交价真正走到该价位才撮合。
  const willFill = type === 'market';
  if (type === 'limit') {
    const eps = px * 1e-6;
    if (isBuy && ordPrice >= px - eps) {
      toast(`限价买入价必须低于现价 ${pxText(inst, px)}：挂单后需等行情跌到该价位才成交；想立刻成交请用市价单`);
      return;
    }
    if (!isBuy && ordPrice <= px + eps) {
      toast(`限价卖出价必须高于现价 ${pxText(inst, px)}：挂单后需等行情涨到该价位才成交；想立刻成交请用市价单`);
      return;
    }
  }
  // 市价单按最新成交价成交；限价单按委托价成交（成交发生在行情触及委托价的那一刻）
  const fillPx = willFill ? px : ordPrice;
  const fillNotional = qty * fillPx;
  const fillMargin = fillNotional / lev;
  const fillFee = fillNotional * feeRate;
  const need = fillMargin + fillFee;
  const dirTxt = isBuy ? '开多（买入）' : '开空（卖出）';
  const gapPct = Math.abs(ordPrice - px) / px * 100;

  if (need > avail + 1e-9) {
    toast(`可用余额不足：需 ${fmt(need, 2)} USDT，可用 ${fmt(avail, 2)} USDT · ${lev}x 下最多约可开 ${fmt(roundStep(maxQtyFor(fillPx, lev, feeRate, avail), inst.qtyStep), 4)} ${inst.short}`);
    return;
  }

  const rows = [
    { k: '交易品种', v: inst.name },
    { k: '下单方向', v: dirTxt, cls: isBuy ? 'txt-up' : 'txt-down' },
    { k: '订单类型', v: type === 'limit' ? '限价单 · Maker 0.05% · 挂单等待' : '市价单 · Taker 0.10% · 立即成交' },
    { k: '委托价格', v: type === 'limit' ? pxText(inst, ordPrice) : '市价 ' + pxText(inst, px) },
    ...(type === 'limit' ? [{
      k: '成交触发条件',
      v: (isBuy ? '实时成交价跌至 ≤ ' : '实时成交价涨至 ≥ ') + pxText(inst, ordPrice)
        + `（现价 ${pxText(inst, px)}，需${isBuy ? '下跌' : '上涨'} ${fmt(gapPct, 2)}% 才会成交）`,
      cls: 'txt-warn',
    }] : []),
    { k: '下单数量', v: qty + ' ' + inst.short },
    { k: '杠杆倍数', v: lev + 'x' },
    { k: '名义价值', v: fmt(fillNotional, 2) + ' USDT' },
    { k: '占用保证金', v: fmt(fillMargin, 2) + ' USDT' },
    { k: '预估手续费', v: fmt(fillFee, 2) + ' USDT' },
    { k: '预估强平价', v: pxText(inst, orderLiq(fillPx, lev, isBuy)) },
    { k: '下单后可用余额', v: fmt(avail - fillMargin - fillFee, 2) + ' USDT' },
    ...tpSlRefRows(isBuy),
    { k: '成交方式', v: type === 'market' ? '立即以最新成交价成交' : '仅挂单，不立即成交；实时行情触及委托价后才成交' },
  ];

  const ok = await confirmYes({
    title: '二次确认 · ' + dirTxt,
    icon: isBuy ? '↑' : '↓',
    btnStyle: isBuy ? 'up' : 'down',
    yesText: '是 · 确认' + (willFill ? '下单' : '挂单'),
    noText: '否 · 取消',
    rows,
    warn: type === 'limit'
      ? `模拟盘挂单，不涉及真实资金。委托将一直挂起到实时行情${isBuy ? '下跌' : '上涨'}到 ${pxText(inst, ordPrice)} 才成交；未成交前可随时撤单并全额退回保证金。${lev}x 杠杆风险极高。`
      : `模拟盘操作，不涉及真实资金。${lev}x 杠杆下价格反向波动约 ${(100 / lev).toFixed(1)}% 即触发强制平仓，风险极高。`,
  });
  if (!ok) { toast('已取消下单，未产生任何委托'); return; }
  if (need > state.acct.cash + 1e-9) { toast('可用余额已变化，下单已取消，请重新确认'); renderEst(); return; }

  state.acct.cash -= need;
  if (willFill) {
    openPosition(inst, isBuy ? 'long' : 'short', qty, fillPx, fillMargin);
    state.acct.history.unshift({
      inst: inst.id, side: isBuy ? '开多' : '开空', qty, price: fillPx,
      amount: fillNotional, pnl: null, fee: fillFee, time: Date.now(), tag: '市价',
    });
    toast(`✅ 市价${dirTxt}成交：${qty} ${inst.short} @ ${pxText(inst, fillPx)} · 保证金 ${fmt(fillMargin, 2)} USDT`);
  } else {
    state.acct.orders.push({
      id: uid(), inst: inst.id, kind: 'open', side, price: ordPrice, qty, lev,
      margin: fillMargin, fee: fillFee, frozenFee: fillFee, time: Date.now(),
      placedPx: px, armedAt: Date.now(), armedSeq: state.tickSeq,
    });
    toast(`📌 挂单成功（未成交）：${dirTxt} ${qty} ${inst.short} @ ${pxText(inst, ordPrice)} · 现价需${isBuy ? '跌' : '涨'} ${fmt(gapPct, 2)}% 触及后才会成交`);
  }
  $('#orderQty').value = '';
  saveAcct(); renderPositions(); renderOrders(); updatePricePanel(); renderEst();
}

/* ---------- 平仓：市价 / 限价 + 二次确认 ---------- */
async function openCloseDialog(posId) {
  const pos = state.acct.positions.find(p => p.id === posId);
  if (!pos) { toast('持仓不存在或已平仓'); return; }
  const inst = instOf(pos.inst);
  const px = lastPrice(pos.inst);
  if (px == null) { toast('暂无实时价格，无法平仓'); return; }

  const dirTxt = pos.side === 'long' ? '多头' : '空头';
  const pnl = posPnl(pos, px);
  const availClose = Math.max(0, pos.qty - pendCloseQty(pos.id));
  if (availClose <= 1e-9) { toast('该持仓已全部挂出限价平仓委托，请先撤销委托'); return; }
  const pr = posRoi(pos, px);

  const rows = [
    { k: '持仓品种', v: inst.name + ' · ' + dirTxt, cls: pos.side === 'long' ? 'txt-up' : 'txt-down' },
    { k: '持仓数量', v: pos.qty + ' ' + inst.short + (pendCloseQty(pos.id) > 0 ? `（已挂平仓委托 ${pendCloseQty(pos.id)}）` : '') },
    { k: '开仓价 / 现价', v: pxText(inst, pos.entry) + ' → ' + pxText(inst, px) },
    { k: '杠杆 / 保证金', v: posLev(pos).toFixed(0) + 'x / ' + fmt(pos.margin, 2) + ' USDT' },
    { k: '强平价', v: pxText(inst, liqPrice(pos)) },
    { k: '浮动盈亏', v: (pnl >= 0 ? '+' : '') + fmt(pnl, 2) + ' USDT（' + (pr >= 0 ? '+' : '') + (pr * 100).toFixed(2) + '%）', cls: upDownClass(pnl) },
  ];

  const bodyHtml = `
    <div class="seg" id="closeType" style="margin-top:14px">
      <button data-ct="market" class="active">市价平仓</button>
      <button data-ct="limit">限价平仓</button>
    </div>
    <label class="of-row" id="closePriceRow" style="display:none">
      <span>平仓价</span><input type="number" id="closePrice" class="md-input" step="any" value="${+px.toFixed(inst.dec)}">
    </label>
    <label class="of-row"><span>平仓数量</span><input type="number" id="closeQty" class="md-input" step="any" value="${availClose}"></label>
    <div class="pct-row">
      <button data-cp="0.25">25%</button><button data-cp="0.5">50%</button>
      <button data-cp="0.75">75%</button><button data-cp="1">全部</button>
    </div>
    <div class="of-tip" id="closeTip">限价平仓：委托价达到后自动成交，未成交前可在「当前委托」撤销</div>`;

  const r = await confirmDialog({
    title: '平仓确认 · ' + inst.short + ' ' + dirTxt,
    icon: '!',
    btnStyle: pos.side === 'long' ? 'up' : 'down',
    yesText: '是 · 确认平仓',
    noText: '否 · 取消',
    rows, bodyHtml,
    warn: '平仓为不可逆操作，请确认品种、方向与数量无误。市价平仓立即以当前价格成交；限价平仓将转为挂单等待成交。',
    onRender: (c) => {
      c.querySelectorAll('#closeType button').forEach(b => b.addEventListener('click', () => {
        c.querySelectorAll('#closeType button').forEach(x => x.classList.toggle('active', x === b));
        const isLimit = b.dataset.ct === 'limit';
        c.querySelector('#closePriceRow').style.display = isLimit ? 'flex' : 'none';
        c.querySelector('#closeTip').textContent = isLimit
          ? (pos.side === 'long' ? '限价平仓（多单）：委托价必须高于现价，挂单后行情真正涨到委托价才成交' : '限价平仓（空单）：委托价必须低于现价，挂单后行情真正跌到委托价才成交')
          : '市价平仓：立即以当前最新价成交，手续费 0.10%';
        $('#mdYes').textContent = isLimit ? '是 · 确认挂单' : '是 · 确认平仓';
      }));
      c.querySelectorAll('.pct-row button').forEach(b => b.addEventListener('click', () => {
        c.querySelector('#closeQty').value = roundStep(availClose * parseFloat(b.dataset.cp), inst.qtyStep);
      }));
    },
    validate: (c) => {
      const t = c.querySelector('#closeType button.active').dataset.ct;
      const q = parseFloat(c.querySelector('#closeQty').value);
      if (!q || q <= 0) return '请输入有效的平仓数量';
      if (q > availClose + 1e-9) return `平仓数量不能超过可平数量 ${availClose} ${inst.short}`;
      if (t === 'limit') {
        const p = parseFloat(c.querySelector('#closePrice').value);
        if (!p || p <= 0) return '请输入限价平仓价格';
        if (pos.side === 'long' && p <= px) return `多头限价平仓价必须高于现价 ${pxText(inst, px)}（限价单只挂单不立即成交，需等行情涨到该价）`;
        if (pos.side === 'short' && p >= px) return `空头限价平仓价必须低于现价 ${pxText(inst, px)}（限价单只挂单不立即成交，需等行情跌到该价）`;
      }
      return null;
    },
    collect: (c) => ({
      type: c.querySelector('#closeType button.active').dataset.ct,
      qty: parseFloat(c.querySelector('#closeQty').value),
      price: parseFloat(c.querySelector('#closePrice').value),
    }),
  });
  if (!r.ok) { toast('已取消平仓操作'); return; }
  if (!state.acct.positions.includes(pos)) { toast('该持仓已不存在（可能已触发强制平仓）'); renderPositions(); return; }

  const { type, qty, price } = r.data;
  if (type === 'market') {
    const res = settleClose(pos, qty, px, FEE_TAKER, '市价平仓');
    toast(`✅ 市价平仓完成：${qty} ${inst.short} @ ${pxText(inst, px)} · 盈亏 ${res.pnl >= 0 ? '+' : ''}${fmt(res.pnl, 2)} USDT`);
  } else {
    state.acct.orders.push({
      id: uid(), inst: pos.inst, kind: 'close', posId: pos.id,
      side: pos.side === 'long' ? 'sell' : 'buy',
      price, qty, time: Date.now(), placedPx: px, armedAt: Date.now(), armedSeq: state.tickSeq,
    });
    toast(`📌 已挂限价平仓单（未成交）：${qty} ${inst.short} @ ${pxText(inst, price)} · 需行情${pos.side === 'long' ? '上涨' : '下跌'} ${fmt(Math.abs(price - px) / px * 100, 2)}% 触及后才成交`);
  }
  saveAcct(); renderPositions(); renderOrders(); updatePricePanel();
}

/* ---------- 委托撮合 / 强平风控 ---------- */
function removeOrder(id) { state.acct.orders = state.acct.orders.filter(o => o.id !== id); }
/* 限价单撮合：以下单之后的「真实成交价轨迹」为唯一依据
   - 买入方向（限价开多 / 限价平空）：行情必须真正跌到委托价 → 期间最低成交价 ≤ 委托价
   - 卖出方向（限价开空 / 限价平多）：行情必须真正涨到委托价 → 期间最高成交价 ≥ 委托价
   下单瞬间的现价不算触发（委托价只能挂在尚未到达的一侧），因此不会出现“直接成交”。 */
function orderHit(o) {
  const { hi, lo } = tradedRangeSince(o.inst, o.armedSeq || 0);
  if (lo === Infinity && hi === -Infinity) return false;
  const tol = 1e-9;
  return o.side === 'buy' ? lo <= o.price * (1 + tol) : hi >= o.price * (1 - tol);
}
function checkPendingOrders() {
  if (!state.acct.orders || !state.acct.orders.length) return false;
  let changed = false;
  for (const o of [...state.acct.orders]) {
    const inst = instOf(o.inst);
    if (lastPrice(o.inst) == null) continue;
    if (!orderHit(o)) continue;
    if (o.kind === 'open') {
      openPosition(inst, o.side === 'buy' ? 'long' : 'short', o.qty, o.price, o.margin);
      state.acct.history.unshift({
        inst: o.inst, side: o.side === 'buy' ? '开多' : '开空', qty: o.qty, price: o.price,
        amount: o.qty * o.price, pnl: null, fee: o.fee, time: Date.now(), tag: '限价成交',
      });
      removeOrder(o.id); changed = true;
      toast(`🔔 限价挂单成交（行情已触及委托价）：${o.side === 'buy' ? '开多' : '开空'} ${o.qty} ${inst.short} @ ${pxText(inst, o.price)}`);
    } else {
      const pos = state.acct.positions.find(p => p.id === o.posId);
      if (!pos) { removeOrder(o.id); changed = true; toast('委托已失效：对应持仓已平，已自动撤单'); continue; }
      const q = Math.min(o.qty, pos.qty);
      const res = settleClose(pos, q, o.price, FEE_MAKER, '限价平仓');
      removeOrder(o.id); changed = true;
      toast(`🔔 限价平仓成交（行情已触及委托价）：${q} ${inst.short} @ ${pxText(inst, o.price)} · 盈亏 ${res.pnl >= 0 ? '+' : ''}${fmt(res.pnl, 2)} USDT`);
    }
  }
  return changed;
}
function checkLiquidation() {
  if (!state.acct.positions.length) return false;
  let changed = false;
  for (const pos of [...state.acct.positions]) {
    const px = lastPrice(pos.inst);
    if (px == null) continue;
    const lp = liqPrice(pos);
    const hit = pos.side === 'long' ? px <= lp : px >= lp;
    if (!hit) continue;
    const inst = instOf(pos.inst);
    const pnl = (px - pos.entry) * pos.qty * posDir(pos);
    const fee = pos.qty * px * FEE_TAKER;
    const remain = Math.max(0, pos.margin + pnl - fee);
    state.acct.cash += remain;
    state.acct.history.unshift({
      inst: pos.inst, side: pos.side === 'long' ? '强平多' : '强平空', qty: pos.qty, price: px,
      amount: pos.qty * px, pnl: remain - pos.margin, fee, time: Date.now(), tag: '强制平仓',
    });
    state.acct.positions = state.acct.positions.filter(x => x !== pos);
    state.acct.orders = state.acct.orders.filter(o => o.posId !== pos.id);
    changed = true;
    toast(`⚠️ ${inst.short} ${pos.side === 'long' ? '多' : '空'}单已触发强制平仓（强平价 ${pxText(inst, lp)}），剩余保证金 ${fmt(remain, 2)} USDT`);
  }
  return changed;
}
async function cancelOrder(id) {
  const o = state.acct.orders.find(x => x.id === id);
  if (!o) return;
  const inst = instOf(o.inst);
  const isOpen = o.kind === 'open';
  const ok = await confirmYes({
    title: '撤销委托确认',
    icon: '×',
    danger: true,
    yesText: '是 · 确认撤单',
    noText: '否 · 取消',
    rows: [
      { k: '交易品种', v: inst.name },
      { k: '委托类型', v: isOpen ? (o.side === 'buy' ? '限价开多' : '限价开空') : (o.side === 'sell' ? '限价平多' : '限价平空') },
      { k: '委托价 / 数量', v: pxText(inst, o.price) + ' / ' + o.qty + ' ' + inst.short },
      { k: '委托时间', v: ts(o.time) },
      ...(isOpen ? [{ k: '将退回保证金', v: fmt(o.margin + (o.frozenFee || 0), 2) + ' USDT' }] : []),
    ],
    warn: '撤单后该委托立即失效，不再参与撮合。',
  });
  if (!ok) { toast('已取消撤单操作'); return; }
  if (isOpen) state.acct.cash += o.margin + (o.frozenFee || 0);
  removeOrder(id);
  saveAcct(); renderPositions(); renderOrders(); updatePricePanel(); renderEst();
  toast(`已撤销委托：${inst.short} @ ${pxText(inst, o.price)}`);
}

/* ---------- 持仓 / 委托 / 成交渲染 ---------- */
function renderPositions() {
  const posBody = $('#posTable tbody'), histBody = $('#histTable tbody');
  if (!state.acct.positions.length) {
    posBody.innerHTML = '<tr><td colspan="12" class="empty">暂无持仓（可用余额 ' + fmt(state.acct.cash, 2) + ' USDT）</td></tr>';
  } else {
    posBody.innerHTML = state.acct.positions.map(p => {
      const inst = instOf(p.inst), pr = lastPrice(p.inst);
      const pnl = posPnl(p, pr), roi = posRoi(p, pr);
      const lp = liqPrice(p);
      const levTxt = posLev(p).toFixed(posLev(p) >= 1 ? 0 : 1) + 'x';
      const nearLiq = pr != null && Math.abs(pr - lp) / pr < 0.02;
      return `<tr>
        <td>${inst.short}</td>
        <td class="${p.side === 'long' ? 'txt-up' : 'txt-down'}">${p.side === 'long' ? '多' : '空'}</td>
        <td>${p.qty}</td>
        <td><span class="badge badge-lev">${levTxt}</span></td>
        <td>${pxText(inst, p.entry)}</td>
        <td>${pxText(inst, pr)}</td>
        <td>${fmt(p.margin, 2)}</td>
        <td class="${nearLiq ? 'txt-down' : ''}">${pxText(inst, lp)}</td>
        <td class="${pnl != null ? upDownClass(pnl) : ''}">${pnl != null ? (pnl >= 0 ? '+' : '') + fmt(pnl, 2) : '—'}</td>
        <td class="${roi != null ? upDownClass(roi) : ''}">${roi != null ? (roi >= 0 ? '+' : '') + (roi * 100).toFixed(2) + '%' : '—'}</td>
        <td>${ts(p.time)}</td>
        <td>
          <button class="btn-sm" data-close="${p.id}">平仓</button>
          <button class="btn-sm" data-reverse="${p.id}">反手</button>
        </td></tr>`;
    }).join('');
  }
  posBody.querySelectorAll('[data-close]').forEach(b =>
    b.addEventListener('click', () => openCloseDialog(b.dataset.close)));
  posBody.querySelectorAll('[data-reverse]').forEach(b => b.addEventListener('click', async () => {
    const pos = state.acct.positions.find(x => x.id === b.dataset.reverse);
    if (!pos) return;
    const inst = instOf(pos.inst);
    const px = lastPrice(pos.inst);
    if (px == null) { toast('暂无实时价格'); return; }
    const qty = pos.qty;
    const ok = await confirmYes({
      title: '反手确认 · ' + inst.short,
      icon: '⇄',
      btnStyle: 'accent',
      yesText: '是 · 确认反手',
      noText: '否 · 取消',
      rows: [
        { k: '当前持仓', v: pos.qty + ' ' + inst.short + ' ' + (pos.side === 'long' ? '多单' : '空单') },
        { k: '反手后', v: qty + ' ' + inst.short + ' ' + (pos.side === 'long' ? '空单' : '多单') },
        { k: '执行价格', v: '市价 ' + pxText(inst, px) },
        { k: '杠杆倍数', v: posLev(pos).toFixed(0) + 'x' },
      ],
      warn: '反手 = 以市价平掉当前持仓，同时反向开立等量新仓（两步均按市价 0.10% 收取手续费）。',
    });
    if (!ok) { toast('已取消反手操作'); return; }
    if (!state.acct.positions.includes(pos)) { toast('该持仓已不存在，反手取消'); renderPositions(); return; }
    const revLev = Math.max(1, Math.round(posLev(pos)));
    const res = settleClose(pos, qty, px, FEE_TAKER, '反手平仓');
    const lev = revLev;
    const feeRate = FEE_TAKER;
    const notional = qty * px, margin = notional / lev, fee = notional * feeRate;
    if (margin + fee > state.acct.cash + 1e-9) {
      toast(`反手开仓余额不足：需 ${fmt(margin + fee, 2)} USDT，可用 ${fmt(state.acct.cash, 2)} USDT（已平仓）`);
    } else {
      state.acct.cash -= margin + fee;
      const newSide = pos.side === 'long' ? 'short' : 'long';
      openPosition(inst, newSide, qty, px, margin);
      state.acct.history.unshift({ inst: inst.id, side: newSide === 'long' ? '开多' : '开空', qty, price: px, amount: notional, pnl: null, fee, time: Date.now(), tag: '反手' });
      toast(`✅ 已反手：${inst.short} 转为 ${newSide === 'long' ? '多单' : '空单'} ${qty} @ ${pxText(inst, px)} · 平仓盈亏 ${res.pnl >= 0 ? '+' : ''}${fmt(res.pnl, 2)} USDT`);
    }
    saveAcct(); renderPositions(); renderOrders(); updatePricePanel();
  }));

  histBody.innerHTML = state.acct.history.length
    ? state.acct.history.slice(0, 40).map(h => {
        const inst = instOf(h.inst);
        return `<tr><td>${inst.short}</td><td>${h.side}${h.tag ? ' <span class="badge badge-pend">' + h.tag + '</span>' : ''}</td><td>${h.qty}</td><td>${pxText(inst, h.price)}</td><td>${fmt(h.amount, 2)}</td>
          <td class="${h.pnl != null ? upDownClass(h.pnl) : ''}">${h.pnl != null ? (h.pnl >= 0 ? '+' : '') + fmt(h.pnl, 2) : '—'}</td><td>${ts(h.time)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="7" class="empty">暂无成交记录</td></tr>';
}
function renderOrders() {
  const body = $('#orderTable tbody');
  const orders = state.acct.orders || [];
  if (!orders.length) { body.innerHTML = '<tr><td colspan="10" class="empty">暂无未成交委托（限价单只挂单不立即成交，未触及时会显示在这里）</td></tr>'; return; }
  body.innerHTML = orders.map(o => {
    const inst = instOf(o.inst);
    const px = lastPrice(o.inst);
    const typeTxt = o.kind === 'open' ? (o.side === 'buy' ? '限价开多' : '限价开空') : (o.side === 'sell' ? '限价平多' : '限价平空');
    const sideTxt = o.side === 'buy' ? '买入' : '卖出';
    // 触发条件：买入方向需行情跌到委托价，卖出方向需涨到委托价
    const need = px == null ? null : (o.side === 'buy' ? (px - o.price) / px * 100 : (o.price - px) / px * 100);
    const trig = need == null ? ''
      : need <= 0 ? '<span class="txt-warn">行情已触及，撮合中…</span>'
      : `需${o.side === 'buy' ? '再跌' : '再涨'} ${need.toFixed(2)}% 才成交`;
    return `<tr>
      <td>${inst.short}</td>
      <td>${typeTxt}</td>
      <td class="${o.side === 'buy' ? 'txt-up' : 'txt-down'}">${sideTxt}</td>
      <td>${(o.side === 'buy' ? '≤ ' : '≥ ') + pxText(inst, o.price)}</td>
      <td>${o.qty}</td>
      <td>${o.kind === 'open' ? '<span class="badge badge-lev">' + o.lev + 'x</span>' : '—'}</td>
      <td><span class="badge badge-pend">挂单未成交</span></td>
      <td style="font-size:11px">${trig}</td>
      <td>${ts(o.time)}</td>
      <td><button class="btn-sm" data-cancel="${o.id}">撤单</button></td></tr>`;
  }).join('');
  body.querySelectorAll('[data-cancel]').forEach(b =>
    b.addEventListener('click', () => cancelOrder(b.dataset.cancel)));
}

/* ---------- 回测 ---------- */
async function runBacktest() {
  const inst = instOf(state.current);
  const box = $('#btResult');
  box.innerHTML = '<div class="empty">加载近10年日线数据中（首次较慢，约几秒）…</div>';
  try {
    let candles = [];
    if (inst.type === 'ust') {
      const d = (await fetchTreasuryYields())[inst.id.toLowerCase()];
      candles = d.dates.map((dt, i) => ({ time: Math.floor(new Date(dt + 'T00:00:00Z').getTime() / 1000), close: d.series[i] }));
    } else {
      let endTime = Date.now();
      for (let page = 0; page < 5; page++) {
        const part = await fetchKlines(inst.sym, '1d', 1000, endTime);
        if (!part.length) break;
        candles = part.concat(candles);
        const firstOpen = part[0].time * 1000;
        if (firstOpen < Date.now() - 365 * 10 * 86400 * 1000) break;
        endTime = firstOpen - 1;
      }
    }
    const closes = candles.map(c => c.close);
    if (closes.length < 100) { box.innerHTML = '<div class="empty">历史数据不足，无法回测</div>'; return; }

    // EMA20/60 趋势跟踪：金叉买入、死叉卖出（全仓模拟）
    const e20 = ema(closes, 20), e60 = ema(closes, 60);
    let cash = 100000, qty = 0, trades = [], wins = 0, entry = 0;
    let peak = 100000, maxDD = 0;
    const equity = [];
    for (let i = 1; i < closes.length; i++) {
      const crossUp = e20[i] > e60[i] && e20[i - 1] <= e60[i - 1];
      const crossDn = e20[i] < e60[i] && e20[i - 1] >= e60[i - 1];
      if (crossUp && qty === 0) { entry = closes[i]; qty = cash / (closes[i] * (1 + FEE)); cash = 0; trades.push({ t: candles[i].time, side: 'buy', p: entry }); }
      else if (crossDn && qty > 0) {
        const proceeds = qty * closes[i] * (1 - FEE);
        const pnl = proceeds - entry * qty;
        cash = proceeds; if (pnl > 0) wins++;
        trades.push({ t: candles[i].time, side: 'sell', p: closes[i], pnl });
        qty = 0;
      }
      const eq = qty > 0 ? qty * closes[i] : cash;
      equity.push(eq);
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
    }
    const finalEq = qty > 0 ? qty * closes[closes.length - 1] : cash;
    const bhRet = (closes[closes.length - 1] / closes[0] - 1) * 100;
    const stratRet = (finalEq / 100000 - 1) * 100;
    const years = (candles[candles.length - 1].time - candles[0].time) / (365.25 * 86400);
    // 年化波动率
    const rets = []; for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length) * Math.sqrt(252) * 100;

    const closed = trades.filter(t => t.side === 'sell');
    box.innerHTML = `
      <div class="bt-grid">
        <div class="bt-card"><div class="k">样本区间</div><div class="v" style="font-size:14px">${ts(candles[0].time * 1000).slice(0, 10)} ~ ${ts(candles[candles.length - 1].time * 1000).slice(0, 10)}</div></div>
        <div class="bt-card"><div class="k">日线样本数</div><div class="v">${closes.length}</div></div>
        <div class="bt-card"><div class="k">策略累计收益</div><div class="v ${stratRet >= 0 ? 'txt-up' : 'txt-down'}">${stratRet.toFixed(1)}%</div></div>
        <div class="bt-card"><div class="k">买入持有收益</div><div class="v ${bhRet >= 0 ? 'txt-up' : 'txt-down'}">${bhRet.toFixed(1)}%</div></div>
        <div class="bt-card"><div class="k">交易次数</div><div class="v">${closed.length}</div></div>
        <div class="bt-card"><div class="k">胜率</div><div class="v">${closed.length ? (wins / closed.length * 100).toFixed(0) + '%' : '—'}</div></div>
        <div class="bt-card"><div class="k">最大回撤</div><div class="v txt-down">${(maxDD * 100).toFixed(1)}%</div></div>
        <div class="bt-card"><div class="k">年化波动率</div><div class="v" style="font-size:14px">${vol.toFixed(1)}%</div></div>
      </div>
      <div class="bt-note">策略规则：EMA20 上穿 EMA60 买入（全仓），下穿卖出；含 0.1% 单边手续费。最近一次信号：${trades.length && trades[trades.length - 1].side === 'buy' ? '持仓中（' + ts(trades[trades.length - 1].t * 1000).slice(0, 10) + ' 买入）' : (trades.length ? '空仓（' + ts(trades[trades.length - 1].t * 1000).slice(0, 10) + ' 卖出）' : '无')}。${inst.type === 'ust' ? '美债收益率为日频数据。' : ''}回测为历史模拟，不代表未来表现。</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">回测失败：${e.message}</div>`;
  }
}

const TF_CACHE_TTL = 60000;

async function ensureCandles(inst, tf, force) {
  const key = inst.id + '_' + tf;
  const tsMap = state.cacheTs;
  const cached = state.candles[key];
  if (!force && cached && tsMap[key] && Date.now() - tsMap[key] < TF_CACHE_TTL) return cached;
  let c;
  try {
    if (inst.type === 'ust') { c = await fetchUstKlines(inst, tf); if (c.length > 300) c = c.slice(-300); }
    else c = await fetchKlines(inst.sym, tf, 200);
    if (!c || !c.length) throw new NetError('K线为空', 'empty');
    state.candles[key] = c; tsMap[key] = Date.now();
    snapSave('k:' + key, slimCandles(c));       // 成功即落盘，供断网时回显
    dataSrc.degraded = false; dataSrc.staleTs = 0;
    return c;
  } catch (e) {
    /* 全源失败 → 回显本地快照。宁可显示「X 分钟前的离线数据」，
       也不要让用户面对一片空白却不知道发生了什么。 */
    const snap = snapLoad('k:' + key);
    if (snap && snap.data && snap.data.length) {
      c = fatCandles(snap.data);
      state.candles[key] = c; tsMap[key] = snap.ts;
      dataSrc.degraded = true; dataSrc.staleTs = snap.ts;
      return c;
    }
    throw e;
  }
}
function atr(candles, p = 14) {
  if (candles.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pv = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pv.close), Math.abs(c.low - pv.close)));
  }
  const seg = trs.slice(-p);
  return seg.reduce((a, b) => a + b, 0) / seg.length;
}

/* ============================================================
   止盈止损区间引擎
   输入：某周期的真实K线（真实成交数据），输出该周期的
        止损价 / 止盈1 / 止盈2 / 盈亏比 / 参考入场区
   依据（八因子信号 + ATR/结构共同定价）：
        ATR(14) 波动 + 近N根结构高低点 + 布林带宽分位（极收/扩张）
        + KDJ 钝化与脱离极端区 + OBV 确认新高新低/背离
        + MACD 二阶加速度与背离 + ADX 强度与升降速度 + RVOL climax + 信号方向
   ============================================================ */

/* 指标驱动的止损/止盈调整系数：
   atrKMul 放大/收紧止损距离 · tp1Mul / tp2Mul 调整止盈远近 · stopBuf 给结构止损加缓冲 */
function indAdjust(sig, candles, dir) {
  const ind = (sig && sig.ind) || {};
  const reasons = [];
  let atrKMul = 1, tp1Mul = 1, tp2Mul = 1, stopBuf = 0;

  const ar = atrRank(candles);
  if (ar != null) {
    if (ar > 0.72) { atrKMul *= 1.15; reasons.push(`ATR 处于历史高位分位(${(ar * 100) | 0}%)，止损放宽 15%`); }
    else if (ar < 0.28) { atrKMul *= 0.90; reasons.push(`ATR 处于历史低位分位(${(ar * 100) | 0}%)，止损收紧 10%`); }
  }
  if (ind.squeeze) { stopBuf = 0.25; reasons.push('布林带宽处历史低分位（波动压缩），止损附加 0.25×ATR 缓冲防扫损'); }
  else if (ind.expand) { atrKMul *= 1.08; reasons.push('布林带宽处历史高分位（波动扩张），止损随波动上浮 8%'); }

  /* KDJ：不看超买超卖本身，看「钝化是否持续」——
     钝化中 = 趋势未竭（止盈可看远）；刚脱离极端区 = 动能衰竭（止盈提前锁定） */
  if (ind.kdjInZone && ind.kdjDun >= 5) {
    tp2Mul *= 1.10;
    reasons.push(`KDJ ${ind.d > 75 ? '超买' : '超卖'}钝化已持续 ${ind.kdjDun} 根（趋势未竭），止盈二看远 10%`);
  } else if (ind.kdjTxt && ind.kdjTxt.indexOf('脱离') === 0) {
    tp1Mul *= 0.82; tp2Mul *= 0.80;
    reasons.push('KDJ 脱离极端区（钝化后动能衰竭），止盈一/二各提前 18% / 20%');
  }

  /* OBV：不看绝对数值，看是否确认价格新高 / 新低 */
  const dvg = ind.dvg || 0;
  if (dvg === -1) { tp1Mul *= 0.80; tp2Mul *= 0.75; atrKMul *= 0.92; reasons.push('OBV 顶背离（价创新高而量能未确认），止盈收紧 20%、止损上移'); }
  else if (dvg === 1) { tp1Mul *= 0.80; tp2Mul *= 0.75; atrKMul *= 0.92; reasons.push('OBV 底背离（价创新低而量能未确认），止盈收紧 20%、止损下移'); }
  else if (ind.obvState === 1 || ind.obvState === -1) { tp2Mul *= 1.10; reasons.push('OBV 量价同步' + (ind.obvState === 1 ? '新高' : '新低') + '（确认），止盈二可看更远'); }

  /* MACD：不看柱的正负，看二阶加速度与背离 */
  const A = ind.atr;
  if (A != null && A > 0) {
    const acc = ind.hist2 / A;
    const revDvg = ind.mdvg && ((dir === 'long' && ind.mdvg < 0) || (dir === 'short' && ind.mdvg > 0));
    if (revDvg) { tp2Mul *= 0.85; reasons.push('MACD 出现反向背离，止盈二下修 15%'); }
    else if (acc > 0.02) { tp2Mul *= 1.10; reasons.push(`MACD 柱二阶加速 (+${acc.toFixed(3)}ATR/根²)，动能增强，止盈二看远 10%`); }
    else if (acc < -0.02) { tp2Mul *= 0.92; reasons.push(`MACD 柱二阶减速 (${acc.toFixed(3)}ATR/根²)，止盈二下修 8%`); }
  }

  /* ADX：不看单个阈值，看绝对强度与升降速度 */
  if (ind.adx != null) {
    if (ind.adx >= 25 && ind.adxSpeed > 0) { atrKMul *= 1.05; tp2Mul *= 1.10; reasons.push(`ADX ${ind.adx.toFixed(0)} 且仍在走强，趋势可信度高，止盈二看远 10%`); }
    else if (ind.adx < 15) { atrKMul *= 0.92; tp2Mul *= 0.90; reasons.push(`ADX ${ind.adx.toFixed(0)} 无趋势（噪音区），止损收紧 8%、止盈二下修 10%`); }
  }

  /* 量能：climax 尖峰后反转风险高 */
  if (ind.rvol != null && ind.rvol >= 3) {
    tp1Mul *= 0.82; tp2Mul *= 0.85;
    reasons.push(`成交量 RVOL ${ind.rvol.toFixed(1)}（climax 尖峰），情绪高潮后易反转，止盈提前锁定`);
  }
  return { atrKMul, tp1Mul, tp2Mul, stopBuf, reasons, atrRank: ar, ind };
}

/* 单周期方案 */
/* 盈亏比口径工具
   rrAtEntry：以「预计入场价」（入场区中点）为基准，而不是方案参考价 P。
              参考价口径会低估实际风险：按截图例子，做空时参考价口径 1:1.00，
              换成入场区中点口径是 1:1.86，两者差接近一倍。
   rrNetOf  ：在入场价口径上再扣掉开仓与平仓两道手续费（费率 = 下单方式对应费率），
              这才是真正拿得到的净盈亏比。手续费按名义金额计，与模拟盘开平仓扣费一致。 */
function rrAtEntry(entry, stop, tp) {
  const r = Math.abs(entry - stop);
  return r > 0 ? Math.abs(tp - entry) / r : 0;
}
function rrNetOf(entry, stop, tp, fee) {
  const loss = Math.abs(entry - stop) + (entry + stop) * fee;   // 被打止损：价差 + 开平仓两道费
  const gain = Math.abs(tp - entry) - (entry + tp) * fee;       // 止盈离场：价差 − 开平仓两道费
  return loss > 0 ? gain / loss : 0;
}

function tpSlPlan(candles, tf, price) {
  if (!candles || candles.length < 45) return null;
  const cfg = TPSL_CFG[tf] || TPSL_CFG['1h'];
  const closes = candles.map(c => c.close);
  const i = closes.length - 1;
  const px = (price != null && price > 0) ? price : closes[i];
  const a = atr(candles, 14);
  if (!a || !(a > 0) || !(px > 0)) return null;

  const seg = candles.slice(-cfg.look);
  const swLow = Math.min(...seg.map(c => c.low));      // 结构支撑（近N根最低）
  const swHigh = Math.max(...seg.map(c => c.high));    // 结构压力（近N根最高）
  const b = boll(closes);
  const bUp = b.up[i], bLo = b.lo[i], bMid = b.mid[i];
  const sig = computeSignal(candles);
  const score = sig && !isNaN(sig.score) ? sig.score : 0;
  const label = sig ? sig.label : '—';

  // 方向：由八因子信号引擎判定（含主导因子与趋势门槛两道闸门）
  const dir = (sig && sig.dir) ? sig.dir : 'wait';
  const adj = indAdjust(sig, candles, dir);
  /* maxAtrK 是最终风险的硬上限：指标系数叠加后（如 2.4×1.15×1.08=2.98 > 2.8）不允许突破，
     ATR 回退分支同样受它约束，不再只筛结构止损。 */
  const effK = Math.min(cfg.atrK * adj.atrKMul, cfg.maxAtrK);
  const cap = cfg.maxAtrK * a;                         // 单笔最大风险（ATR 倍数上限）

  /* ---- 做多方案 ---- */
  const structStopL = swLow - (0.15 + adj.stopBuf) * a;
  const riskSL = px - structStopL;
  let stopL, riskL;
  if (riskSL > 0.15 * a && riskSL <= cap) { stopL = structStopL; riskL = riskSL; }   // 结构止损（前低下方）
  else { const d = Math.min(effK * a, cap); stopL = px - d; riskL = d; }             // 结构过远/过近 → ATR 止损（同样受硬上限约束）
  const tp1L = px + cfg.rr[0] * adj.tp1Mul * riskL;
  // 止盈二：结构性目标（布林上轨 / 近期高点）需在至少 1.5R 之外才采用，否则退回 2R 度量目标
  const candL = [bUp, swHigh].filter(v => v != null && v > px + 1.5 * riskL);
  const tp2L = candL.length ? px + (Math.min(...candL) - px) * adj.tp2Mul : px + cfg.rr[1] * adj.tp2Mul * riskL;
  const tp2SrcL = candL.length ? '结构' : '度量';
  const tp3L = px + cfg.rr[2] * adj.tp2Mul * riskL;

  /* ---- 做空方案 ---- */
  const structStopS = swHigh + (0.15 + adj.stopBuf) * a;
  const riskSS = structStopS - px;
  let stopS, riskS;
  if (riskSS > 0.15 * a && riskSS <= cap) { stopS = structStopS; riskS = riskSS; }
  else { const d = Math.min(effK * a, cap); stopS = px + d; riskS = d; }
  const tp1S = px - cfg.rr[0] * adj.tp1Mul * riskS;
  const candS = [bLo, swLow].filter(v => v != null && v < px - 1.5 * riskS);
  const tp2S = candS.length ? px - (px - Math.max(...candS)) * adj.tp2Mul : px - cfg.rr[1] * adj.tp2Mul * riskS;
  const tp2SrcS = candS.length ? '结构' : '度量';
  const tp3S = px - cfg.rr[2] * adj.tp2Mul * riskS;

  const fee = FEE_MARKET_RATE();                       // 当前下单方式的费率（市价 0.10% / 限价 0.05%）
  const long = {
    stop: stopL, risk: riskL, riskPct: riskL / px,
    tp1: tp1L, tp2: tp2L, tp3: tp3L, tp2Src: tp2SrcL,
    rr1: (tp1L - px) / riskL, rr2: (tp2L - px) / riskL,
    entryLo: px - 0.60 * a, entryHi: px - 0.12 * a,     // 回踩买入区（低于现价 → 符合限价买规则）
  };
  const short = {
    stop: stopS, risk: riskS, riskPct: riskS / px,
    tp1: tp1S, tp2: tp2S, tp3: tp3S, tp2Src: tp2SrcS,
    rr1: (px - tp1S) / riskS, rr2: (px - tp2S) / riskS,
    entryLo: px + 0.12 * a, entryHi: px + 0.60 * a,     // 反弹卖出区（高于现价 → 符合限价卖规则）
  };
  /* 三套盈亏比口径：
     rr1/rr2   —— 按方案参考价 P（卡片历史口径，未扣费）
     rr*Entry  —— 按预计入场价（入场区中点），这才是挂单实际面对的风险收益
     rr*Net    —— 在预计入场价基础上扣掉开仓与平仓两道手续费后的净口径 */
  for (const side of [long, short]) {
    side.entry = (side.entryLo + side.entryHi) / 2;
    side.rr1Entry = rrAtEntry(side.entry, side.stop, side.tp1);
    side.rr2Entry = rrAtEntry(side.entry, side.stop, side.tp2);
    side.rr1Net = rrNetOf(side.entry, side.stop, side.tp1, fee);
    side.rr2Net = rrNetOf(side.entry, side.stop, side.tp2, fee);
  }
  // 自动基线快照：手动微调只在此基线上叠加，清除手填值后可完整还原
  const snap = side => ({ stop: side.stop, tp1: side.tp1, tp2: side.tp2, risk: side.risk, riskPct: side.riskPct,
    rr1: side.rr1, rr2: side.rr2, entry: side.entry, rr1Entry: side.rr1Entry, rr2Entry: side.rr2Entry,
    rr1Net: side.rr1Net, rr2Net: side.rr2Net });
  long.auto = snap(long);
  short.auto = snap(short);

  // 主方案：方向明确用对应侧；震荡则取打分偏好的一侧并标记（区间交易）
  const primary = dir === 'short' ? 'short' : 'long';
  const side = primary === 'short' ? short : long;

  return {
    tf, cfg, px, atr: a, atrPct: a / px, score, label, dir, primary,
    swLow, swHigh, bUp, bLo, bMid,
    long, short,
    // 指标优化依据（界面展示「为什么这么定」）
    adj: { atrKMul: adj.atrKMul, tp1Mul: adj.tp1Mul, tp2Mul: adj.tp2Mul, stopBuf: adj.stopBuf, reasons: adj.reasons },
    ind: adj.ind, atrRank: adj.atrRank,
    // 主方案关键位（便于列表与综合统计）
    stop: side.stop, risk: side.risk, riskPct: side.riskPct,
    tp1: side.tp1, tp2: side.tp2, tp3: side.tp3, tp2Src: side.tp2Src,
    rr1: side.rr1, rr2: side.rr2,
    entryLo: side.entryLo, entryHi: side.entryHi,
    entry: side.entry, rr1Entry: side.rr1Entry, rr2Entry: side.rr2Entry,
    rr1Net: side.rr1Net, rr2Net: side.rr2Net,
  };
}

/* 多周期综合：共振方向 + 加权综合止损/止盈 + 置信度 + 建议数量 */
function tpSlSummary(plans, px, inst) {
  if (!plans || !plans.length) return null;
  const wOf = p => (TPSL_CFG[p.tf] ? TPSL_CFG[p.tf].w : 1 / plans.length);
  const totalW = plans.reduce((s, p) => s + wOf(p), 0) || 1;

  let wLong = 0, wShort = 0;
  plans.forEach(p => { const w = wOf(p); if (p.dir === 'long') wLong += w; else if (p.dir === 'short') wShort += w; });
  const mainDir = wLong >= wShort ? 'long' : 'short';
  const aligned = plans.filter(p => p.dir === mainDir);
  const neutral = plans.filter(p => p.dir === 'wait');

  // 方向一致性权重（明确同向的周期占比）
  const agreeW = aligned.reduce((s, p) => s + wOf(p), 0) / totalW;
  const dirW = aligned.reduce((s, p) => s + wOf(p) * Math.min(1, Math.abs(p.score) / 0.5), 0) / totalW;

  // 综合价位：优先用同向周期，加权平均绝对价位（不随现价漂移）
  const use = aligned.length ? aligned : plans;
  const useW = use.reduce((s, p) => s + wOf(p), 0) || 1;
  let stop = 0, tp1 = 0, tp2 = 0;
  use.forEach(p => { const w = wOf(p) / useW; stop += w * p.stop; tp1 += w * p.tp1; tp2 += w * p.tp2; });

  const riskDist = Math.abs(px - stop);
  const riskPct = riskDist / px;
  const rr1 = riskDist > 0 ? Math.abs(tp1 - px) / riskDist : 0;
  const rr2 = riskDist > 0 ? Math.abs(tp2 - px) / riskDist : 0;

  // 置信度：方向一致性 60% + 信号强度 40%，盈亏比达标加成
  let conf = Math.round(Math.max(0, Math.min(1, agreeW * 0.6 + dirW * 0.6)) * 100);
  if (rr2 >= 1.8) conf = Math.min(100, conf + 8);
  if (neutral.length >= 2) conf = Math.max(0, conf - 12);

  // 建议数量：单笔风险预算 ÷ 止损距离
  const equity = acctEquity();
  const budget = equity * TPSL_RISK_BUDGET;
  const step = inst ? inst.qtyStep : 0.0001;
  const sugQty = riskDist > 0 ? roundStep(budget / riskDist, step) : 0;
  const maxQty = Math.max(0, maxQtyFor(px, state.lever, FEE_MARKET_RATE(), state.acct.cash));

  // 综合价的加权明细：同向周期按权重归一化（不同向的周期不参与），界面要写清楚是哪几个周期、各占多少
  const weights = use.map(p => ({ tf: p.tf, w: wOf(p) / useW }));
  const fee = FEE_MARKET_RATE();
  return {
    mainDir, alignedCount: aligned.length, total: plans.length, neutralCount: neutral.length,
    agreeW, conf, stop, tp1, tp2, riskPct, rr1, rr2,
    rr1Net: rrNetOf(px, stop, tp1, fee), rr2Net: rrNetOf(px, stop, tp2, fee),
    weights, usedTfs: use.map(p => p.tf),
    budget, sugQty, sugQtyCapped: Math.min(sugQty, roundStep(maxQty, step)),
    atrPctAvg: use.reduce((s, p) => s + wOf(p) / useW * p.atrPct, 0),
  };
}
function FEE_MARKET_RATE() { return state.orderType === 'limit' ? FEE_MAKER : FEE_TAKER; }

/* ---------- 止盈止损手动微调 ----------
   自动方案基于八因子信号生成；允许对任一周期手工覆盖 止损 / 止盈一 / 止盈二，
   覆盖后盈亏比、风险预算与建议数量全部按手填价联动重算，可一键恢复自动。 */
const TPOV_KEY = 'simtrader_tpov_v1';
function loadTpOv() {
  try { const s = JSON.parse(localStorage.getItem(TPOV_KEY) || '{}'); return (s && typeof s === 'object') ? s : {}; }
  catch (e) { return {}; }
}
function saveTpOv() { try { localStorage.setItem(TPOV_KEY, JSON.stringify(state.tpOv)); } catch (e) {} }
function tpOvKey(tf) { return state.current + ':' + tf; }
function tpOvOf(tf) { return state.tpOv[tpOvKey(tf)] || null; }
function setTpOvField(tf, field, val) {
  const k = tpOvKey(tf);
  const cur = state.tpOv[k] || (state.tpOv[k] = {});
  if (val == null || isNaN(val) || !(val > 0)) delete cur[field]; else cur[field] = +val;
  if (!Object.keys(cur).length) delete state.tpOv[k];
  saveTpOv(); applyTpSlOverride(); renderAllTpSl();
}
function clearTpOv(tf) {
  const k = tpOvKey(tf);
  if (!state.tpOv[k]) { state.tpOv = loadTpOv(); }
  delete state.tpOv[k];
  saveTpOv(); applyTpSlOverride(); renderAllTpSl();
  toast(`已恢复 ${TF_NAME[tf]} 自动止盈止损方案`);
}
/* 把手动覆盖合并进 plans（只覆盖主方向一侧），并重算风险与盈亏比 */
function applyTpSlOverride() {
  const t = state.tpsl;
  if (!t || !t.plans) return;
  t.plans.forEach(p => {
    p.manual = false; p.ovF = {};
    const side = p.dir === 'short' ? p.short : p.long;
    // 先从自动基线还原（否则手填过的值会残留在方案对象上，清除覆盖后回不去）
    const auto = side.auto || { stop: side.stop, tp1: side.tp1, tp2: side.tp2 };
    ['stop', 'tp1', 'tp2'].forEach(f => { side[f] = auto[f]; p[f] = auto[f]; });
    const ov = state.tpOv[state.current + ':' + p.tf];
    if (ov) {
      ['stop', 'tp1', 'tp2'].forEach(f => {
        if (ov[f] != null) { side[f] = ov[f]; p[f] = ov[f]; p.ovF[f] = true; p.manual = true; }
      });
    }
    side.risk = Math.abs(p.px - side.stop);
    side.riskPct = side.risk / p.px;
    side.rr1 = side.risk > 0 ? Math.abs(side.tp1 - p.px) / side.risk : 0;
    side.rr2 = side.risk > 0 ? Math.abs(side.tp2 - p.px) / side.risk : 0;
    // 手填价同样要重算「预计入场价口径」与「扣费净口径」
    const fee = FEE_MARKET_RATE();
    side.entry = (side.entryLo + side.entryHi) / 2;
    side.rr1Entry = rrAtEntry(side.entry, side.stop, side.tp1);
    side.rr2Entry = rrAtEntry(side.entry, side.stop, side.tp2);
    side.rr1Net = rrNetOf(side.entry, side.stop, side.tp1, fee);
    side.rr2Net = rrNetOf(side.entry, side.stop, side.tp2, fee);
    p.risk = side.risk; p.riskPct = side.riskPct; p.rr1 = side.rr1; p.rr2 = side.rr2;
    p.entry = side.entry; p.rr1Entry = side.rr1Entry; p.rr2Entry = side.rr2Entry;
    p.rr1Net = side.rr1Net; p.rr2Net = side.rr2Net;
  });
  const inst = instOf(state.current);
  const px = lastPrice(inst.id) ?? (t.plans[0] && t.plans[0].px);
  if (px) t.summary = tpSlSummary(t.plans, px, inst);
}

/* 计算并缓存当前品种的多周期止盈止损方案 */
function computeTpSl() {
  const tc = state.tfCandles;
  if (!tc || tc._inst !== state.current) { state.tpsl = null; return; }
  const inst = instOf(state.current);
  const px = lastPrice(inst.id);
  const plans = TFS.map(tf => tpSlPlan(tc[tf], tf, px)).filter(Boolean);
  if (!plans.length) { state.tpsl = null; return; }
  state.tpsl = {
    inst: state.current, plans, ts: Date.now(),
    summary: tpSlSummary(plans, px || plans[plans.length - 1].px, inst),
  };
  applyTpSlOverride();
}

/* 止盈止损相关界面的统一重绘（三格 + 综合区 + 指标面板 + 微调面板） */
function renderAllTpSl() {
  renderSigCards();
  renderTpSl();
  renderIndPanel();
  renderTpOvPanel();
}

/* 渲染信号栏内的止盈止损提示列表 */
function renderTpSl() {
  const box = $('#tpslBlock');
  if (!box) return;
  const inst = instOf(state.current);
  const t = state.tpsl;
  if (!t || t.inst !== state.current) {
    box.innerHTML = '<div class="tpsl-empty">止盈止损区间计算中…（需等待多周期K线加载完成）</div>';
    return;
  }
  const px = lastPrice(inst.id) ?? t.plans[0].px;
  const dec = inst.dec;
  const P = v => fmt(v, dec);
  const dist = v => ((v - px) / px * 100);
  /* 百分比按持仓方向折算：做空时价格下跌才是盈利（止损显示负、止盈显示正） */
  const dTxt = v => { let d = dist(v); if (s && s.mainDir === 'short') d = -d; return `<small class="${d >= 0 ? 'txt-up' : 'txt-down'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</small>`; };
  const s = t.summary;

  /* ---- 综合结论提示条（各周期明细见 K 线下方的四个格子） ---- */
  let head = '';
  if (s && s.alignedCount >= 1) {
    const isLong = s.mainDir === 'long';
    const agreeTxt = `${s.alignedCount}/${s.total} 个周期同向`;
    const lvl = s.alignedCount >= 3 ? '三周期共振' : s.alignedCount === 2 ? '双周期共振' : '单周期偏';
    const dirTfs = t.plans.filter(p => p.dir === s.mainDir).map(p => TF_NAME[p.tf]).join(' / ');
    const wTxt = (s.weights && s.weights.length)
      ? s.weights.map(w => `${TF_NAME[w.tf]} ${(w.w * 100).toFixed(0)}%`).join(' / ') : '—';
    head = `<div class="tpsl-hint ${isLong ? 'long' : 'short'}">
      <div class="th-main">${isLong ? '📈' : '📉'} ${lvl}${isLong ? '多' : '空'} · ${agreeTxt} · 置信度 ${s.conf}%</div>
      <div class="th-line">同向周期：<b>${dirTfs || '—'}</b>（三周期：${TFS.map(tf => TF_NAME[tf]).join(' / ')} · 1h 定方向 / 15m·5m 定入场）</div>
      <div class="th-line">参考止损 <b>${P(s.stop)}</b>${dTxt(s.stop)} · 止盈一 <b>${P(s.tp1)}</b>${dTxt(s.tp1)} · 止盈二 <b>${P(s.tp2)}</b>${dTxt(s.tp2)} · 盈亏比 <b>1:${s.rr1.toFixed(1)} / 1:${s.rr2.toFixed(1)}</b><small>（扣开平仓手续费后净 1:${(s.rr1Net || 0).toFixed(1)} / 1:${(s.rr2Net || 0).toFixed(1)}）</small></div>
      <div class="th-line">综合价 = 同向周期按权重归一化：<b>${wTxt}</b>（仅加权参考值，不是另行识别的支撑压力位）</div>
      <div class="th-line">止损距离 <b>${(s.riskPct * 100).toFixed(2)}%</b> · 单笔风险预算 ${(TPSL_RISK_BUDGET * 100).toFixed(0)}% 权益 = <b>${fmt(s.budget, 2)}</b> USDT → 建议数量 ≈ <b>${s.sugQtyCapped}</b> ${inst.short}（按当前 ${state.lever}x）<small> · 风险预算未计手续费与滑点，实际净亏损不封顶于 ${(TPSL_RISK_BUDGET * 100).toFixed(0)}%</small></div>
      ${s.neutralCount >= 2 ? `<div class="th-line th-warn">⚠ ${s.neutralCount} 个周期信号中性（震荡），方向一致性不足，建议降低仓位或等待突破确认</div>` : ''}
    </div>`;
  } else {
    head = `<div class="tpsl-hint wait"><div class="th-main">⏸ 三周期均处于震荡区间，暂无明确方向</div>
      <div class="th-line">建议按区间交易：靠近支撑挂限价买、靠近压力挂限价卖，跌破/突破后再顺势跟进</div></div>`;
  }

  /* ---- 当前品种持仓的止盈止损提示 ---- */
  const myPos = state.acct.positions.filter(p => p.inst === state.current);
  let posHtml = '';
  if (myPos.length) {
    const pf = tpSlPlanForTf();
    posHtml = `<div class="tpsl-sub">当前品种持仓（按 ${TF_NAME[state.tf]} 方案给出的止盈止损参考）</div>
      <table class="tpsl-tbl tpsl-tbl-sm">
        <thead><tr><th>方向</th><th>开仓价</th><th>现价</th><th>参考止损</th><th>止盈一</th><th>止盈二</th><th>浮盈</th><th>建议</th></tr></thead>
        <tbody>${myPos.map(p => {
          const isLong = p.side === 'long';
          const plan = isLong ? pf.long : pf.short;
          const pnl = posPnl(p, px);
          const dStop = (px - plan.stop) * (isLong ? 1 : -1);
          const dTp1 = (plan.tp1 - px) * (isLong ? 1 : -1);
          let advice = '持有观察', cls = 'adv-hold';
          if (dStop <= 0) { advice = '已触及/跌破止损参考'; cls = 'adv-stop'; }
          else if (dTp1 <= 0) { advice = '已达止盈一，可考虑减仓'; cls = 'adv-tp'; }
          else if (plan.risk && Math.abs(px - plan.stop) < 0.4 * (isLong ? (plan.tp1 - plan.stop) : (plan.stop - plan.tp1))) { advice = '接近止损，注意减仓'; cls = 'adv-near'; }
          return `<tr>
            <td class="${isLong ? 'txt-up' : 'txt-down'}">${isLong ? '多' : '空'}</td>
            <td>${P(p.entry)}</td><td>${P(px)}</td>
            <td class="tpsl-stop">${P(plan.stop)}</td>
            <td class="tpsl-tp">${P(plan.tp1)}</td>
            <td class="tpsl-tp">${P(plan.tp2)}</td>
            <td class="${pnl != null ? upDownClass(pnl) : ''}">${pnl != null ? (pnl >= 0 ? '+' : '') + fmt(pnl, 2) : '—'}</td>
            <td class="${cls}">${advice}</td></tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  const manTfs = t.plans.filter(p => p.manual).map(p => TF_NAME[p.tf]);
  box.innerHTML = head + posHtml + `
    ${manTfs.length ? `<div class="tpsl-manual">✎ 已手动微调：${manTfs.join(' / ')}（黄框为手填价，盈亏比与建议数量已按手填价重算）</div>` : ''}
    <div class="tpsl-note">${inst.type === 'ust' ? '⚠ 美债为日频官方数据，三周期共用同一日线序列，各周期差异仅来自风险倍数设定 · ' : ''}定价格局：<b>八因子信号</b>（EMA15% / MACD14% / ADX13% / OBV13% / VOL14% / RSI11% / KDJ10% / BOLL10%）判方向 · <b>止损</b> = 近N根结构高低点 与 ATR(14) 波动取优，并按 ATR 分位、布林带宽分位（极收加缓冲 / 扩张上浮）修正 · <b>止盈</b> = 结构压力/布林轨 与 风险回报倍数取优，再按 KDJ 钝化与脱离极端区、OBV 确认新高新低/背离、MACD 二阶加速度、ADX 强度与升降速度、RVOL climax 修正 · 综合结论按周期权重（5m 26% / 15m 30% / 1h 44%）加权 · 更新于 ${ts(t.ts)}</div>`;

  box.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => applyTpSlPlan(b.dataset.use)));
  renderTpOvPanel();     // 同步微调面板的联动数值（不重建输入框，避免焦点丢失）
}

/* ---------- 指标全景面板 ----------
   展示当前所选周期的八因子原值与多空判定，便于人工复核止盈止损的生成依据。 */
const IND_TONE = { up: 'up', down: 'down', wait: 'wait' };
function indTag(txt, tone) {
  return `<span class="ind-tag ${tone || 'wait'}">${txt}</span>`;
}
function renderIndPanel() {
  const box = $('#indPanel');
  if (!box) return;
  const t = state.tpsl;
  const sig = state.signals[state.tf];
  if (!t || t.inst !== state.current || !sig || !sig.ind) {
    box.innerHTML = '<div class="ind-empty">指标计算中…（需等待K线加载完成）</div>';
    return;
  }
  const p = t.plans.find(x => x.tf === state.tf) || t.plans[0];
  const inst = instOf(state.current), dec = inst.dec;
  const ind = sig.ind;
  const P = v => (v == null || isNaN(v)) ? '—' : fmt(v, inst.type === 'ust' ? 3 : dec);
  const n2 = v => (v == null || isNaN(v)) ? '—' : v.toFixed(2);
  const n0 = v => (v == null || isNaN(v)) ? '—' : v.toFixed(0);

  /* 每个指标的显示口径都对应表里「推荐关注方式」那一栏：
     不再显示金叉/死叉、不再显示「是否大于 0」、不再显示超买超卖本身、
     不再显示触碰上下轨、不再显示绝对数值。 */
  const sg = (v, d) => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d == null ? 2 : d);
  /* ① EMA —— 斜率 / 快慢线距离 / 价格偏离 */
  const eTone = ind.devA == null ? 'wait' : (ind.devA > 0.3 ? 'up' : ind.devA < -0.3 ? 'down' : 'wait');
  const eTag = ind.devA == null ? '—' : Math.abs(ind.devA) < 0.3 ? '快慢线粘合（震荡）'
    : (ind.devA > 0 ? '多头排列' : '空头排列') + (Math.sign(ind.slopeA) === Math.sign(ind.devA) ? ' · 斜率配合' : ' · 斜率背离');
  /* ② MACD —— Histogram 值 / 一阶 / 二阶加速度 / 背离 */
  const mTone = ind.hist2 == null || ind.atr == null ? 'wait'
    : (ind.hist2 / ind.atr > 0.02 ? 'up' : ind.hist2 / ind.atr < -0.02 ? 'down' : 'wait');
  const mTag = ind.mdvg ? (ind.mdvg < 0 ? '⚠ 顶背离' : '⚠ 底背离')
    : ind.atr == null ? '—' : (ind.hist2 / ind.atr > 0.02 ? '动能二阶加速' : ind.hist2 / ind.atr < -0.02 ? '动能二阶减速' : '动能平稳');
  /* ③ ADX —— 绝对强度 + 连续上升/下降速度 */
  const aTone = ind.adx == null ? 'wait' : (ind.adx >= 25 ? (ind.adxSpeed > 0 ? 'up' : 'down') : 'wait');
  const aTag = ind.adx == null ? '—' : ind.adx < 15 ? '无趋势（噪音区）' : ind.adx < 25 ? '弱趋势'
    : ind.adx < 40 ? (ind.adxSpeed > 0 ? '趋势成型 · 走强' : '趋势成型 · 走弱') : '强趋势';
  /* ④ RSI —— 区域 / 斜率 / 背离 / 脱离极端区 */
  const rTone = ind.rsiSlope == null ? 'wait' : (ind.rsiSlope > 0.05 ? 'up' : ind.rsiSlope < -0.05 ? 'down' : 'wait');
  const rTag = ind.rsiExit ? (ind.rsiExit > 0 ? '脱离超卖区' : '脱离超买区')
    : ind.rdvg ? (ind.rdvg < 0 ? '⚠ 顶背离' : '⚠ 底背离')
      : ind.rsiZone == null ? '—' : ind.rsiZone > 0.35 ? '强势区' : ind.rsiZone < -0.35 ? '弱势区' : '中枢区';
  /* ⑤ KDJ —— 钝化持续时间 + 脱离极端区 */
  const jTone = ind.kdjInZone ? (ind.d > 75 ? 'up' : 'down') : 'wait';
  const jTag = ind.kdjTxt || '—';
  /* ⑥ BOLL —— Band Width 分位 / z-score / 假突破后回归 */
  const bTone = ind.fbrk ? (ind.fbrk < 0 ? 'down' : 'up')
    : ind.z == null ? 'wait' : (ind.z > 1 ? 'down' : ind.z < -1 ? 'up' : 'wait');
  const bTag = ind.fbrk ? (ind.fbrk < 0 ? '⚠ 上轨假突破' : '⚠ 下轨假突破')
    : ind.squeeze ? '带宽极收（变盘临近）' : ind.expand ? '带宽扩张'
      : ind.z == null ? '—' : Math.abs(ind.z) > 2 ? 'z 值极端' : 'z 值常态';
  /* ⑦ OBV —— 是否确认价格新高新低 */
  const oTone = ind.dvg < 0 ? 'down' : ind.dvg > 0 ? 'up'
    : ind.obvState === 1 ? 'up' : ind.obvState === -1 ? 'down' : 'wait';
  const oTag = ind.dvg < 0 ? '⚠ 顶背离' : ind.dvg > 0 ? '⚠ 底背离'
    : ind.obvState === 1 ? '新高确认' : ind.obvState === -1 ? '新低确认' : '无新高新低';
  /* ⑧ Volume —— RVOL / climax / 结构位 */
  const vTone = ind.rvol == null ? 'wait' : (ind.rvol >= 3 ? 'down' : ind.rvol >= 1.4 ? 'up' : 'wait');
  const vTag = ind.rvol == null ? '—' : ind.rvol >= 3 ? 'climax 尖峰' : ind.rvol >= 1.4 ? '放量' : ind.rvol < 0.6 ? '缩量' : '常态量';
  /* ⑨ ATR */
  const wTone = p.atrRank == null ? 'wait' : (p.atrRank > 0.72 ? 'down' : 'wait');
  const wTag = p.atrRank == null ? '—' : p.atrRank > 0.72 ? '高波动' : p.atrRank < 0.28 ? '低波动' : '常态波动';

  const card = (title, main, rows, tag, tone) => `<div class="ind-card">
    <div class="ind-k">${title}</div>
    <div class="ind-v ${tone || ''}">${main}</div>
    <div class="ind-rows">${rows}</div>
    <div>${indTag(tag, tone)}</div>
  </div>`;

  box.innerHTML = `
    <div class="ind-head">
      <span class="ind-title">指标全景 · <b>${TF_NAME[state.tf]}</b></span>
      <span class="ind-sub">EMA · MACD · ADX · RSI · KDJ · BOLL · OBV · VOL —— 一律看状态量（斜率/加速度/带宽分位/z-score/钝化/RVOL），不看金叉死叉与绝对数值</span>
    </div>
    <div class="ind-grid">
      ${card('EMA(9,21)', `距离 ${sg(ind.devA)}ATR`,
        `<div class="ind-r"><span>斜率(5)</span><b>${sg(ind.slopeA)}ATR</b></div><div class="ind-r"><span>价偏离</span><b>${sg(ind.pDevA)}ATR</b></div>`, eTag, eTone)}
      ${card('MACD(12,26,9)', `柱 ${ind.atr ? sg(ind.hist / ind.atr) : '—'}ATR`,
        `<div class="ind-r"><span>一阶变化</span><b>${sg(ind.hist1)}</b></div><div class="ind-r"><span>二阶加速度</span><b>${sg(ind.hist2, 4)}</b></div>`, mTag, mTone)}
      ${card('ADX(14)', `${ind.adx == null ? '—' : ind.adx.toFixed(1)}`,
        `<div class="ind-r"><span>速度(6根)</span><b>${sg(ind.adxSpeed)}</b></div><div class="ind-r"><span>DI+/DI−</span><b>${n0(ind.diP)} / ${n0(ind.diM)}</b></div>`, aTag, aTone)}
      ${card('RSI(14)', n2(ind.rsi),
        `<div class="ind-r"><span>斜率(4根)</span><b>${sg(ind.rsiSlope)}</b></div><div class="ind-r"><span>区域</span><b>${sg(ind.rsiZone)}</b></div>`, rTag, rTone)}
      ${card('KDJ(9,3,3)', `K ${n2(ind.k)} / D ${n2(ind.d)}`,
        `<div class="ind-r"><span>J 值</span><b>${n0(ind.j)}</b></div><div class="ind-r"><span>钝化</span><b>${ind.kdjInZone ? ind.kdjDun + ' 根' : '无'}</b></div>`, jTag, jTone)}
      ${card('BOLL(20,2)', `z ${ind.z == null ? '—' : ind.z.toFixed(2)}`,
        `<div class="ind-r"><span>带宽分位</span><b>${ind.bwRank == null ? '—' : (ind.bwRank * 100).toFixed(0) + '%'}</b></div><div class="ind-r"><span>上/下轨</span><b>${P(ind.bUp)} / ${P(ind.bLo)}</b></div>`, bTag, bTone)}
      ${card('OBV 量价', ind.obvState === 1 ? '确认新高' : ind.obvState === -1 ? '确认新低' : '无新高低',
        `<div class="ind-r"><span>偏离均线</span><b>${sg(ind.obvMa ? (ind.obv - ind.obvMa) / (Math.abs(ind.obvMa) + 1e-9) * 100 : null, 1)}%</b></div><div class="ind-r"><span>量价</span><b>${ind.dvg ? (ind.dvg > 0 ? '底背离' : '顶背离') : '同步'}</b></div>`, oTag, oTone)}
      ${card('VOL 相对量', `RVOL ${ind.rvol == null ? '—' : ind.rvol.toFixed(2)}`,
        `<div class="ind-r"><span>量能状态</span><b>${ind.rvol >= 3 ? 'climax' : ind.rvol >= 1.4 ? '放量' : ind.rvol < 0.6 ? '缩量' : '常态'}</b></div><div class="ind-r"><span>基准</span><b>前 120 根均量</b></div>`, vTag, vTone)}
      ${card('ATR(14)', P(p.atr),
        `<div class="ind-r"><span>占现价</span><b>${(p.atrPct * 100).toFixed(2)}%</b></div><div class="ind-r"><span>分位</span><b>${p.atrRank == null ? '—' : (p.atrRank * 100).toFixed(0) + '%'}</b></div>`, wTag, wTone)}
    </div>
    ${p.adj && p.adj.reasons && p.adj.reasons.length ? `<div class="ind-why"><b>${TF_NAME[state.tf]}方案优化依据：</b>${p.adj.reasons.map(r => '· ' + r).join(' ')}</div>` : '<div class="ind-why">当前周期内指标无极端状态，止盈止损按结构与 ATR 基准生成</div>'}`;
}

/* ---------- 止盈止损手动微调面板 ----------
   面板为静态 DOM（避免每 5 秒重绘导致输入焦点丢失），这里只同步占位值/状态。 */
function renderTpOvPanel() {
  const wrap = $('#tpOvPanel');
  if (!wrap) return;
  const inst = instOf(state.current);
  const tf = state.tf;
  const t = state.tpsl;
  const p = (t && t.inst === state.current) ? t.plans.find(x => x.tf === tf) : null;
  const ov = tpOvOf(tf);
  const tfEl = $('#tpovTf'); if (tfEl) tfEl.textContent = TF_NAME[tf];
  const px = lastPrice(inst.id);

  ['stop', 'tp1', 'tp2'].forEach(f => {
    const el = $('#ov' + f.charAt(0).toUpperCase() + f.slice(1));
    if (!el) return;
    el.step = inst.dec >= 4 ? '0.0001' : (inst.dec >= 2 ? '0.01' : '1');
    const base = p ? p[f] : null;
    el.placeholder = base != null ? (+base.toFixed(inst.dec)) : '—';
    el.disabled = !p;
    if (document.activeElement !== el) el.value = (ov && ov[f] != null) ? +ov[f].toFixed(inst.dec) : '';
    el.classList.toggle('edited', !!(ov && ov[f] != null));
  });

  const btn = $('#tpovReset');
  if (btn) btn.disabled = !ov;

  const note = $('#tpovNote');
  if (note) {
    if (!p) { note.innerHTML = '等待方案生成…'; return; }
    const side = p.dir === 'short' ? p.short : p.long;
    const risk = Math.abs(p.px - side.stop);
    const rr1 = risk > 0 ? Math.abs(side.tp1 - p.px) / risk : 0;
    const rr2 = risk > 0 ? Math.abs(side.tp2 - p.px) / risk : 0;
    const budget = acctEquity() * TPSL_RISK_BUDGET;
    const qty = risk > 0 ? roundStep(budget / risk, inst.qtyStep) : 0;
    const warn = [];
    if (p.dir === 'long' && side.stop >= p.px) warn.push('止损价高于基准价，方向可能设反');
    if (p.dir === 'short' && side.stop <= p.px) warn.push('止损价低于基准价，方向可能设反');
    if (p.dir === 'long' && side.tp1 <= p.px) warn.push('止盈一低于基准价，方向可能设反');
    if (p.dir === 'short' && side.tp1 >= p.px) warn.push('止盈一高于基准价，方向可能设反');
    note.innerHTML = `${ov ? '<b class="txt-warn">已启用手动值</b>（黄框为手填） · ' : ''}方向 <b>${p.dir === 'short' ? '空' : '多'}</b> · 基准价 <b>${fmt(p.px, inst.dec)}</b>${px ? ` · 现价 ${fmt(px, inst.dec)}` : ''} · 风险 <b>${fmt(risk, inst.dec)}</b>（${(risk / p.px * 100).toFixed(2)}%） · 盈亏比 <b>1:${rr1.toFixed(1)} / 1:${rr2.toFixed(1)}</b> · 建议数量 ≈ <b>${qty}</b> ${inst.short}`
      + (warn.length ? `<br><span class="txt-warn">⚠ ${warn.join('；')}</span>` : '');
  }
}

/* 绑定微调面板事件（一次性） */
function bindTpOvEvents() {
  ['stop', 'tp1', 'tp2'].forEach(f => {
    const el = $('#ov' + f.charAt(0).toUpperCase() + f.slice(1));
    if (!el) return;
    const commit = () => {
      const raw = el.value.trim();
      if (raw === '') { setTpOvField(state.tf, f, null); return; }
      const v = +raw;
      if (!isFinite(v) || v <= 0) { toast('请输入大于 0 的价格'); el.value = ''; return; }
      setTpOvField(state.tf, f, v);
    };
    el.addEventListener('change', commit);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  });
  const rst = $('#tpovReset');
  if (rst) rst.addEventListener('click', () => clearTpOv(state.tf));
}

/* 下单确认弹窗中的止盈止损参考（按当前所选周期的方案） */
function tpSlRefRows(isLong) {
  const t = state.tpsl;
  if (!t || t.inst !== state.current) return [];
  const p = tpSlPlanForTf();
  if (!p || !p.long || !p.short) return [];
  const inst = instOf(state.current);
  const side = isLong ? p.long : p.short;
  return [{
    k: '参考止损 / 止盈',
    v: `${pxText(inst, side.stop)} / ${pxText(inst, side.tp1)} / ${pxText(inst, side.tp2)}（止损 / 止盈一 / 止盈二 · ${TF_NAME[state.tf]}）`,
    cls: 'txt-warn',
  }];
}

/* 当前所选周期的方案（用于持仓提示） */
function tpSlPlanForTf() {
  const t = state.tpsl;
  if (!t) return null;
  const p = t.plans.find(x => x.tf === state.tf) || t.plans[t.plans.length - 1];
  const inst = instOf(state.current);
  const px = lastPrice(inst.id) ?? p.px;
  if (p.dir !== 'wait') return p;
  // 震荡周期：用区间边缘构造参考止损/止盈
  const a = p.atr;
  return {
    long: { stop: p.swLow - 0.4 * a, tp1: (p.swLow + p.swHigh) / 2, tp2: p.swHigh, risk: 0.4 * a },
    short: { stop: p.swHigh + 0.4 * a, tp1: (p.swLow + p.swHigh) / 2, tp2: p.swLow, risk: 0.4 * a },
    px,
  };
}

/* 一键把某周期的止盈止损方案填入下单面板（只填参数，仍需手动二次确认） */
function applyTpSlPlan(tf) {
  const t = state.tpsl;
  if (!t) { toast('止盈止损方案尚未生成'); return; }
  const p = t.plans.find(x => x.tf === tf);
  if (!p) return;
  const inst = instOf(state.current);
  const px = lastPrice(inst.id);
  if (px == null) { toast('暂无实时价格'); return; }
  const isLong = p.dir === 'long' ? true : p.dir === 'short' ? false : p.score >= 0;
  const side = isLong ? p.long : p.short;

  // 限价单委托价：优先用方案入场区中值；若落在可立即成交一侧，则退让到现价下方/上方
  let price = p.dir === 'wait'
    ? (isLong ? p.swLow + 0.10 * p.atr : p.swHigh - 0.10 * p.atr)
    : (side.entryLo + side.entryHi) / 2;
  const eps = px * 1e-6;
  if (isLong && price >= px - eps) price = px * (1 - 0.0015);
  if (!isLong && price <= px + eps) price = px * (1 + 0.0015);

  setOrderType('limit');
  $('#orderPrice').value = +price.toFixed(inst.dec);

  // 数量：按单笔风险预算 2% 权益 ÷ 止损距离 反推，并不超过当前杠杆下的最大可开量
  const riskDist = Math.abs(price - side.stop);
  const budget = acctEquity() * TPSL_RISK_BUDGET;
  const qtyByRisk = riskDist > 0 ? roundStep(budget / riskDist, inst.qtyStep) : 0;
  const maxQ = roundStep(maxQtyFor(price, state.lever, FEE_MAKER, state.acct.cash), inst.qtyStep);
  const qty = Math.min(qtyByRisk, maxQ);
  $('#orderQty').value = qty;
  renderEst();
  toast(`已填入 ${TF_NAME[tf]} 方案：${isLong ? '买入/开多' : '卖出/开空'} 限价 ${fmt(price, inst.dec)} · 数量 ${qty} ${inst.short} · 参考止损 ${fmt(side.stop, inst.dec)} · 止盈一 ${fmt(side.tp1, inst.dec)}（需点「${isLong ? '买入 / 开多' : '卖出 / 开空'}」并二次确认；本操作只填参数，不会创建止盈/止损委托单）`);
}

/* ---------- 事件与启动 ---------- */
function selectInstrument(id) {
  state.current = id;
  state.tpsl = null;                   // 品种切换后重新推导止盈止损区间
  document.querySelectorAll('.wl-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  $('#instName').textContent = instOf(id).name;
  $('#sigMatrix').innerHTML = ''; $('#sigDetail').innerHTML = '<div class="empty">加载中…</div>';
  $('#orderQty').value = '';
  if (state.orderType === 'limit') { const p = lastPrice(id); $('#orderPrice').value = p == null ? '' : +p.toFixed(instOf(id).dec); }
  /* 切换品种时同步切换清算图（美债等无永续合约的品种 → 自动关闭） */
  if (window.LiqMap) window.LiqMap.setInstrument(id, GATE_FUT_PAIR[instOf(id).sym] || '', instOf(id).dec);
  /* 多空热力图：换成该品种的永续合约；无永续合约（如美债）时清空并提示 */
  if (window.LsMap) {
    const inst = instOf(id);
    const contract = inst.sym ? (GATE_FUT_PAIR[inst.sym] || '') : '';
    window.LsMap.setInstrument(contract ? { id: inst.id, contract, dec: inst.dec } : null);
    const t = $('#lsSym'); if (t) t.textContent = contract ? `${inst.short} · ${contract}` : `${inst.short} · 无永续合约`;
  }
  /* 回测面板：换品种后清空上一次结果（不同品种不能混读） */
  const inst = instOf(id);
  state._btResult = null; state._lastAlert = ''; state.triggers = [];
  const btSym = $('#btSym');
  if (btSym) btSym.textContent = inst.sym ? `${inst.short} · ${GATE_FUT_PAIR[inst.sym] || ''}` : `${inst.short} · 无永续合约`;
  ['#btCards', '#btList', '#btNote'].forEach(s => { const e = $(s); if (e) e.innerHTML = ''; });
  const bb = $('#btBar'); if (bb) bb.style.width = '0%';
  setBtProg(inst.sym ? '未运行 · 点击「开始回测」跑 5 年真实 5m K线（首次约 1～4 分钟）' : '该品种无 Gate 永续合约，无法回测');
  loadChart();
  updatePricePanel();
  refreshVenues(true);       // 切换品种后立即拉取该品种的多平台比价
  renderTpSl(); renderIndPanel(); renderTpOvPanel();
  renderEst();
}
function switchTf(tf) {
  state.tf = tf;
  document.querySelectorAll('#tfTabs button').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  renderTpSl(); renderIndPanel(); renderTpOvPanel();   // 指标全景与微调面板随所选周期联动
  loadChart();
}
function switchTab(name) {
  document.querySelectorAll('.bottom-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ['pos', 'bt', 'doc'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== name));
}

function boot() {
  renderWatchlist();
  initChart();
  renderLeverBtns();
  document.querySelectorAll('#tfTabs button').forEach(b => b.addEventListener('click', () => switchTf(b.dataset.tf)));
  document.querySelectorAll('.bottom-tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.querySelectorAll('#orderType button').forEach(b => b.addEventListener('click', () => setOrderType(b.dataset.ot)));
  document.querySelectorAll('#pctRow button').forEach(b => b.addEventListener('click', () => {
    const inst = instOf(state.current);
    const px = lastPrice(inst.id);
    if (px == null) { toast('暂无实时价格'); return; }
    const type = state.orderType;
    const feeRate = type === 'limit' ? FEE_MAKER : FEE_TAKER;
    const p = type === 'limit' ? (parseFloat($('#orderPrice').value) || px) : px;
    const q = roundStep(maxQtyFor(p, state.lever, feeRate, state.acct.cash) * parseFloat(b.dataset.pct), inst.qtyStep);
    $('#orderQty').value = q;
    renderEst();
  }));
  ['#orderQty', '#orderPrice'].forEach(sel => {
    const el = $(sel); if (el) el.addEventListener('input', renderEst);
  });
  $('#btnBuy').addEventListener('click', () => doOrder('buy'));
  $('#btnSell').addEventListener('click', () => doOrder('sell'));
  bindTpOvEvents();                    // 止盈止损手动微调（输入即联动，可一键恢复自动）
  bindBacktest();                      // 开单逻辑回测（1h 定方向 + 15m 共振 + 5m 结构触发）
  $('#btnBacktest').addEventListener('click', runBacktest);
  $('#btnReset').addEventListener('click', async () => {
    const ok = await confirmYes({
      title: '重置模拟账户',
      icon: '↺',
      danger: true,
      yesText: '是 · 确认重置',
      noText: '否 · 取消',
      rows: [
        { k: '持仓数量', v: state.acct.positions.length + ' 个' },
        { k: '未成交委托', v: (state.acct.orders || []).length + ' 笔' },
        { k: '成交记录', v: state.acct.history.length + ' 条' },
        { k: '重置后可用余额', v: '100,000.00 USDT' },
      ],
      warn: '重置将清空全部持仓、委托与成交记录，恢复初始 100,000 USDT 模拟资金，操作不可撤销。',
    });
    if (!ok) { toast('已取消重置'); return; }
    state.acct = freshAcct();
    saveAcct(); renderPositions(); renderOrders(); updatePricePanel(); renderEst(); toast('模拟账户已重置');
  });
  selectInstrument('BTC');
  pollPrices();
  bindChartHotkeys();                   // K线键盘微调（↑↓缩放 / ←→平移）
  connectTradeStream();                 // 逐笔实时成交推送（限价单撮合的实时数据源）
  startTickLoops();
  setInterval(pollPrices, 5000);        // 行情/24h涨跌/美债轮询兜底（含撮合与强平检查）——固定 5s，不随档位变慢
  setInterval(() => refreshVenues(false), 20000);   // 多平台比价：20 秒（与主源 5s 解耦，避免高频打第三方接口）
  initRefreshCtl();                     // 右上角刷新控件（立即刷新 + 档位选择 + 倒计时）
  scheduleRefresh();                    // 按已保存/默认档位启动定时刷新
  initDataSourceCtl();                  // 数据源状态条 + 手动锁定主源
  initLiqMapCtl();                      // 多空清算图：开关 + 状态文字 + 定时增量刷新
  probeSources();                       // 探测 Gate.io 永续延迟，写入健康度并显示到状态条
  netHint = (t) => { const n = $('#chartNote'); if (n && t) { n.textContent = t; n.classList.add('stale'); } };
  renderPositions();
  renderOrders();
  renderEst();
}
/* ================= 多空清算图（K线左侧） =================
   数据来自 Gate.io 永续强平订单（liq_orders）近 24 小时，按价位聚合后画在 K 线左侧。
   开关持久化；每 60 秒增量刷新最近 2 小时，手动全量刷新时回溯 24 小时。 */
function initLiqMapCtl() {
  const btn = $('#liqToggle');
  if (btn && window.LiqMap) {
    btn.classList.toggle('on', window.LiqMap.isOn());
    btn.addEventListener('click', () => {
      const on = !window.LiqMap.isOn();
      window.LiqMap.setEnabled(on);
      btn.classList.toggle('on', on);
      toast(on ? '已开启多空清算图（Gate 永续 · 近24h 强平）' : '已关闭多空清算图');
      paintLiqStat();
    });
  }
  setInterval(() => { if (window.LiqMap) window.LiqMap.refresh(false); }, 60000);   // 增量刷新
  setInterval(paintLiqStat, 8000);
  paintLiqStat();
}
function paintLiqStat() {
  if (!window.LiqMap) return;
  const winBox = $('#liqWin');
  if (winBox) winBox.classList.toggle('hide', !window.LiqMap.isActive());
  const el = $('#liqStat');
  if (!el) return;
  const t = window.LiqMap.statusLine();
  el.textContent = t || '';
  el.style.display = t ? '' : 'none';
}


/* ================= 右上角刷新控件 =================
   档位只影响「行情/分析数据」刷新节奏；实时价格与撮合强平仍为 5s，不受档位影响。 */

/* 全量刷新：K线 + 三周期信号 + 止盈止损 + 多空热力图 + 左侧清算图 */
async function refreshAll(manual) {
  const ico = $('#btnRefresh');
  if (ico) ico.classList.add('spin');
  try {
    await loadChart(true);
    await Promise.all([
      pollPrices(), refreshVenues(true),
      window.LiqMap ? window.LiqMap.refresh(true) : Promise.resolve(),
      window.LsMap ? window.LsMap.refresh(true) : Promise.resolve(),
    ]);
  } catch (e) {
    if (manual) toast('刷新失败：' + e.message);
  } finally {
    if (ico) ico.classList.remove('spin');
  }
  if (manual) toast('已刷新 · ' + rfLevel().name + '档');
}

/* 按当前档位重建定时器（切档时先清旧定时器，避免叠加） */
function scheduleRefresh() {
  (state.refreshTimers || []).forEach(t => clearInterval(t));
  state.refreshTimers = [];
  const lv = rfLevel();
  // 信号 + 多空热力图（含止盈止损区间重算）
  state.refreshTimers.push(setInterval(() => { runSignals(null, true); if (window.LsMap) window.LsMap.refresh(false); }, lv.sigMs));
  state.nextRefreshAt = Date.now() + lv.sigMs;   // 以较快的那个为准做倒计时
  renderRefreshCtl();
}

function renderRefreshCtl() {
  const seg = $('#rfSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.rf === state.refreshLevel));
  const lv = rfLevel();
  const btn = $('#btnRefresh');
  if (btn) btn.title = `立即刷新全部行情、信号与热力图（当前档位：${lv.name}）`;
  paintCountdown();
}

function paintCountdown() {
  const el = $('#rfCountdown'); if (!el) return;
  if (state.refreshLevel === 'realtime') { el.className = 'rf-cd'; el.textContent = '实时刷新中'; return; }
  const left = Math.max(0, Math.round((state.nextRefreshAt - Date.now()) / 1000));
  if (left <= 0) { el.className = 'rf-cd due'; el.textContent = '刷新中…'; return; }
  const m = Math.floor(left / 60), s = left % 60;
  el.className = 'rf-cd';
  el.textContent = `下次 ${m}:${String(s).padStart(2, '0')}`;
}

function setRefreshLevel(id) {
  if (!REFRESH_LEVELS.some(l => l.id === id)) return;
  if (state.refreshLevel === id) return;
  state.refreshLevel = id;
  saveRefreshLevel();
  scheduleRefresh();
  toast(id === 'realtime' ? '刷新档位：实时（K线/信号 60 秒 · 成交热力图 15 秒）'
    : `刷新档位：每 ${rfLevel().name.replace('分钟', ' 分钟')}自动刷新`);
}

function initRefreshCtl() {
  const btn = $('#btnRefresh');
  if (btn) btn.addEventListener('click', () => refreshAll(true));
  const seg = $('#rfSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setRefreshLevel(b.dataset.rf)));
  // 快捷键：R = 立即刷新（输入框/弹窗内不触发）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const mm = document.getElementById('modalMask');
    if (mm && mm.classList.contains('show')) return;   // 二次确认弹窗打开时不刷新
    e.preventDefault();
    refreshAll(true);
  });
  renderRefreshCtl();
  setInterval(() => { paintCountdown(); if (state.refreshLevel !== 'realtime' && Date.now() >= state.nextRefreshAt) state.nextRefreshAt = Date.now() + rfLevel().flowMs; }, 1000);
}

boot();
