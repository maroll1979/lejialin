/* Market Board v1.0 — 多平台行情聚合 / 指标演算 / 模拟下单提示
 * 说明：本文件不连接任何真实交易账户，不具备自动下单能力。 */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const fmt = (n, d = 2) => (n == null || !isFinite(n)) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();

/* ============================ 品种定义 ============================ */
// vol = 日化波动率（用于合成 K 线的尺度），dp = 小数位
// perp = 各交易所「永续合约」代码；null 表示该平台无此品种的永续合约
const SYMS = {
  BTC:    { id:'BTC',    label:'BTC',    cn:'比特币',      cg:'bitcoin', vol:0.026, dp:2, min:0.01,
            perp:{ binance:'BTCUSDT', okx:'BTC-USDT-SWAP', bybit:'BTCUSDT', gate:'BTC_USDT', bingx:'BTC-USDT' } },
  ETH:    { id:'ETH',    label:'ETH',    cn:'以太坊',      cg:'ethereum', vol:0.033, dp:2, min:0.01,
            perp:{ binance:'ETHUSDT', okx:'ETH-USDT-SWAP', bybit:'ETHUSDT', gate:'ETH_USDT', bingx:'ETH-USDT' } },
  BNB:    { id:'BNB',    label:'BNB',    cn:'币安币',      cg:'binancecoin', vol:0.031, dp:2, min:0.01,
            perp:{ binance:'BNBUSDT', okx:'BNB-USDT-SWAP', bybit:'BNBUSDT', gate:'BNB_USDT', bingx:'BNB-USDT' } },
  XAUUSD: { id:'XAUUSD', label:'XAU/USD',cn:'伦敦金',      vol:0.009, dp:2, min:0.01, gold:true,
            perp:{ binance:'XAUUSDT', okx:'XAU-USDT-SWAP', bybit:'XAUUSDT', gate:'XAU_USDT', bingx:'XAUT-USDT' } },
  // 布伦特：加密所中仅 BingX 挂出永续；其余平台无永续，故支持源较少
  UKOIL:  { id:'UKOIL',  label:'BRENT',  cn:'布伦特原油',  yh:'BZ=F', vol:0.019, dp:3, min:0.001, oil:true,
            perp:{ binance:null, okx:null, bybit:null, gate:null, bingx:'NCCO1OILBRENT2USD-USDT' } },
};
const SYM_LIST = Object.values(SYMS);

// okx / bybit / bingx = 各平台永续 K 线的周期参数
const TFS = [
  { k:'15m', label:'15分钟', m:15,  yh:'15m', yr:'5d',  okx:'15m', bybit:15,  bingx:'15m' },
  { k:'30m', label:'30分钟', m:30,  yh:'30m', yr:'10d', okx:'30m', bybit:30,  bingx:'30m' },
  { k:'1h',  label:'1小时',  m:60,  yh:'60m', yr:'1mo', okx:'1H',  bybit:60,  bingx:'1h'  },
  { k:'4h',  label:'4小时',  m:240, yh:'1h',  yr:'3mo', okx:'4H',  bybit:240, bingx:'4h', agg:4 },
];
const TF_MAP = Object.fromEntries(TFS.map(t => [t.k, t]));

/* ============================ 网络基础 ============================ */
let PROXY = localStorage.getItem('mb_proxy') || '';   // 形如 https://xxx/?url={url}

/* 转发通道：0 = 浏览器直连交易所，其余 = 公共转发。
 * 为什么要这个：交易所接口大多不返回 CORS 头，浏览器直连会被拦，
 * 一旦拦掉整个页面就没数据了。转发通道只做「原样搬运」，取回的仍是交易所当时的真实行情，
 * 不是任何本地编造的序列。任何一条通道失败都自动换下一条，全部失败才报错。 */
const RELAYS = [
  { id: 'direct', name: '直连', mk: u => u },
  { id: 'allorigins', name: 'AllOrigins', mk: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { id: 'codetabs', name: 'CodeTabs', mk: u => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u) },
  { id: 'thingproxy', name: 'ThingProxy', mk: u => 'https://thingproxy.freeboard.io/fetch/' + u },
];

function relayList() {
  const list = RELAYS.slice();
  if (PROXY) list.splice(1, 0, {
    id: 'custom', name: '自定义',
    mk: u => (PROXY.includes('{url}') ? PROXY.replace('{url}', encodeURIComponent(u)) : PROXY + encodeURIComponent(u)),
  });
  return list;
}

/* 每次成功请求都记下「走的是哪条通道」，顶部状态灯据此区分直连 / 转发 / 不可达。
 * 记这个不是为了好看：转发通道比直连慢且可能被限流，用户需要知道当前数据是怎么来的。 */
const NET = { relay: 'direct', relayName: '直连', ok: 0, fail: 0, lastOk: 0, lastErr: '' };

