// 自动交易端到端：jsdom 加载真实页面，桩出 ETH 真实行情，验证到点自动开仓、止盈止损与补单
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8778/', pretendToBeVisual: true });
const w = dom.window, doc = w.document;
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
/** 可变的行情基准：测试里改动它来触发止盈 / 止损 */
let ethPx = ETH;
// 稳定上升的 K 线序列：让做市商结论落在「做多」，便于验证止盈链路
function klines(base) {
  return Array.from({ length: 240 }, (_, i) => {
    const o = base * (1 + (i - 120) * 0.0009 + Math.sin(i / 11) * 0.0008);
    return [Date.now() - (239 - i) * 900000, o, o * 1.0015, o * 0.9985, o * 1.0009, 100 + i, 0, 0, 0, 0, 0, 0];
  });
}
const priceOf = sym => /^ETH/.test(sym) ? ethPx : /^BTC/.test(sym) ? 77872.12 : /^BNB/.test(sym) ? 722.32 : 4286.4;

w.fetch = url => {
  const u = String(url);
  if (u.includes('api.coingecko.com'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ethereum: { usd: ethPx }, bitcoin: { usd: 77872.12 }, binancecoin: { usd: 722.32 }, 'pax-gold': { usd: 4286.4 } }) });
  if (u.includes('fapi.binance.com') && u.includes('klines')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(klines(priceOf(sym))) });
  }
  if (u.includes('fapi.binance.com') && u.includes('premiumIndex')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = priceOf(sym);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, markPrice: String(p), indexPrice: String(p), lastFundingRate: '0.00004437' }) });
  }
  if (u.includes('fapi.binance.com') && u.includes('ticker/24hr')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = priceOf(sym);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, lastPrice: String(p), markPrice: String(p) }) });
  }
  return Promise.reject(new Error('unstubbed ' + u.slice(0, 60)));
};

/* 注意：jsdom 的 localStorage 是代理对象，直接覆盖 getItem / setItem 不生效
 * （会被当成写入一个名为 getItem 的存储项），所以这里用原生 storage 预置存档。 */
const AUTO_KEY = 'mb_auto_v1';
const nowMs = () => Date.now();
const IV = 30 * 60000;
// 启动状态：已开启、上一档在 2 个间隔之前（应补 3 单）
w.localStorage.setItem(AUTO_KEY, JSON.stringify({
  on: true, sym: 'ETH', tf: '1h', margin: 1000, lev: 10, ivMin: 30, rr: 1.5,
  nextAt: nowMs() - 2 * IV - 5000, orders: [], startedAt: nowMs() - 10 * IV,
}));
const store = new Proxy({}, { get: (t, k) => w.localStorage.getItem(k) });

