/* ============================================================================
 * test-band.js — 「量能结构带」算法测试（离线、不联网、答案可手算）
 *
 * 用 jsdom 加载真实的 lsmap.js，喂入**手工构造**的订单簿（Gate REST 的返回格式），
 * 再对返回的 bands 做断言。核心是几条"必须用纸笔能验算"的性质：
 *
 *   · POC 落在人为放置的最厚那一格
 *   · 上方最薄带必须只由卖盘决定（买盘再厚也不能影响它）—— 这是 v1 修掉的分侧逻辑
 *   · 下方最薄带会自动避开 POC 那个巨额格（否则就是把最厚处当成真空）
 *   · 稀疏度 >= 0 且在三明治构造下 < 0.5 → thin = true
 *   · VA 必须包含 POC，且占比 >= 目标值
 *   · 全零簿 → bands 为 null（不能返回一堆 NaN）
 *   · 渲染后的 SVG 里必须出现数轴与四个结构标签
 *
 * 用法：NODE_PATH=<node workspace>/node_modules node test-band.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'simtrader', 'lsmap.js');
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(a, b, tol, name) {
  ok(Math.abs(a - b) <= (tol == null ? 1e-9 : tol), name, `got ${a}, want ${b}`);
}

/* ---------------------------------------------------------------- 构造数据 */
/* P=1000 tick=0.01 mult=0.01 视野±500tick → [995,1005]，BINS=72，step≈0.13889
   nowBin = 36；买盘占 bin 0..35，卖盘占 bin 37..71                         */
const P = 1000, TICK = 0.01, MULT = 0.01, LO = 995, HI = 1005, BINS = 72;
const STEP = (HI - LO) / BINS;
const priceOf = i => LO + (i + 0.5) * STEP;
/* 让某一格的名义金额正好是 usdAmount */
function contractsFor(px, usdAmount) { return Math.round(usdAmount / (MULT * px)); }

function bookFrom(binMap) {
  const bids = [], asks = [];
  for (let i = BINS - 1; i >= 0; i--) {
    const v = binMap[i];
    if (!v) continue;
    const px = priceOf(i);
    const row = { p: Number(px.toFixed(8)), s: contractsFor(px, v) };
    /* 买单必须在 P 以下、卖单在 P 以上 */
    if (px < P) bids.push(row); else asks.push(row);
  }
  /* REST 返回按价格降序 */
  asks.sort((a, b) => b.p - a.p);
  return { bids, asks, interval: 0, coverTicks: 800, ts: Date.now() };
}

/* 场景 A：卖盘中间掏空一段（bin 60..63 = 0），买盘在 bin 5 放一堵巨墙 */
function scenarioA() {
  const m = {};
  for (let i = 0; i <= 35; i++) m[i] = 1000;
  m[5] = 50000;                       // POC（最厚买盘墙）
  for (let i = 37; i <= 71; i++) m[i] = 1000;
  /* 掏空宽度必须 ≥ 滑窗宽度（12% × 72 ≈ 9 格），否则窗口会连带周围的正常挂单，
     最小和不再是 0 —— 这正是滑窗法的固有语义：它回答「这么宽的一段里哪段最薄」，
     而不是「任意宽度的空洞在哪」 */
  for (let i = 60; i <= 69; i++) m[i] = 0;   // 上方真空（10 格）
  return bookFrom(m);
}
/* 场景 B：全零 */
function scenarioB() { return { bids: [], asks: [], interval: 0, coverTicks: 0, ts: Date.now() }; }
/* 场景 C：只有买单（检验另一侧能优雅退化、不产生 NaN） */
function scenarioC() {
  const m = {};
  for (let i = 0; i <= 35; i++) m[i] = 1000;
  return bookFrom(m);
}

/* ---------------------------------------------------------------- 环境 */
function makeDom() {
  const html = `<!doctype html><html><body>
    <div id="lsChart" style="width:900px"></div><div id="lsCards"></div><div id="lsMeta"></div>
    <div id="lsBands" class="liq-sw"></div>
  </body></html>`;
  /* runScripts:'outside-only' 才让 window.eval 跑在真实 window 环境里
     （默认不启用，eval 出来的代码看不到 window / document） */
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://local.test/' });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!w.AbortController) {
    w.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };
  }
  const store = {};
  Object.defineProperty(w, 'localStorage', {
    value: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
    }, configurable: true,
  });
  return dom;
}

