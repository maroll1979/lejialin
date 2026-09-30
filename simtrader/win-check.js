/* win-check.js · 窗口长度会不会改变投票结果？
   ------------------------------------------------------------------
   页面投票面板只拉最近 300 根。如果拉 1000 / 2000 根算出来的票数不一样，
   那用户看到的"没信号"就可能是窗口太短造成的，而不是行情没信号。
   逐档比较最后一根（已收线）的三周期票数与方向。
   ------------------------------------------------------------------ */
const S = require('./simtrader/strategy.js');
const CONTRACT = process.argv[2] || 'BTC_USDT';
const GATE = 'https://api.gateio.ws';

async function klines(interval, limit) {
  const url = `${GATE}/api/v4/futures/usdt/candlesticks?contract=${CONTRACT}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j && j.message || '格式异常');
  return S.toSeries(j.map(a => ({
    time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c, volume: +a.v,
  })));
}

(async () => {
  const MV = 4, V = { thz: 0.30, bufPct: 0.005, minVotes: MV };
  const s1d = await klines('1d', 300);
  console.log('品种 ' + CONTRACT + ' · 日线 ' + s1d.n + ' 根\n');
  console.log('5m窗口   1h窗口   5m(多/平/空)   15m(多/平/空)   1h(多/平/空)   三周期');

  for (const [n5, n1h] of [[300, 300], [600, 400], [1000, 500], [2000, 700]]) {
    const [s5, s15, s1h] = await Promise.all([
      klines('5m', n5), klines('15m', Math.max(300, Math.round(n5 / 3))), klines('1h', n1h),
    ]);
    const ma5 = S.dailyMa200Lookup(s5, s1d, 200, 300);
    const ma15 = S.dailyMa200Lookup(s15, s1d, 200, 900);
    const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, 3600);
    const r5 = S.voteSeries(s5, ma5, V);
    const r15 = S.voteSeries(s15, ma15, V);
    const r1h = S.voteSeries(s1h, ma1h, V);
    const c = a => a.length - 2;        // 最近已收线
    const i5 = c(r5.dirs), i15 = c(r15.dirs), i1h = c(r1h.dirs);
    const fmt = (r, i) => `${r.up[i]}/${r.w - r.up[i] - r.dn[i]}/${r.dn[i]}`
      + (r.dirs[i] === 1 ? '多' : r.dirs[i] === 2 ? '空' : '—');
    const tri = S.voteTriple(r1h.dirs[i1h], r15.dirs[i15], r5.dirs[i5]);
    console.log(String(n5).padStart(6) + String(n1h).padStart(9)
      + '   ' + fmt(r5, i5).padEnd(15) + fmt(r15, i15).padEnd(16) + fmt(r1h, i1h).padEnd(15)
      + (tri ? '★ ' + (tri === 'long' ? '多' : '空') : '未同向'));
  }

  /* 顺便：最近 300 根窗口内，出现过几次三周期同向（页面能看到的触发） */
  const s5 = await klines('5m', 300), s15 = await klines('15m', 300), s1h = await klines('1h', 300);
  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, 300);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, 900);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, 3600);
  const r5 = S.voteSeries(s5, ma5, V), r15 = S.voteSeries(s15, ma15, V), r1h = S.voteSeries(s1h, ma1h, V);
  const m15 = S.buildClosedMap(s5.t, s15.t, 300, 900);
  const m1h = S.buildClosedMap(s5.t, s1h.t, 300, 3600);
  let trig = 0, prev = false, same = 0;
  const marks = [];
  for (let i = 1; i < s5.n; i++) {
    const j15 = m15[i], j1h = m1h[i];
    let on = false;
    if (j15 >= 0 && j1h >= 0) {
      const a = r1h.dirs[j1h];
      on = a !== 0 && r15.dirs[j15] === a && r5.dirs[i] === a;
    }
    if (on) { same++; marks.push(on ? '★' : '·'); }
    if (on && !prev) { trig++; marks[marks.length - 1] = (r1h.dirs[j1h] === 1 ? 'L' : 'S'); }
    prev = on;
  }
  console.log('\n最近 300 根 5m（≈' + (300 * 5 / 60).toFixed(0) + ' 小时）内：'
    + '三周期同向 ' + same + ' 根 · **触发 ' + trig + ' 次**');
  console.log('轨迹（L=做多触发 S=做空触发 ★=同向持续 ·=否）：');
  console.log('  ' + marks.join(''));
  if (!trig) console.log('\n→ 页面会显示「样本内无触发」。这就是"一直没提示"的直接原因之一：');
  console.log('  不是没发生过，而是窗口只有 300 根，更早的触发不在画面里。');
})();
