/* ============================================================================
 * lsmap.js — 多空热力图（订单簿口径 / Order-book depth heatmap）
 *
 * 面板数据 = 永续订单簿在现价上下 N 个 tick 内的挂单分布：
 *   · 价格下方 = 买盘挂单（bids）→ 多头阵营，向左画绿柱
 *   · 价格上方 = 卖盘挂单（asks）→ 空头阵营，向右画红柱
 *
 * 数据源：Gate.io USDT 永续（公开接口，无需 Key，浏览器可直连）
 *   1) /api/v4/futures/usdt/order_book?contract=&limit=300&interval=
 *        单侧最多 300 档；interval 是「价格分组粒度」：
 *          interval=0 → 原始价位；覆盖实测约 ±1500 tick（BTC）
 *          interval=1 → 覆盖约 ±3500 tick；interval=5 → ±15000 tick
 *        ⚠ interval 不是任意值：只允许 {0} ∪ {1,5}×10^k（2、20 会被拒，
 *          返回 INVALID_PARAM_VALUE）→ 代码里按这个规则生成候选粒度
 *   2) /api/v4/futures/usdt/contracts/{c}   quanto_multiplier（面值）、order_price_round（tick）
 *   3) /api/v4/futures/usdt/tickers        最新价/标记价/24h高低/资金费率/持仓量
 *
 * 名义金额 = 张数 × quanto_multiplier × 价位（USDT）
 *
 * ⚠ 口径提醒（别看错）：订单簿上的挂单是「尚未成交的委托」，不等于未平仓合约（OI，
 *   已成交未平仓的持仓）。右侧卡片里 OI 单列一行并标注来源，不与挂单量混排。
 *
 * 视野：默认 ±500 tick，可切到 ±200 / ±2000 / ±5000；滚轮缩放时若超出当前订单簿覆盖
 *       范围，会自动换用更粗的 interval 重新取更深的簿（缩得太细则换回更细粒度）。
 *
 * 交互：滚轮上下缩放（以光标处价格为锚）、按住拖动平移、双击或按钮复位
 * ========================================================================== */