/* 注入假簿：把 fetch 指向本地构造数据 */
function useFakeFetch(w, book, contractMeta, ticker) {
  w.fetch = url => {
    const u = String(url);
    let data = null;
    if (u.includes('/contracts/')) data = contractMeta;
    else if (u.includes('/tickers')) data = [ticker];
    else if (u.includes('/order_book')) data = book;
    if (data == null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(data))) });
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- 主测 */
async function run() {
  const CONTRACT = 'ETH_USDT';
  const meta = { quanto_multiplier: String(MULT), order_price_round: String(TICK) };
  const ticker = {
    last: String(P), mark_price: String(P), high_24h: String(1004), low_24h: String(996),
    funding_rate: '0.0001', total_size: '1234567',
  };

  const src = fs.readFileSync(SRC, 'utf8');

  console.log('\n=== 场景 A：卖盘中间掏空 + 买盘巨墙 ===');
  {
    const dom = makeDom(); const w = dom.window;
    useFakeFetch(w, scenarioA(), meta, ticker);
    w.eval(src);
    w.LsMap.init(w.document.getElementById('lsChart'), w.document.getElementById('lsCards'), w.document.getElementById('lsMeta'));
    w.LsMap.setSpan(500);
    w.LsMap.setInstrument({ id: 'ETH', contract: CONTRACT, dec: 2 });
    await sleep(400);
    const d = w.LsMap.dist();
    ok(!!d, '拿到了 dist');
    const bd = w.LsMap.bands();
    ok(!!bd, 'bands 已算出');

    /* POC = 人为放在 bin 5 的那堵墙 */
    eq(bd.poc.bin, 5, 0, 'POC 落在最厚格 bin 5');
    ok(bd.poc.usd > 40000, 'POC 金额量级正确（约 50000）', 'usd=' + bd.poc.usd.toFixed(0));
    ok(bd.poc.price < P, 'POC 在买盘侧（价格下方）');

    /* 上方最薄带必须命中掏空的 60..69 */
    ok(!!bd.upper, '上方最薄带存在');
    ok(bd.upper.loBin >= 60 && bd.upper.hiBin <= 69,
      '上方最薄带整体落在被掏空的 60~69 内', `lo=${bd.upper.loBin} hi=${bd.upper.hiBin}`);
    eq(bd.upper.usd, 0, 1e-6, '上方最薄带金额 = 0（真的全空）');
    eq(bd.upper.sparsity, 0, 1e-9, '稀疏度 = 0');
    ok(bd.upper.thin === true, '被判定为「真的稀薄」thin=true');
    ok(bd.upper.distPct > 0, '距离为正（在现价上方）', 'dist=' + bd.upper.distPct);
    eq(bd.upper.widTicks, Math.round(9 * STEP / TICK), 1, '窗口宽度按 tick 报出');

    /* ★ 分侧性：买盘那堵巨墙不应该出现在上方最薄带里 */
    ok(bd.upper.loBin > 35, '上方最薄带完全落在卖盘侧（未跨过买卖分界）', 'loBin=' + bd.upper.loBin);

    /* 下方最薄带会自动避开 POC（bin 5），否则就等于把最厚处当成真空 */
    ok(!!bd.lower, '下方最薄带存在');
    const coversPoc = bd.lower.loBin <= 5 && bd.lower.hiBin >= 5;
    ok(!coversPoc, '下方最薄带避开了 POC（bin 5）', `lo=${bd.lower.loBin} hi=${bd.lower.hiBin}`);
    ok(bd.lower.hiBin <= 35, '下方最薄带完全落在买盘侧', 'hiBin=' + bd.lower.hiBin);
    ok(bd.lower.usd > 0, '下方最薄带金额 > 0（不是全空）', 'usd=' + bd.lower.usd.toFixed(0));
    /* ★ 回归：baseline 用均值时这是 0.42（巨墙把基线抬高，均匀的普通挂单被误判成真空），
         改中位数后应为 1.00 —— 均匀分布不该被判为稀薄 */
    eq(bd.lower.sparsity, 1.0, 0.02, '均匀分布区的稀疏度 = 1.00（中位数 baseline 生效）');
    ok(bd.lower.thin === false, '均匀分布不被误判为「稀薄」', 'sparsity=' + bd.lower.sparsity.toFixed(3));

    /* 价值区 */
    ok(!!bd.va, '价值区已算出');
    ok(bd.va.loBin <= bd.poc.bin && bd.va.hiBin >= bd.poc.bin, '价值区包含 POC');
    ok(bd.va.share >= 0.70 - 1e-9, '价值区占比 >= 70%', 'share=' + bd.va.share.toFixed(4));
    ok(bd.va.widthBins >= 1 && bd.va.widthBins <= 72, '价值区宽度在合法范围', 'w=' + bd.va.widthBins);
    ok(bd.va.usd > 0 && bd.va.usd <= bd.sumAll + 1e-6, '价值区金额不超过总额');
    eq(bd.sumBid + bd.sumAsk, bd.sumAll, 1e-6, '买+卖 = 总额');

    /* 渲染：数轴与四个标签必须出现 */
    const svg = w.document.getElementById('lsChart').querySelector('svg');
    ok(!!svg, 'SVG 已创建');
    const html = svg ? svg.innerHTML : '';
    ok(html.includes('价位轴'), '渲染出「价位轴」标题');
    ok(html.includes('POC'), '渲染出 POC 标签');
    ok(html.includes('上方最薄带') || html.includes('上方薄弱'), '渲染出上方最薄带标签');
    ok(html.includes('下方最薄带') || html.includes('下方薄弱'), '渲染出下方最薄带标签');
    ok(html.includes('中间聚集带') || html.includes('无明显聚集'), '渲染出中间聚集带标签');
    ok(/fill="#6366f1"/.test(html), '数轴上有价值区配色 #6366f1');
    ok(/fill="#f97316"/.test(html), '数轴上有上方空洞配色 #f97316');
    ok(/fill="#0891b2"/.test(html), '数轴上有下方空洞配色 #0891b2');
    /* 右侧卡片 */
    const cards = w.document.getElementById('lsCards').innerHTML;
    ok(cards.includes('流动性判读'), '右侧卡片出现「流动性判读」');
    ok(cards.includes('中间聚集带'), '右侧卡片出现「中间聚集带」');

    /* 开关 */
    w.LsMap.setBands(false);
    ok(w.LsMap.bands() === null, '关闭后 bands 返回 null');
    ok(!w.document.getElementById('lsChart').querySelector('svg').innerHTML.includes('上方最薄带'), '关闭后不再渲染最薄带标签');
    w.LsMap.setBands(true);
    ok(!!w.LsMap.bands(), '重新开启后 bands 回来');
  }

  console.log('\n=== 场景 B：全空订单簿（不能产生 NaN / 崩溃）===');
  {
    const dom = makeDom(); const w = dom.window;
    useFakeFetch(w, scenarioB(), meta, ticker);
    w.eval(src);
    w.LsMap.init(w.document.getElementById('lsChart'), w.document.getElementById('lsCards'), w.document.getElementById('lsMeta'));
    w.LsMap.setInstrument({ id: 'ETH', contract: CONTRACT, dec: 2 });
    await sleep(400);
    const d = w.LsMap.dist();
    /* 全空簿走的是「订单簿为空」的报错分支（联不了网时的表现），
       关键是**不能返回一堆 NaN 的 bands** */
    ok(!d, '全空订单簿 → 不产出 dist（走错误分支而非造 NaN）');
    const svg = w.document.getElementById('lsChart').querySelector('svg');
    ok(!!svg, 'SVG 仍在（显示错误文案而不是崩掉）');
    ok(!/NaN/.test(svg.innerHTML), '渲染结果里没有 NaN');
  }

  console.log('\n=== 场景 C：只有买单（卖盘侧应优雅退化）===');
  {
    const dom = makeDom(); const w = dom.window;
    useFakeFetch(w, scenarioC(), meta, ticker);
    w.eval(src);
    w.LsMap.init(w.document.getElementById('lsChart'), w.document.getElementById('lsCards'), w.document.getElementById('lsMeta'));
    w.LsMap.setInstrument({ id: 'ETH', contract: CONTRACT, dec: 2 });
    await sleep(400);
    const d = w.LsMap.dist();
    const bd = d && d.bands;
    ok(!!bd, 'bands 仍算出');
    ok(bd.sumAsk === 0, '卖盘总额为 0');
    ok(bd.upper === null || Number.isFinite(bd.upper.sparsity), '上方带为 null 或稀疏度是有限数');
    if (bd.upper) {
      ok(bd.upper.sparsity === 1, '整侧为零 → 稀疏度退化为 1（无信息）', 'v=' + bd.upper.sparsity);
      ok(bd.upper.thin === false, '整侧为零不被误判为「真空」');
    }
    ok(Number.isFinite(bd.poc.price) && Number.isFinite(bd.poc.usd), 'POC 无 NaN');
  }

  console.log(`\n──────── ${pass} 通过 / ${fail} 失败 ────────`);
  if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
}

run().catch(e => { console.error('CRASH', e); process.exit(1); });
