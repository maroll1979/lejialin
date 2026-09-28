/* ============================================================
   bt-pct.js · 1m 粒度回测 × 手动指定的止损/止盈百分比
   ------------------------------------------------------------
   把三个常被混为一谈的变量拆开观察：

     A. 5m信号 / 5m撮合   ← 旧口径
     B. 5m信号 / 1m撮合   ← 只提高「成交分辨率」
     C. 1m信号 / 1m撮合   ← 只降低「信号的最低周期」到 1m

     A→B 隔离出「撮合精度」的价值（一根 K 线内先撞止损还是先撞止盈，
          5m 数据上无从分辨、只能一律保守按止损，1m 能看清路径）
     B→C 隔离出「信号灵敏度」的价值（1h+15m+5m → 1h+15m+1m）

   并回答用户手定的盈亏比够不够：实际胜率 vs 扣费后的保本胜率。
   ============================================================ */
const S = require('./strategy.js');
const fs = require('fs');

const sym = (process.argv[2] || 'BTCUSDT').toUpperCase();
const YEARS = +(process.argv[3] || 2);
const CONC = +(process.argv[4] || 6);
const CACHE = '../data/m1_' + sym + '_' + YEARS + 'y.json';

const VOTE = { thz: 0.30, bufPct: 0.005, minVotes: 4 };   // 与页面默认一致

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

/* 出场方案：止损/止盈均以成交价为基准的百分比 */
const PLANS = [
  { key: 'r1a', label: '1:1   1%:1%', stop: 0.010, tp: 0.010 },
  { key: 'r1b', label: '1:1   2%:2%', stop: 0.020, tp: 0.020 },
  { key: 'r2a', label: '1:2   1.5%:3%', stop: 0.015, tp: 0.030 },
  { key: 'r2b', label: '1:2   1%:2%', stop: 0.010, tp: 0.020 },
  { key: 'r2c', label: '1:2   2%:4%', stop: 0.020, tp: 0.040 },
  { key: 'r3a', label: '1:3   1%:3%', stop: 0.010, tp: 0.030 },
  { key: 'r3b', label: '1:3   1.5%:4.5%', stop: 0.015, tp: 0.045 },
  { key: 'atr', label: 'ATR 1.8x (旧基准)', stop: 0, tp: 0 },
];

const GRAN = [
  { key: 'A', label: '5m/5m', baseSec: 300, sigSec: 300, src: '5m' },
  { key: 'B', label: '5m/1m', baseSec: 60, sigSec: 300, src: '1m' },
  { key: 'C', label: '1m/1m', baseSec: 60, sigSec: 60, src: '1m' },
];

