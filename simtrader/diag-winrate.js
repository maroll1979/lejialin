/* ============================================================
   胜率诊断：把「5 年回测胜率不到 40%」拆成几个可归因的来源

   四组对照，共用同一套 TP/SL 与出场规则（1.8×ATR 止损，TP1=1R 减半，TP2=2R，7 天超时）：
     ① 实际信号            —— 现状
     ② 同时刻 · 随机方向      —— 分离「择时」有没有价值（入场点本身是否特殊）
     ③ 完全随机时刻 + 随机方向 —— 裸基线：什么都不做，随机撞，期望是多少
     ④ fee / risk 倍数扫描    —— 分离「交易成本」与「止损宽度」各吃掉多少

   另外单独看：
     · 毛利胜率 vs 净利胜率之差（有多少笔「方向是对的，被手续费打成正转负」）
     · 出场结构（止损 / TP1后止损 / TP2 / 超时）
     · MFE：入场后最大有利偏移，看 alpha 是不是被出场规则浪费掉

   用法：node diag-winrate.js [SYMBOL]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./strategy.js');

const sym = process.argv[2] || 'BTCUSDT';
const CACHE = path.join(__dirname, 'data', 'bt_' + sym + '_5y_5m.json');
const FEE = 0.001;                 // 市价 Taker
const MAXHOLD = 2016;              // 7 天

function load() {
  if (!fs.existsSync(CACHE)) { console.error('缺缓存 ' + CACHE + '，先跑 run-bt5y.js'); process.exit(1); }
  return JSON.parse(fs.readFileSync(CACHE, 'utf8')).rows;
}

const pct = v => (v * 100).toFixed(1) + '%';
const num = (v, d) => (v == null || !isFinite(v)) ? '-' : v.toFixed(d);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function stdev(a) {
  if (a.length < 2) return 0;
  const m = avg(a); const s = a.reduce((x, y) => x + (y - m) * (y - m), 0);
  return Math.sqrt(s / (a.length - 1));
}
const tstat = a => (a.length && stdev(a) > 0) ? avg(a) / (stdev(a) / Math.sqrt(a.length)) : 0;

/* ---------- 单笔模拟：给定入场 index 与强制方向（null=用信号方向） ---------- */
function sim(s5, s1h, m1h, i, forceDir, riskMul, feeRate, wantExcursion, mode) {
  mode = mode || 'p1';                               // p1=TP1减半 / full2=全仓到2R / p05=TP1@0.5R减半
  if (i + 1 >= s5.n) return null;
  const entry = s5.o[i + 1];
  if (!(entry > 0)) return null;
  const j1h = m1h[i];
  if (j1h < 30) return null;
  const plan = S.defaultTpsl(S.tailObjects(s1h, j1h, 300), '1h', s5.c[i]);
  if (!plan) return null;
  const dir = forceDir || 'long';
  const side = dir === 'long' ? plan.long : plan.short;
  if (!side || !(side.risk > 0)) return null;
  const risk = side.risk * riskMul;
  const stop = dir === 'long' ? entry - risk : entry + risk;
  const tp1d = mode === 'p05' ? 0.5 : 1;
  const tp1 = dir === 'long' ? entry + tp1d * risk : entry - tp1d * risk;
  const tp2 = dir === 'long' ? entry + 2 * risk : entry - 2 * risk;
  const sign = dir === 'long' ? 1 : -1;
  const relRisk = Math.abs(entry - stop);
  if (!(relRisk > 0)) return null;

  let exitPx = null, how = '', hold = 0, done1 = false, r1 = tp1;
  let mfe = 0, mae = 0;
  const end = Math.min(s5.n - 1, i + MAXHOLD);
  for (let j = i + 1; j <= end; j++) {
    const favPx = dir === 'long' ? s5.h[j] : s5.l[j];   // 有利方向极值
    const advPx = dir === 'long' ? s5.l[j] : s5.h[j];   // 不利方向极值
    if (wantExcursion) {
      mfe = Math.max(mfe, (favPx - entry) * sign);
      mae = Math.min(mae, (advPx - entry) * sign);
    }
    const hitStop = dir === 'long' ? (s5.l[j] <= stop) : (s5.h[j] >= stop);
    const hitTp1 = dir === 'long' ? (s5.h[j] >= tp1) : (s5.l[j] <= tp1);
    const hitTp2 = dir === 'long' ? (s5.h[j] >= tp2) : (s5.l[j] <= tp2);
    if (hitStop) {
      exitPx = dir === 'long' ? Math.min(stop, s5.o[j]) : Math.max(stop, s5.o[j]);
      how = done1 ? '止损(半仓)' : '止损'; hold = j - i - 1; break;
    }
    if (!done1 && mode !== 'full2' && hitTp1) { done1 = true; r1 = tp1; }
    if (mode === 'full2' ? hitTp2 : (done1 && hitTp2)) {
      exitPx = tp2; how = '止盈2R'; hold = j - i - 1; break;
    }
    if (j === end) { exitPx = s5.c[j]; how = '超时'; hold = j - i - 1; break; }
  }
  if (exitPx == null) return null;

  let gross, fee;
  if (how === '止损' || how === '超时') { gross = (exitPx - entry) * sign; fee = (entry + exitPx) * feeRate; }
  else if (how === '止盈2R' || how === '止损(半仓)') {
    gross = 0.5 * (r1 - entry) * sign + 0.5 * (exitPx - entry) * sign;
    fee = entry * feeRate + 0.5 * r1 * feeRate + 0.5 * exitPx * feeRate;
  } else { gross = (exitPx - entry) * sign; fee = (entry + exitPx) * feeRate; }
  const net = gross - fee;
  return {
    i, dir, time: s5.t[i + 1], entry, stop, how, hold,
    risk: relRisk, riskPct: relRisk / entry,
    gross: gross, fee: fee, net: net,
    grossR: gross / relRisk, feeR: fee / relRisk, r: net / relRisk,
    grossWin: gross > 0, win: net > 0,
    mfeR: mfe / relRisk, maeR: mae / relRisk,
  };
}

