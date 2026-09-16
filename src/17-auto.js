/* ============================ 自动交易（模拟盘） ============================
 * 规则（用户设定，写死在默认值里，参数面板可调）：
 *   1. 方向 = 做市商趋势逻辑（mmTrade 的 bias），每单间隔 30 分钟，按自然时间网格推进
 *   2. 市价成交，每单保证金 1000 USDT，杠杆 10×（名义 10000）
 *   3. 止盈止损自动设置、到价即执行，不做任何二次确认
 *   4. 单据永不清除，按天列表，每单标注下单信号
 *   5. 24 小时按自然时间运作；浏览器关闭期间错过的档位不再补开新单，仅记为 skip
 *   6. 仅 ETH 参与，其余品种不动
 *   7. 盈亏比固定 1 : 1.5（TP1 / SL）
 * 新增约束（P0 修复）：
 *   · 数据过期 / K 线 stale / 网络取数失败时禁止产生新订单
 *   · 不再按当前行情补记历史交易（catchup 只生成 skip 记录）
 *   · 页面策略与执行条件对齐：sweep（扫单后反转）模式真实等待扫单收回，
 *     价格进入扫单带才触发反向开仓，未触发则该档 skip
 * 底线：不接任何交易所 API，不产生真实成交；拿不到真实价或真实 K 线时不下单（不编造价格）。
 */

/* ===== AUTO-PURE-START =====
 * 纯计算段：不碰 DOM、不碰网络，单测直接吃这一段。 */
const AUTO_FEE = 0.0005;        // 单边 taker 费率 0.05%，开平各一次
const AUTO_IV_DEF = 30;         // 默认间隔（分钟）
const AUTO_CATCH_CAP = 48;      // 补单上限：断线一天最多补 48 单，重开页面不会刷出上百条
const AUTO_SLIP_BPS = 1;        // 除买卖价差外的额外冲击成本（1 bp）
const AUTO_FUND_MS = 8 * 3600 * 1000;   // 资金费每 8 小时结算一次（UTC 0 / 8 / 16 点）
const AUTO_MMR = 0.005;         // 维持保证金率 0.5%（逐仓）：权益跌到名义的 0.5% 即被强平

function autoR2(p) { return Math.round(p * 100) / 100; }

/* ---- 强平价：杠杆越高，强平线离入场价越近，可能比止损还近 ----
 * 之前完全没有强平这一层，于是高杠杆下「止损还没到、仓位早该被打掉」的单子
 * 会被记成一笔正常止损，亏损额也只算到止损位 —— 实际上那时本金已经没了。
 * 逐仓强平：亏损把保证金吃到只剩维持保证金时触发，
 *   多：liq = entry × (1 − 1/杠杆 + 维持率)　空：liq = entry × (1 + 1/杠杆 − 维持率)
 * 10 倍时强平在 −9.5%，止损通常只有 −1%，止损先触发；125 倍时强平在 −0.3%，比止损更近，
 * 这时先被强平。出场判定统一走 autoExitHit()：谁离入场价更近谁先触发。 */
function autoLiqPx(o) {
  if (!(o && o.entry > 0) || !(o.lev > 0)) return 0;
  const k = 1 / o.lev - AUTO_MMR;
  if (!(k > 0)) return 0;                       // 杠杆高到维持率都兜不住：开仓即强平，不模拟这种
  return o.side === 'long' ? o.entry * (1 - k) : o.entry * (1 + k);
}

/* 出场命中判定（含强平）。止损与强平谁离入场价更近，谁就是实际先被觸到的那条线；
 * 同一段区间里止损与止盈都够得着时，按亏损口径先算 —— 宁可少赚也不能把
 * 「先扫损再反弹」记成止盈。返回 { hit: 'liq'|'sl'|'tp', lvl, stop }。 */
function autoExitHit(o, lo, hi) {
  if (!(lo > 0) || !(hi > 0) || o.status !== 'open') return null;
  if (!isFinite(o.sl) || !isFinite(o.tp1)) return null;
  const liq = autoLiqPx(o);
  if (o.side === 'long') {
    const byLiq = liq > 0 && liq > o.sl;         // 强平线在止损上方 = 离入场价更近
    const stop = byLiq ? liq : o.sl;
    if (lo <= stop) return { hit: byLiq ? 'liq' : 'sl', lvl: stop, stop };
    if (hi >= o.tp1) return { hit: 'tp', lvl: o.tp1, stop };
    return null;
  }
  if (o.side === 'short') {
    const byLiq = liq > 0 && liq < o.sl;
    const stop = byLiq ? liq : o.sl;
    if (hi >= stop) return { hit: byLiq ? 'liq' : 'sl', lvl: stop, stop };
    if (lo <= o.tp1) return { hit: 'tp', lvl: o.tp1, stop };
    return null;
  }
  return null;
}

/* ---- 滑点：不再「按预设止损 / 止盈价原价成交」 ----
 * 真实成交不可能正好落在挂单价上：买单吃卖一、卖单吃买一，中间隔着整个买卖价差，
 * 单子还要额外推动盘口。这里用「当前报价买卖价差的一半 + 1bp 冲击成本」作滑点，
 * 取不到价差时按 0.02% 兜底 —— 宁可账面难看一点，也不要给出一份「零成本完美成交」的记录。
 * 方向：做多开仓 / 做空平仓是买入，往上滑；做空开仓 / 做多平仓是卖出，往下滑。 */
function autoSlipFrac(spreadPct) {
  const sp = (spreadPct != null && isFinite(spreadPct)) ? Math.max(0, spreadPct) : 0.02;
  return sp / 100 / 2 + AUTO_SLIP_BPS / 10000;
}
function autoSlipPx(px, side, isEntry, spreadPct) {
  if (!(px > 0)) return px;
  const up = (side === 'long') === !!isEntry;
  const f = autoSlipFrac(spreadPct);
  return px * (1 + (up ? f : -f));
}

/* ---- 资金费：持仓跨过结算点就要付 / 收 ----
 * 之前完全没算，等于白拿了永续的多空失衡收益。按 8 小时一段计：
 * 费率为正时多头付给空头，为负时反向。取不到资金费率就记 0，不编造。 */
function autoFundCount(t0, t1) {
  if (!(t1 > t0)) return 0;
  return Math.floor(t1 / AUTO_FUND_MS) - Math.floor(t0 / AUTO_FUND_MS);
}
function autoFundFee(o, exitT, funding) {
  if (funding == null || !isFinite(funding)) return 0;
  const n = autoFundCount(o.t, exitT);
  if (n <= 0) return 0;
  return -funding * n * (o.notional || 0) * (o.side === 'long' ? 1 : -1);
}

/* ---- 用 K 线高低区间判定出场 ----
 * 报价轮询约 7 秒一次，期间「插针到止损又反弹」的行情会被完全漏掉，
 * 结果是模拟盘胜率被系统性高估。K 线的 high/low 记录了那根 bar 走过的全部区间，
 * 用它补判就不会漏。跳空（开盘已在触发价之外）按开盘价成交 —— 这正是真实执行的样子：
 * 跳空穿过止盈成交得更好，跳空穿过止损则更差。 */
