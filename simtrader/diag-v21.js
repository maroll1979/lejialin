/* v2.1 分层评分诊断：分值分布 / Gate 各条件命中率 / 总分分布 */
const S = require('./strategy.js');
const V = require('./v21.js');
const cache = require('./fetch-cache.js');

const sym = process.argv[2] || 'BTCUSDT';
const years = Number(process.argv[3] || 5);

(async () => {
  const rows = await cache.get(sym, years);
  const s5 = S.toSeries(rows);
  const t0 = Date.now();
  const B = V.build(s5, { live: false });
  console.log(`build ${((Date.now() - t0) / 1000).toFixed(1)}s · 5m ${s5.n} / 15m ${B.s15.n} / 30m ${B.s30.n} / 1h ${B.s1h.n} / 4h ${B.s4h.n}`);

  function mm(a, label, cap) {
    let mx = 0, su = 0, c = 0, hi = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v > mx) mx = v; su += v; c++; if (v >= cap * 0.6) hi++; }
    console.log(`  ${label.padEnd(10)} max ${mx.toFixed(2).padStart(6)} · avg ${(su / c).toFixed(2).padStart(6)} (${(su / c / cap * 100).toFixed(0)}% of ${cap}) · ≥60% ${(hi / c * 100).toFixed(1)}%`);
  }
  console.log('\n== 各层分值 ==');
  mm(B.v1h.tL, '1H tL', 20); mm(B.v1h.tS, '1H tS', 20);
  mm(B.v30.rL, '30m rL', 25); mm(B.v30.rS, '30m rS', 25);
  mm(B.v15.uL, '15m uL', 30); mm(B.v15.uS, '15m uS', 30);
  mm(B.ms.lsc, '5m lsc', 25); mm(B.ms.ssc, '5m ssc', 25);

  /* 4H regime 分布 */
  const regC = [0, 0, 0];
  for (let i = 0; i < B.v4h.reg.length; i++) regC[B.v4h.reg[i] + 1]++;
  console.log(`\n== 4H Regime ==  Bear ${(regC[0] / B.v4h.n * 100).toFixed(1)}%  Range ${(regC[1] / B.v4h.n * 100).toFixed(1)}%  Bull ${(regC[2] / B.v4h.n * 100).toFixed(1)}%`);

  /* 30m 状态机分布 */
  const stC = {};
  for (let i = 0; i < B.v30.stt.length; i++) { const k = B.v30.stt[i]; stC[k] = (stC[k] || 0) + 1; }
  console.log('== 30m 状态机 ==');
  Object.keys(stC).sort((a, b) => a - b).forEach(k => {
    console.log(`  ${V.ST_NAME[k].padEnd(18)} ${(stC[k] / B.v30.n * 100).toFixed(1)}%`);
  });

  /* Gate 各条件命中率 + 总分分布 */
  const P = {};
  let nOk = 0, cSetup = 0, cChain = 0, cNotStrong = 0, cExh = 0, cChase = 0, cGate = 0;
  let sSetup = 0, sChain = 0, sNotStrong = 0, sExh = 0, sChase = 0, sGate = 0;
  const hist = new Array(11).fill(0);
  let maxL = 0, maxS = 0;
  const gateHist = new Array(11).fill(0);
  for (let i = 1; i < s5.n; i++) {
    const j15 = B.m15[i], j30 = B.m30[i], j1h = B.m1h[i], j4h = B.m4h[i];
    if (j15 < 0 || j30 < 0 || j1h < 0 || j4h < 0) continue;
    nOk++;
    P.tL = B.v1h.tL[j1h]; P.tS = B.v1h.tS[j1h];
    P.rL = B.v30.rL[j30]; P.rS = B.v30.rS[j30];
    P.st1 = B.v1h.stt[j1h]; P.st30 = B.v30.stt[j30];
    P.uL = B.v15.uL[j15]; P.uS = B.v15.uS[j15];
    P.reg = B.v4h.reg[j4h];
    P.trigL = B.ms.lsc[i]; P.trigS = B.ms.ssc[i];
    P.lsf = B.ms.lsf[i]; P.ssf = B.ms.ssf[i];
    P.lLvl = B.ms.llv[i]; P.sLvl = B.ms.slv[i];
    P.c5 = s5.c[i]; P.atr5 = B.ms.atr[i];
    const d = V.decideAt(P, {});
    if (d.longScore > maxL) maxL = d.longScore;
    if (d.shortScore > maxS) maxS = d.shortScore;
    hist[Math.min(10, Math.floor(d.longScore / 10))]++;
    if (d.g.setup) cSetup++; if (d.g.chain) cChain++; if (d.g.notStrong) cNotStrong++;
    if (d.g.needExh) cExh++; if (d.g.noChase) cChase++; if (d.lGate) cGate++;
    if (d.gs.setup) sSetup++; if (d.gs.chain) sChain++; if (d.gs.notStrong) sNotStrong++;
    if (d.gs.needExh) sExh++; if (d.gs.noChase) sChase++; if (d.sGate) sGate++;
    if (d.lGate) gateHist[Math.min(10, Math.floor(d.longScore / 10))]++;
  }
  const pct = x => (x / nOk * 100).toFixed(3) + '%';
  console.log(`\n== Long Gate 逐条命中率（样本 ${nOk} 根） ==`);
  console.log(`  15m Setup≥18   ${pct(cSetup)}`);
  console.log(`  5m CHOCH链     ${pct(cChain)}`);
  console.log(`  1H 非Strong加速 ${pct(cNotStrong)}`);
  console.log(`  30m 衰竭要求   ${pct(cExh)}`);
  console.log(`  不追价         ${pct(cChase)}`);
  console.log(`  >>> Gate 全过  ${pct(cGate)}   (Short ${pct(sGate)})`);
  console.log(`\n== LongScore 分布 (max ${maxL.toFixed(1)} / Short max ${maxS.toFixed(1)}) ==`);
  hist.forEach((v, k) => {
    const bar = '#'.repeat(Math.round(v / nOk * 60));
    console.log(`  ${String(k * 10).padStart(3)}-${String(k * 10 + 9).padStart(3)}  ${(v / nOk * 100).toFixed(2).padStart(6)}%  ${bar}`);
  });
  console.log('\n== Gate 已过时的 LongScore 分布 ==');
  gateHist.forEach((v, k) => { if (v) console.log(`  ${String(k * 10).padStart(3)}-${String(k * 10 + 9).padStart(3)}  ${v} 根`); });

  const sig = V.findSignals(s5, B, {});
  console.log(`\n== 信号 == ${sig.length} 个（严格阈值 70/75/85）`);
  ['choch', 'choch-rt', 'full'].forEach(ch => {
    const g = V.findSignals(s5, B, { chain: ch });
    console.log(`  chain=${ch.padEnd(9)} ${g.length}`);
  });
  [50, 55, 60, 65, 70, 75, 80, 85].forEach(th => {
    const g = V.findSignals(s5, B, { thrOverride: th });
    console.log(`  thrOverride=${th} → ${g.length}`);
  });
  const cs = V.chainStats(B.ms);
  console.log('\n== 5m 结构链 == ' + JSON.stringify(cs));
})().catch(e => { console.error(e); process.exit(1); });
