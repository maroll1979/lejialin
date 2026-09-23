/* =========================================================================
   Gate.io 永续「多空清算图」—— K 线左侧（Y 轴左）清算强度条 + 清算价位横线
   -------------------------------------------------------------------------
   数据源：GET https://api.gateio.ws/api/v4/futures/usdt/liq_orders
           ?contract=BTC_USDT&limit=1000&from=<秒>&to=<秒>
   接口限制：from/to 窗口跨度不得超过 1 小时 → 按小时切分并发回溯，再合并去重
   方向口径：
     size < 0 → 强平单以「卖出」成交 → 多头仓位被强平（Long  Liq，绿）
     size > 0 → 强平单以「买入」成交 → 空头仓位被强平（Short Liq，红）
   金额口径：|size| × quanto_multiplier × fill_price = 名义 USDT
   ========================================================================= */
(function () {
  'use strict';

  const GATE = 'https://api.gateio.ws';
  const LS_REC = 'simtrader_liq_v1';       // 强平记录缓存（按合约）
  const LS_MULT = 'simtrader_liqmult_v1';  // 合约面值缓存
  const LS_ON = 'simtrader_liqon_v1';      // 开关偏好
  const LS_WIN = 'simtrader_liqwin_v1';    // 统计窗口偏好（24 / 72 / 168 小时）
  const LOOKBACK_H = 24;                   // 常规加载回溯 24 小时
  const TICK_H = 2;                        // 定时增量刷新最近 2 小时
  const DEEP_H = 168;                      // 后台深度回补上限 7 天（历史爆仓可跨会话累积）
  const KEEP_H = 168;                      // 本地最多保留 7 天
  const MAX_REC = 12000;                   // 单合约最多缓存条数
  const CHUNK_H = 24;                      // 深度回补每次补 24 小时
  const BINS = 62;                         // 价格分桶数
  const W_LEFT = 118;                      // 左侧清算图区域宽度（与 CSS --liqw 保持一致）

  const S = {
    on: true, ready: false, active: false,
    chart: null, series: null, box: null, chartEl: null, layer: null,
    instId: '', contract: '', dec: 2, mult: 0,
    recs: [], candles: [], loading: false, err: '', lastTs: 0, n: 0,
    totLong: 0, totShort: 0,
    winH: 24,              // 当前统计窗口（小时）
    backfilling: false,    // 是否正在深度回补历史
    gen: 0,                // 品种切换代号：回补过程中换品种则中止
  };
  /* 窗口文案：24h / 3天 / 7天 */
  function winText(h) { return h >= 168 ? '近7天' : h >= 72 ? '近3天' : '近24h'; }

  /* ---------- 工具 ---------- */
  function px(v, dec) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function usd(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }
  function lsGet(k, def) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  async function fetchJson(url, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 9000);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  /* ---------- 合约面值 ---------- */
  async function ensureMult(contract) {
    if (!contract) return 0;
    const cache = lsGet(LS_MULT, {});
    if (cache[contract] > 0) { S.mult = cache[contract]; return S.mult; }
    const j = await fetchJson(`${GATE}/api/v4/futures/usdt/contracts/${contract}`, 8000);
    const m = parseFloat(j && j.quanto_multiplier);
    if (!(m > 0)) throw new Error('合约面值获取失败');
    cache[contract] = m; lsSet(LS_MULT, cache); S.mult = m;
    return m;
  }

  /* ---------- 抓强平订单（按 1 小时窗口回溯，并发 6） ---------- */
  async function fetchWindows(contract, hours, endTs) {
    const now = endTs == null ? Math.floor(Date.now() / 1000) : endTs;
    const wins = [];
    for (let h = 0; h < hours; h++) { const to = now - h * 3600; wins.push([to - 3599, to]); }
    const out = [];
    const CONC = 6;
    for (let i = 0; i < wins.length; i += CONC) {
      const batch = wins.slice(i, i + CONC);
      const rs = await Promise.all(batch.map(([f, t]) =>
        fetchJson(`${GATE}/api/v4/futures/usdt/liq_orders?contract=${contract}&limit=1000&from=${f}&to=${t}`, 9000)
          .catch(() => null)
      ));
      rs.forEach(a => { if (Array.isArray(a)) for (const it of a) out.push(it); });
    }
    return out;
  }

  function norm(list) {
    const out = [];
    for (const it of list) {
      const t = +it.time, p = +it.fill_price, s = +it.size;
      if (!isFinite(t) || !isFinite(p) || !isFinite(s) || !s) continue;
      out.push({ t, p, s });
    }
    return out;
  }

  function merge(oldR, fresh) {
    const m = new Map();
    for (const r of oldR) m.set(r.t + '|' + r.p + '|' + r.s, r);
    for (const r of fresh) m.set(r.t + '|' + r.p + '|' + r.s, r);
    const arr = [...m.values()].sort((a, b) => a.t - b.t);
    const cut = Math.floor(Date.now() / 1000) - KEEP_H * 3600;
    const kept = arr.filter(r => r.t >= cut);
    return kept.length > MAX_REC ? kept.slice(kept.length - MAX_REC) : kept;
  }

  /* ---------- 加载（先读本地缓存秒出图，再增量补齐） ---------- */
  function localRecs(contract) {
    const all = lsGet(LS_REC, {});
    const e = all[contract];
    if (!e || !Array.isArray(e.recs)) return [];
    const cut = Math.floor(Date.now() / 1000) - KEEP_H * 3600;
    return e.recs.filter(r => r.t >= cut);
  }
  /* 落盘：历史爆仓要跨会话累积，localStorage 写满时逐级裁剪而不是静默丢弃 */
  function saveRecs(contract, recs) {
    const all = lsGet(LS_REC, {});
    all[contract] = { ts: Date.now(), recs };
    if (lsSet(LS_REC, all)) return;
    for (const keep of [8000, 5000, 3000, 1500, 600]) {          // 配额超限 → 只保留最近 N 条
      all[contract] = { ts: Date.now(), recs: recs.slice(-keep) };
      if (lsSet(LS_REC, all)) return;
    }
    for (const c of Object.keys(all)) {                          // 仍失败 → 丢弃其它合约的旧缓存后重试
      if (c === contract) continue;
      delete all[c];
      if (lsSet(LS_REC, all)) return;
    }
    try { localStorage.removeItem(LS_REC); } catch (e) {}
  }

  async function load(hours) {
    const c = S.contract;
    if (!c || S.loading) return;
    S.loading = true;
    try {
      await ensureMult(c);
      const fresh = norm(await fetchWindows(c, hours));
      const base = (S.recs && S.recs.length) ? S.recs : localRecs(c);
      S.recs = merge(base, fresh);
      saveRecs(c, S.recs);
      S.err = '';
      S.lastTs = Date.now();
      recalcTotals();
    } catch (e) {
      S.err = e && e.message ? e.message : String(e);
      if (!S.recs.length) S.recs = localRecs(c);   // 失败时退到本地缓存
    } finally {
      S.loading = false;
      schedule();
    }
  }

  /* ---------- 深度回补：把历史爆仓一直往前补到 7 天，跨会话累积 ----------
     每次只补一段（默认 24 小时），补完落盘再补下一段，
     这样第二次打开页面时本地已有完整历史，不必等网络。 */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function deepBackfill() {
    if (!S.contract || S.backfilling) return;
    const gen = S.gen;
    S.backfilling = true;
    try {
      const oldestAllowed = Math.floor(Date.now() / 1000) - DEEP_H * 3600;
      for (let round = 0; round < 10; round++) {
        if (gen !== S.gen || !S.contract) return;                 // 期间换了品种 → 放弃本次回补
        const cur = S.recs.length ? S.recs[0].t : Math.floor(Date.now() / 1000);
        if (cur <= oldestAllowed) return;                         // 已补满 7 天
        const hours = Math.min(CHUNK_H, Math.ceil((cur - oldestAllowed) / 3600));
        const fresh = norm(await fetchWindows(S.contract, hours, cur - 1));
        if (gen !== S.gen) return;
        if (fresh.length) {
          S.recs = merge(S.recs, fresh);
          saveRecs(S.contract, S.recs);
          recalcTotals();
          schedule();
        }
        if (!fresh.length && hours < CHUNK_H) return;             // 更早的时段没有数据 → 停止
        await sleep(150);
      }
    } catch (e) {
      S.err = e && e.message ? e.message : String(e);
    } finally {
      if (gen === S.gen) S.backfilling = false;
      schedule();
    }
  }

  function recalcTotals() {
    let l = 0, s = 0, n = 0;
    const cut = Math.floor(Date.now() / 1000) - S.winH * 3600;
    for (const r of S.recs) {
      if (r.t < cut) continue;
      const v = Math.abs(r.s) * (S.mult || 0) * r.p;
      if (r.s < 0) l += v; else s += v;
      n++;
    }
    S.totLong = l; S.totShort = s; S.n = n;
  }

  /* ---------- 可见价格区间（随缩放/平移自适应） ---------- */
  function priceRange() {
    let lo = Infinity, hi = -Infinity;
    const cs = S.candles || [];
    if (cs.length) {
      let a = 0, b = cs.length - 1;
      try {
        const vr = S.chart && S.chart.timeScale ? S.chart.timeScale().getVisibleLogicalRange() : null;
        if (vr && isFinite(vr.from) && isFinite(vr.to)) {
          a = Math.max(0, Math.floor(vr.from));
          b = Math.min(cs.length - 1, Math.ceil(vr.to));
        }
      } catch (e) {}
      for (let i = a; i <= b; i++) { const c = cs[i]; if (!c) continue; if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
      for (const r of S.recs) { if (r.p < lo) lo = r.p; if (r.p > hi) hi = r.p; }
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }

  /* ---------- 分桶聚合 ---------- */
  function buildBars() {
    const rg = priceRange();
    if (!rg) return null;
    const { lo, hi } = rg;
    const bw = (hi - lo) / BINS;
    const long = new Array(BINS).fill(0), short = new Array(BINS).fill(0);
    const cut = Math.floor(Date.now() / 1000) - S.winH * 3600;
    for (const r of S.recs) {
      if (r.t < cut) continue;
      if (r.p < lo || r.p > hi) continue;
      let i = Math.floor((r.p - lo) / bw);
      if (i < 0) i = 0; else if (i >= BINS) i = BINS - 1;
      const v = Math.abs(r.s) * (S.mult || 0) * r.p;
      if (r.s < 0) long[i] += v; else short[i] += v;
    }
    const bars = [];
    for (let i = 0; i < BINS; i++) {
      const total = long[i] + short[i];
      if (total <= 0) continue;
      bars.push({ p: lo + bw * (i + 0.5), lo: lo + bw * i, hi: lo + bw * (i + 1), long: long[i], short: short[i], total });
    }
    let max = 0;
    for (const b of bars) if (b.total > max) max = b.total;
    return { bars, max, lo, hi, bw };
  }

  /* ---------- 关键清算价位（峰值簇） ---------- */
  function pickLevels(agg) {
    if (!agg || !agg.bars.length) return [];
    const cand = agg.bars.filter(b => b.total >= agg.max * 0.12).sort((a, b) => b.total - a.total);
    const out = [];
    const gap = (agg.hi - agg.lo) * 0.02;
    for (const b of cand) {
      if (out.length >= 6) break;
      if (out.some(o => Math.abs(o.p - b.p) < gap)) continue;
      out.push(b);
    }
    return out.sort((a, b) => b.total - a.total).slice(0, 5);
  }

  /* ---------- 绘制 ---------- */
  function yOf(price) {
    if (!S.series || typeof S.series.priceToCoordinate !== 'function') return null;
    const y = S.series.priceToCoordinate(price);
    return (y == null || !isFinite(y)) ? null : y;
  }

  function render() {
    const layer = S.layer;
    if (!layer) return;
    if (!S.on || !S.active || !S.chartEl) { layer.innerHTML = ''; return; }
    const boxW = S.box ? S.box.clientWidth : 0;
    const H = S.chartEl.clientHeight, W = S.chartEl.clientWidth;
    if (!boxW || !H || !W) { layer.innerHTML = ''; return; }

    const agg = buildBars();
    if (!agg || !agg.bars.length) {
      layer.innerHTML = svgMsg(boxW, H, S.err ? '清算数据获取失败' : '该区间暂无清算数据');
      return;
    }

    const parts = [];
    /* 左侧底板 */
    parts.push(`<rect x="0" y="0" width="${W_LEFT}" height="${H}" fill="#fafbfc"/>`);
    parts.push(`<line x1="${W_LEFT - 0.5}" y1="0" x2="${W_LEFT - 0.5}" y2="${H}" stroke="#e6e9ee"/>`);
    /* 标题 + 24h 多空总额 */
    parts.push(`<text x="7" y="17" font-size="13" font-weight="700" fill="#374151">多空清算图 · ${winText(S.winH)}</text>`);
    parts.push(`<text x="7" y="35" font-size="13" font-weight="700" fill="#0a8f4e">多头爆仓 $${usd(S.totLong)}</text>`);
    parts.push(`<text x="7" y="52" font-size="13" font-weight="700" fill="#d92c2c">空头爆仓 $${usd(S.totShort)}</text>`);
    parts.push(`<line x1="0" y1="60" x2="${W_LEFT}" y2="60" stroke="#e6e9ee"/>`);

    /* 强度条：从右边界向左延伸，颜色按多空占比 */
    const usable = W_LEFT - 10;
    for (const b of agg.bars) {
      const y1 = yOf(b.hi), y2 = yOf(b.lo);
      if (y1 == null || y2 == null) continue;
      const top = Math.min(y1, y2), h = Math.max(2, Math.abs(y2 - y1) - 1);
      if (top < 58 || top > H - 18) continue;                 // 让出标题区与时间轴
      const ratio = agg.max > 0 ? b.total / agg.max : 0;
      const w = Math.max(2, Math.pow(ratio, 0.75) * usable);
      const share = b.long / b.total;                          // 1=全是多头爆仓 0=全是空头爆仓
      const color = share >= 0.66 ? '#0a8f4e' : share <= 0.34 ? '#d92c2c' : '#8a93a3';
      parts.push(`<rect x="${(W_LEFT - 4 - w).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${(0.35 + 0.55 * ratio).toFixed(2)}"/>`);
    }

    /* 关键清算价位横线 + 标签 */
    const levels = pickLevels(agg);
    const labels = [];
    for (const b of levels) {
      const y = yOf(b.p);
      if (y == null) continue;
      const share = b.long / b.total;
      const isLong = share >= 0.5;
      const color = isLong ? '#0a8f4e' : '#d92c2c';
      const x1 = W_LEFT, x2 = W_LEFT + Math.max(40, W - 64);
      parts.push(`<line x1="${x1}" y1="${y.toFixed(1)}" x2="${x2}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="7 4" opacity="0.9"/>`);
      labels.push({
        y,
        txt: `${px(b.p, S.dec)} · ${isLong ? '多头' : '空头'}爆仓 $${usd(b.total)}`,
        color,
      });
    }
    /* 标签防重叠：按 y 排序后逐个下推 */
    labels.sort((a, b) => a.y - b.y);
    let lastY = -999;
    for (const L of labels) {
      let ly = Math.max(L.y - 5, 66);
      if (ly - lastY < 21) ly = lastY + 21;
      if (ly > H - 26) ly = H - 26;
      lastY = ly;
      const w = L.txt.length * 7.6 + 12;
      parts.push(`<rect x="${W_LEFT + 6}" y="${(ly - 14).toFixed(1)}" width="${w.toFixed(1)}" height="19" rx="3" fill="#ffffff" opacity="0.88" stroke="${L.color}" stroke-width="1"/>`);
      parts.push(`<text x="${W_LEFT + 12}" y="${(ly).toFixed(1)}" font-size="13" font-weight="700" fill="${L.color}">${L.txt}</text>`);
    }

    layer.innerHTML = `<svg width="${boxW}" height="${H}" viewBox="0 0 ${boxW} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  }

  function svgMsg(boxW, H, txt) {
    return `<svg width="${boxW}" height="${H}" viewBox="0 0 ${boxW} ${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W_LEFT}" height="${H}" fill="#fafbfc"/>
      <line x1="${W_LEFT - 0.5}" y1="0" x2="${W_LEFT - 0.5}" y2="${H}" stroke="#e6e9ee"/>
      <text x="7" y="18" font-size="13" font-weight="700" fill="#374151">多空清算图</text>
      <text x="7" y="40" font-size="12" fill="#9aa3af">${txt}</text></svg>`;
  }

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  /* ---------- 对外接口 ---------- */
  function init(chart, series, box, chartEl) {
    S.chart = chart; S.series = series; S.box = box; S.chartEl = chartEl;
    S.on = lsGet(LS_ON, true) !== false;
    const w = +lsGet(LS_WIN, 24);
    S.winH = (w === 72 || w === 168) ? w : 24;
    if (!S.layer && box) {
      const el = document.createElement('div');
      el.id = 'liqLayer';
      el.style.cssText = 'position:absolute;left:0;top:0;right:0;pointer-events:none;z-index:5';
      box.appendChild(el);
      S.layer = el;
    }
    if (box) {
      box.classList.toggle('liq-off', !S.on);
      const ro = new ResizeObserver(() => schedule());
      ro.observe(box);
    }
    S.ready = true;
  }

  /* 品种切换：contract 为空（如美债）则关闭清算图 */
  async function setInstrument(instId, contract, dec) {
    S.gen++;                                    // 中止上一个品种正在进行的深度回补
    S.backfilling = false;
    S.instId = instId; S.contract = contract || ''; S.dec = dec == null ? 2 : dec;
    S.recs = []; S.candles = []; S.err = ''; S.mult = 0;
    S.totLong = 0; S.totShort = 0; S.n = 0;
    S.active = !!contract && S.on;
    if (S.box) S.box.classList.toggle('liq-off', !S.active);
    if (!S.active) { if (S.layer) S.layer.innerHTML = ''; return; }
    /* 先把本地已累积的历史渲染出来（打开页面即可见，不必等网络），再补齐最近 24h，最后后台深度回补 */
    const mc = lsGet(LS_MULT, {});                      // 面值先取缓存：否则离线瞬间金额会算成 0
    S.mult = (contract && mc[contract] > 0) ? mc[contract] : 0;
    S.recs = localRecs(contract);
    recalcTotals();
    schedule();
    await load(LOOKBACK_H);
    const gen = S.gen;
    setTimeout(() => { if (gen === S.gen) deepBackfill(); }, 1200);
  }

  function setCandles(c) { S.candles = c || []; schedule(); }

  async function refresh(full) {
    if (!S.active || !S.contract) return;
    await load(full ? LOOKBACK_H : TICK_H);
    if (full) { const gen = S.gen; setTimeout(() => { if (gen === S.gen) deepBackfill(); }, 300); }
  }

  /* 统计窗口切换：24 / 72 / 168 小时；窗口拉长而本地历史不足时自动补 */
  function setWindow(h) {
    const v = (h === 72 || h === 168) ? h : 24;
    S.winH = v;
    lsSet(LS_WIN, v);
    recalcTotals();
    schedule();
    if (S.active && S.contract) {
      const need = Math.floor(Date.now() / 1000) - v * 3600;
      const oldest = S.recs.length ? S.recs[0].t : 0;
      if (!oldest || oldest > need) { const gen = S.gen; setTimeout(() => { if (gen === S.gen) deepBackfill(); }, 100); }
    }
  }
  function windowHours() { return S.winH; }

  function setEnabled(on) {
    S.on = !!on;
    lsSet(LS_ON, S.on);
    S.active = !!S.contract && S.on;
    if (S.box) S.box.classList.toggle('liq-off', !S.active);
    if (!S.active && S.layer) S.layer.innerHTML = '';
    schedule();
    if (S.active && !S.recs.length) load(LOOKBACK_H);
  }

  function statusLine() {
    if (!S.active) return '';
    if (S.err && !S.recs.length) return '清算图：' + S.err;
    const kept = S.recs.length ? Math.round((Math.floor(Date.now() / 1000) - S.recs[0].t) / 3600) : 0;
    const tail = S.backfilling ? ' · 回补历史中' : (kept > S.winH ? ` · 本地已存 ${kept}h` : '');
    return `${winText(S.winH)} 强平 ${S.n} 笔 · 多头 $${usd(S.totLong)} · 空头 $${usd(S.totShort)}${tail}`;
  }

  window.LiqMap = {
    init, setInstrument, setCandles, render: schedule, refresh, setEnabled, statusLine,
    setWindow, windowHours,
    isOn: () => S.on, isActive: () => S.active, W_LEFT,
  };
})();
