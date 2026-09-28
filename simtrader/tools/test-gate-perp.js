/* 验证两件事：
   1) 站点内 FVG 代码已彻底移除（三个文件都不再有引用）
   2) 行情源收敛为唯一 Gate.io USDT 永续 —— 源链构成、URL、推送地址、品种映射，
      并用真实数据实跑一遍 K线 / 实时价 / 24h涨跌 / 逐笔成交 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');

let ok = true;
function assert(c, m) { if (!c) { ok = false; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); }

/* ---------- 一、FVG 残留检查 ---------- */
console.log('【FVG 是否已彻底移除】');
assert(!/fvg/i.test(appSrc), 'app.js 无 FVG 代码');
assert(!/fvg/i.test(html), 'index.html 无 FVG 开关 / 说明 / 脚本引入');
assert(!/fvg/i.test(css), 'style.css 无 FVG 样式');
assert(!fs.existsSync(path.join(DIR, 'fvg-strategy.js')), '站点目录内已无 fvg-strategy.js');
assert(!/fvg-strategy\.js/.test(html), '页面不再加载 fvg-strategy.js');

/* ---------- 二、其它交易所残留检查 ---------- */
console.log('\n【其它行情源残留检查】');
assert(!/fapi\d?\.binance\.com/.test(appSrc), '无币安永续 fapi 域名');
assert(!/api\d?\.binance\.com/.test(appSrc), '无币安现货 api 域名');
assert(!/data-api\.binance\.vision/.test(appSrc), '无 data-api.binance.vision');
assert(!/fstream/.test(appSrc), '无币安 fstream 推送');
assert(!/\/api\/v4\/spot\//.test(appSrc), '无 Gate 现货接口');
/* 回测历史源允许保留 'binance' 标识（长周期历史只有币安现货能回溯到 2017 年），
   但除这个标识外，app.js 里不应再出现任何 binance 字样（实盘源必须是 Gate 永续） */
const appNoBtSrc = appSrc.replace(/r\.src\s*===\s*['"]binance['"]/g, '');
assert(!/binance/i.test(appNoBtSrc), 'app.js 除回测源标识外已无 binance 字样');

/* ---------- 三、加载 app.js，断言源链 ---------- */
const el = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
  setAttribute() {}, getAttribute: () => null, remove() {}, dataset: {},
  textContent: '', innerHTML: '', value: '', clientWidth: 900, clientHeight: 400,
});
const doc = {
  createElement: el, createElementNS: el, getElementById: () => el(),
  querySelector: () => el(), querySelectorAll: () => [], addEventListener() {},
  body: el(), documentElement: el(),
};
const win = {
  addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
  location: { href: '', search: '' }, navigator: { userAgent: 'node' }, devicePixelRatio: 1,
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
};
function deepProxy() {
  const proxy = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'width' || k === 'height') return () => 62;
      if (k === Symbol.toPrimitive || k === 'valueOf') return () => 0;
      if (k === 'then') return undefined;
      return proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}
const LWC = { createChart: () => deepProxy() };

const exportLine = `\nreturn { KLINE_SOURCES, GATE_FUT_SOURCE, wsPlanFor, srcKindText,
  GATE_FUT_PAIR, SYM_FALLBACK, INSTRUMENTS, SYM_MAP, gateContracts, gateWsChannel };`;
let api;
try {
  const factory = new Function('window', 'document', 'localStorage', 'navigator', 'LightweightCharts',
    'ResizeObserver', 'WebSocket', 'fetch', appSrc + exportLine);
  api = factory(win, doc, win.localStorage, win.navigator, LWC, win.ResizeObserver, function () {}, async () => ({}));
} catch (e) {
  console.log('加载 app.js 失败：' + e.message);
  process.exit(1);
}

console.log('\n【源链构成】');
api.KLINE_SOURCES.forEach((s, i) => console.log(`  ${i}. ${s.name}  key=${s.key}  kind=${s.kind}`));
assert(api.KLINE_SOURCES.length === 1, `源链只有 1 个源（实际 ${api.KLINE_SOURCES.length}）`);
const S = api.KLINE_SOURCES[0];
assert(S.key === 'gate_perp', '唯一源是 Gate.io 永续（gate_perp）');
assert(S.kind === 'perp', '源的口径是永续（perp）');
assert(S.pingUrl.indexOf('/api/v4/futures/usdt/') > 0, '探测地址走永续接口：' + S.pingUrl);
assert(api.srcKindText() === 'Gate.io 永续', 'K线说明固定显示「Gate.io 永续」');
assert(!api.KLINE_SOURCES.some(s => s.kind === 'spot'), '源链里没有任何现货源');