function autoExitScan(o, bars, spreadPct) {
  if (!bars || !bars.length || o.status !== 'open') return null;
  const from = o.chkT || o.t;
  for (const b of bars) {
    if (!(b.t > from)) continue;
    const h = autoExitHit(o, b.l, b.h);
    if (!h) continue;
    // 跳空：开盘已在触发价之外。强平不按开盘价成交 —— 那是被交易所按强平价接管的，亏到只剩维持保证金为止。
    const gapped = h.hit === 'liq'
      ? false
      : (o.side === 'long' ? (h.hit === 'sl' ? b.o < h.lvl : b.o > h.lvl)
        : (h.hit === 'sl' ? b.o > h.lvl : b.o < h.lvl));
    const raw = (gapped && h.hit !== 'liq') ? b.o : h.lvl;
    return {
      hit: h.hit, gap: gapped, src: 'bar', exitT: b.t,
      exitPx: h.hit === 'liq' ? autoR2(raw)
        : autoR2(autoSlipPx(raw, o.side, false, spreadPct)),
    };
  }
  return null;
}

/* ---- 风控预算：单笔保证金由权益倒推，不再无脑每单固定 ----
 * 四条约束取最紧的一条：
 *   1) 单笔风险金额 ≤ 权益 × riskPerTradePct%
 *   2) 单笔保证金   ≤ 权益 × maxMarginPct%
 *   3) 在持风险 + 新单风险 ≤ 权益 × maxRiskTotalPct%
 *   4) 在持名义 + 新单名义 ≤ 权益 × maxLevNotional 倍
 * 返回 { ok, margin, notional, risk, why }。want 是用户设定的每单保证金，只作上界。 */
function autoBudget(px, sl, lev, cfg) {
  const c = cfg || {};
  const eq = c.equity || 0;
  const riskPctOfPx = px > 0 ? Math.abs(px - sl) / px : 0;
  if (!(eq > 0) || !(px > 0) || !(riskPctOfPx > 0) || !(lev > 0)) {
    return { ok: false, margin: 0, notional: 0, risk: 0, why: '参数无效' };
  }
  const capRisk = eq * (c.riskPerTradePct / 100);
  const capMargin = eq * (c.maxMarginPct / 100);
  const leftRisk = Math.max(0, eq * (c.maxRiskTotalPct / 100) - (c.usedRisk || 0));
  const leftNotional = Math.max(0, eq * (c.maxLevNotional || 0) - (c.usedNotional || 0));

  // 名义 = 风险金额 / 风险比例；保证金 = 名义 / 杠杆
  const byRisk = (capRisk / riskPctOfPx) / lev;
  const byLeftRisk = (leftRisk / riskPctOfPx) / lev;
  const byLeftNotional = leftNotional / lev;
  const margin = Math.min(c.want || Infinity, byRisk, capMargin, byLeftRisk, byLeftNotional);
  if (!isFinite(margin) || margin < 10) {
    const why = (byLeftRisk <= byRisk && byLeftRisk <= byLeftNotional)
      ? `总风险额度不足（已用 ${Math.round(c.usedRisk || 0)} / 上限 ${Math.round(eq * c.maxRiskTotalPct / 100)}）`
      : (byLeftNotional <= byRisk)
        ? `总名义敞口已达上限（权益 × ${c.maxLevNotional}）`
        : `单笔风险上限 ${c.riskPerTradePct}% 下保证金不足 10 USDT`;
    return { ok: false, margin: 0, notional: 0, risk: 0, why };
  }
  const notional = margin * lev;
  return { ok: true, margin, notional, risk: notional * riskPctOfPx, why: '' };
}

/* 单笔风险金额：|入场 − 止损| / 入场 × 名义。保证金制下这才是真正会亏掉的钱。 */
function autoRiskAmt(o) {
  if (!(o.entry > 0) || o.sl == null) return 0;
  return Math.abs(o.entry - o.sl) / o.entry * (o.notional || 0);
}

/* 价位：以做市商给出的「结构风险距离」定止损，再按盈亏比推止盈。
 * 为什么不直接用 mmTrade 的 tp1：它取的是清算带近端，盈亏比可能是 0.6 也可能是 4；
 * 固定 1:1.5 的做法是保留结构给出的风险距离（不是拍脑袋的倍数），再按 RR 反推止盈。 */
function autoLevels(px, bias, riskDist, rr) {
  if (!(px > 0) || !(riskDist > 0) || !(rr > 0)) return null;
  if (bias !== 'long' && bias !== 'short') return null;
  const d = clamp(riskDist, px * 0.0015, px * 0.05);   // 夹进 0.15%~5%，极端结构不产生荒谬价位
  return bias === 'long'
    ? { sl: autoR2(px - d), tp1: autoR2(px + d * rr) }
    : { sl: autoR2(px + d), tp1: autoR2(px - d * rr) };
}

/* 命中判定。同一个 tick 里价格同时越过两边时按止损优先 —— 保守口径，
 * 宁可少赚也不能把「扫损后反弹」算成止盈。 */
function autoHit(side, sl, tp1, lo, hi) {
  if (!(sl > 0) || !(tp1 > 0)) return null;
  if (side === 'long') {
    if (lo <= sl) return 'sl';
    if (hi >= tp1) return 'tp';
    return null;
  }
  if (side === 'short') {
    if (hi >= sl) return 'sl';
    if (lo <= tp1) return 'tp';
    return null;
  }
  return null;
}

/* 盈亏：名义 = 保证金 × 杠杆；毛盈亏按价格变动 × 张数；
 * 成本 = 双边手续费 + 持仓跨越的资金费。三者分开记，账单才看得懂钱花在哪。 */
function autoPnl(o, exitPx, exitT, funding) {
  const qty = o.notional / o.entry;
  const dir = o.side === 'long' ? 1 : -1;
  const gross = (exitPx - o.entry) * qty * dir;
  const fee = o.notional * AUTO_FEE * 2;
  const fund = autoFundFee(o, exitT == null ? (o.exitT || o.t) : exitT, funding);
  const pnl = gross - fee + fund;
  return { gross, fee, fund, pnl, pnlPct: o.margin > 0 ? pnl / o.margin * 100 : 0 };
}

/* 自然时间网格：档位 = nextAt + k×间隔。不用「执行时刻 + 间隔」，
 * 否则每次执行都漂移几秒，一天下来整个网格会往后挪。 */
function autoCatchCount(nextAt, t, ivMs, cap) {
  if (!(ivMs > 0) || !(t >= nextAt)) return 0;
  return Math.min(cap == null ? AUTO_CATCH_CAP : cap, Math.floor((t - nextAt) / ivMs) + 1);
}
/* ===== AUTO-PURE-END ===== */

const AUTO_KEY = 'mb_auto_v1';
const AUTO_DEF = {
  on: false,
  sym: 'ETH',            // 规则 6：只有 ETH 参与
  tf: '1h',
  margin: 1000,          // 规则 2
  lev: 10,               // 规则 2
  ivMin: AUTO_IV_DEF,    // 规则 1
  rr: 1.5,               // 规则 7
  nextAt: 0,
  orders: [],            // 规则 4：只增不删
  startedAt: 0,
  pendingSweep: null,    // P0-4：正在等待的扫单收回状态
  maxOpen: 5,            // 最大同时持仓笔数（笔数上限）
  /* ---- 账户与风控（P2：之前只有「每单固定 1000」，没有账户约束）----
   * 之前定时追加订单、不看账户余额，可以累积出远超实际资金承受能力的仓位。
   * 这里补上权益口径：权益 = 初始资金 + 累计已实现盈亏，所有仓位都由它倒推。 */
  balance: 10000,        // 初始资金（USDT）
  riskPerTradePct: 2,    // 单笔最大亏损 ≤ 权益 2%
  maxRiskTotalPct: 6,    // 在持风险合计 ≤ 权益 6%
  maxLevNotional: 20,    // 总名义敞口 ≤ 权益 20 倍
  maxMarginPct: 40,      // 单笔保证金 ≤ 权益 40%
};

