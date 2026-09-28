/* probe-src.js — 数据源实时有效性探针
 * 逐个实际打所有外部接口，记录：HTTP 状态 / 延迟 / 数据新鲜度 / 字段完整性。
 * 目的是回答一个问题：页面上的这些数字，现在到底是不是真的、有多新。
 * 用法：node probe-src.js
 */
'use strict';

const GATE = 'https://api.gateio.ws';
const PAIR = { BTCUSDT: 'BTC_USDT', ETHUSDT: 'ETH_USDT', XAUUSDT: 'XAU_USDT' };

const rows = [];

function fmtAgo(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms < 0) return '未来 ' + Math.abs(Math.round(ms / 1000)) + 's';
  if (ms < 60000) return Math.round(ms / 1000) + 's 前';
  if (ms < 3600000) return (ms / 60000).toFixed(1) + ' 分钟前';
  if (ms < 86400000) return (ms / 3600000).toFixed(1) + ' 小时前';
  return (ms / 86400000).toFixed(1) + ' 天前';
}

async function probe(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    rows.push({
      name, ok: true, ms,
      fresh: r.freshMs != null ? fmtAgo(r.freshMs) : '—',
      detail: r.detail || '',
    });
  } catch (e) {
    rows.push({
      name, ok: false, ms: Date.now() - t0,
      fresh: '—',
      detail: (e && e.message) ? String(e.message).slice(0, 60) : String(e).slice(0, 60),
    });
  }
}

