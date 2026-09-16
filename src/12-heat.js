/* ============================ 多空筹码热力图 ============================ */
/* 这条数据链路有两类完全不同的东西，界面必须分开标注，绝不能把推算结果说成真实爆仓位置：
 *   1) 历史爆仓记录 —— CoinGlass / AiCoin 的真实清算记录（需自备 API Key + CORS 代理）
 *   2) 潜在清算区模型 —— 由已成交 K 线 + 杠杆假设反推「可能」的清算密集区。
 *      它回答的是「若这些筹码仍在场内、且使用这些杠杆，强平价大概落在哪」，
 *      **不是**交易所真实未平仓合约的强平价分布。
 */
let CG_KEY   = localStorage.getItem('mb_cgkey') || '';
let HEAT_MODE= localStorage.getItem('mb_heatsrc') || 'auto';

/* 推算链路与关键假设 —— 页面「模型假设」面板直接读这里，改模型时只改一处。
 * 每一条都是**假设**，不是事实；写出来的目的是让人知道这张图能信到什么程度。 */
const HEAT_MODEL = {
  name: '潜在清算区模型',
  nameFull: '基于成交量与杠杆假设的潜在清算区模型',
  chain: [
    'K 线成交量',
    '按收盘位置（CLV）拆分多空',
    '假设杠杆分布',
    '推算清算位置',
    '形成密集区',
  ],
  caveats: [
    { t: '成交量 ≠ 未平仓量', d: '成交量是这段时间「换手了多少」，不是「还有多少仓位没平」。已平仓的筹码不该再有清算价，模型却一视同仁。' },
    { t: '收盘位置推不出真实开仓方向', d: '用 CLV=(2C−H−L)/(H−L) 把一根 K 线的量拆成多空，只是几何近似；同一根 K 线里买卖双方实际成交了多少手，交易所不公开。' },
    { t: '多空比是账户数比例', d: '币安 globalLongShortAccountRatio 统计的是「多少人做多」，不是「多少钱做多」。一个大户的仓位可以顶一万个散户，两者不能直接换算。' },
    { t: '杠杆档随图表跨度自适应', d: '代码按图跨度反推可见杠杆档位，不是读取交易者真实杠杆。跨度变了，同一批筹码会被推到不同的清算位。' },
    { t: '清算公式是简化的', d: '只用了「清算价 = 开仓价×(1∓1/杠杆)」，没有完整表达保证金率、维持保证金、逐仓/全仓、追加保证金等真实条件。' },
  ],
  verdict: '因此图上每个「清算区」都应读作「模型认为可能有流动性堆积的价格带」，'
    + '而不是「市场真实的爆仓位置」。它可以作为位置参考，不能当作清算事实。',
};
const HEAT_LEV = [[10, .45], [25, .32], [50, .23]];   // 参考杠杆与权重（跨度未知时兜底）
// 周期不同，关注的价格尺度不同：短周期看近处的高杠杆清算，长周期看更远的结构
const TF_SPAN = { '15m': 0.020, '30m': 0.028, '1h': 0.040, '4h': 0.070 };
// 位移幅度必须与图跨度匹配：跨度只有 4% 时，10x 仓位的清算位（−10%）根本不在图上，
// 硬塞到边界档会造出一堵假的「清算墙」，让方向系统性偏空。改为按跨度反推可见杠杆。
function levForSpan(halfFrac) {
  if (!(halfFrac > 0)) return HEAT_LEV;
  const base = clamp(1 / halfFrac, 2, 500);
  return [[base, .45], [base * 2, .32], [base * 4, .23]].map(([l, w]) => [clamp(l, 2, 500), w]);
}
const HEAT_NB = 60;      // 价格档数
const HEAT_NT = 72;      // 时间列数上限
const HEAT_MIN_SPAN = 0.030, HEAT_MAX_SPAN = 0.16;
const HEAT_LS = {};      // 多空比缓存
const MONO = "'SF Mono','JetBrains Mono',Menlo,Consolas,monospace";

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

/* --- 1) Coinglass 真实清算记录 --- */
async function fetchCoinglassLiq(symId) {
  const s = SYMS[symId];
  if (!binSym(s)) throw new Error('该品种 Coinglass 无合约映射');
  if (!CG_KEY) throw new Error('未配置 Coinglass API Key');
  const url = `https://open-api-v3.coinglass.com/api/futures/liquidation/history?symbol=${binSym(s)}&interval=1h`;
  const r = await jgetH(url, { coinglassSecret: CG_KEY, accept: 'application/json' }, 12000);
  if (!r) throw new Error('空响应');
  if (r.code != null && String(r.code) !== '0') throw new Error(r.msg || ('code ' + r.code));

  let arr = r.data;
  if (!Array.isArray(arr)) {
    if (arr && Array.isArray(arr.list)) arr = arr.list;
    else if (arr && Array.isArray(arr.data)) arr = arr.data;
    else throw new Error('返回结构无法解析');
  }
  const out = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const price = num(o.price ?? o.p ?? o.liquidationPrice ?? o.avgPrice ?? o.markPrice);
    const vol   = num(o.volUsd ?? o.usd ?? o.amount ?? o.vol ?? o.qty ?? o.size ?? o.volume);
    const time  = num(o.time ?? o.t ?? o.timestamp ?? o.createTime ?? o.createdAt);
    const sd    = String(o.side ?? o.direction ?? o.type ?? o.liquidationSide ?? '').toUpperCase();
    if (!(price > 0)) continue;
    let side = null;
    if (/^L$|^LONG|^BUY/.test(sd)) side = 'long';
    else if (/^S$|^SHORT|^SELL/.test(sd)) side = 'short';
    out.push({ price, vol: vol == null ? 1 : Math.abs(vol), time: time || null, side });
  }
  if (out.length < 5) throw new Error('有效清算记录不足 5 条（仅 ' + out.length + ' 条）');
  return out;
}

/* --- 2) 币安真实多空持仓比 / 主动买卖比 --- */
async function fetchBinanceLS(symId) {
  const s = SYMS[symId];
  if (!binSym(s)) return null;
  const c = HEAT_LS[symId];
  if (c && now() - c.ts < 300000) return c;
  const [g, t] = await Promise.all([
    jget(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${binSym(s)}&period=1h&limit=1`).catch(() => null),
    jget(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${binSym(s)}&period=1h&limit=1`).catch(() => null),
  ]);
  const ls = num(Array.isArray(g) && g[0] ? g[0].longShortRatio : null);
  const tk = num(Array.isArray(t) && t[0] ? t[0].buySellRatio : null);
  if (ls == null && tk == null) return null;
  const r = { ls, tk, ts: now() };
  HEAT_LS[symId] = r;
  return r;
}

/* --- 价格区间：以现价为中心，限制在 [3%, 16%] --- */
function heatRange(mid, lo, hi, minSpan = HEAT_MIN_SPAN) {
  let pLo = Math.min(lo, mid * (1 - minSpan * 0.6));
  let pHi = Math.max(hi, mid * (1 + minSpan * 0.6));
  const maxS = mid * HEAT_MAX_SPAN;
  if (pHi - pLo > maxS) {
    if (mid - pLo > maxS * 0.62) pLo = mid - maxS * 0.62;
    if (pHi - mid > maxS * 0.38) pHi = mid + maxS * 0.38;
    if (pHi - pLo > maxS) pHi = pLo + maxS;
  }
  if (!(pHi > pLo && isFinite(pLo) && isFinite(pHi))) { pLo = mid * 0.97; pHi = mid * 1.03; }
  return [pLo, pHi];
}

