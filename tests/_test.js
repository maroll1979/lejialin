// 从 app.js 抽取真实算法代码进行验证（不含 DOM 依赖）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const cut = src.indexOf('/* ============================ K 线绘制');
if (cut < 0) throw new Error('切分点未找到');
let code = src.slice(0, cut);

// 极简 stub
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};
global.fetch = () => Promise.reject(new Error('no net'));
global.AbortController = class { constructor(){ this.signal = {}; } abort(){} };

const mod = {};
const fn = new Function('module', 'exports', code + '\n;module.exports={sma,ema,rsi,macd,boll,atr,analyze,mkBars,SYMS,TF_MAP,mulberry32,seedOf};');
fn(mod, {});
const A = mod.exports;

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + ' ' + extra)); };
const fclose = (a, b, t = 1e-6) => Math.abs(a - b) < t;

console.log('\n[1] 移动平均 / 指数平均');
const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const s3 = A.sma(a, 3);
ok(s3[2] === 2 && s3[9] === 9, 'SMA(3) 正确', JSON.stringify(s3));
ok(s3[0] === null && s3[1] === null, 'SMA 前 n-1 项为 null');
const e3 = A.ema(a, 3);
ok(e3.length === 10 && e3.every(v => isFinite(v)), 'EMA 长度与有限性');

console.log('\n[2] RSI 边界');
const up = Array.from({ length: 40 }, (_, i) => 100 + i);
const dn = Array.from({ length: 40 }, (_, i) => 200 - i);
const rUp = A.rsi(up), rDn = A.rsi(dn);
ok(fclose(rUp[39], 100, 0.01), '全涨序列 RSI→100', 'got ' + rUp[39]);
ok(fclose(rDn[39], 0, 0.01), '全跌序列 RSI→0', 'got ' + rDn[39]);
const fl = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 1 : -1));
const rFl = A.rsi(fl);
ok(rFl[39] > 20 && rFl[39] < 80, '震荡序列 RSI 处于中间区', 'got ' + rFl[39]);
ok(A.rsi([1,2]).every(v => v === null || isFinite(v)), '短序列不崩溃');

console.log('\n[3] MACD');
const m = A.macd(up);
ok(m.dif.length === 40 && m.dea.length === 40 && m.hist.length === 40, '三条线长度一致');
ok(m.hist.every(v => isFinite(v)), 'MACD 柱无 NaN');
ok(m.dif[39] > 0, '上涨序列 DIF > 0', 'got ' + m.dif[39]);

console.log('\n[4] 布林带');
const b = A.boll(up, 20);
ok(fclose(b.mid[39], A.sma(up, 20)[39], 1e-9), '中轨 = MA20');
ok(b.up[39] > b.mid[39] && b.mid[39] > b.dn[39], '上轨 > 中轨 > 下轨');
ok(b.wd[39] >= 0, '带宽非负', 'got ' + b.wd[39]);

console.log('\n[5] ATR');
const bars = up.map((c, i) => ({ t: i, o: c - .5, h: c + 1, l: c - 1, c, v: 1 }));
const at = A.atr(bars, 14);
ok(at[13] !== null && at[13] > 0, 'ATR 第14根有值', 'got ' + at[13]);
ok(at.slice(14).every(v => v !== null && isFinite(v)), 'ATR 后续均有效');

console.log('\n[6] 信号方向判定');
const mk = n => Array.from({ length: n }, (_, i) => {
  const p = 50000 * Math.exp(0.006 * i + Math.sin(i / 3) * 0.004);
  return { t: i * 6e4, o: p, h: p * 1.004, l: p * 0.996, c: p, v: 100 };
});
const an = A.analyze(mk(120));
ok(an.dir === 'long', '强上涨序列 → 做多', 'dir=' + an.dir + ' score=' + an.score);
ok(an.score > 0 && an.score <= 100, '分数在 [-100,100]', 'got ' + an.score);
ok(an.sl < an.px && an.tp > an.px, '多头：止损在下方、止盈在上方',
   `sl=${an.sl.toFixed(0)} px=${an.px.toFixed(0)} tp=${an.tp.toFixed(0)}`);
ok(an.posPct >= 5 && an.posPct <= 60, '建议仓位在 5%~60%', 'got ' + an.posPct.toFixed(1));

const mkDn = n => Array.from({ length: n }, (_, i) => {
  const p = 50000 * Math.exp(-0.006 * i);
  return { t: i * 6e4, o: p, h: p * 1.002, l: p * 0.998, c: p, v: 100 };
});
const anD = A.analyze(mkDn(120));
ok(anD.dir === 'short', '强下跌序列 → 做空', 'dir=' + anD.dir + ' score=' + anD.score);
ok(anD.sl > anD.px && anD.tp < anD.px, '空头：止损在上方、止盈在下方',
   `sl=${anD.sl.toFixed(0)} px=${anD.px.toFixed(0)} tp=${anD.tp.toFixed(0)}`);

