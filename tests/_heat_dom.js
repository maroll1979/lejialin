// 热力图浏览器端冒烟：jsdom 中加载真实页面，验证渲染、切换与 hover 链路
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8777/', pretendToBeVisual: true });
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

const CG = { bitcoin: { usd: 77872.12 }, ethereum: { usd: 2512.88 }, binancecoin: { usd: 722.32 }, 'pax-gold': { usd: 4286.4 } };
let cgLiq = null;          // 置为数组则模拟 Coinglass 成功
w.fetch = url => {
  const u = String(url);
  if (u.includes('api.coingecko.com')) {
    const ids = decodeURIComponent((u.match(/ids=([^&]+)/) || [])[1] || '');
    const data = {};
    ids.split(',').forEach(i => { if (CG[i]) data[i] = CG[i]; });
    return Object.keys(data).length
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
      : Promise.reject(new Error('no id'));
  }
  if (u.includes('api.gold-api.com')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ price: 4287.1 }) });
  if (u.includes('fapi.binance.com') && u.includes('globalLongShortAccountRatio'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ symbol: 'BTCUSDT', longShortRatio: '1.5100', longAccount: '0.6016', shortAccount: '0.3984', timestamp: Date.now() }]) });
  if (u.includes('fapi.binance.com') && u.includes('takerlongshortRatio'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ buySellRatio: '0.7076', buyVol: '1508', sellVol: '2131', timestamp: Date.now() }]) });
  /* K 线 / 标记价桩：新版不再用合成 K 线兜底 —— 取不到真实 K 线就没有热力图。
   * 所以这里必须给出一条真实的（桩）K 线序列，否则整条热力图链路无从触发。 */
  if (u.includes('fapi.binance.com') && u.includes('klines')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const base = /^BTC/.test(sym) ? 77872.12 : /^ETH/.test(sym) ? 2512.88
      : /^BNB/.test(sym) ? 722.32 : /^XAU/.test(sym) ? 4286.40 : 104.07;
    const data = Array.from({ length: 240 }, (_, i) => {
      const o = base * (1 + Math.sin(i / 9) * 0.004 + (i - 120) * 0.00004);
      return [Math.floor(Date.now() / 900000) * 900000 - (239 - i) * 900000, o, o * 1.0012, o * 0.9988, o * 1.0004, 100 + i, 0, 0, 0, 0, 0, 0];
    });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  }
  if (u.includes('fapi.binance.com') && u.includes('premiumIndex')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = /^BTC/.test(sym) ? 77872.12 : /^ETH/.test(sym) ? 2512.88
      : /^BNB/.test(sym) ? 722.32 : /^XAU/.test(sym) ? 4286.40 : 104.07;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, markPrice: String(p), indexPrice: String(p), lastFundingRate: '0.00004437' }) });
  }
  /* 商品期货 K 线（布伦特 / 伦敦金）走 Yahoo。生产环境就是这个源，
   * 桩里不给它，布伦特就没有一根真实 K 线，热力图链路无从触发。 */
  if (u.includes('query1.finance.yahoo.com')) {
    const sym = decodeURIComponent((u.match(/chart\/([^?]+)/) || [])[1] || '');
    const base = /XAU/.test(sym) ? 4286.40 : 104.07;
    const n = 240, ts = [], O = [], H = [], L = [], C = [], V = [];
    for (let i = 0; i < n; i++) {
      const o = base * (1 + Math.sin(i / 9) * 0.004 + (i - 120) * 0.00004);
      ts.push(Math.floor((Date.now() - (n - 1 - i) * 900000) / 1000));
      O.push(o); H.push(o * 1.0012); L.push(o * 0.9988); C.push(o * 1.0004); V.push(100 + i);
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      chart: { result: [{ meta: { regularMarketPrice: base }, timestamp: ts,
        indicators: { quote: [{ open: O, high: H, low: L, close: C, volume: V }] } }] } }) });
  }
  if (u.includes('open-api-v3.coinglass.com')) {
    if (!cgLiq) return Promise.reject(new Error('no key'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '0', msg: 'success', data: cgLiq }) });
  }
  return Promise.reject(new Error('blocked: ' + u.slice(0, 48)));
};
w.confirm = () => true;
let promptRet = null;
w.prompt = () => promptRet;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = s => (doc.querySelector(s) || {}).textContent || '';
const hasNaN = () => /NaN|undefined|Infinity/.test(doc.body.textContent);

