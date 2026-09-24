/* ============================================================================
 * lsmap.js — 多空热力图（Long / Short heatmap）
 *
 * 替代原「成交热力图」：不再看「哪里成交多」，而是看「多空双方在哪些价位
 * 被打爆 / 可能被打爆」，按价格分档画成分布图（多头向左、空头向右的背靠背柱）。
 *
 * 数据源：Gate.io USDT 永续（公开接口，无需 Key，浏览器可直连）
 *   1) /api/v4/futures/usdt/liq_orders        真实强平订单（time/size/fill_price）
 *        口径：size < 0 = 卖出成交 = 多头被强平；size > 0 = 买入成交 = 空头被强平
 *        金额：|张数| × 合约面值(quanto_multiplier) × 成交价 = 名义 USDT
 *        限制：单次 from/to 窗口不得超过 1 小时 → 按小时切片并发回溯
 *   2) /api/v4/futures/usdt/contract_stats    多空指标（5m/15m/1h/4h）
 *        字段：lsr_account 账户多空比、lsr_taker 主动买卖比、
 *              top_lsr_size 大户持仓多空比、open_interest_usd 未平仓、
 *              last_funding_rate 资金费率
 *   3) /api/v4/futures/usdt/contracts/{c}     最新价 / 标记价 / 24h 高低 / 资金费率 / 面值
 *
 * 关于 CoinGlass：其官方 API 需要 Key（实测返回 {"code":"401","msg":"API key missing."}），
 * 网页端数据走签名接口，无法免密直连。因此本模块改用 Gate 平台自身公开的多空与强平数据，
 * 口径同样是「平台真实数据」，不掺合成价。
 *
 * 两层分布：
 *   · 真实层（默认）：窗口内真实强平订单按成交价分档累计，是「已经发生」的多空爆仓分布
 *   · 推算层（可选）：按 10/20/25/50/75/100 倍杠杆档 + 当前未平仓量，推算
 *     「若价格走到这里哪些仓位会被打爆」的潜在密集区（与主流清算热力图同原理：
 *     假设多空各占一半持仓，按维持保证金率折算强平价，仅为估算，不等于真实爆仓）
 *
 * 交互：滚轮上下缩放（以光标处价格为锚）、按住拖动平移、双击或按钮复位
 * ========================================================================== */