async function jget(url, ms = 7000, headers) {
  const list = relayList();
  const deadline = now() + ms;
  let lastErr = new Error('无可用通道');
  for (const ry of list) {
    const left = deadline - now();
    if (left <= 0) break;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), left);
    try {
      const r = await fetch(ry.mk(url), { signal: ac.signal, cache: 'no-store', headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      NET.relay = ry.id; NET.relayName = ry.name;
      NET.ok++; NET.lastOk = now(); NET.lastErr = '';
      return j;
    } catch (e) {
      lastErr = e;
      NET.fail++; NET.lastErr = String(e.message || e);
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

/* 带自定义头的请求（Coinglass 等需要 API Key）：公共转发通道会丢掉自定义头，
 * 所以只在「直连 / 用户自建代理」两条通道上试，失败即失败，不伪造任何数据。 */
async function jgetH(url, headers, ms = 9000) {
  const list = relayList().filter(r => r.id === 'direct' || r.id === 'custom');
  let lastErr = new Error('无可用通道');
  for (const ry of list) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(ry.mk(url), { signal: ac.signal, cache: 'no-store', headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      NET.relay = ry.id; NET.relayName = ry.name; NET.ok++; NET.lastOk = now();
      return j;
    } catch (e) { lastErr = e; NET.fail++; NET.lastErr = String(e.message || e); }
    finally { clearTimeout(t); }
  }
  throw lastErr;
}

/* ============================ 平台适配器（永续合约） ============================ */
// 每个平台返回 { price, mark, funding } 或抛错。真实优先，失败在 UI 上显式标注。
// 对比口径统一为「永续合约价」：优先取标记价(mark)，无标记价时取最新成交价(last)。
// funding = 当期资金费率（永续特有），取不到则为 null。
const VENUES = [
  { id:'binance', name:'Binance', note:'永续 · 标记价', perp:true,
    async get(s){
      const sym = s.perp && s.perp.binance; if(!sym) throw new Error('无此永续合约');
      const r = await jget(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
      const mark = parseFloat(r && r.markPrice);
      const px = mark || parseFloat(r && r.indexPrice);
      if (!px) throw new Error('no data');
      return { price: px, mark: mark || null, funding: parseFloat(r.lastFundingRate) };
    } },
  { id:'okx', name:'OKX', note:'永续 · 最新价', perp:true,
    async get(s){
      const sym = s.perp && s.perp.okx; if(!sym) throw new Error('无此永续合约');
      const r = await jget(`https://www.okx.com/api/v5/market/ticker?instId=${sym}`);
      const p = parseFloat(r && r.data && r.data[0] && r.data[0].last);
      if (!p) throw new Error('no data');
      return { price: p, mark: null, funding: null };
    } },
  { id:'bybit', name:'Bybit', note:'永续 · 标记价', perp:true,
    async get(s){
      const sym = s.perp && s.perp.bybit; if(!sym) throw new Error('无此永续合约');
      const r = await jget(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
      const it = r && r.result && r.result.list && r.result.list[0];
      const mark = parseFloat(it && it.markPrice);
      const px = mark || parseFloat(it && it.lastPrice);
      if (!px) throw new Error('no data');
      return { price: px, mark: mark || null, funding: parseFloat(it.fundingRate) };
    } },
  { id:'gate', name:'Gate.io', note:'永续 · 标记价', perp:true,
    async get(s){
      const sym = s.perp && s.perp.gate; if(!sym) throw new Error('无此永续合约');
      const r = await jget(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${sym}`);
      const it = Array.isArray(r) ? r[0] : null;
      const mark = parseFloat(it && it.mark_price);
      const px = mark || parseFloat(it && it.last);
      if (!px) throw new Error('no data');
      return { price: px, mark: mark || null, funding: parseFloat(it.funding_rate) };
    } },
  { id:'bingx', name:'BingX', note:'永续 · 最新价', perp:true,
    async get(s){
      const sym = s.perp && s.perp.bingx; if(!sym) throw new Error('无此永续合约');
      const r = await jget(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${sym}`);
      const p = parseFloat(r && r.data && r.data.lastPrice);
      if (!p) throw new Error('no data');
      return { price: p, mark: null, funding: null };
    } },
  // 布伦特无多平台永续，此处用传统期货连续合约作对照，界面上强制标注「非永续」
  { id:'yahoo', name:'Yahoo', note:'期货连续 · 非永续', perp:false,
    async get(s){
      if (!s.yh) throw new Error('无期货代码');
      const r = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${s.yh}?interval=1m&range=1d`);
      const p = r?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!p) throw new Error('no data');
      return { price: p, mark: null, funding: null };
    } },
  // 现货指数：仅作「永续 vs 现货」基差参考，不参与多平台价差对比
  { id:'coingecko', name:'CoinGecko', note:'现货指数 · 仅参考', perp:false, spotRef:true,
    async get(s){ if(!s.cg) throw new Error('无现货映射');
      const r = await jget(`https://api.coingecko.com/api/v3/simple/price?ids=${s.cg}&vs_currencies=usd`);
      const p = r && r[s.cg] && r[s.cg].usd; if (!p) throw new Error('no data');
      return { price: p, mark: null, funding: null };
    } },
];
const VENUE_BY_ID = Object.fromEntries(VENUES.map(v => [v.id, v]));
// 币安永续合约代码（多空比 / 清算数据用），无映射时返回 null
const binSym = s => (s.perp && s.perp.binance) || null;

/* ============================ 状态 ============================ */
const S = {
  sym: localStorage.getItem('mb_sym') || 'BTC',
  tf: localStorage.getItem('mb_tf') || '1h',
  quotes: {},        // sym -> { rows:[], median, hi, lo, spread, spreadPct, ts, realCount }
  klines: {},        // sym -> { tf -> { bars:[], real:bool, stale:bool, staleSince:number } }
  kErr: {},          // "sym|tf" -> 最近一次取 K 线失败的原因，成功即清空
  venues: {},        // venueId -> { ok, ms, err }
  pos: JSON.parse(localStorage.getItem('mb_pos') || '[]'),
  side: 'long', type: 'market', lev: 10,
  hover: null,
  heat: null,        // 当前选中的热力图数据
  heats: {},         // sym -> tf -> heat：四格信号每个周期一份
  cgLiq: {},         // sym -> { list, ts }：Coinglass 真实清算记录缓存
  heatErr: '',       // Coinglass 取数失败原因
  acLiq: {},         // sym -> AiCoin 1 小时爆仓统计（real / 失败原因）
  kvCount: 130,      // K 线可视根数（滚轮缩放）
  kvEnd: null,       // K 线可视右端索引，null = 贴住最新；向左拖可回看历史
  drag: null,        // 平移中的拖拽状态
};

/* ============================ 行情聚合 ============================ */
// 确定性伪随机：保证“参考报价”稳定，不随刷新闪烁
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seedOf(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

async function loadQuotes(symId) {
  const s = SYMS[symId];
  const t0 = now();
  const list = VENUES.filter(v => {
    if (v.id === 'yahoo') return !!s.yh;              // 商品期货对照（非永续）
    if (v.spotRef) return !!s.cg;                     // 现货指数对照（非永续）
    return true;                                       // 永续源全部参与
  });

  const res = await Promise.all(list.map(async v => {
    const t = now();
    const note = typeof v.note === 'function' ? v.note(s) : v.note;
    try {
      const d = await v.get(s);
      S.venues[v.id] = { ok: true, ms: now() - t };
      return { id: v.id, name: v.name, note, price: d.price, mark: d.mark,
               funding: d.funding, perp: !!v.perp, real: true, ms: now() - t };
    } catch (e) {
      S.venues[v.id] = { ok: false, err: String(e.message || e) };
      return { id: v.id, name: v.name, note, price: null, perp: !!v.perp,
               real: false, err: String(e.message || e) };
    }
  }));

  // 只有「永续合约源」参与多平台价差对比；现货/期货源仅作基差参考
  const ok = res.filter(r => r.price != null);
  const perpRows = ok.filter(r => r.perp);
  const refRows  = ok.filter(r => !r.perp);

  const rows = perpRows.slice();
  const realCount = rows.length;
  /* 真实永续源不足 2 个时，不再补任何「参考报价」。
   * 旧版会按真实价 ±0.08% 造三个假平台出来演示价差算法 —— 那三行数字不属于任何交易所，
   * 却和真实报价并排显示在同一张表里，等于把编造数据混进真实数据。
   * 价差表宁可空着、宁可显示「真实源不足」，也不能造。 */

  const vals = rows.map(r => r.price).sort((a, b) => a - b);
  const median = vals.length
    ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2)
    : null;
  const hi = vals.length ? vals[vals.length - 1] : null;
  const lo = vals.length ? vals[0] : null;
  const mid = rows.find(r => r.real) || rows[0] || null;

  // 平台最低价≥？按用户规则：以“交易价格”为基准，阈值 0.10%
  const basePx = mid ? mid.price : median;
  const spread = (hi != null && lo != null) ? hi - lo : null;
  const spreadPct = (spread != null && lo > 0) ? spread / lo * 100 : null;

  if (median) {
    rows.forEach(r => {
      r.dev = (r.price - median) / median * 100;
      r.isHi = r.price === hi; r.isLo = r.price === lo;
    });
    refRows.forEach(r => { r.dev = (r.price - median) / median * 100; });
  }

  // 资金费率：取各永续源中位数，用于展示多头/空头付费方向
  const fr = perpRows.map(r => r.funding).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  const funding = fr.length
    ? (fr.length % 2 ? fr[(fr.length - 1) / 2] : (fr[fr.length / 2 - 1] + fr[fr.length / 2]) / 2)
    : null;

  S.quotes[symId] = {
    rows, refRows, median, hi, lo, spread, spreadPct, realCount, basePx,
    funding, fundingCount: fr.length,
    ts: now() - t0,
    // 价差阈值判定必须显式判空：spreadPct 为 null 时 `null >= 0.10` 是 false，语义正确但容易被误读
    hit: spreadPct != null && spreadPct >= 0.10,
    price: mid ? mid.price : median,
  };
  return S.quotes[symId];
}

/* 没有「断网兜底锚定价」。
 * 旧版在拿不到任何报价时会用一组写死的价格（BTC 78000 之类）顶上去，
 * 页面看起来有数，实际那个数跟市场毫无关系。现在一律显示「—」并给出取数失败原因。 */

/* ============================ K 线：全部来自交易所真实接口 ============================ */
/* ---- 各平台「永续合约」K 线适配器：统一返回升序 bars ---- */
const KLINE = {
  binance: { name: 'Binance 永续', async run(sym, tf) {
    const r = await jget(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf.k}&limit=240`, 9000);
    if (!Array.isArray(r) || !r.length) throw new Error('empty');
    return r.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } },
  okx: { name: 'OKX 永续', async run(sym, tf) {
    const r = await jget(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${tf.okx}&limit=240`, 9000);
    if (!r || r.code !== '0' || !r.data || !r.data.length) throw new Error('empty');
    return r.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  } },
  bybit: { name: 'Bybit 永续', async run(sym, tf) {
    const r = await jget(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${tf.bybit}&limit=240`, 9000);
    const l = r && r.result && r.result.list;
    if (!l || !l.length) throw new Error('empty');
    return l.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  } },
  bingx: { name: 'BingX 永续', async run(sym, tf) {
    const r = await jget(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${sym}&interval=${tf.bingx}&limit=240`, 9000);
    const l = r && r.data;
    if (!l || !l.length) throw new Error('empty');
    return l.map(k => ({ t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume })).reverse();
  } },
  yahoo: { name: 'Yahoo 期货', async run(sym, tf) {
    const r = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${tf.yh}&range=${tf.yr}`, 9000);
    const res = r?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error('empty');
    const q = res.indicators.quote[0];
    let bars = res.timestamp.map((t, i) => ({
      t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0,
    })).filter(b => b.o && b.h && b.l && b.c);
    if (!bars.length) throw new Error('empty');
    if (tf.agg) { // 4h 由 1h 聚合
      const out = [];
      for (let i = 0; i < bars.length; i += tf.agg) {
        const g = bars.slice(i, i + tf.agg); if (g.length < tf.agg) break;
        out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, v: g.reduce((a, x) => a + x.v, 0) });
      }
      bars = out;
    }
    return bars;
  } },
};

// 永续优先，逐级回退；全部失败交由上层合成兜底
async function fetchReal(symId, tfKey) {
  const s = SYMS[symId], tf = TF_MAP[tfKey];
  const chain = [];
  if (s.perp) {
    if (s.perp.binance) chain.push(['binance', s.perp.binance]);
    if (s.perp.okx)     chain.push(['okx', s.perp.okx]);
    if (s.perp.bybit)   chain.push(['bybit', s.perp.bybit]);
    if (s.perp.bingx)   chain.push(['bingx', s.perp.bingx]);
  }
  if (s.yh) chain.push(['yahoo', s.yh]);

  let lastErr = new Error('无可用永续 K 线源');
  for (const [vid, sym] of chain) {
    try {
      const bars = await KLINE[vid].run(sym, tf);
      const clean = bars.filter(b => isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c));
      if (clean.length >= 30) return { bars: clean.slice(-240), real: true, src: KLINE[vid].name };
      lastErr = new Error(KLINE[vid].name + ' 返回数据不足');
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* 确定性随机 K 线序列。
 * ⚠️ 仅用于测试构造样本（tests/_test.js 等把它当 fixture），
 *    任何线上渲染路径都禁止调用 —— 页面上不允许出现一根编造出来的 K 线。
 *    若你在业务代码里看到 mkBars 的调用，那就是 bug。 */
function mkBars(symId, tfKey, anchor) {
  const s = SYMS[symId], tf = TF_MAP[tfKey], n = 240;
  const rnd = mulberry32(seedOf(symId + tfKey));
  const sigma = s.vol * Math.sqrt(tf.m / 1440);
  const drift = (rnd() - 0.45) * sigma * 0.12;
  const g = mulberry32(seedOf(symId + tfKey + 'g'));
  const gauss = () => { let u = 0, v = 0; while (!u) u = g(); while (!v) v = g(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  let p = 1, seq = [];
  for (let i = 0; i < n; i++) { p *= Math.exp(drift + gauss() * sigma); seq.push(p); }
  const k = anchor / seq[n - 1];
  seq = seq.map(x => x * k);

  const step = tf.m * 60000;
  const bars = [];
  let prev = seq[0] * (1 - sigma * 0.2);
  for (let i = 0; i < n; i++) {
    const c = seq[i], o = prev;
    const w = Math.abs(c - o) + c * sigma * (0.25 + rnd() * 0.6);
    bars.push({
      t: now() - (n - 1 - i) * step,
      o, c, h: Math.max(o, c) + w * rnd() * 0.6, l: Math.min(o, c) - w * rnd() * 0.6,
      v: (0.55 + rnd() * 0.9) * (1 + Math.abs(c / o - 1) * 24),
    });
    prev = c;
  }
  return { bars, real: false, src: '合成' };
}

/* K 线加载：只接受交易所真实返回。
 * 取不到就抛错，由上层把「取数失败 + 原因」显示出来并自动重试 —— 绝不用合成序列顶替。
 * 唯一保留旧数据的情形：已经拉到过真实 K 线、只是这一次刷新没成功。
 * 这时沿用上一次的真实历史（那本来就是真实市场数据），但打上 stale 标记，
 * 界面显著提示「已停止更新 3 分 12 秒」，用户一眼能看出这不是当前行情。 */
async function loadKlines(symId, tfKey) {
  S.klines[symId] = S.klines[symId] || {};
  const cached = S.klines[symId][tfKey];
  let data;
  try {
    data = await fetchReal(symId, tfKey);
    S.kErr[symId + '|' + tfKey] = '';
  } catch (e) {
    S.kErr[symId + '|' + tfKey] = String(e.message || e);
    if (cached && cached.real && cached.bars.length) {
      cached.stale = true;
      cached.staleSince = cached.staleSince || now();
      return cached;
    }
    throw e;
  }

  // 历史首次加载后固定，后续仅更新最后一根，避免整图跳动
  if (cached && cached.bars.length && cached.real === data.real) {
    const last = data.bars[data.bars.length - 1];
    if (last) {
      const b = cached.bars[cached.bars.length - 1];
      b.c = last.c; b.h = Math.max(b.h, last.c); b.l = Math.min(b.l, last.c);
    }
    cached.src = data.src;
    cached.stale = false; cached.staleSince = 0;
    return cached;
  }
  data.stale = false; data.staleSince = 0;
  S.klines[symId][tfKey] = data;
  return data;
}

/* ============================ 指标 ============================ */
const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
function ema(a, n) {
  const k = 2 / (n + 1), out = []; let prev = null;
  for (const v of a) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}
function rsi(closes, n = 14) {
  const out = Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= n) { d > 0 ? g += d : l -= d; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function macd(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  return { dif, dea, hist: dif.map((v, i) => (v - dea[i]) * 2) };
}
function boll(closes, n = 20, k = 2) {
  const m = sma(closes, n), up = [], dn = [], wd = [];
  for (let i = 0; i < closes.length; i++) {
    if (m[i] == null) { up.push(null); dn.push(null); wd.push(null); continue; }
    const sl = closes.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(sl.reduce((a, x) => a + (x - m[i]) ** 2, 0) / n);
    up.push(m[i] + k * sd); dn.push(m[i] - k * sd); wd.push((2 * k * sd) / m[i] * 100);
  }
  return { mid: m, up, dn, wd };
}
/* ATR（Wilder 平滑）。
 * 坑：递推的是「n 项之和」s，输出才是 s/n。原写法 s=(s*(n-1)+tr)/n 少了 tr 该乘的 n，
 *     稳态时解出 s=tr → ATR=tr/n，把 ATR 整整低估 n 倍（实测 14 倍）。
 *     后果是止损位窄到离谱、建议仓位被顶到 60% 上限。 */
function atr(bars, n = 14) {
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  const out = []; let s = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < n) { s += tr[i]; out.push(i === n - 1 ? s / n : null); }
    else { s = s - s / n + tr[i]; out.push(s / n); }
  }
  return out;
}

/* ============================ 结构 · 量能 · 波动（做市商视角四件套） ============================ */
/* 说明：这四个因子与清算热力图共同决定方向。清算图只回答「流动性堆在哪」，
 * 结构回答「市场现在处在什么形态」，MACD 回答「动能往哪边走」，OBV 回答「量能认不认」，
 * BOLL 回答「波动是压缩还是扩张」。少任何一个都容易把「扫流动性」误判成「趋势启动」。 */

function obv(bars) {
  if (!bars.length) return [];                 // 空 K 线不该凭空产出第一个 0 点
  const o = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    o.push(o[i - 1] + (d > 0 ? bars[i].v : d < 0 ? -bars[i].v : 0));
  }
  return o;
}
function idxExt(bars, s, e, key, wantHigh) {
  let k = s;
  for (let i = s + 1; i < e; i++) {
    if (wantHigh ? bars[i][key] > bars[k][key] : bars[i][key] < bars[k][key]) k = i;
  }
  return k;
}

/* OBV 特征：累积量的绝对值没有意义，只取「相对自身波动的斜率」与「对均线的偏离」；
 * 再叠加顶/底背离（价格新高新低而量能不跟随 = 拉抬/砸盘缺乏承接）。 */
function obvFeat(bars) {
  const n = bars.length, i = n - 1;
  const o = obv(bars), m = sma(o, 30);
  if (i < 6) return { s: 0, slope: 0, above: 0, bear: false, bull: false, line: o, ma: m };
  const w = o.slice(Math.max(0, i - 59), i + 1);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length) || 1;
  const slope = (o[i] - o[Math.max(0, i - 10)]) / sd;
  const above = m[i] != null ? (o[i] - m[i]) / sd : 0;

  let bear = false, bull = false;
  // look 必须够长：三段式背离（涨 / 回撤 / 再创新高）的第一个高点天然落在 n 的 1/3 处，
  // 取 0.6n 会把窗口外的前一个高点漏掉，导致形态再标准也判不出来。
  const look = Math.min(120, Math.max(12, Math.floor(n * 0.85)));
  if (n > 25) {
    const seg = Math.max(4, Math.floor(look / 3));
    const a1 = n - look, a2 = Math.min(n, n - look + seg * 2), b1 = Math.max(a2, n - seg);
    if (a2 > a1 && b1 < n) {
      const hiA = idxExt(bars, a1, a2, 'h', true), hiB = idxExt(bars, b1, n, 'h', true);
      const loA = idxExt(bars, a1, a2, 'l', false), loB = idxExt(bars, b1, n, 'l', false);
      bear = bars[hiB].h > bars[hiA].h && o[hiB] < o[hiA];   // 价创新高，量能不跟 → 顶背离
      bull = bars[loB].l < bars[loA].l && o[loB] > o[loA];   // 价创新低，量能不跟 → 底背离
    }
  }
  let s = Math.tanh(slope * 0.8) * 0.62 + Math.tanh(above * 0.9) * 0.38;
  if (bear) s -= 0.5;                     // 确认背离要压得住「OBV 仍在走高」的表面读数
  if (bull) s += 0.5;
  return { s: clamp(s, -1, 1), slope, above, bear, bull, line: o, ma: m };
}

/* ZigZag 摆动点：先用 3 根分形（左右各 3 根的最高/最低）找候选，再用幅度阈值确认反向。
 * 纯幅度法对阈值极敏感：取 1~1.5 倍 ATR 时实测 150 根 K 线能出 149 个「摆动点」，结构完全失真。 */
function zigzag(bars, pct) {
  const n = bars.length, k = 3;
  if (n < k * 2 + 3) return [];
  const raw = [];
  for (let i = k; i < n - k; i++) {
    let isH = true, isL = true;
    // 左侧严格、右侧非严格：价格常见「等高 / 等低」并列，两侧都严格会把所有候选都判死。
    // 右侧取非严格 → 并列时归属最右边那根（更贴近当下）。
    for (let j = i - k; j <= i + k && (isH || isL); j++) {
      if (j === i) continue;
      if (j < i) {
        if (bars[j].h > bars[i].h) isH = false;
        if (bars[j].l < bars[i].l) isL = false;
      } else {
        if (bars[j].h >= bars[i].h) isH = false;
        if (bars[j].l <= bars[i].l) isL = false;
      }
    }
    if (isH) raw.push({ i, p: bars[i].h, t: 'H' });
    else if (isL) raw.push({ i, p: bars[i].l, t: 'L' });
  }
  const out = [];
  let pend = null;
  for (const p of raw) {
    const last = out.length ? out[out.length - 1] : null;
    if (!last) { out.push(p); continue; }
    if (last.t === p.t) {                                   // 同向 → 更新极值
      if (last.t === 'H' ? p.p > last.p : p.p < last.p) out[out.length - 1] = p;
      continue;
    }
    if (!pend || (last.t === 'H' ? p.p < pend.p : p.p > pend.p)) pend = p;   // 反向 → 追更极端
    if (Math.abs(pend.p - last.p) / last.p >= pct) { out.push(pend); pend = null; }
  }
  return out;
}

/* K 线结构：HH/HL = 上升；LH/LL = 下降；上破最近摆动高点 = BOS 转多；下破最近摆动低点 = BOS 转空；
 * 结构反向突破 = CHoCH（趋势可能切换，是做市商最爱用来「扫流动性」的位置）。 */
function structFeat(bars) {
  const n = bars.length, i = n - 1;
  const c = bars.map(b => b.c), px = c[i];
  if (n < 12) return { s: 0, trend: 'range', bos: null, choch: null, pts: [], swingHi: null, swingLo: null, lastH: null, lastL: null, atr: 0 };
  const A = atr(bars), a = A[i] > 0 ? A[i] : px * 0.004;
  // 分形已滤掉单根噪声，阈值只需过滤小幅震荡
  const pct = clamp(a / px * 1.5, 0.004, 0.05);
  const pts = zigzag(bars, pct);
  const hs = pts.filter(p => p.t === 'H'), ls = pts.filter(p => p.t === 'L');
  const lastH = hs.length ? hs[hs.length - 1] : null;
  const lastL = ls.length ? ls[ls.length - 1] : null;
  /* HH/HL/LH/LL 必须「显著」才算数：直接用大小比较会把浮点噪声当成突破。
   * 实测一条纯横盘序列的高点 30188 → 30192（差 0.013%）也会被判成 HH，进而读出上升趋势。
   * 容差取最近一段摆动幅度的 1/4（摆动幅度大则容差大），并用 ATR 兜底。 */
  const span = hs.length && ls.length ? Math.abs(lastH.p - lastL.p) : 0;
  const tol = Math.max(span * 0.25, a * 0.6);
  const HH = hs.length >= 2 && hs[hs.length - 1].p - hs[hs.length - 2].p > tol;
  const LH = hs.length >= 2 && hs[hs.length - 2].p - hs[hs.length - 1].p > tol;
  const HL = ls.length >= 2 && ls[ls.length - 1].p - ls[ls.length - 2].p > tol;
  const LL = ls.length >= 2 && ls[ls.length - 2].p - ls[ls.length - 1].p > tol;

  let trend = 'range';
  if (HH && HL) trend = 'up';
  else if (LH && LL) trend = 'down';
  else if (HH && LL) trend = 'expand';
  else if (LH && HL) trend = 'contract';

  let bos = null;
  if (lastH && px > lastH.p) bos = 'up';
  if (lastL && px < lastL.p) bos = 'down';
  let choch = null;
  if (trend === 'down' && bos === 'up') choch = 'bull';
  if (trend === 'up' && bos === 'down') choch = 'bear';

  let s = trend === 'up' ? 0.55 : trend === 'down' ? -0.55 : 0;
  if (bos === 'up') s += 0.3; else if (bos === 'down') s -= 0.3;
  if (choch === 'bull') s += 0.25; else if (choch === 'bear') s -= 0.25;
  const swingHi = hs.length ? Math.max.apply(null, hs.map(p => p.p)) : null;
  const swingLo = ls.length ? Math.min.apply(null, ls.map(p => p.p)) : null;
  // 连续项：价格在摆动区间中的位置，避免只有离散档位导致分数跳变
  if (swingHi != null && swingLo != null && swingHi > swingLo) s += ((px - swingLo) / (swingHi - swingLo) - 0.5) * 0.5;

  /* 摆动点不足时退回线性回归斜率。
   * 单边不回撤的连续阳线 / 阴线没有分形（最高价单调、最低价单调，一个摆动点都找不到），
   * 直接返回 0 会让「最强的一段趋势」在模型里完全没有声音 —— 没有结构不等于没有方向。 */
  if (hs.length < 2 || ls.length < 2) {
    const w = Math.min(n, 24);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = 0; j < w; j++) { const y = c[n - w + j]; sx += j; sy += y; sxx += j * j; sxy += j * y; }
    const den = w * sxx - sx * sx;
    const sl = den ? (w * sxy - sx * sy) / den : 0;        // 每根 K 线的平均价格变化
    const t = clamp(Math.tanh((sl * w) / (a * 2.5)), -1, 1); // 窗口总位移 / ATR
    trend = t > 0.2 ? 'up' : t < -0.2 ? 'down' : 'range';
    s = t * 0.6;
    if (trend === 'range') s = t * 0.35;
  }

  return { s: clamp(s, -1, 1), trend, bos, choch, pts: pts.slice(-6), hs, ls, lastH, lastL, swingHi, swingLo, atr: a };
}

/* BOLL：%B 位置在「带宽越宽」时趋势意义越强；带宽挤压时方向未定，主动压低权重 */
function bollFeat(bars) {
  const c = bars.map(b => b.c), i = c.length - 1;
  const B = boll(c, 20, 2);
  const mid = B.mid[i], up = B.up[i], dn = B.dn[i], wd = B.wd[i];
  if (mid == null || !(up > dn)) return { s: 0, pb: 0.5, wd: null, rank: 0.5, squeeze: false, B };
  const pb = clamp((c[i] - dn) / (up - dn), 0, 1);
  const ws = B.wd.slice(Math.max(0, i - 119), i + 1).filter(v => v != null).sort((x, y) => x - y);
  const rank = ws.length > 1 ? clamp(ws.filter(v => v <= wd).length / ws.length, 0, 1) : 0.5;
  // 挤压必须「分位低」且「绝对宽度也确实窄」：只判分位会把波动率的缓慢下行误判成挤压
  //（实测 200 根稳定上行序列带宽从 9.1 缓慢降到 6.3，分位只有 0.075，但那根本不是盘整）。
  const med = ws.length ? ws[Math.floor(ws.length / 2)] : wd;
  const squeeze = rank < 0.22 && wd < med * 0.75;
  let s = (pb - 0.5) * 2 * (0.45 + 0.55 * rank);
  if (squeeze) s *= 0.45;
  return { s: clamp(s, -1, 1), pb, wd, rank, squeeze, mid, up, dn, B };
}

/* MACD：柱 / DIF / DEA 统一按「价格的百分比」归一 —— 跨品种可比，且不会被单根噪声翻转。
 * 只取 hist（旧写法按 ATR 归一）会出问题：150 根稳定下行序列在末段一次噪声金叉就能给出 +0.32，
 * 因为此时 hist 只有 22 而 DIF/DEA 在 -373/-384，hist 被 ATR 尺度放大成了主导项。
 * 故把慢变量「DIF/DEA 的零轴位置」也纳入，并把归一尺度换成价格百分比。 */
function macdFeat(bars) {
  const c = bars.map(b => b.c), i = c.length - 1;
  const M = macd(c), A = atr(bars);
  const a = A[i] > 0 ? A[i] : c[i] * 0.004;
  const h = M.hist[i], dif = M.dif[i], dea = M.dea[i];
  if (!isFinite(h) || !isFinite(dif) || !isFinite(dea)) return { s: 0, hist: 0, dif: 0, dea: 0, cross: 0, above0: 0, lvl: 0, M };
  let cross = 0;
  for (let k = Math.max(1, i - 4); k <= i; k++) {
    if (M.dif[k - 1] <= M.dea[k - 1] && M.dif[k] > M.dea[k]) cross = 1;
    if (M.dif[k - 1] >= M.dea[k - 1] && M.dif[k] < M.dea[k]) cross = -1;
  }
  const above0 = dif > 0 && dea > 0 ? 1 : dif < 0 && dea < 0 ? -1 : 0;
  const sc = Math.max(c[i] * 0.01, a * 0.6);            // 归一尺度：价格 1%，极低波动时退回 ATR
  const hn = Math.tanh(h / sc);
  const dn = Math.tanh(dif / sc), en = Math.tanh(dea / sc);
  const lvl = (dn + en) / 2;                            // 零轴位置（慢变量）
  const slope = isFinite(M.hist[i - 2]) ? Math.tanh((h - M.hist[i - 2]) / sc) : 0;
  const s = clamp(hn * 0.34 + slope * 0.14 + cross * 0.2 + lvl * 0.32, -1, 1);
  return { s, hist: h, dif, dea, cross, above0, lvl, M };
}

/* KDJ（9,3,3）：RSV 取 n 根内收盘价在最高/最低区间中的位置，再做两次 1/3 平滑得 K、D。
 * 初值按惯例取 50。注意平滑系数是 1/m（K = 2/3·K' + 1/3·RSV），不是 EMA 的 2/(n+1)。 */
function kdj(bars, n = 9, m1 = 3, m2 = 3) {
  const K = [], D = [], J = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i >= n - 1) {
      let hh = -Infinity, ll = Infinity;
      for (let t = i - n + 1; t <= i; t++) { if (bars[t].h > hh) hh = bars[t].h; if (bars[t].l < ll) ll = bars[t].l; }
      const rsv = hh > ll ? (bars[i].c - ll) / (hh - ll) * 100 : 50;
      k = (k * (m1 - 1) + rsv) / m1;
      d = (d * (m2 - 1) + k) / m2;
    }
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return { K, D, J };
}

/* KDJ 因子：位置 + 交叉 + 极端修正。
 * 关键取舍：KDJ 是摆动指标，单边趋势里会长期钝化在超买/超卖区，
 * 所以「位置项」权重给到 0.46 而不是只看金叉死叉 —— 钝化本身也是趋势强的一种体现。
 * 但 J 值突破 100 / 跌破 0 是实打实的透支信号，此时对顺势方向反向扣分。 */
function kdjFeat(bars) {
  const i = bars.length - 1;
  const K = kdj(bars);
  const k = K.K[i], d = K.D[i], j = K.J[i];
  if (!isFinite(k) || !isFinite(d) || !isFinite(j))
    return { s: 0, k: 50, d: 50, j: 50, cross: 0, zone: 'mid', K };
  let cross = 0;
  for (let t = Math.max(1, i - 4); t <= i; t++) {
    if (K.K[t - 1] <= K.D[t - 1] && K.K[t] > K.D[t]) cross = 1;
    if (K.K[t - 1] >= K.D[t - 1] && K.K[t] < K.D[t]) cross = -1;
  }
  const pos = clamp((k - 50) / 40, -1, 1);           // ±40 点饱和，避免钝化区数值爆炸
  const zone = k >= 80 ? 'over' : k <= 20 ? 'under' : (k > 50 ? 'upper' : 'lower');

  /* 交叉项：与位置项同向时全额计入，反向时只算 55%。
   * 原因：单边市里 KDJ 长期钝化在极端区并反复出现反向交叉 —— 一路暴跌时 K 值贴在 0 附近，
   * 随便一根小反弹就金叉。若不打折，「最强的一段下跌」里 KDJ 会持续给出看多信号，
   * 与其他四个趋势口径的因子长期背离。 */
  const cw = (cross * pos >= 0) ? 0.34 : 0.34 * 0.55;
  const core = pos * 0.46 + cross * cw;
  let s = core;

  // 低位金叉 / 高位死叉是有效确认，但 K<20 / K>80 属于钝化区，那里的交叉基本是噪音，不加分
  if (cross === 1 && k > 20 && k < 35) s += 0.12;
  if (cross === -1 && k < 80 && k > 65) s -= 0.12;

  /* J 突破 100 / 跌破 0 = 动能透支。处理方式是「削弱当前方向的强度」而不是「反向给分」 ——
   * 透支只意味着这段趋势走不远，不意味着它现在就掉头。 */
  if (j > 100 || j < 0) s *= 0.72;

  // 超买区金叉 / 超卖区死叉可信度打折
  if (k >= 80 && cross === 1) s *= 0.8;
  if (k <= 20 && cross === -1) s *= 0.8;

  // 兜底：上述修正不允许把「位置 + 交叉」的核心结论翻号
  if (core !== 0 && s * core < 0) s = core * 0.5;

  return { s: clamp(s, -1, 1), k, d, j, cross, zone, K };
}

/* ============================ 多因子方向融合 ============================ */
/* 技术面五个因子共同决定方向：K 线结构 / MACD / OBV / BOLL / KDJ，权重合计 78。
 * 清算（liq:34）不进这个加权和 —— 它只做乘性修正，见下方 base 计算处。
 * 目的就是让「一张热力图单独定方向」在结构上不可能成立。 */
const FUSE_W = { liq: 34, st: 22, macd: 16, obv: 14, boll: 14, kdj: 12 };

function fuseSignal(symId, tfKey, bars) {
  const st = structFeat(bars), mc = macdFeat(bars), ob = obvFeat(bars), bl = bollFeat(bars), kd = kdjFeat(bars);
  const heat = (S.heats[symId] || {})[tfKey] || null;
  const q = S.quotes[symId] || {};
  let L = null;
  if (heat) L = liqSignal(bars, heat, {
    funding: q.funding, ls: heat.lsInfo ? heat.lsInfo.ls : null, dp: SYMS[symId].dp,
  });

  /* 技术五因子决定方向。注意分母只取这五项之和 —— 若把清算因子并进同一个加权平均，
   * 清算数据一出现就把分母从 78 撑到 112，等于把每个技术因子都稀释掉 30%，
   * 「加了张热力图，技术面凭空变弱」是不合理的。 */
  const f = [];
  // 注意：isFinite(null) === true，必须显式排除 null，否则缺失因子会被当作 0 分计入分母、稀释其余因子
  const push = (k, w, v, name) => { if (v != null && isFinite(v)) f.push({ k, w, s: clamp(v, -1, 1), name }); };
  push('st', FUSE_W.st, st.s, '结构');
  push('macd', FUSE_W.macd, mc.s, 'MACD');
  push('obv', FUSE_W.obv, ob.s, 'OBV');
  push('boll', FUSE_W.boll, bl.s, 'BOLL');
  push('kdj', FUSE_W.kdj, kd.s, 'KDJ');

  const tw = f.reduce((a, x) => a + x.w, 0) || 1;
  const contrib = f.map(x => ({ k: x.k, name: x.name, s: x.s, w: x.w, c: x.w * x.s / tw * 100 }));
  const base = contrib.reduce((a, x) => a + x.c, 0);          // 技术面基准分 [-100,100]
  const techS = clamp(base / 100, -1, 1);

  /* 清算流动性只做「路径修正」，不参与定方向：
   * 与技术面同向 → 放大至多 32%；反向 → 削弱至多 32%。
   * 这是乘性修正，永远改不了 base 的符号 —— 所以「一张清算热力图定方向」在结构上不可能。 */
  const liqS = L ? clamp(L.score / 100, -1, 1) : null;
  let liqAdj = 0;
  if (liqS != null) liqAdj = (liqS * techS >= 0 ? 1 : -1) * 0.32 * Math.abs(liqS);
  const raw = clamp(base * (1 + liqAdj), -100, 100);
  if (liqS != null) contrib.push({
    k: 'liq', name: '清算流动性', s: liqS, w: FUSE_W.liq,
    c: base * liqAdj, mod: true,
  });

  // 一致性：只有明确表态（|s|>0.15）的因子参与，避免一堆 0 把置信度刷高
  const act = (liqS != null ? f.concat([{ s: liqS }]) : f).filter(x => Math.abs(x.s) > 0.15);
  const conf = act.length ? act.filter(x => (x.s > 0) === (raw > 0)).length / act.length : 0;
  let sc = clamp(raw * (0.62 + 0.38 * conf), -100, 100);
  let dir = sc > 15 ? 'long' : sc < -15 ? 'short' : 'wait';
  let weak = false;
  if (act.length < 2 && dir !== 'wait') { dir = 'wait'; weak = true; }

  const wd = (v, n) => (v > 0.15 ? '偏多' : v < -0.15 ? '偏空' : '中性') + `(${fmt(v * 100, 0)})`;
  const reasons = [
    `技术面基准 ${Math.round(base)}（一致度 ${Math.round(conf * 100)}%）· ` +
      contrib.filter(x => x.k !== 'liq').map(x => `${x.name} ${wd(x.s)}`).join(' · ') +
      (liqS != null
        ? `；清算流动性 ${wd(liqS)}${liqAdj < 0 ? '（与技术面反向，合成分下调 ' : '（与技术面同向，合成分上调 '}${Math.abs(liqAdj * 100).toFixed(0)}%）`
        : '；无清算数据，方向完全由技术面给出'),
    ...(L ? L.reasons : []),
  ];
  return {
    dir, score: sc, strength: Math.abs(sc), raw, conf, weak, base, techS, liqS, liqAdj,
    liq: L, heat, st, mc, ob, bl, kd, contrib, factors: f, reasons,
    px: bars[bars.length - 1].c,
    hasHeat: !!heat, grade: heat ? heat.grade : 'none', src: heat ? heat.label : '无清算数据',
  };
}

/* ============================ 做市商视角结论 ============================ */
/* 做市商/主力的核心约束：大单需要对手盘。清算带是全市场最密集的被动挂单池，
 * 所以「流动性在哪，价格就倾向于被推到哪」。但他们不会硬顶着结构推 ——
 * 结构反向时会先做一次「扫单（liquidity sweep / Judas）」拿够流动性再掉头。
 * 因此结论分三种：
 *   follow  = 流动性与结构同向 → 顺势；
 *   sweep   = 流动性在一侧、结构动能在另一侧 → 大概率先扫流动性再反转，逆势单要等收回；
 *   stand   = 挤压 / 因子互相矛盾 → 观望。                                                  */
function mmView(symId, tfKey, bars, F0) {
  const F = F0 || fuseSignal(symId, tfKey, bars);
  const { liq: L, st, mc, ob, bl, kd } = F;
  const px = F.px, dp = SYMS[symId].dp;
  const a = st.atr || (L && L.atr) || px * 0.004;

  // 流动性天平：清算带强度 / 距离，越大越「近而厚」
  const pullUp = L && L.magUp ? L.magUp.v / (0.35 + L.magUp.d) : 0;
  const pullDn = L && L.magDn ? L.magDn.v / (0.35 + L.magDn.d) : 0;
  const liqSide = !L ? null : pullUp > pullDn * 1.12 ? 'up' : pullDn > pullUp * 1.12 ? 'down' : 'even';

  // 技术侧方向：结构 / 动能 / 量能（MACD、KDJ 同为动能口径；不含 BOLL —— 它是波动率口径，
  // 也不含清算，避免把流动性重复计一次）。分母由权重表算出，加因子时不用改死数字。
  const techW = FUSE_W.st + FUSE_W.macd + FUSE_W.obv + FUSE_W.kdj;
  const tech = clamp((st.s * FUSE_W.st + mc.s * FUSE_W.macd + ob.s * FUSE_W.obv + kd.s * FUSE_W.kdj) / techW, -1, 1);
  const techSide = tech > 0.12 ? 'up' : tech < -0.12 ? 'down' : 'flat';

  let mode = 'stand';
  if (liqSide && liqSide !== 'even' && techSide !== 'flat') {
    mode = (liqSide === techSide) ? 'follow' : 'sweep';
  } else if (liqSide && liqSide !== 'even') {
    mode = Math.abs(tech) < 0.08 ? 'follow' : 'sweep';
  } else if (techSide !== 'flat') {
    mode = 'follow';
  }
  if (bl.squeeze && Math.abs(F.score) < 22) mode = 'stand';

  // 做市商最终偏向：扫单情形下，方向取「扫完之后要去的方向」= 技术侧，而不是清算侧
  let bias = F.dir;
  if (mode === 'sweep') bias = tech > 0 ? 'long' : 'short';
  else if (mode === 'follow') bias = F.score > 8 ? 'long' : F.score < -8 ? 'short' : 'wait';
  else bias = 'wait';

  /* ---- 价格带区间：把「哪个价」精确到「哪一段价」 ----
   * 做市商扫的不是一根针，是一整片止损。上面算出的 sweep.p 只是带中心，
   * 真正要挂单、要防假突破都必须知道 lo/hi，否则「差 0.2% 没扫到」无法判断。 */
  const Z = F.heat ? liqZones(F.heat, px, a) : [];
  /* 跨越现价的带不构成「磁吸目标」—— 价格已经在带里面了，那不是要去的地方。
   * 上方带按由近及远排，下方带同样由近及远（mid 降序）。 */
  const zUp = Z.filter(z => z.lo > px).sort((x, y) => x.mid - y.mid).slice(0, 2);
  const zDn = Z.filter(z => z.hi < px).sort((x, y) => y.mid - x.mid).slice(0, 2);
  /* 价格已经贴着的那条带不能当目标 / 失效位。近价兜底会补出紧贴现价的带，
   * 直接用最近的一条会出现「失效区间和挂单区间重叠」—— 回踩挂单和逻辑失效成了同一件事。
   * 目标带：整条带必须在现价 0.5 ATR 之外；
   * 失效带：必须整体位于挂单区的远端之外（做多时 hi < px-0.9ATR，做空时 lo > px+0.9ATR）。 */
  const edgeGap = z => (z.lo > px ? z.lo - px : px - z.hi);
  const pickTarget = arr => arr.find(z => edgeGap(z) >= a * 0.5) || arr[0] || null;
  const pickFail = arr => arr.find(z => (bias === 'long' ? z.hi < px - a * 0.9 : z.lo > px + a * 0.9))
    || arr[arr.length - 1] || null;
  const zoneOf = m => {                       // 把 magUp/magDn 单点匹配回带
    if (!m || !Z.length) return null;
    let best = null;
    for (const z of Z) { const dd = Math.abs(z.mid - m.p); if (!best || dd < best.d) best = { z, d: dd }; }
    return best && best.d <= Math.max(zSpan(best.z), a) ? best.z : null;
  };
  function zSpan(z) { return (z.hi - z.lo) * 0.75; }

  // 扫单目标位：与最终偏向相反那一侧的清算带（先扫掉它）
  let sweep = null;
  if (mode === 'sweep') {
    const wantUp = bias === 'short';            // 最终做空 → 先向上扫空单止损
    const m = wantUp ? (L && L.magUp) : (L && L.magDn);
    const z = zoneOf(m) || (wantUp ? zUp[0] : zDn[0]) || null;
    const ref = z || m;
    if (ref) {
      const p = z ? z.mid : m.p;
      const dist = Math.abs(p / px - 1) * 100;
      // 越近、越强、技术面越坚决 → 扫单概率越高
      const v = z ? Math.max(z.v, z.mass) : m.v;
      const prob = clamp(0.32 + v * 0.34 + (1 - clamp(dist / 3, 0, 1)) * 0.2 + Math.abs(tech) * 0.16, 0.3, 0.92);
      sweep = {
        side: wantUp ? 'up' : 'down', p, v, dpct: dist, prob,
        lo: z ? z.lo : p - a * 0.25, hi: z ? z.hi : p + a * 0.25,
        atrW: z ? z.atrW : 0.5, mass: z ? z.mass : v, zone: z,
      };
    }
  }

  /* 三个操作价格带（做市商视角的核心输出）：
   *   sweepBand   先被扫掉的那一侧（只有 sweep 模式有）
   *   targetBand  顺着最终偏向，价格要去的下一个流动性区
   *   failBand    反方向的带被击穿 = 这套逻辑失效
   *   entryBand   现在可以挂单的区间（现价顺方向一侧的 0.35~0.9 ATR） */
  const mkBand = (kind, z, why) => z ? {
    kind, lo: z.lo, hi: z.hi, mid: z.mid, v: z.v, mass: z.mass,
    atrW: z.atrW, dpct: z.dpct, side: z.side, why,
  } : null;
  const mkRaw = (kind, lo, hi, side, why, extra) => Object.assign({
    kind, lo: Math.min(lo, hi), hi: Math.max(lo, hi), mid: (lo + hi) / 2,
    side, why, v: 0, mass: 0, dpct: (((lo + hi) / 2) / px - 1) * 100,
    atrW: a > 0 ? Math.abs(hi - lo) / a : 0,
  }, extra || {});
  let targetBand = null, failBand = null, entryBand = null;
  if (bias === 'long') {
    targetBand = mkBand('target', pickTarget(zUp), '上方空单止损带被吃穿后的延续目标');
    failBand = mkBand('fail', pickFail(zDn), '下方多单清算带被击穿，多头结构失效');
    entryBand = mkRaw('entry', px - a * 0.9, px - a * 0.15, 'down', '回踩不破的挂单区');
  } else if (bias === 'short') {
    targetBand = mkBand('target', pickTarget(zDn), '下方多单止损带被吃穿后的延续目标');
    failBand = mkBand('fail', pickFail(zUp), '上方空单清算带被击穿，空头结构失效');
    entryBand = mkRaw('entry', px + a * 0.15, px + a * 0.9, 'up', '反抽不过的挂单区');
  }

  /* 扫单模式下 sweep 带和 fail 带常常是同一条（先向下扫 = 跌破下方带即失效）。
   * 二者必须区分开：扫到带内是剧本的一部分，只有「穿出带的远端且不收回」才算失效。 */
  if (sweep && failBand && Math.abs(failBand.mid - sweep.p) < Math.max(1e-9, a * 0.01)) {
    const ext = Math.max(a * 0.5, (sweep.hi - sweep.lo) * 0.15);
    failBand = sweep.side === 'down'
      ? mkRaw('fail', sweep.lo - ext, sweep.lo, 'down', `扫到 ${fmt(sweep.lo, dp)} 是剧本内；跌穿 ${fmt(sweep.lo - ext, dp)} 不收回才失效`, { v: sweep.v, mass: sweep.mass })
      : mkRaw('fail', sweep.hi, sweep.hi + ext, 'up', `扫到 ${fmt(sweep.hi, dp)} 是剧本内；涨穿 ${fmt(sweep.hi + ext, dp)} 不收回才失效`, { v: sweep.v, mass: sweep.mass });
  }
  /* bands 里每条都统一成带符号的 dpct（相对现价）。
   * 注意不能直接 Object.assign(..., sweep) —— 它自带的 dpct 是距离绝对值（无符号），
   * 会把下面算好的带符号值覆盖掉，导致「下方带」显示成 +0.98%。 */
  const sgn = p => (p / px - 1) * 100;
  const bands = [
    sweep ? {
      kind: 'sweep', lo: sweep.lo, hi: sweep.hi, mid: sweep.p, v: sweep.v, mass: sweep.mass,
      atrW: sweep.atrW, dpct: sgn(sweep.p), side: sweep.side, prob: sweep.prob,
      why: `先扫${sweep.side === 'up' ? '上方空单' : '下方多单'}止损拿对手盘，再掉头${bias === 'long' ? '做多' : '做空'}（概率 ${Math.round(sweep.prob * 100)}%）`,
    } : null,
    targetBand, failBand, entryBand,
  ].filter(Boolean);

  // 陷阱提示：价格贴近某侧清算带 + OBV 背离 → 大概率假突破
  let trap = null;
  if (L && L.magUp && Math.abs(L.magUp.p / px - 1) * 100 < 0.6 && ob.bear) trap = { side: 'up', why: '价格贴近上方空单清算带，但 OBV 顶背离，上破缺乏量能承接' };
  if (L && L.magDn && Math.abs(L.magDn.p / px - 1) * 100 < 0.6 && ob.bull) trap = { side: 'down', why: '价格贴近下方多单清算带，但 OBV 底背离，下破缺乏量能承接' };

  const rs = [];
  const zTxt = z => `${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}（强度 ${Math.round(z.v * 100)}%，宽 ${fmt(z.atrW, 1)} ATR，${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%）`;
  rs.push(L
    ? `流动性：上方 ${fmt(L.upPct, 1)}% 空单清算 / 下方 ${fmt(L.dnPct, 1)}% 多单清算`
      + (zUp[0] ? `；上方清算带 ${zTxt(zUp[0])}` : '')
      + (zDn[0] ? `；下方清算带 ${zTxt(zDn[0])}` : '')
    : '流动性：本周期无清算数据，方向由结构 / 动能 / 量能决定');
  rs.push(`结构：${st.trend === 'up' ? 'HH/HL 上升' : st.trend === 'down' ? 'LH/LL 下降' : st.trend === 'expand' ? '高低点扩张（无序）' : st.trend === 'contract' ? '高低点收敛（蓄势）' : '区间震荡'}${st.bos ? ` · 已${st.bos === 'up' ? '上破' : '下破'}最近摆动${st.bos === 'up' ? '高' : '低'}点` : ''}${st.choch ? ` · CHoCH 转${st.choch === 'bull' ? '多' : '空'}` : ''}`);
  rs.push(`动能：MACD 柱 ${fmt(mc.hist, dp)}${mc.cross ? ` · ${mc.cross > 0 ? '近 5 根金叉' : '近 5 根死叉'}` : ''} · ${mc.above0 > 0 ? '零轴上方' : mc.above0 < 0 ? '零轴下方' : '零轴附近'}`);
  rs.push(`量能：OBV ${ob.slope >= 0 ? '走高' : '走低'}${ob.bear ? ' · 顶背离（拉抬无量）' : ''}${ob.bull ? ' · 底背离（抛压衰竭）' : ''}`);
  rs.push(`波动：BOLL %B ${fmt(bl.pb * 100, 0)}% · 带宽分位 ${Math.round(bl.rank * 100)}%${bl.squeeze ? '（挤压，方向未定）' : ''}`);

  return {
    mode, bias, sweep, trap, tech, liqSide, techSide,
    pullUp, pullDn, F, px, reasons: rs,
    zones: Z, zUp, zDn, bands,
    targetBand, failBand, entryBand, atr: a,
    conf: Math.round(F.conf * 100),
  };
}

// 打分模型：以趋势跟随为主，RSI/布林仅作修正与过热提示，避免两类逻辑互相抵消
function analyze(bars) {
  const c = bars.map(b => b.c);
  const i = c.length - 1;
  const R = rsi(c), M = macd(c), B = boll(c), A = atr(bars);
  const ma7 = sma(c, 7), ma25 = sma(c, 25), ma99 = sma(c, 99);
  const KD = kdj(bars);                       // 第五个技术面维度：KDJ(9,3,3)，供图表副图与图例读数
  const px = c[i], a = A[i] || px * 0.004;
  const atrPct = a / px * 100;

  let sc = 0;
  const Rv = R[i] ?? 50;

  // 1) 均线排列 ±25：趋势的主干
  const up25 = ma25[i] != null && px > ma25[i];
  const dn25 = ma25[i] != null && px < ma25[i];
  if (ma25[i] != null && ma99[i] != null) {
    if (px > ma25[i] && ma25[i] > ma99[i]) sc += 25;
    else if (px < ma25[i] && ma25[i] < ma99[i]) sc -= 25;
    else sc += up25 ? 10 : dn25 ? -10 : 0;
  }

  // 2) 动量 ±22：用 ATR 归一化，保证跨品种可比
  const mom = i >= 10 ? (px / c[i - 10] - 1) * 100 : 0;
  const norm = atrPct > 0 ? mom / (atrPct * Math.sqrt(10)) : 0;
  sc += clamp(norm * 7, -22, 22);

  // 3) MACD ±18
  const hv = M.hist[i], hp = M.hist[i - 1];
  if (hv != null && hp != null) {
    if (hv > 0 && hp <= 0) sc += 18;
    else if (hv < 0 && hp >= 0) sc -= 18;
    else sc += hv > 0 ? 7 : -7;
  }

  // 4) RSI 位置 ±15：延续方向给分，极端过热才反向修正
  sc += clamp((Rv - 50) / 50 * 15, -15, 15);
  if (Rv > 80) sc -= 6; else if (Rv < 20) sc += 6;

  // 5) 布林 ±10：仅在未获趋势确认时提示回归
  if (B.dn[i] != null && B.up[i] != null) {
    if (px < B.dn[i] && Rv < 45) sc += 10;
    else if (px > B.up[i] && Rv > 55) sc -= 10;
  }

  sc = clamp(sc, -100, 100);
  const dir = sc > 22 ? 'long' : sc < -22 ? 'short' : 'wait';
  const sgn = dir === 'short' ? -1 : 1;

  return {
    dir, score: sc, strength: Math.abs(sc), px, rsi: Rv, macdH: hv, atr: a, atrPct,
    bollW: B.wd[i], mom, ma7: ma7[i], ma25: ma25[i], ma99: ma99[i],
    entryLo: px - a * 0.25, entryHi: px + a * 0.25,
    sl: px - sgn * a * 1.6, tp: px + sgn * a * 3.2,
    posPct: clamp(1.0 / (1.6 * atrPct) * 10, 5, 60),
    ind: { rsi: R, macd: M, boll: B, atr: A, ma7, ma25, ma99, kdj: KD },
  };
}

// 重绘（含十字光标）时复用指标结果，避免每次 mousemove 重算
const _anCache = new Map();
function analyzeOf(sym, tf, bars) {
  const key = sym + '|' + tf + '|' + bars.length + '|' + bars[bars.length - 1].c;
  if (!_anCache.has(key)) _anCache.set(key, analyze(bars));
  return _anCache.get(key);
}

/* ============================ K 线绘制 ============================ */
const cv = $('#kline'), ctx = cv.getContext('2d');
let view = null;

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
/* 可视区间：默认贴住最右侧（最新），向左可拉到最早一根。count = 可见根数。 */
const KV_DEF = 130;
function kvRange(n) {
  const cnt = clamp(Math.round(S.kvCount || KV_DEF), 15, Math.max(15, n));
  const end = S.kvEnd == null ? n - 1 : clamp(Math.round(S.kvEnd), cnt - 1, n - 1);
  const i1 = clamp(end, cnt - 1, n - 1);
  const i0 = clamp(i1 - cnt + 1, 0, Math.max(0, n - cnt));
  return { i0, i1: clamp(i0 + cnt - 1, 0, n - 1), cnt };
}
function kvReset() { S.kvCount = KV_DEF; S.kvEnd = null; }

const CU = '#12a150', CD = '#e13b3b', TX = '#9a9aa0', LN = '#ececeb';   // 涨/多=绿，跌/空=红
const CB_BOLL = '#b7791f', CB_MACD = '#5b6ee1', CB_OBV = '#7d5bd1', CB_ST = '#8a8a90';
// KDJ 三条线：K 快线蓝、D 慢线橙、J 紫。J 用虚线以区别于 K/D 的实线，避免三条实线糊在一起。
const CB_KDJ_K = '#2f6fd0', CB_KDJ_D = '#e0891e', CB_KDJ_J = '#a855f7';

function draw() {
  const data = S.klines[S.sym]?.[S.tf];
  const W = cv.getBoundingClientRect().width, H = cv.getBoundingClientRect().height;
  ctx.clearRect(0, 0, W, H);
  if (!data || !data.bars.length) return;

  const bars = data.bars, n = bars.length;
  const PL = 8, PR = 62, PT = 10, PB = 18, gap = 8;
  const { i0, i1, cnt } = kvRange(n);

  // 面板高度：MACD / KDJ / 量能(成交量柱 + OBV 线叠加)，其余留给主图
  const mH = clamp(H * 0.135, 34, 58);
  const kdH = clamp(H * 0.115, 30, 52);
  const voH = clamp(H * 0.145, 38, 66);
  const cH = Math.max(70, H - PT - PB - mH - kdH - voH - gap * 3);
  const cW = W - PL - PR;
  const step = cW / Math.max(1, cnt);
  const bw = Math.max(1.1, Math.min(11, step * 0.68));

  let hi = -Infinity, lo = Infinity;
  for (let i = i0; i <= i1; i++) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
  const F = analyzeOf(S.sym, S.tf, bars);
  const BL = F.ind.boll;
  for (let i = i0; i <= i1; i++) {                       // 布林带也要进视野，否则上下轨会被裁掉
    if (BL.up[i] != null) hi = Math.max(hi, BL.up[i]);
    if (BL.dn[i] != null) lo = Math.min(lo, BL.dn[i]);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01; hi += pad; lo -= pad;
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) { hi = (lo || 1) * 1.01; lo = (lo || 1) * 0.99; }

  const X = i => PL + (i - i0 + 0.5) * step;
  const Y = p => PT + (hi - p) / (hi - lo) * cH;
  view = { X, Y, i0, i1, cnt, n, cH, cW, PL, PT, step, bars, hi, lo, mH, voH, gap, H };

  const s = SYMS[S.sym], dp = s.dp;
  const mTop = PT + cH + gap, mBot = mTop + mH;
  const kdTop = mBot + gap, kdBot = kdTop + kdH;
  const vTop = kdBot + gap, vBot = vTop + voH;
  ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  ctx.textBaseline = 'middle';

  /* ---------- 主图 ---------- */
  for (let g = 0; g <= 4; g++) {
    const p = lo + (hi - lo) * g / 4, y = Y(p);
    ctx.strokeStyle = LN; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, y + .5); ctx.lineTo(PL + cW, y + .5); ctx.stroke();
    ctx.fillStyle = TX; ctx.textAlign = 'left';
    ctx.fillText(fmt(p, dp), PL + cW + 6, y);
  }
  // BOLL 带（先画带再画线，避免线被填充盖住）
  ctx.beginPath();
  let bStarted = false;
  for (let i = i0; i <= i1; i++) { const v = BL.up[i]; if (v == null) continue; const x = X(i), y = Y(v); bStarted ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), bStarted = true); }
  for (let i = i1; i >= i0; i--) { const v = BL.dn[i]; if (v == null) continue; ctx.lineTo(X(i), Y(v)); }
  if (bStarted) { ctx.closePath(); ctx.fillStyle = 'rgba(183,121,31,.07)'; ctx.fill(); }
  [[BL.up, CB_BOLL], [BL.mid, '#c79a4e'], [BL.dn, CB_BOLL]].forEach(([arr, col]) => {
    ctx.strokeStyle = col; ctx.lineWidth = arr === BL.mid ? 1.1 : 1; ctx.beginPath();
    let st2 = false;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (v == null) continue; const x = X(i), y = Y(v); st2 ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st2 = true); }
    ctx.stroke();
  });
  // MA
  [[F.ind.ma7, '#e13b3b'], [F.ind.ma25, '#b7791f'], [F.ind.ma99, '#5b6ee1']].forEach(([arr, col]) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath();
    let st2 = false;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (v == null) continue; const x = X(i), y = Y(v); st2 ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st2 = true); }
    ctx.stroke();
  });
  // K 线结构：摆动点连线 + HH/HL/LH/LL 标注 + 关键摆动高低位
  const SF = structFeat(bars);
  if (SF.pts.length >= 2) {
    ctx.strokeStyle = CB_ST; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    SF.pts.forEach((p, k) => { const x = X(p.i), y = Y(p.p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '9px ui-monospace,Menlo,Consolas,monospace';
    for (let k = 1; k < SF.pts.length; k++) {
      const a = SF.pts[k - 1], b = SF.pts[k];
      if (a.t === b.t) continue;
      const tag = b.t === 'H' ? (b.p > a.p ? 'HH' : 'LH') : (b.p > a.p ? 'HL' : 'LL');
      ctx.fillStyle = (tag === 'HH' || tag === 'HL') ? CU : CD;
      ctx.textAlign = 'center'; ctx.textBaseline = b.t === 'H' ? 'bottom' : 'top';
      ctx.fillText(tag, X(b.i), Y(b.p) + (b.t === 'H' ? -4 : 4));
    }
    ctx.font = '10px ui-monospace,Menlo,Consolas,monospace'; ctx.textBaseline = 'middle';
  }
  [['摆动高点', SF.swingHi], ['摆动低点', SF.swingLo]].forEach(([lab, p]) => {
    if (p == null || p < lo || p > hi) return;
    const y = Y(p);
    ctx.strokeStyle = 'rgba(138,138,144,.55)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(PL, y + .5); ctx.lineTo(PL + cW, y + .5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = TX; ctx.textAlign = 'left'; ctx.font = '9px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(lab + ' ' + fmt(p, dp), PL + 3, y + (p > (hi + lo) / 2 ? 9 : -9));
    ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  });
  // 蜡烛
  for (let i = i0; i <= i1; i++) {
    const b = bars[i], up = b.c >= b.o, col = up ? CU : CD;
    const x = X(i);
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, Y(b.h)); ctx.lineTo(Math.round(x) + .5, Y(b.l)); ctx.stroke();
    const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
    ctx.fillStyle = col;
    ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
  }
  // 现价线
  const last = bars[n - 1], ly = Y(last.c);
  if (ly >= PT - 2 && ly <= PT + cH + 2) {
    ctx.strokeStyle = last.c >= last.o ? CU : CD; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, ly + .5); ctx.lineTo(PL + cW, ly + .5); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = last.c >= last.o ? CU : CD;
  ctx.fillRect(PL + cW + 2, clamp(ly, PT, PT + cH) - 8, PR - 4, 16);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText(fmt(last.c, dp), PL + cW + 6, clamp(ly, PT, PT + cH));

  /* ---------- MACD 面板 ---------- */
  const MC = F.ind.macd;
  let hmax = 0;
  for (let i = i0; i <= i1; i++) hmax = Math.max(hmax, Math.abs(MC.hist[i] || 0));
  hmax = hmax || 1;
  const my = v => mTop + mH / 2 - (v / hmax) * (mH / 2 - 3);
  ctx.strokeStyle = LN; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PL, mTop + mH / 2 + .5); ctx.lineTo(PL + cW, mTop + mH / 2 + .5); ctx.stroke();
  ctx.fillStyle = TX; ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', PL + cW + 6, mTop + 9);
  const hbw = Math.max(1, bw * 0.8);
  for (let i = i0; i <= i1; i++) {
    const v = MC.hist[i] || 0, y0 = mTop + mH / 2, y1 = my(v);
    ctx.fillStyle = v >= 0 ? 'rgba(18,161,80,.55)' : 'rgba(225,59,59,.55)';
    ctx.fillRect(X(i) - hbw / 2, Math.min(y0, y1), hbw, Math.max(1, Math.abs(y1 - y0)));
  }
  [[MC.dif, '#e13b3b'], [MC.dea, '#b7791f']].forEach(([arr, col]) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.1; ctx.beginPath();
    let st2 = false;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (!isFinite(v)) continue; const x = X(i), y = clamp(my(v), mTop + 1, mBot - 1); st2 ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st2 = true); }
    ctx.stroke();
  });

  /* ---------- KDJ 面板（第五个技术面维度） ---------- */
  const KD = F.ind.kdj;
  const ky = v => kdBot - (clamp(v, -20, 120) + 20) / 140 * kdH;
  ctx.fillStyle = 'rgba(225,59,59,.05)'; ctx.fillRect(PL, ky(80), cW, ky(100) - ky(80));   // 超买区
  ctx.fillStyle = 'rgba(18,161,80,.05)'; ctx.fillRect(PL, ky(0), cW, ky(20) - ky(0));      // 超卖区
  [20, 50, 80].forEach(g => {
    const y = ky(g);
    ctx.strokeStyle = g === 50 ? '#e6e6e4' : '#f2f2f0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, y + .5); ctx.lineTo(PL + cW, y + .5); ctx.stroke();
  });
  [[KD.J, CB_KDJ_J, 1, [2, 2]], [KD.K, CB_KDJ_K, 1.3], [KD.D, CB_KDJ_D, 1.1]].forEach(([arr, col, lw, dash]) => {
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash(dash || []); ctx.beginPath();
    let sk = false;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (!isFinite(v)) continue; const x = X(i), y = clamp(ky(v), kdTop, kdBot); sk ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), sk = true); }
    ctx.stroke(); ctx.setLineDash([]);
  });
  ctx.fillStyle = TX; ctx.textAlign = 'left';
  ctx.fillText('KDJ(9,3,3)', PL + cW + 6, kdTop + 9);
  ctx.fillStyle = CB_KDJ_K; ctx.fillText('K ' + fmt(KD.K[n - 1], 1), PL + cW + 6, kdTop + 22);
  ctx.fillStyle = CB_KDJ_D; ctx.fillText('D ' + fmt(KD.D[n - 1], 1), PL + cW + 6, kdTop + 34);

  /* ---------- 量能面板：成交量柱 + OBV 线 ---------- */
  let vmax = 0;
  for (let i = i0; i <= i1; i++) vmax = Math.max(vmax, bars[i].v);
  const OB = obvFeat(bars);
  let olo = Infinity, ohi = -Infinity;
  for (let i = i0; i <= i1; i++) { const v = OB.line[i]; if (isFinite(v)) { olo = Math.min(olo, v); ohi = Math.max(ohi, v); } }
  if (!isFinite(olo)) { olo = 0; ohi = 1; }
  if (ohi - olo < 1e-9) { ohi = olo + 1; }
  const oy = v => vBot - 2 - (v - olo) / (ohi - olo) * (voH - 8);
  for (let i = i0; i <= i1; i++) {
    const b = bars[i], h = vmax ? b.v / vmax * (voH - 8) : 0;
    ctx.fillStyle = b.c >= b.o ? 'rgba(18,161,80,.28)' : 'rgba(225,59,59,.28)';
    ctx.fillRect(X(i) - bw / 2, vBot - 2 - h, bw, h);
  }
  ctx.strokeStyle = CB_OBV; ctx.lineWidth = 1.2; ctx.beginPath();
  let so = false;
  for (let i = i0; i <= i1; i++) { const v = OB.line[i]; if (!isFinite(v)) continue; const x = X(i), y = oy(v); so ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), so = true); }
  ctx.stroke();
  if (OB.ma) {
    ctx.strokeStyle = 'rgba(125,91,209,.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    let sm = false;
    for (let i = i0; i <= i1; i++) { const v = OB.ma[i]; if (v == null || !isFinite(v)) continue; const x = X(i), y = oy(v); sm ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), sm = true); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = TX; ctx.textAlign = 'left';
  ctx.fillText('OBV', PL + cW + 6, vTop + 9);
  if (OB.bear || OB.bull) {
    ctx.fillStyle = OB.bear ? CD : CU;
    ctx.fillText(OB.bear ? '顶背离' : '底背离', PL + cW + 6, vTop + 22);
  }

  /* ---------- 时间轴 ---------- */
  ctx.fillStyle = TX; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const fmtT = t => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  ctx.fillText(fmtT(bars[i0].t), PL, H - PB + 2);
  ctx.textAlign = 'right'; ctx.fillText(fmtT(bars[i1].t), PL + cW, H - PB + 2);
  ctx.textAlign = 'center'; ctx.fillStyle = TX;
  ctx.fillText(`${i1 - i0 + 1} 根 · 滚轮缩放 · 拖动平移 · 双击复位`, PL + cW / 2, H - PB + 2);
  ctx.textBaseline = 'middle';

  // 十字光标
  if (S.hover && !S.drag) {
    const { x, y } = S.hover;
    ctx.strokeStyle = '#c8c8c6'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    if (y >= PT && y <= PT + cH) { ctx.beginPath(); ctx.moveTo(PL, y + .5); ctx.lineTo(PL + cW, y + .5); ctx.stroke(); }
    if (x >= PL && x <= PL + cW) { ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, PT); ctx.lineTo(Math.round(x) + .5, vBot); ctx.stroke(); }
    ctx.setLineDash([]);
    // 光标所在价格
    if (y >= PT && y <= PT + cH) {
      const p = hi - (y - PT) / cH * (hi - lo);
      ctx.fillStyle = '#16161a'; ctx.fillRect(PL + cW + 2, y - 8, PR - 4, 16);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(fmt(p, dp), PL + cW + 6, y);
    }
  }
}

/* ---------- 交互：滚轮缩放（以光标为锚）· 拖拽平移（从右向左拉看历史）· 双击复位 ---------- */
function kvIdxAt(x) {
  if (!view) return 0;
  const { i0, i1, step, PL } = view;
  return clamp(Math.floor((x - PL) / step) + i0, i0, i1);
}
function kvZoom(factor, anchorX, W) {
  const data = S.klines[S.sym]?.[S.tf];
  if (!data) return;
  const n = data.bars.length;
  const { i0, cnt, PL, cW, step } = view || { i0: 0, cnt: n, PL: 8, cW: W - 70, step: 1 };
  const nc = clamp(Math.round(cnt * factor), 15, Math.max(15, n));
  if (nc === cnt) return;
  const p = clamp((anchorX - PL) / Math.max(1, cW), 0, 1);
  const ai = i0 + p * cnt;                       // 锚点保持在同一屏幕位置
  const end = Math.round(ai - p * nc + nc - 1);
  S.kvCount = nc;
  S.kvEnd = clamp(end, nc - 1, n - 1);
  if (S.kvEnd >= n - 1 && p > 0.98) S.kvEnd = null;   // 一直贴右就保持自动跟随最新
  draw();
}
function kvPan(dxCss) {
  const data = S.klines[S.sym]?.[S.tf];
  if (!data || !view) return;
  const n = data.bars.length, { cnt, step } = view;
  const base = S.kvEnd == null ? n - 1 : S.kvEnd;
  const end = base - Math.round(dxCss / step);        // 向右拖 → 看更老的数据
  S.kvEnd = clamp(end, cnt - 1, n - 1);
  draw();
}

cv.addEventListener('wheel', e => {
  if (!view) return;
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  kvZoom(e.deltaY > 0 ? 1.14 : 1 / 1.14, e.clientX - r.left, r.width);
}, { passive: false });

cv.addEventListener('mousedown', e => {
  if (!view) return;
  S.drag = { x0: e.clientX, end0: S.kvEnd == null ? (S.klines[S.sym]?.[S.tf]?.bars.length || 1) - 1 : S.kvEnd, moved: false };
});
window.addEventListener('mousemove', e => {
  if (!S.drag) return;
  const dx = e.clientX - S.drag.x0;
  if (!S.drag.moved && Math.abs(dx) < 3) return;
  S.drag.moved = true;
  cv.style.cursor = 'grabbing';
  $('#kTip').style.display = 'none';
  const data = S.klines[S.sym]?.[S.tf];
  if (!data || !view) return;
  const n = data.bars.length, cnt = view.cnt, step = view.step;
  S.kvEnd = clamp(S.drag.end0 - Math.round(dx / step), cnt - 1, n - 1);
  draw();
});
window.addEventListener('mouseup', () => {
  if (S.drag) { S.drag = null; cv.style.cursor = 'crosshair'; }
});
cv.addEventListener('dblclick', () => { kvReset(); draw(); });

// 触屏：单指平移，双指捏合缩放
let _tch = null;
cv.addEventListener('touchstart', e => {
  if (e.touches.length === 1) _tch = { mode: 'pan', x0: e.touches[0].clientX, end0: S.kvEnd == null ? (S.klines[S.sym]?.[S.tf]?.bars.length || 1) - 1 : S.kvEnd };
  else if (e.touches.length === 2) { _tch = { mode: 'pinch', d0: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), c0: view ? view.cnt : KV_DEF }; }
}, { passive: true });
cv.addEventListener('touchmove', e => {
  if (!_tch || !view) return;
  if (_tch.mode === 'pan' && e.touches.length === 1) {
    const n = S.klines[S.sym][S.tf].bars.length;
    S.kvEnd = clamp(_tch.end0 - Math.round((e.touches[0].clientX - _tch.x0) / view.step), view.cnt - 1, n - 1);
    draw();
  } else if (_tch.mode === 'pinch' && e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (_tch.d0 > 0) {
      const nc = clamp(Math.round(_tch.c0 * (_tch.d0 / Math.max(1, d))), 15, S.klines[S.sym][S.tf].bars.length);
      S.kvCount = nc;
      S.kvEnd = clamp(S.kvEnd == null ? S.klines[S.sym][S.tf].bars.length - 1 : S.kvEnd, nc - 1, S.klines[S.sym][S.tf].bars.length - 1);
      draw();
    }
  }
}, { passive: true });
cv.addEventListener('touchend', () => { _tch = null; }, { passive: true });

cv.addEventListener('mousemove', e => {
  if (!view || S.drag) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const { bars } = view;
  const i = kvIdxAt(x);
  const b = bars[i], s = SYMS[S.sym], tip = $('#kTip');
  S.hover = { x, y }; draw();
  const d = new Date(b.t);
  const F = analyzeOf(S.sym, S.tf, bars);
  const bo = F.ind.boll[i], mc = F.ind.macd;
  tip.innerHTML = `<div class="mut" style="margin-bottom:3px">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</div>`
    + `<div>开 <b class="num">${fmt(b.o, s.dp)}</b>　高 <b class="num">${fmt(b.h, s.dp)}</b></div>`
    + `<div>低 <b class="num">${fmt(b.l, s.dp)}</b>　收 <b class="num">${fmt(b.c, s.dp)}</b></div>`
    + `<div class="mut" style="margin-top:3px">BOLL ${bo ? `${fmt(F.ind.boll.dn[i], s.dp)} / ${fmt(F.ind.boll.mid[i], s.dp)} / ${fmt(bo, s.dp)}` : '—'}</div>`
    + `<div class="mut">MACD ${fmt(mc.dif[i], s.dp)} · 柱 ${fmt(mc.hist[i], s.dp)}</div>`;
  tip.style.display = 'block';
  tip.style.left = Math.min(r.width - 165, x + 14) + 'px';
  tip.style.top = Math.max(4, y - 62) + 'px';
});
cv.addEventListener('mouseleave', () => { S.hover = null; $('#kTip').style.display = 'none'; draw(); });
window.addEventListener('resize', () => { fitCanvas(); draw(); drawHeat(); });

/* ============================ 渲染：报价栏 ============================ */
function renderQuote() {
  const q = S.quotes[S.sym], s = SYMS[S.sym];
  if (!q) return;
  const openRef = S.openRef[S.sym] ?? q.price;
  const chg = (q.price / openRef - 1) * 100;
  $('#qName').textContent = `${s.label} · ${s.cn} · 永续`;
  $('#qPx').textContent = fmt(q.price, s.dp);
  $('#qChg').innerHTML = `<span class="${chg >= 0 ? 'up' : 'down'}">${pct(chg)}</span> <span class="mut">较本次会话开盘</span>`;

  const hiRow = q.rows.find(r => r.isHi), loRow = q.rows.find(r => r.isLo);
  $('#qHi').textContent = fmt(q.hi, s.dp); $('#qHiV').textContent = hiRow ? hiRow.name : '—';
  $('#qLo').textContent = fmt(q.lo, s.dp); $('#qLoV').textContent = loRow ? loRow.name : '—';
  $('#qSpread').textContent = fmt(q.spread, s.dp);
  $('#qSpreadPct').innerHTML = `${fmt(q.spreadPct, 3)}% <span class="badge ${q.hit ? 'hot' : 'ok'}">${q.hit ? '≥0.1% 触发' : '<0.1%'}</span>`;
  $('#qVenues').textContent = `${q.realCount} / ${q.rows.length}`;

  /* 名称右侧徽标：一眼确认「这个价格是几个交易所实时给的、走的哪条通道」。
   * 拿不到源时不写「参考价」，直接标红 —— 页面不提供任何非交易所报价。 */
  const badge = $('#qBadge');
  if (badge) {
    const via = NET.relay === 'direct' ? '直连' : '转发';
    badge.textContent = q.realCount >= 2 ? `${q.realCount} 源实时 · ${via}` : q.realCount === 1 ? '仅 1 源 · 不可比' : '无实时源';
    badge.className = 'badge ' + (q.realCount >= 2 ? 'ok' : 'hot');
  }

  const f = q.funding;
  const fEl = $('#qFund'), fSub = $('#qFundSub');
  if (f == null || !isFinite(f)) {
    fEl.textContent = '—'; fEl.className = 'q-v num'; fSub.textContent = '该品种无费率源';
  } else {
    fEl.textContent = (f * 100).toFixed(4) + '%';
    fEl.className = 'q-v num ' + (f >= 0 ? 'up' : 'down');
    fSub.textContent = (f >= 0 ? '多头付空头' : '空头付多头') + ` · ${q.fundingCount} 源中位`;
  }

  const rc = q.realCount;
  const dot = $('#netDot'), txt = $('#netTxt');
  /* 状态灯同时回答两件事：拿到几个真实源、数据是直连还是经转发。
   * 「离线 · 参考模式」这个状态已经不存在了 —— 拿不到真实源就是取数失败，页面不提供参考模式。 */
  const via = NET.relay === 'direct' ? '直连' : '转发·' + NET.relayName;
  if (rc >= 2) { dot.className = 'dot live pulse'; txt.textContent = `实时 ${via} · ${rc} 源`; }
  else if (rc === 1) { dot.className = 'dot sim'; txt.textContent = `仅 1 源 ${via} · 价差不可比`; }
  else { dot.className = 'dot err pulse'; txt.textContent = '无实时源 · 重试中'; }
}

function renderVenues() {
  const q = S.quotes[S.sym], s = SYMS[S.sym];
  if (!q) return;
  const row = r => {
    const cls = r.isHi ? 'hi' : r.isLo ? 'lo' : '';
    const dcls = r.dev > 0.01 ? 'up' : r.dev < -0.01 ? 'down' : 'flat';
    // 取数失败的平台直接标「取数失败」。旧版的 REF 标记（按真实价造的假报价）已彻底移除
    const st = r.real
      ? `<span class="badge ok">实时</span>`
      : `<span class="badge hot" title="${(r.err || '').replace(/"/g, '')}">取数失败</span>`;
    // 资金费率：正=多头付空头（多头拥挤），负=空头付多头
    const fr = (r.funding == null || !isFinite(r.funding))
      ? '<span class="mut">—</span>'
      : `<span class="${r.funding >= 0 ? 'up' : 'down'}">${(r.funding * 100).toFixed(4)}%</span>`;
    return `<tr>
      <td><div class="v-n"><b>${r.name}</b><span class="mut" style="font-size:10px">${r.note}</span></div></td>
      <td class="num ${cls}">${fmt(r.price, s.dp)}</td>
      <td class="num dev ${dcls}">${pct(r.dev, 3)}</td>
      <td class="num" style="font-size:11px">${fr}</td>
      <td>${st}</td></tr>`;
  };
  const refs = q.refRows || [];
  const refHtml = refs.length
    ? `<tr><td colspan="5" class="mut" style="font-size:10px;border:0;padding-top:9px">以下为<b>非永续</b>口径，仅作基差参考，<b>不参与价差计算</b></td></tr>` + refs.map(row).join('')
    : '';
  $('#vBody').innerHTML = q.rows.map(row).join('') + refHtml;

  const off = VENUES.length - (q.realCount + refs.length);
  // 布伦特：加密所永续为合成指数，与传统 ICE 期货口径不同，实测存在明显价差，必须提示
  let oilNote = '';
  if (SYMS[S.sym].oil) {
    let gap = '';
    if (refs.length && q.median > 0) {
      const d = (refs[0].price - q.median) / q.median * 100;
      gap = `当前参考期货价与永续中位价相差 <b>${fmt(Math.abs(d), 2)}%</b>（${refs[0].name} ${fmt(refs[0].price, s.dp)} vs 永续 ${fmt(q.median, s.dp)}），两者标的口径不同，<b>不可直接套利</b>。`;
    }
    oilNote = '<br>布伦特在加密交易所中仅 BingX 挂出永续合约（合成指数），多平台永续对比源有限；传统 ICE 布伦特期货需经纪商数据源。' + gap;
  }
  $('#vCount').textContent = `${q.rows.length} 个永续源` + (refs.length ? ` + ${refs.length} 参考` : '');
  $('#vNote').innerHTML =
    `对比口径为<b>永续合约价</b>（优先标记价，无标记价时取最新成交价），现货指数与传统期货不参与价差计算。` +
    (off ? ` ${off} 个平台取数失败（跨域或地区限制），已在表中标注 —— 本表不出现任何非交易所报价。` : '') +
    oilNote +
    `<br>极差 ${fmt(q.spread, s.dp)}（${fmt(q.spreadPct, 3)}%），阈值 0.10%。资金费率为当期值，正表示多头付空头。`;
}

/* 综合信号：K 线结构 + MACD + OBV + BOLL 决定方向，清算热力图做路径 / 幅度修正。
 * 清算是乘性修正（±32%），改不了技术面基准的正负号，因此无法单独定方向。 */
function signalOf(symId, tfKey, bars) {
  const t = analyzeOf(symId, tfKey, bars);
  const F = fuseSignal(symId, tfKey, bars);
  const L = F.liq;
  return Object.assign({}, t, L || {}, {
    liq: L, src: L ? F.src : '无清算数据', grade: L ? F.grade : 'none',
    dir: F.dir, score: F.score, strength: F.strength,
    reasons: F.reasons, fuse: F, mm: mmView(symId, tfKey, bars, F),
  });
}

/* ============================ 渲染：四格信号 ============================ */
function renderSignals() {
  const el = $('#sigGrid'), s = SYMS[S.sym];
  el.innerHTML = TFS.map(tf => {
    const d = S.klines[S.sym]?.[tf.k];
    if (!d) return `<div class="sig wait"><div class="sig-hd"><span class="sig-tf">${tf.label}</span></div>
      <div class="mut" style="font-size:11px">加载中…</div></div>`;
    const a = signalOf(S.sym, tf.k, d.bars);
    const L = a.liq, FZ = a.fuse;
    const fz1 = k => { const c = FZ && FZ.contrib.find(x => x.k === k); return c ? c.s * 100 : 0; };
    const dirTxt = a.dir === 'long' ? '做多' : a.dir === 'short' ? '做空' : '观望';
    const dirCls = a.dir === 'long' ? 'up' : a.dir === 'short' ? 'down' : 'flat';
    const barW = clamp(a.strength, 0, 100);
    const gTag = L ? (a.grade === 'real' ? 'CoinGlass 真实' : a.grade === 'semi' ? '合约推算' : '模型估算')
                   : '无清算数据';
    const gCls = L ? (a.grade === 'real' ? 'g-real' : a.grade === 'semi' ? 'g-semi' : 'g-est') : 'g-est';

    const rows = L ? `
        <div class="sig-r"><span class="dim">上方空单清算</span><b class="num down">${fmt(L.upPct, 1)}%</b></div>
        <div class="sig-r"><span class="dim">下方多单清算</span><b class="num up">${fmt(L.dnPct, 1)}%</b></div>
        <div class="sig-r"><span class="dim">筹码净偏向</span><b class="num ${L.netBias >= 0 ? 'up' : 'down'}">${pct(L.netBias, 1)}</b></div>
        <div class="sig-r"><span class="dim">资金费率</span><b class="num ${L.funding == null ? '' : L.funding >= 0 ? 'down' : 'up'}">${L.funding == null ? '—' : (L.funding * 100).toFixed(4) + '%'}</b></div>
        <div class="sig-r"><span class="dim">ATR 波动</span><b class="num">${fmt(a.atrPct, 2)}%</b></div>`
      : `
        <div class="sig-r"><span class="dim">RSI(14)</span><b class="num ${a.rsi > 57 ? 'up' : a.rsi < 43 ? 'down' : ''}">${fmt(a.rsi, 1)}</b></div>
        <div class="sig-r"><span class="dim">MACD 柱</span><b class="num ${a.macdH > 0 ? 'up' : 'down'}">${fmt(a.macdH, s.dp)}</b></div>
        <div class="sig-r"><span class="dim">ATR 波动</span><b class="num">${fmt(a.atrPct, 2)}%</b></div>
        <div class="sig-r"><span class="dim">10 周期动量</span><b class="num ${a.mom >= 0 ? 'up' : 'down'}">${pct(a.mom)}</b></div>`;

    // 因子贡献：让「为什么是这个方向」一眼可见。清算项显示成 ×倍率，
    // 直观表达「它只缩放技术面基准，不参与定方向」。
    const fz = FZ ? `<div class="sig-fz">` + FZ.contrib.map(x => {
      const cls = x.s > 0.15 ? 'up' : x.s < -0.15 ? 'down' : '';
      if (x.k === 'liq') {
        return `<div title="清算流动性：方向 ${fmt(x.s * 100, 0)}，与技术面${FZ.liqAdj >= 0 ? '同向' : '反向'}，把技术面基准 ${fmt(FZ.base, 1)} ${FZ.liqAdj >= 0 ? '上调' : '下调'} ${Math.abs(FZ.liqAdj * 100).toFixed(0)}%">${x.name}<em class="${cls}">×${(1 + FZ.liqAdj).toFixed(2)}</em></div>`;
      }
      return `<div title="${x.name} 权重 ${x.w}，方向 ${fmt(x.s * 100, 0)}，对技术面基准贡献 ${x.c >= 0 ? '+' : ''}${fmt(x.c, 1)}">${x.name}<em class="${cls}">${x.c >= 0 ? '+' : ''}${fmt(x.c, 0)}</em></div>`;
    }).join('') + `</div>` : '';

    let act;
    if (!L) {
      act = `本周期无清算数据，方向由技术面五因子融合给出：<b>结构 ${fmt(fz1('st'), 0)} / MACD ${fmt(fz1('macd'), 0)} / OBV ${fmt(fz1('obv'), 0)} / BOLL ${fmt(fz1('boll'), 0)} / KDJ ${fmt(fz1('kdj'), 0)}</b>。可在「数据源」中填入 Coinglass Key 使用真实清算图。`;
    } else if (a.dir === 'wait') {
      const near = L.magUp && L.magDn
        ? (L.magUp.d <= L.magDn.d ? `上方 <b>${fmt(L.magUp.p, s.dp)}</b>` : `下方 <b>${fmt(L.magDn.p, s.dp)}</b>`)
        : (L.magUp ? `上方 <b>${fmt(L.magUp.p, s.dp)}</b>` : L.magDn ? `下方 <b>${fmt(L.magDn.p, s.dp)}</b>` : '关键清算带');
      act = `两侧清算池接近均衡（${fmt(L.upPct, 1)}% / ${fmt(L.dnPct, 1)}%），<b>建议空仓等待</b>；等价格贴近 ${near} 的清算带再顺势介入。`;
    } else {
      const m = a.dir === 'long' ? L.magUp : L.magDn;
      const word = a.dir === 'long' ? '空单清算带' : '多单清算带';
      const verb = a.dir === 'long' ? '上破' : '下破';
      act = m
        ? `${verb} <b>${fmt(L.trigger, s.dp)}</b>（${word}，强度 ${Math.round(m.v * 100)}%，距现价 ${fmt(m.dpct, 2)}%）后顺势跟进，目标 <b>${fmt(L.tp, s.dp)}</b>，反向击穿 <b>${fmt(L.sl, s.dp)}</b> 视为失效。`
        : `${verb} <b>${fmt(L.trigger, s.dp)}</b> 后顺势跟进，目标 <b>${fmt(L.tp, s.dp)}</b>，止损 <b>${fmt(L.sl, s.dp)}</b>。`;
    }

    return `<div class="sig ${a.dir}" title="${(a.reasons || []).join('；')}">
      <div class="sig-hd">
        <span class="sig-tf">${tf.label}</span>
        <span class="sig-src ${gCls}">${gTag}</span>
        <span class="sig-dir ${dirCls}">${dirTxt}</span>
      </div>
      <div class="sig-score">
        <div class="bar ${a.dir}"><i style="width:${barW}%"></i></div>
        <span class="sig-n">${Math.round(a.strength)}</span>
      </div>
      <div class="sig-rows">${rows}</div>
      ${fz}
      <div class="sig-act">${act}<br><span class="mut">五因子合成 ${Math.round(a.score)} · 一致度 ${Math.round((FZ ? FZ.conf : 0) * 100)}% · 建议仓位 ≤ 保证金的 ${Math.round(a.posPct)}%</span></div>
    </div>`;
  }).join('');
}

/* ============================ 渲染：做市商视角 ============================ */
function mmThesis(el, s) {
  const dp = s.dp;
  if (el.mode === 'sweep' && el.sweep) {
    const up = el.sweep.side === 'up';
    const sw = up ? '上方' : '下方', kind = up ? '空单' : '多单';
    const dirW = el.bias === 'long' ? '做多' : '做空';
    return `流动性偏向<b>${sw}</b>：${sw} <b>${fmt(el.sweep.p, dp)}</b> 有强度 ${Math.round(el.sweep.v * 100)}% 的${kind}清算带（距现价 ${fmt(el.sweep.dpct, 2)}%），`
      + `但结构 / 动能 / 量能指向<b>${el.tech > 0 ? '上行' : '下行'}</b>。做市商更可能先<b>向${up ? '上' : '下'}扫</b>掉这批止损拿够对手盘再掉头 —— `
      + `判定为<b>扫单后反转（Judas）</b>，不是趋势延续。最终偏向 <b>${dirW}</b>，扫单发生概率约 <b>${Math.round(el.sweep.prob * 100)}%</b>。`;
  }
  if (el.mode === 'follow') {
    const side = el.bias === 'long' ? '上方' : el.bias === 'short' ? '下方' : '';
    const L = el.F.liq;
    const m = side === '上方' ? (L && L.magUp) : (L && L.magDn);
    const tail = m
      ? `流动性在<b>${side} ${fmt(m.p, dp)}</b>（强度 ${Math.round(m.v * 100)}%，${fmt(m.dpct, 2)}%），与结构动能<b>同向</b> —— 顺势跟随，目标看该清算带被吃穿后的延续。`
      : `流动性与结构动能<b>同向</b>，顺势跟随，但本周期未定位到明确清算密集带，仓位需保守。`;
    return `最终偏向 <b>${el.bias === 'long' ? '做多' : el.bias === 'short' ? '做空' : '观望'}</b>。${tail}`;
  }
  return `各因子<b>互不确认</b>${el.F.bl.squeeze ? '，且 BOLL 带宽处于历史低位（挤压）' : ''} —— 方向未定。此阶段做市商通常在两侧同时挂单收手续费，价格多为区间震荡，<b>不宜追单</b>，等带宽扩张或出现结构突破再介入。`;
}

function mmPlan(el, s) {
  const dp = s.dp, L = el.F.liq;
  const out = [];
  if (el.mode === 'sweep' && el.sweep) {
    const up = el.sweep.side === 'up';
    const wantLong = el.bias === 'long';
    out.push(`<b>操作</b>：不要在扫单方向追单。等价格触及 <b>${fmt(el.sweep.p, dp)}</b> 并在随后 1~2 根快速收回${up ? '其下方' : '其上方'}，再${wantLong ? '做多' : '做空'}；`
      + `止损放在扫单极值外 ${fmt((L && L.atr) ? L.atr * 0.4 : el.px * 0.002, dp)}。`);
    if (L && L.sl && L.tp) out.push(`失效位 <b>${fmt(L.sl, dp)}</b> · 目标 <b>${fmt(L.tp, dp)}</b>（来自该周期清算带结构）。`);
  } else if (el.mode === 'follow') {
    const m = el.bias === 'long' ? (L && L.magUp) : (L && L.magDn);
    out.push(`<b>操作</b>：${el.F.st.bos ? `结构已${el.F.st.bos === 'up' ? '上破' : '下破'}最近摆动${el.F.st.bos === 'up' ? '高' : '低'}点，可顺势跟进` : '等回踩结构位再介入'}，`
      + `${m ? `目标 <b>${fmt(m.p, dp)}</b>（${el.bias === 'long' ? '上方空单' : '下方多单'}清算带）` : '目标参考 ATR 2 倍'}，`
      + `${L && L.sl ? `失效 <b>${fmt(L.sl, dp)}</b>` : '失效参考 ATR 1.5 倍'}。`);
    if (el.F.st.choch) out.push(`注意：出现 <b>CHoCH 转${el.F.st.choch === 'bull' ? '多' : '空'}</b>，原结构已被破坏，需重新等确认。`);
  } else {
    out.push(`<b>操作</b>：观望。等 BOLL 带宽扩张或价格突破摆动高/低点（${el.F.st.swingHi ? fmt(el.F.st.swingHi, dp) : '—'} / ${el.F.st.swingLo ? fmt(el.F.st.swingLo, dp) : '—'}）再定方向。`);
  }
  if (el.trap) out.push(`<b>陷阱提示</b>：${el.trap.why} —— 该侧突破大概率为假动作。`);
  if (el.F.ob.bear || el.F.ob.bull)
    out.push(`<b>量能</b>：OBV 出现${el.F.ob.bear ? '顶背离（价格新高但量能不跟，拉抬缺乏承接）' : '底背离（价格新低但量能抬升，抛压衰竭）'}。`);
  out.push(`<span class="liq">${el.reasons.map(r => '· ' + r).join('<br>')}</span>`);
  return out.join('<br>');
}

/* ---- 价格带区间渲染 ----
 * 一条价位阶梯：上方清算带 → 现价 → 下方清算带，按价格从高到低排，中间那根轴是共享比例尺，
 * 所以「哪段厚、离现价多远、宽几个 ATR」扫一眼就有数，不用去读热力图。 */
function renderZones(el, s) {
  const box = $('#mmZones');
  if (!box) return;
  const dp = s.dp, px = el.px, a = el.atr;
  const Z = (el.zones || []).slice();
  const BJ = b => b && isFinite(b.lo) && isFinite(b.hi);

  if (!Z.length) {
    const eb = el.entryBand;
    box.innerHTML = `<div class="mmz">
      <div class="mmz-hd"><span class="mmz-t">价格带区间</span>
        <span class="mut">本周期无清算热力图 · 无法定位止损带</span></div>
      ${eb ? `<div class="mmz-no">仅给出结构挂单区 <b class="num">${fmt(eb.lo, dp)} – ${fmt(eb.hi, dp)}</b>`
        + `<span class="mut">（${eb.side === 'up' ? '反抽不过' : '回踩不破'} · 宽 ${fmt(eb.atrW, 2)} ATR）</span></div>`
        : '<div class="mmz-no">本周期无可用价格带 —— 填入 Coinglass / AiCoin Key 后可定位真实清算带。</div>'}
    </div>`;
    return;
  }

  /* 共享比例尺：所有带 + 现价 + 各操作带，两侧留 6% 余量，避免带贴在边框上看不见 */
  let lo = px, hi = px;
  for (const z of Z) { lo = Math.min(lo, z.lo); hi = Math.max(hi, z.hi); }
  for (const b of el.bands) if (BJ(b)) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); }
  const pad = Math.max((hi - lo) * 0.06, px * 0.0008);
  lo -= pad; hi += pad;
  const span = Math.max(hi - lo, 1e-9);
  const pc = p => clamp((p - lo) / span * 100, 0, 100);
  const seg = (l, h, cls, op, tip) =>
    `<i class="${cls}" style="left:${pc(l).toFixed(2)}%;width:${Math.max(pc(h) - pc(l), 0.6).toFixed(2)}%;opacity:${op.toFixed(2)}" title="${tip}"></i>`;

  // 本周期里最强的带，用来归一化显示强度
  let vmax = 0.001; for (const z of Z) vmax = Math.max(vmax, z.v);

  /* 阶梯：价格从高到低。上方带是空单止损（红），下方带是多单止损（绿）。 */
  const ups = Z.filter(z => z.lo > px).sort((x, y) => y.mid - x.mid).slice(0, 2);
  const dns = Z.filter(z => z.hi < px).sort((x, y) => y.mid - x.mid).slice(0, 2);
  const near = new Set([ups[0], dns[0]].filter(Boolean));
  const swMid = el.sweep ? el.sweep.p : null;

  const row = z => {
    const op = clamp(0.4 + (z.v / vmax) * 0.6, 0.35, 1);
    const isSw = swMid != null && Math.abs(z.mid - swMid) < (z.hi - z.lo) * 0.5;
    const tag = isSw ? '<b style="color:var(--warn)">先扫</b> · ' : '';
    const nm = z.side === 'up' ? '空单止损带' : '多单止损带';
    const tip = `${nm} ${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}｜强度 ${Math.round(z.v * 100)}%｜`
      + `宽 ${fmt(z.atrW, 2)} ATR｜中距现价 ${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%`;
    return `<div class="mmz-r">
      <div class="k">${tag}${z.side === 'up' ? '上方' : '下方'} ${nm}</div>
      <div class="mmz-ax">${seg(z.lo, z.hi, z.side === 'up' ? 'up' : 'dn', op, tip)}</div>
      <div class="mmz-v">${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}<em>${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%</em></div>
    </div>`;
  };

  const pxRow = `<div class="mmz-r px">
      <div class="k">现价</div>
      <div class="mmz-ax">${seg(px, px, 'px', 1, '现价 ' + fmt(px, dp))}</div>
      <div class="mmz-v">${fmt(px, dp)}<em>ATR ${fmt(a, dp > 2 ? 2 : 1)}</em></div>
    </div>`;

  /* 操作带四宫格 */
  const opCard = (b, t, cls) => {
    if (!BJ(b)) return '';
    const d = (b.mid / px - 1) * 100;
    return `<div class="${cls}">
      <div class="t">${t}</div>
      <div class="r">${fmt(b.lo, dp)} – ${fmt(b.hi, dp)}</div>
      <div class="d">${d >= 0 ? '+' : ''}${fmt(d, 2)}% · 宽 ${fmt(b.atrW, 2)} ATR${b.v ? ` · 强度 ${Math.round(b.v * 100)}%` : ''}<br>${b.why || ''}</div>
    </div>`;
  };
  const ops = [
    opCard(el.bands.find(b => b.kind === 'sweep'), el.sweep ? `先扫区间 · 概率 ${Math.round(el.sweep.prob * 100)}%` : '先扫区间', 'o-sweep'),
    opCard(el.bands.find(b => b.kind === 'target'), '目标区间', 'o-target'),
    opCard(el.bands.find(b => b.kind === 'fail'), '失效区间', 'o-fail'),
    opCard(el.bands.find(b => b.kind === 'entry'), '挂单区间', 'o-entry'),
  ].join('');

  const zc = Z.length;
  box.innerHTML = `<div class="mmz">
    <div class="mmz-hd">
      <span class="mmz-t">价格带区间</span>
      <span class="mut">识别 ${zc} 段 · 现价 ${fmt(px, dp)} · ATR ${fmt(a, dp > 2 ? 2 : 1)}（${fmt(a / px * 100, 2)}%）</span>
    </div>
    <div class="mmz-rows">
      ${ups.map(row).join('')}
      ${ups.length ? '<div class="mmz-sep"></div>' : ''}
      ${pxRow}
      ${dns.length ? '<div class="mmz-sep"></div>' : ''}
      ${dns.map(row).join('')}
    </div>
    ${ops ? `<div class="mmz-op">${ops}</div>` : ''}
  </div>`;
}

/* 报价条里的「做市商方向」：把做市商结论提到最显眼的位置，一眼看到结论再往下看理由。 */
function renderDirCell() {
  const d = S.klines[S.sym]?.[S.tf];
  const elCell = $('#qDir'), sub = $('#qDirSub'), tfEl = $('#qDirTf');
  if (!elCell) return;
  if (tfEl) tfEl.textContent = (TF_MAP[S.tf] || {}).label || S.tf;
  if (!d || !d.bars.length) { elCell.textContent = '—'; elCell.className = 'q-v'; sub.textContent = 'K 线加载中…'; return; }
  const el = mmView(S.sym, S.tf, d.bars);
  const s = SYMS[S.sym];
  const txt = el.bias === 'long' ? '做多' : el.bias === 'short' ? '做空' : '观望';
  const cls = el.bias === 'long' ? 'up' : el.bias === 'short' ? 'down' : 'flat';
  elCell.textContent = txt;
  elCell.className = 'q-v ' + cls;

  const modeW = el.mode === 'sweep' ? '扫单后反转' : el.mode === 'follow' ? '顺势' : '观望';
  const b = el.bands.find(x => x.kind === 'target');
  const tail = el.mode === 'sweep' && el.sweep
    ? `先扫${el.sweep.side === 'up' ? '上' : '下'} ${fmt(el.sweep.lo, s.dp)}–${fmt(el.sweep.hi, s.dp)}，再${txt}`
    : b ? `目标 ${fmt(b.lo, s.dp)}–${fmt(b.hi, s.dp)}` : '无明确目标带';
  sub.innerHTML = `${modeW} · ${tail}`;
  sub.title = `${modeW}｜一致度 ${el.conf}%｜${tail}`;
}

function renderMM() {
  const d = S.klines[S.sym]?.[S.tf];
  const s = SYMS[S.sym];
  const src = $('#mmSrc'), ts = $('#mmTs');
  if (!d || !d.bars.length) {
    $('#mmHd').innerHTML = '<span class="mut">K 线加载中…</span>';
    $('#mmGrid').innerHTML = ''; $('#mmPlan').innerHTML = '—';
    const zb = $('#mmZones'); if (zb) zb.innerHTML = '';
    $('#mmFac5').innerHTML = '';          // 不清的话会留着上一个品种的因子分，与新标题对不上
    src.textContent = '—'; src.className = 'src'; ts.textContent = '';
    return;
  }
  const el = mmView(S.sym, S.tf, d.bars);
  const F = el.F;
  src.textContent = `技术面定方向 · 清算图定路径 · ${TF_MAP[S.tf].label} · ${F.hasHeat ? F.src : '无清算数据'}`;
  src.className = 'src ' + (F.hasHeat && F.grade === 'real' ? 'real' : 'syn');
  ts.textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const modeTxt = el.mode === 'follow' ? '顺势 · 流动性与结构同向'
    : el.mode === 'sweep' ? '扫单后反转 · 背离'
    : '观望 · 因子矛盾 / 挤压';
  const biasTxt = el.bias === 'long' ? '做多' : el.bias === 'short' ? '做空' : '观望';
  const biasCls = el.bias === 'long' ? 'up' : el.bias === 'short' ? 'down' : 'flat';
  $('#mmHd').innerHTML =
    `<span class="mm-mode ${el.mode}">${modeTxt}</span>` +
    `<span class="mm-bias ${biasCls}">${biasTxt}</span>` +
    `<span class="mm-sub">一致度 ${el.conf}% · 合成 ${Math.round(F.score)} · 现价 ${fmt(el.px, s.dp)}</span>`;

  const fc = F.contrib.map(x => {
    const p = clamp(Math.abs(x.c) / 34 * 50, 0, 50);
    const cls = x.s > 0.15 ? 'up' : x.s < -0.15 ? 'down' : 'flat';
    const word = x.s > 0.15 ? '偏多' : x.s < -0.15 ? '偏空' : '中性';
    const bar = x.s >= 0 ? `left:50%;width:${p}%` : `right:50%;width:${p}%`;
    return `<div class="mm-c">
      <div class="k"><span>${x.name}</span><em class="${cls}">${word} ${fmt(x.s * 100, 0)}</em></div>
      <div class="mm-bar"><u></u><i class="${x.s >= 0 ? 'p' : 'n'}" style="${bar}"></i></div>
      <div class="v mut" style="font-size:10.5px;margin-top:6px">${x.k === 'liq'
        ? `路径修正 ×${(1 + F.liqAdj).toFixed(2)}（不参与定方向）`
        : `权重 ${x.w} · 贡献 ${x.c >= 0 ? '+' : ''}${fmt(x.c, 1)}`}</div>
    </div>`;
  }).join('');

  const dp5 = s.dp;
  const fw = k => FUSE_W[k];
  const fcls = v => v > 0.15 ? 'up' : v < -0.15 ? 'down' : 'flat';
  const fbar = v => { const w = clamp(Math.abs(v) * 50, 1, 50); return v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`; };
  const fac = (name, key, v, detail, tip) => `<div class="fac" title="${String(tip || '').replace(/"/g, '')}">
      <div class="n"><span>${name}</span><u>权重 ${fw(key)}</u></div>
      <div class="v ${fcls(v)}">${v > 0 ? '+' : ''}${Math.round(v * 100)}</div>
      <div class="mm-bar"><u></u><i class="${v >= 0 ? 'p' : 'n'}" style="${fbar(v)}"></i></div>
      <div class="d">${detail}</div>
    </div>`;

  const trendTxt = { up: '上升', down: '下降', expand: '扩张', contract: '收敛', range: '震荡' }[F.st.trend] || '震荡';
  const kdZone = { over: '超买区', under: '超卖区', upper: '中上区', lower: '中下区', mid: '中轴区' }[F.kd.zone] || '中轴区';
  const kdCross = F.kd.cross === 1 ? '刚金叉' : F.kd.cross === -1 ? '刚死叉' : (F.kd.k > F.kd.d ? 'K 在 D 上' : 'K 在 D 下');
  const macdPos = F.mc.above0 === 1 ? '零轴上方' : F.mc.above0 === -1 ? '零轴下方' : '跨零轴';
  const obvTxt = F.ob.bear ? '顶背离 · 拉抬无承接' : F.ob.bull ? '底背离 · 抛压衰竭'
    : F.ob.slope > 0.05 ? '量能持续流入' : F.ob.slope < -0.05 ? '量能持续流出' : '量能走平';
  const bollTxt = (F.bl.pb > 0.85 ? '贴上轨' : F.bl.pb < 0.15 ? '贴下轨' : F.bl.pb > 0.5 ? '中轨上方' : '中轨下方')
    + (F.bl.squeeze ? ' · 带宽挤压' : '');

  $('#mmFac5').innerHTML =
    fac('结构', 'st', F.st.s,
      `${trendTxt} · ${F.st.bos ? `已${F.st.bos === 'up' ? '上破' : '下破'}` : '未突破'}${F.st.choch ? ` · CHoCH` : ''}`,
      `摆动高低点 ${F.st.swingHi ? fmt(F.st.swingHi, dp5) : '—'} / ${F.st.swingLo ? fmt(F.st.swingLo, dp5) : '—'}；分值 ${Math.round(F.st.s * 100)}`)
    + fac('MACD', 'macd', F.mc.s,
      `${macdPos} · ${F.mc.cross === 1 ? '金叉' : F.mc.cross === -1 ? '死叉' : (F.mc.dif > F.mc.dea ? 'DIF>DEA' : 'DIF<DEA')}`,
      `DIF ${fmt(F.mc.dif, dp5)} · DEA ${fmt(F.mc.dea, dp5)} · 柱 ${fmt(F.mc.hist, dp5)}`)
    + fac('OBV', 'obv', F.ob.s, obvTxt,
      `OBV 斜率 ${fmt(F.ob.slope, 2)}${F.ob.bear ? ' · 已确认顶背离' : F.ob.bull ? ' · 已确认底背离' : ''}`)
    + fac('BOLL', 'boll', F.bl.s, bollTxt,
      `价格位于带内 ${Math.round(F.bl.pb * 100)}% 处；带宽分位 ${Math.round(F.bl.rank * 100)}%`)
    + fac('KDJ', 'kdj', F.kd.s, `${kdZone} · ${kdCross}`,
      `K ${fmt(F.kd.k, 1)} · D ${fmt(F.kd.d, 1)} · J ${fmt(F.kd.j, 1)}；J = 3K − 2D，超出 0~100 视为极值减弱信号`);

  const L = F.liq;
  const balCard = `<div class="mm-c">
    <div class="k"><span>流动性天平</span><em>${!L ? '无数据' : el.liqSide === 'even' ? '均衡' : el.liqSide === 'up' ? '偏上方' : '偏下方'}</em></div>
    <div class="v">${L ? `上方 ${fmt(L.upPct, 1)}% / 下方 ${fmt(L.dnPct, 1)}%` : '本周期无清算数据'}</div>
    <div class="v mut" style="font-size:10.5px;margin-top:4px">${L && L.magUp ? `上带 ${fmt(L.magUp.p, s.dp)}（${fmt(L.magUp.dpct, 2)}%）` : '上带 —'}${L && L.magDn ? ` · 下带 ${fmt(L.magDn.p, s.dp)}（${fmt(L.magDn.dpct, 2)}%）` : ' · 下带 —'}</div>
  </div>`;
  const swCard = `<div class="mm-c">
    <div class="k"><span>扫单目标</span><em>${el.sweep ? Math.round(el.sweep.prob * 100) + '%' : '—'}</em></div>
    <div class="v">${el.sweep ? `${el.sweep.side === 'up' ? '先扫上方' : '先扫下方'} <b>${fmt(el.sweep.p, s.dp)}</b>` : (el.mode === 'follow' ? '与结构同向，无需扫单' : '未定位到扫单位')}</div>
    <div class="v mut" style="font-size:10.5px;margin-top:4px">${el.sweep ? `${el.sweep.side === 'up' ? '空单' : '多单'}清算带 · 强度 ${Math.round(el.sweep.v * 100)}% · 距现价 ${fmt(el.sweep.dpct, 2)}%` : '做市商需流动性才推得动价格'}</div>
  </div>`;
  const structCard = `<div class="mm-c">
    <div class="k"><span>K 线结构</span><em>${F.st.trend === 'up' ? '上升' : F.st.trend === 'down' ? '下降' : F.st.trend === 'expand' ? '扩张' : F.st.trend === 'contract' ? '收敛' : '震荡'}</em></div>
    <div class="v">${F.st.swingHi ? `高 ${fmt(F.st.swingHi, s.dp)}` : '—'} / ${F.st.swingLo ? `低 ${fmt(F.st.swingLo, s.dp)}` : '—'}</div>
    <div class="v mut" style="font-size:10.5px;margin-top:4px">${F.st.bos ? `已${F.st.bos === 'up' ? '上破' : '下破'}摆动${F.st.bos === 'up' ? '高' : '低'}点` : '未突破'}${F.st.choch ? ` · CHoCH 转${F.st.choch === 'bull' ? '多' : '空'}` : ''}</div>
  </div>`;

  $('#mmGrid').innerHTML = fc + balCard + swCard + structCard;
  renderZones(el, s);                     // 价格带区间（做市商板块内的核心输出）
  $('#mmPlan').innerHTML = mmThesis(el, s) + '<br>' + mmPlan(el, s);
  $('#mmNote').innerHTML = '「扫单后反转」指做市商/主力为获取对手盘，先把价格推向止损密集的一侧，成交后再掉头 —— 表现为假突破。'
    + '该结论由清算热力图、K 线结构、MACD、OBV、BOLL 五项共同给出，<b>任一因子都不能单独定方向</b>。不构成投资建议。';
}

/* ============================ AiCoin · 1 小时多空爆单（建仓前提示） ============================ */
/* 接口：GET https://open.aicoin.com/api/v2/mix/liq        文档：docs.aicoin.com/apis/features
 * 鉴权：Signature = base64( hex( HMAC-SHA1(secret, "AccessKeyId=..&SignatureNonce=..&Timestamp=..") ) )
 * 返回：liq1h / liqLong1h / liqShort1h（1 小时爆仓量与多空分项）、liq24h 系列、maxLiq 等
 * 重要：该接口只给「爆仓量」，不给逐笔爆仓价格。价格部分由 1 小时清算热力图的关键带补齐，
 *       两者在 UI 上分别标注来源，绝不混称。                                                   */
let AC_KEY = localStorage.getItem('mb_ackey') || '';
let AC_SEC = localStorage.getItem('mb_acsec') || '';
const AC_BASE = 'https://open.aicoin.com/api';
const AC_TTL = 60000;   // 免费档 15 次/分钟、2 万次/月，故最低 60 秒缓存
// AiCoin 币种主键；用户可在「数据源」中覆盖（mb_ack_<sym>）。留空 = 该品种无对应数据，不伪造。
const AC_COIN = { BTC: 'btc', ETH: 'eth', BNB: 'bnb', XAUUSD: 'xau', UKOIL: 'oil' };
function acCoinKey(symId) {
  return String(localStorage.getItem('mb_ack_' + symId) || AC_COIN[symId] || '').trim();
}

/* 签名：HMAC-SHA1(secret, 待签串) → hex → base64。官方测试向量见 tests/_entry.js */
async function acSign(id, sec, nonce, ts) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(sec), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(`AccessKeyId=${id}&SignatureNonce=${nonce}&Timestamp=${ts}`));
  let hex = '';
  for (const b of new Uint8Array(raw)) hex += b.toString(16).padStart(2, '0');
  return btoa(hex);
}

async function fetchAicoinLiq(symId) {
  const coinKey = acCoinKey(symId);
  if (!coinKey) throw new Error('该品种无 AiCoin 币种主键');
  if (!AC_KEY || !AC_SEC) throw new Error('未配置 AiCoin Key / Secret');
  if (!crypto || !crypto.subtle) throw new Error('当前环境不支持 Web Crypto（需 https 或 localhost）');
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const sig = await acSign(AC_KEY, AC_SEC, nonce, ts);
  const q = new URLSearchParams({
    currency: 'usd', type: '1', coinKey,
    AccessKeyId: AC_KEY, SignatureNonce: nonce, Timestamp: String(ts), Signature: sig,
  });
  const r = await jgetH(`${AC_BASE}/v2/mix/liq?${q}`, { accept: 'application/json' }, 12000);
  if (!r) throw new Error('空响应');
  if (r.success === false || (r.errorCode != null && Number(r.errorCode) !== 200))
    throw new Error(r.error || ('errorCode ' + r.errorCode));
  const d = (r.data && (r.data.detail || r.data)) || {};
  const lg = num(d.liqLong1h), sh = num(d.liqShort1h);
  let tot = num(d.liq1h);
  if (lg == null && sh == null && tot == null) throw new Error('返回缺少 1 小时爆仓字段');
  if (tot == null || (lg != null && sh != null && tot < (lg + sh) * 0.98)) tot = (lg || 0) + (sh || 0);
  const lg24 = num(d.liqLong24h) || 0, sh24 = num(d.liqShort24h) || 0;
  let tot24 = num(d.liq24h);
  if (tot24 == null || tot24 < (lg24 + sh24) * 0.98) tot24 = lg24 + sh24;
  return {
    coinKey, ts: now(), grade: 'real', src: 'AiCoin · 真实爆仓统计',
    long1h: lg || 0, short1h: sh || 0, tot1h: tot || 0,
    long24h: lg24, short24h: sh24, tot24h: tot24,
    maxLiq: num(d.maxLiq), maxMarket: d.maxLiqMarket || d.liq24HMaxMarket || '',
  };
}

/* 取数（带缓存与失败原因）；无 Key / 无映射时不发请求，直接记录原因 */
async function loadAcLiq(symId) {
  const c = S.acLiq[symId];
  if (c && now() - c.ts < AC_TTL) return c;
  let out;
  try {
    out = await fetchAicoinLiq(symId);
  } catch (e) {
    out = { ts: now(), grade: 'none', src: 'AiCoin 未接入', err: e.message || String(e) };
  }
  S.acLiq[symId] = out;
  return out;
}

/* 降级：用 1 小时清算热力图的上下方清算池占比替代「多空爆单结构」。
   只有相对比例、没有真实金额，故 ratioOnly=true，UI 不显示美元额。 */
function acFallback(symId) {
  const h = (S.heats[symId] || {})['1h'];
  if (!h) return null;
  const px = (S.quotes[symId] && S.quotes[symId].price) || h.mid;
  const p = liqPools(h, px, 0);
  const tot = p.upRaw + p.dnRaw;
  if (!(tot > 0)) return null;
  return {
    ts: now(), grade: 'semi', src: '清算热力图推算 · 非真实爆仓额', ratioOnly: true,
    short1h: p.upRaw, long1h: p.dnRaw, tot1h: tot,      // 上方=空单清算，下方=多单清算
  };
}

/* --- 建仓前提示：把「1 小时多空爆单量」+「关键爆仓价位」+「1 小时方向」合成风险等级与建议 --- */
function entryAdvice(symId) {
  const s = SYMS[symId];
  const kd = S.klines[symId] && S.klines[symId]['1h'];
  const bars = (kd && kd.bars) || [];
  const px = (S.quotes[symId] && S.quotes[symId].price) || (bars.length ? bars[bars.length - 1].c : null);
  const rec = S.acLiq[symId] || null;
  const real = rec && rec.grade === 'real' ? rec : null;
  const liq = real || acFallback(symId);
  const sig = bars.length ? signalOf(symId, '1h', bars) : null;
  const L = sig && sig.liq;

  const out = {
    ok: !!liq, px, grade: liq ? liq.grade : 'none',
    src: liq ? liq.src : 'AiCoin 未接入',
    reason: !liq ? ((rec && rec.err) || '暂无爆仓数据（可配置 AiCoin Key 或等待热力图就绪）') : '',
    long1h: null, short1h: null, tot1h: null, shPct: 50, surge: null, ratioOnly: !real,
    bands: null, dir: sig ? sig.dir : 'wait', level: 'na', levelTxt: '数据不足', pos: 0,
    items: [], ts: liq ? liq.ts : now(), coinKey: real ? real.coinKey : '',
  };
  if (!liq || !px) return out;

  const lg = liq.long1h || 0, sh = liq.short1h || 0;
  const tot = liq.tot1h || (lg + sh);
  out.long1h = lg; out.short1h = sh; out.tot1h = tot;
  out.shPct = tot > 0 ? sh / tot * 100 : 50;
  if (real && liq.tot24h > 0) out.surge = tot / (liq.tot24h / 24);

  out.bands = {
    up: L && L.magUp ? { p: L.magUp.p, dpct: L.magUp.dpct, v: L.magUp.v } : null,
    dn: L && L.magDn ? { p: L.magDn.p, dpct: L.magDn.dpct, v: L.magDn.v } : null,
  };

  const items = [];
  let score = 0;

  /* 1) 主导方向：谁被爆了，价格就更容易朝那一侧继续被推 */
  const sp = out.shPct;
  if (sp >= 65) {
    items.push({ lv: 'warn', t: '主爆空单（轧空）',
      d: `近 1 小时空单爆仓占 ${sp.toFixed(0)}%，价格由空头回补推动上行。此时追多性价比低，容易买在回补尾声，建议等回踩关键位再介入。` });
  } else if (sp <= 35) {
    items.push({ lv: 'warn', t: '主爆多单（多杀多）',
      d: `近 1 小时多单爆仓占 ${(100 - sp).toFixed(0)}%，下跌由强平抛售推动。常见二次探底，不要在瀑布中途接刀，等清算量衰减并企稳再看。` });
  } else {
    items.push({ lv: 'ok', t: '多空双向爆仓',
      d: `多空爆仓占比 ${(100 - sp).toFixed(0)}% / ${sp.toFixed(0)}%，属于来回扫损的震荡结构，方向未明，轻仓或观望。` });
  }
  score += 1;      // 无论主爆哪侧，都意味着该侧正在被强制平仓，追单风险高于常态

  /* 2) 爆仓强度：与 24 小时的小时均量比 */
  if (out.surge != null) {
    const k = out.surge;
    if (k >= 3) { items.push({ lv: 'risk', t: '清算潮进行中', d: `当前 1 小时爆仓量是近 24 小时均量的 ${k.toFixed(1)} 倍，波动显著放大，滑点与插针风险高，建议把仓位压到平时的一半以下或暂缓建仓。` }); score += 3; }
    else if (k >= 2) { items.push({ lv: 'warn', t: '爆仓量明显放大', d: `为近 24 小时均量的 ${k.toFixed(1)} 倍，市场处于活跃清算阶段，止损要给足余量。` }); score += 2; }
    else if (k <= 0.5) { items.push({ lv: 'ok', t: '爆仓清淡', d: `仅为近 24 小时均量的 ${(k * 100).toFixed(0)}%，杠杆资金参与度低，行情缺乏推动力，突破的可靠性下降。` }); }
  }

  /* 3) 关键爆仓价位：现价是否贴在清算带上 */
  const bands = [];
  if (out.bands.up) bands.push({ side: 'up', ...out.bands.up });
  if (out.bands.dn) bands.push({ side: 'dn', ...out.bands.dn });
  const near = bands.filter(b => b.dpct != null).sort((a, b) => a.dpct - b.dpct)[0];
  if (near && near.dpct < 0.25) {
    items.push({ lv: 'risk', t: '现价紧贴清算带',
      d: `最近一条${near.side === 'up' ? '空单' : '多单'}清算带在 ${fmt(near.p, s.dp)}，距现价仅 ${near.dpct.toFixed(2)}%。价格正在测试爆仓密集区，极易先插针扫损再走，建议等价格离开该带（≥0.3%）再建仓。` });
    score += 2;
  } else if (near) {
    items.push({ lv: 'ok', t: '关键爆仓价位',
      d: `上方空单清算带 ${out.bands.up ? fmt(out.bands.up.p, s.dp) + `（距 ${out.bands.up.dpct.toFixed(2)}%）` : '—'}；下方多单清算带 ${out.bands.dn ? fmt(out.bands.dn.p, s.dp) + `（距 ${out.bands.dn.dpct.toFixed(2)}%）` : '—'}。价格触及任一侧都可能加速，止损建议设在关键带之外。` });
  }

  /* 4) 与 1 小时方向是否一致 */
  const dir = out.dir;
  const dirTxt = dir === 'long' ? '做多' : dir === 'short' ? '做空' : '观望';
  const bullSqueeze = sp >= 65, bearCascade = sp <= 35;
  let align = 'na';
  if (dir === 'long' && bullSqueeze) align = 'yes';
  else if (dir === 'short' && bearCascade) align = 'yes';
  else if (dir === 'long' && bearCascade) align = 'no';
  else if (dir === 'short' && bullSqueeze) align = 'no';
  if (align === 'yes') {
    items.push({ lv: 'ok', t: '与 1 小时方向一致', d: `1 小时方向为${dirTxt}，爆仓结构（${bullSqueeze ? '轧空' : '多杀多'}）与之同向，方向得到清算面支撑。` });
  } else if (align === 'no') {
    items.push({ lv: 'risk', t: '与 1 小时方向背离',
      d: `1 小时方向为${dirTxt}，但爆仓结构是${bullSqueeze ? '轧空（利多）' : '多杀多（利空）'}，两者相反。清算面不支持该方向，建议等背离修复或降低仓位。` });
    score += 2;
  } else {
    items.push({ lv: 'ok', t: `1 小时方向：${dirTxt}`, d: '爆仓结构与方向不构成明确共振，按信号本身执行即可，注意止损。' });
  }

  out.level = score >= 3 ? 'risk' : score >= 1 ? 'warn' : 'ok';
  out.levelTxt = out.level === 'risk' ? '高风险 · 建议暂缓' : out.level === 'warn' ? '需谨慎 · 降低仓位' : '风险可控';
  let pos = out.level === 'risk' ? 10 : out.level === 'warn' ? 20 : 30;
  if (align === 'no') pos *= 0.6;
  out.pos = Math.round(clamp(pos, 5, 40));
  out.items = items;
  return out;
}

/* --- 渲染：建仓前提示 --- */
const usd = v => {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
};
const dirWord = d => d === 'long' ? '做多' : d === 'short' ? '做空' : '观望';
const dirCls = d => d === 'long' ? 'up' : d === 'short' ? 'down' : 'flat';

function renderEntry() {
  const a = entryAdvice(S.sym);
  const srcEl = $('#entSrc');
  srcEl.textContent = a.src;
  srcEl.className = 'src ' + (a.grade === 'real' ? 'real' : a.grade === 'semi' ? 'syn' : '');
  $('#entTs').textContent = a.ok ? new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';

  $('#entHd').innerHTML = a.ok
    ? `<span class="ent-lv ${a.level}">${a.levelTxt}</span>` +
      `<span class="mut" style="font-size:11px">1 小时方向 <b class="${dirCls(a.dir)}">${dirWord(a.dir)}</b></span>` +
      `<span class="ent-pos">建议仓位 ≤ 保证金的 <b>${a.pos}%</b></span>`
    : `<span class="ent-lv na">数据不足</span>` +
      `<span class="mut" style="font-size:11px">${a.reason}</span>`;

  if (!a.ok) {
    $('#entBar').innerHTML = ''; $('#entBl').innerHTML = '';
    $('#entStats').innerHTML = ''; $('#entItems').innerHTML = '';
    $('#entNote').innerHTML =
      '爆仓「量」取自 AiCoin 开放 API <b>/v2/mix/liq</b>（1 小时多空分项爆仓额），' +
      '爆仓「价」取自本页 1 小时筹码清算热力图的关键带，两者在下方分别标注来源。' +
      '点右上角「配置 AiCoin」填入密钥后取真实数据；未配置时退化为热力图推算（只显示占比、不显示金额）。' +
      '以上仅为风险提示，不构成投资建议。';
    return;
  }

  const lgPct = a.tot1h > 0 ? a.long1h / a.tot1h * 100 : 50;
  const shPct = a.tot1h > 0 ? a.short1h / a.tot1h * 100 : 50;
  $('#entBar').innerHTML =
    `<i class="l" style="width:${lgPct.toFixed(2)}%"></i><i class="s" style="width:${shPct.toFixed(2)}%"></i>`;
  $('#entBl').innerHTML =
    `<span class="up">多单爆仓 ${lgPct.toFixed(0)}%</span>` +
    `<span class="down">空单爆仓 ${shPct.toFixed(0)}%</span>`;

  const stat = (k, v, cls) => `<div><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`;
  $('#entStats').innerHTML =
    stat('近 1 小时多单爆仓', a.ratioOnly ? lgPct.toFixed(0) + '%' : usd(a.long1h), 'up') +
    stat('近 1 小时空单爆仓', a.ratioOnly ? shPct.toFixed(0) + '%' : usd(a.short1h), 'down') +
    stat('爆仓强度 vs 24h 均量', a.surge == null ? '—' : a.surge.toFixed(1) + '×',
      a.surge == null ? '' : a.surge >= 2 ? 'down' : a.surge <= 0.5 ? 'flat' : '');

  $('#entItems').innerHTML = a.items.map(i =>
    `<div class="ent-i ${i.lv}"><span class="b"></span><span><span class="t">${i.t}</span>${i.d}</span></div>`
  ).join('');

  $('#entNote').innerHTML = a.ratioOnly
    ? '当前比例由 <b>1 小时清算热力图</b> 推算，<b>不是真实爆仓金额</b>；爆仓价位同样来自热力图关键带。' +
      '点「配置 AiCoin」填入密钥后可取真实的 1 小时多空爆仓额。仅为风险提示，不构成投资建议。'
    : `爆仓「量」：<b>AiCoin 开放 API /v2/mix/liq</b>${a.coinKey ? `（币种 ${a.coinKey}）` : ''}，1 小时多空分项真实统计；` +
      '爆仓「价」：本页 <b>1 小时筹码清算热力图</b> 的关键带（该接口不返回逐笔爆仓价格）。' +
      'AiCoin 免费档 15 次/分钟、2 万次/月，本页已按 60 秒缓存。仅为风险提示，不构成投资建议。';
}

function bindEntry() {
  const btn = $('#entCfg');
  if (!btn) return;
  btn.onclick = () => {
  const cur = AC_KEY && AC_SEC ? `${AC_KEY},${AC_SEC}` : '';
  const v = prompt(
    '填写 AiCoin 开放 API 密钥（aicoin.com/opendata 免费申请）\n\n' +
    '格式：AccessKeyId,AccessSecret（英文逗号分隔）\n\n' +
    '· 该接口无 CORS 头，还需在右上角「数据源」中配置代理模板\n' +
    '· 接口只返回爆仓「量」，不返回逐笔爆仓价格，价格部分由清算热力图补齐\n' +
    '· 免费档 15 次/分钟、2 万次/月，本页已按 60 秒缓存\n' +
    '· 密钥仅保存在本机浏览器，不会上传；请勿在他人设备上保存\n\n' +
    '留空则清除。', cur);
  if (v == null) return;
  const parts = String(v).split(/[,，\s]+/).map(x => (x || '').trim());
  AC_KEY = parts[0] || ''; AC_SEC = parts[1] || '';
  localStorage.setItem('mb_ackey', AC_KEY);
  localStorage.setItem('mb_acsec', AC_SEC);
  delete S.acLiq[S.sym];                       // 作废缓存，立即用新密钥重取
  loadAcLiq(S.sym).then(() => { if (S.sym) renderEntry(); });
  };
}

/* ============================ 多空筹码热力图 ============================ */
// 三条数据链路（界面显式标注来源，绝不把估算伪装成真实清算数据）：
//   1) Coinglass —— 真实清算记录，需自备 API Key + CORS 代理
//   2) Binance 合约 —— 真实 K 线成交量分布 + 真实多空持仓比/主动买卖比，按杠杆推算清算密集区
//   3) 本地估算 —— K 线不可用时用合成序列，标注「非真实」
let CG_KEY   = localStorage.getItem('mb_cgkey') || '';
let HEAT_MODE= localStorage.getItem('mb_heatsrc') || 'auto';
const HEAT_LEV = [[10, .45], [25, .32], [50, .23]];   // 参考杠杆与权重（跨度未知时兜底）
// 周期不同，关注的价格尺度不同：短周期看近处的高杠杆清算，长周期看更远的结构
const TF_SPAN = { '15m': 0.020, '30m': 0.028, '1h': 0.040, '4h': 0.070 };
// 位移幅度必须与图跨度匹配：跨度只有 4% 时，10x 仓位的清算位（−10%）根本不在图上，
// 硬塞到边界档会造出一堵假的「清算墙」，让方向系统性偏空。改为按跨度反推可见杠杆。
function levForSpan(halfFrac) {
  if (!(halfFrac > 0)) return HEAT_LEV;
  const base = clamp(1 / halfFrac, 2, 500);
  return [[base, .45], [base * 2, .32], [base * 4, .23]].map(([l, w]) => [clamp(l, 2, 500), w]);
}
const HEAT_NB = 60;      // 价格档数
const HEAT_NT = 72;      // 时间列数上限
const HEAT_MIN_SPAN = 0.030, HEAT_MAX_SPAN = 0.16;
const HEAT_LS = {};      // 多空比缓存
const MONO = "'SF Mono','JetBrains Mono',Menlo,Consolas,monospace";

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

/* --- 1) Coinglass 真实清算记录 --- */
async function fetchCoinglassLiq(symId) {
  const s = SYMS[symId];
  if (!binSym(s)) throw new Error('该品种 Coinglass 无合约映射');
  if (!CG_KEY) throw new Error('未配置 Coinglass API Key');
  const url = `https://open-api-v3.coinglass.com/api/futures/liquidation/history?symbol=${binSym(s)}&interval=1h`;
  const r = await jgetH(url, { coinglassSecret: CG_KEY, accept: 'application/json' }, 12000);
  if (!r) throw new Error('空响应');
  if (r.code != null && String(r.code) !== '0') throw new Error(r.msg || ('code ' + r.code));

  let arr = r.data;
  if (!Array.isArray(arr)) {
    if (arr && Array.isArray(arr.list)) arr = arr.list;
    else if (arr && Array.isArray(arr.data)) arr = arr.data;
    else throw new Error('返回结构无法解析');
  }
  const out = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const price = num(o.price ?? o.p ?? o.liquidationPrice ?? o.avgPrice ?? o.markPrice);
    const vol   = num(o.volUsd ?? o.usd ?? o.amount ?? o.vol ?? o.qty ?? o.size ?? o.volume);
    const time  = num(o.time ?? o.t ?? o.timestamp ?? o.createTime ?? o.createdAt);
    const sd    = String(o.side ?? o.direction ?? o.type ?? o.liquidationSide ?? '').toUpperCase();
    if (!(price > 0)) continue;
    let side = null;
    if (/^L$|^LONG|^BUY/.test(sd)) side = 'long';
    else if (/^S$|^SHORT|^SELL/.test(sd)) side = 'short';
    out.push({ price, vol: vol == null ? 1 : Math.abs(vol), time: time || null, side });
  }
  if (out.length < 5) throw new Error('有效清算记录不足 5 条（仅 ' + out.length + ' 条）');
  return out;
}

