// AiCoin 1 小时多空爆单 + 建仓前提示：切出 app.js 的对应段（无 DOM 依赖）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');

const cutA = src.indexOf('/* ============================ K 线绘制');
const acStart = src.indexOf('/* ============================ AiCoin');
const acEnd = src.indexOf('/* ============================ 多空筹码热力图');
const hStart = acEnd;
const hEnd = src.indexOf('/* --- 绘制 --- */');
const sStart = src.indexOf('function signalOf(symId, tfKey, bars)');
const sEnd = src.indexOf('function renderSignals()');
[['cutA', cutA], ['acStart', acStart], ['hEnd', hEnd], ['sStart', sStart], ['sEnd', sEnd]]
  .forEach(([k, v]) => { if (v < 0) throw new Error('切分点未找到: ' + k); });

const code = src.slice(0, cutA) + '\n' +
  src.slice(acStart, acEnd) + '\n' +
  src.slice(hStart, hEnd) + '\n' +
  src.slice(sStart, sEnd);

global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };

// fetch 桩：按队列返回，便于模拟 AiCoin 各种响应
let _resp = [];
global.fetch = () => {
  const r = _resp.length ? _resp.shift() : { ok: false, status: 500, json: async () => ({}) };
  return Promise.resolve({ ok: r.ok !== false, status: r.status || 200, json: async () => r.body });
};

const EXPORT = '\n;module.exports={acSign,fetchAicoinLiq,loadAcLiq,acFallback,entryAdvice,' +
  'acCoinKey,SYM_LIST,SYMS,S,clamp,fmt,usd,finishHeat,liqPools,num,AC_TTL};';

// 模块在顶层就读取 localStorage，故按不同的本机存储重建实例（模拟有/无密钥）
function buildModule(store) {
  const st = Object.assign({}, store);
  const ls = {
    getItem: k => (k in st ? st[k] : null),
    setItem: (k, v) => { st[k] = String(v); },
  };
  global.localStorage = ls;
  const m = {};
  new Function('module', 'exports', code + EXPORT)(m, {});
  m.exports.__ls = ls;
  return m.exports;
}
// 切回某个实例的存储（acCoinKey 等在运行时读 localStorage，需与实例匹配）
const useModule = mod => { global.localStorage = mod.__ls; };
const KEY = { mb_ackey: 'k-id', mb_acsec: 'k-sec' };
const A = buildModule(KEY);

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => {
  c ? (pass++, console.log('  ✓ ' + msg))
    : (fail++, console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')));
};
const H = t => console.log('\n' + t);

/* ---------- 造数据 ---------- */
const PX = 30000;
function norm(bars, px) {
  const k = px / bars[bars.length - 1].c;
  return bars.map(b => ({ t: b.t, o: b.o * k, c: b.c * k, h: b.h * k, l: b.l * k, v: b.v }));
}
function flatBars(n = 60, px = PX, jitter = 0.0006) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = px * (1 + Math.sin(i) * jitter), c = px * (1 + Math.cos(i) * jitter);
    out.push({ t: Date.now() - (n - 1 - i) * 3600000, o, c,
               h: Math.max(o, c) * (1 + jitter), l: Math.min(o, c) * (1 - jitter), v: 100 });
  }
  return norm(out, px);
}
function mkHeat(fn, px = PX, span = 0.04, n = 60) {
  const pLo = px * (1 - span / 2), pHi = px * (1 + span / 2), step = (pHi - pLo) / n;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = pLo + (i + 0.5) * step, v = fn(p, i / (n - 1)) || {};
    rows.push({ p, long: v.long || 0, short: v.short || 0 });
  }
  return A.finishHeat({ grid: [], rows, pLo, pHi, step, px, maxV: 0, times: [],
                        label: 'test', grade: 'real', lsInfo: null });
}
// 装填 1 小时上下文：K 线 + 报价 + 1h 热力图 + AiCoin 爆仓记录
function setup(sym, liq, heatFn) {
  A.S.klines[sym] = { '1h': { bars: flatBars(60, PX) } };
  A.S.quotes[sym] = { price: PX };
  A.S.heats[sym] = { '1h': mkHeat(heatFn || ((p) => ({ long: p < PX ? 10 : 1, short: p > PX ? 10 : 1 })), PX, 0.04) };
  A.S.acLiq[sym] = liq || null;
}
const clear = sym => { delete A.S.acLiq[sym]; delete A.S.heats[sym]; delete A.S.klines[sym]; delete A.S.quotes[sym]; };