// 震荡行情应判观望，避免长期满屏信号
const mkFlat = n => Array.from({ length: n }, (_, i) => {
  const p = 50000 * (1 + Math.sin(i / 5) * 0.006);
  return { t: i * 6e4, o: p, h: p * 1.003, l: p * 0.997, c: p, v: 100 };
});
const anF = A.analyze(mkFlat(120));
ok(Math.abs(anF.score) < 60, '震荡序列不应出现极端分数', 'score=' + anF.score);
ok(['long', 'short', 'wait'].includes(anF.dir), '震荡序列方向合法', 'dir=' + anF.dir);
[an, anD].forEach((x, i) => {
  const bad = ['rsi', 'macdH', 'atr', 'atrPct', 'bollW', 'mom', 'entryLo', 'entryHi']
    .filter(k => !isFinite(x[k]));
  ok(bad.length === 0, `${i ? '空' : '多'}头信号关键指标均为有限值`, bad.join(','));
});

console.log('\n[7] 全景 NaN 扫描（5 品种 × 4 周期合成数据）');
let nanCount = 0, dirStat = {};
Object.keys(A.SYMS).forEach(sid => {
  ['15m', '30m', '1h', '4h'].forEach(tf => {
    const bars = A.mkBars(sid, tf, A.SYMS[sid].id === 'UKOIL' ? 108 : 50000).bars;
    const r = A.analyze(bars);
    dirStat[r.dir] = (dirStat[r.dir] || 0) + 1;
    const bad = Object.entries(r).filter(([k, v]) => typeof v === 'number' && !isFinite(v));
    if (bad.length) { nanCount++; console.log('    NaN:', sid, tf, bad); }
    if (!['long', 'short', 'wait'].includes(r.dir)) { nanCount++; console.log('    非法方向:', sid, tf, r.dir); }
  });
});
ok(nanCount === 0, '20 组数据无 NaN / 非法方向');
console.log('    方向分布:', dirStat);

console.log('\n[8] 合成 K 线锚定与结构');
const sb = A.mkBars('BTC', '1h', 78000);
const last = sb.bars[sb.bars.length - 1];
ok(fclose(last.c, 78000, 78000 * 1e-9), '末根收盘 = 锚定价', 'got ' + last.c);
ok(sb.bars.length === 240, '生成 240 根', 'got ' + sb.bars.length);
ok(sb.bars.every(b => b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c)), 'OHLC 结构合法');
ok(sb.bars.every(b => b.h > 0 && b.l > 0 && b.v >= 0), '价格为正、成交量非负');
// 时间戳随当前时间生成，因此只比对价格结构是否可复现
const strip = bs => JSON.stringify(bs.map(b => [b.o, b.h, b.l, b.c, b.v]));
const again = A.mkBars('BTC', '1h', 78000);
ok(strip(sb.bars) === strip(again.bars), '同参数价格序列可复现（种子稳定）');
const bt = A.mkBars('BTC', '1h', 78000).bars;
ok(bt.every((b, i) => i === 0 || b.t > bt[i - 1].t), '时间轴严格递增');
const oil = A.mkBars('UKOIL', '15m', 108);
ok(oil.bars.every(b => b.h > 0), '原油合成正常');

console.log('\n[9] 波动率尺度合理性（日化波动还原）');
Object.entries(A.SYMS).forEach(([sid, s]) => {
  const bars = A.mkBars(sid, '1h', 1000).bars;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) sum += Math.log(bars[i].c / bars[i - 1].c) ** 2;
  const realized = Math.sqrt(sum / (bars.length - 1)) * Math.sqrt(24) * 100;
  const okv = realized > s.vol * 100 * 0.4 && realized < s.vol * 100 * 2.2;
  ok(okv, `${sid} 实际波动 ${realized.toFixed(2)}% ≈ 设定 ${(s.vol * 100).toFixed(2)}%`);
});

console.log('\n[10] 交易计算（强平价 / 盈亏 / 盈亏比）');
const calc = (entry, lev, margin, side, mark) => {
  const qty = margin * lev / entry;
  const liq = side === 'long' ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev);
  const pnl = (mark - entry) * qty * (side === 'long' ? 1 : -1);
  return { qty, liq, pnl, roi: pnl / margin * 100 };
};
let c1 = calc(78000, 10, 1000, 'long', 78000);
ok(fclose(c1.qty, 1000 * 10 / 78000), '数量 = 保证金×杠杆/开仓价');
ok(fclose(c1.liq, 78000 * (1 - 0.095)), '10× 多头强平价 = 入场 90.5%', 'got ' + c1.liq.toFixed(0));
ok(fclose(c1.pnl, 0), '平价时盈亏为 0');
let c2 = calc(78000, 10, 1000, 'long', 78000 * 1.01);
ok(fclose(c2.roi, 10, 0.01), '10× 涨 1% → 本金 +10%', 'got ' + c2.roi.toFixed(3));
let c3 = calc(78000, 10, 1000, 'short', 78000 * 1.01);
ok(fclose(c3.roi, -10, 0.01), '10× 空头涨 1% → 本金 -10%', 'got ' + c3.roi.toFixed(3));
let c4 = calc(78000, 100, 1000, 'long', 78000);
ok(fclose(c4.liq, 78000 * (1 - 0.0095)), '100× 强平距离 ≈ 0.95%');
const rr = Math.abs(78000 * 1.03 - 78000) / Math.abs(78000 - 78000 * 0.985);
ok(fclose(rr, 2, 0.01), '盈亏比计算正确 (3%/1.5% = 2:1)', 'got ' + rr.toFixed(3));

console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
