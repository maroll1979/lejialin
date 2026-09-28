/* 止损宽度 × 4H 顺逆过滤器 联合扫描
   背景：手续费 R/笔 ≈ 双边费率 ÷ 止损宽度%。止损越窄，手续费吃掉的 R 越多。
   v2.1 修正后发现「顺 4H」是唯一有统计支撑的分组，本脚本验证放宽止损能否让它跨过盈亏平衡线，
   并强制在第二个品种上做样本外验证 —— 单品种挑出来的参数必须先在样本外死一遍才能信。

   用法：node scan-sl.js [SYMBOL ...]
*/
const fs = require('fs');
const path = require('path');
const S = require('./strategy.js');
const V = require('./v21.js');

const CACHE = p => path.join(__dirname, 'data', 'bt_' + p + '_5y_5m.json');
const SLS = [1, 1.5, 2, 3];
const THR = 60;                     // v2.1 统一门槛（规范 70/75/85 样本量太小）

function load(sym) {
  const f = CACHE(sym);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).rows;
}
const isWith = t => (t.dir === 'long' && t.reg === 1) || (t.dir === 'short' && t.reg === -1);

/* 把止损与两档止盈按同一比例 k 放宽：risk 变大 → 手续费 R/笔 按 1/k 下降 */
function widened(base, k) {
  if (k === 1) return undefined;
  return (objs, tf, px) => {
    const r = base(objs, tf, px);
    if (!r) return r;
    const sc = o => ({
      stop: px + (o.stop - px) * k, risk: o.risk * k,
      tp1: px + (o.tp1 - px) * k, tp2: px + (o.tp2 - px) * k,
    });
    return { dir: r.dir, px: px, atr: r.atr, long: sc(r.long), short: sc(r.short) };
  };
}
const pad = (v, w) => String(v).padStart(w);
const num = (v, d) => (isFinite(v) ? v.toFixed(d) : '—');

function run(sym, rows) {
  const s5 = S.toSeries(rows);
  const B = V.build(s5, { live: false });
  const base = S.defaultTpsl;
  const all = V.findSignals(s5, B, { thrOverride: THR });
  const with4H = all.filter(isWith);
  console.log(`\n${'='.repeat(78)}\n${sym}  全部信号 ${all.length} 笔 · 顺 4H 过滤后 ${with4H.length} 笔（${(with4H.length / all.length * 100).toFixed(1)}%）\n${'='.repeat(78)}`);
  console.log('  止损倍率  样本        笔数    毛利R     手续费R   净R       t值     胜率     PF     最大DD   平均持仓');
  const out = {};
  [['全部信号', all], ['顺 4H only', with4H]].forEach(pair => {
    SLS.forEach(k => {
      const sim = V.simulate(s5, pair[1], B, { tpslFn: widened(base, k) });
      const st = V.stats(sim.trades, s5);
      out[pair[0] + '_' + k] = st;
      console.log(`  x${String(k).padEnd(6)} ${pair[0].padEnd(11)} ${pad(st.count, 6)}  ${pad(num(st.grossAvg, 3), 8)} ${pad(num(st.feeAvg, 3), 8)}  ${pad(num(st.avgR, 3), 7)} ${pad(num(st.t, 2), 7)} ${pad((st.winRate * 100).toFixed(1) + '%', 7)} ${pad(num(st.profitFactor, 2), 6)} ${pad((st.maxDD * 100).toFixed(1) + '%', 7)} ${pad(st.avgHoldHours.toFixed(1) + 'h', 8)}`);
    });
  });
  return out;
}

(async () => {
  const syms = process.argv.slice(2);
  const list = syms.length ? syms : ['BTCUSDT', 'ETHUSDT'];
  const res = {};
  for (const sym of list) {
    const rows = load(sym);
    if (!rows) { console.log(`\n${sym}：无缓存数据，先跑 node fetch-cache.js ${sym.slice(0, -4)} 5`); continue; }
    res[sym] = run(sym, rows);
  }
  /* 跨品种一致性：两个品种对同一组参数的结论是否同号 */
  const keys = Object.keys(res);
  if (keys.length >= 2) {
    console.log(`\n${'='.repeat(78)}\n样本外一致性检验（在一个品种上调参数，必须能在另一个品种上复现）\n${'='.repeat(78)}`);
    let agree = 0, tried = 0;
    SLS.forEach(k => {
      [['全部信号', 'all'], ['顺 4H only', 'with4H']].forEach(g => {
        const kk = `${g[0]}_${k}`;
        const a = res[keys[0]][kk], b = res[keys[1]][kk];
        if (!a || !b || !a.count || !b.count) return;
        tried++;
        const same = Math.sign(a.grossAvg) === Math.sign(b.grossAvg);
        if (same) agree++;
        console.log(`  止损 x${k} · ${g[0].padEnd(11)}  ${keys[0]} 毛利 ${num(a.grossAvg, 3)}R  vs  ${keys[1]} 毛利 ${num(b.grossAvg, 3)}R  ${same ? '同号 ✓' : '异号 ✗'}`);
      });
    });
    console.log(`\n  一致率 ${agree}/${tried}。低于半数说明「在哪品种上调的就在哪品种上有效」，参数不可信。`);
  }
  console.log('\n注：手续费按市价 Taker 单边 0.1% 计入；止损宽度 = 1.8×ATR(14,1h)，k 为倍数。');
  console.log('    手续费 R/笔 ≈ 0.2% ÷ 止损宽度% —— 放宽止损是唯一直接降低手续费 R 的手段。\n');
})().catch(e => { console.error(e); process.exit(1); });
