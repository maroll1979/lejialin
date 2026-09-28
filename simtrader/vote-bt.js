/* ============================================================
   vote-bt.js · 九指标投票制 vs 旧八因子加权
   ------------------------------------------------------------
   同一段真实 5m 数据、同一套出场规则（TP1=1R 减半 / TP2=2R /
   止损取 1h 结构与 ATR 取优），只换「入场方向的判定方式」：

     旧：八个因子加权求和 → 阈值判方向 + 5m 结构扣扳机
     新：九个指标各自三态投票 → 赢家票数 ≥ minVotes 且多于反方
         → 1h 定方向 + 15m/5m 同时同向 → 跃变沿触发

   为什么必须对照着跑：换方向判定后笔数会变，绝对收益没有可比性，
   只有「同一批数据、同一套出场」的期望 R 才能说明改进是否有意义。
   ============================================================ */
const S = require('./strategy.js');
const fs = require('fs');

const sym = (process.argv[2] || 'BTCUSDT').toUpperCase();
const YEARS = +(process.argv[3] || 5);
const ONLY = (process.argv[4] || '').toLowerCase();
const CACHE = '../data/bt_' + sym + '_' + YEARS + 'y_5m.json';

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}
/* 逐笔 R 的 t 统计量：判断「这些结果均值不为 0」是不是偶然 */
function tstat(rs) {
  const n = rs.length;
  if (n < 2) return 0;
  const s = sd(rs);
  if (!(s > 0)) return 0;
  return mean(rs) / (s / Math.sqrt(n));
}
function num(v, d) { return (v == null || !isFinite(v)) ? '   -  ' : v.toFixed(d == null ? 3 : d); }

/* 旧体系基线（页面默认严格档：5m 需 CHOCH+回踩+BOS 齐备） */
const OLD_MS = { loose: false, minScore: 0, andDir: false };

