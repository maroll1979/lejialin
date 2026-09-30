/* vote-focus.js · 用户最看重的五个因子的「触达占比」体检
   ------------------------------------------------------------------
   用户点名： KDJ(4) · MACD(1) · OBV(6) · BOLL(5) · EMA(0)，且**不分先后 / 等权**。

   光给「占比」是不够的 —— 占比高只说明它爱说话，不代表它说得对。
   所以这里用五个互相独立的口径交叉验证：

     A 活跃度     该因子在全部 5m bar 上投了非 0 票的比例（爱不爱说话）
     B 触发触达率  ★核心★ 在 N 次实际触发中，该因子在 5m/15m/1h 上
                   投了「与信号同向」那一票的比例（有没有真的参与）
     C 触达结构    一次触发里这五个平均来了几个（避免被单一因子刷高占比）
     D 单独成军    只用这五票等权（其余作废），能复现多少触发 + 回测表现
     E 单因子预测力 ★证伪★ 该因子单独表态时，后续 1 小时的方向准确率。
                   占比高但准确率≈50% 的因子，说明它只是噪声放大器

   用法：node vote-focus.js BTCUSDT 2
   ------------------------------------------------------------------ */
const S = require('./simtrader/strategy.js');
const fs = require('fs');

const sym = process.argv[2] || 'BTCUSDT';
const YEARS = +(process.argv[3] || 2);
const CACHE = 'data/m1_' + sym + '_' + YEARS + 'y.json';

const VOTE_LABEL = ['EMA趋势', 'MACD动能', 'ADX趋向', 'RSI摆动',
  'KDJ摆动', 'BOLL通道', 'OBV量价', 'VOL量能', 'MA200位置'];
/* 用户点名的五个（等权，无先后） */
const FOCUS = [
  { k: 0, name: 'EMA' }, { k: 1, name: 'MACD' },
  { k: 4, name: 'KDJ' }, { k: 5, name: 'BOLL' }, { k: 6, name: 'OBV' },
];
const REST = [2, 3, 7, 8];               // 另外四个：ADX / RSI / VOL / MA200
const SEC = { '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

function pct(a, b) { return b ? (a / b * 100) : 0; }
function bar(p, w) { const n = Math.round(p / 100 * w); return '█'.repeat(n) + '·'.repeat(w - n); }
const pad = (s, n) => String(s).padStart(n);

/* 把指定的票作废后重新定方向（drop 可以是数组） */
function reVote(r, minVotes, drop) { return reVoteEx(r, minVotes, drop, null); }

/* drop: 作废的票（数组/单个/-1=不作废）；flip: 取反的票（数组/单个/null）
   —— 用来验证「某个因子在体系里是不是其实在投反票」 */
function reVoteEx(r, minVotes, drop, flip) {
  const w = r.w, n = r.dirs.length;
  const dropSet = Array.isArray(drop) ? new Set(drop) : new Set(drop == null || drop < 0 ? [] : [drop]);
  const flipSet = Array.isArray(flip) ? new Set(flip) : new Set(flip == null || flip < 0 ? [] : [flip]);
  const dirs = new Int8Array(n), up = new Int8Array(n), dn = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, d = 0;
    for (let k = 0; k < w; k++) {
      if (dropSet.has(k)) continue;
      let v = r.votes[i * w + k];
      if (flipSet.has(k)) v = -v;
      if (v > 0) u++; else if (v < 0) d++;
    }
    up[i] = u; dn[i] = d;
    dirs[i] = (u >= minVotes && u > d) ? 1 : ((d >= minVotes && d > u) ? 2 : 0);
  }
  return { dirs, up, dn, votes: r.votes, w };
}

