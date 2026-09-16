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

