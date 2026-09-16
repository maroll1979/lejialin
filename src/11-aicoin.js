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
    coinKey, ts: now(), grade: 'real', src: '历史爆仓 · AiCoin',
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
    ts: now(), grade: 'semi', src: '潜在清算区模型 · 热力图推算', ratioOnly: true,
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
  srcEl.title = a.grade === 'real' ? '历史爆仓：交易所/数据商真实清算记录'
    : a.grade === 'semi' ? '潜在清算区模型：由 K 线成交量 + 杠杆假设推算，非真实爆仓数据'
    : '数据不足';
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
      '「历史爆仓」量取自 AiCoin 开放 API <b>/v2/mix/liq</b>（1 小时多空分项真实爆仓额）。' +
      '未配置 AiCoin 时退化为「潜在清算区模型」：由 K 线成交量按杠杆假设推算多空占比，不显示真实金额。' +
      '爆仓「价」取自本页 1 小时清算热力图关键带 —— 那也是模型推算的潜在清算区，不是真实爆仓位置。' +
      '两种来源（历史爆仓记录 / 潜在清算区模型）在界面中分别标注，不会混淆。' +
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
    ? '当前为 <b>潜在清算区模型</b>：由 1 小时清算热力图（成交量 + 杠杆假设）推算多空爆仓占比，<b>不是真实爆仓金额</b>；' +
      '爆仓价位同样来自热力图关键带，即模型认为的潜在清算区，而非市场真实爆仓位置。' +
      '点「配置 AiCoin」填入密钥后可切换为「历史爆仓」真实数据。仅为风险提示，不构成投资建议。'
    : '当前为 <b>历史爆仓</b>：' +
      `爆仓「量」取自 <b>AiCoin 开放 API /v2/mix/liq</b>${a.coinKey ? `（币种 ${a.coinKey}）` : ''}，1 小时多空分项真实统计；` +
      '爆仓「价」取自本页 <b>1 小时清算热力图</b> 关键带（该接口不返回逐笔爆仓价格）。' +
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