function autoLoad() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null'); } catch (e) { o = null; }
  const a = Object.assign({}, AUTO_DEF, o || {});
  a.sym = 'ETH';                                  // 即便旧存档里是别的品种，也强制回到 ETH
  if (!Array.isArray(a.orders)) a.orders = [];
  a.margin = clamp(+a.margin || 1000, 10, 1e6);
  a.lev = clamp(+a.lev || 10, 1, 125);
  a.ivMin = clamp(+a.ivMin || AUTO_IV_DEF, 1, 720);
  a.rr = clamp(+a.rr || 1.5, 1, 10);
  if (!TF_MAP[a.tf]) a.tf = '1h';
  a.maxOpen = clamp(+a.maxOpen || 5, 1, 50);
  a.balance = clamp(+a.balance || 10000, 100, 1e9);
  a.riskPerTradePct = clamp(+a.riskPerTradePct || 2, 0.1, 20);
  a.maxRiskTotalPct = clamp(+a.maxRiskTotalPct || 6, 0.5, 50);
  a.maxLevNotional = clamp(+a.maxLevNotional || 20, 1, 200);
  a.maxMarginPct = clamp(+a.maxMarginPct || 40, 5, 100);
  // 扫单状态持久化：页面刷新后仍继续等待
  if (a.pendingSweep && !(a.pendingSweep.deadline > 0)) a.pendingSweep = null;
  return a;
}
let AUTO = autoLoad();
if (typeof window !== 'undefined') window.AUTO = AUTO;   // 便于端到端测试访问状态
function autoSave() {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify(AUTO)); } catch (e) { /* 配额满：不阻断交易 */ }
}
const autoIvMs = () => Math.max(1, AUTO.ivMin) * 60000;

/* ---- 账户权益 ----
 * 权益 = 初始资金 + 累计已实现盈亏。在持仓位的浮动盈亏不计入（未落袋），
 * 但已占用的风险与名义敞口要计 —— 那是实实在在被锁住的额度。 */