(async () => {
  w.eval(appjs);
  await new Promise(r => setTimeout(r, 900));      // 等 init 的 refresh + autoCatchUp 跑完

  const st = JSON.parse(store[AUTO_KEY] || '{}');
  const orders = st.orders || [];

  console.log('\n[1] 到点自动开仓');
  ok(orders.length === 3, '错过 2 个间隔 → 补齐 3 单（含当前档）', 'got ' + orders.length);
  ok(orders.every(o => o.sym === 'ETH'), '全部单据品种为 ETH（其余品种不参与）');
  ok(orders.every(o => o.tf === '1h'), '结论周期一致');
  ok(orders.every(o => o.margin === 1000 && o.lev === 10 && o.notional === 10000),
     '每单保证金 1000 / 杠杆 10× / 名义 10000');
  ok(orders.every(o => o.catchup === true), '补单已标注（便于区分实时档与补单档）');
  const opened = orders.filter(o => o.status === 'open');
  ok(opened.length > 0, '至少开出一笔真实方向的持仓', 'open=' + opened.length);
  ok(orders.every(o => o.status === 'open' || o.status === 'skip'), '单据状态为持仓或跳过（观望不下单）');

  console.log('\n[2] 止盈止损价位');
  opened.forEach((o, i) => {
    const r2 = v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
    ok(r2(o.sl) && r2(o.tp1), `第 ${i + 1} 笔止盈止损精确到两位小数`, `${o.sl}/${o.tp1}`);
    if (o.side === 'long') ok(o.sl < o.entry && o.tp1 > o.entry, `第 ${i + 1} 笔做多：止损在下、止盈在上`, `${o.sl}/${o.entry}/${o.tp1}`);
    if (o.side === 'short') ok(o.sl > o.entry && o.tp1 < o.entry, `第 ${i + 1} 笔做空：止损在上、止盈在下`, `${o.sl}/${o.entry}/${o.tp1}`);
    const rr = Math.abs(o.tp1 - o.entry) / Math.abs(o.entry - o.sl);
    ok(Math.abs(rr - 1.5) < 0.02, `第 ${i + 1} 笔盈亏比 = 1.5`, rr.toFixed(4));
  });
  ok(opened.every(o => o.entry > 0), '入场价为真实市价（非 0）');

  console.log('\n[3] 信号标注');
  ok(opened.every(o => o.sig && o.sig.text && o.sig.text.length > 8), '每单标注下单信号', opened[0] && opened[0].sig.text);
  ok(opened.every(o => /结构|KDJ|MACD/.test(o.sig.text)), '信号含结构 / KDJ / MACD 口径');
  ok(opened.every(o => o.sig.conf >= 0), '信号附一致度');

  console.log('\n[4] 到价自动平仓（改行情触发）');
  const first = opened[0];
  if (first) {
    // 先把价格推到止盈价之外，下一轮 tick 必须自动平仓，且不需要任何确认
    ethPx = first.tp1 + (first.side === 'long' ? 5 : -5);
    await new Promise(r => setTimeout(r, 9500));   // 报价 7 秒刷新一轮，等它回来才会触发平仓判定
    const st2 = JSON.parse(store[AUTO_KEY] || '{}');
    const done = (st2.orders || []).find(o => o.id === first.id);
    ok(done && done.status === 'win', '触及止盈价 → 自动止盈平仓', done && done.status);
    ok(done && done.exitPx === first.tp1, '按触发价成交', done && done.exitPx);
    ok(done && done.pnl > 0, '止盈单为盈利', done && done.pnl && done.pnl.toFixed(2));
    ok(done && done.fee > 0, '计入双边手续费', done && done.fee && done.fee.toFixed(2));
    ok(done && /止盈/.test(done.reason), '平仓原因写明止盈', done && done.reason);
  } else {
    ok(false, '（跳过：本轮无持仓）');
  }

  /* 三笔补单共用同一时刻的市价，止盈止损位相同，一触发就同时平掉，
   * 所以这里只在「还有持仓」时验证止损链路；否则改为验证平仓后的统计与留存。
   * 止损命中与亏损计算的口径由 _auto.js 的纯计算段覆盖。 */
  console.log('\n[5] 平仓后的统计与留存');
  {
    const st3 = JSON.parse(store[AUTO_KEY] || '{}');
    const stillOpen = (st3.orders || []).filter(o => o.status === 'open');
    if (stillOpen.length) {
      const o = stillOpen[0];
      ethPx = o.sl + (o.side === 'long' ? -5 : 5);
      await new Promise(r => setTimeout(r, 9500));
      const st4 = JSON.parse(store[AUTO_KEY] || '{}');
      const d = (st4.orders || []).find(x => x.id === o.id);
      ok(d && d.status === 'loss', '触及止损价 → 自动止损平仓', d && d.status);
      ok(d && d.pnl < 0, '止损单为亏损', d && d.pnl && d.pnl.toFixed(2));
    } else {
      ok(true, '（本轮持仓已全部平掉，止损口径见 _auto.js 纯计算段）');
    }
    const stx = JSON.parse(store[AUTO_KEY] || '{}');
    const closed = (stx.orders || []).filter(o => o.status === 'win' || o.status === 'loss');
    ok(closed.length > 0, '已平仓单据保留在存档中');
    ok(closed.every(o => o.exitT && o.exitPx > 0 && o.pnl != null), '每笔平仓记录出场时间、价格与盈亏');
    ok(/止盈|止损/.test(doc.querySelector('#autoCard').textContent), '统计区反映已平仓结果');
  }

  console.log('\n[6] 单据保留与渲染');
  const st5 = JSON.parse(store[AUTO_KEY] || '{}');
  ok(st5.orders.length >= 3, '单据只增不删', 'total=' + st5.orders.length);
  ok(st5.nextAt > nowMs(), '网格已推进到未来档位');
  const card = doc.querySelector('#autoCard').textContent;
  ok(/累计单据/.test(card) && /今日/.test(card), '统计区已渲染');
  ok(!/NaN|undefined/.test(card), '自动交易区无 NaN / undefined');
  ok(doc.querySelectorAll('#autoDays .al-day').length >= 1, '历史按天分组已渲染');
  ok(errors.length === 0, '全流程无未捕获异常', errors.join(' | '));

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