/* ---------- 1) 签名：官方文档的测试向量 ---------- */
H('[1] AiCoin 签名（HMAC-SHA1 → hex → base64）');
(async () => {
  const sig = await A.acSign('975988f45090561684b7d8f4e45b85c2', '957f23f2d6435e37d4ac21f3e9a67d45', '2', 1612149637);
  ok(sig === 'M2Y0ODNlYTUwNDFiMTg5MjRmMGQxNmY1YTMyMzc1NTc5NTUzNDAzYw==',
    '与官方文档测试向量一致', sig);
  ok(/^[A-Za-z0-9+/]+=*$/.test(sig), '签名为 base64 字符串');
  const sig2 = await A.acSign('975988f45090561684b7d8f4e45b85c2', '957f23f2d6435e37d4ac21f3e9a67d45', '3', 1612149637);
  ok(sig2 !== sig, 'nonce 变化 → 签名变化');

  /* ---------- 2) 接口解析 ---------- */
  H('[2] /v2/mix/liq 解析');
  _resp = [{ body: { success: true, errorCode: 200, error: '', data: { detail: {
    liq1h: '4000000', liqLong1h: '1000000', liqShort1h: '3000000',
    liq24h: '24000000', liqLong24h: '6000000', liqShort24h: '18000000',
    maxLiq: '500000', maxLiqMarket: 'Binance-BTC' } } } }];
  const d = await A.fetchAicoinLiq('BTC');
  ok(d.long1h === 1e6 && d.short1h === 3e6, '多空爆仓量解析正确',
    `${d.long1h}/${d.short1h}`);
  ok(d.tot1h === 4e6, '1 小时总量正确', String(d.tot1h));
  ok(Math.abs(d.tot24h - 24e6) < 1, '24 小时总量正确', String(d.tot24h));
  ok(d.grade === 'real', '标记为真实数据');
  ok(d.coinKey === 'btc', 'BTC → coinKey=btc', d.coinKey);

  // 文档示例中 liq1h 与分项相等（占位），应以分项之和为准
  _resp = [{ body: { success: true, errorCode: 200, data: { detail: {
    liq1h: '100', liqLong1h: '1000000', liqShort1h: '3000000', liq24h: '100' } } } }];
  const d2 = await A.fetchAicoinLiq('BTC');
  ok(d2.tot1h === 4e6, 'liq1h 与分项矛盾时取分项之和', String(d2.tot1h));

  // 错误码
  _resp = [{ body: { success: false, errorCode: 401, error: '签名错误' } }];
  let err = '';
  try { await A.fetchAicoinLiq('BTC'); } catch (e) { err = e.message; }
  ok(/签名错误/.test(err), 'errorCode 非 200 时抛出错误原因', err);

  // 缺字段
  _resp = [{ body: { success: true, errorCode: 200, data: { detail: { foo: 1 } } } }];
  err = '';
  try { await A.fetchAicoinLiq('BTC'); } catch (e) { err = e.message; }
  ok(/缺少/.test(err), '缺爆仓字段时明确报错', err);

  // 无 Key / 无映射（用独立实例，因为密钥在模块加载时读取）
  err = '';
  try { await buildModule({}).fetchAicoinLiq('BTC'); } catch (e) { err = e.message; }
  ok(/未配置/.test(err), '未配置密钥时明确报错', err);

  err = '';
  try { await buildModule({ mb_ackey: 'k-id', mb_acsec: 'k-sec', mb_ack_BTC: ' ' }).fetchAicoinLiq('BTC'); }
  catch (e) { err = e.message; }
  ok(/币种主键/.test(err), '币种主键为空时报错（不伪造）', err);

  /* ---------- 3) 缓存与降级 ---------- */
  H('[3] 缓存与降级');
  useModule(A);                                  // 前面的无密钥实例换掉了全局存储，先切回来
  _resp = [{ body: { success: true, errorCode: 200, data: { detail: {
    liq1h: '4000000', liqLong1h: '1000000', liqShort1h: '3000000', liq24h: '24000000' } } } }];
  await A.loadAcLiq('BTC');
  const n1 = _resp.length;
  await A.loadAcLiq('BTC');
  ok(_resp.length === n1, '60 秒内命中缓存，不重复请求');
  ok(A.S.acLiq['BTC'].grade === 'real', '真实数据写入缓存');

  _resp = [];
  await A.loadAcLiq('ETH');
  ok(A.S.acLiq['ETH'].grade === 'none' && !!A.S.acLiq['ETH'].err,
    '请求失败时记录原因而非静默', A.S.acLiq['ETH'].err || '');

  // 热力图降级：只有比例，没有金额
  setup('BNB', null);
  const fb = A.acFallback('BNB');
  ok(fb && fb.grade === 'semi', '无 AiCoin 时退化为热力图推算');
  ok(fb.ratioOnly === true, '降级数据标记 ratioOnly（不显示金额）');
  ok(fb.short1h > 0 && fb.long1h > 0, '降级时多空两侧均有值');

  /* ---------- 4) 建仓前提示：主导方向 ---------- */
  H('[4] 建仓前提示 · 主导方向');
  const mk = (lo, sh, tot24) => ({ grade: 'real', src: 'AiCoin', ts: Date.now(),
    long1h: lo, short1h: sh, tot1h: lo + sh, tot24h: tot24 == null ? (lo + sh) * 24 : tot24 });

  setup('BTC', mk(1e6, 3e6));                    // 空单爆仓 75%
  let a = A.entryAdvice('BTC');
  ok(a.shPct > 70 && a.shPct < 80, '空单爆仓占比计算正确', a.shPct.toFixed(1) + '%');
  ok(a.items.some(i => /主爆空单/.test(i.t)), '主爆空单 → 提示轧空追高风险',
    a.items.map(i => i.t).join(','));
  ok(a.items.some(i => /回踩/.test(i.d)), '提示等回踩再介入');

  setup('BTC', mk(3e6, 1e6));
  a = A.entryAdvice('BTC');
  ok(a.items.some(i => /主爆多单/.test(i.t)), '主爆多单 → 提示多杀多', a.items.map(i => i.t).join(','));
  ok(a.items.some(i => /二次探底|企稳/.test(i.d)), '提示二次探底风险');

  setup('BTC', mk(2e6, 2e6));
  a = A.entryAdvice('BTC');
  ok(a.items.some(i => /双向爆仓/.test(i.t)), '多空均衡 → 提示方向未明', a.items.map(i => i.t).join(','));

  /* ---------- 5) 爆仓强度 ---------- */
  H('[5] 建仓前提示 · 爆仓强度');
  setup('BTC', mk(4e6, 12e6, 24e6));             // surge = 16e6 / 1e6 = 16
  a = A.entryAdvice('BTC');
  ok(a.surge > 3, '爆仓强度按 24h 均量归一', a.surge && a.surge.toFixed(1));
  ok(a.items.some(i => /清算潮/.test(i.t)), '强度 ≥3 倍 → 清算潮提示');
  ok(a.level === 'risk', '清算潮 → 高风险', a.level);
  ok(a.pos <= 10, '高风险时建议仓位被压到 10% 以内', String(a.pos));

  setup('BTC', mk(0.2e6, 0.6e6, 24e6));          // surge = 0.8e6/1e6 = 0.8
  a = A.entryAdvice('BTC');
  ok(a.surge < 1, '清淡行情强度 <1', a.surge.toFixed(2));

  /* ---------- 6) 关键价位与方向一致性 ---------- */
  H('[6] 建仓前提示 · 关键价位与一致性');
  ok(a.bands === null || typeof a.bands === 'object', '关键价位结构合法');
  setup('BTC', mk(1e6, 3e6));
  a = A.entryAdvice('BTC');
  ok(a.bands && (a.bands.up || a.bands.dn), '给出关键爆仓价位',
    JSON.stringify(a.bands && { up: a.bands.up && Math.round(a.bands.up.p), dn: a.bands.dn && Math.round(a.bands.dn.p) }));
  ok(a.items.some(i => /清算带|爆仓价位/.test(i.t)), '提示中包含关键清算带',
    a.items.map(i => i.t).join(','));
  ok(['long', 'short', 'wait'].includes(a.dir), '1 小时方向合法', a.dir);

  /* ---------- 7) 等级与仓位 ---------- */
  H('[7] 建仓前提示 · 等级与仓位');
  setup('BTC', mk(1e6, 3e6));
  a = A.entryAdvice('BTC');
  ok(a.pos >= 5 && a.pos <= 40, '建议仓位落在 5%~40%', String(a.pos));
  ok(['risk', 'warn', 'ok'].includes(a.level), '等级合法', a.level);
  ok(a.levelTxt.length > 0, '等级文案非空', a.levelTxt);
  ok(a.items.length >= 2, '至少给出 2 条提示', String(a.items.length));
  ok(a.items.every(i => i.t && i.d && ['risk', 'warn', 'ok'].includes(i.lv)), '每条提示结构完整');

  /* ---------- 8) 无数据 / 健壮性 ---------- */
  H('[8] 无数据与健壮性');
  clear('BTC');
  A.S.klines['BTC'] = { '1h': { bars: flatBars(60, PX) } };
  A.S.quotes['BTC'] = { price: PX };
  a = A.entryAdvice('BTC');
  ok(a.ok === false, '无爆仓数据时 ok=false');
  ok(a.grade === 'none', '无数据时 grade=none');
  ok(a.reason.length > 0, '给出不可用原因', a.reason);
  ok(a.items.length === 0 && a.pos === 0, '无数据时不给仓位建议');

  // 空 K 线 / 无报价
  clear('BTC');
  a = A.entryAdvice('BTC');
  ok(a.ok === false, '空上下文不抛错');
  clear('BTC');
  A.S.klines['BTC'] = { '1h': { bars: [] } };
  A.S.quotes['BTC'] = { price: null };
  a = A.entryAdvice('BTC');
  ok(a.ok === false, '空 K 线 + 空报价不抛错');

  // 异常爆仓数据（0 总量 / NaN）
  clear('BTC');
  setup('BTC', { grade: 'real', src: 'x', ts: Date.now(), long1h: 0, short1h: 0, tot1h: 0, tot24h: 0 });
  a = A.entryAdvice('BTC');
  ok(a.ok === true && isFinite(a.shPct), '总量为 0 时不崩、占比回落到 50%', String(a.shPct));
  ok(a.items.every(i => !/NaN|undefined/.test(i.d)), '提示文案无 NaN',
    a.items.map(i => i.d).join(' | ').slice(0, 80));

  /* ---------- 9) 五品种跑通 ---------- */
  H('[9] 五品种跑通');
  for (const s of A.SYM_LIST) {
    clear(s.id);
    setup(s.id, mk(1e6, 3e6));
    const r = A.entryAdvice(s.id);
    ok(r.ok && r.items.length >= 2 && (r.pos >= 5 && r.pos <= 40),
      `${s.label} 可生成建仓提示`, `${r.level}/${r.pos}%`);
  }

  /* ---------- 10) 金额格式化 ---------- */
  H('[10] 金额格式化');
  ok(A.usd(1234) === '$1.2K', '千位缩写', A.usd(1234));
  ok(A.usd(1234567) === '$1.23M', '百万缩写', A.usd(1234567));
  ok(A.usd(2.5e9) === '$2.50B', '十亿缩写', A.usd(2.5e9));
  ok(A.usd(null) === '—', '空值显示占位符');

  console.log('\n==============================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
