/* app.js 整体冒烟：mock DOM + mock LightweightCharts 加载真实 app.js（boot 会执行），
   验证新增的清算图钩子不破坏启动，且接入点齐全 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const liqSrc = fs.readFileSync(path.join(DIR, 'liq-map.js'), 'utf8');
const lsSrc = fs.readFileSync(path.join(DIR, 'lsmap.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');

let fail = 0;
const ok = (c, m, x) => { console.log((c ? '  PASS ' : '  FAIL ') + m + (x != null ? ' → ' + x : '')); if (!c) fail++; };

console.log('【接入点静态检查】');
ok(/lsmap\.js\?v=\d+/.test(html), 'index.html 引入 lsmap.js 且带版本号');
ok(html.indexOf('liq-map.js') < html.indexOf('lsmap.js') && html.indexOf('lsmap.js') < html.indexOf('app.js?v='), '加载顺序 liq-map → lsmap → app');
ok(/id="lsChart"/.test(html) && /id="lsCards"/.test(html) && /id="lsMeta"/.test(html), '页面含多空热力图容器/卡片/状态行');
ok(/data-lsspan="200"/.test(html) && /data-lsspan="500"/.test(html) && /data-lsspan="2000"/.test(html) && /data-lsspan="5000"/.test(html), '页面含 ±200/±500/±2000/±5000 四个视野按钮');
ok(!/lsiv|lslayer|data-lsiv|data-lslayer/.test(html + css + appSrc), '已无旧的 5m/15m/1h/4h 窗口与图层按钮残留');
ok(!/heat-matrix|vpChart|vpMeta|heatMatrix/.test(html + css + appSrc), '已无「多品种多周期热力图 / 成交热力图」残留');
ok(/window\.LsMap\.init\(\$\('#lsChart'\)/.test(appSrc), 'initChart 中初始化多空热力图');
ok(/window\.LsMap\.setInstrument\(/.test(appSrc), '切换品种时切换多空热力图合约');
ok(/window\.LsMap\.setSpan\(\+b\.dataset\.lsspan\)/.test(appSrc), '视野按钮绑定 setSpan');
ok(/window\.LsMap\.span\(\)/.test(appSrc), '按钮高亮读取当前视野');
ok(/window\.LsMap\.refresh\(true\)/.test(appSrc) && /window\.LsMap\.refresh\(false\)/.test(appSrc), '全量刷新与定时刷新都已接入');
ok(/handleScale/.test(appSrc) && /handleScroll/.test(appSrc) && /minBarSpacing/.test(appSrc), 'K线缩放/拖动配置齐全（含最大缩放范围）');
ok(/bindChartHotkeys/.test(appSrc), 'K线键盘微调已绑定');
ok(/liq-map\.js\?v=\d+/.test(html), 'index.html 引入 liq-map.js 且带版本号（在 app.js 之前）');
ok(/id="zoomIn"/.test(html) && /id="zoomOut"/.test(html) && /id="zoomReset"/.test(html), '页面含 K线缩放/复位按钮');
ok(/data-liqwin="168"/.test(html), '页面含清算图 7 天窗口切换');
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
const el = (depth) => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 900, height: 460 }),
  setPointerCapture() {}, releasePointerCapture() {},
  querySelector: () => (depth > 0 ? el(depth - 1) : null),
  addEventListener() {}, appendChild(c) { children.push(c); }, querySelectorAll: () => [],
  setAttribute() {}, getAttribute: () => null, remove() {}, dataset: {},
  textContent: '', innerHTML: '', value: '', clientWidth: 900, clientHeight: 460,
});
const doc = {
  hidden: false,
  createElement: () => el(0), createElementNS: () => el(0), getElementById: () => el(2),
  querySelector: () => el(3), querySelectorAll: () => [], addEventListener() {}, body: el(0), documentElement: el(0),
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
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'AbortController', 'fetch', liqSrc)(win, doc, LS, win.requestAnimationFrame, () => {}, win.ResizeObserver, AbortController, async () => ({ json: async () => [], ok: true }));
ok(!!win.LiqMap, 'liq-map.js 挂载 window.LiqMap');
ok(typeof win.LiqMap.init === 'function' && typeof win.LiqMap.setInstrument === 'function', '清算图对外接口齐全');
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'AbortController', 'fetch', lsSrc)(win, doc, LS, win.requestAnimationFrame, () => {}, win.ResizeObserver, AbortController, async () => ({ json: async () => [], ok: true }));
ok(!!win.LsMap, 'lsmap.js 挂载 window.LsMap');
ok(typeof win.LsMap.init === 'function' && typeof win.LsMap.setSpan === 'function' && typeof win.LsMap.span === 'function' && typeof win.LsMap.book === 'function', '多空热力图对外接口齐全');

let bootErr = null;
try {
  const factory = new Function('window', 'document', 'localStorage', 'navigator', 'LightweightCharts',
    'ResizeObserver', 'WebSocket', 'fetch', appSrc + '\nreturn { ok: typeof window.LiqMap !== "undefined" && typeof window.LsMap !== "undefined" };');
  factory(win, doc, LS, win.navigator, LWC, win.ResizeObserver, function () {}, async () => ({ json: async () => ([]), ok: true }));
} catch (e) { bootErr = e; }
ok(!bootErr, 'app.js 加载并完成 boot() 无异常', bootErr ? bootErr.message : 'ok');
ok(children.some(c => c && c.id === 'liqLayer'), '清算图图层已插入 chartBox', `新增子元素 ${children.length} 个`);

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
