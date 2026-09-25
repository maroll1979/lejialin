/* ============================================================
   第 14 条 · 四阶段回测验证
   ① 旧模型 vs v2.1
   ② 顺 4H / 震荡 / 逆 4H 分组绩效
   ③ 30m Transition 是否减少「趋势末端追单」
   ④ 5m CHOCH / CHOCH+Retest / 完整三段 对比
   + ⑤ 阈值扫描（§14.6：最后才优化阈值）
   用法：node cmp-v21.js [SYMBOL] [YEARS]
   ============================================================ */
const S = require('./strategy.js');
const V = require('./v21.js');
const cache = require('./fetch-cache.js');

const sym = process.argv[2] || 'BTCUSDT';
const years = Number(process.argv[3] || 5);

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d) => (v == null || !isFinite(v)) ? '-' : v.toFixed(d);

function line(a, b, c, d, e, f, g, h) {
  console.log('  ' + pad(a, 22) + pad(b, 7) + pad(c, 9) + pad(d, 8) + pad(e, 8)
    + pad(f, 9) + pad(g, 8) + pad(h, 10));
}

function head() {
  line('配置', '笔数', '胜率', '期望R', 't值', 'PF', '最大DD', '平均持仓');
  console.log('  ' + '-'.repeat(80));
}
function row(label, st) {
  line(label, st.count, (st.winRate * 100).toFixed(1) + '%',
    num(st.avgR, 3), num(st.t, 2), num(st.profitFactor, 2),
    (st.maxDD * 100).toFixed(1) + '%', st.avgHoldHours.toFixed(1) + 'h');
}

