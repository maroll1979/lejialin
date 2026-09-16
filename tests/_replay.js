// P1-3 历史回放与样本外验证：jsdom 加载真实页面，
// 直接对 window.autoReplay / window.renderReplay 做断言。
// 验证：参数校验、订单字段自洽、样本内+样本外=全段、三种市况分区、界面渲染与按钮。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8779/', pretendToBeVisual: true });
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
const STEP = 15 * 60000;                    // 15 分钟一根
/** 确定性伪随机，保证测试可复现 */
let seed = 20260916;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
/** 分段趋势 + 噪声的 K 线序列，保证既有趋势段也有震荡段 */
function mkBars(n, base) {
  const out = [];
  let px = base;
  const t0 = Math.floor(Date.now() / STEP) * STEP - (n - 1) * STEP;
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / 80) % 3;      // 0 上升 / 1 震荡 / 2 下降
    const drift = seg === 0 ? 0.0016 : seg === 2 ? -0.0016 : 0;
    const open = px;
    const close = open * (1 + drift + (rnd() - 0.5) * 0.006);
    const hi = Math.max(open, close) * (1 + rnd() * 0.0022);
    const lo = Math.min(open, close) * (1 - rnd() * 0.0022);
    out.push({ t: t0 + i * STEP, o: open, h: hi, l: lo, c: close, v: 100 + i });
    px = close;
  }
  return out;
}

