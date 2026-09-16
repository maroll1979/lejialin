// P0-2 数据过期禁止开仓 / P1-2 多周期共振与总仓位限制：
// jsdom 加载真实页面，直接驱动 window.autoCanTrade / mtfDecision / autoOpenOnce。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8780/', pretendToBeVisual: true });
const w = dom.window;
const errors = [];
w.addEventListener('error', e => errors.push(String(e.message || e)));

const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = k === 'measureText' ? (s => ({ width: String(s).length * 6 })) : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.Element.prototype.getBoundingClientRect = () => ({ width: 900, height: 320, top: 0, left: 0, right: 900, bottom: 320, x: 0, y: 0 });
Object.defineProperty(w, 'devicePixelRatio', { value: 1, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 620; }, configurable: true });

const ETH = 2512.88;
const M15 = 15 * 60000;
const TF_STEP = { '15m': M15, '30m': 30 * 60000, '1h': 60 * 60000, '4h': 240 * 60000 };
/** 强趋势序列：dir=1 上涨 / -1 下跌，用于让各周期给出明确方向 */
function trend(n, tf, dir, base = ETH) {
  const step = TF_STEP[tf];
  const t0 = Math.floor(Date.now() / step) * step - (n - 1) * step;
  let px = base * (dir > 0 ? 0.94 : 1.06);
  return Array.from({ length: n }, (_, i) => {
    const o = px, c = px * (1 + dir * 0.004);
    const b = { t: t0 + i * step, o, c, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, v: 100 + i };
    px = c;
    return b;
  });
}
const setBars = (tf, bars, stale) => {
  w.MB_STATE.klines['ETH'] = w.MB_STATE.klines['ETH'] || {};
  w.MB_STATE.klines['ETH'][tf] = { bars, real: true, src: 'test', stale: !!stale, staleSince: stale ? Date.now() : 0 };
};
const setQuote = (px, ageMs) => {
  w.MB_STATE.quotes['ETH'] = { price: px, median: px, ts: Date.now() - (ageMs || 0), realCount: 4, rows: [], spreadPct: 0.01 };
};
/** 让数据全部达标：报价新鲜 + 主周期 K 线充足且连续 */
function healthy() {
  w.AUTO.sym = 'ETH'; w.AUTO.tf = '1h';
  setQuote(ETH, 0);
  // 四周期融合要读四份 K 线，缺一份就不允许开仓
  ['15m', '30m', '1h', '4h'].forEach(tf => setBars(tf, trend(120, tf, 1), false));
}

w.fetch = url => {
  const u = String(url);
  if (u.includes('api.coingecko.com'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ethereum: { usd: ETH }, bitcoin: { usd: 77872.12 }, binancecoin: { usd: 722.32 }, 'pax-gold': { usd: 4286.4 } }) });
  if (u.includes('fapi.binance.com') && u.includes('klines')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const b = /^ETH/.test(sym) ? ETH : 77872.12;
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(trend(240, '1h', 1, b)
        .map(k => [k.t, String(k.o), String(k.h), String(k.l), String(k.c), String(k.v)])),
    });
  }
  if (u.includes('fapi.binance.com') && (u.includes('premiumIndex') || u.includes('ticker/24hr'))) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = /^ETH/.test(sym) ? ETH : 77872.12;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, markPrice: String(p), indexPrice: String(p), lastPrice: String(p), lastFundingRate: '0.00004437' }) });
  }
  return Promise.reject(new Error('unstubbed ' + u.slice(0, 60)));
};