/* --- 2) 币安真实多空持仓比 / 主动买卖比 --- */
async function fetchBinanceLS(symId) {
  const s = SYMS[symId];
  if (!binSym(s)) return null;
  const c = HEAT_LS[symId];
  if (c && now() - c.ts < 300000) return c;
  const [g, t] = await Promise.all([
    jget(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${binSym(s)}&period=1h&limit=1`).catch(() => null),
    jget(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${binSym(s)}&period=1h&limit=1`).catch(() => null),
  ]);
  const ls = num(Array.isArray(g) && g[0] ? g[0].longShortRatio : null);
  const tk = num(Array.isArray(t) && t[0] ? t[0].buySellRatio : null);
  if (ls == null && tk == null) return null;
  const r = { ls, tk, ts: now() };
  HEAT_LS[symId] = r;
  return r;
}

/* --- 价格区间：以现价为中心，限制在 [3%, 16%] --- */
function heatRange(mid, lo, hi, minSpan = HEAT_MIN_SPAN) {
  let pLo = Math.min(lo, mid * (1 - minSpan * 0.6));
  let pHi = Math.max(hi, mid * (1 + minSpan * 0.6));
  const maxS = mid * HEAT_MAX_SPAN;
  if (pHi - pLo > maxS) {
    if (mid - pLo > maxS * 0.62) pLo = mid - maxS * 0.62;
    if (pHi - mid > maxS * 0.38) pHi = mid + maxS * 0.38;
    if (pHi - pLo > maxS) pHi = pLo + maxS;
  }
  if (!(pHi > pLo && isFinite(pLo) && isFinite(pHi))) { pLo = mid * 0.97; pHi = mid * 1.03; }
  return [pLo, pHi];
}