w.fetch = url => {
  const u = String(url);
  if (u.includes('api.coingecko.com'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ethereum: { usd: ETH }, bitcoin: { usd: 77872.12 }, binancecoin: { usd: 722.32 }, 'pax-gold': { usd: 4286.4 } }) });
  if (u.includes('fapi.binance.com') && u.includes('klines')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const b = /^ETH/.test(sym) ? ETH : 77872.12;
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(mkBars(240, b)
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
  await new Promise(r => setTimeout(r, 300));

  console.log('\n[1] 参数校验');
  ok(typeof w.autoReplay === 'function', 'autoReplay 已暴露给测试');
  ok(typeof w.replayStatsOf === 'function', 'replayStatsOf 已暴露给测试');
  const short = mkBars(30, ETH);
  ok(!!w.autoReplay(short, {}).error, 'K 线不足 60 根时返回错误', JSON.stringify(w.autoReplay(short, {})));
  const bad = mkBars(80, ETH); bad[5].t = bad[4].t; bad[6].t = bad[4].t;
  const rb = w.autoReplay(bad, {});
  ok(!rb.error || /时间戳/.test(String(rb.error)), '时间戳异常时给出提示', String(rb.error));

  console.log('\n[2] 回放结果自洽');
  const bars = mkBars(400, ETH);
  const r = w.autoReplay(bars, { ivMin: 30, margin: 1000, lev: 10, rr: 1.5 });
  ok(!r.error, '正常序列可回放', String(r.error));
  ok(Array.isArray(r.orders), '返回订单数组');
  ok(r.orders.length > 0, `产生了回放订单（${r.orders.length} 笔）`);
  ok(r.n === 400 && r.cut === 280, `样本切分 前${r.cut}/后${r.n - r.cut}`);

  const badSide = r.orders.filter(o => o.side !== 'long' && o.side !== 'short');
  ok(badSide.length === 0, '每笔都有明确方向');
  const badLv = r.orders.filter(o => !(o.sl > 0) || !(o.tp1 > 0)
    || (o.side === 'long' && !(o.sl < o.entry && o.tp1 > o.entry))
    || (o.side === 'short' && !(o.sl > o.entry && o.tp1 < o.entry)));
  ok(badLv.length === 0, '止损止盈方向与仓位一致', JSON.stringify(badLv[0] || {}));
  const badFee = r.orders.filter(o => Math.abs(o.fee - 1000 * 10 * 0.0005 * 2) > 1e-6);
  ok(badFee.length === 0, '每笔手续费 = 名义本金 × 0.05% × 2');
  // 与实盘同口径：毛盈亏 − 手续费 + 资金费（资金费可为 0，取决于持仓跨越的结算点）
  const badPnl = r.orders.filter(o => Math.abs(o.pnl - (o.gross - o.fee + (o.fund || 0))) > 1e-6);
  ok(badPnl.length === 0, '净盈亏 = 毛盈亏 - 手续费 + 资金费', JSON.stringify(badPnl[0] || {}));
  const badFund = r.orders.filter(o => o.fund == null || !isFinite(o.fund));
  ok(badFund.length === 0, '每笔都记录了资金费（可为 0）');
  const badReg = r.orders.filter(o => !['up', 'down', 'range'].includes(o.regime));
  ok(badReg.length === 0, '每笔都标注了市况');

  console.log('\n[3] 统计口径');
  const s = r.stats;
  ok(s.total === r.orders.length, '全段单数 = 订单数');
  ok(!!r.ins && !!r.oos, '返回样本内 / 样本外分段统计');
  ok(r.ins.total + r.oos.total === s.total, '样本内 + 样本外 = 全段单数', `${r.ins.total}+${r.oos.total} vs ${s.total}`);
  ok(Math.abs((r.ins.net + r.oos.net) - s.net) < 1e-6, '样本内 + 样本外 = 全段净盈亏');
  ok(s.maxDd >= 0, '最大回撤非负');
  ok(s.rate == null || (s.rate >= 0 && s.rate <= 100), '胜率在 0–100 之间');
  const regSum = s.regimes.up.n + s.regimes.down.n + s.regimes.range.n;
  ok(regSum === s.total, `三种市况单数之和 = 总数（上升${s.regimes.up.n}/下降${s.regimes.down.n}/震荡${s.regimes.range.n}）`);
  ok(r.orders.every(o => o.idx < 400 && o.exitIdx >= o.idx), '出场索引不早于入场索引');

  console.log('\n[4] 空样本不报错');
  const empty = w.replayStatsOf([]);
  ok(empty.total === 0 && empty.rate === null, '空列表返回零值统计');
  ok(empty.maxDd === 0 && empty.net === 0, '空列表净盈亏与回撤为 0');

  console.log('\n[5] 界面渲染');
  w.MB_STATE.klines = w.MB_STATE.klines || {};
  w.MB_STATE.klines['ETH'] = w.MB_STATE.klines['ETH'] || {};
  w.MB_STATE.klines['ETH']['1h'] = { bars: mkBars(300, ETH), real: true, src: 'test' };
  ok(!!doc.querySelector('#replayResult'), '页面存在回放结果容器');
  ok(!!doc.querySelector('#replayRun'), '页面存在运行回放按钮');
  ok(!!doc.querySelector('#replayMeta'), '页面存在回放元信息');
  w.renderReplay();
  const out = doc.querySelector('#replayResult').textContent;
  ok(/样本内/.test(out) && /样本外/.test(out), '渲染出样本内 / 样本外两段', out.slice(0, 80));
  ok(/根 K 线/.test(doc.querySelector('#replayMeta').textContent), '元信息标注 K 线根数');
  ok(/胜率/.test(out) && /最大回撤/.test(out), '渲染出胜率与最大回撤');

  console.log('\n[6] 点击按钮触发回放');
  doc.querySelector('#replayResult').innerHTML = '';
  doc.querySelector('#replayRun').dispatchEvent(new w.Event('click'));
  await new Promise(r => setTimeout(r, 200));
  const out2 = doc.querySelector('#replayResult').textContent;
  ok(out2.length > 10, '点击后回放结果已渲染', out2.slice(0, 60));
  ok(doc.querySelector('#replayRun').disabled === false, '回放结束后按钮恢复可用');

  console.log('\n[7] 无未捕获错误');
  ok(errors.length === 0, '运行期无未捕获错误', errors.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