(function () {
  'use strict';

  const GATE = 'https://api.gateio.ws';
  const LS_SPAN = 'simtrader_lsspan_v1';     // 视野偏好（单边 tick 数）
  const LS_BANDS = 'simtrader_lsbands_v1';   // 是否叠加「量能结构带」
  const LS_BOOK = 'simtrader_lsbook_v1';     // 最近一次订单簿快照（离线兜底）
  const LS_MULT = 'simtrader_liqmult_v1';    // 合约面值缓存（与 liq-map 共用同一份）
  const LS_TICK = 'simtrader_lstick_v1';     // 合约 tick（order_price_round）缓存

  const SPANS = [200, 500, 2000, 5000];      // 可选视野（单边 tick 数）
  const REFRESH_MS = 5000;                   // 订单簿快照刷新间隔
  const BINS = 72;                           // 价格分档数
  const H = 470;                             // 画布高度
  /* PAD.l 是左侧价格数字区；AXIS_W 是紧随其后的「价格数轴」（量能结构带画在这里）；
     真正的能量柱从 PLOT_L 开始 —— 数轴与柱子分离，互不遮挡 */
  const PAD = { l: 86, r: 96, t: 22, b: 22 };
  const AXIS_W = 22;
  const PLOT_L = PAD.l + AXIS_W;

  const COL_BID = '#0a8f4e';     // 买盘挂单（价格下方 / 多头阵营）
  const COL_ASK = '#d92c2c';     // 卖盘挂单（价格上方 / 空头阵营）
  const COL_GRID = '#e9eef5';
  const COL_TXT = '#4b5563';
  const COL_TXT2 = '#8a94a6';
  const COL_NOW = '#2563eb';
  const COL_VA = '#6366f1';      // 价值区（中间聚集的量能带）
  const COL_UPV = '#f97316';     // 上方流动性空洞（橙色，区别于卖盘红）
  const COL_DNV = '#0891b2';     // 下方流动性空洞（青色，区别于买盘绿）

  const S = {
    host: null, cards: null, meta: null,
    svg: null, g: null, W: 0,
    inst: null, contract: '', dec: 2, mult: 0, tick: 0,
    span: 500, P: 0,
    book: null, quote: null, dist: null, loading: false, err: '', lastTs: 0, offline: false,
    view: null,                    // 手工缩放/平移后的价格窗口 {lo,hi}；null = 按视野自动
    showBands: true,               // 是否叠加「量能结构带」（POC / 价值区 / 上下空洞）
    drag: null, gen: 0, timer: 0, refetchT: 0, ro: null, raf: 0,
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
  function fmt(v) { return Number(v.toFixed(10)).toString(); }

  /* interval 候选：只允许 {0} ∪ {1,5}×10^k（实测 2 / 20 会被拒） */
  function intervalCandidates(tick) {
    const out = [0];
    for (let k = -8; k <= 6; k++) {
      for (const m of [1, 5]) {
        const v = m * Math.pow(10, k);
        if (v >= tick * 0.999) out.push(v);
      }
    }
    return out.sort((a, b) => a - b);
  }
  /* 经验：覆盖 tick 数 ≈ 300 × (interval / tick) × 1.2；原始簿（0）实测约 ±1500 tick */
  function pickInterval(tick, needTicks) {
    const c = intervalCandidates(tick);
    if (needTicks <= 1200) return 0;
    const target = tick * needTicks / 300;
    for (const v of c) { if (v > 0 && v >= target) return v; }
    return c[c.length - 1];
  }

  /* ---------------------------------------------------------------- 抓取 */
  /* 合约面值 + tick：都进缓存，否则离线那一瞬间金额会全算成 0、视野算成 ±0 */
  async function ensureContract(contract) {
    const mc = lsGet(LS_MULT, {}), tc = lsGet(LS_TICK, {});
    if (mc[contract]) S.mult = +mc[contract];
    if (tc[contract]) S.tick = +tc[contract];
    if (S.mult > 0 && S.tick > 0) return;
    try {
      const c = await fetchJson(`${GATE}/api/v4/futures/usdt/contracts/${contract}`, 9000);
      const m = +c.quanto_multiplier, t = +c.order_price_round;
      if (m > 0) { mc[contract] = m; lsSet(LS_MULT, mc); S.mult = m; }
      if (t > 0) { tc[contract] = t; lsSet(LS_TICK, tc); S.tick = t; }
    } catch (e) { /* 取不到就维持缓存值 */ }
  }

  async function fetchQuote(contract) {
    const j = await fetchJson(`${GATE}/api/v4/futures/usdt/tickers?contract=${contract}`, 9000);
    const t = Array.isArray(j) ? (j[0] || {}) : (j || {});
    const q = {
      last: +t.last, mark: +t.mark_price,
      high24: +t.high_24h, low24: +t.low_24h,
      funding: t.funding_rate == null ? null : +t.funding_rate,
      oiContracts: t.total_size == null ? null : +t.total_size,
    };
    if (q.oiContracts != null && S.mult > 0 && q.mark > 0) q.oiUsd = q.oiContracts * S.mult * q.mark;
    return q;
  }

  /* 取订单簿：粒度自适应。先按经验选 interval，覆盖不够就换更粗的（最多 4 次） */
  async function fetchBook(contract, tick, needTicks) {
    const cands = intervalCandidates(tick);
    let idx = Math.max(0, cands.indexOf(pickInterval(tick, needTicks)));
    let last = null;
    for (let t = 0; t < 4 && idx < cands.length; t++, idx++) {
      const iv = cands[idx];
      let j;
      try {
        j = await fetchJson(`${GATE}/api/v4/futures/usdt/order_book?contract=${contract}&limit=300&interval=${iv === 0 ? 0 : fmt(iv)}`, 9000);
      } catch (e) { continue; }
      const bids = (j.bids || []).map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
      const asks = (j.asks || []).map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
      if (!bids.length || !asks.length) { last = { bids, asks, interval: iv, coverTicks: 0, ts: Date.now() }; continue; }
      const midP = (bids[0][0] + asks[0][0]) / 2;
      let loB = bids[0][0], hiA = asks[0][0];
      bids.forEach(b => { if (b[0] < loB) loB = b[0]; });
      asks.forEach(a => { if (a[0] > hiA) hiA = a[0]; });
      const cover = Math.max(midP - loB, hiA - midP) / (tick || 1);
      last = { bids, asks, interval: iv, coverTicks: cover, midP, ts: Date.now() };
      if (cover >= needTicks) break;
    }
    return last;
  }

  /* ---------------------------------------------------------------- 视野 */
  function view() {
    if (S.view) return S.view;
    const P = S.P || (S.dist && S.dist.P) || 0;
    if (!(P > 0) || !(S.tick > 0)) return null;
    return { lo: P - S.span * S.tick, hi: P + S.span * S.tick };
  }
  /* 当前视野需要的单边 tick 数（留 25% 余量，免得一缩放就要重新取数） */
  function needTicks() {
    const v = view();
    const P = S.P || (S.dist && S.dist.P) || 0;
    if (!v || !(P > 0) || !(S.tick > 0)) return S.span;
    return Math.max(SPANS[0], Math.max(P - v.lo, v.hi - P) / S.tick * 1.25);
  }

  /* ==========================================================================
   * 量能结构带 —— 把订单簿读成一张「流动性地图」
   *
   *   POC   Point of Control：单位价位内挂单金额最大处（挂单意愿最密集的价位）
   *   VA    Value Area：包含 VA_SHARE 总挂单额的**最窄**价格区间 = 中间聚集的量能带
   *         算法：从 POC 向两侧贪心扩张（Market Profile 标准做法），
   *               保证「同等占比下区间最窄」的最优性
   *   空洞  上方只在**卖盘侧**、下方只在**买盘侧**滑窗找总额最小的一段
   *         稀疏度 = 窗口均值 ÷ 同侧均值；< 0.5 才判为「真的稀薄」
   *
   * ⚠ 为什么 POC/VA 可以把买卖合成一个数组算，而空洞不行：
   *   买盘只存在于买一以下、卖盘只存在于卖一以上 —— 两侧在价格上互斥，
   *   所以 tot[i] = bid[i]+ask[i] 在任何一格都等于「该价位的挂单总额」，不会重复计数，
   *   用它找全局最密集点是对的。
   *   但找「稀薄」必须分侧：拿 A 侧的值去衡量 B 侧的稀薄程度毫无意义，
   *   而且合成后的窗口会越过买卖分界、被另一侧的 0 拉低，选出跨 melaluiát界的假空洞。
   *
   * ⚠ 视野越窄越不可信：小视野下单行业发展被切碎，每格里要么是孤立大单要么几乎为零
   *   （实测 ETH ±400 tick 时格子内有 $54 与 $708K 并存），「最小量能带」退化为挑噪声。
   *   所以 VA 宽度 > 75% 视野、或稀疏度 > 0.75 时，UI 会明确标「不显著」而不是硬指一个带。
   * ======================================================================== */
  const VA_SHARE = 0.70;      // 价值区目标占比（通常 70%，即 Market Profile 的 VA）
  const VOID_WIN = 0.12;      // 空洞窗口宽度（占视野的比例）

  function findPeak(arr) {
    let i = 0;
    for (let k = 1; k < arr.length; k++) if (arr[k] > arr[i]) i = k;
    return i;
  }

  function valueArea(arr, target) {
    const tot = arr.reduce((a, b) => a + b, 0);
    if (!(tot > 0)) return null;
    let poc = findPeak(arr), lo = poc, hi = poc, acc = arr[poc];
    while (lo > 0 || hi < arr.length - 1) {
      const dv = lo > 0 ? arr[lo - 1] : -1;
      const uv = hi < arr.length - 1 ? arr[hi + 1] : -1;
      if (dv < 0 && uv < 0) break;
      if (dv >= uv) { lo--; acc += arr[lo]; } else { hi++; acc += arr[hi]; }
      if (acc / tot >= target) break;
    }
    return { lo, hi, poc, acc, share: acc / tot };
  }

  /* 单侧滑窗最小窗口。
     baseline 取**非零格的中位数**而不是均值 —— 这个选择是真实数据逼出来的：
     订单簿的典型形态是「少量巨墙 + 大量普通单」，用均值时那堵巨墙会把 baseline 抬高
     （实测：35 格 1000 + 1 格 50000 → 均值 2361），结果**均匀的普通挂单反过来显得稀薄**
     （稀疏度被压到 0.42 而误判成真空）。中位数对这类离群值稳健，才是「常态挂单水平」。*/
  function thinBand(arr, from, to, win) {
    const a = Math.max(0, from), b = Math.min(arr.length - 1, to);
    if (b - a + 1 < win || win < 1) return null;
    const nz = [];
    for (let i = a; i <= b; i++) if (arr[i] > 0) nz.push(arr[i]);
    nz.sort((x, y) => x - y);
    let baseline = 0;
    if (nz.length) {
      const m = nz.length >> 1;
      baseline = (nz.length % 2) ? nz[m] : (nz[m - 1] + nz[m]) / 2;
    }
    let sum = 0;
    for (let i = a; i < a + win; i++) sum += arr[i];
    let best = { lo: a, hi: a + win - 1, sum };
    for (let i = a + 1; i + win - 1 <= b; i++) {
      sum += arr[i + win - 1] - arr[i - 1];
      if (sum < best.sum) best = { lo: i, hi: i + win - 1, sum };
    }
    best.baseline = baseline;
    best.sparsity = baseline > 0 ? (best.sum / win) / baseline : 1;
    return best;
  }

  function computeBands(bidA, askA, lo, step, P, bins, tick) {
    const tot = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) tot[i] = bidA[i] + askA[i];
    const sumBid = bidA.reduce((a, b) => a + b, 0);
    const sumAsk = askA.reduce((a, b) => a + b, 0);
    const sumAll = tot.reduce((a, b) => a + b, 0);
    if (!(sumAll > 0)) return null;

    const pBin = findPeak(tot);
    const poc = { bin: pBin, price: lo + (pBin + 0.5) * step, usd: tot[pBin] };

    const r = valueArea(tot, VA_SHARE);
    const va = r ? {
      loBin: r.lo, hiBin: r.hi,
      lo: lo + r.lo * step, hi: lo + (r.hi + 1) * step,
      usd: r.acc, share: r.share, widthBins: r.hi - r.lo + 1,
      /* 价值区中心 vs 现价：二者接近 = 价格正处在市场公认的价值中枢 */
      center: lo + (r.lo + r.hi + 1) / 2 * step,
    } : null;
    if (va) va.tooWide = va.widthBins / bins > 0.75;      // 宽到没信息量

    const win = Math.max(2, Math.round(bins * VOID_WIN));
    const nowBin = clamp(Math.floor((P - lo) / step), 0, bins - 1);
    const mk = (band, side) => !band ? null : {
      side: side,
      loBin: band.lo, hiBin: band.hi,
      lo: lo + band.lo * step, hi: lo + (band.hi + 1) * step,
      usd: band.sum, sparsity: band.sparsity, baseline: band.baseline,
      thin: band.sparsity < 0.5,
      /* 窗口宽度按 tick 报出来：滑窗法找的是「这么宽的一段里最薄的」，
         不是「任意宽度的空洞」—— 宽度不写出来，这个数就会被误读 */
      widTicks: tick > 0 ? Math.round((band.hi - band.lo + 1) * step / tick) : 0,
      distPct: P > 0 ? ((lo + (band.lo + band.hi + 1) / 2 * step) - P) / P : 0,
    };
    const upper = mk(thinBand(askA, nowBin + 1, bins - 1, win), 'up');
    const lower = mk(thinBand(bidA, 0, nowBin - 1, win), 'down');

    return { poc, va, upper, lower, win, sumBid, sumAsk, sumAll, nowBin };
  }

  /* ---------------------------------------------------------------- 聚合 */
  function build(book, quote) {
    const P = quote.last > 0 ? quote.last : (quote.mark || 0);
    const v = view() || { lo: P * 0.999, hi: P * 1.001 };
    const lo = v.lo, hi = v.hi, step = (hi - lo) / BINS;
    const mult = S.mult || 0;
    const bidA = new Array(BINS).fill(0), askA = new Array(BINS).fill(0);
    const put = (arr, p, s) => {
      if (!(p >= lo && p < hi) || !(s > 0)) return;
      const i = clamp(Math.floor((p - lo) / step), 0, BINS - 1);
      arr[i] += s * mult * p;
    };
    (book.bids || []).forEach(r => put(bidA, r[0], r[1]));
    (book.asks || []).forEach(r => put(askA, r[0], r[1]));

    const sum = a => a.reduce((x, y) => x + y, 0);
    const peak = arr => {
      let bi = 0;
      arr.forEach((val, i) => { if (val > arr[bi]) bi = i; });
      return { price: lo + (bi + 0.5) * step, usd: arr[bi], bin: bi };
    };
    const totBid = sum(bidA), totAsk = sum(askA);
    return {
      contract: S.contract, dec: S.dec, ts: Date.now(),
      lo, hi, step, bins: BINS, tick: S.tick, span: S.span,
      bidA, askA, totBid, totAsk, P,
      peakBid: peak(bidA), peakAsk: peak(askA),
      /* 注意 peakBid/peakAsk 是「各自阵营里最厚的一堵墙」，
         bands.poc 是「全价位加起来最密集的那格」——两者常不在同一价位 */
      bands: computeBands(bidA, askA, lo, step, P, BINS, S.tick),
      nBid: (book.bids || []).length, nAsk: (book.asks || []).length,
      interval: book.interval, coverTicks: book.coverTicks || 0,
      bestBid: (book.bids && book.bids[0]) ? book.bids[0][0] : 0,
      bestAsk: (book.asks && book.asks[0]) ? book.asks[0][0] : 0,
      quote, offline: S.offline,
    };
  }

  /* ---------------------------------------------------------------- 数据加载 */
  async function load() {
    if (!S.contract) return;
    const gen = ++S.gen;
    S.loading = true;
    if (S.meta && !S.dist) S.meta.textContent = '多空热力图取数中…';
    try {
      S.offline = false;
      await ensureContract(S.contract);
      const need = needTicks();
      const [quote, book] = await Promise.all([
        fetchQuote(S.contract),
        fetchBook(S.contract, S.tick || 1, need),
      ]);
      if (gen !== S.gen) return;
      if (!(quote.last > 0) && !(quote.mark > 0)) throw new Error('行情为空');
      if (!book || (!book.bids.length && !book.asks.length)) throw new Error('订单簿为空');
      S.P = quote.last > 0 ? quote.last : quote.mark;
      S.quote = quote; S.book = book;
      S.dist = build(book, quote);
      S.lastTs = Date.now(); S.err = '';
      const snap = lsGet(LS_BOOK, {});
      snap[S.contract] = { ts: S.lastTs, quote, book: { bids: book.bids, asks: book.asks, interval: book.interval, coverTicks: book.coverTicks } };
      lsSet(LS_BOOK, snap);
    } catch (e) {
      if (gen !== S.gen) return;
      S.err = e && e.message ? e.message : String(e);
      S.offline = true;
      const snap = lsGet(LS_BOOK, {})[S.contract];
      if (snap && snap.book && snap.quote) {
        try {
          S.P = snap.quote.last > 0 ? snap.quote.last : snap.quote.mark;
          S.quote = snap.quote; S.book = snap.book;
          S.dist = build(snap.book, snap.quote);
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
      load();
    }, REFRESH_MS);
  }

  /* 缩放后视野超出当前订单簿覆盖 → 换更粗粒度重取；缩得太细 → 换回更细粒度 */
  function maybeRefetch() {
    clearTimeout(S.refetchT);
    S.refetchT = setTimeout(() => {
      if (!S.contract || !S.book) return;
      const need = needTicks();
      if (need > (S.book.coverTicks || 0) * 0.98) { load(); return; }
      if (S.book.interval > 0 && need * 3 < S.book.coverTicks) load();
    }, 420);
  }

  /* ---------------------------------------------------------------- 绘图 */
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
    const w = Math.max(320, S.host.clientWidth || 640);

    if (!S.dist) {
      ensureSvg(w);
      S.g.innerHTML = `<text x="${w / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="${COL_TXT2}">${S.err ? '取数失败：' + S.err : '加载中…'}</text>`;
      if (S.cards) S.cards.innerHTML = '';
      if (S.meta) S.meta.textContent = S.err ? 'Gate.io 永续接口不可达（' + S.err + '）' : '多空热力图加载中…';
      return;
    }
    ensureSvg(w);
    /* 缩放/平移后视野变了 → 用同一份订单簿按新视野重新分档（不必重新联网） */
    const v0 = view();
    if (S.book && S.quote && v0 && (Math.abs(S.dist.lo - v0.lo) > 1e-9 || Math.abs(S.dist.hi - v0.hi) > 1e-9)) {
      const wasCache = S.dist.fromCache;
      S.dist = build(S.book, S.quote);
      if (wasCache) S.dist.fromCache = true;
    }
    const d = S.dist;
    const v = view() || { lo: d.lo, hi: d.hi };
    const lo = v.lo, hi = v.hi, span = hi - lo, step = span / BINS;
    const plotW = w - PLOT_L - PAD.r, plotH = H - PAD.t - PAD.b;
    const cx = PLOT_L + plotW / 2, halfW = plotW / 2 - 8;
    const yOf = p => PAD.t + (hi - p) / span * plotH;
    const barH = Math.max(2, plotH / BINS - 1.2);
    const maxV = Math.max(Math.max.apply(null, d.bidA), Math.max.apply(null, d.askA), 1e-9);
    const bd = S.showBands ? d.bands : null;

    /* 把一段价格区间裁进绘图区；整个区间在视野外则返回 null */
    const clipBand = (bLo, bHi) => {
      const y1 = Math.max(PAD.t, yOf(bHi)), y2 = Math.min(PAD.t + plotH, yOf(bLo));
      return (y2 - y1 < 0.6) ? null : { y: y1, h: y2 - y1 };
    };

    let g = '';
    /* 网格 + 左右价格刻度 */
    for (let i = 0; i <= 6; i++) {
      const p = lo + span * i / 6, y = yOf(p);
      g += `<line x1="${PLOT_L}" y1="${y.toFixed(1)}" x2="${w - PAD.r}" y2="${y.toFixed(1)}" stroke="${COL_GRID}"/>`;
      g += `<text x="${PAD.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${COL_TXT}">${num(p, d.dec)}</text>`;
      if (d.P > 0) g += `<text x="${w - PAD.r + 8}" y="${(y + 4).toFixed(1)}" font-size="12" fill="${COL_TXT2}">${pct((p - d.P) / d.P, 2)}</text>`;
    }
    /* ① 三个「量能带」的横贯底色（画在柱子之前，当背景，不遮挡分布）*/
    if (bd) {
      const box = (bLo, bHi, fill, op) => {
        const r = clipBand(bLo, bHi); if (!r) return '';
        return `<rect x="${PLOT_L}" y="${r.y.toFixed(1)}" width="${plotW}" height="${r.h.toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`;
      };
      /* 过宽的 VA 说明这一档视野里根本没有明确聚集，把底色压淡，避免误导 */
      if (bd.va) g += box(bd.va.lo, bd.va.hi, COL_VA, bd.va.tooWide ? 0.03 : 0.085);
      if (bd.upper) g += box(bd.upper.lo, bd.upper.hi, COL_UPV, bd.upper.thin ? 0.11 : 0.04);
      if (bd.lower) g += box(bd.lower.lo, bd.lower.hi, COL_DNV, bd.lower.thin ? 0.11 : 0.04);
    }
    /* 多空分界中线 */
    g += `<line x1="${cx}" y1="${PAD.t}" x2="${cx}" y2="${PAD.t + plotH}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`;

    /* 分布柱：价格下方买盘向左（多头阵营），上方卖盘向右（空头阵营） */
    for (let i = 0; i < BINS; i++) {
      const y = yOf(lo + (i + 0.5) * step);
      if (y < PAD.t - barH || y > PAD.t + plotH) continue;
      if (d.bidA[i] > 0) {
        const bw = Math.max(1.5, d.bidA[i] / maxV * halfW);
        g += `<rect x="${(cx - bw).toFixed(1)}" y="${(y - barH / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${COL_BID}" fill-opacity="0.88"/>`;
      }
      if (d.askA[i] > 0) {
        const bw = Math.max(1.5, d.askA[i] / maxV * halfW);
        g += `<rect x="${cx.toFixed(1)}" y="${(y - barH / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${COL_ASK}" fill-opacity="0.88"/>`;
      }
    }

    /* 标注线：24h 高低 / 最厚买盘墙 / 最厚卖盘墙
       —— 标签统一靠右：左侧空间留给「量能结构带」的标签，两边不打架 */
    const marks = [];
    if (d.quote.high24 > lo && d.quote.high24 < hi) marks.push({ p: d.quote.high24, c: '#94a3b8', t: '24h 最高', dash: '3 5' });
    if (d.quote.low24 > lo && d.quote.low24 < hi) marks.push({ p: d.quote.low24, c: '#94a3b8', t: '24h 最低', dash: '3 5' });
    if (d.totBid > 0) marks.push({ p: d.peakBid.price, c: COL_BID, t: '最厚买盘 ' + usd(d.peakBid.usd), dash: '7 4' });
    if (d.totAsk > 0) marks.push({ p: d.peakAsk.price, c: COL_ASK, t: '最厚卖盘 ' + usd(d.peakAsk.usd), dash: '7 4' });
    const yList = marks.map(m => yOf(m.p));
    const order = marks.map((m, i) => i).sort((a, b) => yList[a] - yList[b]);
    for (let k = 1; k < order.length; k++) {
      const i = order[k], j = order[k - 1];
      if (yList[i] - yList[j] < 17) yList[i] = yList[j] + 17;
    }
    marks.forEach((m, i) => {
      const y = yOf(m.p);
      g += `<line x1="${PLOT_L}" y1="${y.toFixed(1)}" x2="${w - PAD.r}" y2="${y.toFixed(1)}" stroke="${m.c}" stroke-width="1.4" stroke-dasharray="${m.dash}"/>`;
      const ly = clamp(yList[i], PAD.t + 11, PAD.t + plotH - 2);
      g += `<text x="${w - PAD.r - 6}" y="${(ly + 4).toFixed(1)}" text-anchor="end"
        font-size="12.5" font-weight="700" fill="${m.c}" stroke="#fff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">${m.t} · ${num(m.p, d.dec)}</text>`;
    });

    /* ② 左侧「价格数轴」：一根按价格着色的竖直窄条，把三个量能带的位置一眼摊开。
          这是整张图的**纵向标尺**——同一套价格刻度，左侧这根条只回答「哪一段是墙、
          哪一段是空」，不画柱状长度，所以不会被利润分布图挤压。 */
    const axX = PAD.l + 4, axW = AXIS_W - 8;
    g += `<rect x="${axX}" y="${PAD.t}" width="${axW}" height="${plotH}" fill="#f8fafc" stroke="${COL_GRID}"/>`;
    if (bd) {
      const seg = (bLo, bHi, fill, op) => {
        const r = clipBand(bLo, bHi); if (!r) return '';
        return `<rect x="${axX}" y="${r.y.toFixed(1)}" width="${axW}" height="${r.h.toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`;
      };
      if (bd.va) g += seg(bd.va.lo, bd.va.hi, COL_VA, bd.va.tooWide ? 0.2 : 0.5);
      if (bd.upper) g += seg(bd.upper.lo, bd.upper.hi, COL_UPV, bd.upper.thin ? 0.9 : 0.3);
      if (bd.lower) g += seg(bd.lower.lo, bd.lower.hi, COL_DNV, bd.lower.thin ? 0.9 : 0.3);
      /* POC：数轴上的一道黑刻 */
      const yp = clamp(yOf(bd.poc.price), PAD.t, PAD.t + plotH);
      g += `<line x1="${axX}" y1="${yp.toFixed(1)}" x2="${(axX + axW).toFixed(1)}" y2="${yp.toFixed(1)}" stroke="#111827" stroke-width="3"/>`;
    }
    const ynp0 = clamp(yOf(d.P), PAD.t, PAD.t + plotH);
    g += `<line x1="${axX}" y1="${ynp0.toFixed(1)}" x2="${(axX + axW).toFixed(1)}" y2="${ynp0.toFixed(1)}" stroke="${COL_NOW}" stroke-width="2.5"/>`;

    /* ③ 结构标签：贴在绘图区左缘（右侧留给 24h 高低 / 最厚墙），纵向自动避让 */
    if (bd) {
      const tags = [];
      if (bd.upper) tags.push({
        p: (bd.upper.lo + bd.upper.hi) / 2, c: COL_UPV,
        t: (bd.upper.thin ? '▲ 上方最薄带 $' : '▲ 上方薄弱（不显著）$') + usd(bd.upper.usd),
        s: `${num(bd.upper.lo, d.dec)}–${num(bd.upper.hi, d.dec)} · 宽 ${bd.upper.widTicks} tick · 稀疏 ${bd.upper.sparsity.toFixed(2)} · ${pct(bd.upper.distPct, 2)}`,
      });
      if (bd.lower) tags.push({
        p: (bd.lower.lo + bd.lower.hi) / 2, c: COL_DNV,
        t: (bd.lower.thin ? '▼ 下方最薄带 $' : '▼ 下方薄弱（不显著）$') + usd(bd.lower.usd),
        s: `${num(bd.lower.lo, d.dec)}–${num(bd.lower.hi, d.dec)} · 宽 ${bd.lower.widTicks} tick · 稀疏 ${bd.lower.sparsity.toFixed(2)} · ${pct(bd.lower.distPct, 2)}`,
      });
      if (bd.va) tags.push({
        p: bd.va.center, c: COL_VA,
        t: bd.va.tooWide
          ? `◆ 无明显聚集带（价值区宽达 ${Math.round(bd.va.widthBins / BINS * 100)}% 视野）`
          : `◆ 中间聚集带 · ${(bd.va.share * 100).toFixed(0)}% 量能挤在 ${Math.round(bd.va.widthBins / BINS * 100)}% 视野内`,
        s: `${num(bd.va.lo, d.dec)}–${num(bd.va.hi, d.dec)} · $${usd(bd.va.usd)} · 中心偏离现价 ${pct((bd.va.center - d.P) / (d.P || 1), 2)}`,
      });
      tags.push({
        p: bd.poc.price, c: '#111827',
        t: '● 挂单最密集价位（POC）$' + usd(bd.poc.usd),
        s: `${num(bd.poc.price, d.dec)} · ${pct((bd.poc.price - d.P) / (d.P || 1), 2)} vs 现价`,
      });
      const ty = tags.map(t => yOf(t.p));
      const ord = tags.map((t, i) => i).sort((a, b) => ty[a] - ty[b]);
      for (let k = 1; k < ord.length; k++) {
        const i = ord[k], j = ord[k - 1];
        if (ty[i] - ty[j] < 31) ty[i] = ty[j] + 31;
      }
      tags.forEach((t, i) => {
        const y0 = clamp(ty[i], PAD.t + 10, PAD.t + plotH - 15);
        g += `<text x="${PLOT_L + 6}" y="${(y0 - 3).toFixed(1)}" font-size="12" font-weight="700" fill="${t.c}" stroke="#fff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">${t.t}</text>`;
        g += `<text x="${PLOT_L + 6}" y="${(y0 + 11).toFixed(1)}" font-size="11" fill="${COL_TXT2}" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${t.s}</text>`;
      });
    }

    /* 现价 */
    const py = yOf(d.P);
    if (py > PAD.t - 4 && py < PAD.t + plotH + 4) {
      g += `<line x1="${PLOT_L}" y1="${py.toFixed(1)}" x2="${w - PAD.r}" y2="${py.toFixed(1)}" stroke="${COL_NOW}" stroke-width="2"/>`;
      g += `<rect x="${(cx - 48).toFixed(1)}" y="${(py - 11).toFixed(1)}" width="96" height="21" rx="5" fill="${COL_NOW}"/>`;
      g += `<text x="${cx}" y="${(py + 4).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#fff">现价 ${num(d.P, d.dec)}</text>`;
    }

    /* 左右表头 + 数轴标题 */
    g += `<text x="${PLOT_L + 6}" y="${PAD.t - 7}" font-size="13" font-weight="700" fill="${COL_BID}">◀ 买盘挂单（价格下方）$${usd(d.totBid)}</text>`;
    g += `<text x="${w - PAD.r - 6}" y="${PAD.t - 7}" text-anchor="end" font-size="13" font-weight="700" fill="${COL_ASK}">卖盘挂单（价格上方）$${usd(d.totAsk)} ▶</text>`;
    g += `<text x="${PAD.l}" y="${PAD.t - 7}" font-size="9.5" fill="${COL_TXT2}">价位轴</text>`;
    g += `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11.5" fill="${COL_TXT2}">滚轮上下缩放（自动取更深订单簿）· 按住拖动平移 · 双击复位</text>`;

    S.g.innerHTML = g;
    renderCards();
    renderMeta();
  }

  function renderMeta() {
    if (!S.meta) return;
    const d = S.dist; if (!d) return;
    const v = view() || { lo: d.lo, hi: d.hi };
    const halfTick = Math.max(d.P - v.lo, v.hi - d.P) / (d.tick || 1);
    const spanPct = d.P > 0 ? ((v.hi - v.lo) / d.P * 100).toFixed(3) : '—';
    const age = Math.round((Date.now() - S.lastTs) / 1000);
    const parts = [
      `Gate.io 永续订单簿 · ${d.contract} · tick ${fmt(d.tick)}`,
      `视野 ±${Math.round(halfTick)} tick（±${num(halfTick * d.tick, d.dec)}，${spanPct}%）`,
      `挂单 ${d.nBid}/${d.nAsk} 档 · 粒度 ${d.interval === 0 ? '原始价位' : fmt(d.interval)} · 覆盖 ±${Math.round(d.coverTicks)} tick`,
      (S.offline || d.fromCache) ? `⚠ 接口不可达，显示 ${age}s 前本地快照` : `更新于 ${new Date(S.lastTs).toLocaleTimeString('zh-CN', { hour12: false })}（${age}s 前）`,
    ];
    S.meta.textContent = parts.join(' · ');
    S.meta.classList.toggle('rt', !(S.offline || d.fromCache));
  }

  function renderCards() {
    if (!S.cards) return;
    const d = S.dist; if (!d) { S.cards.innerHTML = ''; return; }
    const q = d.quote, dec = d.dec;
    const tot = d.totBid + d.totAsk;
    const imb = tot > 0 ? (d.totBid - d.totAsk) / tot : 0;                 // 挂单失衡（正=买盘厚）
    const bias = Math.abs(imb) < 0.08 ? ['挂单均衡', 'var(--muted)']
      : imb > 0 ? [imb > 0.35 ? '买盘明显占优' : '略偏买盘', 'var(--up)']
        : [imb < -0.35 ? '卖盘明显占优' : '略偏卖盘', 'var(--down)'];
    const ratio = d.totAsk > 0 ? d.totBid / d.totAsk : null;
    const spread = (d.bestAsk > 0 && d.bestBid > 0) ? d.bestAsk - d.bestBid : 0;

    const row = (k, v, sub, color) => `<div class="rc"><div class="k">${k}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${v}${sub ? `<small> ${sub}</small>` : ''}</div></div>`;
    const rows = [
      row('盘口方向', bias[0], `失衡 ${(imb * 100).toFixed(0)}`, bias[1]),
      row('买盘挂单量', '$' + usd(d.totBid), tot > 0 ? `占 ${(d.totBid / tot * 100).toFixed(0)}%` : '', COL_BID),
      row('卖盘挂单量', '$' + usd(d.totAsk), tot > 0 ? `占 ${(d.totAsk / tot * 100).toFixed(0)}%` : '', COL_ASK),
      row('买卖挂单比', ratio == null ? '—' : ratio.toFixed(2), ratio == null ? '' : (ratio > 1 ? '买盘更厚' : '卖盘更厚'), ratio == null ? null : (ratio > 1 ? 'var(--up)' : 'var(--down)')),
      row('最厚买盘墙', num(d.peakBid.price, dec), '$' + usd(d.peakBid.usd), COL_BID),
      row('最厚卖盘墙', num(d.peakAsk.price, dec), '$' + usd(d.peakAsk.usd), COL_ASK),
      row('未平仓合约（真实持仓）', q.oiUsd ? '$' + usd(q.oiUsd) : '—', '非挂单，来自 tickers'),
      row('资金费率', q.funding == null ? '—' : pct(q.funding, 4), q.funding == null ? '' : (q.funding > 0 ? '多头付空头' : '空头付多头')),
      row('现价 / 标记价', num(q.last, dec), '标记 ' + num(q.mark, dec)),
      row('买一 / 卖一', num(d.bestBid, dec), num(d.bestAsk, dec) + (spread > 0 ? ` · 价差 ${num(spread, dec)}` : '')),
    ];

    /* 量能结构带：插在「最厚墙」之后 —— 墙是单点，结构带是区间，二者互补 */
    const bd = S.showBands ? d.bands : null;
    if (bd) {
      const st = [];
      st.push(row(bd.va && bd.va.tooWide ? '中间聚集带（不显著）' : '中间聚集带（价值区）',
        bd.va ? '$' + usd(bd.va.usd) : '—',
        bd.va ? `${num(bd.va.lo, dec)}–${num(bd.va.hi, dec)}` : '', COL_VA));
      st.push(row('挂单最密集 POC', num(bd.poc.price, dec),
        '$' + usd(bd.poc.usd) + ' · ' + pct((bd.poc.price - q.last) / (q.last || 1), 2), null));
      if (bd.upper) st.push(row('上方最薄带', '$' + usd(bd.upper.usd),
        `稀疏 ${bd.upper.sparsity.toFixed(2)} · ${pct(bd.upper.distPct, 2)}`, COL_UPV));
      if (bd.lower) st.push(row('下方最薄带', '$' + usd(bd.lower.usd),
        `稀疏 ${bd.lower.sparsity.toFixed(2)} · ${pct(bd.lower.distPct, 2)}`, COL_DNV));
      /* 判读：稀疏度越小越接近真空，两侧对比决定「往哪边更好走」 */
      if (bd.upper && bd.lower) {
        const diff = bd.lower.sparsity - bd.upper.sparsity;
        const near = Math.abs(diff) < 0.08;
        st.push(row('流动性判读',
          near ? '上下稀薄程度接近' : (diff > 0 ? '上方更薄 → 向上突破阻力更小' : '下方更薄 → 向下跌破阻力更小'),
          `上 ${bd.upper.sparsity.toFixed(2)} / 下 ${bd.lower.sparsity.toFixed(2)}`,
          near ? null : (diff > 0 ? 'var(--up)' : 'var(--down)')));
      }
      rows.splice(6, 0, ...st);
    }
    S.cards.innerHTML = rows.join('');
  }

  /* ---------------------------------------------------------------- 交互 */
  function bindInteractions() {
    const svg = S.svg; if (!svg) return;

    svg.addEventListener('wheel', e => {
      const d = S.dist; if (!d) return;
      e.preventDefault();
      const v = view() || { lo: d.lo, hi: d.hi };
      const rect = svg.getBoundingClientRect();
      const plotH = H - PAD.t - PAD.b;
      const rel = clamp(((e.clientY - rect.top) * (H / (rect.height || H)) - PAD.t) / plotH, 0, 1);
      const anchor = v.hi - rel * (v.hi - v.lo);          // 以光标所在价格为锚点
      const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      let nl = anchor - (anchor - v.lo) * k;
      let nh = anchor + (v.hi - anchor) * k;
      const minSpan = (S.tick || 1) * 24;                 // 太窄没有意义（至少几十个 tick）
      const maxSpan = d.P * 0.40;
      if (nh - nl < minSpan) { const m = (nl + nh) / 2; nl = m - minSpan / 2; nh = m + minSpan / 2; }
      if (nh - nl > maxSpan) { const m = (nl + nh) / 2; nl = m - maxSpan / 2; nh = m + maxSpan / 2; }
      S.view = { lo: nl, hi: nh };
      render();
      maybeRefetch();
    }, { passive: false });

    svg.addEventListener('pointerdown', e => {
      if (!S.dist) return;
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
      maybeRefetch();
    });
    const end = e => {
      if (!S.drag) return;
      S.drag = null; svg.style.cursor = 'grab';
      try { svg.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { S.view = null; render(); maybeRefetch(); });
  }

  function resetView() { S.view = null; render(); maybeRefetch(); }

  /* ---------------------------------------------------------------- 外部接口 */
  function init(host, cards, meta) {
    S.host = host; S.cards = cards; S.meta = meta;
    S.span = lsGet(LS_SPAN, 500);
    if (!SPANS.includes(S.span)) S.span = 500;
    S.showBands = lsGet(LS_BANDS, true) !== false;
    if (window.ResizeObserver && host) {
      if (S.ro) { try { S.ro.disconnect(); } catch (e) {} }
      S.ro = new ResizeObserver(() => {
        cancelAnimationFrame(S.raf);
        S.raf = requestAnimationFrame(render);
      });
      S.ro.observe(host);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.contract) load(); });
    render();
  }

  function setInstrument(inst) {
    const contract = inst && inst.contract ? inst.contract : '';
    if (!inst || !contract) {
      S.inst = null; S.contract = ''; S.dist = null; S.book = null; S.view = null; S.P = 0;
      render(); return;
    }
    const changed = S.contract !== contract;
    S.inst = inst; S.contract = contract; S.dec = inst.dec == null ? 2 : inst.dec;
    S.view = null;
    if (changed) {
      /* 先用手头快照把图画出来，再联网刷新（换品种也有内容，不会空白） */
      S.dist = null; S.P = 0;
      const snap = lsGet(LS_BOOK, {})[contract];
      if (snap && snap.book && snap.quote) {
        try {
          S.P = snap.quote.last > 0 ? snap.quote.last : snap.quote.mark;
          S.book = snap.book;
          S.mult = +lsGet(LS_MULT, {})[contract] || S.mult;
          S.tick = +lsGet(LS_TICK, {})[contract] || S.tick;
          if (S.P > 0 && S.tick > 0) { S.dist = build(snap.book, snap.quote); S.dist.fromCache = true; }
        } catch (e) { /* ignore */ }
      }
      render();
    }
    load();
  }

  function setSpan(span) {
    span = +span;
    if (!SPANS.includes(span) || span === S.span) return;
    S.span = span; lsSet(LS_SPAN, span); S.view = null;
    load();
  }

  window.LsMap = {
    init, setInstrument, setSpan, refresh: load, resetView, render,
    span: () => S.span,
    hasDist: () => !!S.dist,
    dist: () => S.dist,
    book: () => S.book,
    /* 量能结构带（POC / 价值区 / 上下最薄带） */
    showBands: () => S.showBands,
    setBands: on => { S.showBands = !!on; lsSet(LS_BANDS, S.showBands); render(); },
    bands: () => (S.showBands && S.dist) ? S.dist.bands : null,
    SPANS,
  };
})();