(async () => {
  console.log('\n[1] 热力图卡片渲染');
  try { w.eval(appjs); } catch (e) { ok(false, '脚本执行未抛异常', e.message); }
  for (let i = 0; i < 60 && txt('#heatSrc') === '—'; i++) await sleep(50);
  await sleep(300);

  ok(!!doc.querySelector('#heatCard'), '热力图卡片存在');
  ok(!!doc.querySelector('#heat'), '热力图 canvas 存在');
  ok(txt('#heatSrc') !== '—' && txt('#heatSrc').length > 0, '数据来源已标注', txt('#heatSrc'));
  ok(txt('#heatSym') === 'BTC', '标题显示当前品种', txt('#heatSym'));
  ok(doc.querySelectorAll('#heatStats .hst').length === 3, '统计条 3 格',
    String(doc.querySelectorAll('#heatStats .hst').length));
  ok(/价格区间/.test(txt('#heatScale')), '显示价格区间', txt('#heatScale'));
  ok(txt('#heatNote').length > 40, '底部说明非空');
  ok(doc.querySelectorAll('#heatTabs .tf').length === 4, '4 个数据源按钮');

  console.log('\n[2] 币安实盘分支（真实多空比）');
  ok(/Binance/.test(txt('#heatSrc')), '默认走 Binance 分支', txt('#heatSrc'));
  ok(/多空持仓人数比 1\.51/.test(txt('#heatNote')), '说明中带真实多空比 1.51',
    (txt('#heatNote').match(/多空持仓人数比 [\d.]+/) || [''])[0]);
  ok(doc.querySelector('#heatSrc').className.includes('src'), '来源标签样式类已设置');

  const stats = Array.from(doc.querySelectorAll('#heatStats .hst')).map(e => e.textContent);
  ok(/多头筹码密集区/.test(stats[0]), '第 1 格为多头筹码密集区');
  ok(/空头筹码密集区/.test(stats[1]), '第 2 格为空头筹码密集区');
  ok(/多空净偏向/.test(stats[2]), '第 3 格为多空净偏向');
  ok(stats.every(s => !/NaN|undefined/.test(s)), '统计格无 NaN', stats.join(' | ').slice(0, 120));

  console.log('\n[3] 切换数据源');
  const tab = k => doc.querySelector(`#heatTabs [data-hs="${k}"]`);
  tab('local').click();
  // 两条推算链路都以「潜在清算区模型」开头，等更具体的「仅 K 线推算」才算真正切到本地
  for (let i = 0; i < 40 && !/仅 K 线推算/.test(txt('#heatSrc')); i++) await sleep(50);
  ok(/潜在清算区模型/.test(txt('#heatSrc')), '切到本地推算生效', txt('#heatSrc'));
  ok(tab('local').className.includes('on'), '本地估算按钮高亮');
  ok(!tab('binance').className.includes('on'), '其他按钮取消高亮');
  ok(doc.querySelector('#heatSrc').className.includes('syn'), '本地估算标注为警示样式');

  tab('binance').click();
  for (let i = 0; i < 40 && !/Binance/.test(txt('#heatSrc')); i++) await sleep(50);
  ok(/Binance/.test(txt('#heatSrc')), '切回币安实盘生效', txt('#heatSrc'));

  console.log('\n[4] Coinglass 分支（Key + 真实清算记录）');
  promptRet = null;                        // 用户取消输入 → 不应切换
  tab('coinglass').click();
  await sleep(120);
  ok(/Binance|本地/.test(txt('#heatSrc')), '取消输入时不切换数据源', txt('#heatSrc'));

  cgLiq = Array.from({ length: 80 }, (_, i) => ({
    price: 77800 + (i % 40) * 12, volUsd: 5e5 + i * 1000,
    time: Date.now() - (80 - i) * 60000, side: i % 2 ? 'L' : 'S',
  }));
  promptRet = 'mock-key';
  tab('coinglass').click();
  for (let i = 0; i < 40 && !/CoinGlass/.test(txt('#heatSrc')); i++) await sleep(50);
  ok(/CoinGlass/.test(txt('#heatSrc')), 'Coinglass 真实清算数据生效', txt('#heatSrc'));
  ok(doc.querySelector('#heatSrc').className.includes('real'), '真实数据标注为 real 样式');
  ok(/真实发生的清算记录/.test(txt('#heatNote')), '说明标注为真实发生的历史清算记录');
  ok(!hasNaN(), 'Coinglass 分支无 NaN');

  // 四格方向依赖 S.heats，切源后必须整批重算，不能只刷当前那张图
  for (let i = 0; i < 60; i++) {
    const n = doc.querySelectorAll('#sigGrid .sig-src.g-real').length;
    if (n >= 4) break;
    await sleep(50);
  }
  const realTags = doc.querySelectorAll('#sigGrid .sig-src.g-real').length;
  ok(realTags === 4, '切到 Coinglass 后四格来源全部变为真实清算', 'g-real 格数=' + realTags);
  ok(doc.querySelectorAll('#sigGrid .sig').length === 4, '四格信号仍为 4 格');
  ok(!/NaN|undefined/.test(doc.querySelector('#sigGrid').textContent), '四格无 NaN');

  tab('local').click();
  for (let i = 0; i < 60; i++) {
    const n = doc.querySelectorAll('#sigGrid .sig-src.g-est').length;
    if (n >= 4) break;
    await sleep(50);
  }
  ok(doc.querySelectorAll('#sigGrid .sig-src.g-est').length === 4, '切回本地估算后四格来源同步降级为估算',
    'g-est 格数=' + doc.querySelectorAll('#sigGrid .sig-src.g-est').length);
  tab('coinglass').click();
  for (let i = 0; i < 60 && doc.querySelectorAll('#sigGrid .sig-src.g-real').length < 4; i++) await sleep(50);
  ok(doc.querySelectorAll('#sigGrid .sig-src.g-real').length === 4, '再切回 Coinglass 四格恢复真实清算');

  console.log('\n[5] 切换品种与周期');
  doc.querySelector('#ovGrid [data-sym="ETH"]').click();
  for (let i = 0; i < 40 && txt('#heatSym') !== 'ETH'; i++) await sleep(50);
  await sleep(200);
  ok(txt('#heatSym') === 'ETH', '切品种后热力图标题跟随', txt('#heatSym'));
  ok(!hasNaN(), '切品种后无 NaN');

  // UKOIL 无币安永续映射，应给出降级提示；XAUUSD 已有 XAUUSDT 永续，不再走此分支
  doc.querySelector('#ovGrid [data-sym="UKOIL"]').click();
  for (let i = 0; i < 40 && txt('#heatSym') !== 'BRENT'; i++) await sleep(50);
  await sleep(200);
  ok(txt('#heatSym') === 'BRENT', '布伦特品种切换正常', txt('#heatSym'));
  ok(/无币安永续合约映射/.test(txt('#heatNote')), '非合约品种给出提示');

  doc.querySelector('#ovGrid [data-sym="BTC"]').click();
  await sleep(250);
  doc.querySelector('#tfTabs [data-tf="15m"]').click();
  await sleep(400);
  ok(txt('#heatSrc').length > 0, '切周期后热力图仍渲染');
  ok(!hasNaN(), '切周期后无 NaN');

  console.log('\n[6] hover 读数');
  promptRet = null;
  tab('local').click();
  await sleep(300);
  const cv = doc.querySelector('#heat');
  const mv = new w.MouseEvent('mousemove', { clientX: 200, clientY: 120, bubbles: true });
  cv.dispatchEvent(mv);
  await sleep(60);
  const tip = doc.querySelector('#heatTip');
  ok(tip.style.display === 'block', 'hover 显示读数浮层', 'display=' + tip.style.display);
  ok(/强度/.test(tip.textContent) && /净向/.test(tip.textContent), '浮层含强度与净向',
    tip.textContent.replace(/\s+/g, ' ').slice(0, 70));
  ok(!/NaN|undefined/.test(tip.textContent), '浮层无 NaN', tip.textContent.slice(0, 70));

  cv.dispatchEvent(new w.MouseEvent('mouseleave', { bubbles: true }));
  await sleep(40);
  ok(tip.style.display === 'none', '移出后隐藏浮层');

  console.log('\n[7] 全局健壮性');
  ok(!hasNaN(), '页面无 NaN / undefined / Infinity');
  ok(errors.length === 0, '无未捕获异常', errors.join(' | ').slice(0, 200));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