/* --- 由 K 线构建：成交量在价格上的分布 + 杠杆位移到清算位 --- */
function buildHeatFromBars(bars, px, lsInfo, label, grade, minSpan) {
  const use = bars.slice(-HEAT_NT);
  const n = use.length;
  if (n < 5) return null;
  const mid = num(px);
  if (!(mid > 0)) return null;

  let lo = Infinity, hi = -Infinity;
  for (const b of use) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const [pLo, pHi] = heatRange(mid, lo, hi, minSpan);
  const step = (pHi - pLo) / HEAT_NB;
  if (!(step > 0)) return null;
  const idxOf = p => (p - pLo) / step - 0.5;

  // 成交量按 K 线区间铺开：买方把价格从 low 推到 close，卖方从 high 压到 close。
  // 买卖力量用收盘位置 CLV=(2C-H-L)/(H-L) 划分，避免 K 线落在区间外时误判多空。
  const half = Math.max(6, n / 3);
  const gL = [], gS = [];
  const put = (arr, a, z, amt) => {
    if (!(amt > 0)) return;
    let i0 = Math.floor((Math.min(a, z) - pLo) / step), i1 = Math.ceil((Math.max(a, z) - pLo) / step);
    i0 = Math.max(0, Math.min(HEAT_NB - 1, i0));
    i1 = Math.max(0, Math.min(HEAT_NB - 1, i1));
    const sh = amt / (i1 - i0 + 1);
    if (!isFinite(sh)) return;
    for (let i = i0; i <= i1; i++) arr[i] += sh;
  };
  for (let j = 0; j < n; j++) {
    const b = use[j];
    const L = new Float64Array(HEAT_NB), Sx = new Float64Array(HEAT_NB);
    gL.push(L); gS.push(Sx);
    // 只统计落在可见价格区间的成交部分，避免区间外 K 线把量全压到边界档
    const ovl = Math.min(b.h, pHi) - Math.max(b.l, pLo);
    const vis = b.h > b.l ? clamp(ovl / (b.h - b.l), 0, 1) : (b.l >= pLo && b.l <= pHi ? 1 : 0);
    if (!(vis > 0)) continue;
    const w = (b.v > 0 ? b.v : 0) * Math.pow(0.5, (n - 1 - j) / half) * vis;
    const rng = b.h - b.l;
    let clv = rng > 0 ? (2 * b.c - b.h - b.l) / rng : (b.c >= b.o ? 1 : -1);
    clv = clamp(isFinite(clv) ? clv : 0, -1, 1);
    const shareL = (1 + clv) / 2;
    put(L, b.l, b.c, w * shareL);            // 多头筹码：低位买入区
    put(Sx, b.c, b.h, w * (1 - shareL));     // 空头筹码：高位卖出区
  }

  // 清算位移：多单清算价 = 开仓价×(1−1/杠杆)，空单 = 开仓价×(1+1/杠杆)。
  // 落在图外的位移直接丢弃（夹到边界会造出假墙）；丢弃后按原总量等比还原，
  // 保证多空两侧总量守恒，可见性只改变分布形状，不制造方向偏差。
  const halfFrac = (pHi - pLo) / 2 / mid;
  const levs = levForSpan(halfFrac);
  const shift = (src, dir) => {
    const out = new Float64Array(HEAT_NB);
    let srcTot = 0;
    for (let i = 0; i < HEAT_NB; i++) srcTot += src[i] > 0 ? src[i] : 0;
    if (!(srcTot > 0)) return out;
    for (const [lev, wt] of levs) {
      const k = dir < 0 ? (1 - 1 / lev) : (1 + 1 / lev);
      if (!(k > 0)) continue;
      for (let i = 0; i < HEAT_NB; i++) {
        const fi = idxOf((pLo + (i + 0.5) * step) / k);
        if (fi < -0.5 || fi > HEAT_NB - 0.5) continue;     // 图外：不计入
        const a = Math.max(0, Math.min(HEAT_NB - 1, Math.floor(fi)));
        const b2 = Math.max(0, Math.min(HEAT_NB - 1, a + 1));
        const f = clamp(fi - a, 0, 1);
        out[i] += wt * (src[a] * (1 - f) + src[b2] * f);
      }
    }
    let sum = 0;
    for (let i = 0; i < HEAT_NB; i++) sum += out[i];
    if (sum > 0) { const r = srcTot / sum; for (let i = 0; i < HEAT_NB; i++) out[i] *= r; }
    return out;
  };

  const grid = [];
  let maxV = 0;
  for (let j = 0; j < n; j++) {
    const L = shift(gL[j], -1), Sx = shift(gS[j], 1), row = [];
    for (let i = 0; i < HEAT_NB; i++) {
      const l = L[i] > 0 ? L[i] : 0, s = Sx[i] > 0 ? Sx[i] : 0;
      row.push({ l, s });
      if (l + s > maxV) maxV = l + s;
    }
    grid.push(row);
  }

  // 用真实多空持仓比校准多空总量：几何分配只决定「谁在上谁在下」，
  // 偏向（谁多谁少）交由交易所真实多空比决定，避免纯几何推测造成偏差。
  let tl = 0, ts = 0;
  for (const row of grid) for (const c of row) { tl += c.l; ts += c.s; }
  h_lsCalib: if (lsInfo && lsInfo.ls > 0 && tl + ts > 0) {
    // 真实多空比长期偏向多头（散户结构），全额校准会让下方燃料永远更厚、方向长期看空。
    // 先向 50% 收缩再校准：保留真实偏向，避免把「多头多」直接等价成「该做空」。
    const raw = clamp(lsInfo.ls / (1 + lsInfo.ls), 0.15, 0.85);
    const target = clamp(0.5 + (raw - 0.5) * 0.65, 0.2, 0.8);
    const cur = tl / (tl + ts);
    if (!(cur > 0.01 && cur < 0.99)) break h_lsCalib;
    const tot = tl + ts;
    const fl = clamp(tot * target / tl, 0.1, 10), fs = clamp(tot * (1 - target) / ts, 0.1, 10);
    for (const row of grid) for (const c of row) { c.l *= fl; c.s *= fs; }
    tl *= fl; ts *= fs;
  }
  maxV = 0;
  for (const row of grid) for (const c of row) if (c.l + c.s > maxV) maxV = c.l + c.s;

  const rows = [];
  for (let i = 0; i < HEAT_NB; i++) {
    let l = 0, s = 0;
    for (const row of grid) { l += row[i].l; s += row[i].s; }
    rows.push({ p: pLo + (i + 0.5) * step, long: l, short: s });
  }
  return finishHeat({ grid, rows, pLo, pHi, step, px: mid, maxV, times: use.map(b => b.t),
                      label, grade, lsInfo, levs: levs.map(l => Math.round(l[0])) });
}

