/* ============================================================================
 * liq-replay.js — 方案 A：把「信号」和「流动性结构」结合，做历史回放
 * ============================================================================
 *
 * 【背景：前面已经证伪了什么】
 *   · 换因子、砍因子、调阈值 → 报警更少，不解决
 *   · 换入场方式（市价 / 等回踩 / 等不回踩 / 加仓）→ 四种全不行
 *   · 病灶定位：99.3% 的入场是「顺着价格偏离方向追进去」的
 *   ⇒ 结论是信号本身没有方向性优势。所以方案 A 不碰信号，只加**结构过滤器**。
 *
 * 【方案 A 做什么】
 *   在信号触发的那一刻，同时看一眼流动性结构（用 K 线重建的 Volume Profile，
 *   因为历史真实挂单拿不到 —— 见 volprofile.js 头注释），然后决定要不要这单。
 *
 * 【★ 本办法的三条纪律】
 *   1) 过滤器不改入场价，所以收益变化 **100% 是筛选效应**。
 *      因此判定标准不是「选中组赚不赚钱」，而是「选中组 vs 放弃组」差多少。
 *      只看选中组会自我欺骗 —— 涨势里任何过滤器都好看。
 *   2) 必须看**分层单调性**。只有阈值卡出来的最好一组是不作数的，
 *      换了阈值就散掉的规律是噪声。
 *   3) 扫描多个特征 × 多个阈值，最优组必然好看 —— 所以要跑**块置换检验**：
 *      把特征和结果随机配对后重扫一遍，看真实最优能不能打赢随机最优。
 *
 * 用法：node liq-replay.js [SYM] [YEARS] [PERM]
 * ========================================================================== */
'use strict';
const S = require('./simtrader/strategy.js');
const V = require('./volprofile.js');
const fs = require('fs');

const sym = process.argv[2] || 'BTCUSDT';
const YEARS = +(process.argv[3] || 2);
const PERM = +(process.argv[4] || 200);               // 置换次数
const CACHE = 'data/m1_' + sym + '_' + YEARS + 'y.json';
const SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

const WINDOWS = [60, 240, 720];                        // VP 窗口（1m 根）：1h / 4h / 12h
const MAIN_W = 240;
const BINS = 72;
const VASHARE = 0.70;
const WINPCT = 0.12;
const PLANS = [
  { lab: '1.5%:3%', stop: 0.015, tp: 0.030 },
  { lab: '2%:4%', stop: 0.020, tp: 0.040 }
];
const MAX_HOLD = Math.round(7 * 86400 / 300);
const FEE = S.FEE_RATE;
const BLK = 20;                                        // 置换块长（保留信号的时间聚集性）
const QS = [0.5, 0.6, 0.7, 0.8, 0.9];                  // 扫描的分位（★必须定义在调用点之前，否则 TDZ）
/* ★ 最小样本约束：不设的话，某个分位切出 20 笔的极小组就能刷出 t=20+ 的假象
   （实测随机最优里出现过 t=22.94），随机分布被它抬到天上，检验就失去意义。
   同 QS，必须定义在调用点之前。 */
const MIN_SEL = 100;

const pad = (s, n) => String(s).padStart(n);
const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(4);
const f3 = v => v == null ? '   --  ' : ((v >= 0 ? '+' : '') + v.toFixed(3));

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/* 触发点（只在刚凑齐三周期同向的那一根响一次） */
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
    if (on && !prev) out.push({ i: i, dir: r1h.dirs[j1h] });
    prev = on;
  }
  return out;
}

/* 出场（口径与 bt-pullback 完全一致：5m 撮合、先判止损、最多 7 天） */
function outcome(s5, k0, entry, dir, stopPct, tpPct, fee) {
  const up = dir === 1;
  const stop = up ? entry * (1 - stopPct) : entry * (1 + stopPct);
  const tp = up ? entry * (1 + tpPct) : entry * (1 - tpPct);
  const end = Math.min(s5.n, k0 + MAX_HOLD);
  for (let j = k0; j < end; j++) {
    if (up ? s5.l[j] <= stop : s5.h[j] >= stop) return { r: -(stopPct + fee * (2 - stopPct)) / stopPct, how: 'stop' };
    if (up ? s5.h[j] >= tp : s5.l[j] <= tp) return { r: (tpPct - fee * (2 + tpPct)) / stopPct, how: 'tp' };
  }
  const last = Math.min(s5.n - 1, k0 + MAX_HOLD - 1);
  const pnl = up ? (s5.c[last] - entry) / entry : (entry - s5.c[last]) / entry;
  return { r: (pnl - fee * 2) / stopPct, how: 'expire' };
}