/* 触发点（同 findVoteTriggersClosed 口径：只在刚凑齐那一根响一次） */
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
    const up = tg.dir === 1;
    const stop = up ? entry * (1 - stopPct) : entry * (1 + stopPct);
    const tp = up ? entry * (1 + tpPct) : entry * (1 - tpPct);
    let r = null;
    for (let j = i; j < Math.min(s5.n, i + maxHold); j++) {
      if (up ? s5.l[j] <= stop : s5.h[j] >= stop) { r = -(stopPct + fee * (2 - stopPct)) / stopPct; break; }
      if (up ? s5.h[j] >= tp : s5.l[j] <= tp) { r = (tpPct - fee * (2 + tpPct)) / stopPct; break; }
    }
    if (r == null) {
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

(async () => {
  if (!fs.existsSync(CACHE)) { console.error('缺缓存 ' + CACHE + '，请先跑 bt-pct.js 拉数'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const s1m = S.toSeries(raw.rows);
  const s5 = S.aggregate(s1m, SEC['5m']);
  const s15 = S.aggregate(s5, SEC['15m']);
  const s1h = S.aggregate(s5, SEC['1h']);
  const s1d = S.aggregate(s5, SEC['1d']);
  const N = s5.n;
  const days = (s5.t[N - 1] - s5.t[0]) / 86400;

  console.log('════════ ' + sym + ' · ' + N.toLocaleString('en-US') + ' 根 5m · '
    + days.toFixed(0) + ' 天 · 五因子触达体检 ════════');

  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, SEC['5m']);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, SEC['15m']);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, SEC['1h']);
  const m15 = S.buildClosedMap(s5.t, s15.t, SEC['5m'], SEC['15m']);
  const m1h = S.buildClosedMap(s5.t, s1h.t, SEC['5m'], SEC['1h']);

  const V = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
  const r5 = S.voteSeries(s5, ma5, V);
  const r15 = S.voteSeries(s15, ma15, V);
  const r1h = S.voteSeries(s1h, ma1h, V);
  const trigs = triggersOf(r5, r15, r1h, m15, m1h, N);
  console.log('基线（九票 ≥4）：触发 ' + trigs.length + ' 次 · 平均 '
    + (days / trigs.length * 24).toFixed(1) + ' 小时一次\n');

  /* ---------------- A 活跃度 ---------------- */
  console.log('──── 一、活跃度：该因子在全部 bar 上「表态」的占比（5m） ────');
  console.log('因子(序号)      表态率     偏多     偏空   直方图');
  const act = [];
  for (let k = 0; k < 9; k++) {
    let u = 0, d = 0;
    for (let i = 0; i < N; i++) { const v = r5.votes[i * 9 + k]; if (v > 0) u++; else if (v < 0) d++; }
    act.push({ k, rate: (u + d) / N, up: u / N, dn: d / N });
  }
  act.forEach(x => {
    const foc = FOCUS.some(f => f.k === x.k);
    console.log((VOTE_LABEL[x.k] + '(' + x.k + ')').padEnd(16)
      + ((x.rate * 100).toFixed(1) + '%').padStart(7)
      + ((x.up * 100).toFixed(1) + '%').padStart(9)
      + ((x.dn * 100).toFixed(1) + '%').padStart(9)
      + '  ' + bar(x.rate * 100, 24) + (foc ? '  ★' : ''));
  });

  /* ---------------- B 触发触达率（核心） ---------------- */
  console.log('\n──── 二、★触达占比★ ' + trigs.length + ' 次触发中，该因子投了「同向票」的比例 ────');
  console.log('    （信号方向由 1h 决定；因子票 v 同号即算触达。分母 = 触发次数）');
  console.log('因子         5m      15m      1h    三周期全中   至少一周期');
  const touch = [];
  for (const f of FOCUS) {
    const k = f.k;
    let c5 = 0, c15 = 0, c1h = 0, all = 0, any = 0;
    for (const tg of trigs) {
      const want = tg.dir === 1 ? 1 : -1;          // 1=多 → 想要 +1；2=空 → 想要 -1
      const i = tg.i, j15 = m15[i], j1h = m1h[i];
      const v5 = r5.votes[i * 9 + k];
      const v15 = j15 >= 0 ? r15.votes[j15 * 9 + k] : 0;
      const v1 = j1h >= 0 ? r1h.votes[j1h * 9 + k] : 0;
      const h5 = v5 === want, h15 = v15 === want, h1 = v1 === want;
      if (h5) c5++; if (h15) c15++; if (h1) c1h++;
      if (h5 && h15 && h1) all++;
      if (h5 || h15 || h1) any++;
    }
    const T = trigs.length || 1;
    touch.push({ k, name: f.name, p5: c5 / T, p15: c15 / T, p1h: c1h / T, all: all / T, any: any / T });
  }
  touch.forEach(x => {
    console.log(x.name.padEnd(10)
      + ((x.p5 * 100).toFixed(1) + '%').padStart(7)
      + ((x.p15 * 100).toFixed(1) + '%').padStart(9)
      + ((x.p1h * 100).toFixed(1) + '%').padStart(8)
      + ((x.all * 100).toFixed(1) + '%').padStart(11)
      + ((x.any * 100).toFixed(1) + '%').padStart(11)
      + '  ' + bar(x.any * 100, 16));
  });
  /* 另外四个作为对照 */
  const touchRest = [];
  for (const k of REST) {
    let c5 = 0, c15 = 0, c1h = 0, all = 0, any = 0;
    for (const tg of trigs) {
      const want = tg.dir === 1 ? 1 : -1;
      const i = tg.i, j15 = m15[i], j1h = m1h[i];
      const v5 = r5.votes[i * 9 + k];
      const v15 = j15 >= 0 ? r15.votes[j15 * 9 + k] : 0;
      const v1 = j1h >= 0 ? r1h.votes[j1h * 9 + k] : 0;
      const h5 = v5 === want, h15 = v15 === want, h1 = v1 === want;
      if (h5) c5++; if (h15) c15++; if (h1) c1h++;
      if (h5 && h15 && h1) all++;
      if (h5 || h15 || h1) any++;
    }
    const T = trigs.length || 1;
    touchRest.push({ k, name: VOTE_LABEL[k], p5: c5 / T, p15: c15 / T, p1h: c1h / T, all: all / T, any: any / T });
  }
  console.log('— 对照：另外四个 —');
  touchRest.forEach(x => {
    console.log(x.name.padEnd(10)
      + ((x.p5 * 100).toFixed(1) + '%').padStart(7)
      + ((x.p15 * 100).toFixed(1) + '%').padStart(9)
      + ((x.p1h * 100).toFixed(1) + '%').padStart(8)
      + ((x.all * 100).toFixed(1) + '%').padStart(11)
      + ((x.any * 100).toFixed(1) + '%').padStart(11)
      + '  ' + bar(x.any * 100, 16));
  });

  /* ---------------- C 触达结构 ---------------- */
  console.log('\n──── 三、触达结构：一次触发里这五个平均来了几个（按 5m 计） ────');
  const hist = new Array(6).fill(0);
  for (const tg of trigs) {
    const want = tg.dir === 1 ? 1 : -1;
    let c = 0;
    for (const f of FOCUS) if (r5.votes[tg.i * 9 + f.k] === want) c++;
    hist[c]++;
  }
  for (let c = 0; c <= 5; c++) {
    console.log('来了 ' + c + '/5 个 ' + pad(hist[c], 7)
      + '  ' + (pct(hist[c], trigs.length).toFixed(1) + '%').padStart(7)
      + '  ' + bar(pct(hist[c], trigs.length), 26));
  }
  let avgC = 0; for (let c = 0; c <= 5; c++) avgC += c * hist[c];
  console.log('平均每次触发有 ' + (avgC / (trigs.length || 1)).toFixed(2) + ' / 5 个因子同向触达');

  /* ---------------- D 单独成军 ---------------- */
  console.log('\n──── 四、单独成军：只用这五票（等权，其余四票作废）+ 1.5%:3% 结算 ────');
  console.log('口径                     触发次数   平均间隔    胜率    每笔净R    t值');
  const CASES = [
    [V, null, '九票 ≥4（基线）'],
    [[4, 4, 4], REST, '五票 ≥4（等权）'],
    [[3, 3, 3], REST, '五票 ≥3（多数）'],
    [[2, 2, 2], REST, '五票 ≥2'],
    [[2, 2, 2], FOCUS.map(f => f.k), '另外四票 ≥2（反证）'],
    [[1, 1, 1], FOCUS.map(f => f.k), '另外四票 ≥1（反证）'],
  ];
  const rows = [];
  for (const [mv, drop, lab] of CASES) {
    let r5b, r15b, r1hb;
    if (drop === null) { r5b = r5; r15b = r15; r1hb = r1h; }
    else {
      const [a, b, c] = mv;
      r5b = reVote(r5, a, drop); r15b = reVote(r15, b, drop); r1hb = reVote(r1h, c, drop);
    }
    const tg = triggersOf(r5b, r15b, r1hb, m15, m1h, N);
    const st = settle(s5, tg, 0.015, 0.030, S.FEE_RATE);
    rows.push({ lab, n: tg.length, st });
    console.log(lab.padEnd(22)
      + pad(tg.length, 9)
      + (tg.length ? (days / tg.length * 24).toFixed(1) + 'h' : '  —').padStart(11)
      + ((st.winRate * 100).toFixed(1) + '%').padStart(9)
      + st.avgR.toFixed(4).padStart(10)
      + st.t.toFixed(2).padStart(8));
  }
  /* 重合度：五票 ≥3 的触发点有多少落在九票 ≥4 里 */
  {
    const r5b = reVote(r5, 3, REST), r15b = reVote(r15, 3, REST), r1hb = reVote(r1h, 3, REST);
    const tgB = triggersOf(r5b, r15b, r1hb, m15, m1h, N);
    const setA = new Set(trigs.map(t => t.i));
    const hit = tgB.filter(t => setA.has(t.i)).length;
    console.log('\n五票≥3 的 ' + tgB.length + ' 次触发中，有 ' + hit + ' 次与九票≥4 的触发点重合'
      + '（' + pct(hit, tgB.length).toFixed(1) + '%）→ 五票覆盖了九票信号的 '
      + pct(hit, trigs.length).toFixed(1) + '%');
  }

  /* ---------------- E 单因子预测力（证伪） ---------------- */
  console.log('\n──── 五、★证伪★ 单因子预测力：该因子单独表态时，后续 1h 的方向准确率 ────');
  console.log('    （只看该因子自己在 5m 上投了非 0 票的那些 bar，看之后 12 根 5m 涨跌是否同向）');
  console.log('因子         表态次数   方向准确率   平均涨跌     t值     判定');
  const H = 12;
  for (let k = 0; k < 9; k++) {
    let n = 0, hit = 0, sumRet = 0; const rets = [];
    for (let i = 60; i < N - H; i++) {
      const v = r5.votes[i * 9 + k];
      if (v === 0) continue;
      const exit = s5.c[i + H], entry = s5.c[i];
      const ret = (exit - entry) / entry;
      const dir = ret > 0 ? 1 : (ret < 0 ? -1 : 0);
      n++; sumRet += ret; rets.push(ret);
      if (dir !== 0 && dir === v) hit++;
    }
    if (!n) continue;
    const m = sumRet / n;
    let ss = 0; for (const r of rets) ss += (r - m) * (r - m);
    const sd = Math.sqrt(ss / (n - 1)) || 1e-9;
    const t = m / (sd / Math.sqrt(n));
    const acc = hit / n;
    const foc = FOCUS.some(f => f.k === k);
    const verdict = Math.abs(t) < 2 ? '无预测力（≈噪声）'
      : (t > 0 ? '同向有效' : '★反向有效（应取反）');
    console.log((VOTE_LABEL[k] + '(' + k + ')').padEnd(16)
      + pad(n.toLocaleString('en-US'), 10)
      + ((acc * 100).toFixed(2) + '%').padStart(11)
      + ((m * 100).toFixed(4) + '%').padStart(11)
      + t.toFixed(2).padStart(8) + '   ' + verdict + (foc ? '  ★' : ''));
  }
  console.log('\n（t 值 = 平均涨跌 ÷ 标准误；|t|≥2 才配叫「有预测力」。');
  console.log(' 注意这里看的是**因子自身方向**的预测力，不是它在投票体系里的贡献。）');

  /* ---------------- F 低触达因子到底投了什么 ---------------- */
  console.log('\n──── 六、低触达因子去向：触发那一刻它投的是同向 / 反向 / 弃权 ────');
  console.log('    （只看 1h，因为信号方向由 1h 决定。同向+反向+弃权 = 100%）');
  console.log('因子           同向     反向     弃权    判定');
  for (const k of [0, 1, 4, 5, 6, 2, 3, 7, 8]) {
    let same = 0, opp = 0, flat = 0;
    for (const tg of trigs) {
      const j1h = m1h[tg.i]; if (j1h < 0) continue;
      const want = tg.dir === 1 ? 1 : -1;
      const v = r1h.votes[j1h * 9 + k];
      if (v === 0) flat++; else if (v === want) same++; else opp++;
    }
    const T = trigs.length || 1;
    const verdict = opp > same * 1.5 ? '★几乎总是投反票（体系内是阻力）'
      : same > opp * 1.5 ? '稳定同向' : '摇摆';
    console.log((VOTE_LABEL[k] + '(' + k + ')').padEnd(16)
      + ((same / T * 100).toFixed(1) + '%').padStart(7)
      + ((opp / T * 100).toFixed(1) + '%').padStart(9)
      + ((flat / T * 100).toFixed(1) + '%').padStart(9) + '   ' + verdict);
  }

  /* ---------------- G 组合搜索：这五个里到底该留谁 ---------------- */
  console.log('\n──── 七、组合搜索：只用用户点名的五票，等权，看留谁最好 ────');
  console.log('    （1.5%:3% 结算 · t≥2 且两品种同号才算数 · 下面先看单品种）');
  console.log('组合                            门槛  触发次数  平均间隔    胜率    每笔净R    t值');
  const SUB = [
    ['EMA+MACD+KDJ+BOLL+OBV（全五票）', [0, 1, 4, 5, 6], null],
    ['去掉 BOLL（四票）', [0, 1, 4, 6], null],
    ['BOLL 取反（五票）', [0, 1, 4, 5, 6], 5],
    ['去掉 KDJ+BOLL（三票）', [0, 1, 6], null],
    ['EMA+OBV 两票', [0, 6], null],
    ['EMA+MACD+OBV', [0, 1, 6], null],
    ['EMA+BOLL取反+OBV', [0, 5, 6], 5],
  ];
  const results = [];
  for (const [lab, keepSet, flip] of SUB) {
    const drop = []; for (let k = 0; k < 9; k++) if (!keepSet.includes(k)) drop.push(k);
    for (const mv of [2, 3]) {
      if (mv > keepSet.length) continue;
      const r5b = reVoteEx(r5, mv, drop, flip);
      const r15b = reVoteEx(r15, mv, drop, flip);
      const r1hb = reVoteEx(r1h, mv, drop, flip);
      const tg = triggersOf(r5b, r15b, r1hb, m15, m1h, N);
      if (!tg.length) continue;
      const st = settle(s5, tg, 0.015, 0.030, S.FEE_RATE);
      results.push({ lab, mv, n: tg.length, st });
      console.log(lab.padEnd(30) + ('≥' + mv).padStart(5)
        + pad(tg.length, 9)
        + (days / tg.length * 24).toFixed(1) + 'h'.padStart(4)
        + ((st.winRate * 100).toFixed(1) + '%').padStart(9)
        + st.avgR.toFixed(4).padStart(10)
        + st.t.toFixed(2).padStart(8));
    }
  }
  console.log('\n（基线九票≥4：净R ' + settle(s5, trigs, 0.015, 0.030, S.FEE_RATE).avgR.toFixed(4)
    + ' · 胜率 ' + (settle(s5, trigs, 0.015, 0.030, S.FEE_RATE).winRate * 100).toFixed(1) + '%）');

  /* ---------------- H BOLL 不是同向票，那它能不能当「过热过滤器」 ----------------
     假设：BOLL 的 z 衡量价格偏离中轨多远。它总投反票（91%），是因为它本来就是
     均值回归逻辑。但它单独的方向准确率有 53%（全场最高）→ 说明它的"反向"
     其实是有信息量的警告：**价格已经偏离太远了，此时追进去风险高**。
     如果成立，那么 |z| 越大的触发应该表现越差 → 那它就是个有效的过滤器。 */
  console.log('\n──── 八、BOLL 当「过热过滤器」：按 1h 上价格偏离中轨的 z 分层 ────');
  console.log('    （对基线九票≥4 的 ' + trigs.length + ' 次触发分层，看每组 1.5%:3% 的表现）');
  /* 自己算 1h 的 BOLL z：20 根 SMA ± 2sd */
  const nH = s1h.n, zH = new Float64Array(nH).fill(NaN);
  for (let i = 19; i < nH; i++) {
    let s = 0; for (let x = i - 19; x <= i; x++) s += s1h.c[x];
    const mid = s / 20;
    let ss = 0; for (let x = i - 19; x <= i; x++) { const d = s1h.c[x] - mid; ss += d * d; }
    const sd = Math.sqrt(ss / 20);
    if (sd > 0) zH[i] = (s1h.c[i] - mid) / sd;
  }
  const BUCKETS = [
    ['极端偏离（|z|≥1.6）', t => Math.abs(t.z) >= 1.6],
    ['明显偏离（1.0~1.6）', t => Math.abs(t.z) >= 1.0 && Math.abs(t.z) < 1.6],
    ['温和偏离（0.5~1.0）', t => Math.abs(t.z) >= 0.5 && Math.abs(t.z) < 1.0],
    ['贴近中轨（|z|<0.5）', t => Math.abs(t.z) < 0.5],
  ];
  /* 另外单独看：顺着趋势方向偏离（追涨）vs 逆着（抄底） */
  const withZ = [];
  for (const tg of trigs) {
    const j1h = m1h[tg.i];
    if (j1h < 0 || !isFinite(zH[j1h])) continue;
    withZ.push({ i: tg.i, dir: tg.dir, z: zH[j1h] });
  }
  console.log('分层                       次数    占比     胜率    每笔净R    t值');
  const buckRows = [];
  for (const [lab, fn] of BUCKETS) {
    const sub = withZ.filter(fn);
    if (sub.length < 20) { console.log(lab.padEnd(24) + pad(sub.length, 7) + '  （样本太少）'); continue; }
    const st = settle(s5, sub, 0.015, 0.030, S.FEE_RATE);
    buckRows.push({ lab, n: sub.length, st });
    console.log(lab.padEnd(24) + pad(sub.length, 7)
      + (pct(sub.length, withZ.length).toFixed(1) + '%').padStart(8)
      + ((st.winRate * 100).toFixed(1) + '%').padStart(9)
      + st.avgR.toFixed(4).padStart(10)
      + st.t.toFixed(2).padStart(8));
  }
  /* 追涨 vs 抄底：做多时 z>0 是追涨，做空时 z<0 是追跌 */
  const chase = withZ.filter(t => (t.dir === 1 ? t.z > 0 : t.z < 0));
  const fade = withZ.filter(t => (t.dir === 1 ? t.z < 0 : t.z > 0));
  const stC = settle(s5, chase, 0.015, 0.030, S.FEE_RATE);
  const stF = settle(s5, fade, 0.015, 0.030, S.FEE_RATE);
  console.log('— 顺着偏离方向入场（追）  ' + pad(chase.length, 7)
    + (pct(chase.length, withZ.length).toFixed(1) + '%').padStart(8)
    + ((stC.winRate * 100).toFixed(1) + '%').padStart(9)
    + stC.avgR.toFixed(4).padStart(10) + stC.t.toFixed(2).padStart(8));
  console.log('— 逆着偏离方向入场（抄）  ' + pad(fade.length, 7)
    + (pct(fade.length, withZ.length).toFixed(1) + '%').padStart(8)
    + ((stF.winRate * 100).toFixed(1) + '%').padStart(9)
    + stF.avgR.toFixed(4).padStart(10) + stF.t.toFixed(2).padStart(8));

  /* ---------------- I KDJ 在体系里是不是「死票」 ---------------- */
  console.log('\n──── 九、KDJ 在体系里的实际作用（触发时它在 1h 上的票） ────');
  {
    let same = 0, opp = 0, flat = 0;
    for (const tg of trigs) {
      const j1h = m1h[tg.i]; if (j1h < 0) continue;
      const want = tg.dir === 1 ? 1 : -1;
      const v = r1h.votes[j1h * 9 + 4];
      if (v === 0) flat++; else if (v === want) same++; else opp++;
    }
    const T = trigs.length || 1;
    console.log('KDJ 同向 ' + (same / T * 100).toFixed(1) + '% · 反向 ' + (opp / T * 100).toFixed(1)
      + '% · 弃权 ' + (flat / T * 100).toFixed(1) + '%');
    console.log('→ 在九票≥4 的门槛下，KDJ 有 ' + (flat / T * 100).toFixed(0)
      + '% 的时候根本没表态，它基本不参与定方向。');
  }
})();
