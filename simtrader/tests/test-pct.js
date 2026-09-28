/* ============================================================
   test-pct.js · 1m 粒度回测 与 手动百分比止盈止损 的单元测试
   ------------------------------------------------------------
   不需要联网（用合成数据），可重复。
   最重要的一条断言是「不变量」：同一套信号下，5m 撮合与 1m 撮合
   必须逐笔完全一致 —— 这是 signalSec / baseSec 分离改造的地基。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'simtrader');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  — ' + extra : '')); }
}
function head(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }

const S = require(path.join(DIR, 'strategy.js'));
const htmlSrc = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

(async () => {
  head('保本胜率公式（回答「1:1 到底要多少胜率」）');
  const BE = S.breakevenWinRate;
  ok(typeof BE === 'function', 'breakevenWinRate 已导出');

  /* 零手续费下必须退化回用户直觉的那组数字 */
  ok(Math.abs(BE(0.01, 0.01, 0).breakeven - 0.5) < 1e-9,
    '零费率 1:1 → 保本 50%（用户直觉的基准）');
  ok(Math.abs(BE(0.015, 0.03, 0).breakeven - 1 / 3) < 1e-9,
    '零费率 1:2（1.5%:3%）→ 保本 33.3%');
  ok(Math.abs(BE(0.01, 0.03, 0).breakeven - 0.25) < 1e-9,
    '零费率 1:3 → 保本 25%');

  /* 计入双边 0.2% Taker 后必须显著抬高 */
  const b11 = BE(0.01, 0.01, 0.001);
  const b12 = BE(0.015, 0.03, 0.001);
  ok(Math.abs(b11.breakeven - 0.60) < 0.005,
    'Taker 下 1:1（1%:1%）→ 保本 ' + (b11.breakeven * 100).toFixed(1) + '%，不是 50%');
  ok(Math.abs(b12.breakeven - 0.378) < 0.005,
    'Taker 下 1:2（1.5%:3%）→ 保本 ' + (b12.breakeven * 100).toFixed(1) + '%，不是 33%');
  ok(b11.breakeven > 0.5 && b12.breakeven > 1 / 3, '含费率后保本线一律高于零费率的直觉值');
  ok(Math.abs(b11.feeR - 0.2) < 1e-9, '1% 止损下每笔进出费用 = 0.200R');
  ok(BE(0.015, 0.03, 0.001).feeR < BE(0.01, 0.02, 0.001).feeR,
    '同为 1:2，宽止损（1.5%:3%）费用占比低于窄止损（1%:2%）');
  ok(BE(0.01, 0.001, 0.001) === null, '止盈盖不住手续费时返回 null，而不是给出虚高胜率');

  const bx = BE(0.015, 0.03, 0.001);
  ok(Math.abs(bx.expR(bx.breakeven)) < 1e-12, '以保本胜率代入 expR → 每笔期望恰为 0');
  ok(bx.expR(bx.breakeven + 0.05) > 0, '胜率高出保本线 5 个百分点 → 期望转正');
  ok(BE(0.01, 0.01, 0.0001) !== null
    && Math.abs(BE(0.01, 0.01, 0.0001).breakeven - 0.51) < 0.005,
    'Maker（单边 0.01%）下 1:1 保本回到 51%');

  head('合成 1m 序列（不联网、可重复）');
  function synth1m(n, seed) {
    const rows = [];
    let st = seed || 20260928, px = 30000;
    const rnd = function () { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
    const base = 1700000000 - (1700000000 % 60);
    for (let i = 0; i < n; i++) {
      px += Math.sin(i / 220) * 26 + Math.sin(i / 63) * 11 + (rnd() - 0.5) * 34;
      const o = px, c = px + (rnd() - 0.5) * 20;
      const h = Math.max(o, c) + 6 + rnd() * 40;
      const l = Math.min(o, c) - 6 - rnd() * 40;
      rows.push({ time: base + i * 60, open: o, high: h, low: l, close: c, volume: 12 + rnd() * 8 });
    }
    return rows;
  }
  const N1M = 30000;                                   // 500 小时 ≈ 21 天
  const s1mT = S.toSeries(synth1m(N1M));
  const s5mT = S.aggregate(s1mT, 300);
  ok(s1mT.n === N1M && Math.abs(s5mT.n - N1M / 5) <= 1,
    '1m ' + N1M + ' 根 → 5m ' + s5mT.n + ' 根（5:1 聚合）');

  const V_T = { thz: 0.30, bufPct: 0.005, minVotes: 3 };
  const PCT_T = { stopPct: 0.015, tpPct: 0.030, tpMode: 'single' };

  head('不变量：同一信号下 5m 撮合 ≡ 1m 撮合');
  const ra = S.backtestCore(s5mT, { vote: V_T, msMode: false, baseSec: 300, stopPct: PCT_T.stopPct, tpPct: PCT_T.tpPct, tpMode: 'single' });
  const rb = S.backtestCore(s1mT, { vote: V_T, msMode: false, baseSec: 60, sigSec: 300, stopPct: PCT_T.stopPct, tpPct: PCT_T.tpPct, tpMode: 'single' });
  ok(ra.count > 0, '合成数据上确实产生了交易（' + ra.count + ' 笔），测试有效');
  ok(ra.count === rb.count, '笔数一致：5m撮合 ' + ra.count + ' = 5m信号+1m撮合 ' + rb.count);

  let allSame = ra.count > 0, maxDiff = 0;
  for (let i = 0; i < Math.min(ra.count, rb.count); i++) {
    const p = ra.trades[i], q = rb.trades[i];
    if (Math.abs(p.entry - q.entry) > 1e-9 || Math.abs(p.exit - q.exit) > 1e-9
      || p.how !== q.how || p.dir !== q.dir) allSame = false;
    maxDiff = Math.max(maxDiff, Math.abs(p.r - q.r));
  }
  ok(allSame, '逐笔对照：入场价 / 出场价 / 出场方式 / 方向全部一致');
  ok(maxDiff < 1e-12, '两档每笔 R 最大偏差 ' + maxDiff.toExponential(2) + '（应为 0）');

  head('百分比止盈止损的落地口径');
  let pctOk = true, riskOk = true, tpOk = true;
  for (const t of rb.trades) {
    if (Math.abs(Math.abs(t.entry - t.stop) / t.entry - 0.015) > 1e-6) pctOk = false;
    if (Math.abs(t.risk - t.entry * 0.015) > 1e-6) riskOk = false;
    const want = t.dir === 'long' ? t.entry * 1.03 : t.entry * 0.97;
    if (Math.abs(t.tp1 - want) > 1e-6) tpOk = false;
  }
  ok(pctOk, '每笔止损距离 = 成交价 × 1.5%（按入场价算，与 ATR 无关）');
  ok(riskOk, 'risk 字段 = 入场价 × 止损%，R 的基准正确');
  ok(tpOk, '每笔止盈价位 = 成交价 ×（1 ± 3%）');

  const batch = ['止盈二', '止损（半仓）'];
  ok(rb.trades.every(t => batch.indexOf(t.how) < 0),
    'single 模式下不会出现分批出场（无「止盈二」/「止损（半仓）」）');

  const tpTr = rb.trades.filter(t => t.how === '止盈');
  ok(tpTr.length > 0, '样本里存在止盈单（' + tpTr.length + ' 笔）');
  ok(tpTr.every(t => Math.abs(t.grossR - 2) < 1e-9),
    '止盈单毛利恰为 2R（1:2 盈亏比的直接体现）');
  const slTr = rb.trades.filter(t => t.how === '止损');
  if (slTr.length) {
    ok(slTr.every(t => Math.abs(t.grossR + 1) < 1e-6),
      '止损单毛利恰为 -1R（未跳空时）');
  }

  head('信号周期分离');
  const rc = S.backtestCore(s1mT, { vote: V_T, msMode: false, baseSec: 60, sigSec: 60, stopPct: PCT_T.stopPct, tpPct: PCT_T.tpPct, tpMode: 'single' });
  ok(rc.count !== rb.count,
    '信号最低周期 5m→1m 后笔数改变（' + rb.count + ' → ' + rc.count + '），两档确实不同');
  ok(ra.baseLabel === '5m' && rb.baseLabel === '1m' && rc.baseLabel === '1m', '结果带正确的 baseLabel');
  ok(ra.baseSec === 300 && rb.baseSec === 60 && rc.baseSec === 60, '结果带正确的 baseSec');
  ok(isFinite(rb.avgHoldHours) && rb.avgHoldHours >= 0,
    '1m 口径下 avgHoldHours 有效（不再沿用 5m 的 ×5/60 换算）');

  head('mapLastBase 边界');
  const mb = S.mapLastBase;
  ok(typeof mb === 'function', 'mapLastBase 已导出');
  if (typeof mb === 'function') {
    const m = mb(s5mT.t, 300, s1mT.t, 60);
    ok(m.length === s5mT.n, '映射长度 = 粗周期根数');
    ok(m[0] >= 0 && m[m.length - 1] < s1mT.n, '映射落在合法索引区间内');
    ok(m[m.length - 1] >= m[0], '映射单调递增');
    let okLast = true;
    for (let i = 1; i < m.length; i += 37) {
      if (m[i] < 0) continue;
      if (s1mT.t[m[i]] !== s5mT.t[i] + 300 - 60) okLast = false;
    }
    ok(okLast, '每根 5m 映射到其内部的最后一根 1m（= t₅ₘ + 240s）');
  }

  head('看板接入点');
  ok(/id="btBase"/.test(htmlSrc), 'index.html 含撮合粒度选择 #btBase');
  ok(/id="btSig"/.test(htmlSrc), 'index.html 含信号周期选择 #btSig');
  ok(/id="btStop"/.test(htmlSrc) && /id="btTp"/.test(htmlSrc), 'index.html 含止损/止盈百分比输入');
  ok(/class="btn-xs bt-ps"/.test(htmlSrc), 'index.html 含 1:1 / 1:2 / 1:3 预设按钮');
  ok(/breakevenWinRate/.test(appSrc), '看板实时计算保本胜率');
  ok(/stopPct: p\.stopPct/.test(appSrc), '看板传入手动指定的 stopPct/tpPct');
  ok(/sigSec: p\.sigSec/.test(appSrc), '看板传入 sigSec（信号周期与撮合粒度分离）');
  ok(/vote: voteOpt\(\)/.test(appSrc), '回测与投票面板共用 voteOpt()，口径一致');
  ok(/tpMode: 'single'/.test(appSrc), '看板默认一次性全平');
  ok(!/tpslFn: tpSlPlan/.test(appSrc), '回测不再依赖 ATR 式的 tpSlPlan');

  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