function report(label, trades) {
  const n = trades.length;
  if (!n) { console.log('  ' + label.padEnd(26) + '（无成交）'); return; }
  const gw = trades.filter(t => t.grossWin).length;
  const netWin = trades.filter(t => t.win).length;
  const gr = trades.map(t => t.grossR), nr = trades.map(t => t.r);
  const feeR = avg(trades.map(t => t.feeR));
  console.log('  ' + label.padEnd(26)
    + String(n).padStart(6)
    + pct(gw / n).padStart(9)
    + pct(netWin / n).padStart(9)
    + num(avg(gr), 4).padStart(9)
    + num(avg(nr), 4).padStart(9)
    + num(feeR, 4).padStart(8)
    + num(avg(trades.map(t => t.riskPct)) * 100, 2).padStart(8)
    + num(tstat(gr), 2).padStart(7)
    + num(tstat(nr), 2).padStart(7));
}

(async () => {
  console.log('加载 ' + sym + ' 5 年 5m ...');
  const rows = load();
  const s5 = S.toSeries(rows);
  const t0 = Date.now();
  const s15 = S.aggregate(s5, S.TF_SEC['15m']);
  const s1h = S.aggregate(s5, S.TF_SEC['1h']);
  const r5 = S.dirSeries(s5), r15 = S.dirSeries(s15), r1h = S.dirSeries(s1h);
  const m15 = S.buildClosedMap(s5.t, s15.t, S.TF_SEC['5m'], S.TF_SEC['15m']);
  const m1h = S.buildClosedMap(s5.t, s1h.t, S.TF_SEC['5m'], S.TF_SEC['1h']);
  const ms = S.msSeries(s5);
  const trig = S.findTriggersClosedMs(r5.dirs, r15.dirs, r1h.dirs, m15, m1h, ms,
    { loose: false, minScore: 0, andDir: false });
  console.log(`准备完成 ${((Date.now() - t0) / 1000).toFixed(1)}s · 5m ${s5.n} 根 · 入场候选 ${trig.length} 个`);

  /* ---------- ① 实际信号（带 MFE/MAE） ---------- */
  const base = [];
  for (const tg of trig) {
    const t = sim(s5, s1h, m1h, tg.i, tg.dir, 1, FEE, true);
    if (t) base.push(t);
  }
  console.log(`\n【一、基准：信号实跑】${base.length} 笔`);
  console.log('  ' + '组'.padEnd(24) + '笔数'.padStart(8) + '毛利胜率'.padStart(10) + '净利胜率'.padStart(10)
    + '毛利R'.padStart(10) + '净R'.padStart(10) + '费R'.padStart(10) + '止损%'.padStart(10)
    + 't(毛)'.padStart(8) + 't(净)'.padStart(8));
  report('① 实际信号', base);

  /* ---------- ② 同时刻随机方向 ③ 完全随机 ---------- */
  const N = base.length;
  // 伪随机（可复现）
  let seed = 20260928;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const sameFlip = base.map(t => {
    return sim(s5, s1h, m1h, t.i, rnd() < 0.5 ? 'long' : 'short', 1, FEE, false);
  }).filter(Boolean);
  report('② 同时刻·随机方向', sameFlip);

  const iMax = s5.n - MAXHOLD - 2;
  const rand = [];
  for (let k = 0; k < N; k++) {
    const i = 30000 + Math.floor(rnd() * (iMax - 30000));
    const t = sim(s5, s1h, m1h, i, rnd() < 0.5 ? 'long' : 'short', 1, FEE, false);
    if (t) rand.push(t);
  }
  report('③ 完全随机（裸基线）', rand);

  console.log('\n  解读：③ 是「什么都不懂、随机开」的结果。① 若与 ③ 接近，说明信号没有方向预测力；');
  console.log('        ① 毛利明显好于 ③、但净 R 接近或更差，说明有微弱 alpha 但被交易成本吃光。');

  /* ---------- ④ 止损宽度扫描 ---------- */
  console.log('\n【二、止损宽度（同一批信号，只改 risk 倍数）】');
  console.log('  ' + 'risk 倍数'.padEnd(14) + '毛利胜率'.padStart(10) + '净利胜率'.padStart(10)
    + '毛利R'.padStart(10) + '净R'.padStart(10) + '费R'.padStart(10) + '止损%'.padStart(10)
    + 't(净)'.padStart(8));
  for (const mul of [1.0, 1.8, 2.5, 3.5, 5.0]) {
    const ts = [];
    for (const tg of trig) {
      const t = sim(s5, s1h, m1h, tg.i, tg.dir, mul, FEE, false);
      if (t) ts.push(t);
    }
    const gr = ts.map(t => t.grossR), nr = ts.map(t => t.r);
    console.log('  ' + ('×' + mul.toFixed(1)).padEnd(14)
      + pct(ts.filter(t => t.grossWin).length / ts.length).padStart(12)
      + pct(ts.filter(t => t.win).length / ts.length).padStart(10)
      + num(avg(gr), 4).padStart(10) + num(avg(nr), 4).padStart(10)
      + num(avg(ts.map(t => t.feeR)), 4).padStart(10)
      + num(avg(ts.map(t => t.riskPct)) * 100, 2).padStart(10)
      + num(tstat(nr), 2).padStart(8));
  }

  /* ---------- ⑤ 手续费扫描 ---------- */
  console.log('\n【三、费率（同一批信号 ×1.8 止损）】');
  for (const f of [0.0010, 0.0005, 0.0002, 0]) {
    const ts = [];
    for (const tg of trig) { const t = sim(s5, s1h, m1h, tg.i, tg.dir, 1, f, false); if (t) ts.push(t); }
    const nr = ts.map(t => t.r);
    console.log('  ' + ('双边 ' + (f * 100).toFixed(2) + '%').padEnd(16)
      + '净利胜率 ' + pct(ts.filter(t => t.win).length / ts.length).padStart(7)
      + ' · 净R ' + num(avg(nr), 4).padStart(9)
      + ' · 费R ' + num(avg(ts.map(t => t.feeR)), 4).padStart(8)
      + ' · t(净) ' + num(tstat(nr), 2).padStart(7));
  }

  /* ---------- ⑥ 出场结构与 MFE ---------- */
  console.log('\n【四、出场结构（信号组）】');
  const groups = {};
  for (const t of base) (groups[t.how] = groups[t.how] || []).push(t);
  console.log('  ' + '出场方式'.padEnd(14) + '笔数'.padStart(7) + '占比'.padStart(9)
    + '平均毛利R'.padStart(11) + '平均净R'.padStart(11) + '平均持有h'.padStart(11));
  for (const k of Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)) {
    const g = groups[k];
    console.log('  ' + k.padEnd(14) + String(g.length).padStart(7) + pct(g.length / base.length).padStart(9)
      + num(avg(g.map(t => t.grossR)), 3).padStart(11) + num(avg(g.map(t => t.r)), 3).padStart(11)
      + num(avg(g.map(t => t.hold)) * 5 / 60, 1).padStart(11));
  }

  const flipCount = base.filter(t => t.grossWin && !t.win).length;
  console.log('\n  毛利为正但净利为负（被手续费翻转）：' + flipCount + ' 笔，占毛利赢单 '
    + pct(flipCount / Math.max(1, base.filter(t => t.grossWin).length)));

  const mfeAll = avg(base.map(t => t.mfeR));
  const reachOne = base.filter(t => t.mfeR >= 0.9).length;
  const loseAfterOne = base.filter(t => t.mfeR >= 0.9 && t.r < 0).length;
  console.log('  平均最大有利偏移 MFE：' + num(mfeAll, 3) + 'R'
    + ' · 曾到 ≥0.9R 的笔数 ' + reachOne + '（' + pct(reachOne / base.length) + '）'
    + ' · 其中最终亏损 ' + loseAfterOne + ' 笔（' + pct(loseAfterOne / Math.max(1, reachOne)) + '）');
  console.log('  平均最大不利偏移 MAE：' + num(avg(base.map(t => t.maeR)), 3) + 'R');

  /* ---------- 出场结构变体（回答「胜率是否被出场规则锁死」） ---------- */
  console.log('\n【四·b 出场规则变体（同一批信号 ×1.0 止损）】');
  const VARIANTS = [
    ['p1', 'TP1=1R 减半 + TP2=2R（现状）'],
    ['full2', '不减仓，全仓等到 2R 或止损'],
    ['p05', 'TP1=0.5R 减半 + TP2=2R'],
  ];
  console.log('  ' + '出场规则'.padEnd(30) + '毛利胜率'.padStart(10) + '净利胜率'.padStart(10)
    + '毛利R'.padStart(10) + '净R'.padStart(10) + 't(毛)'.padStart(8) + 't(净)'.padStart(8));
  for (const [mode, label] of VARIANTS) {
    const ts = [];
    for (const tg of trig) { const t = sim(s5, s1h, m1h, tg.i, tg.dir, 1, FEE, false, mode); if (t) ts.push(t); }
    const gr = ts.map(t => t.grossR), nr = ts.map(t => t.r);
    console.log('  ' + label.padEnd(28)
      + pct(ts.filter(t => t.grossWin).length / ts.length).padStart(10)
      + pct(ts.filter(t => t.win).length / ts.length).padStart(10)
      + num(avg(gr), 4).padStart(10) + num(avg(nr), 4).padStart(10)
      + num(tstat(gr), 2).padStart(8) + num(tstat(nr), 2).padStart(8));
  }

  /* ---------- ⑦ 按年 ---------- */
  console.log('\n【五、按年（信号组）】');
  const byYear = {};
  for (const t of base) {
    const y = new Date(t.time * 1000).getUTCFullYear();
    (byYear[y] = byYear[y] || []).push(t);
  }
  console.log('  ' + '年'.padEnd(8) + '笔数'.padStart(7) + '毛利胜率'.padStart(10) + '净利胜率'.padStart(10)
    + '净R'.padStart(10) + '累计R'.padStart(10));
  for (const y of Object.keys(byYear).sort()) {
    const g = byYear[y];
    console.log('  ' + y.padEnd(8) + String(g.length).padStart(7)
      + pct(g.filter(t => t.grossWin).length / g.length).padStart(10)
      + pct(g.filter(t => t.win).length / g.length).padStart(10)
      + num(avg(g.map(t => t.r)), 3).padStart(10)
      + num(g.reduce((a, t) => a + t.r, 0), 1).padStart(10));
  }
})();
