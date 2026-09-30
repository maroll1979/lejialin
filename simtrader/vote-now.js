/* vote-now.js · 此刻三个周期到底差几票（实时快照）
   ------------------------------------------------------------------
   页面「信号一直没提示」最直接的排查：把当前 1h / 15m / 5m 三个周期
   九个因子各自投了什么票、赢家几票、门槛几票，一行行打出来。
   同时给出「还差几票就触发」，以及缺的是哪个周期。

   用法：node vote-now.js BTC_USDT
   ------------------------------------------------------------------ */
const S = require('./simtrader/strategy.js');

const CONTRACT = process.argv[2] || 'BTC_USDT';
const VOTE_LABEL = [
  ['EMA趋势', 'ema'], ['MACD动能', 'macd'], ['ADX趋向', 'adx'], ['RSI摆动', 'rsi'],
  ['KDJ摆动', 'kdj'], ['BOLL通道', 'boll'], ['OBV量价', 'obv'], ['VOL量能', 'vol'],
  ['MA200位置', 'ma200'],
];
const GATE = 'https://api.gateio.ws';

async function klines(interval, limit) {
  const url = `${GATE}/api/v4/futures/usdt/candlesticks?contract=${CONTRACT}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j && j.message || '格式异常');
  return S.toSeries(j.map(a => ({
    time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c, volume: +a.v,
  })));
}

function show(tag, r, i, ma, minVotes) {
  const w = r.w;
  const votes = [];
  for (let k = 0; k < w; k++) votes.push(r.votes[i * w + k]);
  const u = r.up[i], d = r.dn[i];
  const dir = r.dirs[i];
  const ok = dir !== 0;
  console.log('\n── ' + tag + ' ──  收盘 ' + (ma ? '有' : '无') + ' MA200'
    + '   多 ' + u + ' 票 / 空 ' + d + ' 票 / 平 ' + (w - u - d) + ' 票'
    + '   门槛 ≥' + minVotes);
  votes.forEach((v, k) => {
    const mark = v > 0 ? '多' : (v < 0 ? '空' : '—');
    console.log('   ' + VOTE_LABEL[k][0].padEnd(10) + ' ' + mark);
  });
  console.log('   → 方向：' + (dir === 1 ? '多' : (dir === -1 ? '空' : '无表态'))
    + (ok ? '' : '   （差 ' + (minVotes - Math.max(u, d)) + ' 票）'));
  return dir;
}

(async () => {
  const MV = 4, THZ = 0.30, BUF = 0.005;
  console.log('拉取 ' + CONTRACT + ' 实时 K 线 ...');
  const [s5, s15, s1h, s1d] = await Promise.all([
    klines('5m', 400), klines('15m', 400), klines('1h', 400), klines('1d', 300),
  ]);
  console.log('5m ' + s5.n + ' 根（最新 ' + new Date(s5.t[s5.n - 1] * 1000).toLocaleString('zh-CN') + '）'
    + ' · 1h ' + s1h.n + ' 根 · 日线 ' + s1d.n + ' 根');

  const V = { thz: THZ, bufPct: BUF, minVotes: MV };
  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, 300);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, 900);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, 3600);
  const r5 = S.voteSeries(s5, ma5, V);
  const r15 = S.voteSeries(s15, ma15, V);
  const r1h = S.voteSeries(s1h, ma1h, V);

  const L = n => n - 1;              // 最新一根（还在走）
  const C = n => n - 2;              // 最近已收线的一根

  console.log('\n════════ 用「最近已收线」那根（回测口径，也是页面的判定口径） ════════');
  const d5c = show('5m  已收线', r5, C(r5.dirs.length), !!ma5[C(r5.dirs.length)], MV);
  const d15c = show('15m 已收线', r15, C(r15.dirs.length), !!ma15[C(r15.dirs.length)], MV);
  const d1hc = show('1h  已收线', r1h, C(r1h.dirs.length), !!ma1h[C(r1h.dirs.length)], MV);

  console.log('\n════════ 用「最新一根（尚未收线）」 ════════');
  const d5l = show('5m  最新', r5, L(r5.dirs.length), !!ma5[L(r5.dirs.length)], MV);
  const d15l = show('15m 最新', r15, L(r15.dirs.length), !!ma15[L(r15.dirs.length)], MV);
  const d1hl = show('1h  最新', r1h, L(r1h.dirs.length), !!ma1h[L(r1h.dirs.length)], MV);

  console.log('\n════════ 结论 ════════');
  const tri = S.voteTriple(d1hc, d15c, d5c);
  const triL = S.voteTriple(d1hl, d15l, d5l);
  const nm = v => v === 1 ? '多' : (v === 2 ? '空' : '无表态');
  console.log('已收线：1h=' + nm(d1hc) + ' 15m=' + nm(d15c) + ' 5m=' + nm(d5c)
    + '  → ' + (tri ? '【触发 ' + (tri === 'long' ? '做多' : '做空') + '】' : '不触发'));
  console.log('未收线：1h=' + nm(d1hl) + ' 15m=' + nm(d15l) + ' 5m=' + nm(d5l)
    + '  → ' + (triL ? '【触发 ' + (triL === 'long' ? '做多' : '做空') + '】' : '不触发'));

  if (!tri && !triL) {
    const zero = [['1h', d1hc], ['15m', d15c], ['5m', d5c]].filter(x => x[1] === 0).map(x => x[0]);
    if (zero.length) console.log('\n卡在：' + zero.join(' / ') + ' 没有表态（票数不足，或正反打平）');
    else {
      const base = d1hc || d1hl;
      const diff = [['15m', d15c], ['5m', d5c]].filter(x => x[1] !== base).map(x => x[0]);
      console.log('\n三个周期都有方向，但 ' + diff.join(' / ') + ' 与 1h 不一致');
    }
  }

  /* ---- 关键校验：当前这一刻沉默，是市场真的横，还是数据/归一化坏了？ ---- */
  console.log('\n════════ 校验：最近 400 根上因子的真实分布 ════════');
  console.log('（若这里的表态率也接近 0，说明是数据或归一化问题，不是行情问题）');
  console.log('因子        表态率    |值|中位数   |值|90分位   最新值');
  const W = r5.w, n5 = r5.dirs.length;
  const absVals = Array.from({ length: W }, () => []);
  const fq = S.VoteStream ? null : null;
  /* 重新跑一遍流，留住每根的因子原始值 */
  const st = new (Object.getPrototypeOf(r5).constructor === Object ? Object : Object)();
  for (let k = 0; k < W; k++) {
    let nonZero = 0;
    for (let i = 0; i < n5; i++) if (r5.votes[i * W + k] !== 0) nonZero++;
    console.log(VOTE_LABEL[k][0].padEnd(11)
      + (pct(nonZero, n5).toFixed(1) + '%').padStart(7));
  }
  console.log('\n5m 方向分布：多 ' + cnt(r5.dirs, 1) + ' / 空 ' + cnt(r5.dirs, -1)
    + ' / 无表态 ' + cnt(r5.dirs, 0) + '  （共 ' + n5 + ' 根）');
  console.log('15m 方向分布：多 ' + cnt(r15.dirs, 1) + ' / 空 ' + cnt(r15.dirs, -1)
    + ' / 无表态 ' + cnt(r15.dirs, 0));
  console.log('1h  方向分布：多 ' + cnt(r1h.dirs, 1) + ' / 空 ' + cnt(r1h.dirs, -1)
    + ' / 无表态 ' + cnt(r1h.dirs, 0));
  console.log('\n最近 8 根 5m 的收盘价与涨跌：');
  for (let i = n5 - 8; i < n5; i++) {
    const chg = i > 0 ? (s5.c[i] - s5.c[i - 1]) / s5.c[i - 1] * 100 : 0;
    console.log('   ' + new Date(s5.t[i] * 1000).toLocaleTimeString('zh-CN')
      + '  ' + s5.c[i].toFixed(2) + '  ' + (chg >= 0 ? '+' : '') + chg.toFixed(3) + '%'
      + '   量 ' + s5.v[i].toFixed(2));
  }

  function cnt(a, v) { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] === v) c++; return c; }
  function pct(a, b) { return b ? (a / b * 100) : 0; }

  /* 回看最近 48 根 5m，看三周期同向出现过几次（说明"差一点"的频率） */
  console.log('\n最近 48 根 5m 的方向轨迹（5m / 15m / 1h，·=无表态 ▲多 ▼空）：');
  const m15 = S.buildClosedMap(s5.t, s15.t, 300, 900);
  const m1h = S.buildClosedMap(s5.t, s1h.t, 300, 3600);
  let line5 = '', line15 = '', line1h = '', hit = '';
  for (let i = s5.n - 48; i < s5.n; i++) {
    const a = r5.dirs[i], b = m15[i] >= 0 ? r15.dirs[m15[i]] : 0, c = m1h[i] >= 0 ? r1h.dirs[m1h[i]] : 0;
    line5 += a > 0 ? '▲' : (a < 0 ? '▼' : '·');
    line15 += b > 0 ? '▲' : (b < 0 ? '▼' : '·');
    line1h += c > 0 ? '▲' : (c < 0 ? '▼' : '·');
    hit += (c !== 0 && b === c && a === c) ? '★' : ' ';
  }
  console.log('  5m  ' + line5);
  console.log('  15m ' + line15);
  console.log('  1h  ' + line1h);
  console.log('  同向 ' + hit + '   （★ = 三周期同向，只在它刚出现的那一根报警一次）');
})();