/* --- 由 K 线构建：成交量在价格上的分布 + 杠杆位移到清算位 --- */
function buildHeatFromBars(bars, px, lsInfo, label, grade, minSpan) {
  const use = bars.slice(-HEAT_NT);
  const n = use.length;
  if (n < 5) return null;
  const mid = num(px);
  if (!(mid > 0)) return null;

  let lo = Infinity, hi = -Infinity;
  for (const b of use) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const [pLo, pHi] = heatRange(mid, lo, hi, minSpan);
  const step = (pHi - pLo) / HEAT_NB;
  if (!(step > 0)) return null;
  const idxOf = p => (p - pLo) / step - 0.5;

  // 成交量按 K 线区间铺开：买方把价格从 low 推到 close，卖方从 high 压到 close。
  // 买卖力量用收盘位置 CLV=(2C-H-L)/(H-L) 划分，避免 K 线落在区间外时误判多空。
  const half = Math.max(6, n / 3);
  const gL = [], gS = [];
  const put = (arr, a, z, amt) => {
    if (!(amt > 0)) return;
    let i0 = Math.floor((Math.min(a, z) - pLo) / step), i1 = Math.ceil((Math.max(a, z) - pLo) / step);
    i0 = Math.max(0, Math.min(HEAT_NB - 1, i0));
    i1 = Math.max(0, Math.min(HEAT_NB - 1, i1));
    const sh = amt / (i1 - i0 + 1);
    if (!isFinite(sh)) return;
    for (let i = i0; i <= i1; i++) arr[i] += sh;
  };
  for (let j = 0; j < n; j++) {
    const b = use[j];
    const L = new Float64Array(HEAT_NB), Sx = new Float64Array(HEAT_NB);
    gL.push(L); gS.push(Sx);
    // 只统计落在可见价格区间的成交部分，避免区间外 K 线把量全压到边界档
    const ovl = Math.min(b.h, pHi) - Math.max(b.l, pLo);
    const vis = b.h > b.l ? clamp(ovl / (b.h - b.l), 0, 1) : (b.l >= pLo && b.l <= pHi ? 1 : 0);
    if (!(vis > 0)) continue;
    const w = (b.v > 0 ? b.v : 0) * Math.pow(0.5, (n - 1 - j) / half) * vis;
    const rng = b.h - b.l;
    let clv = rng > 0 ? (2 * b.c - b.h - b.l) / rng : (b.c >= b.o ? 1 : -1);
    clv = clamp(isFinite(clv) ? clv : 0, -1, 1);
    const shareL = (1 + clv) / 2;
    put(L, b.l, b.c, w * shareL);            // 多头筹码：低位买入区
    put(Sx, b.c, b.h, w * (1 - shareL));     // 空头筹码：高位卖出区
  }

  // 清算位移：多单清算价 = 开仓价×(1−1/杠杆)，空单 = 开仓价×(1+1/杠杆)。
  // 落在图外的位移直接丢弃（夹到边界会造出假墙）；丢弃后按原总量等比还原，
  // 保证多空两侧总量守恒，可见性只改变分布形状，不制造方向偏差。
  const halfFrac = (pHi - pLo) / 2 / mid;
  const levs = levForSpan(halfFrac);
  const shift = (src, dir) => {
    const out = new Float64Array(HEAT_NB);
    let srcTot = 0;
    for (let i = 0; i < HEAT_NB; i++) srcTot += src[i] > 0 ? src[i] : 0;
    if (!(srcTot > 0)) return out;
    for (const [lev, wt] of levs) {
      const k = dir < 0 ? (1 - 1 / lev) : (1 + 1 / lev);
      if (!(k > 0)) continue;
      for (let i = 0; i < HEAT_NB; i++) {
        const fi = idxOf((pLo + (i + 0.5) * step) / k);
        if (fi < -0.5 || fi > HEAT_NB - 0.5) continue;     // 图外：不计入
        const a = Math.max(0, Math.min(HEAT_NB - 1, Math.floor(fi)));
        const b2 = Math.max(0, Math.min(HEAT_NB - 1, a + 1));
        const f = clamp(fi - a, 0, 1);
        out[i] += wt * (src[a] * (1 - f) + src[b2] * f);
      }
    }
    let sum = 0;
    for (let i = 0; i < HEAT_NB; i++) sum += out[i];
    if (sum > 0) { const r = srcTot / sum; for (let i = 0; i < HEAT_NB; i++) out[i] *= r; }
    return out;
  };

  const grid = [];
  let maxV = 0;
  for (let j = 0; j < n; j++) {
    const L = shift(gL[j], -1), Sx = shift(gS[j], 1), row = [];
    for (let i = 0; i < HEAT_NB; i++) {
      const l = L[i] > 0 ? L[i] : 0, s = Sx[i] > 0 ? Sx[i] : 0;
      row.push({ l, s });
      if (l + s > maxV) maxV = l + s;
    }
    grid.push(row);
  }

  // 用真实多空持仓比校准多空总量：几何分配只决定「谁在上谁在下」，
  // 偏向（谁多谁少）交由交易所真实多空比决定，避免纯几何推测造成偏差。
  let tl = 0, ts = 0;
  for (const row of grid) for (const c of row) { tl += c.l; ts += c.s; }
  h_lsCalib: if (lsInfo && lsInfo.ls > 0 && tl + ts > 0) {
    // 真实多空比长期偏向多头（散户结构），全额校准会让下方燃料永远更厚、方向长期看空。
    // 先向 50% 收缩再校准：保留真实偏向，避免把「多头多」直接等价成「该做空」。
    const raw = clamp(lsInfo.ls / (1 + lsInfo.ls), 0.15, 0.85);
    const target = clamp(0.5 + (raw - 0.5) * 0.65, 0.2, 0.8);
    const cur = tl / (tl + ts);
    if (!(cur > 0.01 && cur < 0.99)) break h_lsCalib;
    const tot = tl + ts;
    const fl = clamp(tot * target / tl, 0.1, 10), fs = clamp(tot * (1 - target) / ts, 0.1, 10);
    for (const row of grid) for (const c of row) { c.l *= fl; c.s *= fs; }
    tl *= fl; ts *= fs;
  }
  maxV = 0;
  for (const row of grid) for (const c of row) if (c.l + c.s > maxV) maxV = c.l + c.s;

  const rows = [];
  for (let i = 0; i < HEAT_NB; i++) {
    let l = 0, s = 0;
    for (const row of grid) { l += row[i].l; s += row[i].s; }
    rows.push({ p: pLo + (i + 0.5) * step, long: l, short: s });
  }
  return finishHeat({ grid, rows, pLo, pHi, step, px: mid, maxV, times: use.map(b => b.t),
                      label, grade, lsInfo, levs: levs.map(l => Math.round(l[0])) });
}

/* ---------- 清算引力模型：由筹码热力图反推多空方向 ---------- */
// 核心假设（Coinglass 清算热力图的通行读法）：流动性会朝「清算燃料更近更厚」的一侧运动。
//   现价上方堆积的是空单清算位 → 需要价格上行才被击穿 → 击穿后强平回补形成轧空加速 = 偏多引力
//   现价下方堆积的是多单清算位 → 需要价格下行才被击穿 → 击穿后强平抛售形成多杀多 = 偏空引力
// 打分构成：清算池引力 ±52 > 近端清算墙 ±22 > 趋势确认 ±18 > 资金费率 ±12 > 多空持仓比 ±10
// 趋势只做确认不做主导，避免与清算结论互相抵消；样本外无法验证，仅作方向参考。
// 距离尺度：以热力图半跨为主、ATR 兜底。用 ATR 直接归一会让短周期的距离全部放大到几十 ATR，
// 衰减失去分辨力；用图跨度则 15m 与 4h 可比，语义就是「在图上的远近」。
function heatScaleOf(heat, atrV) {
  const half = (isFinite(heat.pHi) && isFinite(heat.pLo) && heat.pHi > heat.pLo)
    ? (heat.pHi - heat.pLo) * 0.5 : 0;
  const a = atrV > 0 ? atrV : 0;
  const s = Math.max(half, a);
  return s > 0 ? s : 1;
}