(async () => {
  w.eval(appjs);
  await new Promise(r => setTimeout(r, 400));

  console.log('\n[1] P0-2 数据闸门 autoCanTrade');
  ok(typeof w.autoCanTrade === 'function', 'autoCanTrade 已暴露');
  w.MB_STATE.quotes['ETH'] = null;
  ok(w.autoCanTrade().ok === false && /无实时价/.test(w.autoCanTrade().why), '无实时价 → 禁止', w.autoCanTrade().why);

  setQuote(ETH, 60000); setBars('1h', trend(120, '1h', 1), false);
  ok(/报价已过期/.test(w.autoCanTrade().why), '报价 60 秒未更新 → 禁止', w.autoCanTrade().why);

  setQuote(ETH, 0); setBars('1h', trend(20, '1h', 1), false);
  ok(/K 线不足/.test(w.autoCanTrade().why), 'K 线不足 40 根 → 禁止', w.autoCanTrade().why);

  setBars('1h', trend(120, '1h', 1), true);
  ok(/停止更新/.test(w.autoCanTrade().why), 'K 线 stale → 禁止', w.autoCanTrade().why);

  const holed = trend(120, '1h', 1).filter((_, i) => i < 40 || i > 60);
  setBars('1h', holed, false);
  ok(/不连续/.test(w.autoCanTrade().why), 'K 线有空洞 → 禁止', w.autoCanTrade().why);

  healthy();
  const good = w.autoCanTrade();
  ok(good.ok === true, '全部达标 → 允许开仓', good.why);

  console.log('\n[2] 四周期融合决策 mtfDecision（模拟盘唯一信号入口）');
  /* 旧口径是「四周期投票 + 主周期兜底」：15m 做多 / 4h 做空时以主周期（默认 1h）开仓，
   * 等于小周期能推翻大周期。现在只允许 4h 定趋势 → 1h 筛选 → 30m 看回调 → 15m 触发。 */
  ok(typeof w.mtfDecision === 'function', 'mtfDecision 已暴露');
  ok(w.autoMultiBias === undefined, '旧的多周期投票口径已移除（不再有并行入口）');

  /* mtfDecision 有 5 秒缓存，键是「各周期根数 + 末根时间戳」，
   * 换场景时改根数以强制重算。 */
  w.AUTO.sym = 'ETH'; w.AUTO.tf = '1h';
  ['15m', '30m', '1h', '4h'].forEach(tf => setBars(tf, trend(120, tf, 1), false));
  let dec = w.mtfDecision('ETH');
  ok(dec && dec.trendDir === 'long', '四周期同向 → 4h 趋势层定方向为做多', dec && dec.trendDir);
  ok(dec && dec.bias !== 'short', '四周期同向不会给出做空', dec && dec.bias);

  ['15m', '30m'].forEach(tf => setBars(tf, trend(121, tf, -1), false));
  dec = w.mtfDecision('ETH');
  ok(dec && dec.bias !== 'short', '15m / 30m 转空而 4h / 1h 仍多 → 总决策不做空',
    dec && dec.bias + ' / ' + dec.stage);
  ok(dec && /触发层|回调层/.test(dec.reasons.join('')), '卡在 15m 触发层或 30m 回调层',
    dec && dec.stage);

  ['1h', '4h'].forEach(tf => setBars(tf, trend(122, tf, -1), false));
  dec = w.mtfDecision('ETH');
  ok(dec && dec.trendDir === 'short', '4h 转空 → 趋势层改判做空', dec && dec.trendDir);
  ok(dec && dec.bias !== 'long', '4h 做空时不会给出做多（小周期翻不动大周期）', dec && dec.bias);

  w.AUTO.tf = '1h';

  console.log('\n[3] P1-2 总仓位限制');
  w.AUTO.orders = [];
  w.AUTO.maxOpen = 1;
  w.AUTO.orders.push({ id: 'X1', t: Date.now(), day: 'd', sym: 'ETH', tf: '1h', side: 'long', status: 'open', entry: ETH, px0: ETH });
  const before = w.AUTO.orders.length;
  w.autoOpenOnce(Date.now(), false);
  const last = w.AUTO.orders[w.AUTO.orders.length - 1];
  ok(w.AUTO.orders.length === before + 1, '产生了一条新记录');
  ok(/持仓笔数上限/.test(last.reason || ''), '持仓数达上限 → 本档记为 skip', last.reason);
  ok(last.status === 'skip' && last.side === 'wait', '不是新开仓，而是 skip', last.status + '/' + last.side);

  w.AUTO.orders = w.AUTO.orders.filter(o => o.status !== 'open');
  w.AUTO.maxOpen = 5;
  w.autoOpenOnce(Date.now(), false);
  const last2 = w.AUTO.orders[w.AUTO.orders.length - 1];
  ok(!/总仓位限制/.test(last2.reason || ''), '持仓清零后不再因上限拦截', last2.reason);

  console.log('\n[4] P0-3 错过的档位不补开新单');
  const n0 = w.AUTO.orders.length;
  w.autoOpenOnce(Date.now() - 3600000, true);
  const last3 = w.AUTO.orders[w.AUTO.orders.length - 1];
  ok(w.AUTO.orders.length === n0 + 1, '补单档位仍留痕');
  ok(last3.status === 'skip' && last3.catchup === true, '补单档位记为 skip（catchup 标记保留）', last3.status);
  ok(/不补开新单/.test(last3.reason || ''), '原因写明不补开新单', last3.reason);

  console.log('\n[5] 无未捕获错误');
  ok(errors.length === 0, '运行期无未捕获错误', errors.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