async function json(url, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout || 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function text(url, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout || 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

(async function main() {
  const now = Date.now();
  console.log('数据抓取实时有效性探针 — ' + new Date().toISOString());
  console.log('本机时间 ' + new Date(now).toLocaleString('zh-CN'));
  console.log('');

  /* ---------- 1. Gate.io 永续：K线 ---------- */
  /* 最新一根 K 线天然是「进行中」的，它的结束时间落在未来属正常。
     真正要看新鲜度的是**开始时间**：落后当前周期太多就说明数据停了。 */
  async function probeKline(name, contract, interval, sec) {
    await probe(name, async () => {
      const j = await json(`${GATE}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&limit=300`);
      if (!Array.isArray(j) || !j.length) throw new Error('空数据');
      for (let i = 1; i < j.length; i++) if (+j[i].t <= +j[i - 1].t) throw new Error('时间未升序');
      const last = j[j.length - 1];
      if (!(+last.c > 0)) throw new Error('收盘价无效');
      const tOpen = +last.t * 1000;
      const ago = now - tOpen;
      if (ago > sec * 1000 * 2.5) throw new Error('数据停滞：最新一根已过期 ' + fmtAgo(ago));
      const live = tOpen + sec * 1000 > now;
      return { freshMs: live ? 0 : ago, detail: `${j.length}根 · 最新一根开于 ${new Date(tOpen).toLocaleString('zh-CN')}（${live ? '进行中' : '已收线'}）· close ${(+last.c).toFixed(2)}` };
    });
  }

  await probeKline('K线 5m', 'BTC_USDT', '5m', 300);
  await probeKline('K线 15m', 'BTC_USDT', '15m', 900);
  await probeKline('K线 1h', 'BTC_USDT', '1h', 3600);
  await probeKline('K线 1d（MA200 用）', 'BTC_USDT', '1d', 86400);

  await probe('日线 SMA200 可算性', async () => {
    const j = await json(`${GATE}/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=1d&limit=300`);
    if (!Array.isArray(j) || j.length < 200) throw new Error('日线不足 200 根：' + (j || []).length);
    const last = j[j.length - 1];
    let sum = 0;
    for (let i = j.length - 200; i < j.length; i++) sum += +j[i].c;
    const ma = sum / 200;
    return { freshMs: now - +last.t * 1000, detail: `已收盘提到 ${j.length} 根 · SMA200 = ${ma.toFixed(2)} · 现价 ${(+last.c).toFixed(2)} · ${ma < +last.c ? '价在均线上方 +' : '价在均线下方 '}${((( +last.c / ma) - 1) * 100).toFixed(1)}%` };
  });

  /* ---------- 2. 实时价 / 24h ---------- */
  await probe('tickers（实时价/24h）', async () => {
    const j = await json(`${GATE}/api/v4/futures/usdt/tickers?contract=BTC_USDT`);
    if (!j || !j[0] || !(+j[0].last > 0)) throw new Error('last 无效');
    const d = j[0];
    const need = ['last', 'change_percentage', 'volume_24h', 'mark_price'];
    const miss = need.filter(k => d[k] == null);
    return { freshMs: 0, detail: 'last ' + (+d.last).toFixed(2) + ' · 24h ' + (+d.change_percentage).toFixed(2) + '% · 缺失字段 ' + (miss.length ? miss.join(',') : '无') };
  });

  /* ---------- 3. 逐笔成交 ---------- */
  await probe('trades（逐笔成交）', async () => {
    const j = await json(`${GATE}/api/v4/futures/usdt/trades?contract=BTC_USDT&limit=50`);
    if (!Array.isArray(j) || !j.length) throw new Error('空数据');
    if (!j.length) throw new Error('空数据');
    const newest = j.reduce((a, b) => (+b.create_time > +a.create_time ? b : a));
    /* 实测陷阱：Gate 的 create_time_ms 与 create_time **同为秒**（值相等，只是精度不同），
       直接当毫秒用会得到 1970 年。这里统一按 create_time（秒）×1000。 */
    const t = Math.round(+newest.create_time * 1000);
    if (!(t > 1e12)) throw new Error('时间戳量级错误');
    const msField = newest.create_time_ms;
    const msIsSec = msField != null && Math.abs(+msField - +newest.create_time) < 2;
    return { freshMs: now - t, detail: `${j.length}笔 · 最新成交 ${(+newest.price).toFixed(2)} · create_time_ms ${msIsSec ? '是秒（须×1000）' : '是毫秒'}` };
  });

  /* ---------- 4. 合约详情 ---------- */
  await probe('contracts（合约详情/ping）', async () => {
    const j = await json(`${GATE}/api/v4/futures/usdt/contracts/BTC_USDT`);
    if (!j || !j.name) throw new Error('返回无效');
    const miss = ['quanto_multiplier', 'order_price_round', 'mark_price'].filter(k => j[k] == null);
    return { freshMs: 0, detail: 'quanto ' + j.quanto_multiplier + ' · tick ' + j.order_price_round + ' · 缺失字段 ' + (miss.length ? miss.join(',') : '无') };
  });

  /* ---------- 5. 强平单（清算图） ---------- */
  /* Gate 限制：单次查询的 from/to 窗口不得超过 1 小时，否则 INVALID_PARAM_VALUE。
     页面 liq-map.js 已按 1 小时切片并发，探针必须用同样口径，否则会误报接口不可用。 */
  await probe('liq_orders（强平/清算图）', async () => {
    const to = Math.floor(now / 1000);
    let all = [], newest = 0;
    for (let h = 0; h < 3; h++) {
      const t = to - h * 3600;
      const j = await json(`${GATE}/api/v4/futures/usdt/liq_orders?contract=BTC_USDT&limit=1000&from=${t - 3599}&to=${t}`);
      if (!Array.isArray(j)) throw new Error('返回非数组');
      j.forEach(o => { const x = +o.time; if (x > newest) newest = x; all.push(o); });
    }
    if (!all.length) return { freshMs: null, detail: '接口通但近 3 小时内无强平单（0 条）' };
    return { freshMs: now - newest * 1000, detail: `近3h ${all.length} 条 · 最新 ${new Date(newest * 1000).toLocaleString('zh-CN')} · 须知窗口≤1h` };
  });

  /* ---------- 6. 订单簿（多空热力图） ---------- */
  await probe('order_book（订单簿/热力图）', async () => {
    const j = await json(`${GATE}/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=300&interval=0`);
    if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks)) throw new Error('买卖盘缺失');
    if (!j.bids.length || !j.asks.length) throw new Error('盘口为空');
    const bid = +j.bids[0].p, ask = +j.asks[0].p;
    if (!(ask > bid)) throw new Error('买卖价倒挂');
    return { freshMs: 0, detail: 'bid ' + bid.toFixed(2) + ' / ask ' + ask.toFixed(2) + ' · 价差 ' + ((ask - bid) / bid * 100).toFixed(3) + '% · 各 ' + j.bids.length + '/' + j.asks.length + ' 档' };
  });

  /* ---------- 7. WebSocket 逐笔推送 ---------- */
  await new Promise(resolve => {
    const name = 'WS fx-ws 逐笔推送';
    const t0 = Date.now();
    let done = false, ws = null, timer = null;
    const fin = (ok, detail) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) {}
      rows.push({ name, ok, ms: Date.now() - t0, fresh: ok ? '实时' : '—', detail: detail.slice(0, 60) });
      resolve();
    };
    try {
      const WebSocket = global.WebSocket || require('ws');
      ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
      timer = setTimeout(() => fin(false, '15s 内未收到首帧'), 15000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.trades', event: 'subscribe', payload: ['BTC_USDT'] }));
      };
      ws.onmessage = (ev) => {
        const s = String(ev.data || '');
        try {
          const j = JSON.parse(s);
          if (j.event === 'update' && j.result && j.result.length) {
            fin(true, '已收到 ' + j.result.length + ' 笔成交 · px ' + j.result[0].price);
          } else if (j.error) fin(false, '服务端错误 ' + JSON.stringify(j.error).slice(0, 40));
        } catch (e) { /* 忽略握手帧 */ }
      };
      ws.onerror = (e) => fin(false, '连接错误 ' + (e && e.message || ''));
      ws.onclose = () => { if (!done) fin(false, '连接被关闭'); };
    } catch (e) { fin(false, String(e && e.message || e)); }
  });

  /* ---------- 8. 美债收益率 ---------- */
  await probe('美债 Treasury CSV（主源）', async () => {
    const y = new Date().getUTCFullYear();
    const t = await text(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`);
    if (!t || t.indexOf('Date') < 0) throw new Error('CSV 格式异常');
    const lines = t.trim().split(/\r?\n/);
    const first = lines[1] ? lines[1].split(',') : [];
    if (!first[0]) throw new Error('无数据行');
    /* 日期归一化必须与 app.js 的 normDate 同口径：财政部 CSV 用 MM/DD/YYYY，
       直接塞进 new Date() 会得到 Invalid Date 而误判成「数据失效」。 */
    const iso = (s => {
      const t = String(s).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
      const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
    })(first[0]);
    if (!iso) throw new Error('日期格式未识别 ' + first[0]);
    const dt = new Date(iso + 'T00:00:00Z').getTime();
    if (!isFinite(dt)) throw new Error('日期解析失败 ' + first[0] + ' → ' + iso);
    const head = lines[0].split(',');
    const i10 = head.findIndex(h => /10 Yr|10-Yr|10Yr/i.test(h));
    /* 美债是日频数据，隔夜发布属正常；超过 7 天才算停滞。
       注意美债 T+1 公布：当日晚些时候才有当天数据，所以允许 3 天。 */
    const ago = now - dt;
    if (ago > 7 * 86400000) throw new Error('数据停滞 ' + fmtAgo(ago));
    return { freshMs: ago, detail: `${lines.length} 行 · 最新 ${first[0]} · 10Y ${i10 >= 0 ? first[i10] : '?'}%` };
  });

  await probe('美债 fiscaldata API（备用源）', async () => {
    const j = await json('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/daily_treasury_par_yield_curve_rates?sort=-record_date&page[size]=5');
    if (!j || !Array.isArray(j.data) || !j.data.length) throw new Error('data 缺失');
    const d = j.data[0];
    const dt = new Date(d.record_date + 'T00:00:00Z').getTime();
    return { freshMs: now - dt, detail: '最新 ' + d.record_date + ' · 10Y ' + d.avg_10_yr + '%' };
  });

  /* ---------- 9. 第三方比价（本机已知受限，仅作比价展示，失败不影响主流程） ---------- */
  await probe('比价 OKX（辅助）', async () => {
    const j = await json('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP', 6000);
    if (!j || !j.data || !j.data[0]) throw new Error('data 缺失');
    return { freshMs: 0, detail: 'last ' + (+j.data[0].last).toFixed(2) };
  });
  await probe('比价 Coinbase（辅助）', async () => {
    const j = await json('https://api.exchange.coinbase.com/products/BTC-USD/ticker', 6000);
    if (!j || !(+j.price > 0)) throw new Error('price 无效');
    return { freshMs: 0, detail: 'last ' + (+j.price).toFixed(2) };
  });
  await probe('比价 Bitstamp（辅助）', async () => {
    const j = await json('https://www.bitstamp.net/api/v2/ticker/btcusd/', 6000);
    if (!j || !(+j.last > 0)) throw new Error('last 无效（注意：不存在的交易对会返回数组）');
    return { freshMs: 0, detail: 'last ' + (+j.last).toFixed(2) };
  });

  /* ---------- 输出 ---------- */
  console.log('┌─ 数据源 ───────────────────────────┬──────┬───────┬───────────┐');
  console.log('│ 接口                                │ 状态 │ 延迟  │ 数据新鲜度 │');
  console.log('├────────────────────────────────────┼──────┼───────┼───────────┤');
  rows.forEach(r => {
    const aux = /辅助|备用源/.test(r.name);
    console.log('│ ' + pad(r.name, 34) + ' │ ' + (r.ok ? ' ✓  ' : (aux ? ' –  ' : ' ✗  ')) + ' │ ' + pad(r.ms + 'ms', 5) + ' │ ' + pad(r.fresh, 9) + ' │');
    if (r.detail) console.log('│   └ ' + r.detail);
  });
  console.log('└────────────────────────────────────┴──────┴───────┴───────────┘');

  const isAux = r => /辅助|备用源/.test(r.name);
  const main = rows.filter(r => !isAux(r)), aux = rows.filter(isAux);
  const hardFail = main.filter(r => !r.ok).map(r => r.name);
  const auxFail = aux.filter(r => !r.ok).map(r => r.name);
  console.log('\n主源通过 ' + (main.length - hardFail.length) + '/' + main.length
    + (hardFail.length ? ' · ✗ 失败：' + hardFail.join('、') : ' · 全部可用'));
  console.log('辅助/降级源 ' + (aux.length - auxFail.length) + '/' + aux.length + ' 可用'
    + (auxFail.length ? ' · 降级中：' + auxFail.join('、') + '（已有替代路径，不影响主流程）' : ''));
})();

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}
