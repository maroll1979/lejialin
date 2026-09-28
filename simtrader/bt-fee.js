/* ============================================================
   bt-fee.js · 给定手动止损/止盈比例，扫描「多低的费率才能盈利」
   ------------------------------------------------------------
   前面几轮已经确认：这些比例的问题是「毛利不够覆盖手续费」，
   而不是方向判断差。那么唯一要回答的就是——摩擦要降到多少。

   对每个品种、每个比例组合，用同一批入场点扫一遍单边费率，
   给出：每笔净 R、t 值、以及「刚好摸到保本的费率」。
   只有两个品种在同一费率下都转正，这个结论才值得相信。
   ============================================================ */
const S = require('./strategy.js');
const fs = require('fs');

const YEARS = +(process.argv[2] || 2);
const SYMS = ['BTCUSDT', 'ETHUSDT'];
const VOTE = { thz: 0.30, bufPct: 0.005, minVotes: 4 };

const PLANS = [
  { key: 'r1a', label: '1:1   1%:1%', stop: 0.010, tp: 0.010 },
  { key: 'r1b', label: '1:1   2%:2%', stop: 0.020, tp: 0.020 },
  { key: 'r2a', label: '1:2   1.5%:3%', stop: 0.015, tp: 0.030 },
  { key: 'r2b', label: '1:2   1%:2%', stop: 0.010, tp: 0.020 },
  { key: 'r2c', label: '1:2   2%:4%', stop: 0.020, tp: 0.040 },
  { key: 'r3a', label: '1:3   1%:3%', stop: 0.010, tp: 0.030 },
  { key: 'r3b', label: '1:3   1.5%:4.5%', stop: 0.015, tp: 0.045 },
];
const FEES = [0.0010, 0.0008, 0.0006, 0.0004, 0.0002, 0.0001, 0.00005, 0];

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}
function tstat(rs) {
  const n = rs.length;
  if (n < 2) return 0;
  const s = sd(rs);
  return s > 0 ? mean(rs) / (s / Math.sqrt(n)) : 0;
}
function num(v, d) { return (v == null || !isFinite(v)) ? '   -  ' : v.toFixed(d == null ? 3 : d); }
function pad(v, n) { return String(v).padStart(n); }

/* 目标：按 AskUserQuestion 口径 —— 1m 撮合 + 1m 信号 */
const BASE = 60, SIG = 60;

(async () => {
  const out = {};
  for (const sym of SYMS) {
    const f = '../data/m1_' + sym + '_' + YEARS + 'y.json';
    if (!fs.existsSync(f)) { console.log('缺缓存 ' + f + '，先跑 bt-pct.js ' + sym); continue; }
    const s1m = S.toSeries(JSON.parse(fs.readFileSync(f, 'utf8')).rows);
    /* 同一批入场点：只改费率，所以触发集合完全固定 */
    let cache = null;
    const res = {};
    for (const p of PLANS) {
      res[p.key] = {};
      for (const fee of FEES) {
        const opt = {
          vote: VOTE, msMode: false, baseSec: BASE, sigSec: SIG,
          stopPct: p.stop, tpPct: p.tp, tpMode: 'single',
          feeRate: fee, onProgress: () => {},
        };
        if (cache) opt.cache = cache;
        const r = S.backtestCore(s1m, opt);
        if (!cache) cache = r.cache;
        res[p.key][fee] = { avgR: r.avgR, winRate: r.winRate, count: r.count, t: tstat(r.trades.map(t => t.r)) };
      }
    }
    out[sym] = { res: res, bars: s1m.n };
    console.log('已算 ' + sym + ' · ' + s1m.n.toLocaleString('en-US') + ' 根 1m');
  }

  console.log('\n【费率扫描】' + BASE / 60 + 'm 撮合 + ' + SIG / 60 + 'm 信号 · ' + YEARS + ' 年');
  console.log('纵轴 = 出场方案，横轴 = 单边费率（进出各扣一次）\n');

  for (const p of PLANS) {
    console.log('── ' + p.label + ' ' + '─'.repeat(48));
    console.log(pad('单边费率', 11) + pad('双边合计', 11) + pad('BTC 每笔', 10) + pad('t', 7)
      + pad('ETH 每笔', 10) + pad('t', 7) + pad('判定', 14));
    for (const fee of FEES) {
      const b = out.BTCUSDT ? out.BTCUSDT.res[p.key][fee] : null;
      const e = out.ETHUSDT ? out.ETHUSDT.res[p.key][fee] : null;
      if (!b || !e) continue;
      const both = b.avgR > 0 && e.avgR > 0;
      const sig2 = both && b.t >= 2 && e.t >= 2;
      const verdict = sig2 ? '两品种同号且显著'
        : both ? '两品种都转正(未显著)' : '至少一个为负';
      const tag = (fee === 0.001 ? ' ← 当前 Taker' : (fee === 0.0001 ? ' ← Maker+VIP' : ''));
      console.log(pad((fee * 100).toFixed(3) + '%', 11) + pad((fee * 200).toFixed(3) + '%', 11)
        + pad(num(b.avgR, 4), 10) + pad(num(b.t, 2), 7)
        + pad(num(e.avgR, 4), 10) + pad(num(e.t, 2), 7)
        + pad(verdict, 14) + tag);
    }
    console.log('');
  }

  /* 每个方案「最宽松的可行费率」（两品种都转正的最高费率） */
  console.log('【可行门槛】能让两个品种同时转正的最高单边费率');
  console.log(pad('出场方案', 20) + pad('可行费率', 12) + pad('折让幅度', 12) + pad('t 门槛', 16));
  console.log('-'.repeat(62));
  for (const p of PLANS) {
    let best = null;
    for (const fee of FEES) {
      const b = out.BTCUSDT && out.BTCUSDT.res[p.key][fee];
      const e = out.ETHUSDT && out.ETHUSDT.res[p.key][fee];
      if (b && e && b.avgR > 0 && e.avgR > 0) { if (best == null || fee > best) best = fee; }
    }
    if (best == null) { console.log(pad(p.label, 20) + pad('扫到 0 费率仍不成立', 22)); continue; }
    const b = out.BTCUSDT.res[p.key][best], e = out.ETHUSDT.res[p.key][best];
    console.log(pad(p.label, 20) + pad((best * 100).toFixed(3) + '%', 12)
      + pad('现费率的 ' + (best / 0.001 * 100).toFixed(0) + '%', 12)
      + pad('t=' + b.t.toFixed(2) + ' / ' + e.t.toFixed(2), 16));
  }
  console.log('\n注：现实里 taker 单边 0.1% 是默认档；maker 0.02%~0.05%（视 VIP 与品种而定）。');
  console.log('    「可行费率 ≤ maker 水平」才意味着这套参数在现实中可执行。');
})().catch(e => { console.error('失败：', e); process.exit(1); });
