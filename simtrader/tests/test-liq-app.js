/* app.js 整体冒烟：mock DOM + mock LightweightCharts 加载真实 app.js（boot 会执行），
   验证新增的清算图钩子不破坏启动，且接入点齐全 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');   // 站点文件在 tests/ 的上一级 simtrader/
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const liqSrc = fs.readFileSync(path.join(DIR, 'liq-map.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');

let fail = 0;
const ok = (c, m, x) => { console.log((c ? '  PASS ' : '  FAIL ') + m + (x != null ? ' → ' + x : '')); if (!c) fail++; };

console.log('【接入点静态检查】');
ok(/liq-map\.js\?v=20260923f/.test(html), 'index.html 引入 liq-map.js（在 app.js 之前）');
ok(html.indexOf('liq-map.js') < html.indexOf('app.js?v='), 'liq-map.js 先于 app.js 加载');
ok(/id="liqToggle"/.test(html) && /id="liqStat"/.test(html), '页面含清算图开关与状态位');
ok(/window\.LiqMap\.init\(chart, state\.candleSeries/.test(appSrc), 'initChart 中初始化清算图');
ok(/subscribeVisibleTimeRangeChange\(\(\) => window\.LiqMap\.render\(\)\)/.test(appSrc), '缩放/平移时重绘清算图');
ok(/window\.LiqMap\.setCandles\(candles\)/.test(appSrc), 'paintChart 后同步 K 线并重绘');
ok(/window\.LiqMap\.setInstrument\(id, GATE_FUT_PAIR/.test(appSrc), '切换品种时切换清算图合约');
ok(/window\.LiqMap\.refresh\(true\)/.test(appSrc), '全量刷新时回溯 24 小时');
ok(/window\.LiqMap\.refresh\(false\)/.test(appSrc), '存在增量刷新定时器');
ok(/--liqw: 118px/.test(css) && /#chartBox\.liq-off \{ --liqw: 0px/.test(css), 'CSS：默认留 118px，关闭时归零');
ok(/#chart \{ position: absolute; left: var\(--liqw\)/.test(css), 'CSS：K线容器右移，不与清算图重叠');

/* ---------- mock 环境（沿用 test-gate-perp.js 的骨架） ---------- */
const store = {};
const LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const children = [];
const el = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, appendChild(c) { children.push(c); }, querySelector: () => null, querySelectorAll: () => [],
  setAttribute() {}, getAttribute: () => null, remove() {}, dataset: {},
  textContent: '', innerHTML: '', value: '', clientWidth: 900, clientHeight: 460,
});
const doc = {
  createElement: el, createElementNS: el, getElementById: () => el(),
  querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el(), documentElement: el(),
};
const win = {
  addEventListener() {}, removeEventListener() {}, localStorage: LS,
  location: { href: '', search: '' }, navigator: { userAgent: 'node' }, devicePixelRatio: 1,
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, requestAnimationFrame: fn => setTimeout(fn, 0),
};
function deepProxy() {
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'width' || k === 'height') return () => 62;
      if (k === Symbol.toPrimitive || k === 'valueOf') return () => 0;
      if (k === 'then') return undefined;
      return p;
    },
    apply() { return p; },
  });
  return p;
}
const LWC = { createChart: () => deepProxy() };

console.log('\n【模块加载 + boot 冒烟】');
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'ResizeObserver', 'AbortController', 'fetch', liqSrc)(win, doc, LS, win.requestAnimationFrame, win.ResizeObserver, AbortController, async () => ({ json: async () => [], ok: true }));
ok(!!win.LiqMap, 'liq-map.js 挂载 window.LiqMap');
ok(typeof win.LiqMap.init === 'function' && typeof win.LiqMap.setInstrument === 'function', '对外接口齐全');

let bootErr = null;
try {
  const factory = new Function('window', 'document', 'localStorage', 'navigator', 'LightweightCharts',
    'ResizeObserver', 'WebSocket', 'fetch', appSrc + '\nreturn { LiqMapInitOK: typeof window.LiqMap !== "undefined" };');
  factory(win, doc, LS, win.navigator, LWC, win.ResizeObserver, function () {}, async () => ({ json: async () => ([]), ok: true }));
} catch (e) { bootErr = e; }
ok(!bootErr, 'app.js 加载并完成 boot() 无异常', bootErr ? bootErr.message : 'ok');
ok(children.some(c => c && c.id === 'liqLayer'), '清算图图层已插入 chartBox', `新增子元素 ${children.length} 个`);

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