function stats(Rs) {
  if (!Rs.length) return { n: 0, avg: 0, t: 0, win: 0, sd: 0 };
  let sum = 0; for (const v of Rs) sum += v;
  const m = sum / Rs.length;
  let ss = 0; for (const v of Rs) ss += (v - m) * (v - m);
  const sd = Rs.length > 1 ? Math.sqrt(ss / (Rs.length - 1)) : 0;
  return { n: Rs.length, avg: m, t: m / ((sd || 1e-9) / Math.sqrt(Rs.length)), win: Rs.filter(v => v > 0).length / Rs.length, sd: sd };
}

/* 两样本 t（选中组 vs 放弃组） */
function twoSample(a, b) {
  if (a.length < 3 || b.length < 3) return { t: 0, diff: 0 };
  const sa = stats(a), sb = stats(b);
  const se = Math.sqrt(sa.sd * sa.sd / a.length + sb.sd * sb.sd / b.length) || 1e-9;
  return { t: (sa.avg - sb.avg) / se, diff: sa.avg - sb.avg, sa: sa, sb: sb };
}

/* ---------- 特征定义（方向化后，越大 = 越有利；都不预设符号好坏） ---------- */
const FEATS = [
  { key: 'thinEdge', lab: '薄带方向' },      // 上方比下方薄 → 做多有利
  { key: 'cheapEdge', lab: '便宜度' },       // 现价在 POC 下方 → 做多有利（没追高）
  { key: 'roomEdge', lab: '目标薄带距' },    // 目标方向薄带到现价的距离
  { key: 'guardEdge', lab: '止损薄带距' },   // 止损方向薄带到现价的距离
  { key: 'posVA', lab: 'VA内位置' },         // 0=下沿 1=上沿
  { key: 'vaWidth', lab: 'VA宽度' },         // 价值区相对宽度
  { key: 'posSpanEdge', lab: '低位度' }      // 现价在窗口视野中的低位程度（连续，不丢样本）
];

/* 组合规则：必须放进置换搜索空间，否则「组合更好看」就是在置换之外挑樱桃 */
const COMBOS = [
  { lab: '便宜∧薄', keys: ['cheapEdge', 'thinEdge'], op: 'and' },
  { lab: '便宜∨薄', keys: ['cheapEdge', 'thinEdge'], op: 'or' },
  { lab: '低位∧薄', keys: ['posSpanEdge', 'thinEdge'], op: 'and' },
  { lab: '低位∨薄', keys: ['posSpanEdge', 'thinEdge'], op: 'or' }
];

