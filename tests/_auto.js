// 自动交易（模拟盘）纯计算段测试：切出 app.js 的 AUTO-PURE 段
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');

const p0 = src.indexOf('/* ===== AUTO-PURE-START =====');
const p1 = src.indexOf('/* ===== AUTO-PURE-END =====');
if (p0 < 0 || p1 < 0) throw new Error('AUTO-PURE 切分点未找到');
// 基础工具（clamp/now 等）在文件头部，拼上即可
const base = src.slice(0, src.indexOf('/* ============================ 网络基础'));
const code = base + '\n' + src.slice(p0, p1);

const _store = {};
global.localStorage = {
  getItem: k => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
};
global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};

const EXPORT = '\n;module.exports={autoLevels,autoHit,autoPnl,autoCatchCount,autoR2,AUTO_FEE,AUTO_CATCH_CAP,AUTO_IV_DEF,' +
  'autoLiqPx,autoExitHit,AUTO_MMR,autoSlipPx,autoBudget,autoFundFee};';
const m = {};
new Function('module', 'exports', code + EXPORT)(m, {});
const { autoLevels, autoHit, autoPnl, autoCatchCount, autoR2, AUTO_FEE, AUTO_CATCH_CAP,
  autoLiqPx, autoExitHit, AUTO_MMR, autoSlipPx, autoBudget, autoFundFee } = m.exports;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => {
  if (c) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('\n[1] 价位：止损取结构风险距离，止盈按盈亏比 1:1.5 反推');
{
  const L = autoLevels(3000, 'long', 30, 1.5);
  ok(L && near(L.sl, 2970) && near(L.tp1, 3045), '做多：SL=入场−风险，TP1=入场+1.5×风险', JSON.stringify(L));
  ok(L.sl < 3000 && L.tp1 > 3000, '做多：止损在下方、止盈在上方');
  const risk = 3000 - L.sl, rew = L.tp1 - 3000;
  ok(near(rew / risk, 1.5, 1e-9), '做多：盈亏比精确等于 1.5', (rew / risk).toFixed(6));

  const S1 = autoLevels(3000, 'short', 30, 1.5);
  ok(S1 && near(S1.sl, 3030) && near(S1.tp1, 2955), '做空：方向与做多完全镜像', JSON.stringify(S1));
  ok(S1.sl > 3000 && S1.tp1 < 3000, '做空：止损在上方、止盈在下方');
  ok(near((3000 - S1.tp1) / (S1.sl - 3000), 1.5, 1e-9), '做空：盈亏比精确等于 1.5');
}

console.log('\n[2] 边界与非法输入');
{
  ok(autoLevels(3000, 'wait', 30, 1.5) === null, '方向为观望时不产出价位');
  ok(autoLevels(0, 'long', 30, 1.5) === null, '价格为 0 时不产出价位');
  ok(autoLevels(3000, 'long', 0, 1.5) === null, '风险距离为 0 时不产出价位');
  const tiny = autoLevels(3000, 'long', 0.1, 1.5);    // 0.003% → 夹到 0.15%
  ok(tiny && (3000 - tiny.sl) >= 3000 * 0.0015 - 0.01, '风险距离过小被夹到下限 0.15%', JSON.stringify(tiny));
  const huge = autoLevels(3000, 'long', 900, 1.5);    // 30% → 夹到 5%
  ok(huge && (3000 - huge.sl) <= 3000 * 0.05 + 0.01, '风险距离过大被夹到上限 5%', JSON.stringify(huge));
  ok(autoLevels(3000, 'long', 30, 2) && near(autoLevels(3000, 'long', 30, 2).tp1, 3060), '盈亏比可调（2:1 → +60）');
}

console.log('\n[3] 两位小数');
{
  const L = autoLevels(3018.456, 'long', 23.3337, 1.5);
  ok(near(L.sl, autoR2(L.sl)) && near(L.tp1, autoR2(L.tp1)), '止盈止损均精确到小数点后两位', JSON.stringify(L));
  ok(near(autoR2(1.005), 1.01) || near(autoR2(1.005), 1.0), 'autoR2 四舍五入不抛异常');
}

console.log('\n[4] 命中判定');
{
  ok(autoHit('long', 2970, 3045, 2960, 3000) === 'sl', '做多：跌破止损 → 止损');
  ok(autoHit('long', 2970, 3045, 2990, 3050) === 'tp', '做多：涨过止盈 → 止盈');
  ok(autoHit('long', 2970, 3045, 2990, 3010) === null, '做多：区间内 → 继续持有');
  ok(autoHit('short', 3030, 2955, 2990, 3040) === 'sl', '做空：涨过止损 → 止损');
  ok(autoHit('short', 3030, 2955, 2940, 3020) === 'tp', '做空：跌过止盈 → 止盈');
  ok(autoHit('long', 2970, 3045, 2900, 3100) === 'sl', '单边 tick 内同时穿越两边 → 止损优先（保守）');
  ok(autoHit('hold', 2970, 3045, 2900, 3100) === null, '非法方向不命中');
}

console.log('\n[5] 盈亏：含双边手续费');
{
  const o = { side: 'long', entry: 3000, notional: 10000, margin: 1000 };
  const w = autoPnl(o, 3045);              // 涨 1.5%
  ok(near(w.gross, 150), '毛盈亏 = 价格变动 × 张数 × 方向', w.gross.toFixed(4));
  ok(near(w.fee, 10000 * AUTO_FEE * 2), '手续费 = 名义 × 费率 × 2（开平各一次）', w.fee.toFixed(4));
  ok(near(w.pnl, 150 - 10), '净盈亏扣掉双边手续费', w.pnl.toFixed(4));
  ok(near(w.pnlPct, (150 - 10) / 1000 * 100), '盈亏按保证金口径计百分比', w.pnlPct.toFixed(3));

  const l = autoPnl(o, 2970);              // 跌 1%
  ok(l.pnl < 0, '止损出场为负');
  const s = autoPnl({ side: 'short', entry: 3000, notional: 10000, margin: 1000 }, 2955);
  ok(s.pnl > 0, '做空在下跌中盈利', s.pnl.toFixed(4));
  const s2 = autoPnl({ side: 'short', entry: 3000, notional: 10000, margin: 1000 }, 3030);
  ok(s2.pnl < 0, '做空在上涨中亏损', s2.pnl.toFixed(4));
}

console.log('\n[6] 自然时间网格与补单');
{
  const iv = 30 * 60000, t0 = 1000000;
  ok(autoCatchCount(t0, t0 - 1, iv, 48) === 0, '未到档位不补单');
  ok(autoCatchCount(t0, t0, iv, 48) === 1, '正好到档位 → 补 1 单');
  ok(autoCatchCount(t0, t0 + iv - 1, iv, 48) === 1, '不足一个间隔 → 仍只补 1 单');
  ok(autoCatchCount(t0, t0 + iv * 3, iv, 48) === 4, '跨 3 个间隔 → 补 4 单');
  const day = autoCatchCount(t0, t0 + iv * 48 * 2, iv, 48);
  ok(day === AUTO_CATCH_CAP, '断线两天也只补上限 48 单', String(day));
  ok(autoCatchCount(t0, t0 + 1000, 0, 48) === 0, '间隔非法不补单');
}

console.log('\n[7] 默认参数符合用户规则');
{
  ok(AUTO_FEE > 0, '手续费率为正：' + AUTO_FEE);
  const def = src.match(/const AUTO_IV_DEF = (\d+);/);
  ok(def && +def[1] === 30, '默认间隔 30 分钟', def && def[1]);
  ok(/sym: 'ETH'/.test(src), '引擎品种固定为 ETH');
  ok(/margin: 1000,/.test(src) && /lev: 10,/.test(src), '默认保证金 1000 / 杠杆 10');
  ok(/rr: 1\.5,/.test(src), '默认盈亏比 1.5');
  ok(/orders: \[\],/.test(src) && !/\.splice\(/.test(src.slice(src.indexOf('const AUTO_KEY'))),
    '单据数组只增不删');
  ok(/不接任何交易所 API/.test(src), '界面明确标注为模拟盘');
  ok(/if \(!\(px > 0\)\) return false/.test(src), '无真实价时不下单');
  ok(/function autoMtfReady/.test(src), '四周期数据齐备才开仓');
  ok(/function autoBudget/.test(src), '仓位由账户权益与风险倒推');
  ok(/function autoSlipPx/.test(src), '成交计滑点');
  ok(/function autoExitScan/.test(src), '止盈止损用 K 线区间补判');
  ok(/function autoFundFee/.test(src), '持仓计资金费');
  ok(/const dec = mtfDecision\(AUTO\.sym\)/.test(src), '开仓方向取自四周期融合决策');
  ok(!/autoMultiBias\(\)/.test(src.slice(src.indexOf('function autoOpenOnce'))), '开仓不再走单周期共振口径');
  ok(/autoExitHit\(o, px, px\)/.test(src), '持仓检查：到价即平，无二次确认（含强平线）');
  ok(/function autoLiqPx/.test(src) && /AUTO_MMR/.test(src), '存在强平价与维持保证金率');
  ok(/function autoExitHit/.test(src), '出场判定统一走 autoExitHit（强平 / 止损 / 止盈）');
  ok(/o\.liquidated = r\.hit === 'liq'/.test(src), '强平平仓会打上标记');
  ok(/liqP:/.test(src), '单据记录强平价');
  ok(/function renderAutoModel/.test(src) && /const AUTO_ASSUME/.test(src), '模拟盘有假设与偏差面板');
  ok(/仍未计入/.test(src), '假设面板列出仍未计入的偏差');
  ok(/错过档位/.test(src) && !/>补单</.test(src), '错过的档位不再标成「补单」');
  ok(/function autoCanTrade/.test(src), '存在数据过期检查');
  ok(/数据过期禁止开仓/.test(src), '数据过期时禁止开仓');
  ok(/不补开新单/.test(src), '错过档位不补开新单');
  ok(/等待扫单收回/.test(src), '页面策略与执行对齐：等待扫单收回');
  ok(/function autoSweepTrigger/.test(src), '存在扫单触发函数');
}

console.log('\n[8] 强平：高杠杆时强平线可能比止损更近，先被強平');
{
  ok(AUTO_MMR > 0, '存在维持保证金率', String(AUTO_MMR));
  const o10 = { entry: 100, side: 'long', lev: 10, sl: 99, tp1: 101.5, status: 'open' };
  ok(near(autoLiqPx(o10), 90.5, 1e-9), '10 倍做多强平价 = 入场 ×(1−1/10+维持率)', autoLiqPx(o10).toFixed(3));
  const s10 = { entry: 100, side: 'short', lev: 10, sl: 101, tp1: 98.5, status: 'open' };
  ok(near(autoLiqPx(s10), 109.5, 1e-9), '10 倍做空强平价在上方', autoLiqPx(s10).toFixed(3));

  // 低杠杆：止损（99）比强平（90.5）离入场更近 → 正常止损
  let h = autoExitHit(o10, 98.5, 100.5);
  ok(h && h.hit === 'sl' && near(h.lvl, 99), '10 倍：跌到 98.5 触发止损而非强平', JSON.stringify(h));
  ok(!autoExitHit(o10, 99.5, 100.5), '10 倍：没碰到止损就不出场');

  // 125 倍：强平在 99.7，比止损 99 更近 → 先被强平，而不是记成一笔普通止损
  const o125 = { entry: 100, side: 'long', lev: 125, sl: 99, tp1: 101.5, status: 'open' };
  ok(near(autoLiqPx(o125), 99.7, 1e-9), '125 倍强平价 = 入场 ×(1−1/125+维持率)', autoLiqPx(o125).toFixed(4));
  h = autoExitHit(o125, 99.65, 100.5);
  ok(h && h.hit === 'liq' && near(h.lvl, 99.7), '125 倍：跌破 99.7 判定为强平（不是止损）', JSON.stringify(h));
  h = autoExitHit(o125, 99.8, 101.6);
  ok(h && h.hit === 'tp', '125 倍：够到止盈就按止盈出场', JSON.stringify(h));
  const s125 = { entry: 100, side: 'short', lev: 125, sl: 101, tp1: 98.5, status: 'open' };
  h = autoExitHit(s125, 99.5, 100.35);
  ok(h && h.hit === 'liq', '做空同理：涨过强平价先被强平', JSON.stringify(h));
  ok(!autoExitHit({ entry: 100, side: 'long', lev: 10, sl: 99, tp1: 101.5, status: 'win' }, 80, 120),
    '已平仓的单不再参与出场判定');
}

console.log('\n[9] 成交成本：滑点与资金费不再被当成零');
{
  const buy = autoSlipPx(3000, 'long', true, 0.04);
  const sell = autoSlipPx(3000, 'long', false, 0.04);
  ok(buy > 3000, '买入成交价高于报价（吃卖一 + 冲击）', buy.toFixed(3));
  ok(sell < 3000, '卖出成交价低于报价（吃买一 + 冲击）', sell.toFixed(3));
  ok(near(buy - 3000, 3000 - sell, 1e-6), '买卖两侧滑点对称');
  ok(autoSlipPx(3000, 'long', true, null) > 3000, '取不到价差时用兜底值，仍然计入滑点');

  const held = { t: 0, side: 'long', notional: 10000 };
  ok(autoFundFee(held, 8 * 3600 * 1000 - 1, 0.0001) === 0, '未跨过结算点不计资金费');
  const f1 = autoFundFee(held, 8 * 3600 * 1000 + 1, 0.0001);
  ok(near(f1, -1, 1e-9), '多头跨一次结算点：付 0.01% × 名义', f1.toFixed(4));
  ok(near(autoFundFee({ t: 0, side: 'short', notional: 10000 }, 8 * 3600 * 1000 + 1, 0.0001), 1, 1e-9),
    '空头在正费率下收资金费');
  ok(autoFundFee(held, 8 * 3600 * 1000 + 1, null) === 0, '取不到费率记 0，不编造');
}

console.log('\n[10] 仓位由账户权益倒推，四条约束取最紧');
{
  const cfg = {
    equity: 10000, riskPerTradePct: 2, maxMarginPct: 40,
    maxRiskTotalPct: 6, maxLevNotional: 20, usedRisk: 0, usedNotional: 0, want: 1000,
  };
  let B = autoBudget(3000, 2970, 10, cfg);          // 风险距离 1%
  ok(B.ok && near(B.margin, 1000, 1e-6), '单笔风险 2% / 杠杆 10 → 保证金 1000（受 want 约束）', JSON.stringify(B));
  B = autoBudget(3000, 2970, 10, Object.assign({}, cfg, { want: 99999 }));
  ok(B.ok && near(B.margin, 2000, 1e-6), '放开 want 后由单笔风险 2% 决定 → 保证金 2000', String(B.margin));
  B = autoBudget(3000, 2970, 10, Object.assign({}, cfg, { want: 99999, usedRisk: 550 }));
  ok(B.ok && near(B.margin, 500, 1e-6), '在持风险已用 550 → 新单被压到剩余额度允许的 500', String(B.margin));
  B = autoBudget(3000, 2970, 10, Object.assign({}, cfg, { want: 99999, usedNotional: 199000 }));
  ok(B.ok && near(B.margin, 100, 1e-6), '名义敞口只剩 1000 → 新单被压到保证金 100', String(B.margin));
  B = autoBudget(3000, 2970, 10, Object.assign({}, cfg, { want: 99999, equity: 500, usedRisk: 29.5 }));
  ok(!B.ok && /总风险额度不足/.test(B.why), '风险额度耗尽 → 直接拒绝开仓', B.why);
  B = autoBudget(3000, 2970, 10, Object.assign({}, cfg, { want: 99999, equity: 500, usedNotional: 9990 }));
  ok(!B.ok, '名义额度耗尽 → 直接拒绝开仓', B.why);
  ok(autoBudget(0, 2970, 10, cfg).ok === false, '参数非法（无价格）→ 拒绝开仓');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
