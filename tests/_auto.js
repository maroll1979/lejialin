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

const EXPORT = '\n;module.exports={autoLevels,autoHit,autoPnl,autoCatchCount,autoR2,AUTO_FEE,AUTO_CATCH_CAP,AUTO_IV_DEF};';
const m = {};
new Function('module', 'exports', code + EXPORT)(m, {});
const { autoLevels, autoHit, autoPnl, autoCatchCount, autoR2, AUTO_FEE, AUTO_CATCH_CAP } = m.exports;

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
  ok(/if \(!\(px > 0\) \|\| !bars\) return false/.test(src), '无真实价或真实 K 线时不下单');
  ok(/autoHit\(o\.side, o\.sl, o\.tp1, px, px\)/.test(src), '持仓检查：到价即平，无二次确认');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