/* ---------- 清算引力模型：由筹码热力图反推多空方向 ---------- */
// 核心假设（Coinglass 清算热力图的通行读法）：流动性会朝「清算燃料更近更厚」的一侧运动。
//   现价上方堆积的是空单清算位 → 需要价格上行才被击穿 → 击穿后强平回补形成轧空加速 = 偏多引力
//   现价下方堆积的是多单清算位 → 需要价格下行才被击穿 → 击穿后强平抛售形成多杀多 = 偏空引力
// 打分构成：清算池引力 ±52 > 近端清算墙 ±22 > 趋势确认 ±18 > 资金费率 ±12 > 多空持仓比 ±10
// 趋势只做确认不做主导，避免与清算结论互相抵消；样本外无法验证，仅作方向参考。
// 距离尺度：以热力图半跨为主、ATR 兜底。用 ATR 直接归一会让短周期的距离全部放大到几十 ATR，
// 衰减失去分辨力；用图跨度则 15m 与 4h 可比，语义就是「在图上的远近」。
function heatScaleOf(heat, atrV) {
  const half = (isFinite(heat.pHi) && isFinite(heat.pLo) && heat.pHi > heat.pLo)
    ? (heat.pHi - heat.pLo) * 0.5 : 0;
  const a = atrV > 0 ? atrV : 0;
  const s = Math.max(half, a);
  return s > 0 ? s : 1;
}