function autoRealized() {
  return AUTO.orders.reduce((s, o) =>
    s + ((o.status === 'win' || o.status === 'loss') ? (o.pnl || 0) : 0), 0);
}
function autoEquity() { return Math.max(0, (AUTO.balance || 0) + autoRealized()); }
function autoOpenOrders() { return AUTO.orders.filter(o => o.status === 'open'); }
function autoUsedRisk() { return autoOpenOrders().reduce((s, o) => s + autoRiskAmt(o), 0); }
function autoUsedNotional() { return autoOpenOrders().reduce((s, o) => s + (o.notional || 0), 0); }
function autoUsedMargin() { return autoOpenOrders().reduce((s, o) => s + (o.margin || 0), 0); }
/* 当前报价的买卖价差（百分数）。滑点由它推导，取不到时用兜底值。 */
function autoSpreadPct() {
  const q = S.quotes[AUTO.sym];
  return (q && isFinite(q.spreadPct)) ? Math.max(0, q.spreadPct) : null;
}
function autoFundingRate() {
  const q = S.quotes[AUTO.sym];
  return (q && isFinite(q.funding)) ? q.funding : null;
}
function dayKey(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 真实价：取 ETH 永续源报价的中位数。拿不到就返回 null —— 与页面其余部分同一条底线，
 * 没有真实价就绝不下单。 */
function autoPx() {
  const q = S.quotes[AUTO.sym];
  if (q && q.median > 0) return q.median;
  const rows = ((q && q.rows) || []).filter(r => r.real && r.perp && r.price > 0);
  if (!rows.length) return null;
  const v = rows.map(r => r.price).sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
function autoBars() {
  const d = (S.klines[AUTO.sym] || {})[AUTO.tf];
  return (d && d.bars && d.bars.length >= 40) ? d.bars : null;
}

/* 四周期数据是否齐备且新鲜。融合决策要读 4h/1h/30m/15m 四份 K 线，
 * 缺任何一份都不该开仓 —— 否则又变成「只看一个周期就下单」。
 * 除了 stale 标志，还要看最后一根 bar 的时间戳：缓存里留着旧数据也是「数据停止更新」的一种。 */
function autoMtfReady() {
  const miss = [];
  for (const tf of MTF_TFS) {
    const d = (S.klines[AUTO.sym] || {})[tf];
    const lab = MTF_LABEL[tf] || tf;
    if (!d || !d.bars || d.bars.length < MTF_MIN_BARS) { miss.push(lab + ' 不足'); continue; }
    if (d.stale) { miss.push(lab + ' 停更'); continue; }
    const step = (TF_MAP[tf] ? TF_MAP[tf].m : 60) * 60000;
    const last = d.bars[d.bars.length - 1];
    if (now() - last.t > step * 2.5 + 60000) miss.push(lab + ' 过期');
    else if (!klineGaps(d.bars, step).ok) miss.push(lab + ' 断档');
  }
  return { ok: miss.length === 0, miss };
}

/* P0-2：数据过期时禁止开仓。
 * 检查报价时间戳、K 线 stale 标志、K 线时间空洞、最后一根 bar 的时间戳、
 * 网络最近一次成功取数时间。返回 { ok, why }，供开仓逻辑决策。 */
function autoCanTrade() {
  const q = S.quotes[AUTO.sym];
  if (!q || !(q.price > 0)) return { ok: false, why: '无实时价' };
  const qAge = now() - (q.ts || 0);
  if (qAge > 30000) return { ok: false, why: `报价已过期 ${Math.round(qAge / 1000)}s` };
  const d = (S.klines[AUTO.sym] || {})[AUTO.tf];
  if (!d || !d.bars || d.bars.length < 40) return { ok: false, why: 'K 线不足' };
  if (d.stale) return { ok: false, why: 'K 线已停止更新' };
  const tf = TF_MAP[AUTO.tf];
  const gap = klineGaps(d.bars, (tf ? tf.m : 60) * 60000);
  if (!gap.ok) return { ok: false, why: `K 线不连续，缺失 ${gap.gaps.length} 段` };
  const last = d.bars[d.bars.length - 1];
  const barAge = now() - last.t;
  const step = (tf ? tf.m : 60) * 60000;
  if (barAge > step * 2.5 + 60000) {
    return { ok: false, why: `最后一根 K 线已过去 ${Math.round(barAge / 60000)} 分钟` };
  }
  const netAge = now() - NET.lastOk;
  if (netAge > 90000) return { ok: false, why: '网络取数失败超过 90s' };
  const mt = autoMtfReady();
  if (!mt.ok) return { ok: false, why: '四周期数据不齐：' + mt.miss.join(' / ') };
  return { ok: true };
}

/* ---- 模拟盘的假设与偏差 ----
 * 和清算热力图同一个道理：模拟结果好不好，取决于它说清楚了自己没算什么。
 * 这里把「已计入」和「仍未计入」分开列，避免把一份理想化成交记录当成实盘战绩。 */
const AUTO_ASSUME = {
  name: '模拟成交模型',
  counted: [
    ['双边手续费', '开平各一次，taker 0.05%'],
    ['成交滑点', '买卖价差的一半 + 1bp 冲击成本；跳空按开盘价成交'],
    ['资金费', '持仓每跨过一次 8 小时结算点计一次，取当前费率；取不到就记 0，不编造'],
    ['出场判定', '轮询价 + K 线 high/low 双路径，7 秒轮询间隙里的插针不会漏'],
    ['仓位约束', '单笔风险 / 总风险 / 名义敞口 / 单笔保证金四条取最紧，由账户权益倒推'],
    ['强平线', '逐仓维持保证金率 0.5%，谁离入场价更近谁先触发（高杠杆可能先于止损被强平）'],
  ],
  missing: [
    ['盘口深度', '不做分笔成交，也不按挂单量额外加冲击成本'],
    ['资金费时变', '按平仓时的费率计全程，持仓期间费率变化未跟踪'],
    ['执行环境', '不模拟下单延迟、交易所宕机、断线期间的行情'],
    ['止盈成交', '按 taker 滑点算，实际挂单成交可能是 maker（结果偏保守）'],
    ['错过档位', '页面未运行时错过的档位只记「错过档位」，不按当前行情补开'],
    ['保证金占用', '逐仓、不交叉，也未模拟真实资金与借贷成本'],
  ],
  verdict: '模拟盘用于检验策略逻辑是否自洽，不等于实盘收益：它给的是「在这套假设下会怎样」，不是「真这么干能赚多少」。',
};
function renderAutoModel() {
  const box = $('#autoModel');
  if (!box) return;
  const row = (k, v) => `<div class="hm-row"><b>${k}</b><span>${v}</span></div>`;
  box.innerHTML = `<details class="sub hmodel">
      <summary>模拟盘假设与偏差 · ${AUTO_ASSUME.name}</summary>
      <div class="hm-chain">已计入的成本与规则：</div>
      <div class="hm-cv">${AUTO_ASSUME.counted.map(c => row(c[0], c[1])).join('')}</div>
      <div class="hm-chain" style="margin-top:8px">仍未计入、会系统性偏差的地方：</div>
      <div class="hm-cv">${AUTO_ASSUME.missing.map(c => row(c[0], c[1])).join('')}</div>
      <div class="hm-vd">${AUTO_ASSUME.verdict}</div>
    </details>`;
}

/* 多周期方向不再由「投票 + 主周期兜底」给出 —— 那套口径会让 15m 做多 / 4h 做空时
 * 以主周期（默认 1h）的结论开仓，等于小周期能推翻大周期。
 * 现在唯一入口是 mtfDecision()：4h 定趋势 → 1h 筛选 → 30m 看回调 → 15m 触发，
 * 见 08a-mtf.js。这里不再保留任何并行口径，避免以后又被接回开仓路径。 */
// 端到端测试访问（app.js 在严格模式下求值，内部函数不会挂到 window）
if (typeof window !== 'undefined') {
  window.autoCanTrade = autoCanTrade;
  window.autoOpenOnce = autoOpenOnce;
}

/* P0-3：把一档记为 skip，原因写清楚。 */
function autoPushSkip(atT, catchup, px0, reason) {
  AUTO.orders.push({
    id: 'A' + (AUTO.orders.length + 1) + '-' + String(atT).slice(-6),
    t: atT, day: dayKey(atT), sym: AUTO.sym, tf: AUTO.tf,
    margin: AUTO.margin, lev: AUTO.lev, notional: AUTO.margin * AUTO.lev,
    catchup: !!catchup, px0: px0 || 0,
    side: 'wait', status: 'skip', sig: { text: '—', conf: 0, score: 0 },
    reason,
  });
}

let _autoQT = 0;
const _autoKT = {};                                  // 各周期上次拉 K 线的时刻
const AUTO_K_IV = { '15m': 240000, '30m': 240000, '1h': 600000, '4h': 1800000 };
async function autoEnsureData(force) {
  if (!AUTO.on) return;
  const t = now();
  const needQ = force || t - _autoQT > 7000;         // 报价 7 秒一次
  if (needQ) _autoQT = t;
  const jobs = [];
  if (needQ) jobs.push(loadQuotes(AUTO.sym).catch(() => {}));
  /* 四周期融合要读 15m/30m/1h/4h 四份 K 线，只拉一个周期就永远做不出总决策。
   * 短周期 4 分钟一刷、1h 十分钟、4h 半小时 —— 4h 一根要走四小时，半小时足够。 */
  for (const tf of MTF_TFS) {
    const iv = AUTO_K_IV[tf] || 240000;
    if (force || t - (_autoKT[tf] || 0) > iv) {
      _autoKT[tf] = t;
      jobs.push(loadKlines(AUTO.sym, tf).catch(() => {}));
    }
  }
  /* 只有 force（启动 / 补单 / 页面重新可见）才等结果：平时 tick 每秒一次，
   * 等待会把每次 tick 拖成串行请求，界面刷新和持仓检查都被卡住。 */
  if (force) await Promise.all(jobs);
}

/* 信号标注：把「四周期融合决策 + 执行周期结论」压成一句话，写进每一笔单据。
 * 之前只标执行周期的结论，于是单据上写着「顺势 · 结构上升」，实际却是被 4h 趋势否决的单，
 * 事后完全没法复盘。现在把流水线状态也写进去。 */
function autoSigOf(T, dec) {
  const F = T && T.mm && T.mm.F, kd = F && F.kd, mc = F && F.mc, st = F && F.st;
  if (!F) return { text: (dec ? mtfStageTxt(dec) : '—'), conf: dec ? dec.conf : 0, score: 0 };
  const kdTxt = !kd ? '—'
    : kd.cross === 1 ? 'KDJ 刚金叉' : kd.cross === -1 ? 'KDJ 刚死叉'
    : (kd.k > kd.d ? 'KDJ K 在 D 上' : 'KDJ K 在 D 下');
  const mcTxt = !mc ? '—'
    : mc.cross === 1 ? 'MACD 金叉' : mc.cross === -1 ? 'MACD 死叉'
    : (mc.dif > mc.dea ? 'MACD 多头排列' : 'MACD 空头排列');
  const trendTxt = st ? (st.trend === 'up' ? '结构上升' : st.trend === 'down' ? '结构下降'
    : st.trend === 'expand' ? '高低点扩张' : st.trend === 'contract' ? '高低点收敛' : '区间震荡') : '—';
  const modeTxt = T.mode === 'follow' ? '顺势' : T.mode === 'sweep' ? '扫单反转' : '观望';
  return {
    text: `${dec ? mtfStageTxt(dec) + ' · ' : ''}${modeTxt} · ${trendTxt} · ${kdTxt} · ${mcTxt}`,
    conf: dec ? dec.conf : (T.conf || 0), score: Math.round(T.score || 0),
    stage: dec ? dec.stage : null,
  };
}

/* 用风控预算 + 滑点成交开一单。所有开仓路径（定时档 / 扫单触发）都必须走这里，
 * 否则「定时档有风控、扫单触发没有」这种漏口径迟早会出事。 */
function autoPlace(atT, bias, plan, dec, reason) {
  const px = autoPx();
  if (!(px > 0)) return null;
  // 先算含滑点的成交价，再以它为基准挂止损止盈 —— 实盘就是以实际成交价为基准设止损的，
  // 这样盈亏比也才是真的 1:1.5（用未滑点的报价算，RR 会被滑点吃掉几个百分点）。
  const fill = autoSlipPx(px, bias, true, autoSpreadPct());
  const dist = (plan && plan.sl != null) ? Math.abs(plan.px - plan.sl) : 0;
  const L = autoLevels(fill, bias, dist || (plan && plan.atr) || px * 0.01, AUTO.rr);
  if (!L) return null;
  const B = autoBudget(px, L.sl, AUTO.lev, {
    equity: autoEquity(), riskPerTradePct: AUTO.riskPerTradePct,
    maxMarginPct: AUTO.maxMarginPct, maxRiskTotalPct: AUTO.maxRiskTotalPct,
    maxLevNotional: AUTO.maxLevNotional,
    usedRisk: autoUsedRisk(), usedNotional: autoUsedNotional(), want: AUTO.margin,
  });
  if (!B.ok) return { err: B.why };
  // 市价单按买卖价差滑点成交，不再是「报价即成交价」
  const entry = autoR2(fill);
  return {
    order: {
      id: 'A' + (AUTO.orders.length + 1) + '-' + String(atT).slice(-6),
      t: atT, day: dayKey(atT), sym: AUTO.sym, tf: AUTO.tf,
      margin: Math.round(B.margin * 100) / 100, lev: AUTO.lev,
      notional: Math.round(B.notional * 100) / 100,
      catchup: false, px0: px, side: bias, status: 'open',
      entry, sl: L.sl, tp1: L.tp1,
      tp2: (plan && plan.tp2 != null) ? autoR2(plan.tp2) : null,
      risk: autoR2(Math.abs(L.sl - entry)), sig: autoSigOf(plan, dec),
      chkT: atT,                                   // K 线区间扫描的起点
      slip: autoR2(entry - px),                    // 开仓滑点（正＝买贵 / 卖便宜）
      liqP: autoR2(autoLiqPx({ entry, side: bias, lev: AUTO.lev })),   // 强平价：杠杆越高离入场越近
      reason,
    },
    budget: B, entry, px,
  };
}

/* 下一单：到点执行。
 * P0-2：数据过期禁止开仓。
 * P0-3：catchup（页面没开时错过的档位）不再按当前行情补开新单，只记 skip。
 * P0-4：页面策略与执行对齐 —— 需要扫单收回时真实等待价格进带。
 * P2：方向只来自四周期融合决策；仓位由账户权益与总风险约束倒推。 */
function autoOpenOnce(atT, catchup) {
  const iv = autoIvMs();
  const can = autoCanTrade();
  const px = autoPx();

  // 数据过期：不产生新订单，但该档必须推进（避免永远卡住）
  if (!can.ok) {
    autoPushSkip(atT, catchup, px || 0, '数据过期禁止开仓：' + can.why);
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }
  if (!(px > 0)) return false;                     // 数据不全：不推进网格，下个 tick 重试

  // P0-3：取消按当前行情补记历史交易
  if (catchup) {
    autoPushSkip(atT, true, px, '错过档位，按规则不补开新单（历史回放另行实现）');
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }

  // 笔数上限
  const openCount = autoOpenOrders().length;
  if (openCount >= AUTO.maxOpen) {
    autoPushSkip(atT, false, px, `持仓笔数上限：当前 ${openCount} 笔 ≥ ${AUTO.maxOpen} 笔`);
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }

  /* 唯一的方向来源：四周期融合决策（4h 趋势 → 1h 机会 → 30m 回调 → 15m 触发）。
   * 不再读「设置里的单个周期」—— 那是「15m 做多、4h 做空照样开多」的根源。 */
  const dec = mtfDecision(AUTO.sym);
  if (dec.bias !== 'long' && dec.bias !== 'short') {
    autoPushSkip(atT, false, px,
      `四周期融合决策观望（${mtfStageTxt(dec)}）：${dec.reasons[dec.reasons.length - 1] || '四层未达成一致'}`);
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }

  const mtf = mtfPlan(AUTO.sym, AUTO.tf);
  const plan = mtf.plan;
  if (!plan) {
    autoPushSkip(atT, false, px, `执行周期 ${MTF_LABEL[AUTO.tf] || AUTO.tf} 数据不足，无法定价`);
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }

  // P0-4：15m 处于扫单结构 —— 真实等价格进带再反向开仓
  if (dec.need === 'sweep' && dec.sweep) {
    const lo = Math.min(dec.sweep.lo, dec.sweep.hi), hi = Math.max(dec.sweep.lo, dec.sweep.hi);
    AUTO.pendingSweep = {
      atT, px0: px, bias: dec.bias, sweepLo: lo, sweepHi: hi,
      deadline: atT + iv, sig: autoSigOf(plan, dec),
      T: { px: plan.px, sl: plan.sl, tp2: plan.tp2, atr: plan.atr, dp: plan.dp, mode: 'sweep' },
    };
    autoPushSkip(atT, false, px,
      `等待扫单收回：${fmt(lo, plan.dp)} – ${fmt(hi, plan.dp)}（${dec.bias === 'long' ? '跌进带后做多' : '涨进带后做空'}）`
      + ` · 15m 扫单倾向${sweepTendency(dec.sweep.score).txt}`);
    AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
  }

  const r = autoPlace(atT, dec.bias, plan, dec,
    `市价开仓 · 四层全通过（${mtfStageTxt(dec)}）· 自动挂止盈止损`);
  if (r && r.order) {
    AUTO.orders.push(r.order);
  } else {
    autoPushSkip(atT, false, px, '风控拒绝开仓：' + ((r && r.err) || '价位计算失败'));
  }
  AUTO.nextAt += iv; autoSave(); renderAuto(); return true;
}

/* 持仓检查（轮询价路径）：到价即平，不做任何确认。
 * 成交价 = 触发价 ± 滑点；跳空由 K 线区间路径 autoCheckBars 负责。 */
function autoCheckOpen(px) {
  if (!(px > 0)) return false;
  const spread = autoSpreadPct(), fund = autoFundingRate();
  let changed = false;
  for (const o of AUTO.orders) {
    if (o.status !== 'open') continue;
    const h = autoExitHit(o, px, px);              // 与 K 线路径同一判定：含强平线
    if (!h) continue;
    const exitPx = h.hit === 'liq' ? autoR2(h.lvl)
      : autoR2(autoSlipPx(h.lvl, o.side, false, spread));
    autoClose(o, { hit: h.hit, exitPx, exitT: now(), gap: false, src: 'quote' }, fund);
    changed = true;
  }
  if (changed) { autoSave(); renderAuto(); }
  return changed;
}

/* 平仓：两条出场路径（轮询价 / K 线区间）共用，保证口径一致 —— 手续费、资金费、
 * 滑点、状态标记只在这里算一次，不会出现「同一笔单两种算法」。 */
function autoClose(o, r, funding) {
  const p = autoPnl(o, r.exitPx, r.exitT, funding);
  o.status = r.hit === 'tp' ? 'win' : 'loss';
  o.exitT = r.exitT; o.exitPx = r.exitPx;
  o.gross = p.gross; o.fee = p.fee; o.fund = p.fund;
  o.pnl = p.pnl; o.pnlPct = p.pnlPct;
  o.exitSrc = r.src || 'quote';
  o.exitGap = !!r.gap;
  o.liquidated = r.hit === 'liq';
  o.reason = r.hit === 'liq'
    ? '触发强平（保证金吃到维持线，按强平价接管）'
    : (r.hit === 'sl' ? '触发止损' : '触发止盈')
      + `（${r.gap ? '跳空按开盘价' : '按触发价'}成交${r.src === 'bar' ? ' · K 线区间判定' : ''}）`;
}

/* K 线区间出场：7 秒一次的轮询价会漏掉「插针到止损又反弹」，
 * 这里用已收盘（含正在形成）K 线的 high/low 补判，漏不掉。 */
function autoCheckBars() {
  const bars = autoBars();
  if (!bars || !bars.length) return false;
  const spread = autoSpreadPct(), fund = autoFundingRate();
  let changed = false;
  for (const o of AUTO.orders) {
    if (o.status !== 'open') continue;
    const r = autoExitScan(o, bars, spread);
    if (!r) continue;
    autoClose(o, r, fund);
    changed = true;
  }
  if (changed) { autoSave(); renderAuto(); }
  return changed;
}

/* P0-4：扫单触发 —— 价格进入等待中的扫单带时立即按 bias 反向开仓。
 * 同样走 autoPlace，享受同一套风控与滑点，不另开一条口径。 */
function autoSweepTrigger(px) {
  const p = AUTO.pendingSweep;
  if (!p || !(px > 0)) return false;
  if (px < p.sweepLo || px > p.sweepHi) return false;
  const plan = { px: p.T.px, sl: p.T.sl, tp2: p.T.tp2, atr: p.T.atr, dp: p.T.dp, mode: 'sweep', mm: null };
  const r = autoPlace(now(), p.bias, plan, null,
    `扫单收回触发 · 现价 ${fmt(px, p.T.dp)} 进入 ${fmt(p.sweepLo, p.T.dp)} – ${fmt(p.sweepHi, p.T.dp)}，反向${p.bias === 'long' ? '做多' : '做空'}`);
  if (r && r.order) { r.order.sig = p.sig; AUTO.orders.push(r.order); }
  else autoPushSkip(now(), false, px, '扫单触发但风控拒绝开仓：' + ((r && r.err) || '价位计算失败'));
  AUTO.pendingSweep = null;
  autoSave(); renderAuto();
  return true;
}

/* P0-4：扫单超时 —— 到下一档仍未触发，skip。 */
function autoSweepExpire() {
  const p = AUTO.pendingSweep;
  if (!p || now() < p.deadline) return false;
  autoPushSkip(p.atT, false, autoPx() || 0,
    `等待扫单收回超时：${fmt(p.sweepLo, p.T.dp)} – ${fmt(p.sweepHi, p.T.dp)} 在 ${Math.round((p.deadline - p.atT) / 60000)} 分钟内未触发`);
  AUTO.pendingSweep = null;
  autoSave(); renderAuto();
  return true;
}

/* 每秒 tick：刷新数据、检查持仓、检查扫单触发/超时、到点下单。 */
function autoTick() {
  if (!AUTO.on) return;
  autoEnsureData(false);
  const px = autoPx();
  // 两条出场路径并行：轮询价即时，K 线区间补上轮询问隙里被漏掉的插针
  if (px > 0) autoCheckOpen(px);
  autoCheckBars();

  // P0-4：扫单状态处理
  if (AUTO.pendingSweep) {
    autoSweepTrigger(px);
    autoSweepExpire();
  }

  if (AUTO.nextAt <= 0) AUTO.nextAt = now() + autoIvMs();
  let guard = 0;
  while (now() >= AUTO.nextAt && guard++ < 6) {     // 单 tick 最多补 6 单，避免一次性补几百单卡死
    if (!autoOpenOnce(AUTO.nextAt, now() > AUTO.nextAt + 45000)) break;
  }
  renderAutoLight();
}

/* 页面重开时按自然时间补齐错过的档位记录（上限 AUTO_CATCH_CAP）。
 * P0-3：不再按当前行情补开新单，错过的档位统一记为 skip。 */
async function autoCatchUp() {
  if (!AUTO.on) return;
  await autoEnsureData(true);                       // 仍尝试拿数据，确保到点后的第一档能正常执行
  const iv = autoIvMs();
  if (AUTO.nextAt <= 0) { AUTO.nextAt = now() + iv; autoSave(); return; }
  const n = autoCatchCount(AUTO.nextAt, now(), iv, AUTO_CATCH_CAP);
  for (let i = 0; i < n; i++) {
    if (!autoOpenOnce(AUTO.nextAt, true)) break;    // catchup=true → autoOpenOnce 生成 skip 记录
  }
  if (AUTO.nextAt < now()) AUTO.nextAt = now() + iv;   // 落后太多（超过补单上限）：网格拉回当前时刻
  autoSave(); renderAuto();
}

/* ---- 渲染 ---- */
function autoStatsOf(list) {
  const closed = list.filter(o => o.status === 'win' || o.status === 'loss');
  const win = closed.filter(o => o.status === 'win').length;
  const net = closed.reduce((s, o) => s + (o.pnl || 0), 0);
  return {
    total: list.length, open: list.filter(o => o.status === 'open').length,
    skip: list.filter(o => o.status === 'skip').length,
    win, loss: closed.length - win,
    liq: closed.filter(o => o.liquidated).length,
    rate: closed.length ? win / closed.length * 100 : null,
    net,
  };
}
function autoRowHtml(o) {
  const t = new Date(o.t).toLocaleString('zh-CN', { hour12: false });
  const sideTxt = o.side === 'long' ? '做多' : o.side === 'short' ? '做空' : '观望';
  const sideCls = o.side === 'long' ? 'up' : o.side === 'short' ? 'down' : '';
  const tag = o.status === 'open' ? '<span class="atag hold">持仓中</span>'
    : o.liquidated ? '<span class="atag loss">强平</span>'
      : o.status === 'win' ? '<span class="atag win">止盈</span>'
        : o.status === 'loss' ? '<span class="atag loss">止损</span>'
          : '<span class="atag skip">跳过</span>';
  const pnlHtml = (o.status === 'win' || o.status === 'loss')
    ? `<b class="num ${o.pnl >= 0 ? 'up' : 'down'}">${o.pnl >= 0 ? '+' : ''}${fmt(o.pnl, 2)}</b>`
      + `<div class="mut" style="font-size:10px">${o.pnlPct >= 0 ? '+' : ''}${fmt(o.pnlPct, 2)}%</div>`
    : '<span class="mut">—</span>';
  const lv = o.status === 'skip' ? '<span class="mut">—</span>'
    : `<div>${fmt(o.entry, 2)}</div><div class="mut" style="font-size:10px">SL ${fmt(o.sl, 2)} · TP ${fmt(o.tp1, 2)}`
      + (o.liqP ? ` · 强平 ${fmt(o.liqP, 2)}` : '') + `</div>`;
  const exitCell = o.exitPx ? `<div>${fmt(o.exitPx, 2)}</div>
      <div class="mut" style="font-size:10px">${new Date(o.exitT).toLocaleTimeString('zh-CN', { hour12: false })}</div>` : '<span class="mut">—</span>';
  return `<tr>
    <td>${t}${o.catchup ? ' <span class="atag skip">错过档位</span>' : ''}</td>
    <td class="${sideCls}">${sideTxt}</td>
    <td class="sig">${(o.sig && o.sig.text) || '—'}<div class="mut" style="font-size:10px">四层一致度 ${(o.sig && o.sig.conf) || 0}%（非胜率） · 合成 ${(o.sig && o.sig.score) || 0}</div></td>
    <td>${lv}</td>
    <td>${exitCell}</td>
    <td>${tag}</td>
    <td>${pnlHtml}</td>
  </tr>`;
}
const AUTO_TB = `<table class="al-tb"><thead><tr>
  <th>时间</th><th>方向</th><th>下单信号</th><th>入场 / 止损 / 止盈</th><th>出场</th><th>状态</th><th>盈亏 (USDT)</th>
</tr></thead><tbody>`;

function renderAuto() {
  renderAutoModel();
  const st = $('#autoState'), tg = $('#autoToggle');
  if (st) {
    st.textContent = AUTO.on ? '运行中 · 仅 ETH' : '已停止';
    st.className = 'src ' + (AUTO.on ? 'real' : 'syn');
  }
  if (tg) {
    tg.textContent = AUTO.on ? '停止自动交易' : '启动自动交易';
    tg.className = 'btn ' + (AUTO.on ? '' : 'solid');
  }
  const list = AUTO.orders;
  const S1 = autoStatsOf(list);
  const today = dayKey(now());
  const todayList = list.filter(o => o.day === today);
  const S2 = autoStatsOf(todayList);

  const cell = (label, val, cls) => `<div class="st"><span>${label}</span><b class="${cls || ''}">${val}</b></div>`;
  const eq = autoEquity(), uRisk = autoUsedRisk(), uNot = autoUsedNotional();
  const riskPct = eq > 0 ? uRisk / eq * 100 : 0;
  const notX = eq > 0 ? uNot / eq : 0;
  $('#autoStats').innerHTML =
    cell('账户权益', fmt(eq, 0), eq > 0 ? '' : 'down')
    + cell('在持风险', `${fmt(uRisk, 0)} · ${fmt(riskPct, 1)}%`, riskPct >= AUTO.maxRiskTotalPct ? 'down' : '')
    + cell('名义敞口', `${fmt(uNot, 0)} · ${fmt(notX, 1)}×`, notX >= AUTO.maxLevNotional ? 'down' : '')
    + cell('累计单据', S1.total)
    + cell('持仓中', S1.open, S1.open ? '' : 'mut')
    + cell('止盈 / 止损', `${S1.win} / ${S1.loss}${S1.liq ? `（含强平 ${S1.liq}）` : ''}`)
    + cell('胜率', S1.rate == null ? '—' : S1.rate.toFixed(0) + '%')
    + cell('累计净盈亏', (S1.net >= 0 ? '+' : '') + fmt(S1.net, 2), S1.net >= 0 ? 'up' : 'down')
    + cell('今日 / 盈亏', `${S2.total} · ${(S2.net >= 0 ? '+' : '') + fmt(S2.net, 2)}`, S2.net >= 0 ? 'up' : 'down');

  const open = list.filter(o => o.status === 'open');
  const px = autoPx();
  const oi = $('#autoOpenInfo');
  if (oi) {
    const parts = [];
    // P0-4：显示正在等待的扫单状态
    if (AUTO.pendingSweep) {
      const p = AUTO.pendingSweep;
      const left = Math.max(0, p.deadline - now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      parts.push(`<span><b class="${p.bias === 'long' ? 'up' : 'down'}">等待扫单收回</b>
        <span class="mut">${fmt(p.sweepLo, p.T.dp)} – ${fmt(p.sweepHi, p.T.dp)} · ${p.bias === 'long' ? '跌进后做多' : '涨进后做空'} · 剩余 ${m}:${String(s).padStart(2, '0')}</span></span>`);
    }
    if (open.length) {
      parts.push(...open.map(o => {
        const fl = (px > 0) ? autoPnl(o, px) : null;
        const cls = fl ? (fl.pnl >= 0 ? 'up' : 'down') : '';
        return `<span><b class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? '做多' : '做空'}</b>
          ${fmt(o.entry, 2)} → 现 ${px ? fmt(px, 2) : '—'}
          <span class="mut">SL ${fmt(o.sl, 2)} · TP ${fmt(o.tp1, 2)} · 保证金 ${fmt(o.margin, 0)} · 风险 ${fmt(autoRiskAmt(o), 0)}</span></span>
          <span class="num ${cls}">${fl ? (fl.pnl >= 0 ? '+' : '') + fmt(fl.pnl, 2) + '（' + (fl.pnlPct >= 0 ? '+' : '') + fmt(fl.pnlPct, 1) + '%）' : '—'}</span>`;
      }));
    }
    oi.innerHTML = parts.length ? parts.join('')
      : '<span class="mut">当前无持仓' + (AUTO.on ? '，等待下一档' : '') + '</span>';
  }

  const tk = $('#autoTodayKey');
  if (tk) tk.textContent = today + ' · ' + todayList.length + ' 笔';
  $('#autoToday').innerHTML = todayList.length
    ? AUTO_TB + todayList.slice().reverse().map(autoRowHtml).join('') + '</tbody></table>'
    : '<div class="mut" style="font-size:11.5px">今日暂无单据</div>';

  const days = [...new Set(list.map(o => o.day))].sort().reverse();
  $('#autoDays').innerHTML = days.length ? days.map(d => {
    const dl = list.filter(o => o.day === d);
    const s = autoStatsOf(dl);
    return `<div class="al-day">${d}<i>${dl.length} 笔 · 止盈 ${s.win} / 止损 ${s.loss}`
      + (s.rate == null ? '' : ` · 胜率 ${s.rate.toFixed(0)}%`)
      + ` · 净盈亏 <b class="${s.net >= 0 ? 'up' : 'down'}">${(s.net >= 0 ? '+' : '') + fmt(s.net, 2)}</b></i></div>`
      + AUTO_TB + dl.slice().reverse().map(autoRowHtml).join('') + '</tbody></table>';
  }).join('') : '<div class="mut" style="font-size:11.5px">暂无历史单据</div>';

  const nt = $('#autoNote');
  if (nt) {
    nt.innerHTML = '模拟盘：不接任何交易所 API，不产生真实成交，所有价位与成交均为按真实行情推演的账面记录。'
      + '<br><b>方向只来自四周期融合决策</b>：4h 定趋势 → 1h 筛选机会 → 30m 观察回调 → 15m 触发进场，'
      + '任何一层不过就整体观望；不再读「设置里的单个周期」。价位按执行周期 '
      + (MTF_LABEL[AUTO.tf] || AUTO.tf) + ' 的结构给出，方向强制与总决策一致。'
      + '15m 处于扫单结构时，需价格真正进入扫单带才反向开仓（页面写「等扫单收回」，执行也真的等）。'
      + '<br><b>成交与成本</b>：市价成交按当前买卖价差的一半 + 1bp 冲击成本计滑点，不再是「报价即成交价」；'
      + '止盈止损除轮询价外，还用 K 线 high/low 区间补判（避免 7 秒轮询漏掉插针），跳空按开盘价成交。'
      + '手续费 taker ' + (AUTO_FEE * 100).toFixed(3) + '% × 2（开平各一次）；'
      + '持仓跨越 8 小时结算点计资金费（取不到费率记 0）。'
      + '<br><b>仓位与风控</b>：保证金由权益倒推，单笔风险 ≤ 权益 ' + fmt(AUTO.riskPerTradePct, 1) + '%、'
      + '在持风险合计 ≤ ' + fmt(AUTO.maxRiskTotalPct, 1) + '%、总名义敞口 ≤ 权益 ' + fmt(AUTO.maxLevNotional, 0) + ' 倍、'
      + '单笔保证金 ≤ 权益 ' + fmt(AUTO.maxMarginPct, 0) + '%，同时持仓不超过 ' + AUTO.maxOpen + ' 笔；任一条不满足即跳过该档。'
      + '<br><b>数据新鲜度</b>：报价超过 30s、K 线停更 / 断档 / 最后一根过期、四周期任一份缺失、'
      + '网络取数失败超过 90s，一律禁止开仓。'
      + '<br><b>浏览器完全关闭期间脚本不会运行</b>，重开页面时错过的档位统一记为「跳过」，'
      + '不再按当前行情补开新单（要评估历史表现请用下面的离线回放）。'
      + '<br>' + CONF_NOTE + ' ' + INDEP_NOTE + ' ' + SWEEP_TENDENCY_NOTE;
  }
  renderAutoLight();
}

function renderAutoLight() {
  const n = $('#autoNext');
  if (n) {
    if (!AUTO.on) { n.textContent = '未启动'; }
    else if (AUTO.pendingSweep) {
      const left = Math.max(0, AUTO.pendingSweep.deadline - now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      n.textContent = `扫单倒计时 ${m}:${String(s).padStart(2, '0')}`;
    } else {
      const left = Math.max(0, AUTO.nextAt - now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      n.textContent = `下一单 ${m}:${String(s).padStart(2, '0')}`;
    }
  }
}

function bindAuto() {
  const tg = $('#autoToggle');
  if (tg) tg.onclick = () => {
    AUTO.on = !AUTO.on;
    if (AUTO.on) {
      if (AUTO.nextAt <= 0 || AUTO.nextAt < now() - 7 * 86400000) AUTO.nextAt = now() + autoIvMs();
      AUTO.startedAt = AUTO.startedAt || now();
      autoEnsureData(true);
    }
    autoSave(); renderAuto();
  };
  const sv = $('#autoSaveSet');
  if (sv) sv.onclick = () => {
    const iv = parseInt($('#autoIv').value, 10);
    const mg = parseFloat($('#autoMg').value);
    const lv = parseFloat($('#autoLv').value);
    const rr = parseFloat($('#autoRr').value);
    const tf = $('#autoTf').value;
    const mo = parseInt($('#autoMaxOpen').value, 10);
    const bl = parseFloat($('#autoBalance').value);
    const rp2 = parseFloat($('#autoRiskPct').value);
    const rt = parseFloat($('#autoRiskTot').value);
    const mn = parseFloat($('#autoMaxNot').value);
    const mp = parseFloat($('#autoMarginPct').value);
    AUTO.ivMin = clamp(isFinite(iv) ? iv : AUTO_IV_DEF, 1, 720);
    AUTO.margin = clamp(isFinite(mg) ? mg : 1000, 10, 1e6);
    AUTO.lev = clamp(isFinite(lv) ? lv : 10, 1, 125);
    AUTO.rr = clamp(isFinite(rr) ? rr : 1.5, 1, 10);
    AUTO.maxOpen = clamp(isFinite(mo) ? mo : 5, 1, 50);
    AUTO.balance = clamp(isFinite(bl) ? bl : 10000, 100, 1e9);
    AUTO.riskPerTradePct = clamp(isFinite(rp2) ? rp2 : 2, 0.1, 20);
    AUTO.maxRiskTotalPct = clamp(isFinite(rt) ? rt : 6, 0.5, 50);
    AUTO.maxLevNotional = clamp(isFinite(mn) ? mn : 20, 1, 200);
    AUTO.maxMarginPct = clamp(isFinite(mp) ? mp : 40, 5, 100);
    if (TF_MAP[tf]) AUTO.tf = tf;
    autoSave(); renderAuto(); toast('参数已保存');
  };
  const ex = $('#autoExport');
  if (ex) ex.onclick = () => {
    const head = ['时间', '品种', '周期', '方向', '保证金', '名义', '入场', '止损', '止盈', '出场',
      '状态', '出场方式', '毛盈亏', '手续费', '资金费', '盈亏', '盈亏%', '信号', '四层一致度', '错过档位'];
    const rows = AUTO.orders.map(o => [
      new Date(o.t).toLocaleString('zh-CN', { hour12: false }), o.sym, o.tf,
      o.side === 'long' ? '做多' : o.side === 'short' ? '做空' : '观望',
      o.margin || '', o.notional || '',
      o.entry || '', o.sl || '', o.tp1 || '', o.exitPx || '',
      o.status, o.exitGap ? '跳空' : (o.exitSrc === 'bar' ? 'K线区间' : '报价'),
      o.gross != null ? o.gross.toFixed(2) : '', o.fee != null ? o.fee.toFixed(2) : '',
      o.fund != null ? o.fund.toFixed(2) : '',
      o.pnl != null ? o.pnl.toFixed(2) : '', o.pnlPct != null ? o.pnlPct.toFixed(2) : '',
      (o.sig && o.sig.text) || '', (o.sig && o.sig.conf) || '', o.catchup ? 'Y' : '',
    ]);
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'auto-orders-' + dayKey(now()) + '.csv';
    a.click();
  };
  const rp = $('#replayRun');
  if (rp) rp.onclick = async () => {
    const label = rp.textContent;
    rp.disabled = true; rp.textContent = '回放中…';
    try {
      let d = (S.klines[AUTO.sym] || {})[AUTO.tf];
      if (!d || !d.bars || d.bars.length < 60) {
        try { await loadKlines(AUTO.sym, AUTO.tf); } catch (e) { /* 取数失败时 renderReplay 会给出提示 */ }
        d = (S.klines[AUTO.sym] || {})[AUTO.tf];
      }
      renderReplay();
    } finally { rp.disabled = false; rp.textContent = label; }
  };
  // 参数面板回填当前值
  const iv = $('#autoIv'), mg = $('#autoMg'), lv = $('#autoLv'), rr = $('#autoRr'), tf = $('#autoTf');
  const mo = $('#autoMaxOpen'), bl = $('#autoBalance'), rp2 = $('#autoRiskPct');
  const rt = $('#autoRiskTot'), mn = $('#autoMaxNot'), mp = $('#autoMarginPct');
  if (iv) iv.value = AUTO.ivMin;
  if (mg) mg.value = AUTO.margin;
  if (lv) lv.value = AUTO.lev;
  if (rr) rr.value = AUTO.rr;
  if (tf) tf.value = AUTO.tf;
  if (mo) mo.value = AUTO.maxOpen;
  if (bl) bl.value = AUTO.balance;
  if (rp2) rp2.value = AUTO.riskPerTradePct;
  if (rt) rt.value = AUTO.maxRiskTotalPct;
  if (mn) mn.value = AUTO.maxLevNotional;
  if (mp) mp.value = AUTO.maxMarginPct;
}

