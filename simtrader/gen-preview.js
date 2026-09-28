/* ============================================================================
 * gen-preview.js — 用**真实盘口 + 真实 lsmap.js** 生成多空热力图 SVG
 *
 * 不是手画示意图：用 jsdom 加载页面上跑的同一份 lsmap.js，
 * 把真实 Gate.io 订单簿喂进去，再把它吐出的 SVG innerHTML 抠出来。
 * 页面上显示什么，这里就是什么。
 *
 * 用法：NODE_PATH=<node workspace>/node_modules node gen-preview.js ETH_USDT 5000
 * 输出：data/lsmap-preview.svg
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const GATE = 'https://api.gateio.ws';
const ROOT = __dirname;
const SRC = path.join(ROOT, 'simtrader', 'lsmap.js');
const WIDTH = 680;

async function getJson(p) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(GATE + p, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 900));
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cands(tick) {
  const out = [0];
  for (let k = -8; k <= 6; k++) for (const m of [1, 5]) {
    const v = m * Math.pow(10, k);
    if (v >= tick * 0.999) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

async function main() {
  const CONTRACT = process.argv[2] || 'ETH_USDT';
  const SPAN = +(process.argv[3] || 5000);

  const ci = await getJson(`/api/v4/futures/usdt/contracts/${CONTRACT}`);
  const tick = +ci.order_price_round;
  const tkr = (await getJson(`/api/v4/futures/usdt/tickers?contract=${CONTRACT}`))[0];
  const P = +tkr.last;

  /* 逐级变粗直到覆盖 SPAN 个 tick（与 lsmap.js fetchBook 同样的策略） */
  let book = null, chosenIv = 0;
  for (const iv of cands(tick)) {
    const b = await getJson(`/api/v4/futures/usdt/order_book?contract=${CONTRACT}&limit=300&interval=${iv === 0 ? 0 : Number(iv.toFixed(10))}`);
    const bids = b.bids.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    const asks = b.asks.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    const cover = Math.max(P - Math.min.apply(null, bids.map(r => r[0])),
      Math.max.apply(null, asks.map(r => r[0])) - P) / tick;
    book = { bids, asks, interval: iv, coverTicks: cover, ts: Date.now() };
    chosenIv = iv;
    if (cover >= SPAN) break;
  }
  console.log(`合约 ${CONTRACT} · tick ${tick} · last ${P} · interval ${chosenIv} · 覆盖 ±${Math.round(book.coverTicks)} tick`);

  /* ---- jsdom 里跑真实的 lsmap.js ---- */
  const html = `<!doctype html><html><body>
    <div id="lsChart"></div><div id="lsCards"></div><div id="lsMeta"></div></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://local.test/' });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!w.AbortController) w.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  const store = {};
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    value: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }, clear: () => {},
    },
  });
  /* 让 host.clientWidth = 680（jsdom 里恒为 0，不 mock 的话 SVG 会退化成 320 宽） */
  const host = w.document.getElementById('lsChart');
  Object.defineProperty(host, 'clientWidth', { value: WIDTH, configurable: true });

  w.fetch = url => {
    const u = String(url);
    let payload = null;
    if (u.includes('/contracts/')) payload = ci;
    else if (u.includes('/tickers')) payload = [tkr];
    else if (u.includes('/order_book')) payload = {
      bids: book.bids.map(([p, s]) => ({ p: String(p), s: String(s) })),
      asks: book.asks.map(([p, s]) => ({ p: String(p), s: String(s) })),
    };
    if (!payload) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))) });
  };

  w.eval(fs.readFileSync(SRC, 'utf8'));
  w.LsMap.init(host, w.document.getElementById('lsCards'), w.document.getElementById('lsMeta'));
  w.LsMap.setSpan(SPAN);
  w.LsMap.setInstrument({ id: CONTRACT, contract: CONTRACT, dec: tick >= 1 ? 1 : 2 });
  await sleep(1200);

  const svg = host.querySelector('svg');
  if (!svg) { console.error('没有生成 SVG'); process.exit(1); }
  const d = w.LsMap.dist(), bd = w.LsMap.bands();

  const inner = svg.innerHTML
    .replace(/width="100%" height="470" viewBox="0 0 680 470"/, `width="100%" viewBox="0 0 680 470"`)
    .replace('style="display:block;cursor:grab;user-select:none;touch-action:none"', 'style="display:block"');
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 680 470" style="display:block">${inner}</svg>`;
  const fp = path.join(ROOT, 'data', 'lsmap-preview.svg');
  fs.writeFileSync(fp, out, 'utf8');

  console.log('\n视野 [' + d.lo.toFixed(2) + ', ' + d.hi.toFixed(2) + ']  买 $' + (d.totBid / 1e6).toFixed(2) + 'M / 卖 $' + (d.totAsk / 1e6).toFixed(2) + 'M');
  console.log('POC   ' + bd.poc.price.toFixed(2) + '  $' + (bd.poc.usd / 1e6).toFixed(2) + 'M');
  console.log('VA    ' + bd.va.lo.toFixed(2) + ' ~ ' + bd.va.hi.toFixed(2) + '  占 ' + (bd.va.share * 100).toFixed(1) + '%  宽 ' + Math.round(bd.va.widthBins / 72 * 100) + '% 视野');
  console.log('上方  ' + bd.upper.lo.toFixed(2) + ' ~ ' + bd.upper.hi.toFixed(2) + '  $' + (bd.upper.usd / 1e6).toFixed(2) + 'M  稀疏 ' + bd.upper.sparsity.toFixed(3) + '  ' + ((bd.upper.lo - P) / P * 100).toFixed(2) + '%');
  console.log('下方  ' + bd.lower.lo.toFixed(2) + ' ~ ' + bd.lower.hi.toFixed(2) + '  $' + (bd.lower.usd / 1e6).toFixed(2) + 'M  稀疏 ' + bd.lower.sparsity.toFixed(3) + '  ' + ((bd.lower.hi - P) / P * 100).toFixed(2) + '%');
  console.log('\nSVG 已写出：' + fp + '  (' + out.length + ' 字节)');
}
main().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