function liqPools(heat, px, atrV) {
  const sc0 = heatScaleOf(heat, atrV);
  let up = 0, dn = 0, upRaw = 0, dnRaw = 0, tot = 0;
  for (const r of heat.rows || []) {
    const l = r.long > 0 ? r.long : 0, s = r.short > 0 ? r.short : 0;
    tot += l + s;
    const w = 1 / (1 + Math.abs(r.p - px) / sc0 * 1.2);   // 距离衰减：近处燃料更有吸引力
    if (r.p > px) { up += s * w; upRaw += s; }
    else if (r.p < px) { dn += l * w; dnRaw += l; }
  }
  return { up, dn, upRaw, dnRaw, tot,
           upPct: tot > 0 ? upRaw / tot * 100 : 0,
           dnPct: tot > 0 ? dnRaw / tot * 100 : 0 };
}

// 找现价上下两侧「最近且够厚」的清算密集带，作为磁吸目标与失效位
function magnetBands(heat, px, atrV) {
  const rows = heat.rows || [];
  const n = rows.length;
  if (!n || !(heat.step > 0)) return { up: null, dn: null };
  const a = atrV > 0 ? atrV : px * 0.004;
  const sc0 = heatScaleOf(heat, atrV);
  const win = Math.max(3, Math.round(n * 0.06));
  const s = rows.map(r => (r.long > 0 ? r.long : 0) + (r.short > 0 ? r.short : 0));
  let mx = 0; for (const v of s) if (v > mx) mx = v;
  if (!(mx > 0)) return { up: null, dn: null };

  const pick = side => {
    let best = null;
    for (let i = 0; i + win <= n; i++) {
      let t = 0; for (let k = i; k < i + win; k++) t += s[k];
      const v = t / (mx * win);
      if (!(v >= 0.32)) continue;
      const p = heat.pLo + (i + win / 2) * heat.step;
      // 中心落在现价所在档附近的带不构成「磁吸」，必须离开现价至少 0.75 档
      const off = (p - px) / heat.step;
      if (side > 0 ? off < 0.75 : off > -0.75) continue;
      const d = Math.max(0.15, Math.abs(p - px) / sc0);
      const dpct = Math.abs(p / px - 1) * 100;          // 价格偏离百分比，跨周期可比
      const score = v / (1 + d * 0.9);
      if (!best || score > best.score) best = { p, v, d, dpct, score };
    }
    return best;
  };
  return { up: pick(1), dn: pick(-1) };
}

/* 价格带区间：把热力图里「连续的高密度档」合并成带，给出 [lo,hi]、强度、宽度与距现价百分比。
 * 只给一个中心价是不够的 —— 止损是成片堆在那里的，做市商扫的是一整个区间而不是一个点。
 * 返回按 score（强且近）降序排列的带列表。 */