(function () {
  'use strict';

  const GATE = 'https://api.gateio.ws';
  const LS_IV = 'simtrader_lsiv_v1';         // 周期偏好
  const LS_LAYER = 'simtrader_lslayer_v1';   // 图层偏好
  const LS_SNAP = 'simtrader_lssnap_v1';     // 最近一次原始强平记录
  const LS_STAT = 'simtrader_lsstat_v1';     // 多空指标缓存
  const LS_MULT = 'simtrader_liqmult_v1';    // 合约面值缓存（与 liq-map 共用同一份）

  /* 周期 → 回溯窗口（分钟）；实时 = 滚动最近 60 秒 */
  const IV_MIN = { live: 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240 };
  const IV_NAME = { live: '实时（滚动 60 秒）', '5m': '5 分钟', '15m': '15 分钟', '1h': '1 小时', '4h': '4 小时' };
  const IV_STAT = { live: '5m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' };  // 对应 contract_stats 周期
  const REFRESH_MS = { live: 10000, '5m': 60000, '15m': 60000, '1h': 120000, '4h': 180000 };

  const BINS = 44;                 // 价格分档数
  const H = 470;                   // 画布高度
  const PAD = { l: 86, r: 96, t: 22, b: 22 };
  const COL_LONG = '#0a8f4e';      // 多头被强平（价格下跌方向）
  const COL_SHORT = '#d92c2c';     // 空头被强平（价格上涨方向）
  const COL_GRID = '#e9eef5';
  const COL_TXT = '#4b5563';
  const COL_TXT2 = '#8a94a6';
  const COL_NOW = '#2563eb';

  /* 杠杆档位经验权重（用于推算层；会归一化） */
  const LEV_TIERS = [
    { L: 10, w: 0.12 }, { L: 20, w: 0.16 }, { L: 25, w: 0.14 },
    { L: 50, w: 0.24 }, { L: 75, w: 0.14 }, { L: 100, w: 0.20 },
  ];
  const MMR = 0.005;               // 维持保证金率近似值

  const S = {
    host: null, cards: null, meta: null,
    svg: null, g: null, W: 0,
    inst: null, contract: '', dec: 2, mult: 0,
    iv: '5m', layer: 'real',
    dist: null, loading: false, err: '', lastTs: 0, offline: false,
    view: null,                    // 手工缩放/平移后的价格窗口 {lo,hi}；null = 自动
    drag: null, gen: 0, timer: 0, ro: null, raf: 0,
  };

  /* ---------------------------------------------------------------- 工具 */
  function lsGet(k, def) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function fetchJson(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 9000);
    return fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(() => clearTimeout(t));
  }

  function usd(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }
  function num(v, dec) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function pct(v, d) { return (v > 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%'; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------------------------------------------------------------- 抓取 */
  async function ensureMult(contract) {
    const cache = lsGet(LS_MULT, {});
    if (cache[contract]) { S.mult = +cache[contract]; return S.mult; }
    try {
      const c = await fetchJson(`${GATE}/api/v4/futures/usdt/contracts/${contract}`, 9000);
      const m = +c.quanto_multiplier;
      if (m > 0) { cache[contract] = m; lsSet(LS_MULT, cache); S.mult = m; }
    } catch (e) { /* 取不到就维持 0，金额会显示 — */ }
    return S.mult;
  }

  /* 最新价 / 标记价 / 24h 高低 / 资金费率 / 持仓量：走 tickers 接口
     （合约详情 /contracts/{c} 里没有 24h 高低，只有 quanto_multiplier 等静态参数） */
  async function fetchQuote(contract) {
    const j = await fetchJson(`${GATE}/api/v4/futures/usdt/tickers?contract=${contract}`, 9000);
    const t = Array.isArray(j) ? (j[0] || {}) : (j || {});
    const q = {
      last: +t.last, mark: +t.mark_price, index: +t.index_price,
      high24: +t.high_24h, low24: +t.low_24h,
      funding: t.funding_rate == null ? null : +t.funding_rate,
      oiContracts: t.total_size == null ? null : +t.total_size,
      mult: S.mult,
    };
    if (q.oiContracts != null && q.mult > 0 && q.mark > 0) q.oiUsd = q.oiContracts * q.mult * q.mark;
    return q;
  }

  async function fetchStat(contract, iv) {
    const ivKey = IV_STAT[iv] || '5m';
    const ck = contract + '|' + ivKey;
    try {
      const j = await fetchJson(`${GATE}/api/v4/futures/usdt/contract_stats?contract=${contract}&interval=${ivKey}&limit=2`, 9000);
      const row = Array.isArray(j) && j.length ? j[j.length - 1] : null;
      if (row) { const cache = lsGet(LS_STAT, {}); cache[ck] = { ts: Date.now(), row }; lsSet(LS_STAT, cache); }
      return row;
    } catch (e) {
      const hit = lsGet(LS_STAT, {})[ck];
      if (hit) { S.offline = true; return hit.row; }
      return null;
    }
  }

  /* 真实强平订单：按小时切片并发回溯（接口限制单窗口 ≤ 1 小时） */
  async function fetchLiq(contract, minutes) {
    const now = Math.floor(Date.now() / 1000);
    const wins = Math.max(2, Math.ceil(minutes / 60) + 1);
    const jobs = [];
    for (let i = 0; i < wins; i++) {
      const to = now - i * 3600;
      jobs.push(fetchJson(`${GATE}/api/v4/futures/usdt/liq_orders?contract=${contract}&limit=1000&from=${to - 3599}&to=${to}`, 9000).catch(() => []));
    }
    const parts = await Promise.all(jobs);
    const cut = now - minutes * 60;
    const seen = new Set(), out = [];
    parts.forEach(arr => (arr || []).forEach(o => {
      const t = +o.time, p = +o.fill_price, sz = +o.size;
      if (!(t >= cut) || !(p > 0) || !sz) return;
      const k = t + '|' + p + '|' + sz;
      if (seen.has(k)) return; seen.add(k);
      out.push({ t, p, s: sz });
    }));
    return out;
  }

  /* ---------------------------------------------------------------- 聚合 */
  function autoRange(raw, quote, minutes) {
    const P = quote.last || quote.mark;
    const list = raw.map(r => r.p).filter(p => p > 0);
    list.push(P);
    if (minutes >= 60) {
      if (quote.high24 > 0) list.push(quote.high24);
      if (quote.low24 > 0) list.push(quote.low24);
    }
    let lo = Math.min.apply(null, list), hi = Math.max.apply(null, list);
    if (!(hi > lo)) { lo = P * 0.98; hi = P * 1.02; }
    const pad = (hi - lo) * 0.18;
    lo -= pad; hi += pad;
    /* 保底跨度（太窄看不出分布、也盖不住 100x/50x 杠杆档），同时不超过 ±15%（否则柱子被压成一条线） */
    const minSpan = P * 0.06;
    if (hi - lo < minSpan) { const m = (lo + hi) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
    const cap = P * 0.15;
    lo = Math.max(lo, P - cap); hi = Math.min(hi, P + cap);
    if (lo > P) lo = P * 0.985;
    if (hi < P) hi = P * 1.015;
    return { lo, hi };
  }

  function addGauss(arr, price, weight, sigma, lo, step) {
    const c = (price - lo) / step - 0.5;
    const sd = Math.max(sigma / step, 0.6);
    const from = Math.max(0, Math.floor(c - sd * 3)), to = Math.min(arr.length - 1, Math.ceil(c + sd * 3));
    for (let i = from; i <= to; i++) {
      const z = (i - c) / sd;
      arr[i] += weight * Math.exp(-0.5 * z * z);
    }
  }

  function build(raw, quote, stat, iv) {
    const minutes = IV_MIN[iv] || 5;
    const rng = autoRange(raw, quote, minutes);
    const lo = rng.lo, hi = rng.hi, step = (hi - lo) / BINS;
    const longReal = new Array(BINS).fill(0), shortReal = new Array(BINS).fill(0);
    const mult = S.mult || 0;
    let totLong = 0, totShort = 0;
    raw.forEach(r => {
      const i = clamp(Math.floor((r.p - lo) / step), 0, BINS - 1);
      const v = Math.abs(r.s) * mult * r.p;
      if (r.s < 0) { longReal[i] += v; totLong += v; } else { shortReal[i] += v; totShort += v; }
    });

    /* 推算层：以标记价为锚，按杠杆档推强平价，权重按未平仓量 */
    const P = quote.mark || quote.last;
    const oiUsd = quote.oiUsd != null ? quote.oiUsd : ((stat && +stat.open_interest_usd) || 0);
    const longModel = new Array(BINS).fill(0), shortModel = new Array(BINS).fill(0);
    if (P > 0 && oiUsd > 0) {
      const wTot = LEV_TIERS.reduce((s, t) => s + t.w, 0);
      const sigma = P * 0.0035;
      LEV_TIERS.forEach(t => {
        const d = 1 / t.L - MMR;
        const w = oiUsd * t.w / wTot * 0.5;         // 假设多空各占一半持仓
        addGauss(longModel, P * (1 - d), w, sigma, lo, step);
        addGauss(shortModel, P * (1 + d), w, sigma, lo, step);
      });
    }
    const sum = a => a.reduce((x, y) => x + y, 0);
    const peak = arr => {
      let bi = 0;
      arr.forEach((v, i) => { if (v > arr[bi]) bi = i; });
      return { price: lo + (bi + 0.5) * step, usd: arr[bi], bin: bi };
    };
    return {
      contract: S.contract, iv, dec: S.dec, ts: Date.now(),
      lo, hi, step, bins: BINS,
      longReal, shortReal, longModel, shortModel,
      totLongReal: totLong, totShortReal: totShort,
      totLongModel: sum(longModel), totShortModel: sum(shortModel),
      nRaw: raw.length,
      peakRealLong: peak(longReal), peakRealShort: peak(shortReal),
      peakModelLong: peak(longModel), peakModelShort: peak(shortModel),
      stat: stat || null, quote, offline: S.offline,
    };
  }

  /* ---------------------------------------------------------------- 数据加载 */
  async function load(force) {
    if (!S.contract) return;
    const gen = ++S.gen;
    S.loading = true;
    if (S.meta && !S.dist) S.meta.textContent = '多空热力图取数中…';
    try {
      S.offline = false;
      await ensureMult(S.contract);
      const [quote, stat, raw] = await Promise.all([
        fetchQuote(S.contract),
        fetchStat(S.contract, S.iv),
        fetchLiq(S.contract, IV_MIN[S.iv] || 5),
      ]);
      if (gen !== S.gen) return;
      if (!(quote.last > 0) && !(quote.mark > 0)) throw new Error('行情为空');
      S.dist = build(raw, quote, stat, S.iv);
      S.view = null;                       // 重新取数后回到自动范围
      S.lastTs = Date.now(); S.err = '';
      const snap = lsGet(LS_SNAP, {});
      snap[S.contract + '|' + S.iv] = { ts: S.lastTs, quote, stat, raw: raw.slice(-4000) };
      lsSet(LS_SNAP, snap);
    } catch (e) {
      if (gen !== S.gen) return;
      S.err = e && e.message ? e.message : String(e);
      S.offline = true;
      /* 离线兜底：用上次快照按当前窗口重算，保证打开页面就有图 */
      const snap = lsGet(LS_SNAP, {})[S.contract + '|' + S.iv];
      if (snap && snap.raw && snap.quote) {
        try {
          const cut = Math.floor(Date.now() / 1000) - (IV_MIN[S.iv] || 5) * 60;
          S.dist = build(snap.raw.filter(r => r.t >= cut), snap.quote, snap.stat, S.iv);
          S.dist.fromCache = true;
        } catch (e2) { /* ignore */ }
      }
    } finally {
      if (gen === S.gen) { S.loading = false; render(); schedule(); }
    }
  }

  function schedule() {
    clearTimeout(S.timer);
    if (!S.contract || !S.inst) return;
    S.timer = setTimeout(() => {
      if (document.hidden) { schedule(); return; }   // 页面不可见时不打接口
      load(false);
    }, REFRESH_MS[S.iv] || 60000);
  }

  /* ---------------------------------------------------------------- 绘图 */
  function view() {
    const d = S.dist;
    if (!d) return null;
    return S.view || { lo: d.lo, hi: d.hi };
  }

  function ensureSvg(w) {
    if (S.svg && S.W === w) return;
    S.W = w;
    S.host.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${w} ${H}" style="display:block;cursor:grab;user-select:none;touch-action:none">
      <rect x="0" y="0" width="${w}" height="${H}" fill="#fff"></rect><g></g></svg>`;
    S.svg = S.host.querySelector('svg');
    S.g = S.svg.querySelector('g');
    bindInteractions();
  }

  function render() {
    if (!S.host) return;
    const d = S.dist;
    const w = Math.max(320, S.host.clientWidth || 640);

    if (!d) {
      ensureSvg(w);
      S.g.innerHTML = `<text x="${w / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="${COL_TXT2}">${S.err ? '取数失败：' + S.err : '加载中…'}</text>`;
      if (S.cards) S.cards.innerHTML = '';
      if (S.meta) S.meta.textContent = S.err ? 'Gate.io 永续接口不可达（' + S.err + '）' : '多空热力图加载中…';
      return;
    }
    ensureSvg(w);
    const v = view();
    const lo = v.lo, hi = v.hi, span = hi - lo, step = span / BINS;
    const plotW = w - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const cx = PAD.l + plotW / 2, halfW = plotW / 2 - 8;
    const yOf = p => PAD.t + (hi - p) / span * plotH;
    const barH = Math.max(2, plotH / BINS - 1.6);

    const showReal = S.layer === 'real' || S.layer === 'both';
    const realEmpty = d.totLongReal <= 0 && d.totShortReal <= 0;
    const autoModel = showReal && realEmpty;      // 窗口内没有真实强平 → 自动补推算层，别让面板空着
    const useModel = S.layer === 'model' || S.layer === 'both' || autoModel;
    const L = [], Sh = [];
    for (let i = 0; i < BINS; i++) {
      L.push((showReal ? d.longReal[i] : 0) + (useModel ? d.longModel[i] : 0));
      Sh.push((showReal ? d.shortReal[i] : 0) + (useModel ? d.shortModel[i] : 0));
    }
    const maxV = Math.max(Math.max.apply(null, L), Math.max.apply(null, Sh), 1e-9);

    let g = '';
    /* 网格 + 左右价格刻度 */
    for (let i = 0; i <= 6; i++) {
      const p = lo + span * i / 6, y = yOf(p);
      g += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${w - PAD.r}" y2="${y.toFixed(1)}" stroke="${COL_GRID}"/>`;
      g += `<text x="${PAD.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${COL_TXT}">${num(p, d.dec)}</text>`;
      if (d.quote.last > 0) g += `<text x="${w - PAD.r + 8}" y="${(y + 4).toFixed(1)}" font-size="12" fill="${COL_TXT2}">${pct((p - d.quote.last) / d.quote.last, 2)}</text>`;
    }
    /* 多空分界中线 */
    g += `<line x1="${cx}" y1="${PAD.t}" x2="${cx}" y2="${PAD.t + plotH}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`;

    /* 分布柱：多头向左、空头向右；实心=真实爆仓，半透明描边=推算 */
    for (let i = 0; i < BINS; i++) {
      const y = yOf(lo + (i + 0.5) * step);
      if (y < PAD.t - barH || y > PAD.t + plotH) continue;
      if (L[i] > 0) {
        const bw = Math.max(1.5, L[i] / maxV * halfW);
        const real = showReal && d.longReal[i] > 0;
        g += `<rect x="${(cx - bw).toFixed(1)}" y="${(y - barH / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${COL_LONG}"
          fill-opacity="${real ? 0.88 : 0.3}" stroke="${real ? 'none' : COL_LONG}" stroke-opacity="0.45"/>`;
      }
      if (Sh[i] > 0) {
        const bw = Math.max(1.5, Sh[i] / maxV * halfW);
        const real = showReal && d.shortReal[i] > 0;
        g += `<rect x="${cx.toFixed(1)}" y="${(y - barH / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${COL_SHORT}"
          fill-opacity="${real ? 0.88 : 0.3}" stroke="${real ? 'none' : COL_SHORT}" stroke-opacity="0.45"/>`;
      }
    }

    /* 标注线：24h 高低 / 真实爆仓最密价位 / 推算最强档 */
    const marks = [];
    if (d.quote.high24 > lo && d.quote.high24 < hi) marks.push({ p: d.quote.high24, c: '#94a3b8', t: '24h 最高', dash: '3 5', side: 'r' });
    if (d.quote.low24 > lo && d.quote.low24 < hi) marks.push({ p: d.quote.low24, c: '#94a3b8', t: '24h 最低', dash: '3 5', side: 'r' });
    if (showReal && d.totLongReal > 0) marks.push({ p: d.peakRealLong.price, c: COL_LONG, t: '多头爆仓密集 ' + usd(d.peakRealLong.usd), dash: '7 4', side: 'l' });
    if (showReal && d.totShortReal > 0) marks.push({ p: d.peakRealShort.price, c: COL_SHORT, t: '空头爆仓密集 ' + usd(d.peakRealShort.usd), dash: '7 4', side: 'r' });
    if (useModel) {
      marks.push({ p: d.peakModelLong.price, c: COL_LONG, t: '潜在多头强平区（推算）', dash: '2 4', side: 'l' });
      marks.push({ p: d.peakModelShort.price, c: COL_SHORT, t: '潜在空头强平区（推算）', dash: '2 4', side: 'r' });
    }
    const yList = marks.map(m => yOf(m.p));
    const order = marks.map((m, i) => i).sort((a, b) => yList[a] - yList[b]);
    for (let k = 1; k < order.length; k++) {
      const i = order[k], j = order[k - 1];
      if (yList[i] - yList[j] < 17) yList[i] = yList[j] + 17;
    }
    marks.forEach((m, i) => {
      const y = yOf(m.p);
      g += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${w - PAD.r}" y2="${y.toFixed(1)}" stroke="${m.c}" stroke-width="1.4" stroke-dasharray="${m.dash}"/>`;
      const ly = clamp(yList[i], PAD.t + 11, PAD.t + plotH - 2);
      const left = m.side === 'l';
      g += `<text x="${left ? PAD.l + 6 : w - PAD.r - 6}" y="${(ly + 4).toFixed(1)}" text-anchor="${left ? 'start' : 'end'}"
        font-size="12.5" font-weight="700" fill="${m.c}" stroke="#fff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">${m.t} · ${num(m.p, d.dec)}</text>`;
    });

    /* 现价 */
    const py = yOf(d.quote.last);
    if (py > PAD.t - 4 && py < PAD.t + plotH + 4) {
      g += `<line x1="${PAD.l}" y1="${py.toFixed(1)}" x2="${w - PAD.r}" y2="${py.toFixed(1)}" stroke="${COL_NOW}" stroke-width="2"/>`;
      g += `<rect x="${(cx - 48).toFixed(1)}" y="${(py - 11).toFixed(1)}" width="96" height="21" rx="5" fill="${COL_NOW}"/>`;
      g += `<text x="${cx}" y="${(py + 4).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#fff">现价 ${num(d.quote.last, d.dec)}</text>`;
    }

    /* 左右表头：真实爆仓金额（推算层只标注“有推算区”，金额量级不同不混排） */
    const lTxt = d.totLongReal > 0 ? '$' + usd(d.totLongReal) : '—（本窗口无）';
    const sTxt = d.totShortReal > 0 ? '$' + usd(d.totShortReal) : '—（本窗口无）';
    g += `<text x="${PAD.l + 6}" y="${PAD.t - 7}" font-size="13" font-weight="700" fill="${COL_LONG}">◀ 多头被强平 ${lTxt}${useModel ? ' · 含推算区' : ''}</text>`;
    g += `<text x="${w - PAD.r - 6}" y="${PAD.t - 7}" text-anchor="end" font-size="13" font-weight="700" fill="${COL_SHORT}">空头被强平 ${sTxt}${useModel ? ' · 含推算区' : ''} ▶</text>`;
    g += `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11.5" fill="${COL_TXT2}">滚轮上下缩放 · 按住拖动平移 · 双击复位</text>`;

    d.autoModel = autoModel;
    S.g.innerHTML = g;
    renderCards();
    renderMeta();
  }

  function renderMeta() {
    if (!S.meta) return;
    const d = S.dist; if (!d) return;
    const v = view() || { lo: d.lo, hi: d.hi };
    const spanPct = d.quote.last > 0 ? ((v.hi - v.lo) / d.quote.last * 100).toFixed(2) : '—';
    const age = Math.round((Date.now() - S.lastTs) / 1000);
    const parts = [
      `Gate.io USDT 永续 · ${d.contract} · 窗口 ${S.iv === 'live' ? IV_NAME.live : '近 ' + IV_NAME[S.iv]}`,
      `真实强平 ${d.nRaw} 笔（多头 $${usd(d.totLongReal)} / 空头 $${usd(d.totShortReal)}）`,
      `视图跨度 ${spanPct}%`,
      (S.offline || d.fromCache) ? `⚠ 接口不可达，显示 ${age}s 前本地快照` : `更新于 ${new Date(S.lastTs).toLocaleTimeString('zh-CN', { hour12: false })}（${age}s 前）`,
    ];
    if (d.autoModel) parts.unshift('本窗口内没有真实强平成交，图上显示的是推算层');
    S.meta.textContent = parts.join(' · ');
    S.meta.classList.toggle('rt', !(S.offline || d.fromCache));
  }

  function renderCards() {
    if (!S.cards) return;
    const d = S.dist; if (!d) { S.cards.innerHTML = ''; return; }
    const st = d.stat || {}, q = d.quote, dec = d.dec;
    const lsrAcc = st.lsr_account == null ? null : +st.lsr_account;
    const lsrTak = st.lsr_taker == null ? null : +st.lsr_taker;
    const topLsr = st.top_lsr_size == null ? null : +st.top_lsr_size;
    const oiUsd = q.oiUsd != null ? q.oiUsd : (+st.open_interest_usd || null);

    /* 综合多空力量：账户比 30% + 大户比 30% + 主动买卖 20% + 本窗口爆仓结构 20% */
    let score = 0, wt = 0;
    if (lsrAcc != null) { score += clamp((lsrAcc - 1) * 2, -1, 1) * 0.30; wt += 0.30; }
    if (topLsr != null) { score += clamp((topLsr - 1) * 2, -1, 1) * 0.30; wt += 0.30; }
    if (lsrTak != null) { score += clamp((lsrTak - 1) * 2, -1, 1) * 0.20; wt += 0.20; }
    const tot = d.totShortReal + d.totLongReal;
    if (tot > 0) { score += clamp((d.totShortReal - d.totLongReal) / tot, -1, 1) * 0.20; wt += 0.20; }
    const sc = wt > 0 ? score / wt : 0;
    const bias = Math.abs(sc) < 0.12 ? ['多空均衡', 'var(--muted)']
      : sc > 0 ? [sc > 0.45 ? '多头占优' : '略偏多头', 'var(--up)']
        : [sc < -0.45 ? '空头占优' : '略偏空头', 'var(--down)'];

    const row = (k, v, sub, color) => `<div class="rc"><div class="k">${k}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${v}${sub ? `<small> ${sub}</small>` : ''}</div></div>`;
    const rows = [
      row('多空力量', bias[0], `综合分 ${(sc * 100).toFixed(0)}`, bias[1]),
      row('账户多空比', lsrAcc == null ? '—' : lsrAcc.toFixed(2), lsrAcc == null ? '接口无数据' : (lsrAcc > 1 ? '多头账户更多' : '空头账户更多'), lsrAcc == null ? null : (lsrAcc > 1 ? 'var(--up)' : 'var(--down)')),
      row('大户持仓多空比', topLsr == null ? '—' : topLsr.toFixed(2), topLsr == null ? '接口无数据' : (topLsr > 1 ? '大户偏多' : '大户偏空'), topLsr == null ? null : (topLsr > 1 ? 'var(--up)' : 'var(--down)')),
      row('主动买卖比', lsrTak == null ? '—' : lsrTak.toFixed(2), lsrTak == null ? '' : (lsrTak > 1 ? '主动买更多' : '主动卖更多')),
      row('多头爆仓（窗口）', '$' + usd(d.totLongReal), d.peakRealLong.usd > 0 ? `最密 ${num(d.peakRealLong.price, dec)}` : '本窗口无多单爆仓', COL_LONG),
      row('空头爆仓（窗口）', '$' + usd(d.totShortReal), d.peakRealShort.usd > 0 ? `最密 ${num(d.peakRealShort.price, dec)}` : '本窗口无空单爆仓', COL_SHORT),
      row('未平仓合约', oiUsd ? '$' + usd(oiUsd) : '—', '按标记价折算'),
      row('资金费率', q.funding == null ? '—' : pct(q.funding, 4), q.funding == null ? '' : (q.funding > 0 ? '多头付空头' : '空头付多头')),
      row('现价 / 标记价', num(q.last, dec), '标记 ' + num(q.mark, dec)),
      row('24小时最高 / 最低', num(q.high24, dec), num(q.low24, dec)),
    ];
    S.cards.innerHTML = rows.join('');
  }

  /* ---------------------------------------------------------------- 交互 */
  function bindInteractions() {
    const svg = S.svg; if (!svg) return;

    svg.addEventListener('wheel', e => {
      const d = S.dist; if (!d) return;
      e.preventDefault();
      const v = view();
      const rect = svg.getBoundingClientRect();
      const plotH = H - PAD.t - PAD.b;
      const rel = clamp(((e.clientY - rect.top) * (H / (rect.height || H)) - PAD.t) / plotH, 0, 1);
      const anchor = v.hi - rel * (v.hi - v.lo);          // 以光标所在价格为锚点
      const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      let nl = anchor - (anchor - v.lo) * k;
      let nh = anchor + (v.hi - anchor) * k;
      const P = d.quote.last || d.quote.mark;
      const minSpan = P * 0.004, maxSpan = P * 0.40;
      if (nh - nl < minSpan) { const m = (nl + nh) / 2; nl = m - minSpan / 2; nh = m + minSpan / 2; }
      if (nh - nl > maxSpan) { const m = (nl + nh) / 2; nl = m - maxSpan / 2; nh = m + maxSpan / 2; }
      S.view = { lo: nl, hi: nh };
      render();
    }, { passive: false });

    svg.addEventListener('pointerdown', e => {
      const d = S.dist; if (!d) return;
      S.drag = { y: e.clientY, v: Object.assign({}, view()) };
      svg.style.cursor = 'grabbing';
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
    });
    svg.addEventListener('pointermove', e => {
      if (!S.drag) return;
      const rect = svg.getBoundingClientRect();
      const plotH = H - PAD.t - PAD.b;
      const dy = (e.clientY - S.drag.y) * (H / (rect.height || H));
      const shift = dy / plotH * (S.drag.v.hi - S.drag.v.lo);
      S.view = { lo: S.drag.v.lo + shift, hi: S.drag.v.hi + shift };
      render();
    });
    const end = e => {
      if (!S.drag) return;
      S.drag = null; svg.style.cursor = 'grab';
      try { svg.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { S.view = null; render(); });
  }

  function resetView() { S.view = null; render(); }

  /* ---------------------------------------------------------------- 外部接口 */
  function init(host, cards, meta) {
    S.host = host; S.cards = cards; S.meta = meta;
    /* 默认窗口 1 小时：5 分钟窗口里真实强平往往只有 0~2 笔，默认值取 1 小时更有信息量 */
    S.iv = lsGet(LS_IV, '1h'); if (!IV_MIN[S.iv]) S.iv = '1h';
    /* 默认「叠加」：真实爆仓是稀疏事件（5 分钟窗口可能只有几笔），
       只画真实层面板会显得空；叠加推算层既能看清价位分布，也能分辨哪些是真实成交 */
    S.layer = lsGet(LS_LAYER, 'both');
    if (!['real', 'model', 'both'].includes(S.layer)) S.layer = 'both';
    if (window.ResizeObserver && host) {
      if (S.ro) { try { S.ro.disconnect(); } catch (e) {} }
      S.ro = new ResizeObserver(() => {
        cancelAnimationFrame(S.raf);
        S.raf = requestAnimationFrame(render);   // 宽度变了 ensureSvg 会自行重建，这里是重绘节流
      });
      S.ro.observe(host);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.contract) load(false); });
    render();
  }

  function setInstrument(inst) {
    const contract = inst && inst.contract ? inst.contract : '';
    if (!inst || !contract) { S.inst = null; S.contract = ''; S.dist = null; S.view = null; render(); return; }
    const changed = S.contract !== contract;
    S.inst = inst; S.contract = contract; S.dec = inst.dec == null ? 2 : inst.dec;
    S.view = null;
    if (changed) {
      /* 先用手头快照把图画出来，再联网刷新（换品种也有内容，不会空白） */
      const snap = lsGet(LS_SNAP, {})[contract + '|' + S.iv];
      S.dist = null;
      if (snap && snap.raw && snap.quote) {
        try {
          const cut = Math.floor(Date.now() / 1000) - (IV_MIN[S.iv] || 5) * 60;
          S.dist = build(snap.raw.filter(r => r.t >= cut), snap.quote, snap.stat, S.iv);
          S.dist.fromCache = true;
        } catch (e) { /* ignore */ }
      }
      render();
    }
    load(true);
  }

  function setIv(iv) {
    if (!IV_MIN[iv] || iv === S.iv) return;
    S.iv = iv; lsSet(LS_IV, iv); S.view = null;
    load(true);
  }

  function setLayer(layer) {
    if (!['real', 'model', 'both'].includes(layer)) return;
    S.layer = layer; lsSet(LS_LAYER, layer);
    render();
  }

  window.LsMap = {
    init, setInstrument, setIv, setLayer, refresh: load, resetView, render,
    interval: () => S.iv,
    layer: () => S.layer,
    hasDist: () => !!S.dist,
    dist: () => S.dist,
    IV_MIN,
  };
})();
