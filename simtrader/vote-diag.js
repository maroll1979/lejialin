/* vote-diag.js · 「信号为什么一直不提示」漏斗诊断
   ------------------------------------------------------------------
   把「从一根 K 线到一个报警」拆成五层，每层统计通过率，
   这样「是不是因子太多」就不再靠猜：

     L0  5m bar 总数
     L1  最低周期有明确方向（票数赢家 ≥ minVotes 且多于反方）
     L2  已收线的 15m 也有方向
     L3  已收线的 1h  也有方向
     L4  三周期同向（1h 定方向，15m / 5m 都等于它）
     L5  实际报警（只在「刚凑齐」那一根响一次）

   另外针对当前 minVotes 输出：
     · 九个指标各自的表态率（从来不表态的就是死因子）
     · 多空票数直方图
     · 卡点归因：L4 失败时到底卡在哪一环

   用法：node vote-diag.js BTCUSDT 2
   ------------------------------------------------------------------ */
const S = require('./simtrader/strategy.js');
const fs = require('fs');

const sym = process.argv[2] || 'BTCUSDT';
const YEARS = +(process.argv[3] || 2);
const CACHE = 'data/m1_' + sym + '_' + YEARS + 'y.json';
const VOTE_LABEL = [
  'EMA趋势', 'MACD动能', 'ADX趋向', 'RSI摆动',
  'KDJ摆动', 'BOLL通道', 'OBV量价', 'VOL量能', 'MA200位置',
];
const SEC = { '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

function pct(a, b) { return b ? (a / b * 100) : 0; }
function bar(p, w) { const n = Math.round(p / 100 * w); return '█'.repeat(n) + '·'.repeat(w - n); }

/* 一层一层往下筛，返回每层通过数 */
function funnel(r5, r15, r1h, m15, m1h, n) {
  let c5 = 0, c15 = 0, c1h = 0, cSame = 0, cTrig = 0;
  /* 卡点归因：L4 失败时，缺的是哪一环 */
  let miss = { d1h0: 0, d15_0: 0, d5_0: 0, conflict15: 0, conflict5: 0 };
  let prev = false;
  for (let i = 1; i < n; i++) {
    const j15 = m15[i], j1h = m1h[i];
    if (j15 < 0 || j1h < 0) { prev = false; continue; }
    const d5v = r5.dirs[i], d15v = r15.dirs[j15], d1hv = r1h.dirs[j1h];
    if (d5v !== 0) c5++;
    if (d15v !== 0) c15++;
    if (d1hv !== 0) c1h++;
    let on = false;
    if (d1hv === 0) miss.d1h0++;
    else if (d15v === 0) miss.d15_0++;
    else if (d5v === 0) miss.d5_0++;
    else if (d15v !== d1hv) miss.conflict15++;
    else if (d5v !== d1hv) miss.conflict5++;
    else { on = true; cSame++; }
    if (on && !prev) cTrig++;
    prev = on;
  }
  return { c5, c15, c1h, cSame, cTrig, miss, n: n - 1 };
}

/* 九个指标各自的表态率 */
function factorStats(votes, w, dirs, n) {
  const out = [];
  for (let k = 0; k < w; k++) {
    let up = 0, dn = 0, flat = 0;
    for (let i = 0; i < n; i++) {
      const v = votes[i * w + k];
      if (v > 0) up++; else if (v < 0) dn++; else flat++;
    }
    out.push({ k, up, dn, flat, rate: (up + dn) / n, upRate: up / n, dnRate: dn / n });
  }
  return out;
}

(async () => {
  if (!fs.existsSync(CACHE)) { console.error('缺缓存 ' + CACHE + '，请先跑 bt-pct.js 拉数'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('数据 ' + CACHE + ' · ' + raw.rows.length.toLocaleString('en-US') + ' 根 1m'
    + ' · 落盘 ' + new Date(raw.at).toLocaleString('zh-CN'));
  const s1m = S.toSeries(raw.rows);
  const s5 = S.aggregate(s1m, SEC['5m']);
  const s15 = S.aggregate(s5, SEC['15m']);
  const s1h = S.aggregate(s5, SEC['1h']);
  const s1d = S.aggregate(s5, SEC['1d']);
  const N = s5.n;
  const days = (s5.t[N - 1] - s5.t[0]) / 86400;   // t 是秒
  console.log('5m ' + N.toLocaleString('en-US') + ' 根 · 跨度 ' + days.toFixed(0) + ' 天');

  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, SEC['5m']);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, SEC['15m']);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, SEC['1h']);
  const m15 = S.buildClosedMap(s5.t, s15.t, SEC['5m'], SEC['15m']);
  const m1h = S.buildClosedMap(s5.t, s1h.t, SEC['5m'], SEC['1h']);

  /* ---------------- 【一】minVotes 扫描：是不是因子太多了 ---------------- */
  console.log('\n════ 一、票数门槛 minVotes 扫描（越低越松） ════');
  console.log('门槛   5m有方向   三周期同向    报警次数   平均间隔      每年');
  const keep = {};
  for (let mv = 2; mv <= 7; mv++) {
    const V = { thz: 0.30, bufPct: 0.005, minVotes: mv };
    const r5 = S.voteSeries(s5, ma5, V);
    const r15 = S.voteSeries(s15, ma15, V);
    const r1h = S.voteSeries(s1h, ma1h, V);
    const f = funnel(r5, r15, r1h, m15, m1h, N);
    const perYear = f.cTrig / days * 365;
    console.log('≥' + mv + '票  '
      + (pct(f.c5, f.n).toFixed(1) + '%').padStart(7)
      + (pct(f.cSame, f.n).toFixed(2) + '%').padStart(11)
      + String(f.cTrig).padStart(11)
      + (f.cTrig ? (days / f.cTrig * 24).toFixed(1) + '小时' : '  —').padStart(13)
      + perYear.toFixed(1).padStart(10));
    if (mv === 4) keep.f = f, keep.r5 = r5, keep.r15 = r15, keep.r1h = r1h;
  }

  /* ---------------- 【二】当前设置（≥4票）的漏斗 ---------------- */
  const f = keep.f;
  console.log('\n════ 二、当前设置（≥4 票）逐层漏斗 ════');
  const layers = [
    ['L1 5m 有明确方向', f.c5],
    ['L2 15m 有方向', f.c15],
    ['L3 1h 有方向', f.c1h],
    ['L4 三周期同向', f.cSame],
    ['L5 实际报警（跃变沿）', f.cTrig],
  ];
  layers.forEach(([lab, c]) => {
    console.log(lab.padEnd(24) + String(c).padStart(9)
      + '  ' + (pct(c, f.n).toFixed(2) + '%').padStart(8) + '  ' + bar(pct(c, f.n), 30));
  });

  /* ---------------- 【三】卡点归因：L4 到底卡在哪 ---------------- */
  console.log('\n════ 三、不报警的时候，卡在哪一环（占全部 bar） ════');
  const M = f.miss;
  const missRows = [
    ['1h 没表态（票数不够）', M.d1h0],
    ['15m 没表态', M.d15_0],
    ['5m 没表态', M.d5_0],
    ['15m 与 1h 反向', M.conflict15],
    ['5m 与 1h 反向', M.conflict5],
  ];
  missRows.forEach(([lab, c]) => {
    console.log(lab.padEnd(24) + String(c).padStart(9)
      + '  ' + (pct(c, f.n).toFixed(1) + '%').padStart(7) + '  ' + bar(pct(c, f.n), 26));
  });

  /* ---------------- 【四】九个因子的表态率（找死因子） ---------------- */
  console.log('\n════ 四、九个因子各自的表态率（5m 周期） ════');
  console.log('因子         表态率   偏多    偏空    直方图');
  const fs5 = factorStats(keep.r5.votes, keep.r5.w, keep.r5.dirs, N);
  fs5.forEach((x, i) => {
    console.log(VOTE_LABEL[i].padEnd(12)
      + (pct(x.up + x.dn, N).toFixed(1) + '%').padStart(7)
      + (pct(x.upRate, 1).toFixed(1) + '%').padStart(8)
      + (pct(x.dnRate, 1).toFixed(1) + '%').padStart(8)
      + '  ' + bar(pct(x.up + x.dn, N), 24));
  });

  /* ---------------- 【五】票数直方图 ---------------- */
  console.log('\n════ 五、5m 每根 bar 上「最多的一方」拿到几票 ════');
  const hist = new Array(10).fill(0);
  let winDir = 0;
  for (let i = 0; i < N; i++) {
    const u = keep.r5.up[i], d = keep.r5.dn[i];
    hist[Math.max(u, d)]++;
    if (keep.r5.dirs[i] !== 0) winDir++;
  }
  for (let k = 0; k <= 9; k++) {
    if (!hist[k]) continue;
    console.log(String(k) + ' 票 ' + String(hist[k]).padStart(8)
      + '  ' + (pct(hist[k], N).toFixed(1) + '%').padStart(7) + '  ' + bar(pct(hist[k], N), 26)
      + (k >= 4 ? '  ← 可触发' : ''));
  }

  /* ---------------- 【六】逐因子剔除：砍掉一个会怎样 ---------------- */
  console.log('\n════ 六、砍掉某一个因子后（其余八票，门槛仍 ≥4） ════');
  console.log('剔除          5m有方向    三周期同向    报警次数    平均间隔');
  for (let drop = 0; drop < 9; drop++) {
    const V = { thz: 0.30, bufPct: 0.005, minVotes: 4, dropKey: drop };
    /* voteSeries 不支持剔除，手工重算：复用 votes 矩阵，把该列置 0 再投票 */
    const r5b = reVote(keep.r5, 4, drop);
    const r15b = reVote(keep.r15, 4, drop);
    const r1hb = reVote(keep.r1h, 4, drop);
    const fb = funnel(r5b, r15b, r1hb, m15, m1h, N);
    console.log(VOTE_LABEL[drop].padEnd(12)
      + (pct(fb.c5, fb.n).toFixed(1) + '%').padStart(9)
      + (pct(fb.cSame, fb.n).toFixed(2) + '%').padStart(12)
      + String(fb.cTrig).padStart(11)
      + (fb.cTrig ? (days / fb.cTrig * 24).toFixed(1) + '小时' : '  —').padStart(13));
  }
  console.log('\n（基线：不剔除 → 5m有方向 ' + pct(f.c5, f.n).toFixed(1) + '%'
    + ' · 三周期同向 ' + pct(f.cSame, f.n).toFixed(2) + '%'
    + ' · 报警 ' + f.cTrig + ' 次 · 平均 ' + (days / f.cTrig * 24).toFixed(1) + ' 小时）');

  /* ---------------- 【七】分层门槛：只松 1h 会怎样 ---------------- */
  console.log('\n════ 七、分层门槛（各周期用不同票数门槛）+ 固定 1.5%:3% 结算 ════');
  console.log('注意：votes 矩阵与 minVotes 无关，门槛只影响定方向那一步，');
  console.log('      所以下面每组都是同一批原始票数，只换判定线。\n');
  console.log('5m/15m/1h门槛      报警次数   平均间隔    胜率    每笔净R    t值');
  const COMBOS = [
    [4, 4, 4, '基线（现行）'],
    [3, 4, 4, '只松 5m'],
    [4, 3, 4, '只松 15m'],
    [4, 4, 3, '只松 1h'],
    [4, 4, 2, '1h 降到 ≥2'],
    [3, 3, 3, '三个都 ≥3'],
    [2, 2, 2, '三个都 ≥2'],
    [5, 5, 5, '三个都 ≥5'],
  ];
  for (const [a, b, c, lab] of COMBOS) {
    const r5b = reVote(keep.r5, a, -1);
    const r15b = reVote(keep.r15, b, -1);
    const r1hb = reVote(keep.r1h, c, -1);
    const fb = funnel(r5b, r15b, r1hb, m15, m1h, N);
    const trigs = triggersOf(r5b, r15b, r1hb, m15, m1h, N);
    const st = settle(s5, trigs, 0.015, 0.030, S.FEE_RATE);
    console.log(('≥' + a + '/≥' + b + '/≥' + c).padEnd(10) + lab.padEnd(14)
      + String(trigs.length).padStart(7)
      + (trigs.length ? (days / trigs.length * 24).toFixed(1) + 'h' : '  —').padStart(11)
      + (st.winRate * 100).toFixed(1).padStart(9) + '%'
      + st.avgR.toFixed(4).padStart(10)
      + st.t.toFixed(2).padStart(8));
  }
})();