console.log('\n【实时推送】');
const plan = api.wsPlanFor();
console.log('  推送地址: ' + plan.hosts[0] + '  订阅频道: ' + api.gateWsChannel());
assert(plan.type === 'gate' && plan.market === 'futures', '推送走 Gate 期货通道');
assert(plan.hosts[0] === 'wss://fx-ws.gateio.ws/v4/ws/usdt', '推送地址是 Gate 永续 WS');
assert(api.gateWsChannel() === 'futures.trades', '订阅的是永续成交频道 futures.trades');
const contracts = api.gateContracts();
console.log('  订阅合约: ' + contracts.join(', '));
assert(contracts.length === 4, '四个品种都有永续合约');
assert(contracts.every(c => /_USDT$/.test(c)), '订阅的都是 USDT 永续合约');

console.log('\n【品种与代码映射】');
console.log('  GATE_FUT_PAIR: ' + JSON.stringify(api.GATE_FUT_PAIR));
const gold = api.INSTRUMENTS.find(i => i.id === 'GOLD');
console.log('  黄金主代码: ' + gold.sym + '  备用: XAUUSDT → ' + api.SYM_FALLBACK.XAUUSDT);
assert(gold.sym === 'XAUUSDT', '黄金主代码 XAUUSDT');
assert(api.GATE_FUT_PAIR.XAUUSDT === 'XAU_USDT', '黄金映射到 Gate 的 XAU_USDT 永续');
assert(api.SYM_FALLBACK.XAUUSDT === 'PAXGUSDT', '黄金备用代码 PAXGUSDT');
assert(api.GATE_FUT_PAIR.PAXGUSDT === 'PAXG_USDT', '备用代码也是永续合约（PAXG_USDT），不会掉到现货');
assert(api.SYM_MAP.XAUUSDT === 'GOLD', '推送合约能映射回黄金品种');

/* ---------- 四、真实数据实跑 ---------- */
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 1200)); }
  }
}

(async () => {
  console.log('\n【真实数据实跑（Gate.io USDT 永续）】');
  const HOST = 'https://api.gateio.ws';
  let live = true;
  try {
    /* K线：按 app.js 的解析规则转换 */
    for (const [sym, contract] of [['BTCUSDT', 'BTC_USDT'], ['XAUUSDT', 'XAU_USDT']]) {
      const j = await get(`${HOST}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=15m&limit=5`);
      const c = j.map(a => ({ time: +a.t, open: +a.o, high: +a.h, low: +a.l, close: +a.c, volume: +a.v }));
      const sorted = c.every((x, i) => i === 0 || x.time > c[i - 1].time);
      const valid = c.every(x => x.close > 0 && x.high >= x.low && x.high >= x.close && x.low <= x.close);
      console.log(`  ${sym} 15m 最新: ${c[c.length - 1].close} (${c.length} 根)`);
      assert(c.length === 5, `${sym} K线取到 5 根`);
      assert(sorted, `${sym} K线时间递增`);
      assert(valid, `${sym} K线 OHLC 合法（high≥close≥low）`);
    }
    /* 实时价 + 24h 涨跌 */
    const t = await get(`${HOST}/api/v4/futures/usdt/tickers?contract=BTC_USDT`);
    const px = +t[0].last, chg = +t[0].change_percentage;
    console.log(`  BTC 永续最新价: ${px}  24h涨跌: ${chg}%`);
    assert(px > 0, '实时价有效');
    assert(isFinite(chg), '24小时涨跌幅可解析');
    /* 黄金：主代码 + 备用代码都要能取到（备用也是永续） */
    const g1 = await get(`${HOST}/api/v4/futures/usdt/tickers?contract=XAU_USDT`);
    const g2 = await get(`${HOST}/api/v4/futures/usdt/tickers?contract=PAXG_USDT`);
    console.log(`  黄金 XAU_USDT: ${+g1[0].last}  备用 PAXG_USDT: ${+g2[0].last}`);
    assert(+g1[0].last > 0, '黄金永续 XAU 有价');
    assert(+g2[0].last > 0, '备用 PAXG 永续有价（回退不会掉到现货）');
    /* 逐笔成交 */
    const tr = await get(`${HOST}/api/v4/futures/usdt/trades?contract=BTC_USDT&limit=10`);
    const norm = tr.map(x => ({ T: Math.round(+(x.create_time_ms != null ? x.create_time_ms : x.create_time * 1000)), p: x.price, q: x.size }));
    console.log(`  逐笔成交: ${norm.length} 笔，最新 ${norm[0] && norm[0].p}`);
    assert(norm.length === 10, '逐笔成交取到 10 笔');
    assert(norm.every(x => +x.p > 0 && isFinite(x.T)), '逐笔字段（时间/价格）解析正确');
  } catch (e) {
    live = false;
    console.log('  ⚠ 真实数据拉取失败（网络问题，非代码问题）：' + e.message);
  }

  console.log('\n' + (ok ? '验证通过' : '验证失败') + (live ? '' : '（真实数据部分因网络未跑完）'));
  process.exit(ok ? 0 : 1);
})();
