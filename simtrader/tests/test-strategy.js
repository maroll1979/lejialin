/* 开单逻辑 / 回测引擎测试
   核心：流式信号引擎必须与 app.js 的 computeSignal 同口径，
        否则回测出来的东西跟看板实盘不是一套逻辑，结论就是假的。
   需联网（拉真实 Gate K线）。若只走代理：NODE_USE_ENV_PROXY=1 node test-strategy.js */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'simtrader');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  — ' + extra : '')); }
}
function head(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }

/* ---------- 从 app.js 抽出「真实」指标与信号函数，作为对照基准 ---------- */
function loadAppSignalCore() {
  const src = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
  const a = src.indexOf('/* ---------- 技术指标 ---------- */');
  const b = src.indexOf('const SIG_COLOR = {');
  if (a < 0 || b < 0) throw new Error('无法在 app.js 中定位指标段');
  const code = src.slice(a, b);
  /* 只取指标段：computeSignal 依赖的 ema/macd/rsi/bollExt/kdj/obv/obvDivergence/clampN 都在其中。
     atr() 定义在 app.js 更后面（止盈止损段），这里用不到，不要一起抽。 */
  const fn = new Function(code + '\n return { computeSignal: computeSignal };');
  return fn();
}

(async () => {
  const core = loadAppSignalCore();
  const S = require(path.join(DIR, 'strategy.js'));

  head('1. 模块加载');
  ok(typeof S.SignalStream === 'function', 'SignalStream 可用');
  ok(typeof S.dirSeries === 'function' && typeof S.findTriggers === 'function', 'dirSeries / findTriggers 可用');
  ok(typeof core.computeSignal === 'function', '已从 app.js 抽出 computeSignal 作为基准');

  head('2. 拉真实 5m K线（BTC，约 6000 根）');
  const now = Math.floor(Date.now() / 1000);
  const to = Math.floor(now / 300) * 300;
  const rows = [];
  for (let k = 0; k < 3; k++) {
    /* 网络抖动会偶发超时（2000 根一段约 3~6s，拥塞时可达 20s+），重试 3 次再判失败 */
    let seg = null;
    for (let a = 0; a < 3 && !seg; a++) {
      try { seg = await S.fetchSeg('BTC_USDT', '5m', to - (k + 1) * 2000 * 300, to - k * 2000 * 300 - 1, 30000); }
      catch (e) { if (a === 2) throw e; await new Promise(r => setTimeout(r, 1500)); }
    }
    rows.unshift(...seg);
  }
  const map = new Map();
  rows.forEach(r => { if (r.time > 0 && r.close > 0) map.set(r.time, r); });
  const candles = Array.from(map.values()).sort((x, y) => x.time - y.time);
  ok(candles.length > 4000, '拿到足够样本', candles.length + ' 根');

  head('3. 流式引擎 vs computeSignal 逐根对照（实盘语义 = 最近 200 根窗口）');
  const s = S.toSeries(candles);
  const st = new S.SignalStream();
  const streamDir = [], streamScore = [], streamFac = [];
  for (let i = 0; i < s.n; i++) {
    const r = st.push(s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]);
    streamDir.push(r.dir); streamScore.push(r.score); streamFac.push(r.f);
  }
  /* 对照窗口：只取最后 600 根逐点重算（每点一次 O(200) 重算，全量太慢） */
  const CHECK = 600;
  const start = s.n - CHECK;
  const FAC = ['trend', 'macd', 'adx', 'rsi', 'kdj', 'boll', 'obv', 'vol'];
  const maxDev = {}; FAC.forEach(k => { maxDev[k] = 0; });
  let same = 0, diff = 0, scoreMaxDev = 0, signFlip = 0;
  for (let i = start; i < s.n; i++) {
    const win = candles.slice(Math.max(0, i - 199), i + 1);
    const ref = core.computeSignal(win);
    const rd = ref ? ref.dir : 'wait';
    if (rd === streamDir[i]) same++; else diff++;
    if (ref) {
      scoreMaxDev = Math.max(scoreMaxDev, Math.abs(ref.score - streamScore[i]));
      FAC.forEach(k => {
        const d = Math.abs(ref.fac[k] - streamFac[i][k]);
        if (d > maxDev[k]) maxDev[k] = d;
        /* 因子数值接近零时不追究符号，其余情况符号必须一致 */
        if (Math.abs(ref.fac[k]) > 0.05 && Math.sign(ref.fac[k]) !== Math.sign(streamFac[i][k])) signFlip++;
      });
    }
  }
  const rate = same / (same + diff);
  const worst = FAC.map(k => [k, maxDev[k]]).sort((a, b) => b[1] - a[1])[0];
  console.log(`     方向一致 ${same} / 不一致 ${diff} → 一致率 ${(rate * 100).toFixed(2)}% · 分数最大偏差 ${scoreMaxDev.toFixed(4)}`);
  console.log('     各因子最大偏差：' + FAC.map(k => `${k} ${maxDev[k].toFixed(4)}`).join(' · '));
  ok(rate >= 0.97, '方向一致率 ≥ 97%（回测口径 = 实盘口径）', (rate * 100).toFixed(2) + '%');
  ok(scoreMaxDev < 0.06, '八因子综合分数最大偏差 < 0.06', scoreMaxDev.toFixed(4));
  ok(worst[1] < 0.02, '逐因子最大偏差 < 0.02（八因子与实盘逐字同式）', `最差 ${worst[0]} ${worst[1].toFixed(4)}`);
  ok(signFlip === 0, '八因子符号全部一致（方向不发生翻转）', signFlip + ' 处翻转');
  ok(FAC.every(k => typeof core.computeSignal(candles.slice(-200)).fac[k] === 'number'),
    'app.js computeSignal 暴露八因子原值（fac）供对照');

  head('4. OBV 窗口化生效（不随样本长度漂移）');
  /* 同一段末尾，用「短样本」与「长样本」分别跑流式，末尾方向必须一致 ——
     若 OBV 是全历史累加，末尾 obv 会差出数量级，方向会变。 */
  const shortStart = s.n - 1500;
  const st2 = new S.SignalStream();
  for (let i = shortStart; i < s.n; i++) st2.push(s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]);
  ok(st2.dir === st.dir, '长短样本末尾方向一致（OBV 已窗口化）', `长=${st.dir} 短=${st2.dir}`);

  head('5. 聚合：5m → 15m / 1h 与真实周期一致');
  const s15 = S.aggregate(s, 900), s1h = S.aggregate(s, 3600);
  ok(s15.n > 0 && Math.abs(s15.n - s.n / 3) < 5, '15m 根数 ≈ 5m/3', `${s15.n} vs ${Math.round(s.n / 3)}`);
  ok(s1h.n > 0 && Math.abs(s1h.n - s.n / 12) < 5, '1h 根数 ≈ 5m/12', `${s1h.n} vs ${Math.round(s.n / 12)}`);
  ok(s15.t[0] % 900 === 0 && s1h.t[0] % 3600 === 0, '聚合时间戳对齐到周期起点');
  /* 与 Gate 直接返回的 1h 对比。最后一根是「进行中」的，两次请求之间价格会变，
     故只比已闭合的（倒数第 2 根往前）。 */
  const real1h = (await S.fetchSeg('BTC_USDT', '1h', s1h.t[s1h.n - 7], to, 20000)).slice(0, -1);
  let aggOk = 0;
  real1h.forEach(r => {
    const k = Array.prototype.indexOf.call(s1h.t, r.time);
    if (k >= 0 && Math.abs(s1h.c[k] - r.close) < 1e-6 && Math.abs(s1h.h[k] - r.high) < 1e-6 && Math.abs(s1h.l[k] - r.low) < 1e-6) aggOk++;
  });
  ok(aggOk === real1h.length, '聚合出的 1h 与 Gate 真实 1h 完全一致（已闭合部分）', aggOk + '/' + real1h.length);

  head('6. 共振沿触发逻辑（构造用例）');
  const T = S.triggerAt;
  ok(T(1, 1, 1, 1, 1, 0) === 1, '1h多 + 15m已多 + 5m刚转多 → 买入');
  ok(T(1, 1, 1, 1, 0, 1) === 1, '1h多 + 15m刚转多 + 5m已多 → 买入');
  ok(T(1, 1, 1, 1, 1, 1) === 0, '三者早已同向 → 不重复报警');
  ok(T(1, 1, 1, 0, 1, 1) === 0, '15m/5m 未翻转（只是 1h 刚变）→ 不触发');
  ok(T(0, 1, 1, 0, 0, 0) === 0, '1h 无方向 → 不开仓');
  ok(T(1, 0, 1, 1, 0, 0) === 0, '15m 未同向（观望）→ 不触发');
  ok(T(1, 2, 1, 1, 2, 0) === 0, '15m 反向 → 不触发');
  ok(T(2, 2, 2, 2, 2, 1) === 2, '1h空 + 5m刚转空 → 卖出');
  ok(T(2, 2, 2, 2, 0, 2) === 2, '1h空 + 15m刚转空 → 卖出');
  ok(T(1, 1, 0, 1, 1, 2) === 0, '5m 反向 → 不触发');

  head('7. 在真实序列上跑共振沿');
  const r5 = S.dirSeries(s), r15 = S.dirSeries(s15), r1h = S.dirSeries(s1h);
  const m15 = S.buildMap(s.t, s15.t), m1h = S.buildMap(s.t, s1h.t);
  const trig = S.findTriggers(r5.dirs, r15.dirs, r1h.dirs, m15, m1h);
  ok(Array.isArray(trig), '触发点数组可用');
  console.log(`     ${s.n} 根 5m 上共触发 ${trig.length} 次（约 ${((s.n * 5) / 60 / 24).toFixed(0)} 天）`);
  ok(trig.length > 0, '真实数据上能触发（说明逻辑不是死条件）', trig.length + ' 次');
  /* 每个触发点都应满足「三周期同向 + 至少一个刚翻转」 */
  let bad = 0;
  trig.forEach(tg => {
    const j15 = m15[tg.i], j1h = m1h[tg.i];
    const d = tg.dir === 'long' ? 1 : 2;
    if (r1h.dirs[j1h] !== d || r15.dirs[j15] !== d || r5.dirs[tg.i] !== d) bad++;
    if (r15.dirs[j15 - 1] === d && r5.dirs[tg.i - 1] === d) bad++;   // 两者都没翻转
  });
  ok(bad === 0, '所有触发点都满足严格共振沿定义', bad === 0 ? '0 个违规' : bad + ' 个违规');

  head('7b. 已收线映射（回测必须无未来函数）');
  const mc15 = S.buildClosedMap(s.t, s15.t, 300, 900);
  const mc1h = S.buildClosedMap(s.t, s1h.t, 300, 3600);
  /* 严格因果性：映射到的那根粗 K 线，必须在当前 5m 收盘前就已经走完 */
  let fut = 0, sample = 0;
  for (let i = 200; i < s.n; i += 7) {
    sample++;
    const a = mc15[i]; if (a >= 0 && s15.t[a] + 900 > s.t[i] + 300) fut++;
    const b = mc1h[i]; if (b >= 0 && s1h.t[b] + 3600 > s.t[i] + 300) fut++;
  }
  ok(fut === 0, '映射到的 15m/1h 均已收线（无未来函数）', `${sample} 个抽样点，${fut} 个违规`);
  /* 对照：buildMap（实盘口径）确实会给出未收线的那根 —— 证明两者不同 */
  const mb1h = S.buildMap(s.t, s1h.t);
  let openCnt = 0;
  for (let i = 200; i < s.n; i += 7) { const b = mb1h[i]; if (b >= 0 && s1h.t[b] + 3600 > s.t[i] + 300) openCnt++; }
  ok(openCnt > 0, '对照：buildMap 确实包含未收线的进行中 K线（故只用于实盘）', `${openCnt}/${sample} 根进行中`);
  /* 单调不减 */
  let mono = true;
  for (let i = 1; i < s.n; i++) if (mc1h[i] < mc1h[i - 1] || mc15[i] < mc15[i - 1]) { mono = false; break; }
  ok(mono, '已收线映射单调不减');

  const trigC = S.findTriggersClosed(r5.dirs, r15.dirs, r1h.dirs, mc15, mc1h);
  ok(trigC.length > 0, '已收线口径在真实数据上能触发', trigC.length + ' 次');
  /* 每个触发点：当前三周期同向；前一根 5m 不满足（保证一次共振只响一次） */
  const alignedAt = i => {
    const a = mc1h[i] >= 0 ? r1h.dirs[mc1h[i]] : 0;
    return a !== 0 && mc15[i] >= 0 && r15.dirs[mc15[i]] === a && r5.dirs[i] === a;
  };
  let badC = 0;
  trigC.forEach(tg => {
    if (!alignedAt(tg.i)) badC++;
    if (alignedAt(tg.i - 1)) badC++;                       // 上一根就已共振 → 重复报警
    const a = r1h.dirs[mc1h[tg.i]];
    if ((tg.dir === 'long' ? 1 : 2) !== a) badC++;         // 方向必须与 1h 一致
  });
  ok(badC === 0, '触发点均为「未共振 → 共振」跃变，且不重复', badC === 0 ? '0 个违规' : badC + ' 个违规');
  let gapBad = 0;
  for (let k = 1; k < trigC.length; k++) if (trigC[k].i <= trigC[k - 1].i) gapBad++;
  ok(gapBad === 0, '触发点严格递增（不会同根连发）');

  head('8. 回测（用本段数据跑一遍全链路）');
  const res = S.backtestCore(s, { tpslFn: S.defaultTpsl, maxHold: 2016 });
  ok(res.count >= 0 && typeof res.winRate === 'number', '回测产出统计', `${res.count} 笔 · 胜率 ${(res.winRate * 100).toFixed(1)}%`);
  ok(res.trades.every(t => t.how && isFinite(t.r)), '每笔都有出场方式与 R 倍数');
  ok(res.trades.every(t => t.entry > 0 && t.stop > 0), '每笔都有入场价与止损价');
  console.log(`     区间 ${new Date(res.from * 1000).toISOString().slice(0, 10)} → ${new Date(res.to * 1000).toISOString().slice(0, 10)}` +
    ` · 累计 ${res.totalR.toFixed(1)}R · 最大回撤 ${(res.maxDD * 100).toFixed(1)}% · 平均持仓 ${res.avgHoldHours.toFixed(1)} 小时`);
  /* 止损距离必须为正且方向正确 */
  let stopBad = 0;
  res.trades.forEach(t => {
    if (t.dir === 'long' && !(t.stop < t.entry && t.tp1 > t.entry)) stopBad++;
    if (t.dir === 'short' && !(t.stop > t.entry && t.tp1 < t.entry)) stopBad++;
  });
  ok(stopBad === 0, '多空止损/止盈方向正确', stopBad === 0 ? '0 个异常' : stopBad + ' 个异常');

  head('9. 分页拉取（from/to 分段）');
  const h = await S.fetchHistory('BTCUSDT', '1h', 1, { concurrency: 6 });
  ok(h.rows.length > 8000, '1 年 1h K线 ≥ 8000 根', h.rows.length + ' 根');
  ok(h.segFailed === 0, '无失败分段', h.segFailed + '/' + h.segTotal);
  ok(h.rows.every((r, i) => i === 0 || r.time > h.rows[i - 1].time), '升序且无重复');

  head('10. 时间对齐');
  ok(S.alignTime(1790258700, '5m') === 1790258700 - 1790258700 % 300, '对齐到 5m');
  ok(S.alignTime(1790258700, '1h') % 3600 === 0, '对齐到 1h');

  /* ============================================================
     11. 第 6 节 · 5m 市场结构触发（0–25 分）
     ============================================================ */
  head('11. 市场结构触发：构造用例（多空对称）');
  function mk(seq) {                     // seq: [[方向, 根数, 每根幅度], ...]
    const out = []; let t = 0, p = seq.start;
    for (const it of seq.legs) {
      for (let i = 0; i < it[1]; i++) {
        const o = p, cl = p + it[2];
        out.push({ time: t, open: o, high: Math.max(o, cl) + 0.25, low: Math.min(o, cl) - 0.25, close: cl, volume: 1 });
        p = cl; t += 300;
      }
    }
    return out;
  }
  /* 上涨到顶 → 下跌 → 反弹(LH1) → 再跌 → 反弹(LH2 更低) → 再跌 → 突破 LH2 → 回踩 → 破新高 */
  const bull = mk({ start: 60, legs: [[0, 20, 1.0], [0, 10, -1.0], [0, 8, 1.0], [0, 10, -1.0], [0, 7, 1.0], [0, 8, -1.0], [0, 5, 1.0], [0, 4, -0.9], [0, 6, 1.0]] });
  const rb = S.msReplay(bull);
  const evB = [], evLB = [];
  for (let i = 0; i < rb.n; i++) { if (rb.ev[i]) evB.push(i); if (rb.evL[i]) evLB.push(i); }
  ok(evB.length >= 1, '多头构造序列出现严格档触发（CHOCH+回踩+BOS）', `第 ${evB.join(',')} 根`);
  ok(evLB.length >= 1, '多头构造序列出现宽松档触发（核心≥2，即回踩成立那根）', `第 ${evLB.join(',')} 根`);
  ok(evLB.length && evB.length && evLB[0] < evB[0], '宽松档早于严格档（回踩 → BOS）', `${evLB[0]} < ${evB[0]}`);

  /* 空头：把价格沿常数镜像（x → 200 − x），事件方向应互换 */
  const bear = bull.map(c => ({ time: c.time, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close, volume: 1 }));
  const rs = S.msReplay(bear);
  let mirrorBad = 0, mirrorN = 0;
  for (let i = 0; i < rb.n; i++) {
    const a = rb.ev[i] ? (rb.ev[i] === 1 ? 1 : 2) : 0;
    const b = rs.ev[i] ? (rs.ev[i] === 1 ? 2 : 1) : 0;   // 镜像后多空互换
    if (a || b) mirrorN++;
    if (a !== b) mirrorBad++;
  }
  ok(mirrorN > 0 && mirrorBad === 0, '多空完全对称（价格镜像后触发方向互换）', `${mirrorN} 个事件，${mirrorBad} 个不对称`);

  head('12. 结构分值范围与核心条件蕴含关系（真实 6000 根）');
  const ms = S.msSeries(s);
  let rangeBad = 0, coreBad = 0, looseBad = 0, maxSeen = 0;
  for (let i = 0; i < ms.n; i++) {
    const L = ms.lsc[i], Sh = ms.ssc[i];
    maxSeen = Math.max(maxSeen, L, Sh);
    if (!(L >= 0 && L <= S.MS_SCORE_MAX) || !(Sh >= 0 && Sh <= S.MS_SCORE_MAX)) rangeBad++;
    if (ms.ev[i]) {
      const c = ms.ev[i] === 1 ? ms.lcore[i] : ms.score_side[i];
      if (c < 3) coreBad++;
    }
    const c2 = ms.evL[i] === 1 ? ms.lcore[i] : ms.evL[i] === 2 ? ms.score_side[i] : 0;
    if (ms.evL[i] && c2 < 2) looseBad++;
  }
  ok(rangeBad === 0, `结构总分恒在 0–${S.MS_SCORE_MAX} 之间`, `最大 ${maxSeen.toFixed(1)}`);
  ok(coreBad === 0, '严格档触发 ⇒ 三个核心条件齐备（CHOCH+Retest+BOS）', `${coreBad} 个例外`);
  ok(looseBad === 0, '宽松档触发 ⇒ 核心条件 ≥ 2', `${looseBad} 个例外`);

  head('13. 无未来函数：改动第 m 根之后的数据，第 m 根之前必须完全不变');
  const m = Math.floor(s.n * 0.7);
  const s2 = { n: s.n, t: s.t, o: Float64Array.from(s.o), h: Float64Array.from(s.h), l: Float64Array.from(s.l), c: Float64Array.from(s.c), v: s.v };
  for (let i = m; i < s2.n; i++) { s2.o[i] *= 1.37; s2.h[i] *= 1.37; s2.l[i] *= 1.37; s2.c[i] *= 1.37; }
  const ms2 = S.msSeries(s2);
  let leak = 0, leakSc = 0;
  for (let i = 0; i < m; i++) {
    if (ms.ev[i] !== ms2.ev[i] || ms.evL[i] !== ms2.evL[i]) leak++;
    if (Math.abs(ms.lsc[i] - ms2.lsc[i]) > 1e-9 || Math.abs(ms.ssc[i] - ms2.ssc[i]) > 1e-9) leakSc++;
  }
  ok(leak === 0 && leakSc === 0, '前 70% 的结构事件与分值不受后 30% 数据影响',
    `事件泄漏 ${leak} · 分值泄漏 ${leakSc}`);

  head('14. 实盘口径一致：窗口重放 vs 全量流式');
  /* 看板拿到的是最近 200 根 5m，用 msReplay 冷启动重放；回测是全程连续流式。
     两者必须收敛到同一状态，否则「回测结论」和「实盘报警」不是一回事。 */
  const WIN = 200, WARM = 60;
  const win = [];
  for (let i = Math.max(0, s.n - WIN); i < s.n; i++) win.push({ time: s.t[i], open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i], volume: s.v[i] });
  const rw = S.msReplay(win);
  const off = s.n - win.length;
  let evDiff = 0, scDiff = 0, cmpN = 0, maxSc = 0;
  for (let k = WARM; k < rw.n; k++) {
    const i = off + k;
    cmpN++;
    if (rw.ev[k] !== ms.ev[i] || rw.evL[k] !== ms.evL[i]) evDiff++;
    const d = Math.max(Math.abs(rw.lsc[k] - ms.lsc[i]), Math.abs(rw.ssc[k] - ms.ssc[i]));
    if (d > maxSc) maxSc = d;
    if (d > 1) scDiff++;
  }
  const agree = (1 - evDiff / cmpN) * 100;
  ok(agree >= 99.5, `窗口重放与全量流式的方向一致率 ≥ 99.5%`, agree.toFixed(2) + '%');
  ok(maxSc < 0.5, `结构分最大偏差 < 0.5（预热 ${WARM} 根后）`, maxSc.toFixed(2));

  head('15. app.js 接入点（第 6 节）');
  const appSrc2 = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  ok(/function renderMsPanel\(\)/.test(appSrc2), '看板含 5m 市场结构面板渲染函数');
  ok(/id="msPanel"/.test(htmlSrc), 'index.html 含结构面板容器');
  ok(/st\.msReplay\(c5\)/.test(appSrc2), '状态条用真实 5m K线重放结构');
  ok(/st\.findTriggersMs\(/.test(appSrc2), '触发点来自 findTriggersMs（结构扳机）');
  ok(/msOpts\(\)/.test(appSrc2) && /msMode|msMin|msAnd/.test(appSrc2), '档位 / 最低结构分 / AND 叠加可调');
  ok(!/15m 与 5m 共振同向/.test(appSrc2), '已无「15m 与 5m 共振同向」旧口径报警文案');
  ok(/ms: msOpts\(\)/.test(appSrc2), '回测按钮把结构参数传给回测引擎');
  ok(/严格档/.test(htmlSrc) && /宽松档/.test(htmlSrc) && /CHOCH/.test(htmlSrc) && /Retest/.test(htmlSrc),
    'index.html 已写明严格档 / 宽松档 / CHOCH / Retest 口径');

  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