/* 触发点列表（与 findVoteTriggersClosed 同口径） */
function triggersOf(r5, r15, r1h, m15, m1h, n) {
  const out = [];
  let prev = false;
  for (let i = 1; i < n; i++) {
    const j15 = m15[i], j1h = m1h[i];
    let on = false;
    if (j15 >= 0 && j1h >= 0) {
      const a = r1h.dirs[j1h];
      on = a !== 0 && r15.dirs[j15] === a && r5.dirs[i] === a;
    }
    if (on && !prev) out.push({ i, dir: r1h.dirs[j1h] });
    prev = on;
  }
  return out;
}

/* 固定百分比结算：次根开盘成交，逐根走到止损或止盈，最多持 7 天 */
function settle(s5, trigs, stopPct, tpPct, fee) {
  const maxHold = Math.round(7 * 86400 / 300);
  const Rs = [];
  for (const tg of trigs) {
    const i = tg.i + 1;
    if (i >= s5.n - 1) continue;
    const entry = s5.o[i];
    const up = tg.dir === 1;              // dirs 编码：1=多 2=空
    const stop = up ? entry * (1 - stopPct) : entry * (1 + stopPct);
    const tp = up ? entry * (1 + tpPct) : entry * (1 - tpPct);
    let r = null;
    for (let j = i; j < Math.min(s5.n, i + maxHold); j++) {
      const hitStop = up ? s5.l[j] <= stop : s5.h[j] >= stop;
      const hitTp = up ? s5.h[j] >= tp : s5.l[j] <= tp;
      if (hitStop) { r = -(stopPct + fee * (2 - stopPct)) / stopPct; break; }
      if (hitTp) { r = (tpPct - fee * (2 + tpPct)) / stopPct; break; }
    }
    if (r == null) {   // 超时按现价平
      const last = Math.min(s5.n - 1, i + maxHold - 1);
      const pnl = up ? (s5.c[last] - entry) / entry : (entry - s5.c[last]) / entry;
      r = (pnl - fee * 2) / stopPct;
    }
    Rs.push(r);
  }
  if (!Rs.length) return { winRate: 0, avgR: 0, t: 0, n: 0 };
  let sum = 0; for (const v of Rs) sum += v;
  const m = sum / Rs.length;
  let ss = 0; for (const v of Rs) ss += (v - m) * (v - m);
  const sd = Math.sqrt(ss / (Rs.length - 1)) || 1e-9;
  return { winRate: Rs.filter(v => v > 0).length / Rs.length, avgR: m, t: m / (sd / Math.sqrt(Rs.length)), n: Rs.length };
}

/* 把某因子的票全部作废后重新定方向（minVotes 不变，但总票池少一票） */
function reVote(r, minVotes, drop) {
  const w = r.w, n = r.dirs.length;
  const dirs = new Int8Array(n), up = new Int8Array(n), dn = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, d = 0;
    for (let k = 0; k < w; k++) {
      if (k === drop) continue;
      const v = r.votes[i * w + k];
      if (v > 0) u++; else if (v < 0) d++;
    }
    up[i] = u; dn[i] = d;
    dirs[i] = (u >= minVotes && u > d) ? 1 : ((d >= minVotes && d > u) ? 2 : 0);   // 编码同 voteSeries：1=多 2=空 0=无
  }
  return { dirs, up, dn, votes: r.votes, w };
}