const CFG = [
  { key: 'old', label: '旧·八因子加权+5m结构', opt: { msMode: true, ms: OLD_MS } },
  { key: 'v4', label: '新·九指标 ≥4票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 4 } } },
  { key: 'v3', label: '新·九指标 ≥3票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 3 } } },
  { key: 'v5', label: '新·九指标 ≥5票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 5 } } },
  { key: 'v6', label: '新·九指标 ≥6票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 6 } } },
  { key: 'v7', label: '新·九指标 ≥7票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 7 } } },
  { key: 'v8', label: '新·九指标 ≥8票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 8 } } },
  { key: 'v9', label: '新·九指标 全9票', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 9 } } },
  { key: 'noMA', label: '新·去掉MA200票(八票)', opt: { vote: { thz: 0.30, bufPct: 0.005, minVotes: 4 }, dropMa: true } },
  { key: 't20', label: '新·≥4票 阈值0.20', opt: { vote: { thz: 0.20, bufPct: 0.005, minVotes: 4 } } },
  { key: 't40', label: '新·≥4票 阈值0.40', opt: { vote: { thz: 0.40, bufPct: 0.005, minVotes: 4 } } },
  { key: 'buf0', label: '新·≥4票 MA缓冲0', opt: { vote: { thz: 0.30, bufPct: 0, minVotes: 4 } } },
  { key: 'buf1', label: '新·≥4票 MA缓冲1%', opt: { vote: { thz: 0.30, bufPct: 0.010, minVotes: 4 } } },
];

(async () => {
  let rows;
  if (fs.existsSync(CACHE)) {
    rows = JSON.parse(fs.readFileSync(CACHE, 'utf8')).rows;
    console.log('用本地缓存 ' + CACHE + ' · ' + rows.length + ' 根');
  } else {
    const h = await S.fetchHistory(sym, '5m', YEARS, {
      src: 'binance',
      onProgress: p => process.stdout.write('\r拉取中 ' + (p * 100).toFixed(0) + '%   '),
    });
    if (!h.rows.length) throw new Error('未取到历史 K线');
    rows = h.rows;
    try { fs.writeFileSync(CACHE, JSON.stringify(h)); } catch (e) { /* 缓存写失败不影响 */ }
  }
  let s5 = S.toSeries(rows);

  /* ---- 公平裁剪：裁掉「日线 MA200 还没算出来」的那一段 ----
     若不裁，投票制在前 200 天只有 8 票在说话（第九票恒为「平」），
     与旧体系对比时等于换了对手夏普 tickets 的开始条件。
     两边都从同一根开始，差异才只来自「方向怎么判」。 */
  const sTmp = S.aggregate(s5, S.TF_SEC['1d']);
  if (sTmp.n < 220) throw new Error('历史不足，算不出 MA200');
  const maStart0 = sTmp.t[199];                       // 第 200 根日线的起点
  let i0 = 0;
  while (i0 < s5.n && s5.t[i0] < maStart0) i0++;
  if (i0 > 0) {
    const k2 = [];
    for (let i = i0; i < s5.n; i++) {
      k2.push({ time: s5.t[i], open: s5.o[i], high: s5.h[i], low: s5.l[i], close: s5.c[i], volume: s5.v[i] });
    }
    const before = s5.n;
    s5 = S.toSeries(k2);
    console.log('裁掉 MA200 预热段 ' + i0 + ' 根（剩 ' + s5.n + ' / ' + before + '）· 起 '
      + new Date(s5.t[0] * 1000).toISOString().slice(0, 10));
  }
  console.log('5m ' + s5.n + ' 根 · 源 币安现货');

  /* 与配置无关的共享计算：聚合 + 日线 MA200 铺到各周期。
     ★ MA200 一律取「已收盘日线」，盘中不准偷看当天未走完的日线。 */
  const shared = {
    s15: S.aggregate(s5, S.TF_SEC['15m']),
    s1h: S.aggregate(s5, S.TF_SEC['1h']),
    s1d: S.aggregate(s5, S.TF_SEC['1d']),
  };
  shared.ma5 = S.dailyMa200Lookup(s5, shared.s1d, 200, S.TF_SEC['5m']);
  shared.ma15 = S.dailyMa200Lookup(shared.s15, shared.s1d, 200, S.TF_SEC['15m']);
  shared.ma1h = S.dailyMa200Lookup(shared.s1h, shared.s1d, 200, S.TF_SEC['1h']);
  /* 共享覆盖率检查：MA200 可用区间占全样本多少（不足 200 根日线的开头必然无效） */
  let maOK = 0;
  for (let i = 0; i < s5.n; i++) if (isFinite(shared.ma5[i])) maOK++;
  console.log('日线 ' + shared.s1d.n + ' 根 · MA200 可覆盖 5m 的 '
    + (100 * maOK / s5.n).toFixed(1) + '%（开头需 200 根日线预热）');

  /* 旧体系的三周期方向序列与配置无关，算一次共用 */
  const oldCache = Object.assign({}, shared, {
    r5: S.dirSeries(s5), r15: S.dirSeries(shared.s15), r1h: S.dirSeries(shared.s1h),
  });

  const list = ONLY ? CFG.filter(c => c.key.toLowerCase() === ONLY) : CFG;

  console.log('\n' + '配置'.padEnd(24) + '笔数'.padStart(7) + '胜率'.padStart(8)
    + '净R'.padStart(9) + '每笔'.padStart(8) + '毛利R'.padStart(9) + '费R'.padStart(9)
    + 't(净)'.padStart(8) + '回撤'.padStart(8) + '多/空'.padStart(9));
  console.log('-'.repeat(92));

  const results = {};
  for (const c of list) {
    const cache = c.opt.vote ? shared : oldCache;
    let opt = Object.assign({}, c.opt, { cache: cache, msMode: c.opt.vote ? false : c.opt.msMode });
    /* dropMa：把第九票换成 NaN（ma200Vote 会因 ma 无效返回「平」），
       用来隔离 MA200 这一票到底贡献了什么 */
    if (c.opt.dropMa) {
      const z8 = { ma5: new Float64Array(s5.n).fill(NaN) };
      z8.ma15 = new Float64Array(shared.s15.n).fill(NaN);
      z8.ma1h = new Float64Array(shared.s1h.n).fill(NaN);
      opt.cache = Object.assign({}, shared, z8);
    }
    const r = S.backtestCore(s5, opt);
    const rs = r.trades.map(t => t.r);
    const gr = r.trades.map(t => t.grossR);
    results[c.key] = { cfg: c, res: r, rs: rs, gr: gr, tNet: tstat(rs), tGross: tstat(gr) };
    console.log(c.label.padEnd(24)
      + String(r.count).padStart(7)
      + (r.winRate * 100).toFixed(1).padStart(7) + '%'
      + num(r.totalR, 1).padStart(9)
      + num(r.avgR, 3).padStart(8)
      + num(r.grossR, 1).padStart(9)
      + num(-r.feeR, 1).padStart(9)
      + num(results[c.key].tNet, 2).padStart(8)
      + (r.maxDD * 100).toFixed(1).padStart(7) + '%'
      + (r.longCount + '/' + r.shortCount).padStart(9));
  }

  /* ---------- 结论：与基线比收益率更可靠：按年分布 ---------- */
  function byYear(rs, times) {
    const m = {};
    for (let i = 0; i < rs.length; i++) {
      const y = new Date(times[i] * 1000).getUTCFullYear();
      m[y] = m[y] || []; m[y].push(rs[i]);
    }
    return Object.keys(m).sort().map(y => ({ y: y, r: m[y].reduce((a, b) => a + b, 0), n: m[y].length }));
  }

  console.log('\n【按年净 R】');
  const yearsSet = new Set();
  for (const k of Object.keys(results)) {
    const r = results[k].res;
    byYear(results[k].rs, r.trades.map(t => t.time)).forEach(o => yearsSet.add(o.y));
  }
  const ys = Array.from(yearsSet).sort();
  console.log('配置'.padEnd(24) + ys.map(y => (y + '(' + 'n' + ')').padStart(14)).join(''));
  for (const k of Object.keys(results)) {
    const r = results[k].res;
    const m = byYear(results[k].rs, r.trades.map(t => t.time));
    const row = ys.map(y => {
      const o = m.find(x => x.y === y);
      return o ? (num(o.r, 1) + '(' + o.n + ')').padStart(14) : '      -     '.padStart(14);
    }).join('');
    console.log(results[k].cfg.label.padEnd(24) + row);
  }

  /* ---------- 费率敏感性：毛利既然显著为正，就要知道降到多少能转正 ----------
     同一批入场点、同一套出场，只有摩擦不同 —— 这样才能分离「策略」与「成本」。 */
  if (!ONLY) {
    const V = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
    console.log('\n【费率敏感性 · 九指标 ≥4票】');
    console.log('双边费率'.padEnd(12) + '每笔费R'.padStart(10) + '每笔毛利R'.padStart(11)
      + '每笔净R'.padStart(10) + '总净R'.padStart(10) + 't(净)'.padStart(8) + '年化'.padStart(10));
    console.log('-'.repeat(72));
    const feeList = [0.0010, 0.0008, 0.0006, 0.0004, 0.0002, 0.0001, 0];
    for (const f of feeList) {
      const r = S.backtestCore(s5, { vote: V, feeRate: f, cache: shared, msMode: false });
      const rs = r.trades.map(t => t.r);
      console.log(((f * 100).toFixed(3) + '%').padEnd(12)
        + num(r.avgFeeR, 4).padStart(10)
        + num(r.grossR / Math.max(1, r.count), 4).padStart(11)
        + num(r.avgR, 4).padStart(10)
        + num(r.totalR, 1).padStart(10)
        + num(tstat(rs), 2).padStart(8)
        + (r.annRet * 100).toFixed(1).padStart(9) + '%');
    }
  }

  /* ---------- 新 vs 老：每笔 t 值与手续费占比 ---------- */
  console.log('\n【关键对比】');
  for (const k of Object.keys(results)) {
    const r = results[k].res;
    if (!r.count) continue;
    console.log('  ' + results[k].cfg.label.padEnd(24)
      + '每笔净 ' + num(r.avgR, 3) + 'R'
      + ' · 每笔费 ' + num(r.avgFeeR, 3) + 'R'
      + ' · 止损宽 ' + (r.avgRiskPct * 100).toFixed(2) + '%'
      + ' · 平均持仓 ' + num(r.avgHoldHours, 1) + 'h'
      + ' · t(毛利) ' + num(results[k].tGross, 2));
  }
})().catch(e => { console.error('\n[X] ' + (e && e.stack || e)); process.exit(1); });