function liqPools(heat, px, atrV) {
  const sc0 = heatScaleOf(heat, atrV);
  let up = 0, dn = 0, upRaw = 0, dnRaw = 0, tot = 0;
  for (const r of heat.rows || []) {
    const l = r.long > 0 ? r.long : 0, s = r.short > 0 ? r.short : 0;
    tot += l + s;
    const w = 1 / (1 + Math.abs(r.p - px) / sc0 * 1.2);   // 距离衰减：近处燃料更有吸引力
    if (r.p > px) { up += s * w; upRaw += s; }
    else if (r.p < px) { dn += l * w; dnRaw += l; }
  }
  return { up, dn, upRaw, dnRaw, tot,
           upPct: tot > 0 ? upRaw / tot * 100 : 0,
           dnPct: tot > 0 ? dnRaw / tot * 100 : 0 };
}

// 找现价上下两侧「最近且够厚」的清算密集带，作为磁吸目标与失效位
function magnetBands(heat, px, atrV) {
  const rows = heat.rows || [];
  const n = rows.length;
  if (!n || !(heat.step > 0)) return { up: null, dn: null };
  const a = atrV > 0 ? atrV : px * 0.004;
  const sc0 = heatScaleOf(heat, atrV);
  const win = Math.max(3, Math.round(n * 0.06));
  const s = rows.map(r => (r.long > 0 ? r.long : 0) + (r.short > 0 ? r.short : 0));
  let mx = 0; for (const v of s) if (v > mx) mx = v;
  if (!(mx > 0)) return { up: null, dn: null };

  const pick = side => {
    let best = null;
    for (let i = 0; i + win <= n; i++) {
      let t = 0; for (let k = i; k < i + win; k++) t += s[k];
      const v = t / (mx * win);
      if (!(v >= 0.32)) continue;
      const p = heat.pLo + (i + win / 2) * heat.step;
      // 中心落在现价所在档附近的带不构成「磁吸」，必须离开现价至少 0.75 档
      const off = (p - px) / heat.step;
      if (side > 0 ? off < 0.75 : off > -0.75) continue;
      const d = Math.max(0.15, Math.abs(p - px) / sc0);
      const dpct = Math.abs(p / px - 1) * 100;          // 价格偏离百分比，跨周期可比
      const score = v / (1 + d * 0.9);
      if (!best || score > best.score) best = { p, v, d, dpct, score };
    }
    return best;
  };
  return { up: pick(1), dn: pick(-1) };
}

/* 价格带区间：把热力图里「连续的高密度档」合并成带，给出 [lo,hi]、强度、宽度与距现价百分比。
 * 只给一个中心价是不够的 —— 止损是成片堆在那里的，做市商扫的是一整个区间而不是一个点。
 * 返回按 score（强且近）降序排列的带列表。 */