(async () => {
  if (!fs.existsSync(CACHE)) { console.error('缺缓存 ' + CACHE + '，请先跑 bt-pct.js 拉数'); process.exit(1); }
  console.log('加载 ' + CACHE + ' ...');
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const s1m = S.toSeries(raw.rows);
  const s5 = S.aggregate(s1m, SEC['5m']);
  const s15 = S.aggregate(s5, SEC['15m']);
  const s1h = S.aggregate(s5, SEC['1h']);
  const s1d = S.aggregate(s5, SEC['1d']);
  const N = s5.n, days = (s5.t[N - 1] - s5.t[0]) / 86400;

  console.log('\n════════ ' + sym + ' · ' + N.toLocaleString('en-US') + ' 根 5m · '
    + days.toFixed(0) + ' 天 · 方案A：信号 × 流动性结构 ════════');
  console.log('单边费率 ' + (FEE * 100).toFixed(3) + '% · VP 窗口 ' + WINDOWS.join('/') + ' 根 1m · '
    + BINS + ' 格 · VA=' + VASHARE + '\n');

  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, SEC['5m']);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, SEC['15m']);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, SEC['1h']);
  const m15 = S.buildClosedMap(s5.t, s15.t, SEC['5m'], SEC['15m']);
  const m1h = S.buildClosedMap(s5.t, s1h.t, SEC['5m'], SEC['1h']);
  const Vc = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
  const r5 = S.voteSeries(s5, ma5, Vc);
  const r15 = S.voteSeries(s15, ma15, Vc);
  const r1h = S.voteSeries(s1h, ma1h, Vc);
  const trigs = triggersOf(r5, r15, r1h, m15, m1h, N);

  /* ---------- 每个触发点：基线 R + 各窗口的结构特征 ---------- */
  const recs = [];
  let noFeat = 0;
  for (const tg of trigs) {
    const i = tg.i;
    const kEntry = i + 1;
    if (kEntry >= s5.n - 1) continue;
    const P0 = s5.o[kEntry];
    const base = {};
    for (const P of PLANS) base[P.lab] = outcome(s5, kEntry, P0, tg.dir, P.stop, P.tp, FEE).r;
    const tEnd = s5.t[kEntry];
    const feats = {};
    let okAny = false;
    for (const W of WINDOWS) {
      const w = V.windowBefore(s1m, tEnd, W);
      const prof = V.buildProfile(s1m, w.from, w.to, BINS);
      const f = prof ? V.structureAt(prof, P0, { winPct: WINPCT, vaShare: VASHARE, anchor: 'price' }) : null;
      feats[W] = f ? V.directional(f, tg.dir) : null;
      if (f) okAny = true;
    }
    if (!okAny) { noFeat++; continue; }
    recs.push({ i: i, dir: tg.dir, P0: P0, base: base, feats: feats, t: tEnd });
  }
  console.log('触发 ' + trigs.length + ' 次 · 可评估 ' + recs.length + ' 次（结构缺失 ' + noFeat + '）· 平均 '
    + (days / recs.length * 24).toFixed(1) + ' 小时一次\n');

  /* ---------- 一、基线 ---------- */
  console.log('──── 一、基线：信号后市价成交，不加任何结构过滤 ────');
  for (const P of PLANS) {
    const st = stats(recs.map(x => x.base[P.lab]));
    console.log('  ' + P.lab.padEnd(9) + ' 笔数 ' + pad(st.n, 5)
      + '  胜率 ' + (st.win * 100).toFixed(1).padStart(5) + '%'
      + '  净R ' + pad(f2(st.avg), 9) + '  t=' + pad(st.t.toFixed(2), 6));
  }

  const PLAN = PLANS[0].lab;
  const R = recs.map(x => x.base[PLAN]);

  /* ---------- 二、五分位分层（看单调性，这是硬指标） ---------- */
  console.log('\n──── 二、分层单调性：按特征值分 5 档，看净 R 是否一路走高 ────');
  console.log('  （窗口 ' + MAIN_W + ' 根 1m，结算 ' + PLAN + '。真规律 → 单调递增/递减；噪声 → 忽高忽低）');
  for (const F of FEATS) {
    const vals = recs.map(x => { const f = x.feats[MAIN_W]; return f ? f[F.key] : null; });
    const idx = [];
    for (let j = 0; j < vals.length; j++) if (vals[j] != null) idx.push(j);
    idx.sort((a, b) => vals[a] - vals[b]);
    const q = 5, per = Math.floor(idx.length / q);
    const cells = [];
    for (let k = 0; k < q; k++) {
      const part = idx.slice(k * per, k === q - 1 ? idx.length : (k + 1) * per);
      const st = stats(part.map(j => R[j]));
      cells.push(st);
    }
    const avgs = cells.map(c => c.avg);
    /* 单调性打分：相邻档同号变化的比例 */
    let mono = 0;
    for (let k = 1; k < avgs.length; k++) if ((avgs[k] - avgs[k - 1]) * (avgs[avgs.length - 1] - avgs[0]) > 0) mono++;
    console.log('\n  ' + F.lab + ' (' + F.key + ')  样本 ' + idx.length);
    console.log('    档位      ' + cells.map((c, k) => pad('Q' + (k + 1), 9)).join(''));
    console.log('    净R       ' + cells.map(c => pad(f2(c.avg), 9)).join(''));
    console.log('    胜率      ' + cells.map(c => pad((c.win * 100).toFixed(1) + '%', 9)).join(''));
    console.log('    笔数      ' + cells.map(c => pad(c.n, 9)).join(''));
    console.log('    单调 ' + mono + '/4  首尾差 ' + f2(avgs[avgs.length - 1] - avgs[0])
      + '  （Q5−Q1 的 t=' + twoSample(idx.slice(4 * per).map(j => R[j]), idx.slice(0, per).map(j => R[j])).t.toFixed(2) + '）');
  }

  /* ---------- 三、阈值过滤：选中 vs 放弃（★真正的判定口径） ---------- */
  console.log('\n\n──── 三、★选中 vs 放弃★：过滤器的全部价值都在这里 ────');
  console.log('  只看「选中组赚没赚」会自欺（牛市里随便过滤都好看）；');
  console.log('  必须看「选中组 − 放弃组」。差值 = 纯筛选效应。');
  for (const F of FEATS) {
    console.log('\n  ── ' + F.lab + ' (' + F.key + ') ──');
    console.log('    分位   选中n  选中R     放弃n  放弃R     差值      t');
    for (const W of WINDOWS) {
      const pairs = [];
      for (let j = 0; j < recs.length; j++) {
        const f = recs[j].feats[W];
        if (!f || f[F.key] == null) continue;
        pairs.push([f[F.key], R[j]]);
      }
      if (pairs.length < 40) continue;
      for (const q of [0.5, 0.7, 0.8, 0.9]) {
        const cut = quantile(pairs.map(p => p[0]), q);
        const sel = [], rej = [];
        for (const p of pairs) (p[0] >= cut ? sel : rej).push(p[1]);
        const ts = twoSample(sel, rej);
        console.log('    ' + (W + 'm').padEnd(6) + pad((q * 100).toFixed(0) + '%', 6)
          + pad(sel.length, 7) + pad(f2(stats(sel).avg), 10)
          + pad(rej.length, 7) + pad(f2(stats(rej).avg), 10)
          + pad(f2(ts.diff), 10) + pad(ts.t.toFixed(2), 7) + (Math.abs(ts.t) >= 2 ? ' *' : ''));
      }
    }
  }

  /* ---------- 四、组合过滤 ---------- */
  console.log('\n\n──── 四、组合：不追高 + 上方薄（两个最直观的假说叠加）────');
  console.log('  组合            n     净R      胜率    放弃R     差值     t');
  for (const W of [MAIN_W]) {
    for (const q of [0.5, 0.7]) {
      const cs = quantile(pick(W, 'cheapEdge'), q), ts2 = quantile(pick(W, 'thinEdge'), q);
      const sel = [], rej = [];
      for (let j = 0; j < recs.length; j++) {
        const f = recs[j].feats[W];
        if (!f || f.cheapEdge == null || f.thinEdge == null) continue;
        (f.cheapEdge >= cs && f.thinEdge >= ts2 ? sel : rej).push(R[j]);
      }
      const t2 = twoSample(sel, rej);
      console.log('  ' + ('便宜+' + (q * 100) + '%').padEnd(14) + pad(sel.length, 6)
        + pad(f2(stats(sel).avg), 9) + pad((stats(sel).win * 100).toFixed(1) + '%', 8)
        + pad(f2(stats(rej).avg), 9) + pad(f2(t2.diff), 10) + pad(t2.t.toFixed(2), 7));
      const sel2 = [], rej2 = [];
      for (let j = 0; j < recs.length; j++) {
        const f = recs[j].feats[W];
        if (!f || f.cheapEdge == null || f.thinEdge == null) continue;
        (f.cheapEdge >= cs || f.thinEdge >= ts2 ? sel2 : rej2).push(R[j]);
      }
      const t3 = twoSample(sel2, rej2);
      console.log('  ' + ('便宜或薄' + (q * 100) + '%').padEnd(14) + pad(sel2.length, 6)
        + pad(f2(stats(sel2).avg), 9) + pad((stats(sel2).win * 100).toFixed(1) + '%', 8)
        + pad(f2(stats(rej2).avg), 9) + pad(f2(t3.diff), 10) + pad(t3.t.toFixed(2), 7));
    }
  }

  /* ---------- 五、★ 块置换检验 ---------- */
  console.log('\n\n──── 五、★块置换检验★：真实最优能不能打赢随机最优 ────');
  console.log('  上面扫了 ' + ((FEATS.length + COMBOS.length) * WINDOWS.length * 5)
    + ' 个组合（单特征 ' + FEATS.length + ' + 组合 ' + COMBOS.length + '）× 窗口 × 5 个分位，最好的那组好看是必然的。');
  console.log('  把特征和结果随机配对（按 ' + BLK + ' 个信号为一块整体挪动，保留时间聚集性）重扫 ' + PERM + ' 次，');
  console.log('  看真实最优在随机分布里排第几 ---- 排不进前 5% 就是选择偏差，不是 alpha。');

  /* 真实最优 */
  const realBest = scanBest(false);
  /* 置换 */
  const dist = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let b = 0; b < PERM; b++) {
    const perm = blockPerm(recs.length, BLK, rnd);
    dist.push(scanBest(perm));
  }
  dist.sort((a, b) => a.t - b.t);
  const rank = dist.filter(d => d.t < realBest.t).length;
  const pval = 1 - rank / dist.length;
  console.log('\n  真实最优：' + realBest.desc);
  console.log('           选中 ' + realBest.sel.length + ' 笔 净R ' + f2(realBest.selAvg)
    + ' vs 放弃 ' + realBest.rej.length + ' 笔 净R ' + f2(realBest.rejAvg)
    + '  差值 ' + f2(realBest.diff) + '  t=' + realBest.t.toFixed(2));
  console.log('  随机最优分布（' + PERM + ' 次）：中位数 t=' + dist[Math.floor(dist.length / 2)].t.toFixed(2)
    + '  95 分位 t=' + dist[Math.floor(dist.length * 0.95)].t.toFixed(2)
    + '  最大 t=' + dist[dist.length - 1].t.toFixed(2));
  console.log('  → 真实最优在随机中排第 ' + (rank + 1) + '/' + dist.length + '，p≈' + pval.toFixed(3)
    + (pval < 0.05 ? '  ★ 显著，可能真有东西' : '  ★★★ 不显著 —— 这是选择偏差，不是 alpha'));
  console.log('  （每组至少 ' + MIN_SEL + ' 笔才参与评选，否则 20 笔的小组能刷出 t=20+ 的假象）');
  console.log('BEST_RULE=' + realBest.kind);

  /* ---------- 六、跨品种迁移：别的品种找到的规则，在我这儿还好使吗 ---------- */
  const APPLY = process.argv[5] || '';
  if (APPLY) {
    console.log('\n\n──── 六、★跨品种迁移★：把另一个品种的最优规则原样搬过来 ────');
    console.log('  真规律应该跨品种同号；换一个品种就反号的，是拟合噪声。');
    console.log('  规则 ' + APPLY + '（分位取相对值，各品种按自己的分布切）');
    const e = evalRule(APPLY);
    if (!e) {
      console.log('  规则解析失败');
    } else {
      const ts = twoSample(e.sel, e.rej);
      console.log('  选中 ' + pad(e.sel.length, 5) + ' 笔 净R ' + pad(f2(e.selAvg), 9)
        + '  放弃 ' + pad(e.rej.length, 5) + ' 笔 净R ' + pad(f2(e.rejAvg), 9)
        + '  差值 ' + pad(f2(ts.diff), 9) + '  t=' + ts.t.toFixed(2));
      console.log('  → 与来源品种同号且 |t|≥2 才算迁移成功；反号或接近 0 就是过拟合。');
    }
  }

  /* 辅助 */
  function pick(W, key) {
    const out = [];
    for (const x of recs) { const f = x.feats[W]; out.push(f && f[key] != null ? f[key] : null); }
    return out;
  }
  function quantile(arrIn, q) {
    const a = arrIn.filter(v => v != null).slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const pos = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))));
    return a[pos];
  }
  /* 扫描所有 (单特征 / 组合 × 窗口 × 分位)，返回 t 值最大的那个。
     ★ 单特征和组合必须扫在同一空间里 —— 否则「组合更好看」就是在置换之外挑樱桃。 */
  function consider(best, sel, rej, desc, kind) {
    if (sel.length < MIN_SEL || rej.length < MIN_SEL) return best;
    const ts = twoSample(sel, rej);
    if (ts.t > best.t) {
      best.kind = kind;
      best.t = ts.t; best.diff = ts.diff; best.sel = sel; best.rej = rej;
      best.selAvg = stats(sel).avg; best.rejAvg = stats(rej).avg; best.desc = desc;
    }
    return best;
  }
  function scanBest(perm) {
    let best = { t: -1e9 };
    const rr = j => (perm ? R[perm[j]] : R[j]);
    for (const W of WINDOWS) {
      /* 单特征 */
      for (const F of FEATS) {
        const vals = [];
        for (let j = 0; j < recs.length; j++) { const f = recs[j].feats[W]; vals.push(f ? f[F.key] : null); }
        for (const q of QS) {
          const cut = quantile(vals, q);
          const sel = [], rej = [];
          for (let j = 0; j < recs.length; j++) {
            if (vals[j] == null) continue;
            (vals[j] >= cut ? sel : rej).push(rr(j));
          }
          consider(best, sel, rej, F.lab + ' · ' + W + 'm · 取前 ' + ((1 - q) * 100).toFixed(0) + '%',
            'f:' + F.key + '|' + W + '|' + q);
        }
      }
      /* 组合 */
      for (const C of COMBOS) {
        const v1 = [], v2 = [];
        for (let j = 0; j < recs.length; j++) {
          const f = recs[j].feats[W];
          v1.push(f && f[C.keys[0]] != null ? f[C.keys[0]] : null);
          v2.push(f && f[C.keys[1]] != null ? f[C.keys[1]] : null);
        }
        for (const q of QS) {
          const c1 = quantile(v1, q), c2 = quantile(v2, q);
          const sel = [], rej = [];
          for (let j = 0; j < recs.length; j++) {
            if (v1[j] == null || v2[j] == null) continue;
            const a = v1[j] >= c1, b = v2[j] >= c2;
            ((C.op === 'and' ? (a && b) : (a || b)) ? sel : rej).push(rr(j));
          }
          consider(best, sel, rej, C.lab + ' · ' + W + 'm · 取前 ' + ((1 - q) * 100).toFixed(0) + '%',
            'c' + COMBOS.indexOf(C) + '|' + W + '|' + q);
        }
      }
    }
    return best;
  }
  /* 按规则 kind 在**本品种**上评估（用于跨品种迁移：另一品种把它的最优规则丢过来测） */
  function evalRule(kind) {
    const p = String(kind).split('|');
    const W = +p[1], q = +p[2];
    const vals1 = [], vals2 = [];
    let keys, op = null;
    if (p[0][0] === 'f') {
      keys = [p[0].slice(2), null];
    } else {
      const C = COMBOS[+p[0].slice(1)];
      if (!C) return null;
      keys = [C.keys[0], C.keys[1]];
      op = C.op;
    }
    for (let j = 0; j < recs.length; j++) {
      const f = recs[j].feats[W];
      vals1.push(f && f[keys[0]] != null ? f[keys[0]] : null);
      vals2.push(keys[1] && f ? (f[keys[1]] != null ? f[keys[1]] : null) : null);
    }
    const c1 = quantile(vals1, q);
    const sel = [], rej = [];
    if (!keys[1]) {
      for (let j = 0; j < recs.length; j++) { if (vals1[j] == null) continue; (vals1[j] >= c1 ? sel : rej).push(R[j]); }
    } else {
      const c2 = quantile(vals2, q);
      for (let j = 0; j < recs.length; j++) {
        if (vals1[j] == null || vals2[j] == null) continue;
        const a = vals1[j] >= c1, b = vals2[j] >= c2;
        ((op === 'and' ? (a && b) : (a || b)) ? sel : rej).push(R[j]);
      }
    }
    const ts = twoSample(sel, rej);
    return { sel: sel, rej: rej, t: ts.t, diff: ts.diff, selAvg: stats(sel).avg, rejAvg: stats(rej).avg, n: sel.length };
  }
  /* 块置换：把 [0,n) 按 BLK 切成若干块，块内顺序不变，块之间随机重排 */
  function blockPerm(n, blk, rnd) {
    const blocks = [];
    for (let i = 0; i < n; i += blk) blocks.push(Math.floor(i / blk));
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = blocks[i]; blocks[i] = blocks[j]; blocks[j] = t;
    }
    const out = new Array(n);
    let p = 0;
    for (const b of blocks) for (let i = b * blk; i < Math.min(n, (b + 1) * blk); i++) out[p++] = i;
    return out;
  }
})().catch(e => { console.error('FAIL', e && e.stack); process.exit(1); });