function liqZones(heat, px, atrV, opt = {}) {
  const rows = (heat && heat.rows) || [];
  const n = rows.length;
  if (!heat || !n || !(heat.step > 0)) return [];
  const a = atrV > 0 ? atrV : px * 0.004;
  const sc0 = heatScaleOf(heat, atrV);
  const tot = rows.map(r => (r.long > 0 ? r.long : 0) + (r.short > 0 ? r.short : 0));
  let mx = 0; for (const v of tot) if (v > mx) mx = v;
  if (!(mx > 0)) return [];

  // 3 点平滑，避免单档噪声造出假峰
  const sm = tot.map((v, i) => {
    let t = v, c = 1;
    if (i > 0) { t += tot[i - 1]; c++; }
    if (i < n - 1) { t += tot[i + 1]; c++; }
    return t / c;
  });
  let smx = 0; for (const v of sm) if (v > smx) smx = v;
  if (!(smx > 0)) return [];

  const thr = opt.thr != null ? opt.thr : 0.22;        // 相对峰值的入门门槛
  const maxW = Math.max(3, Math.round(n * 0.34));      // 再宽就不是「带」而是整张图了
  const ipx = clamp(Math.floor((px - heat.pLo) / heat.step), -1, n);

  /* 局部峰 → 半高扩展。
   * 不能简单取「所有高于阈值的连续档」：清算密度从现价向外单调衰减，
   * 那样会把半张图并成一条巨宽的带（实测宽 142 个 ATR），完全失去定位意义。 */
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] / smx < thr) continue;
    if (sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && (sm[i] > sm[i - 1] || sm[i] > sm[i + 1])) peaks.push(i);
  }
  /* 近价兜底：密度从现价向外单调衰减时，某一侧的「峰」就在现价本身，
   * 于是那侧一个局部峰都找不到 —— 实测出现过「只识别出下方带、上方带为空」。
   * 而做市商最关心的恰恰是紧邻现价的这批止损，所以把现价两侧各补一个种子峰。
   * 补出来的带随后会在现价处被切成上下两半，不会退化成一条跨现价的巨带。 */
  for (const i of [ipx, ipx + 1]) {
    if (i < 0 || i > n - 1 || peaks.indexOf(i) >= 0) continue;
    if (sm[i] / smx >= thr) peaks.push(i);
  }
  if (!peaks.length) {                                  // 单调序列：峰值那一档就是唯一的带
    let bi = 0; for (let i = 1; i < n; i++) if (sm[i] > sm[bi]) bi = i;
    if (sm[bi] / smx >= thr) peaks.push(bi);
  }

  const segs = [];
  for (const pi of peaks) {
    const floorV = Math.max(sm[pi] * 0.55, smx * thr * 0.9);
    let i0 = pi, i1 = pi;
    while (i0 - 1 >= 0 && sm[i0 - 1] >= floorV && i1 - i0 + 1 < maxW) i0--;
    while (i1 + 1 < n && sm[i1 + 1] >= floorV && i1 - i0 + 1 < maxW) i1++;
    // 与已有区间重叠则合并，避免同一片止损被拆成两条带
    const hit = segs.find(s => i0 <= s.i1 + 1 && i1 >= s.i0 - 1);
    if (hit) { hit.i0 = Math.min(hit.i0, i0); hit.i1 = Math.max(hit.i1, i1); hit.pi = sm[pi] > sm[hit.pi] ? pi : hit.pi; continue; }
    segs.push({ i0, i1, pi });
  }

  const out = [];
  const minW = Math.min(2, Math.max(1, Math.round(n * 0.03)));

  /* 先在现价处切成上下两半，再让每一半各自围绕「段内真实峰值」收敛。
   * 顺序不能颠倒：
   *   · 跨越现价的带必须先切开 —— 价格已经在带里就谈不上「磁吸」；
   *   · 收敛必须放在切开之后 —— 若先按全局峰值收敛，弱的一侧会被强的一侧整段吞掉，
   *     实测出现过「只识别出下方带、上方带为空」；
   *   · 种子峰（紧邻现价那一档）的平滑值常被对侧空白拉低，直接拿它算半高门槛
   *     会得到过低的门槛，把整条下侧并成 10 个 ATR 的宽带。按段内峰值重算即可收敛。 */
  const halves = [];
  for (const sg of segs) {
    if (ipx >= sg.i0 && ipx <= sg.i1) halves.push([sg.i0, ipx - 1], [ipx + 1, sg.i1]);
    else halves.push([sg.i0, sg.i1]);
  }
  for (let [i0, i1] of halves) {
    if (i1 - i0 + 1 < minW) continue;
    let pi = i0;
    for (let i = i0; i <= i1; i++) if (sm[i] > sm[pi]) pi = i;
    const floorV = Math.max(sm[pi] * 0.55, smx * thr * 0.9);
    let a0 = pi, a1 = pi;
    while (a0 - 1 >= i0 && sm[a0 - 1] >= floorV && a1 - a0 + 1 < maxW) a0--;
    while (a1 + 1 <= i1 && sm[a1 + 1] >= floorV && a1 - a0 + 1 < maxW) a1++;
    i0 = a0; i1 = a1;
    if (i1 - i0 + 1 < minW) continue;
    {
      const lo = heat.pLo + i0 * heat.step;
      const hi = heat.pLo + (i1 + 1) * heat.step;
      if (!(hi > lo)) continue;
      let t = 0, pv = 0;
      for (let k = i0; k <= i1; k++) { t += tot[k]; if (sm[k] > pv) pv = sm[k]; }
      const mid = (lo + hi) / 2;
      const v = clamp(pv / smx, 0, 1);                   // 带内峰值相对强度
      const d = Math.max(0.15, Math.abs(mid - px) / sc0);
      out.push({
        lo, hi, mid, w: hi - lo,
        side: mid >= px ? 'up' : 'down',
        v,
        mass: clamp(t / (mx * n) * 4.5, 0, 1),           // 该带占全图燃料的比例（放大后便于展示）
        atrW: a > 0 ? (hi - lo) / a : 0,                 // 带宽折合多少个 ATR
        dpct: (mid / px - 1) * 100,                      // 带中心距现价百分比（带符号）
        d, i0, i1,
        score: v / (1 + d * 0.9),
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function liqSignal(bars, heat, opt = {}) {
  const c = bars.map(b => b.c);
  const i = c.length - 1;
  const px = c[i];
  const dp = isFinite(opt.dp) ? opt.dp : 2;
  const A = atr(bars);
  const a = A[i] > 0 ? A[i] : px * 0.004;
  const atrPct = a / px * 100;
  const P = liqPools(heat, px, a);
  const M = magnetBands(heat, px, a);
  const fund = isFinite(opt.funding) ? opt.funding : null;
  const ls = isFinite(opt.ls) && opt.ls > 0 ? opt.ls : null;

  let sc = 0;
  const parts = [];
  const add = (k, v) => { if (isFinite(v)) { sc += v; parts.push({ k, v: +v.toFixed(2) }); } };

  // 1) 清算池引力差：多空两侧燃料之差（距离加权）
  const tot = P.up + P.dn;
  if (tot > 0) add('清算池引力', clamp((P.up - P.dn) / tot, -1, 1) * 52);

  // 2) 近端清算墙：更近更厚的那一侧先被吃掉
  const nUp = M.up ? M.up.v / (1 + M.up.d * 0.9) : 0;
  const nDn = M.dn ? M.dn.v / (1 + M.dn.d * 0.9) : 0;
  if (nUp + nDn > 0) add('近端清算墙', clamp((nUp - nDn) / (nUp + nDn), -1, 1) * 22);

  // 3) 资金费率：多头付费（正）说明多头拥挤，回撤时更容易连锁强平
  if (fund != null) add('资金费率', -clamp(fund / 0.0006, -1, 1) * 12);

  // 4) 多空持仓比不再单独计分：它已通过筹码校准进入清算池（多头占比高 → 下方燃料厚），
  //    再扣一次会让所有品种系统性偏空。仅在依据中展示。

  // 5) 趋势确认：与清算方向一致才有效，权重低于清算项
  // tanh 压缩：低波动时的小幅噪声不会把趋势项直接打满
  const mom = i >= 10 ? (px / c[i - 10] - 1) * 100 : 0;
  let tn = atrPct > 0 ? Math.tanh(mom / (atrPct * Math.sqrt(10))) : 0;
  const ma = sma(c, 25)[i];
  tn = clamp(ma != null ? tn * 0.8 + (px > ma ? 0.2 : -0.2) : tn, -1, 1);
  add('趋势确认', tn * 18);

  sc = clamp(sc, -100, 100);
  const dir = sc > 16 ? 'long' : sc < -16 ? 'short' : 'wait';

  // 关键位：顺方向的清算带 = 目标，反方向的清算带 = 失效位
  const magUp = M.up, magDn = M.dn;
  let trigger = null, tp = null, sl = null;
  const stepPx = heat.step > 0 ? heat.step : a * 0.3;
  if (dir === 'long') {
    trigger = magUp ? magUp.p : px + a * 0.8;
    tp = (magUp ? magUp.p : px + a * 1.6) + Math.max(a * 0.5, stepPx * 2);
    sl = magDn ? magDn.p - a * 0.25 : px - a * 1.5;
  } else if (dir === 'short') {
    trigger = magDn ? magDn.p : px - a * 0.8;
    tp = (magDn ? magDn.p : px - a * 1.6) - Math.max(a * 0.5, stepPx * 2);
    sl = magUp ? magUp.p + a * 0.25 : px + a * 1.5;
  }
  if (dir === 'long' && !(sl < px && tp > px)) { sl = px - a * 1.5; tp = px + a * 2.4; }
  if (dir === 'short' && !(sl > px && tp < px)) { sl = px + a * 1.5; tp = px - a * 2.4; }
  if (dir === 'wait') { trigger = null; sl = px - a * 2.0; tp = px + a * 2.0; }
  if (!isFinite(sl)) sl = px - a * 1.5;
  if (!isFinite(tp)) tp = px + a * 1.5;

  const rs = [];
  rs.push(`上方空单清算 ${fmt(P.upPct, 1)}% / 下方多单清算 ${fmt(P.dnPct, 1)}%`);
  if (magUp) rs.push(`上方 ${fmt(magUp.p, dp)} 有清算密集带（强度 ${Math.round(magUp.v * 100)}%，距现价 ${fmt(magUp.dpct, 2)}%）`);
  if (magDn) rs.push(`下方 ${fmt(magDn.p, dp)} 有清算密集带（强度 ${Math.round(magDn.v * 100)}%，距现价 ${fmt(magDn.dpct, 2)}%）`);
  if (fund != null) rs.push(`资金费率 ${(fund * 100).toFixed(4)}%（${fund >= 0 ? '多头付费 · 拥挤偏多' : '空头付费 · 拥挤偏空'}）`);
  if (ls != null) rs.push(`多空持仓比 ${fmt(ls, 2)}${ls > 1.4 ? '（多头拥挤，已计入下方燃料）' : ls < 0.8 ? '（空头拥挤）' : ''}`);
  rs.push(`趋势${(tn >= 0 ? '向上' : '向下')}${dir === 'wait' ? '' : ((dir === 'long') === (tn >= 0) ? ' · 与清算方向一致' : ' · 与清算方向背离')}`);

  return {
    dir, score: sc, strength: Math.abs(sc), px, atr: a, atrPct, mom, trend: tn,
    up: P.up, dn: P.dn, upPct: P.upPct, dnPct: P.dnPct,
    netBias: heat.netBias, funding: fund, ls,
    magUp, magDn, trigger, tp, sl, parts, reasons: rs,
    posPct: clamp(1.0 / (1.6 * atrPct) * 10, 5, 60),
  };
}

/* --- 由 Coinglass 清算记录构建 --- */
function buildHeatFromCG(list, px, minSpan) {
  const mid = num(px);
  if (!(mid > 0) || !list.length) return null;
  let lo = Infinity, hi = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const o of list) {
    if (o.price < lo) lo = o.price;
    if (o.price > hi) hi = o.price;
    if (o.time != null) { if (o.time < t0) t0 = o.time; if (o.time > t1) t1 = o.time; }
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const [pLo, pHi] = heatRange(mid, lo, hi, minSpan);
  const step = (pHi - pLo) / HEAT_NB;
  if (!(step > 0)) return null;

  const hasT = isFinite(t0) && t1 > t0;
  const nCol = Math.min(HEAT_NT, Math.max(12, Math.round(Math.sqrt(list.length) * 3)));
  const grid = Array.from({ length: nCol }, () => Array.from({ length: HEAT_NB }, () => ({ l: 0, s: 0 })));
  let maxV = 0;
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const price = num(o.price ?? o.p ?? o.liquidationPrice ?? o.avgPrice);
    if (!(price > 0)) continue;
    const vol = Math.abs(num(o.vol ?? o.volUsd ?? o.usd ?? o.amount ?? o.qty ?? o.size ?? 1)) || 1;
    const sd = String(o.side ?? o.direction ?? o.type ?? '').toUpperCase();
    const j = hasT ? clamp(Math.floor((o.time - t0) / (t1 - t0) * nCol), 0, nCol - 1) : nCol - 1;
    const i = clamp(Math.floor((price - pLo) / step), 0, HEAT_NB - 1);
    const c = grid[j][i];
    if (/^L$|^LONG|^BUY/.test(sd)) c.l += vol;
    else if (/^S$|^SHORT|^SELL/.test(sd)) c.s += vol;
    else { c.l += vol / 2; c.s += vol / 2; }
    if (c.l + c.s > maxV) maxV = c.l + c.s;
  }
  const rows = [];
  for (let i = 0; i < HEAT_NB; i++) {
    let l = 0, s = 0;
    for (const row of grid) { l += row[i].l; s += row[i].s; }
    rows.push({ p: pLo + (i + 0.5) * step, long: l, short: s });
  }
  const times = hasT
    ? Array.from({ length: nCol }, (_, j) => t0 + (t1 - t0) * (j + 0.5) / nCol)
    : [];
  return finishHeat({ grid, rows, pLo, pHi, step, px: mid, maxV, times,
                      label: 'CoinGlass · 真实清算', grade: 'real', lsInfo: null });
}

/* --- 汇总关键区间 --- */
function finishHeat(h) {
  // 滑动窗口找多/空筹码最密集的价格带
  const win = Math.max(3, Math.round(HEAT_NB * 0.08));
  const best = key => {
    let bi = 0, bv = -1;
    for (let i = 0; i + win <= HEAT_NB; i++) {
      let s = 0;
      for (let k = i; k < i + win; k++) s += h.rows[k][key];
      if (s > bv) { bv = s; bi = i; }
    }
    return { i0: bi, i1: bi + win - 1, v: Math.max(0, bv) };
  };
  const bl = best('long'), bs = best('short');
  const pOf = i => h.pLo + (i + 0.5) * h.step;
  let tl = 0, ts = 0;
  for (const r of h.rows) { tl += r.long; ts += r.short; }
  const tot = tl + ts;
  h.longBand  = { lo: h.pLo + bl.i0 * h.step, hi: h.pLo + (bl.i1 + 1) * h.step, v: bl.v };
  h.shortBand = { lo: h.pLo + bs.i0 * h.step, hi: h.pLo + (bs.i1 + 1) * h.step, v: bs.v };
  h.longPct  = tot > 0 ? tl / tot * 100 : 50;
  h.shortPct = tot > 0 ? ts / tot * 100 : 50;
  h.netBias  = tot > 0 ? (tl - ts) / tot * 100 : 0;
  h.bandMax  = Math.max(bl.v, bs.v, 1);
  return h;
}

/* --- Coinglass 清算记录缓存（5 分钟），四格共用同一份真实数据 --- */
const CG_TTL = 300000;
async function cgRecords(symId) {
  const c = S.cgLiq[symId];
  if (c && now() - c.ts < CG_TTL) return c.list;
  const list = await fetchCoinglassLiq(symId);
  S.cgLiq[symId] = { list, ts: now() };
  return list;
}

/* --- 构建单张热力图：CoinGlass 真实清算 > 币安合约推算 > 本地估算 --- */
async function buildHeatFor(symId, tfKey, bars, px, minSpan) {
  const s = SYMS[symId];
  const span = minSpan || TF_SPAN[tfKey] || HEAT_MIN_SPAN;   // 周期 → 关注的价格尺度
  const wantCG = HEAT_MODE === 'auto' || HEAT_MODE === 'coinglass';
  if (wantCG) {
    if (!binSym(s)) S.heatErr = '该品种无币安合约映射，Coinglass 无对应清算数据';
    else if (!CG_KEY) S.heatErr = '未配置 Coinglass API Key（数据源设置中填写后即用真实清算数据）';
    else {
      try {
        const hm = buildHeatFromCG(await cgRecords(symId), px, span);
        if (hm) return hm;
      } catch (e) { S.heatErr = String(e.message || e); }
    }
  }

  if (HEAT_MODE !== 'local' && binSym(s) && bars.length >= 8) {
    const ls = await fetchBinanceLS(symId).catch(() => null);
    const hm = buildHeatFromBars(bars, px, ls,
      ls ? 'Binance 合约 · 真实成交' : 'Binance K线 · 多空未校准',
      ls ? 'semi' : 'est', span);
    if (hm) return hm;
  }

  /* K 线不足 8 根时热力图直接放弃，不拿合成序列凑数。
   * 旧版会用 mkBars 造 240 根假 K 线去推「本地估算」热力图 —— 那张图看着像筹码分布，
   * 实际是随机数画出来的，做市商结论却建立在它上面。宁可显示「无清算数据」。 */
  if (bars.length < 8) { S.heatErr = 'K 线数据不足，无法推算筹码分布'; return null; }
  return buildHeatFromBars(bars, px, null, '本地估算 · 由真实K线推算', 'est', span);
}

/* --- 带缓存的按周期热力图：四格信号各自取一份，价格波动小于 0.08% 时复用 --- */
const _heatCache = new Map();
async function heatForSymTf(symId, tfKey) {
  const kd = S.klines[symId] && S.klines[symId][tfKey];
  const bars = (kd && kd.bars) || [];
  const px = (S.quotes[symId] && S.quotes[symId].price)
    || (bars.length ? bars[bars.length - 1].c : null);
  if (!(px > 0)) return null;   // 连一个真实价格都没有 → 不做任何推算
  const lastT = bars.length ? bars[bars.length - 1].t : 0;
  const q = Math.round(1 / 0.0008 * Math.log(px > 0 ? px : 1));   // 对数价格分桶，约 0.08%
  const key = [symId, tfKey, bars.length, lastT, q, HEAT_MODE, CG_KEY ? 1 : 0].join('|');
  if (_heatCache.has(key)) return _heatCache.get(key);

  const h = await buildHeatFor(symId, tfKey, bars, px).catch(() => null);  if (h) {
    if (_heatCache.size > 80) _heatCache.clear();
    _heatCache.set(key, h);
    S.heats[symId] = S.heats[symId] || {};
    S.heats[symId][tfKey] = h;
  }
  return h;
}

/* --- 四格信号：每个周期各准备一张热力图（带缓存），再据此判方向 --- */
async function loadAllHeat(symId, tfKeys) {
  await Promise.all(tfKeys.map(k => heatForSymTf(symId, k).catch(() => null)));
}

/* --- 编排：按优先级取数（当前展示用） --- */
async function loadHeat(symId, tfKey) {
  return heatForSymTf(symId, tfKey);
}

/* --- 数据源/Key 变更后：作废该品种的全部热力图缓存并重算四格 --- */
function invalidateHeat(symId) {
  for (const k of Array.from(_heatCache.keys())) {
    if (k.split('|')[0] === symId) _heatCache.delete(k);
  }
  if (symId) { delete S.heats[symId]; delete S.cgLiq[symId]; }
  else { S.heats = {}; S.cgLiq = {}; }
}

/* 切换数据源 / 填写 Key 后：四格方向必须跟着新的清算数据等级重判，不能只刷当前那张图 */
async function reloadHeatAll() {
  const cur = S.sym;
  invalidateHeat(cur);
  // 1) 当前品种四个周期立刻重算
  await loadAllHeat(cur, TFS.map(t => t.k)).catch(() => null);
  if (S.sym !== cur) return;
  renderSignals(); renderOverview();
  refreshHeat(cur, S.tf).catch(() => {});
  // 2) 其余品种后台补齐（总览用的是 1h 判向）
  SYM_LIST.filter(s => s.id !== cur).forEach(s => {
    invalidateHeat(s.id);
    (async () => {
      await loadKlines(s.id, '1h').catch(() => {});
      await heatForSymTf(s.id, '1h').catch(() => null);
      if (S.sym === cur) renderOverview();
    })();
  });
}

/* --- 绘制 --- */
const hcv = $('#heat'), hctx = hcv.getContext('2d');
function fitHeat() {
  const r = window.devicePixelRatio || 1;
  const w = hcv.clientWidth || 620, h = 302;
  hcv.width = Math.round(w * r); hcv.height = Math.round(h * r);
  hctx.setTransform(r, 0, 0, r, 0, 0);
  return { w, h };
}
let heatBox = null;   // 供 hover 命中计算

function heatColor(net, inten) {
  const t = clamp(inten, 0, 1), a = clamp(Math.abs(net), 0, 1);
  const [r, g, b] = net >= 0 ? [15, 153, 96] : [217, 43, 43];   // 净偏多=绿，净偏空=红
  const m = t * (0.26 + 0.74 * a);
  return `rgb(${Math.round(255 + (r - 255) * m)},${Math.round(255 + (g - 255) * m)},${Math.round(255 + (b - 255) * m)})`;
}

function drawHeat() {
  const H = S.heat;
  const { w, h } = fitHeat();
  hctx.clearRect(0, 0, w, h);
  const padL = 58, padR = 106, padT = 6, padB = 20;
  const gw = w - padL - padR, gh = h - padT - padB;
  if (!H || !H.grid || !H.grid.length || gw <= 10 || gh <= 10) {
    // 区分「还在拉」和「根本拉不到」：没有 K 线就谈不上热力图，写「加载中」会让人干等
    const kd0 = (S.klines[S.sym] || {})[S.tf];
    hctx.fillStyle = '#9a9aa0'; hctx.font = '11px ' + MONO;
    hctx.fillText(kd0 && kd0.bars.length ? '本周期无清算数据' : '本周期无真实 K 线 · 无清算数据', 12, h / 2);
    heatBox = null; return;
  }
  const s = SYMS[S.sym], dp = s.dp;
  const nCol = H.grid.length;
  const cw = gw / nCol, ch = gh / HEAT_NB;
  heatBox = { padL, padT, gw, gh, cw, ch, nCol, dp, H };

  // 单元格
  for (let j = 0; j < nCol; j++) {
    for (let i = 0; i < HEAT_NB; i++) {
      const c = H.grid[j][i], tot = c.l + c.s;
      if (!(tot > 0)) continue;
      const inten = H.maxV > 0 ? Math.pow(tot / H.maxV, 0.55) : 0;
      hctx.fillStyle = heatColor((c.l - c.s) / tot, inten);
      hctx.fillRect(padL + j * cw, padT + (HEAT_NB - 1 - i) * ch, cw + 0.6, ch + 0.6);
    }
  }

  // 网格淡线
  hctx.strokeStyle = '#f0f0ee'; hctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const y = Math.round(padT + gh * k / 4) + .5;
    hctx.beginPath(); hctx.moveTo(padL, y); hctx.lineTo(padL + gw, y); hctx.stroke();
  }

  // 现价线
  const pyOf = p => padT + gh - (p - H.pLo) / (H.pHi - H.pLo) * gh;
  const yPx = pyOf(H.px);
  if (isFinite(yPx) && yPx > padT - 2 && yPx < padT + gh + 2) {
    hctx.strokeStyle = '#16161a'; hctx.lineWidth = 1; hctx.setLineDash([3, 3]);
    hctx.beginPath(); hctx.moveTo(padL, yPx); hctx.lineTo(padL + gw, yPx); hctx.stroke();
    hctx.setLineDash([]);
    hctx.fillStyle = '#16161a'; hctx.font = '600 10px ' + MONO;
    hctx.fillText(fmt(H.px, dp), padL + 4, Math.max(padT + 9, yPx - 4));
  }

  // 多/空密集带标线
  [[H.longBand, '#12a150', '多头'], [H.shortBand, '#e13b3b', '空头']].forEach(([bd, col, nm]) => {
    const yc = pyOf((bd.lo + bd.hi) / 2);
    if (!isFinite(yc) || yc < padT || yc > padT + gh) return;
    hctx.strokeStyle = col; hctx.globalAlpha = .5; hctx.setLineDash([2, 4]);
    hctx.beginPath(); hctx.moveTo(padL, yc); hctx.lineTo(padL + gw, yc); hctx.stroke();
    hctx.setLineDash([]); hctx.globalAlpha = 1;
  });

  // 价格轴
  hctx.fillStyle = '#9a9aa0'; hctx.font = '10px ' + MONO;
  hctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) {
    const i = Math.round((HEAT_NB - 1) * (1 - k / 4));
    const y = padT + (HEAT_NB - 1 - i) * ch + ch / 2 + 3;
    hctx.fillText(fmt(H.pLo + (i + 0.5) * H.step, dp), padL - 6, y);
  }
  hctx.textAlign = 'left';

  // 右侧：多空筹码分布（左红=空头 / 右绿=多头）
  const hx = padL + gw + 12, hw = padR - 24, midX = hx + hw / 2;
  let rmax = 0;
  for (const r of H.rows) { if (r.long > rmax) rmax = r.long; if (r.short > rmax) rmax = r.short; }
  for (let i = 0; i < HEAT_NB; i++) {
    const y = padT + (HEAT_NB - 1 - i) * ch, r = H.rows[i];
    const lw = rmax > 0 ? r.long / rmax * (hw * 0.46) : 0;
    const sw = rmax > 0 ? r.short / rmax * (hw * 0.46) : 0;
    if (sw > 0) { hctx.fillStyle = 'rgba(225,59,59,.72)'; hctx.fillRect(midX - sw, y, sw, Math.max(1, ch - .4)); }
    if (lw > 0) { hctx.fillStyle = 'rgba(18,161,80,.72)'; hctx.fillRect(midX, y, lw, Math.max(1, ch - .4)); }
  }
  hctx.strokeStyle = '#ececeb';
  hctx.beginPath(); hctx.moveTo(midX, padT); hctx.lineTo(midX, padT + gh); hctx.stroke();
  hctx.fillStyle = '#9a9aa0'; hctx.font = '9px ' + MONO;
  hctx.fillText('空', hx, padT + gh + 13);
  hctx.textAlign = 'right'; hctx.fillText('多', hx + hw, padT + gh + 13); hctx.textAlign = 'left';

  // 时间轴
  hctx.fillStyle = '#9a9aa0'; hctx.font = '10px ' + MONO;
  const tArr = H.times || [];
  if (tArr.length >= 2) {
    for (let k = 0; k <= 3; k++) {
      const j = Math.round((nCol - 1) * k / 3);
      const t = tArr[Math.min(tArr.length - 1, j)];
      if (!t) continue;
      const d = new Date(t);
      const txt = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      hctx.textAlign = k === 0 ? 'left' : k === 3 ? 'right' : 'center';
      hctx.fillText(txt, padL + (j + (k === 0 ? 0 : k === 3 ? 1 : .5)) * cw, h - 6);
    }
    hctx.textAlign = 'left';
  }
}

/* --- 说明与统计 --- */
function renderHeatMeta() {
  const H = S.heat, el = $('#heatSrc');
  const lbl = (SYMS[S.sym] && SYMS[S.sym].label) || '—';
  if (!H) {
    /* 无清算数据时也必须把标题切到当前品种：早期 return 会让热力图卡顶着上一个品种的名字，
     * 切到没有清算源的品种时看到的是「ETH」，属于误导。 */
    el.textContent = '无清算数据'; el.className = 'src syn';
    $('#heatSym').textContent = lbl;
    $('#heatScale').textContent = '';
    $('#heatStats').innerHTML = '';
    const kd = (S.klines[S.sym] || {})[S.tf];
    const why = S.heatErr
      || (!(kd && kd.bars.length) ? `${(TF_MAP[S.tf] || {}).label || S.tf} 没有可用的真实 K 线` : '本周期清算数据不足');
    $('#heatNote').textContent = `${why} —— 页面不会用合成数据填充热力图。`;
    drawHeat();                       // 擦掉上一个品种的热力图，避免留一张不属于当前品种的图
    return;
  }
  el.textContent = H.label;
  el.className = 'src ' + (H.grade === 'real' ? 'real' : H.grade === 'semi' ? '' : 'syn');
  $('#heatSym').textContent = SYMS[S.sym].label;
  $('#heatScale').textContent = `价格区间 ${fmt(H.pLo, SYMS[S.sym].dp)} – ${fmt(H.pHi, SYMS[S.sym].dp)}`
    + ` · 跨度 ${((H.pHi - H.pLo) / H.px * 100).toFixed(2)}%`;

  const dp = SYMS[S.sym].dp;
  const toPx = p => (p / H.px - 1) * 100;
  $('#heatStats').innerHTML = [
    { k: '多头筹码密集区', v: `${fmt(H.longBand.lo, dp)} – ${fmt(H.longBand.hi, dp)}`,
      s: `距现价 ${pct(toPx((H.longBand.lo + H.longBand.hi) / 2))} · 跌破易触发多单强平`,
      c: 'var(--up)', w: H.longBand.v / H.bandMax * 100 },
    { k: '空头筹码密集区', v: `${fmt(H.shortBand.lo, dp)} – ${fmt(H.shortBand.hi, dp)}`,
      s: `距现价 ${pct(toPx((H.shortBand.lo + H.shortBand.hi) / 2))} · 突破易触发空单强平`,
      c: 'var(--down)', w: H.shortBand.v / H.bandMax * 100 },
    { k: '多空净偏向', v: (H.netBias >= 0 ? '多头 ' : '空头 ') + Math.abs(H.netBias).toFixed(1) + '%',
      s: `多 ${H.longPct.toFixed(1)}% · 空 ${H.shortPct.toFixed(1)}%`,
      c: H.netBias >= 0 ? 'var(--up)' : 'var(--down)', w: Math.min(100, Math.abs(H.netBias) * 2), dual: true },
  ].map(x => `<div class="hst"><div class="k">${x.k}</div>
    <div class="v" style="color:${x.c}">${x.v}</div>
    <div class="s">${x.s}</div>
    <div class="hbar"><i style="${x.dual ? `left:50%;width:${(x.w / 2).toFixed(1)}%;margin-left:${x.netBias < 0 ? -x.w / 2 : 0}%` : `left:0;width:${x.w.toFixed(1)}%`};background:${x.c}"></i></div>
  </div>`).join('');

  const ls = H.lsInfo;
  const levTxt = (H.levs && H.levs.length === 3) ? `${H.levs[0]}/${H.levs[1]}/${H.levs[2]} 倍` : '10/25/50 倍';
  const bits = [];
  if (H.grade === 'real') bits.push('数据源：CoinGlass 真实清算记录（需自备 Key + 代理）。');
  else if (H.grade === 'semi') bits.push(`数据源：Binance 合约真实 K 线成交量 + 真实多空持仓比，按 ${levTxt} 杠杆加权推算清算密集区（杠杆档随周期跨度自适应，落在图外的清算位不计入）。`);
  else bits.push('数据源：本地估算，<b>非交易所真实清算数据</b>，仅用于展示算法形态。');
  if (ls && ls.ls) bits.push(`币安全网多空持仓人数比 ${ls.ls.toFixed(2)}（已向 50% 收缩后校准，避免长期看空）。`);
  if (S.heatErr) bits.push(`CoinGlass 未生效：${S.heatErr}`);
  if (!binSym(SYMS[S.sym])) bits.push('该品种无币安永续合约映射，无法获取合约多空数据，已按永续 K 线成交量估算。');
  $('#heatNote').innerHTML = bits.join(' ') +
    ' 热力图纵轴为价格、横轴为时间，颜色越浓表示该价区筹码越密集；绿色=多头筹码（下方为多单强平风险区），红色=空头筹码（上方为空单强平风险区）。' +
    `<br><b>四格方向的算法</b>：比较本图现价上方「空单清算池」与下方「多单清算池」的距离加权引力（±52）、最近且够厚的清算墙（±22）、趋势确认（±18）、资金费率拥挤（±12）；` +
    '每个周期按自身跨度单独成图，短周期看近处高杠杆清算，长周期看更远结构。推算模型基于杠杆假设，与交易所实际清算存在偏差，不构成投资建议。';
}

function renderHeatTabs() {
  $('#heatTabs').querySelectorAll('[data-hs]').forEach(b =>
    b.classList.toggle('on', b.dataset.hs === HEAT_MODE));
}

async function refreshHeat(symId, tfKey) {
  S.heatErr = '';
  const hm = await loadHeat(symId, tfKey);
  if (S.sym !== symId) return;
  S.heat = hm;
  renderHeatMeta(); drawHeat();
}

/* ============================ 渲染：五品种总览 ============================ */
function setSym(id) {
  S.sym = id; localStorage.setItem('mb_sym', id);
  kvReset();
  // 切换后立即更新标题，避免等待网络期间显示上一品种造成误读
  const s = SYMS[id];
  $('#qName').textContent = `${s.label} · ${s.cn}`;
  $('#qPx').textContent = '—'; $('#qChg').textContent = '载入中…';
  renderTabs(); renderOverview(); refresh(true);
}

function renderOverview() {
  const el = $('#ovGrid');
  el.innerHTML = SYM_LIST.map(s => {
    const q = S.quotes[s.id];
    const d = S.klines[s.id] && S.klines[s.id]['1h'];
    const a = d ? signalOf(s.id, '1h', d.bars) : null;
    const mm = a && a.mm ? a.mm : null;
    const ref = S.openRef[s.id];
    const chg = (q && ref) ? (q.price / ref - 1) * 100 : null;
    // 做市商偏向优先于纯合成分：扫单情形下合成分会被流动性拉向错误的一侧
    const showDir = mm ? mm.bias : (a ? a.dir : null);
    const dirTxt = showDir === 'long' ? '做多' : showDir === 'short' ? '做空' : '观望';
    const cls = chg == null ? 'flat' : chg >= 0 ? 'up' : 'down';
    const modeTxt = mm ? (mm.mode === 'follow' ? '顺势' : mm.mode === 'sweep' ? '扫单后反转' : '观望') : '';
    const tip = mm
      ? `${modeTxt} · 一致度 ${mm.conf}%\n` + mm.reasons.join('\n')
      : (a ? '五因子融合加载中…' : '1h 数据未就绪');
    return `<button class="ov-i ${showDir || 'wait'} ${s.id === S.sym ? 'on' : ''}" data-sym="${s.id}" title="${tip.replace(/"/g, '')}">
      <div class="ov-h"><b>${s.label}</b><span>${s.cn}</span>${mm && mm.mode !== 'follow' ? `<span class="ov-mode ${mm.mode}">${modeTxt}</span>` : ''}</div>
      <div class="ov-p num">${q ? fmt(q.price, s.dp) : '—'}</div>
      <div class="ov-c num ${cls}">${chg == null ? '—' : pct(chg)}</div>
      <div class="ov-s">
        <div class="bar ${showDir || ''}"><i style="width:${a ? clamp(a.strength, 0, 100) : 0}%"></i></div>
        <em>${dirTxt}${a ? ' ' + Math.round(a.strength) : ''}</em>
      </div>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-sym]').forEach(b => b.onclick = () => setSym(b.dataset.sym));
}

// 全部品种各拉一次报价与 1h K 线（30s 一次，避免触发免费接口限流）
async function refreshOverview() {
  await Promise.all(SYM_LIST.map(async s => {
    await loadQuotes(s.id).catch(() => {});
    if (S.openRef[s.id] == null && S.quotes[s.id]) S.openRef[s.id] = S.quotes[s.id].price;
    await loadKlines(s.id, '1h').catch(() => {});
    await heatForSymTf(s.id, '1h').catch(() => {});
  }));
  renderOverview();
}

/* ============================ 渲染：图表头部 ============================ */
function renderChartHead() {
  const d = S.klines[S.sym]?.[S.tf];
  const el = $('#kSrc');
  el.textContent = d ? (d.real ? `真实 K 线 · ${d.src}` : `合成 K 线 · ${d.src}`) : '—';
  el.className = 'src ' + (d && d.real ? 'real' : 'syn');
  renderLegend(d);
}

/* 图例由 JS 渲染：读数必须跟着最新一根 K 线走，写死在 HTML 里的静态图例会给出过期数字，
 * 而且加一个因子（KDJ）就要手工改一次 HTML —— 这里改成按指标数组自动出列。 */
function renderLegend(d) {
  const el = $('#legend');
  if (!el) return;
  const s = SYMS[S.sym], dp = s.dp;
  if (!d || !d.bars.length) {
    el.innerHTML = `<span class="mut">${TF_MAP[S.tf].label} · 等待真实 K 线…</span>`;
    return;
  }
  const bars = d.bars, i = bars.length - 1;
  const F = analyzeOf(S.sym, S.tf, bars);
  const KD = F.ind.kdj, MC = F.ind.macd, BL = F.ind.boll;
  const lg = (label, val, color, cls) =>
    `<span class="lg${cls ? ' ' + cls : ''}">${color ? `<i style="background:${color}"></i>` : ''}${label} <b${color ? ` style="color:${color}"` : ''}>${val}</b></span>`;
  const k = KD.K[i], dd = KD.D[i], j = KD.J[i];
  const zone = k >= 80 ? '超买' : k <= 20 ? '超卖' : k > 50 ? '偏强区' : '偏弱区';
  const cross = KD.K[i - 1] != null && KD.D[i - 1] != null
    ? (KD.K[i - 1] <= KD.D[i - 1] && k > dd ? '金叉' : KD.K[i - 1] >= KD.D[i - 1] && k < dd ? '死叉' : '—')
    : '—';
  el.innerHTML =
    `<span class="lg px">现价 <b class="${bars[i].c >= bars[i].o ? 'up' : 'down'}">${fmt(bars[i].c, dp)}</b></span>`
    + lg('BOLL', BL.up[i] != null ? `${fmt(BL.dn[i], dp)}/${fmt(BL.mid[i], dp)}/${fmt(BL.up[i], dp)}` : '—', CB_BOLL)
    + lg('MA7', F.ma7 != null ? fmt(F.ma7, dp) : '—', '#e13b3b')
    + lg('MA25', F.ma25 != null ? fmt(F.ma25, dp) : '—', '#b7791f')
    + lg('MA99', F.ma99 != null ? fmt(F.ma99, dp) : '—', '#5b6ee1')
    + lg('MACD', isFinite(MC.dif[i]) ? `${fmt(MC.dif[i], dp)}/${fmt(MC.dea[i], dp)}` : '—', CB_MACD)
    + lg('KDJ', `K${fmt(k, 1)} D${fmt(dd, 1)} J${fmt(j, 1)}`, CB_KDJ_K)
    + `<span class="lg" title="KDJ 位置与交叉，是第五个技术面因子">KDJ 状态 <b>${zone} · ${cross}</b></span>`
    + `<span class="lg">RSI(14) <b>${fmt(F.rsi, 1)}</b></span>`
    + `<span class="lg">ATR <b>${fmt(F.atrPct, 2)}%</b></span>`
    + `<span class="lg">${TF_MAP[S.tf].label} <b>${bars.length} 根</b></span>`
    + (d.stale ? `<span class="lg" style="border-color:#f6cccc;background:#fff2f2;color:#8a2626">已停止更新 <b style="color:#8a2626">${d.staleSince ? new Date(d.staleSince).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</b></span>` : '');
}

/* ============================ 交易面板 ============================ */
function estOrder() {
  const s = SYMS[S.sym], q = S.quotes[S.sym];
  // 拿不到真实行情就是拿不到。旧版会退回一组写死的价格，那个数算出来的强平价是假的
  const px = (q && q.price) || null;
  const margin = parseFloat($('#fMargin').value) || 0;
  const lev = clamp(parseInt($('#fLev').value) || 1, 1, 125);
  S.lev = lev;
  const isLimit = S.type === 'limit';
  const entry = isLimit ? (parseFloat($('#fLimit').value) || px) : px;
  const tp = parseFloat($('#fTP').value) || null;
  const sl = parseFloat($('#fSL').value) || null;
  // 无实时行情时不做任何估算 —— 用假价算出来的强平价比没有数字更危险
  const noPx = !(px > 0);
  const qty = (!noPx && entry > 0) ? margin * lev / entry : 0;
  const notional = noPx ? 0 : qty * entry;
  const fee = notional * 0.0006;                       // taker 0.06%
  const liq = noPx ? null : (S.side === 'long' ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev));
  const rr = (tp && sl && !noPx && Math.abs(entry - sl) > 0) ? Math.abs(tp - entry) / Math.abs(entry - sl) : null;
  let tpPnl = null, slPnl = null;
  if (tp && !noPx) tpPnl = (tp - entry) * qty * (S.side === 'long' ? 1 : -1);
  if (sl && !noPx) slPnl = (sl - entry) * qty * (S.side === 'long' ? 1 : -1);
  const distLiq = (liq != null && entry > 0) ? Math.abs(entry - liq) / entry * 100 : null;
  return { px, noPx, margin, lev, entry, tp, sl, qty, notional, fee, liq, rr, tpPnl, slPnl, distLiq, isLimit };
}

function renderEst() {
  const e = estOrder(), s = SYMS[S.sym];
  if (e.noPx) {
    $('#estBox').innerHTML = `<div class="alert r" style="margin:0">当前品种没有可用的实时行情，无法估算。请等待行情恢复后再下单 —— 这里不会用估算价替你算。</div>`;
    return;
  }
  const rows = [
    ['开仓价', fmt(e.entry, s.dp)],
    ['名义价值', fmt(e.notional, 2) + ' USDT'],
    ['数量', fmt(e.qty, 6) + ' ' + S.sym],
    ['预估手续费', fmt(e.fee, 2) + ' USDT'],
    ['强平价', `${fmt(e.liq, s.dp)} <span class="mut">(距 ${fmt(e.distLiq, 2)}%)</span>`],
  ];
  if (e.rr) rows.push(['盈亏比', `${fmt(e.rr, 2)} : 1`]);
  if (e.tpPnl != null) rows.push(['止盈盈亏', `${e.tpPnl >= 0 ? '+' : ''}${fmt(e.tpPnl, 2)} USDT`]);
  if (e.slPnl != null) rows.push(['止损盈亏', `${e.slPnl >= 0 ? '+' : ''}${fmt(e.slPnl, 2)} USDT`]);
  $('#estBox').innerHTML = rows.map(([k, v]) => {
    const warn = k === '强平价' && e.distLiq < 5;
    return `<div class="est-r${warn ? ' warn' : ''}"><span>${k}</span><b>${v}</b></div>`;
  }).join('') + (e.isLimit && Math.abs(e.entry - e.px) / e.px > 0.02
    ? `<div class="alert y" style="margin:8px 0 0">限价与市价偏离 ${fmt(Math.abs(e.entry - e.px) / e.px * 100, 2)}%，委托可能长时间不成交。</div>` : '')
    + (e.lev >= 20 ? `<div class="alert r" style="margin:8px 0 0">杠杆 ${e.lev}× 极高风险，反向波动 ${fmt(e.distLiq, 2)}% 即触发强平。</div>` : '');
}

function openConfirm() {
  const e = estOrder(), s = SYMS[S.sym];
  if (e.noPx) { flash(); return; }      // 没有实时行情就不生成下单提示
  if (!(e.margin > 0)) { flash(); return; }
  if (e.isLimit && !(parseFloat($('#fLimit').value) > 0)) { flash(); return; }
  const dirTxt = S.side === 'long' ? '买入 / 做多' : '卖出 / 做空';
  $('#mTitle').innerHTML = `<span class="tag ${S.side === 'long' ? 'l' : 's'}">${dirTxt}</span> ${S.sym} · ${S.type === 'market' ? '市价' : '限价'}`;
  $('#mBody').innerHTML = `
    <div class="kv"><span>品种</span><b>${s.label} · ${s.cn}</b></div>
    <div class="kv"><span>方式</span><b>${S.type === 'market' ? '市价成交' : '限价委托 ' + fmt(e.entry, s.dp)}</b></div>
    <div class="kv"><span>当前市价</span><b>${fmt(e.px, s.dp)}</b></div>
    <div class="kv"><span>保证金 / 杠杆</span><b>${fmt(e.margin, 2)} USDT × ${e.lev}×</b></div>
    <div class="kv"><span>名义价值</span><b>${fmt(e.notional, 2)} USDT</b></div>
    <div class="kv"><span>数量</span><b>${fmt(e.qty, 6)}</b></div>
    <div class="kv"><span>止盈 / 止损</span><b>${e.tp ? fmt(e.tp, s.dp) : '未设置'} / ${e.sl ? fmt(e.sl, s.dp) : '未设置'}</b></div>
    <div class="kv"><span>预估强平价</span><b class="${e.distLiq < 5 ? 'up' : ''}">${fmt(e.liq, s.dp)}</b></div>
    <div class="alert y">这是<b>手动下单提示</b>。系统不会向任何交易所发送指令。请自行在交易平台核对价格与数量后再操作。</div>
    ${e.lev >= 20 ? `<div class="alert r">杠杆 ${e.lev}× 属高风险区间，反向波动 ${fmt(e.distLiq, 2)}% 即强平。</div>` : ''}
    ${!e.sl ? `<div class="alert r">未设置止损。建议至少设置止损以控制单笔风险。</div>` : ''}`;
  $('#mask').classList.add('on');
}
function flash() { $('#btnOrder').textContent = '请检查输入'; setTimeout(() => $('#btnOrder').textContent = '生成下单提示', 1400); }

$('#mCancel').onclick = () => $('#mask').classList.remove('on');
$('#mask').onclick = e => { if (e.target.id === 'mask') $('#mask').classList.remove('on'); };
$('#mOk').onclick = () => {
  const e = estOrder();
  if (e.noPx) { toast('无实时行情，未记录'); $('#mask').classList.remove('on'); return; }
  S.pos.push({
    id: 'P' + now().toString(36) + Math.random().toString(36).slice(2, 5),
    sym: S.sym, side: S.side, lev: e.lev, entry: e.entry, qty: e.qty, margin: e.margin,
    tp: e.tp, sl: e.sl, liq: e.liq, type: S.type, status: e.isLimit ? 'pending' : 'open',
    ts: now(),
  });
  save(); $('#mask').classList.remove('on'); renderPos();
};

/* ============================ 持仓 ============================ */
/* 标记价只能来自实时行情。取不到就返回 null —— 旧版用 p.entry（开仓价）兜底，
 * 结果行情一断，每笔持仓的浮动盈亏全变成 0，看上去像「没波动」，实际是没数据。 */
function markOf(p) { const q = S.quotes[p.sym]; return (q && q.price) || null; }
function pnlOf(p, mark) { return mark == null ? null : (mark - p.entry) * p.qty * (p.side === 'long' ? 1 : -1); }

function renderPos() {
  const tb = $('#posBody');
  let total = 0, totalM = 0;
  const rows = S.pos.map(p => {
    const s = SYMS[p.sym], mark = markOf(p), pnl = pnlOf(p, mark);
    const stale = mark == null;                 // 行情断了：盈亏未知，不能显示成 0
    const roi = (!stale && p.margin) ? pnl / p.margin * 100 : null;
    if (p.status === 'open' && !stale) { total += pnl; totalM += p.margin; }
    const cls = stale ? 'mut' : (pnl >= 0 ? 'up' : 'down');
    const pnlTxt = stale ? '<span class="mut">待行情</span>' : `${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}`;
    const cross = !stale && p.type === 'limit' && p.status === 'pending'
      && ((p.side === 'long' && mark <= p.entry) || (p.side === 'short' && mark >= p.entry));
    const act = p.status === 'pending'
      ? (cross ? `<button class="btn" data-exec="${p.id}" style="padding:2px 7px">已触及·执行</button>` : `<span class="mut" style="font-size:10.5px">待触及 ${fmt(p.entry, s.dp)}</span>`)
      : `<button class="btn" data-close="${p.id}" style="padding:2px 7px">平仓</button>`;
    return `<tr>
      <td><b>${s.label}</b> <span class="mut" style="font-size:10px">${p.type === 'limit' ? '限价' : '市价'}</span></td>
      <td><span class="tag ${p.side === 'long' ? 'l' : 's'}">${p.side === 'long' ? '多' : '空'}</span></td>
      <td class="num">${p.lev}×</td>
      <td class="num">${fmt(p.entry, s.dp)}</td>
      <td class="num">${stale ? '<span class="mut">—</span>' : fmt(mark, s.dp)}</td>
      <td class="num mut">${fmt(p.qty, 5)}</td>
      <td class="num">${fmt(p.margin, 0)}</td>
      <td class="num ${cls}">${pnlTxt}</td>
      <td class="num ${cls}">${stale ? '—' : pct(roi, 1)}</td>
      <td class="num mut">${fmt(p.liq, s.dp)}</td>
      <td>${act} <button class="x" data-del="${p.id}" title="删除">×</button></td></tr>`;
  });
  tb.innerHTML = rows.length ? rows.join('')
    : `<tr><td colspan="11"><div class="empty">暂无模拟持仓。在右侧生成下单提示并确认后，会记录到这里。</div></td></tr>`;
  $('#pnlSum').innerHTML = S.pos.length
    ? `浮动盈亏 <b class="num ${total >= 0 ? 'up' : 'down'}">${total >= 0 ? '+' : ''}${fmt(total, 2)} USDT</b>
       <span class="mut"> / 保证金 ${fmt(totalM, 0)}</span>` : '';

  tb.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
    const p = S.pos.find(x => x.id === b.dataset.close);
    const pnl = pnlOf(p, markOf(p));
    S.pos = S.pos.filter(x => x.id !== p.id); save(); renderPos();
    toast(`已平仓 ${p.sym} · 盈亏 ${pnl == null ? '行情缺失，未计价' : (pnl >= 0 ? '+' : '') + fmt(pnl, 2) + ' USDT'}`);
  });
  tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.pos = S.pos.filter(x => x.id !== b.dataset.del); save(); renderPos(); });
  tb.querySelectorAll('[data-exec]').forEach(b => b.onclick = () => {
    const p = S.pos.find(x => x.id === b.dataset.exec);
    const mk = p ? markOf(p) : null;
    if (p && mk != null) { p.status = 'open'; p.entry = mk; save(); renderPos(); }
  });
}

function checkTPSL() {
  let hit = false;
  S.pos.forEach(p => {
    if (p.status !== 'open') return;
    const m = markOf(p);
    if (m == null) return;      // 没有实时价就不判定止盈止损/强平，避免用错误价格平仓
    const long = p.side === 'long';
    const tp = p.tp && ((long && m >= p.tp) || (!long && m <= p.tp));
    const sl = p.sl && ((long && m <= p.sl) || (!long && m >= p.sl));
    const lq = (long && m <= p.liq) || (!long && m >= p.liq);
    if (tp || sl || lq) {
      const pnl = pnlOf(p, m);
      S.pos = S.pos.filter(x => x.id !== p.id);
      hit = true;
      toast(`${p.sym} ${lq ? '触发强平' : tp ? '止盈' : '止损'} · 盈亏 ${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} USDT`);
    }
  });
  if (hit) { save(); renderPos(); }
}

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#16161a;color:#fff;' +
      'padding:9px 16px;border-radius:5px;font-size:12px;z-index:200;box-shadow:0 4px 16px rgba(0,0,0,.18)';
    document.body.appendChild(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 3200);
}
const save = () => localStorage.setItem('mb_pos', JSON.stringify(S.pos));

/* ============================ 交互装配 ============================ */
function renderTabs() {
  /* 品种切换已经并进顶部五品种大卡（#ovGrid），这里不再渲染一组重复的小 tab ——
   * 两处都能切品种时很容易出现「卡上高亮 A、tab 上高亮 B」的不同步。 */
  $('#tfTabs').innerHTML = TFS.map(t =>
    `<button class="tf ${t.k === S.tf ? 'on' : ''}" data-tf="${t.k}">${t.k}</button>`).join('');
  $('#tfTabs').querySelectorAll('[data-tf]').forEach(b => b.onclick = () => {
    S.tf = b.dataset.tf; localStorage.setItem('mb_tf', S.tf);
    kvReset();                                    // 换周期回到默认视野，避免沿用上一周期的根数/位置
    $('#tfTabs').querySelectorAll('.tf').forEach(x => x.classList.toggle('on', x.dataset.tf === S.tf));
    /* 取数失败必须在这里兜住：去掉合成 K 线兜底后 loadKlines 会真的 reject，
     * 少了这个 catch，每次点周期切换都会冒一个未处理的 Promise rejection。 */
    loadKlines(S.sym, S.tf).then(() => { renderChartHead(); draw(); refreshHeat(S.sym, S.tf).catch(() => {}); })
      .catch(e => {
        S.kErr[S.sym + '|' + S.tf] = String(e.message || e);
        renderChartHead(); renderNetAlert(); scheduleRetry(true);
      });
  });
  $('#levBtns').innerHTML = [1, 5, 10, 20, 50].map(l =>
    `<button data-lev="${l}" class="${l === S.lev ? 'on' : ''}">${l}×</button>`).join('');
  $('#levBtns').querySelectorAll('[data-lev]').forEach(b => b.onclick = () => {
    $('#fLev').value = b.dataset.lev; syncLev(); renderEst();
  });
  renderHeatTabs();
}

/* 热力图：数据源切换 + hover 读数 */
function bindHeat() {
  /* 数据源按钮现在放在 details>summary 里，点击会顺带把折叠块收起来 —— 必须截断冒泡，
   * 否则每切一次源热力图就被折叠，还得手动展开。 */
  $('#heatTabs').querySelectorAll('[data-hs]').forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const m = b.dataset.hs;
    if (m === 'coinglass' && !CG_KEY) {
      const k = prompt(
        '填写 Coinglass API Key（open-api-v3 · 需自备）\n\n' +
        '· Coinglass 接口无 CORS 头，还需在「数据源」中配置代理模板\n' +
        '· Key 仅保存在本机 localStorage，不会上传\n\n' +
        '留空则取消切换。', CG_KEY);
      if (k == null) { renderHeatTabs(); return; }
      CG_KEY = k.trim(); localStorage.setItem('mb_cgkey', CG_KEY);
      if (!CG_KEY) { renderHeatTabs(); return; }
    }
    HEAT_MODE = m; localStorage.setItem('mb_heatsrc', m);
    renderHeatTabs(); reloadHeatAll();
  });

  /* 折叠块展开后 canvas 才拿到真实尺寸，必须重算再画，否则展开后是一张空白图 */
  const hCard = $('#heatCard');
  if (hCard) hCard.addEventListener('toggle', () => {
    if (hCard.open) requestAnimationFrame(() => { fitHeat(); drawHeat(); });
  });

  const tip = $('#heatTip');
  hcv.addEventListener('mousemove', e => {
    if (!heatBox || !S.heat) { tip.style.display = 'none'; return; }
    const r = hcv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { padL, padT, gw, gh, cw, ch, nCol, dp, H } = heatBox;
    if (x < padL || x > padL + gw || y < padT || y > padT + gh) { tip.style.display = 'none'; return; }
    const j = clamp(Math.floor((x - padL) / cw), 0, nCol - 1);
    const i = clamp(HEAT_NB - 1 - Math.floor((y - padT) / ch), 0, HEAT_NB - 1);
    const c = H.grid[j][i], tot = c.l + c.s, p = H.pLo + (i + 0.5) * H.step;
    const t = H.times && H.times[Math.min(H.times.length - 1, j)];
    const net = tot > 0 ? (c.l - c.s) / tot * 100 : 0;
    tip.innerHTML = `<div class="num">${fmt(p, dp)}</div>` +
      `<div class="mut" style="font-size:10px">${t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'}</div>` +
      `<div style="margin-top:4px">强度 ${H.maxV > 0 ? (tot / H.maxV * 100).toFixed(0) : 0}% · ` +
      `净向 <b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '多' : '空'} ${Math.abs(net).toFixed(0)}%</b></div>`;
    tip.style.display = 'block';
    tip.style.left = Math.min(r.width - 150, x + 14) + 'px';
    tip.style.top = Math.max(0, y - 46) + 'px';
  });
  hcv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
function syncLev() {
  const l = parseInt($('#fLev').value) || 1;
  $('#levBtns').querySelectorAll('[data-lev]').forEach(b => b.classList.toggle('on', +b.dataset.lev === l));
  S.lev = l;
}
$('#fLev').oninput = () => { syncLev(); renderEst(); };
$('#fMargin').oninput = renderEst;
$('#fTP').oninput = renderEst;
$('#fSL').oninput = renderEst;
$('#fLimit').oninput = renderEst;

$('#tType').querySelectorAll('button').forEach(b => b.onclick = () => {
  S.type = b.dataset.v;
  $('#tType').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  $('#limitWrap').style.display = S.type === 'limit' ? '' : 'none';
  if (S.type === 'limit' && !$('#fLimit').value) {
    const q = S.quotes[S.sym]; if (q) $('#fLimit').value = q.price.toFixed(SYMS[S.sym].dp);
  }
  renderEst();
});
$('#tSide').querySelectorAll('button').forEach(b => b.onclick = () => {
  S.side = b.dataset.v;
  $('#tSide').querySelectorAll('button').forEach(x => {
    x.className = (x === b ? 'on ' : '') + (x.dataset.v === 'long' ? 'b' : 's');
  });
  renderEst();
});
$('#btnOrder').onclick = openConfirm;
$('#btnReset').onclick = () => {
  $('#fTP').value = ''; $('#fSL').value = ''; $('#fMargin').value = 1000;
  $('#fLev').value = 10; syncLev(); renderEst();
};
$('#btnClear').onclick = () => { if (confirm('清空全部模拟持仓？')) { S.pos = []; save(); renderPos(); } };

// 数据源设置
$('#btnSet').onclick = () => {
  const v = prompt(
    '填写 CORS 代理模板，用于访问被跨域拦截的行情接口。\n\n' +
    '用 {url} 代表目标地址，例如：\n' +
    'https://api.allorigins.win/raw?url={url}\n' +
    'https://your-worker.workers.dev/?url={url}\n\n' +
    '留空表示浏览器直连。（Coinglass API Key 请在热力图右上角的「Coinglass」按钮中配置）', PROXY);
  if (v != null) {
    PROXY = v.trim(); localStorage.setItem('mb_proxy', PROXY);
    Object.keys(S.venues).forEach(k => delete S.venues[k]);
    S.klines = {}; refresh(true);
  }
};

/* ============================ 分享链接 ============================ */
const PUB_URL = 'https://7e011a904e364b1fb8f3f764b1e62440.app.workbuddy.host';
const DOM_CANDIDATES = ['quantboard.top', 'perpboard.top', 'marketboard.top', 'mkboard.top'];

function pageUrl() {
  const h = location.host || '';
  if (location.protocol === 'file:') return PUB_URL;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(h)) return PUB_URL;
  return location.origin + (location.pathname === '/' ? '' : location.pathname);
}
function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u.replace(/^https?:\/\//, '').split('/')[0]; } }

async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; }
  } catch (e) { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}
function copied(btn) {
  if (!btn || !btn.dataset || btn.dataset.busy === '1') return;
  const old = btn.textContent; btn.dataset.busy = '1'; btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = old; btn.dataset.busy = ''; }, 1200);
}
function normDomain(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function initShare() {
  const url  = pageUrl();
  const host = hostOf(url);
  const isLocal = (location.protocol === 'file:') ||
                  /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(location.host || '');

  $('#pubLink').textContent = url;
  $('#pubLink').title = url;
  $('#btnOpenPub').href = url;
  $('#pubHint').textContent = isLocal
    ? '当前为本地打开；上面是已上线的公网地址，复制后在任意浏览器可直接访问。'
    : '当前页面即线上地址，复制后可直接分享给别人打开。';

  const doCopy = async (sel, text) => {
    const btn = $(sel);                       // 先取引用：await 之后 e.currentTarget 已被清空
    const ok = await copyText(text);
    if (ok) copied(btn); else toast('复制失败，请手动选中链接复制');
    return ok;
  };
  const pubSel = '#btnCopyPub', domSel = '#btnCopyDom', shareSel = '#btnShare';

  $(pubSel).onclick = () => doCopy(pubSel, url);
  $(shareSel).onclick = () => doCopy(shareSel, url);

  const inp = $('#domInput'), link = $('#domLink'), hint = $('#domHint'), chips = $('#domChips');
  const saved = localStorage.getItem('mb_domain');
  if (saved) inp.value = saved;

  const apply = () => {
    const d  = normDomain(inp.value);
    const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.top$/.test(d);
    link.textContent = 'https://' + (d || 'your-domain.top');
    link.title = link.textContent;
    if (!d)            { hint.className = 'lnk-hint warn'; hint.textContent = '请填写域名，例如 quantboard.top'; }
    else if (!ok)      { hint.className = 'lnk-hint warn'; hint.textContent = '需以 .top 结尾，且只能含字母、数字与短横线。'; }
    else               { hint.className = 'lnk-hint';
                         hint.textContent = '注册 ' + d + ' 后添加 CNAME 记录指向 ' + host + '，生效后即可用该地址访问。'; }
    return ok ? d : null;
  };
  inp.addEventListener('input', apply);
  inp.addEventListener('change', () => { localStorage.setItem('mb_domain', inp.value.trim()); });

  chips.innerHTML = '';
  DOM_CANDIDATES.forEach(d => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = d;
    b.onclick = () => { inp.value = d; localStorage.setItem('mb_domain', d); apply(); };
    chips.appendChild(b);
  });

  $(domSel).onclick = () => {
    const d = apply();
    if (!d) { toast('域名不合法，需以 .top 结尾'); return; }
    doCopy(domSel, 'https://' + d);
  };
  apply();
}