async function loadSeries() {
  if (fs.existsSync(CACHE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log('命中缓存 ' + CACHE + ' · ' + raw.rows.length.toLocaleString('en-US') + ' 根'
      + ' · 落盘于 ' + new Date(raw.at).toLocaleString('zh-CN'));
    return S.toSeries(raw.rows);
  }
  console.log('拉取 ' + sym + ' ' + YEARS + ' 年 1m ...');
  const t0 = Date.now();
  const h = await S.fetchHistory(sym, '1m', YEARS, {
    src: 'binance', concurrency: CONC,
    onProgress: p => process.stdout.write('\r拉取中 ' + (p * 100).toFixed(0) + '%   '),
  });
  if (!h.rows.length) throw new Error('未取到 1m K线');
  console.log('\n' + h.series.n.toLocaleString('en-US') + ' 根 · 段数 ' + h.segTotal
    + ' · 失败 ' + h.segFailed + ' · 用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), rows: h.rows }));
  console.log('已缓存 → ' + CACHE);
  return h.series;
}

(async () => {
  const s1m = await loadSeries();
  const s5m = S.aggregate(s1m, 300);
  console.log('1m ' + s1m.n.toLocaleString('en-US') + ' 根 → 5m ' + s5m.n.toLocaleString('en-US') + ' 根（同源聚合）');

  const FEE = S.FEE_RATE;
  console.log('费率：单边 ' + (FEE * 100).toFixed(3) + '%（进出合计 ' + (FEE * 200).toFixed(2) + '%）\n');

  const rows = [];
  const caches = {};                       // 按 sigSec 复用「聚合 + 三周期票选」
  for (const g of GRAN) {
    const s = (g.src === '5m') ? s5m : s1m;
    for (const p of PLANS) {
      const opt = {
        vote: VOTE, msMode: false,
        baseSec: g.baseSec, sigSec: g.sigSec,
        stopPct: p.stop > 0 ? p.stop : 0, tpPct: p.tp > 0 ? p.tp : 0, tpMode: 'single',
        onProgress: () => {},
      };
      if (p.stop === 0) opt.tpslFn = S.defaultTpsl;
      if (caches[g.sigSec]) opt.cache = caches[g.sigSec];
      const r = S.backtestCore(s, opt);
      if (!caches[g.sigSec]) caches[g.sigSec] = r.cache;
      rows.push({ plan: p, g: g, res: r, bk: p.stop > 0 ? S.breakevenWinRate(p.stop, p.tp, FEE) : null });
      process.stdout.write('.');
    }
  }
  console.log('\n');
  const get = (pk, gk) => rows.find(x => x.plan.key === pk && x.g.key === gk);

  /* ---------- 主表 ---------- */
  console.log('【主表】' + sym + ' ' + YEARS + ' 年 · 撮合/信号 三档对照');
  console.log(pad('出场方案', 20) + pad('档位', 8) + pad('笔数', 7) + pad('实际胜率', 9)
    + pad('保本胜率', 9) + pad('落差', 8) + pad('每笔净R', 9) + pad('毛利R', 9)
    + pad('费R', 8) + pad('t(净)', 7) + pad('持仓', 9));
  console.log('-'.repeat(103));
  for (const g of GRAN) {
    for (const p of PLANS) {
      const x = get(p.key, g.key), r = x.res;
      const gap = x.bk ? (r.winRate - x.bk.breakeven) * 100 : NaN;
      console.log(pad(p.label, 20) + pad(g.label, 8) + pad(r.count, 7)
        + pad((r.winRate * 100).toFixed(1) + '%', 9)
        + pad(x.bk ? (x.bk.breakeven * 100).toFixed(1) + '%' : '(ATR)', 9)
        + pad(isFinite(gap) ? (gap >= 0 ? '+' : '') + gap.toFixed(1) : '-', 8)
        + pad(num(r.avgR, 4), 9) + pad(num(r.grossR / Math.max(1, r.count), 4), 9)
        + pad(num(r.avgFeeR, 3), 8) + pad(num(tstat(r.trades.map(t => t.r)), 2), 7)
        + pad(r.avgHoldHours.toFixed(1) + 'h', 9));
    }
    console.log('');
  }

  /* ---------- A→B：纯粹的撮合精度价值 ---------- */
  console.log('【效应①】撮合精度：5m 撮合 → 1m 撮合（信号层完全不动）');
  console.log(pad('出场方案', 20) + pad('5m撮合', 10) + pad('1m撮合', 10) + pad('差值', 9)
    + pad('5m胜率', 9) + pad('1m胜率', 9) + pad('差值', 9) + pad('判定', 14));
  console.log('-'.repeat(80));
  for (const p of PLANS) {
    const a = get(p.key, 'A'), b = get(p.key, 'B');
    const dR = b.res.avgR - a.res.avgR, dW = (b.res.winRate - a.res.winRate) * 100;
    console.log(pad(p.label, 20) + pad(num(a.res.avgR, 4), 10) + pad(num(b.res.avgR, 4), 10)
      + pad((dR >= 0 ? '+' : '') + dR.toFixed(4), 9)
      + pad((a.res.winRate * 100).toFixed(1) + '%', 9) + pad((b.res.winRate * 100).toFixed(1) + '%', 9)
      + pad((dW >= 0 ? '+' : '') + dW.toFixed(1), 9)
      + pad(Math.abs(dR) < 1e-9 ? '毫无差别' : '有差别', 14));
  }

  /* ---------- B→C：纯粹的信号周期价值 ---------- */
  console.log('\n【效应②】信号周期：1h+15m+5m → 1h+15m+1m（都用 1m 撮合）');
  console.log(pad('出场方案', 20) + pad('5m信号', 10) + pad('1m信号', 10) + pad('差值', 9)
    + pad('5m笔数', 9) + pad('1m笔数', 9) + pad('增量', 9) + pad('1m胜率', 9));
  console.log('-'.repeat(84));
  for (const p of PLANS) {
    const b = get(p.key, 'B'), c = get(p.key, 'C');
    const dR = c.res.avgR - b.res.avgR;
    console.log(pad(p.label, 20) + pad(num(b.res.avgR, 4), 10) + pad(num(c.res.avgR, 4), 10)
      + pad((dR >= 0 ? '+' : '') + dR.toFixed(4), 9)
      + pad(b.res.count, 9) + pad(c.res.count, 9)
      + pad((c.res.count - b.res.count >= 0 ? '+' : '') + (c.res.count - b.res.count), 9)
      + pad((c.res.winRate * 100).toFixed(1) + '%', 9));
  }

  /* ---------- 同 R:R 下宽止损 vs 窄止损 ---------- */
  console.log('\n【效应③】同盈亏比：宽止损应当优于窄止损（手续费占比被摊薄）');
  console.log(pad('对比', 28) + pad('窄·净R', 10) + pad('宽·净R', 10) + pad('差值', 9) + pad('结论', 12));
  console.log('-'.repeat(70));
  const pairs = [
    ['r2b', 'r2a', 'R:R=2  窄 1%:2%  vs 宽 1.5%:3%'],
    ['r2a', 'r2c', 'R:R=2  中 1.5%:3% vs 宽 2%:4%'],
    ['r1a', 'r1b', 'R:R=1  窄 1%:1%  vs 宽 2%:2%'],
    ['r3a', 'r3b', 'R:R=3  窄 1%:3%  vs 宽 1.5%:4.5%'],
  ];
  let flexWin = 0, flexTotal = 0;
  for (const [nKey, wKey, lab] of pairs) {
    for (const gk of ['A', 'C']) {
      const n = get(nKey, gk), w = get(wKey, gk);
      if (!n || !w) continue;
      const d = w.res.avgR - n.res.avgR;
      flexTotal++; if (d > 0) flexWin++;
      if (gk === 'C') {
        console.log(pad(lab, 28) + pad(num(n.res.avgR, 4), 10) + pad(num(w.res.avgR, 4), 10)
          + pad((d >= 0 ? '+' : '') + d.toFixed(4), 9)
          + pad(d > 0.002 ? '宽止损更优' : d < -0.002 ? '窄止损更优' : '基本无差', 12));
      }
    }
  }
  console.log('（A/C 两档合计 ' + flexWin + '/' + flexTotal + ' 组同向）');

  /* ---------- 达标检查 ---------- */
  console.log('\n【达标检查】实际胜率 vs 扣费后保本胜率（1m/1m 档）');
  const pass = rows.filter(x => x.g.key === 'C' && x.bk)
    .sort((a, b) => (b.res.winRate - b.bk.breakeven) - (a.res.winRate - a.bk.breakeven));
  for (const x of pass) {
    const gap = (x.res.winRate - x.bk.breakeven) * 100;
    const rs = x.res.trades.map(t => t.r);
    console.log(pad(x.plan.label, 20) + (gap > 0 ? '✔ 过线' : '✘ 未过')
      + '  实际 ' + (x.res.winRate * 100).toFixed(1) + '%  vs 保本 ' + (x.bk.breakeven * 100).toFixed(1) + '%'
      + '  落差 ' + (gap >= 0 ? '+' : '') + gap.toFixed(1) + 'pp'
      + '  每笔 ' + num(x.res.avgR, 4) + 'R  t=' + num(tstat(rs), 2));
  }
  console.log('\n注：t(净) 需 ≥2 且第二个品种同号，才能声称不是偶然。');
})().catch(e => { console.error('\n失败：', e); process.exit(1); });