function liqZones(heat, px, atrV, opt = {}) {
  const rows = (heat && heat.rows) || [];
  const n = rows.length;
  if (!heat || !n || !(heat.step > 0)) return [];
  const a = atrV > 0 ? atrV : px * 0.004;
  const sc0 = heatScaleOf(heat, atrV);
  const tot = rows.map(r => (r.long > 0 ? r.long : 0) + (r.short > 0 ? r.short : 0));
  let mx = 0; for (const v of tot) if (v > mx) mx = v;
  if (!(mx > 0)) return [];

  // 3 点平滑，避免单档噪声造出假峰
  const sm = tot.map((v, i) => {
    let t = v, c = 1;
    if (i > 0) { t += tot[i - 1]; c++; }
    if (i < n - 1) { t += tot[i + 1]; c++; }
    return t / c;
  });
  let smx = 0; for (const v of sm) if (v > smx) smx = v;
  if (!(smx > 0)) return [];

  const thr = opt.thr != null ? opt.thr : 0.22;        // 相对峰值的入门门槛
  const maxW = Math.max(3, Math.round(n * 0.34));      // 再宽就不是「带」而是整张图了
  const ipx = clamp(Math.floor((px - heat.pLo) / heat.step), -1, n);

  /* 局部峰 → 半高扩展。
   * 不能简单取「所有高于阈值的连续档」：清算密度从现价向外单调衰减，
   * 那样会把半张图并成一条巨宽的带（实测宽 142 个 ATR），完全失去定位意义。 */
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] / smx < thr) continue;
    if (sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && (sm[i] > sm[i - 1] || sm[i] > sm[i + 1])) peaks.push(i);
  }
  /* 近价兜底：密度从现价向外单调衰减时，某一侧的「峰」就在现价本身，
   * 于是那侧一个局部峰都找不到 —— 实测出现过「只识别出下方带、上方带为空」。
   * 而做市商最关心的恰恰是紧邻现价的这批止损，所以把现价两侧各补一个种子峰。
   * 补出来的带随后会在现价处被切成上下两半，不会退化成一条跨现价的巨带。 */
  for (const i of [ipx, ipx + 1]) {
    if (i < 0 || i > n - 1 || peaks.indexOf(i) >= 0) continue;
    if (sm[i] / smx >= thr) peaks.push(i);
  }
  if (!peaks.length) {                                  // 单调序列：峰值那一档就是唯一的带
    let bi = 0; for (let i = 1; i < n; i++) if (sm[i] > sm[bi]) bi = i;
    if (sm[bi] / smx >= thr) peaks.push(bi);
  }

  const segs = [];
  for (const pi of peaks) {
    const floorV = Math.max(sm[pi] * 0.55, smx * thr * 0.9);
    let i0 = pi, i1 = pi;
    while (i0 - 1 >= 0 && sm[i0 - 1] >= floorV && i1 - i0 + 1 < maxW) i0--;
    while (i1 + 1 < n && sm[i1 + 1] >= floorV && i1 - i0 + 1 < maxW) i1++;
    // 与已有区间重叠则合并，避免同一片止损被拆成两条带
    const hit = segs.find(s => i0 <= s.i1 + 1 && i1 >= s.i0 - 1);
    if (hit) { hit.i0 = Math.min(hit.i0, i0); hit.i1 = Math.max(hit.i1, i1); hit.pi = sm[pi] > sm[hit.pi] ? pi : hit.pi; continue; }
    segs.push({ i0, i1, pi });
  }

  const out = [];
  const minW = Math.min(2, Math.max(1, Math.round(n * 0.03)));

  /* 先在现价处切成上下两半，再让每一半各自围绕「段内真实峰值」收敛。
   * 顺序不能颠倒：
   *   · 跨越现价的带必须先切开 —— 价格已经在带里就谈不上「磁吸」；
   *   · 收敛必须放在切开之后 —— 若先按全局峰值收敛，弱的一侧会被强的一侧整段吞掉，
   *     实测出现过「只识别出下方带、上方带为空」；
   *   · 种子峰（紧邻现价那一档）的平滑值常被对侧空白拉低，直接拿它算半高门槛
   *     会得到过低的门槛，把整条下侧并成 10 个 ATR 的宽带。按段内峰值重算即可收敛。 */
  const halves = [];
  for (const sg of segs) {
    if (ipx >= sg.i0 && ipx <= sg.i1) halves.push([sg.i0, ipx - 1], [ipx + 1, sg.i1]);
    else halves.push([sg.i0, sg.i1]);
  }
  for (let [i0, i1] of halves) {
    if (i1 - i0 + 1 < minW) continue;
    let pi = i0;
    for (let i = i0; i <= i1; i++) if (sm[i] > sm[pi]) pi = i;
    const floorV = Math.max(sm[pi] * 0.55, smx * thr * 0.9);
    let a0 = pi, a1 = pi;
    while (a0 - 1 >= i0 && sm[a0 - 1] >= floorV && a1 - a0 + 1 < maxW) a0--;
    while (a1 + 1 <= i1 && sm[a1 + 1] >= floorV && a1 - a0 + 1 < maxW) a1++;
    i0 = a0; i1 = a1;
    if (i1 - i0 + 1 < minW) continue;
    {
      const lo = heat.pLo + i0 * heat.step;
      const hi = heat.pLo + (i1 + 1) * heat.step;
      if (!(hi > lo)) continue;
      let t = 0, pv = 0;
      for (let k = i0; k <= i1; k++) { t += tot[k]; if (sm[k] > pv) pv = sm[k]; }
      const mid = (lo + hi) / 2;
      const v = clamp(pv / smx, 0, 1);                   // 带内峰值相对强度
      const d = Math.max(0.15, Math.abs(mid - px) / sc0);
      out.push({
        lo, hi, mid, w: hi - lo,
        side: mid >= px ? 'up' : 'down',
        v,
        mass: clamp(t / (mx * n) * 4.5, 0, 1),           // 该带占全图燃料的比例（放大后便于展示）
        atrW: a > 0 ? (hi - lo) / a : 0,                 // 带宽折合多少个 ATR
        dpct: (mid / px - 1) * 100,                      // 带中心距现价百分比（带符号）
        d, i0, i1,
        score: v / (1 + d * 0.9),
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function liqSignal(bars, heat, opt = {}) {
  const c = bars.map(b => b.c);
  const i = c.length - 1;
  const px = c[i];
  const dp = isFinite(opt.dp) ? opt.dp : 2;
  const A = atr(bars);
  const a = A[i] > 0 ? A[i] : px * 0.004;
  const atrPct = a / px * 100;
  const P = liqPools(heat, px, a);
  const M = magnetBands(heat, px, a);
  const fund = isFinite(opt.funding) ? opt.funding : null;
  const ls = isFinite(opt.ls) && opt.ls > 0 ? opt.ls : null;

  let sc = 0;
  const parts = [];
  const add = (k, v) => { if (isFinite(v)) { sc += v; parts.push({ k, v: +v.toFixed(2) }); } };

  // 1) 清算池引力差：多空两侧燃料之差（距离加权）
  const tot = P.up + P.dn;
  if (tot > 0) add('清算池引力', clamp((P.up - P.dn) / tot, -1, 1) * 52);

  // 2) 近端清算墙：更近更厚的那一侧先被吃掉
  const nUp = M.up ? M.up.v / (1 + M.up.d * 0.9) : 0;
  const nDn = M.dn ? M.dn.v / (1 + M.dn.d * 0.9) : 0;
  if (nUp + nDn > 0) add('近端清算墙', clamp((nUp - nDn) / (nUp + nDn), -1, 1) * 22);

  // 3) 资金费率：多头付费（正）说明多头拥挤，回撤时更容易连锁强平
  if (fund != null) add('资金费率', -clamp(fund / 0.0006, -1, 1) * 12);

  // 4) 多空持仓比不再单独计分：它已通过筹码校准进入清算池（多头占比高 → 下方燃料厚），
  //    再扣一次会让所有品种系统性偏空。仅在依据中展示。

  // 5) 趋势确认：与清算方向一致才有效，权重低于清算项
  // tanh 压缩：低波动时的小幅噪声不会把趋势项直接打满
  const mom = i >= 10 ? (px / c[i - 10] - 1) * 100 : 0;
  let tn = atrPct > 0 ? Math.tanh(mom / (atrPct * Math.sqrt(10))) : 0;
  const ma = sma(c, 25)[i];
  tn = clamp(ma != null ? tn * 0.8 + (px > ma ? 0.2 : -0.2) : tn, -1, 1);
  add('趋势确认', tn * 18);

  sc = clamp(sc, -100, 100);
  const dir = sc > 16 ? 'long' : sc < -16 ? 'short' : 'wait';

  // 关键位：顺方向的清算带 = 目标，反方向的清算带 = 失效位
  const magUp = M.up, magDn = M.dn;
  let trigger = null, tp = null, sl = null;
  const stepPx = heat.step > 0 ? heat.step : a * 0.3;
  if (dir === 'long') {
    trigger = magUp ? magUp.p : px + a * 0.8;
    tp = (magUp ? magUp.p : px + a * 1.6) + Math.max(a * 0.5, stepPx * 2);
    sl = magDn ? magDn.p - a * 0.25 : px - a * 1.5;
  } else if (dir === 'short') {
    trigger = magDn ? magDn.p : px - a * 0.8;
    tp = (magDn ? magDn.p : px - a * 1.6) - Math.max(a * 0.5, stepPx * 2);
    sl = magUp ? magUp.p + a * 0.25 : px + a * 1.5;
  }
  if (dir === 'long' && !(sl < px && tp > px)) { sl = px - a * 1.5; tp = px + a * 2.4; }
  if (dir === 'short' && !(sl > px && tp < px)) { sl = px + a * 1.5; tp = px - a * 2.4; }
  if (dir === 'wait') { trigger = null; sl = px - a * 2.0; tp = px + a * 2.0; }
  if (!isFinite(sl)) sl = px - a * 1.5;
  if (!isFinite(tp)) tp = px + a * 1.5;

  const rs = [];
  rs.push(`上方空单清算 ${fmt(P.upPct, 1)}% / 下方多单清算 ${fmt(P.dnPct, 1)}%`);
  if (magUp) rs.push(`上方 ${fmt(magUp.p, dp)} 有清算密集带（强度 ${Math.round(magUp.v * 100)}%，距现价 ${fmt(magUp.dpct, 2)}%）`);
  if (magDn) rs.push(`下方 ${fmt(magDn.p, dp)} 有清算密集带（强度 ${Math.round(magDn.v * 100)}%，距现价 ${fmt(magDn.dpct, 2)}%）`);
  if (fund != null) rs.push(`资金费率 ${(fund * 100).toFixed(4)}%（${fund >= 0 ? '多头付费 · 拥挤偏多' : '空头付费 · 拥挤偏空'}）`);
  if (ls != null) rs.push(`多空持仓比 ${fmt(ls, 2)}${ls > 1.4 ? '（多头拥挤，已计入下方燃料）' : ls < 0.8 ? '（空头拥挤）' : ''}`);
  rs.push(`趋势${(tn >= 0 ? '向上' : '向下')}${dir === 'wait' ? '' : ((dir === 'long') === (tn >= 0) ? ' · 与清算方向一致' : ' · 与清算方向背离')}`);

  return {
    dir, score: sc, strength: Math.abs(sc), px, atr: a, atrPct, mom, trend: tn,
    up: P.up, dn: P.dn, upPct: P.upPct, dnPct: P.dnPct,
    netBias: heat.netBias, funding: fund, ls,
    magUp, magDn, trigger, tp, sl, parts, reasons: rs,
    posPct: clamp(1.0 / (1.6 * atrPct) * 10, 5, 60),
  };
}

/* --- 由 Coinglass 清算记录构建 --- */
function buildHeatFromCG(list, px, minSpan) {
  const mid = num(px);
  if (!(mid > 0) || !list.length) return null;
  let lo = Infinity, hi = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const o of list) {
    if (o.price < lo) lo = o.price;
    if (o.price > hi) hi = o.price;
    if (o.time != null) { if (o.time < t0) t0 = o.time; if (o.time > t1) t1 = o.time; }
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const [pLo, pHi] = heatRange(mid, lo, hi, minSpan);
  const step = (pHi - pLo) / HEAT_NB;
  if (!(step > 0)) return null;

  const hasT = isFinite(t0) && t1 > t0;
  const nCol = Math.min(HEAT_NT, Math.max(12, Math.round(Math.sqrt(list.length) * 3)));
  const grid = Array.from({ length: nCol }, () => Array.from({ length: HEAT_NB }, () => ({ l: 0, s: 0 })));
  let maxV = 0;
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const price = num(o.price ?? o.p ?? o.liquidationPrice ?? o.avgPrice);
    if (!(price > 0)) continue;
    const vol = Math.abs(num(o.vol ?? o.volUsd ?? o.usd ?? o.amount ?? o.qty ?? o.size ?? 1)) || 1;
    const sd = String(o.side ?? o.direction ?? o.type ?? '').toUpperCase();
    const j = hasT ? clamp(Math.floor((o.time - t0) / (t1 - t0) * nCol), 0, nCol - 1) : nCol - 1;
    const i = clamp(Math.floor((price - pLo) / step), 0, HEAT_NB - 1);
    const c = grid[j][i];
    if (/^L$|^LONG|^BUY/.test(sd)) c.l += vol;
    else if (/^S$|^SHORT|^SELL/.test(sd)) c.s += vol;
    else { c.l += vol / 2; c.s += vol / 2; }
    if (c.l + c.s > maxV) maxV = c.l + c.s;
  }
  const rows = [];
  for (let i = 0; i < HEAT_NB; i++) {
    let l = 0, s = 0;
    for (const row of grid) { l += row[i].l; s += row[i].s; }
    rows.push({ p: pLo + (i + 0.5) * step, long: l, short: s });
  }
  const times = hasT
    ? Array.from({ length: nCol }, (_, j) => t0 + (t1 - t0) * (j + 0.5) / nCol)
    : [];
  return finishHeat({ grid, rows, pLo, pHi, step, px: mid, maxV, times,
                      label: '历史爆仓记录 · CoinGlass', grade: 'real', lsInfo: null });
}

/* --- 汇总关键区间 --- */
function finishHeat(h) {
  // 滑动窗口找多/空筹码最密集的价格带
  const win = Math.max(3, Math.round(HEAT_NB * 0.08));
  const best = key => {
    let bi = 0, bv = -1;
    for (let i = 0; i + win <= HEAT_NB; i++) {
      let s = 0;
      for (let k = i; k < i + win; k++) s += h.rows[k][key];
      if (s > bv) { bv = s; bi = i; }
    }
    return { i0: bi, i1: bi + win - 1, v: Math.max(0, bv) };
  };
  const bl = best('long'), bs = best('short');
  const pOf = i => h.pLo + (i + 0.5) * h.step;
  let tl = 0, ts = 0;
  for (const r of h.rows) { tl += r.long; ts += r.short; }
  const tot = tl + ts;
  h.longBand  = { lo: h.pLo + bl.i0 * h.step, hi: h.pLo + (bl.i1 + 1) * h.step, v: bl.v };
  h.shortBand = { lo: h.pLo + bs.i0 * h.step, hi: h.pLo + (bs.i1 + 1) * h.step, v: bs.v };
  h.longPct  = tot > 0 ? tl / tot * 100 : 50;
  h.shortPct = tot > 0 ? ts / tot * 100 : 50;
  h.netBias  = tot > 0 ? (tl - ts) / tot * 100 : 0;
  h.bandMax  = Math.max(bl.v, bs.v, 1);
  /* 真实清算记录链路没有假设；推算链路一律挂上模型说明，
   * 让界面任何一处引用这张图时都能顺手拿到「它是什么、哪里不可信」。 */
  h.model = h.grade === 'real' ? null : Object.assign({}, HEAT_MODEL, {
    levs: (h.levs && h.levs.length) ? h.levs : null,
    calibrated: !!(h.lsInfo && h.lsInfo.ls > 0),
  });
  return h;
}

/* --- Coinglass 清算记录缓存（5 分钟），四格共用同一份真实数据 --- */
const CG_TTL = 300000;
async function cgRecords(symId) {
  const c = S.cgLiq[symId];
  if (c && now() - c.ts < CG_TTL) return c.list;
  const list = await fetchCoinglassLiq(symId);
  S.cgLiq[symId] = { list, ts: now() };
  return list;
}

/* --- 构建单张热力图：CoinGlass 真实清算 > 币安合约推算 > 本地估算 --- */
async function buildHeatFor(symId, tfKey, bars, px, minSpan) {
  const s = SYMS[symId];
  const span = minSpan || TF_SPAN[tfKey] || HEAT_MIN_SPAN;   // 周期 → 关注的价格尺度
  const wantCG = HEAT_MODE === 'auto' || HEAT_MODE === 'coinglass';
  if (wantCG) {
    if (!binSym(s)) S.heatErr = '该品种无币安合约映射，Coinglass 无对应清算数据';
    else if (!CG_KEY) S.heatErr = '未配置 Coinglass API Key（数据源设置中填写后即用真实清算数据）';
    else {
      try {
        const hm = buildHeatFromCG(await cgRecords(symId), px, span);
        if (hm) return hm;
      } catch (e) { S.heatErr = String(e.message || e); }
    }
  }

  if (HEAT_MODE !== 'local' && binSym(s) && bars.length >= 8) {
    const ls = await fetchBinanceLS(symId).catch(() => null);
    const hm = buildHeatFromBars(bars, px, ls,
      ls ? '潜在清算区模型 · Binance 成交校准' : '潜在清算区模型 · Binance K线（无多空比校准）',
      ls ? 'semi' : 'est', span);
    if (hm) return hm;
  }

  /* K 线不足 8 根时热力图直接放弃，不拿合成序列凑数。
   * 旧版会用 mkBars 造 240 根假 K 线去推「本地估算」热力图 —— 那张图看着像筹码分布，
   * 实际是随机数画出来的，做市商结论却建立在它上面。宁可显示「无清算数据」。 */
  if (bars.length < 8) { S.heatErr = 'K 线数据不足，无法推算筹码分布'; return null; }
  return buildHeatFromBars(bars, px, null, '潜在清算区模型 · 仅 K 线推算', 'est', span);
}

/* --- 带缓存的按周期热力图：四格信号各自取一份，价格波动小于 0.08% 时复用 --- */
const _heatCache = new Map();
async function heatForSymTf(symId, tfKey) {
  const kd = S.klines[symId] && S.klines[symId][tfKey];
  const bars = (kd && kd.bars) || [];
  const px = (S.quotes[symId] && S.quotes[symId].price)
    || (bars.length ? bars[bars.length - 1].c : null);
  if (!(px > 0)) return null;   // 连一个真实价格都没有 → 不做任何推算
  const lastT = bars.length ? bars[bars.length - 1].t : 0;
  const q = Math.round(1 / 0.0008 * Math.log(px > 0 ? px : 1));   // 对数价格分桶，约 0.08%
  const key = [symId, tfKey, bars.length, lastT, q, HEAT_MODE, CG_KEY ? 1 : 0].join('|');
  if (_heatCache.has(key)) return _heatCache.get(key);

  const h = await buildHeatFor(symId, tfKey, bars, px).catch(() => null);  if (h) {
    if (_heatCache.size > 80) _heatCache.clear();
    _heatCache.set(key, h);
    S.heats[symId] = S.heats[symId] || {};
    S.heats[symId][tfKey] = h;
  }
  return h;
}

/* --- 四格信号：每个周期各准备一张热力图（带缓存），再据此判方向 --- */
async function loadAllHeat(symId, tfKeys) {
  await Promise.all(tfKeys.map(k => heatForSymTf(symId, k).catch(() => null)));
}

/* --- 编排：按优先级取数（当前展示用） --- */
async function loadHeat(symId, tfKey) {
  return heatForSymTf(symId, tfKey);
}

/* --- 数据源/Key 变更后：作废该品种的全部热力图缓存并重算四格 --- */
function invalidateHeat(symId) {
  for (const k of Array.from(_heatCache.keys())) {
    if (k.split('|')[0] === symId) _heatCache.delete(k);
  }
  if (symId) { delete S.heats[symId]; delete S.cgLiq[symId]; }
  else { S.heats = {}; S.cgLiq = {}; }
}

/* 切换数据源 / 填写 Key 后：四格方向必须跟着新的清算数据等级重判，不能只刷当前那张图 */
async function reloadHeatAll() {
  const cur = S.sym;
  invalidateHeat(cur);
  // 1) 当前品种四个周期立刻重算
  await loadAllHeat(cur, TFS.map(t => t.k)).catch(() => null);
  if (S.sym !== cur) return;
  renderSignals(); renderOverview();
  refreshHeat(cur, S.tf).catch(() => {});
  // 2) 其余品种后台补齐（总览用的是 1h 判向）
  SYM_LIST.filter(s => s.id !== cur).forEach(s => {
    invalidateHeat(s.id);
    (async () => {
      await loadKlines(s.id, '1h').catch(() => {});
      await heatForSymTf(s.id, '1h').catch(() => null);
      if (S.sym === cur) renderOverview();
    })();
  });
}

/* --- 绘制 --- */
const hcv = $('#heat'), hctx = hcv.getContext('2d');
function fitHeat() {
  const r = window.devicePixelRatio || 1;
  const w = hcv.clientWidth || 620, h = hcv.clientHeight || 340;
  hcv.width = Math.round(w * r); hcv.height = Math.round(h * r);
  hctx.setTransform(r, 0, 0, r, 0, 0);
  return { w, h };
}
let heatBox = null;   // 供 hover 命中计算

function heatColor(net, inten) {
  const t = clamp(inten, 0, 1), a = clamp(Math.abs(net), 0, 1);
  const [r, g, b] = net >= 0 ? [18, 161, 80] : [225, 59, 59];     // 净偏多=绿，净偏空=红
  const m = t * (0.26 + 0.74 * a);
  return `rgb(${Math.round(255 + (r - 255) * m)},${Math.round(255 + (g - 255) * m)},${Math.round(255 + (b - 255) * m)})`;
}

/* 点阵配色：与 heatColor 同色系，但透明度单独表达「密度」。
 * 密度由圆点直径表达（面积正比），这里只做可见度补偿 ——
 * 小点如果还用浅色，弱档会直接看不见，密度差异就白算了。 */
function heatDot(net, inten) {
  const a = clamp(Math.abs(net), 0, 1);
  const [r, g, b] = net >= 0 ? [18, 161, 80] : [225, 59, 59];
  const al = clamp(0.3 + 0.7 * inten, 0.3, 0.96) * (0.55 + 0.45 * a);
  return `rgba(${r},${g},${b},${al.toFixed(3)})`;
}

const _hzCache = new Map();
function heatZonesOf(H, px, atrV) {
  const key = (H.px | 0) + '|' + H.pLo + '|' + H.pHi + '|' + Math.round(H.maxV || 0) + '|' + H.rows.length;
  if (!_hzCache.has(key)) {
    if (_hzCache.size > 40) _hzCache.clear();
    // 只保留带符号最强的 4 段：画满十几条框之后图就只剩框了，反而看不出筹码在哪
    _hzCache.set(key, liqZones(H, px, atrV).slice(0, 4));
  }
  return _hzCache.get(key);
}

function drawHeat() {
  const H = S.heat;
  const { w, h } = fitHeat();
  hctx.clearRect(0, 0, w, h);
  const padL = 62, padR = 108, padT = 8, padB = 22;
  const gw = w - padL - padR, gh = h - padT - padB;
  if (!H || !H.grid || !H.grid.length || gw <= 10 || gh <= 10) {
    // 区分「还在拉」和「根本拉不到」：没有 K 线就谈不上热力图，写「加载中」会让人干等
    const kd0 = (S.klines[S.sym] || {})[S.tf];
    hctx.fillStyle = '#9a9aa0'; hctx.font = '11px ' + MONO;
    hctx.fillText(kd0 && kd0.bars.length ? '本周期无清算数据' : '本周期无真实 K 线 · 无清算数据', 12, h / 2);
    heatBox = null; return;
  }
  const s = SYMS[S.sym], dp = s.dp;
  const nCol = H.grid.length;
  const cw = gw / nCol, ch = gh / HEAT_NB;
  const pyOf = p => padT + gh - (p - H.pLo) / (H.pHi - H.pLo) * gh;

  // ATR 取自当前周期真实 K 线；拿不到就用 0.4% 兜底（只影响带宽折算，不影响筹码分布本身）
  let a = 0;
  const kd = (S.klines[S.sym] || {})[S.tf];
  if (kd && kd.bars && kd.bars.length) { const A = atr(kd.bars); a = A[A.length - 1] || 0; }
  if (!(a > 0)) a = H.px * 0.004;
  const Z = heatZonesOf(H, H.px, a);
  heatBox = { padL, padT, gw, gh, cw, ch, nCol, dp, H, zones: Z, atr: a };

  /* 点阵：圆点大小 = 该价区筹码密度，颜色 = 净多空偏向。
   * 用点阵而不是实心色块，是因为色块在小格子上会连成一片，看不出哪一档才是真正的密集中心；
   * 点的直径按 sqrt(强度) 缩放（面积正比于强度），弱档会缩成小点，强档一眼就顶出来。 */
  const cell = Math.min(cw, ch), RMAX = Math.max(1.2, cell * 0.47);
  for (let j = 0; j < nCol; j++) {
    const cx = padL + (j + 0.5) * cw;
    for (let i = 0; i < HEAT_NB; i++) {
      const c = H.grid[j][i], tot = c.l + c.s;
      if (!(tot > 0)) continue;
      const inten = H.maxV > 0 ? Math.pow(tot / H.maxV, 0.55) : 0;
      const r = RMAX * Math.sqrt(clamp(inten, 0, 1));
      if (r < 0.32) continue;
      hctx.fillStyle = heatDot((c.l - c.s) / tot, inten);
      hctx.beginPath();
      hctx.arc(cx, padT + (HEAT_NB - 1 - i + 0.5) * ch, r, 0, Math.PI * 2);
      hctx.fill();
    }
  }

  // 网格淡线
  hctx.strokeStyle = '#f0f0ee'; hctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const y = Math.round(padT + gh * k / 4) + .5;
    hctx.beginPath(); hctx.moveTo(padL, y); hctx.lineTo(padL + gw, y); hctx.stroke();
  }

  /* 区间标注：识别出的清算带画成虚线框，框内左上角写价格区间、右上角写强度。
   * 「区间 + 数字」比单纯看颜色浓淡精确得多 —— 挂单和失效位都要落到具体价位上。 */
  Z.forEach((z, k) => {
    const yTop = pyOf(z.hi), yBot = pyOf(z.lo);
    if (yBot - yTop < 3) return;
    const col = z.side === 'up' ? '#e13b3b' : '#12a150';
    hctx.save();
    hctx.strokeStyle = col; hctx.globalAlpha = .62; hctx.lineWidth = 1;
    hctx.setLineDash([4, 3]);
    hctx.strokeRect(padL + .5, Math.max(padT, yTop) + .5, gw - 1, Math.min(gh, yBot - yTop) - 1);
    hctx.setLineDash([]); hctx.globalAlpha = 1;
    hctx.font = '9px ' + MONO; hctx.textAlign = 'left';
    // 区间数字：贴在框内侧，窄图时自动省略到「下沿」一个数
    const wide = gw > 300;
    const rg = wide ? `${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}` : fmt(z.side === 'up' ? z.lo : z.hi, dp);
    const ty = clamp(yTop + 7, padT + 8, padT + gh - 4);
    hctx.fillStyle = 'rgba(255,255,255,.82)';
    const tw = hctx.measureText(rg).width + 6;
    hctx.fillRect(padL + 3, ty - 7, tw, 13);
    hctx.fillStyle = col; hctx.fillText(rg, padL + 6, ty);
    // 强度与距离
    const info = `${Math.round(z.v * 100)}% · ${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%`;
    hctx.textAlign = 'right';
    const iw = hctx.measureText(info).width + 6;
    hctx.fillStyle = 'rgba(255,255,255,.82)';
    hctx.fillRect(padL + gw - 3 - iw, ty - 7, iw, 13);
    hctx.fillStyle = col; hctx.fillText(info, padL + gw - 6, ty);
    hctx.textAlign = 'left';
    hctx.restore();
  });

  // 现价线（带数字标签，避免和图上的区间数字混淆）
  const yPx = pyOf(H.px);
  if (isFinite(yPx) && yPx > padT - 2 && yPx < padT + gh + 2) {
    hctx.strokeStyle = '#16161a'; hctx.lineWidth = 1; hctx.setLineDash([3, 3]);
    hctx.beginPath(); hctx.moveTo(padL, yPx); hctx.lineTo(padL + gw, yPx); hctx.stroke();
    hctx.setLineDash([]);
    const lbl = '现价 ' + fmt(H.px, dp);
    hctx.font = '600 10px ' + MONO;
    const lw = hctx.measureText(lbl).width + 10;
    hctx.fillStyle = '#16161a'; hctx.fillRect(padL + gw - lw - 2, clamp(yPx, padT, padT + gh) - 8, lw, 16);
    hctx.fillStyle = '#fff'; hctx.textAlign = 'left';
    hctx.fillText(lbl, padL + gw - lw + 3, clamp(yPx, padT, padT + gh));
    hctx.textAlign = 'left';
  }

  // 多/空密集带标线
  [[H.longBand, '#12a150', '多头密集'], [H.shortBand, '#e13b3b', '空头密集']].forEach(([bd, col, nm]) => {
    const yc = pyOf((bd.lo + bd.hi) / 2);
    if (!isFinite(yc) || yc < padT || yc > padT + gh) return;
    hctx.strokeStyle = col; hctx.globalAlpha = .5; hctx.setLineDash([2, 4]);
    hctx.beginPath(); hctx.moveTo(padL, yc); hctx.lineTo(padL + gw, yc); hctx.stroke();
    hctx.setLineDash([]); hctx.globalAlpha = 1;
  });

  // 价格轴：6 等分（比原来的 4 等分更密，配合点阵读数）
  hctx.fillStyle = '#9a9aa0'; hctx.font = '9px ' + MONO;
  hctx.textAlign = 'right';
  for (let k = 0; k <= 6; k++) {
    const i = Math.round((HEAT_NB - 1) * (1 - k / 6));
    const y = padT + (HEAT_NB - 1 - i) * ch + ch / 2 + 3;
    hctx.fillText(fmt(H.pLo + (i + 0.5) * H.step, dp), padL - 6, y);
  }
  hctx.textAlign = 'left';

  // 右侧：多空筹码分布（左红=空头 / 右绿=多头）
  const hx = padL + gw + 12, hw = padR - 24, midX = hx + hw / 2;
  let rmax = 0;
  for (const r of H.rows) { if (r.long > rmax) rmax = r.long; if (r.short > rmax) rmax = r.short; }
  for (let i = 0; i < HEAT_NB; i++) {
    const y = padT + (HEAT_NB - 1 - i) * ch, r = H.rows[i];
    const lw = rmax > 0 ? r.long / rmax * (hw * 0.46) : 0;
    const sw = rmax > 0 ? r.short / rmax * (hw * 0.46) : 0;
    if (sw > 0) { hctx.fillStyle = 'rgba(225,59,59,.72)'; hctx.fillRect(midX - sw, y, sw, Math.max(1, ch - .4)); }
    if (lw > 0) { hctx.fillStyle = 'rgba(18,161,80,.72)'; hctx.fillRect(midX, y, lw, Math.max(1, ch - .4)); }
  }
  hctx.strokeStyle = '#ececeb';
  hctx.beginPath(); hctx.moveTo(midX, padT); hctx.lineTo(midX, padT + gh); hctx.stroke();
  hctx.fillStyle = '#9a9aa0'; hctx.font = '9px ' + MONO;
  hctx.fillText('空', hx, padT + gh + 13);
  hctx.textAlign = 'right'; hctx.fillText('多', hx + hw, padT + gh + 13); hctx.textAlign = 'left';

  // 时间轴
  hctx.fillStyle = '#9a9aa0'; hctx.font = '10px ' + MONO;
  const tArr = H.times || [];
  if (tArr.length >= 2) {
    for (let k = 0; k <= 3; k++) {
      const j = Math.round((nCol - 1) * k / 3);
      const t = tArr[Math.min(tArr.length - 1, j)];
      if (!t) continue;
      const d = new Date(t);
      const txt = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      hctx.textAlign = k === 0 ? 'left' : k === 3 ? 'right' : 'center';
      hctx.fillText(txt, padL + (j + (k === 0 ? 0 : k === 3 ? 1 : .5)) * cw, h - 6);
    }
    hctx.textAlign = 'left';
  }
}

/* --- 说明与统计 --- */
function renderHeatMeta() {
  const H = S.heat, el = $('#heatSrc');
  const lbl = (SYMS[S.sym] && SYMS[S.sym].label) || '—';
  if (!H) {
    /* 无清算数据时也必须把标题切到当前品种：早期 return 会让热力图卡顶着上一个品种的名字，
     * 切到没有清算源的品种时看到的是「ETH」，属于误导。 */
    el.textContent = '无清算数据'; el.className = 'src syn';
    $('#heatSym').textContent = lbl;
    $('#heatScale').textContent = '';
    $('#heatStats').innerHTML = '';
    $('#heatZones').innerHTML = '';
    const kd = (S.klines[S.sym] || {})[S.tf];
    const why = S.heatErr
      || (!(kd && kd.bars.length) ? `${(TF_MAP[S.tf] || {}).label || S.tf} 没有可用的真实 K 线` : '本周期清算数据不足');
    $('#heatNote').textContent = `${why} —— 页面不会用合成数据填充热力图。`;
    renderHeatModel(null);
    drawHeat();                       // 擦掉上一个品种的热力图，避免留一张不属于当前品种的图
    return;
  }
  el.textContent = H.label;
  el.className = 'src ' + (H.grade === 'real' ? 'real' : H.grade === 'semi' ? '' : 'syn');
  $('#heatSym').textContent = SYMS[S.sym].label;
  $('#heatScale').textContent = `价格区间 ${fmt(H.pLo, SYMS[S.sym].dp)} – ${fmt(H.pHi, SYMS[S.sym].dp)}`
    + ` · 跨度 ${((H.pHi - H.pLo) / H.px * 100).toFixed(2)}%`;

  const dp = SYMS[S.sym].dp;
  const toPx = p => (p / H.px - 1) * 100;
  $('#heatStats').innerHTML = [
    { k: '多头筹码密集区', v: `${fmt(H.longBand.lo, dp)} – ${fmt(H.longBand.hi, dp)}`,
      s: `距现价 ${pct(toPx((H.longBand.lo + H.longBand.hi) / 2))} · 跌破易触发多单强平`,
      c: 'var(--up)', w: H.longBand.v / H.bandMax * 100 },
    { k: '空头筹码密集区', v: `${fmt(H.shortBand.lo, dp)} – ${fmt(H.shortBand.hi, dp)}`,
      s: `距现价 ${pct(toPx((H.shortBand.lo + H.shortBand.hi) / 2))} · 突破易触发空单强平`,
      c: 'var(--down)', w: H.shortBand.v / H.bandMax * 100 },
    { k: '多空净偏向', v: (H.netBias >= 0 ? '多头 ' : '空头 ') + Math.abs(H.netBias).toFixed(1) + '%',
      s: `多 ${H.longPct.toFixed(1)}% · 空 ${H.shortPct.toFixed(1)}%`,
      c: H.netBias >= 0 ? 'var(--up)' : 'var(--down)', w: Math.min(100, Math.abs(H.netBias) * 2), dual: true },
  ].map(x => `<div class="hst"><div class="k">${x.k}</div>
    <div class="v" style="color:${x.c}">${x.v}</div>
    <div class="s">${x.s}</div>
    <div class="hbar"><i style="${x.dual ? `left:50%;width:${(x.w / 2).toFixed(1)}%;margin-left:${x.netBias < 0 ? -x.w / 2 : 0}%` : `left:0;width:${x.w.toFixed(1)}%`};background:${x.c}"></i></div>
  </div>`).join('');

  /* 区间数字清单：图上的虚线框只放得下区间和强度，宽 / 距现价 / 档位这些读数放这里，
   * 免得为了看全数字把框内文字挤成一团。 */
  const zBox = $('#heatZones');
  if (zBox) {
    let za = 0;
    const kd = (S.klines[S.sym] || {})[S.tf];
    if (kd && kd.bars && kd.bars.length) { const A = atr(kd.bars); za = A[A.length - 1] || 0; }
    if (!(za > 0)) za = H.px * 0.004;
    const ZS = heatZonesOf(H, H.px, za);
    zBox.innerHTML = ZS.length
      ? ZS.map((z, k) => {
        const up = z.side === 'up';
        return `<div class="hz" title="${up ? '上方空单止损带：突破后空头被迫回补，容易加速上行' : '下方多单止损带：跌破后多头被迫平仓，容易加速下行'}">
          <span class="sd ${up ? 'up' : 'dn'}">${up ? '上方空单' : '下方多单'} #${k + 1}</span>
          <span class="rg">${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}</span>
          <span class="mt">强度 ${Math.round(z.v * 100)}% · 宽 ${fmt(z.atrW, 2)} ATR · ${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%</span>
          <span class="wg">跨 ${z.i1 - z.i0 + 1} 档</span>
        </div>`;
      }).join('')
      : '';
  }

  const ls = H.lsInfo;
  const levTxt = (H.levs && H.levs.length === 3) ? `${H.levs[0]}/${H.levs[1]}/${H.levs[2]} 倍` : '10/25/50 倍';
  const bits = [];
  if (H.grade === 'real') {
    bits.push('数据来源：<b>历史爆仓记录 · CoinGlass</b> —— 真实发生的清算记录（需自备 Key + 代理），非模型推算。');
  } else {
    bits.push(`数据来源：<b>${HEAT_MODEL.nameFull}</b> —— `
      + (H.grade === 'semi'
        ? `由 Binance 合约真实 K 线成交量，按 ${levTxt} 杠杆假设反推的<b>潜在</b>清算密集区`
        : '仅由当前品种真实 K 线成交量按杠杆假设反推')
      + '。<b>它不是交易所真实未平仓合约的强平价分布</b>。');
  }
  if (ls && ls.ls) bits.push(`币安全网多空持仓人数比 ${ls.ls.toFixed(2)}（已向 50% 收缩后校准，避免长期看空）—— 注意这是<b>账户数</b>比例，不是持仓金额比例。`);
  if (S.heatErr) bits.push(`CoinGlass 未生效：${S.heatErr}`);
  if (!binSym(SYMS[S.sym])) bits.push('该品种无币安永续合约映射，无法获取合约多空数据，已按永续 K 线成交量估算。');
  $('#heatNote').innerHTML = bits.join(' ') +
    ' 热力图纵轴为价格、横轴为时间：<b>圆点越大表示该价区筹码越密集</b>（面积正比于密度），绿色＝多头筹码（下方为多单强平风险区），红色＝空头筹码（上方为空单强平风险区）；'
    + '虚线框为识别出的清算区间，框内标注<b>价格区间与强度百分比</b>，鼠标悬停可读出每一档的多空金额。' +
    `<br><b>四格方向的算法</b>：比较本图现价上方「空单清算池」与下方「多单清算池」的距离加权引力（±52）、最近且够厚的清算墙（±22）、趋势确认（±18）、资金费率拥挤（±12）；` +
    '每个周期按自身跨度单独成图，短周期看近处高杠杆清算，长周期看更远结构。' +
    (H.grade === 'real' ? '' : '<b>推算模型基于成交量与杠杆假设，与交易所实际清算存在偏差</b>，详见下方「模型假设与偏差」。') +
    ' 不构成投资建议。';
  renderHeatModel(H);
}

/* 模型假设面板：把推算链路和每一条假设摊开写清楚。
 * 这张图最容易被误读成「市场真实的爆仓位置」，所以偏差说明必须和图形同屏可见，
 * 而不是藏在文档里。 */
function renderHeatModel(H) {
  const box = $('#heatModel');
  if (!box) return;
  const M = H && H.model;
  if (!M) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  const chain = M.chain.join(' → ');
  box.innerHTML = `<details class="sub hmodel">
      <summary>模型假设与偏差 · ${M.name}${M.calibrated ? '（已用多空比校准）' : '（未校准）'}</summary>
      <div class="hm-chain">推算链路：<b>${chain}</b></div>
      <div class="hm-cv">${M.caveats.map(c =>
        `<div class="hm-row"><b>${c.t}</b><span>${c.d}</span></div>`).join('')}</div>
      ${M.levs && M.levs.length === 3
        ? `<div class="hm-lev">本图使用的杠杆档：<b>${M.levs[0]}× / ${M.levs[1]}× / ${M.levs[2]}×</b>（按图表跨度自适应，非交易者真实杠杆）</div>`
        : ''}
      <div class="hm-vd">${M.verdict}</div>
    </details>`;
}

function renderHeatTabs() {
  $('#heatTabs').querySelectorAll('[data-hs]').forEach(b =>
    b.classList.toggle('on', b.dataset.hs === HEAT_MODE));
}

async function refreshHeat(symId, tfKey) {
  S.heatErr = '';
  const hm = await loadHeat(symId, tfKey);
  if (S.sym !== symId) return;
  S.heat = hm;
  renderHeatMeta(); drawHeat();
}

