/* ============================ 网络基础 ============================ */
let PROXY = localStorage.getItem('mb_proxy') || '';   // 形如 https://xxx/?url={url}

/* 转发通道：0 = 浏览器直连交易所，其余 = 公共转发。
 * 为什么要这个：交易所接口大多不返回 CORS 头，浏览器直连会被拦，
 * 一旦拦掉整个页面就没数据了。转发通道只做「原样搬运」，取回的仍是交易所当时的真实行情，
 * 不是任何本地编造的序列。任何一条通道失败都自动换下一条，全部失败才报错。 */
/* 转发通道：0 = 浏览器直连交易所，其余 = 公共转发。
 * 为什么要这个：交易所接口大多不返回 CORS 头，浏览器直连会被拦，
 * 一旦拦掉整个页面就没数据了。转发通道只做「原样搬运」，取回的仍是交易所当时的真实行情，
 * 不是任何本地编造的序列。任何一条通道失败都自动换下一条，全部失败才报错。
 *
 * pick：部分通道会把响应包一层（如 AllOrigins 的 /get 返回 { contents: "<json>" }），
 * 没有 pick 就拿到一个包装对象，下游取字段全是 undefined —— 表现为「有响应但没数据」，
 * 比直接失败更难排查。所以每条通道显式声明自己的解包方式。 */
const RELAYS = [
  { id: 'direct', name: '直连', mk: u => u },
  { id: 'allorigins', name: 'AllOrigins', mk: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { id: 'allorigins-get', name: 'AllOrigins·get', mk: u => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u),
    pick: r => (r && typeof r.contents === 'string') ? JSON.parse(r.contents) : r },
  { id: 'codetabs', name: 'CodeTabs', mk: u => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u) },
  { id: 'thingproxy', name: 'ThingProxy', mk: u => 'https://thingproxy.freeboard.io/fetch/' + u },
  { id: 'corsproxy', name: 'CorsProxy', mk: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { id: 'corslol', name: 'Cors.lol', mk: u => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
];
/* 单通道上限。不能把整份 deadline 全给第一条通道：一条挂死的转发会吃掉全部时间，
 * 后面明明可用的通道一次都轮不到（实测某网络下 AllOrigins 会挂满 12 秒不返回）。
 * 3 秒足够一条可用通道返回，剩下的时间留给后面的候选。 */
const RELAY_MAX = 3000;

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
const NET = { relay: 'direct', relayName: '直连', ok: 0, fail: 0, lastOk: 0, lastErr: '', switches: 0 };

/* 通道打分：只按「成功过的通道优先」排，不按失败次数惩罚。
 * 原因：一次网络抖动就让好通道降权，会把请求全赶去最慢的那条，实盘里反而更容易超时。
 * 排序规则 —— 最近 5 分钟内成功过 → 按成功次数降序 → 其次保序。直连永远排第一（最快、无中转）。 */
const RS = {};   // relayId -> { ok, fail, lastOk, lastFail, ms }
function rsOf(id) { return (RS[id] = RS[id] || { ok: 0, fail: 0, lastOk: 0, lastFail: 0, ms: 0 }); }
function orderedRelays(list) {
  const t = now();
  // 0 = 最近成功过（优先）｜1 = 没用过或很久没动静｜2 = 90 秒内刚失败过（最后再试）
  const rank = x => (x.lastOk && t - x.lastOk < 300000) ? 0
    : (x.lastFail && t - x.lastFail < 90000) ? 2 : 1;
  return list.slice().sort((a, b) => {
    if (a.id === 'direct') return -1;
    if (b.id === 'direct') return 1;
    const A = rsOf(a.id), B = rsOf(b.id);
    const ra = rank(A), rb = rank(B);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      if (A.ok !== B.ok) return B.ok - A.ok;
      return (A.ms || 9999) - (B.ms || 9999);
    }
    return 0;
  });
}

function noteRelay(id, ok, ms) {
  const r = rsOf(id);
  if (ok) { r.ok++; r.lastOk = now(); r.ms = r.ms ? Math.round(r.ms * 0.7 + ms * 0.3) : ms; }
  else { r.fail++; r.lastFail = now(); }
}

/* 通道健康度一览：挂在状态灯上做 tooltip。
 * 「实时 · 转发」只告诉你现在走哪条，看不出别的通道是不是全挂了 —— 那才是要排查的信息。 */
function relaySummary() {
  const t = now();
  return RELAYS.map(r => {
    const x = rsOf(r.id), cur = NET.relay === r.id ? ' ←当前' : '';
    const bad = x.lastFail && (t - x.lastFail < 90000) ? ' · 刚失败，已降到最后顺位' : '';
    return `${r.name}：成功 ${x.ok}${x.ms ? `（${x.ms}ms）` : ''} 失败 ${x.fail}${bad}${cur}`;
  }).join('\n');
}

/* 解包：通道声明了 pick 就用 pick，否则原样返回。pick 抛错视为该通道失败，换下一条。 */
function unwrap(ry, j) {
  if (!ry.pick) return j;
  const v = ry.pick(j);
  if (v == null) throw new Error('通道返回空内容');
  return v;
}

async function jget(url, ms = 7000, headers) {
  const list = orderedRelays(relayList());
  const deadline = now() + ms;
  let lastErr = new Error('无可用通道');
  for (const ry of list) {
    const left = deadline - now();
    if (left <= 0) break;
    const budget = Math.min(left, RELAY_MAX);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), budget);
    const t0 = now();
    try {
      const r = await fetch(ry.mk(url), { signal: ac.signal, cache: 'no-store', headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = unwrap(ry, await r.json());
      if (NET.relay !== ry.id && NET.lastOk) NET.switches++;
      NET.relay = ry.id; NET.relayName = ry.name;
      NET.ok++; NET.lastOk = now(); NET.lastErr = '';
      noteRelay(ry.id, true, now() - t0);
      return j;
    } catch (e) {
      lastErr = e;
      noteRelay(ry.id, false, 0);
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
    const t0 = now();
    try {
      const r = await fetch(ry.mk(url), { signal: ac.signal, cache: 'no-store', headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = unwrap(ry, await r.json());
      NET.relay = ry.id; NET.relayName = ry.name; NET.ok++; NET.lastOk = now();
      noteRelay(ry.id, true, now() - t0);
      return j;
    } catch (e) { lastErr = e; noteRelay(ry.id, false, 0); NET.fail++; NET.lastErr = String(e.message || e); }
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