/* ============================ 主循环 ============================ */
S.openRef = {};
async function refresh(hard) {
  const sym = S.sym;
  await loadQuotes(sym);
  if (S.openRef[sym] == null) S.openRef[sym] = S.quotes[sym].price;
  renderQuote(); renderVenues(); renderEst();

  const tfs = hard ? TFS.map(t => t.k) : [S.tf];
  /* 每个周期单独 catch：一个周期取不到不该拖垮整页。
   * loadKlines 现在取不到就抛错（没有合成兜底），错误记进 S.kErr，由告警条显示并退避重试。 */
  await Promise.all(tfs.map(async k => {
    try { await loadKlines(sym, k); }
    catch (e) { S.kErr[sym + '|' + k] = String(e.message || e); }
  }));
  await loadAllHeat(sym, tfs);                 // 四格方向依赖各周期的清算热力图
  await loadAcLiq(sym);                        // 建仓前提示依赖 1 小时真实爆仓量
  if (S.sym !== sym) return;
  renderChartHead(); renderSignals(); renderMM(); renderDirCell(); renderEntry(); draw(); checkTPSL(); renderPos(); renderOverview();
  if (hard) refreshHeat(sym, S.tf).catch(() => {});   // 热力图跟随 60s 硬刷新，避免频繁请求
  renderNetAlert();
  scheduleRetry(dataBroken());

  $('#footClock').textContent = '本地时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
}

/* 当前是否处于「数据不完整」状态：没有任何真实报价，或有周期的 K 线取不到。 */
function dataBroken() {
  const q = S.quotes[S.sym];
  if (!q || !q.realCount) return true;
  return Object.keys(S.kErr).some(k => k.startsWith(S.sym + '|') && S.kErr[k]);
}

/* 显著告警条：数据不完整时必须让用户看见，而不是静默显示旧图。
 * 旧版此时已经在用合成 K 线画图了，界面上完全看不出异常 —— 这是最危险的地方。 */
function renderNetAlert() {
  const el = $('#netAlert');
  if (!el) return;
  const q = S.quotes[S.sym];
  const badTf = Object.keys(S.kErr)
    .filter(k => k.startsWith(S.sym + '|') && S.kErr[k])
    .map(k => (TF_MAP[k.split('|')[1]] || {}).label || k.split('|')[1]);
  const noSrc = !q || !q.realCount;

  if (!noSrc && !badTf.length) { el.className = 'alert-bar'; el.style.display = 'none'; el.innerHTML = ''; return; }

  const parts = [];
  if (noSrc) parts.push(`<b>${SYMS[S.sym].label} 当前没有任何交易所返回报价</b>，页面不显示任何价格（不会用估算价顶替）。`);
  if (badTf.length) parts.push(`<b>${badTf.join(' / ')}</b> K 线取数失败，图表沿用上一次成功拉取的真实数据。`);
  const lastOk = NET.lastOk ? new Date(NET.lastOk).toLocaleTimeString('zh-CN', { hour12: false }) : '从未成功';
  el.className = 'alert-bar on';
  el.style.display = '';
  el.innerHTML = `<span class="ab-dot"></span>
    <div>${parts.join(' ')}
      <div class="ab-sub">最后一次成功取数：${lastOk}${NET.relay !== 'direct' ? ` · 经 ${NET.relayName} 转发` : ' · 直连'}。
      正在自动重试${_retryN > 1 ? `（第 ${_retryN} 次）` : ''}。若长时间失败，请检查网络或到「数据源」填写自建代理。</div>
    </div>
    <button class="btn" id="abRetry">立即重试</button>`;
  const b = $('#abRetry');
  if (b) b.onclick = () => { _retryN = 0; refresh(true); };
}

/* 退避重试：数据不完整时自动重拉，间隔 5s → 8s → 13s … 上限 60s，成功后清零。 */
let _retryT = null, _retryN = 0;
function scheduleRetry(broken) {
  if (!broken) { _retryN = 0; if (_retryT) { clearTimeout(_retryT); _retryT = null; } return; }
  if (_retryT) return;
  _retryN++;
  const wait = Math.min(5000 * Math.pow(1.6, _retryN - 1), 60000);
  _retryT = setTimeout(async () => { _retryT = null; await refresh(true); }, wait);
}

/* ============================ 刷新间隔（右上角） ============================ */
/* 设计取舍：报价始终保持实时（价格滞后会直接导致误判），间隔只控制 K 线 / 四格信号 /
   热力图 / 爆单这类重数据的刷新，既能降请求频率与 AiCoin 配额消耗，又不牺牲价格新鲜度。 */
const RF_MODES = [0, 5, 10, 15, 30];
let RF_MODE = (() => {
  const v = parseInt(localStorage.getItem('mb_refresh') || '0', 10);
  return RF_MODES.includes(v) ? v : 0;
})();
let _rfTimers = [], _nextRf = 0;

async function refreshQuotes() {                  // 轻量：只刷新多平台报价与估算，不碰 K 线
  const sym = S.sym;
  await loadQuotes(sym).catch(() => {});
  if (S.sym !== sym) return;
  if (S.openRef[sym] == null && S.quotes[sym]) S.openRef[sym] = S.quotes[sym].price;
  renderQuote(); renderVenues(); renderEst(); checkTPSL(); renderPos();
}

function renderRf() {
  // 段控（#rfSeg）取代了原来的下拉框：五个档位一眼看全，不必展开才知道当前是几秒
  $('#rfSeg').querySelectorAll('[data-rf]').forEach(b =>
    b.classList.toggle('on', parseInt(b.dataset.rf, 10) === RF_MODE));
  const n = $('#rfNext');
  if (!n) return;
  if (RF_MODE === 0) { n.textContent = '实时 8s'; return; }
  const left = Math.max(0, _nextRf - now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  n.textContent = m + ':' + String(sec).padStart(2, '0');
}
function tickRf() {
  const c = $('#footClock');
  if (c) c.textContent = '本地时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
  renderRf();
}
function applyRefresh() {
  _rfTimers.forEach(clearInterval); _rfTimers = [];
  _rfTimers.push(setInterval(() => refreshQuotes(), 8000));        // 报价：始终实时
  _rfTimers.push(setInterval(() => { if (S.quotes[S.sym]) renderQuote(); }, 1000));
  if (RF_MODE === 0) {
    _rfTimers.push(setInterval(() => refresh(true), 60000));
    _rfTimers.push(setInterval(() => refreshOverview(), 30000));
    _nextRf = now() + 60000;
  } else {
    const ms = RF_MODE * 60000;
    _rfTimers.push(setInterval(() => {
      refresh(true); refreshOverview(); _nextRf = now() + ms;
    }, ms));
    _nextRf = now() + ms;
  }
  _rfTimers.push(setInterval(tickRf, 1000));
  renderRf();
}
function bindRefresh() {
  $('#rfSeg').querySelectorAll('[data-rf]').forEach(b => b.onclick = () => {
    const v = parseInt(b.dataset.rf, 10);
    RF_MODE = RF_MODES.includes(v) ? v : 0;
    localStorage.setItem('mb_refresh', String(RF_MODE));
    applyRefresh();
  });
  // 顶栏 ⟳ 图标按钮：立即重拉一次，不等待下一个周期
  const icon = $('#btnRefreshIcon');
  if (icon) icon.onclick = () => {
    icon.classList.add('spin');
    _retryN = 0;
    Promise.all([refresh(true), refreshOverview()]).finally(() => {
      setTimeout(() => icon.classList.remove('spin'), 600);
      _nextRf = now() + (RF_MODE || 1) * 60000;
      renderRf();
    });
  };
}

(async function init() {
  renderTabs();
  initShare();
  renderOverview();
  syncLev();
  renderPos();
  fitCanvas();
  bindHeat();
  bindRefresh();
  bindEntry();
  renderHeatMeta();
  drawHeat();
  renderEntry();
  renderMM(); renderDirCell();
  await refresh(true);
  await refreshOverview();                            // 五品种总览
  applyRefresh();                                     // 按当前刷新间隔启动定时刷新
})();
