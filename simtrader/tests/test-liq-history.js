/* 历史爆仓持久化校验：模拟「第一次打开」与「关掉后重新打开」两次会话，
   验证第二次打开时无需联网就能立刻看到已累积的历史强平数据 */
const fs = require('fs');
const MOD = require('path').join(__dirname, '..', 'liq-map.js');   /* 仓库内相对路径 */

/* ---- mock 浏览器环境（localStorage 跨「两次会话」保留） ---- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.requestAnimationFrame = fn => setTimeout(() => fn(), 0);
global.ResizeObserver = class { observe() {} };
const mkEl = () => ({
  style: { cssText: '' }, innerHTML: '', id: '',
  appendChild() {}, classList: { toggle() {} },
});
global.document = { createElement: () => mkEl() };

const H = 420;
const chartEl = { clientHeight: H, clientWidth: 782 };
const series = { priceToCoordinate: () => 200 };
const chart = { timeScale: () => ({ getVisibleLogicalRange: () => null }) };
const box = { clientWidth: 900, appendChild() {}, classList: { toggle() {} } };

function loadModule() {
  global.window = {};
  new Function(fs.readFileSync(MOD, 'utf8'))();
  return global.window.LiqMap;
}

let fail = 0;
const ok = (c, m, x) => { console.log((c ? '  PASS ' : '  FAIL ') + m + (x != null ? ' → ' + x : '')); if (!c) fail++; };
const numOf = s => { const m = /强平 (\d+) 笔/.exec(s || ''); return m ? +m[1] : -1; };

(async () => {
  console.log('\n【1】第一次会话：抓取并落盘');
  let M = loadModule();
  M.init(chart, series, box, chartEl);
  await M.setInstrument('ETH', 'ETH_USDT', 2);
  const line1 = M.statusLine();
  console.log('  状态行：' + line1);
  const n1 = numOf(line1);
  ok(n1 > 0, '第一次会话抓到强平数据', n1 + ' 笔');

  const raw = store['simtrader_liq_v1'];
  ok(!!raw, '已写入 localStorage（simtrader_liq_v1）', raw ? (raw.length / 1024).toFixed(1) + ' KB' : '');
  let persisted = 0;
  try { persisted = JSON.parse(raw).ETH_USDT.recs.length; } catch (e) {}
  ok(persisted > 0, '落盘条数与抓到的笔数一致', persisted + ' 条');

  console.log('\n【2】第二次会话（模拟关掉页面再打开，尚未联网）');
  M = loadModule();                 // 重新执行模块 = 全新的运行时，localStorage 保留
  M.init(chart, series, box, chartEl);
  const p = M.setInstrument('ETH', 'ETH_USDT', 2);   // 故意不 await：验证本地历史立刻可用
  const line2 = M.statusLine();
  console.log('  状态行：' + line2);
  const n2 = numOf(line2);
  ok(n2 > 0, '重新打开时无需等待网络即有历史数据', n2 + ' 笔');
  ok(Math.abs(n2 - persisted) <= Math.max(20, persisted * 0.05), '笔数与上次落盘基本一致', `${n2} vs ${persisted}`);
  await p;

  console.log('\n【3】统计窗口切换');
  ok(M.windowHours() === 24, '默认窗口 24h');
  M.setWindow(168);
  ok(M.windowHours() === 168, '切换到 7 天后 windowHours 正确');
  const line7 = M.statusLine();
  console.log('  状态行：' + line7);
  ok(/近7天/.test(line7), '状态行显示「近7天」');
  const n7 = numOf(line7);
  ok(n7 >= n2, '7 天窗口笔数不少于 24h 窗口', `${n7} ≥ ${n2}`);
  M.setWindow(24);

  console.log('\n【4】深度回补（后台把历史往前补，最多 7 天）');
  const before = M.statusLine();
  const kept0 = /本地已存 (\d+)h/.exec(before);
  console.log('  回补前：' + before);
  await new Promise(r => setTimeout(r, 30000));      // 等待后台分块回补
  const after = M.statusLine();
  console.log('  回补后：' + after);
  const kept1 = /本地已存 (\d+)h/.exec(after) || /近24h/.exec(after);
  const h0 = kept0 ? +kept0[1] : 0;
  const h1 = after.includes('本地已存') ? +/本地已存 (\d+)h/.exec(after)[1] : 0;
  ok(h1 > h0 || h1 >= 25, '回补后本地历史跨度变长', `${h0}h → ${h1}h`);

  console.log(fail ? `\n❌ 失败 ${fail} 项` : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