/* 毛利的 t 值（净值的 t 会被手续费主导，要分开看） */
function grossT(trades) {
  const n = trades.length;
  if (n < 2) return 0;
  const m = trades.reduce((a, t) => a + t.grossR, 0) / n;
  const sd = Math.sqrt(trades.reduce((a, t) => a + (t.grossR - m) * (t.grossR - m), 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return se > 0 ? m / se : 0;
}

(async () => {
  const rows = await cache.get(sym, years);
  const s5 = S.toSeries(rows);
  console.log(`\n========== v2.1 四阶段回测 · ${sym} · ${years} 年 ==========`);
  console.log(`5m ${s5.n} 根 · ${new Date(s5.t[0] * 1000).toISOString().slice(0, 10)} → ${new Date(s5.t[s5.n - 1] * 1000).toISOString().slice(0, 10)}`);

  const t0 = Date.now();
  const B = V.build(s5, { live: false });
  const spanDays = (s5.t[s5.n - 1] - s5.t[0]) / 86400;
  console.log(`构建 ${((Date.now() - t0) / 1000).toFixed(1)}s（15m ${B.s15.n} / 30m ${B.s30.n} / 1h ${B.s1h.n} / 4h ${B.s4h.n}）`);

  /* ---------- 旧模型（1h 定方向 + 15m 共振 + 5m 结构严格档） ----------
     用 strategy.js 的 findTriggersClosedMs 取触发点（带 5m 索引），
     再走 V.simulate，与 v2.1 共用同一套成交/手续费/出场口径，保证可比。 */
  const r5 = S.dirSeries(s5), r15 = S.dirSeries(B.s15), r1h = S.dirSeries(B.s1h);
  const m15 = S.buildClosedMap(s5.t, B.s15.t, 300, 900);
  const m1h = S.buildClosedMap(s5.t, B.s1h.t, 300, 3600);
  const oldTrigRaw = S.findTriggersClosedMs(r5.dirs, r15.dirs, r1h.dirs, m15, m1h, B.ms,
    { loose: false, minScore: 0, andDir: false });
  const oldTrig = oldTrigRaw.map(t => {
    const j30 = B.m30[t.i], j4h = B.m4h[t.i];
    return Object.assign({}, t, {
      reg: j4h >= 0 ? B.v4h.reg[j4h] : 0,
      st30: j30 >= 0 ? B.v30.stt[j30] : 0,
      st1: B.m1h[t.i] >= 0 ? B.v1h.stt[B.m1h[t.i]] : 0,
    });
  }).filter(t => t.i != null);
  const oldSim = V.simulate(s5, oldTrig, B, {});
  const oldTrades = oldSim.trades;
  const oldSt0 = V.stats(oldTrades, s5);

  /* ---------- ① 旧 vs 新 ---------- */
  console.log('\n【阶段 ①】旧模型 vs v2.1（总分门槛）');
  head();
  row('旧模型(1h+15m+5m结构)', oldSt0);
  const variants = [
    { label: 'v2.1 规范门槛70/75/85', opt: {} },
    { label: 'v2.1 统一 70', opt: { thrOverride: 70 } },
    { label: 'v2.1 统一 65', opt: { thrOverride: 65 } },
    { label: 'v2.1 统一 60', opt: { thrOverride: 60 } },
    { label: 'v2.1 统一 55', opt: { thrOverride: 55 } },
  ];
  const store = {};
  variants.forEach(v => {
    const sig = V.findSignals(s5, B, v.opt);
    const sim = V.simulate(s5, sig, B, {});
    const st = V.stats(sim.trades, s5);
    store[v.label] = { sig, trades: sim.trades, st };
    row(v.label, st);
  });

  console.log(`  （旧模型：毛利 ${num(oldSt0.grossAvg, 3)}R/笔 · 手续费 ${num(oldSt0.feeAvg, 3)}R/笔 · 触发 ${oldTrig.length} 次）`);

  /* ---------- ② 环境分组 ---------- */
  console.log('\n【阶段 ②】顺 4H / 震荡 / 逆 4H 分组（v2.1 统一 60，样本够看）');
  const pick = store['v2.1 统一 60'];
  const grp = V.byRegime(pick.trades);
  line('分组', '笔数', '胜率', '期望R', 't值', 'PF', '最大DD', '平均持仓');
  console.log('  ' + '-'.repeat(80));
  ['with', 'range', 'against'].forEach(k => {
    const name = { with: '顺 4H', range: '4H 震荡', against: '逆 4H' }[k];
    if (!grp[k].length) { line(name, 0, '-', '-', '-', '-', '-', '-'); return; }
    const st = V.stats(grp[k], s5);
    row(name, st);
    const cons = (() => { let c = 0, m = 0; grp[k].forEach(t => { if (t.win) c = 0; else { c++; if (c > m) m = c; } }); return m; })();
    const gt = grossT(grp[k]);
    console.log(`        毛利 ${num(st.grossAvg, 3)}R（t=${num(gt, 2)}） · 手续费 ${num(st.feeAvg, 3)}R · MAE ${num(st.avgMaeR, 2)}R · MFE ${num(st.avgMfeR, 2)}R · 最长连亏 ${cons}`);
  });

  /* ---------- ③ 30m Transition 是否减少末端追单 ---------- */
  console.log('\n【阶段 ③】30m Transition：衰竭组 vs 趋势组（同一批 v2.1 信号，按信号当时 30m 状态机分组）');
  line('信号时 30m 状态', '笔数', '胜率', '期望R', 't值', 'PF', '最大DD', '平均持仓');
  console.log('  ' + '-'.repeat(80));
  const exhStates = [V.ST.BEAR_EXH, V.ST.TRANSITION, V.ST.BULL_EXH];
  const trendStates = [V.ST.STRONG_BEAR, V.ST.BEAR, V.ST.BULL, V.ST.STRONG_BULL];
  [['衰竭/过渡', exhStates], ['趋势仍成立', trendStates]].forEach(([nm, set]) => {
    const sel = pick.trades.filter(t => set.indexOf(t.st30) >= 0);
    if (!sel.length) { line(nm, 0, '-', '-', '-', '-', '-', '-'); return; }
    row(nm, V.stats(sel, s5));
  });

  /* 末端追单：旧模型信号里有多少落在「30m 强趋势」上，以及它们的后续表现 */
  console.log('\n  旧模型信号的 30m 环境分布（追单检测）：');
  const oldEnv = { endChase: [], other: [] };
  oldTrades.forEach(t => {
    const j30 = B.m30[t.i];
    if (j30 < 0) return;
    const st30 = B.v30.stt[j30];
    const strong = st30 === V.ST.STRONG_BULL || st30 === V.ST.STRONG_BEAR;
    const aligned = (t.dir === 'long' && (st30 === V.ST.STRONG_BULL || st30 === V.ST.BULL))
      || (t.dir === 'short' && (st30 === V.ST.STRONG_BEAR || st30 === V.ST.BEAR));
    (strong && aligned ? oldEnv.endChase : oldEnv.other).push(t);
  });
  [['追在 30m 强趋势末端', oldEnv.endChase], ['其余', oldEnv.other]].forEach(([nm, arr]) => {
    if (!arr.length) { console.log(`    ${pad(nm, 20)} 0 笔`); return; }
    const st = V.stats(arr, s5);
    console.log(`    ${pad(nm, 20)} ${pad(arr.length, 6)} 胜率 ${(st.winRate * 100).toFixed(1)}% · 期望 ${num(st.avgR, 3)}R · t ${num(st.t, 2)} · MAE ${num(st.avgMaeR, 2)}R`);
  });
  const cr = oldEnv.endChase.length + oldEnv.other.length;
  console.log(`    末端追单占比 ${(cr ? oldEnv.endChase.length / cr * 100 : 0).toFixed(1)}%`);

  /* 时效性：v2.1 相对旧模型提前多少 */
  const lead = V.leadStats(pick.sig, oldTrig, 96);
  console.log(`\n  时效性：v2.1 覆盖了旧模型 ${(lead.coverRate * 100).toFixed(1)}% 的信号（${lead.covered}/${lead.oldCount}），平均提前 ${lead.avgLeadBars.toFixed(1)} 根 5m = ${lead.avgLeadMin.toFixed(0)} 分钟`);
  const lead2 = V.leadStats(oldTrig, pick.sig, 96);
  console.log(`          反向：旧模型覆盖了 v2.1 ${(lead2.coverRate * 100).toFixed(1)}% 的信号（v2.1 独有的信号 ${pick.sig.length - lead2.covered} 个）`);

  /* ---------- ④ 5m 结构链对比 ---------- */
  console.log('\n【阶段 ④】5m 结构链：只有 CHOCH / CHOCH+Retest / 完整三段（统一 60）');
  line('结构链', '笔数', '胜率', '期望R', 't值', 'PF', '最大DD', '平均持仓');
  console.log('  ' + '-'.repeat(80));
  [['只有 CHOCH', 'choch'], ['CHOCH+Retest', 'choch-rt'], ['完整三段', 'full'], ['v2.1 Gate(CHOCH∧(R∨B))', 'gate']].forEach(([nm, ch]) => {
    const sig = V.findSignals(s5, B, { chain: ch, thrOverride: 60 });
    const sim = V.simulate(s5, sig, B, {});
    row(nm, V.stats(sim.trades, s5));
  });

  /* 假信号比例 */
  const cs = V.chainStats(B.ms);
  console.log(`\n  5m 结构链失败率：CHOCH ${cs.choch} 次 → Retest ${cs.retest}（失败 ${(cs.retestFail * 100).toFixed(1)}%）→ BOS ${cs.bos}（Retest 后失败 ${(cs.bosFail * 100).toFixed(1)}%）`);
  console.log(`  CHOCH 走到 BOS 的整体失败率 ${(cs.chochBosFail * 100).toFixed(1)}%`);

  /* ---------- ⑤ 阈值扫描 ---------- */
  console.log('\n【阶段 ⑤】总分门槛扫描（§14.6「最后才优化阈值」）');
  line('门槛', '笔数', '胜率', '期望R', 't值', 'PF', '最大DD', '年化');
  console.log('  ' + '-'.repeat(80));
  [50, 55, 60, 65, 70, 75, 80].forEach(th => {
    const sig = V.findSignals(s5, B, { thrOverride: th });
    const sim = V.simulate(s5, sig, B, {});
    const st = V.stats(sim.trades, s5);
    line(String(th), st.count, (st.winRate * 100).toFixed(1) + '%', num(st.avgR, 3), num(st.t, 2),
      num(st.profitFactor, 2), (st.maxDD * 100).toFixed(1) + '%', (st.annRet * 100).toFixed(1) + '%');
  });

  console.log(`\n（样本跨度 ${spanDays.toFixed(0)} 天；手续费按市价 Taker 单边 0.1% 计入）`);
})().catch(e => { console.error(e); process.exit(1); });
