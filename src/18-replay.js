/* ============================ P1-3：历史回放与样本外验证 ============================
 * 用已加载的一段真实 K 线离线跑一遍策略，只写回放结果，不污染真实 AUTO 订单。
 * 输出：总单数、胜率、净盈亏、最大回撤、手续费、不同市况表现。
 * 样本外验证：按时间把序列切成 前 70%（样本内） / 后 30%（样本外），
 * 两段分别统计 —— 若样本外明显劣化，说明参数大概率过拟合，不能上真实盘。
 * 注意：回放窗口受 KBAR_CAP（1000 根）限制，样本量有限，结论只能作参考。 */
function replayStatsOf(list) {
  const closed = list.filter(o => o.status !== 'open');
  const win = closed.filter(o => o.pnl > 0).length;
  let eq = 0, peak = 0, dd = 0;
  for (const o of list) {
    eq += o.pnl;
    if (eq > peak) peak = eq;
    const d = peak - eq;
    if (d > dd) dd = d;
  }
  const byReg = { up: [], down: [], range: [] };
  for (const o of list) (byReg[o.regime] || byReg.range).push(o);
  const regOf = k => {
    const l = byReg[k] || [];
    const c = l.filter(o => o.status !== 'open');
    const w = c.filter(o => o.pnl > 0).length;
    return { n: l.length, win: w, loss: c.length - w, net: l.reduce((s, o) => s + o.pnl, 0) };
  };
  return {
    total: list.length, closed: closed.length, open: list.length - closed.length,
    win, loss: closed.length - win,
    rate: closed.length ? win / closed.length * 100 : null,
    net: list.reduce((s, o) => s + o.pnl, 0),
    fees: list.reduce((s, o) => s + o.fee, 0),
    maxDd: dd,
    regimes: { up: regOf('up'), down: regOf('down'), range: regOf('range') },
  };
}
function autoReplay(bars, params) {
  const { ivMin = AUTO.ivMin, margin = AUTO.margin, lev = AUTO.lev, rr = AUTO.rr } = params || {};
  const ivMs = Math.max(1, ivMin) * 60000;
  const n = bars.length;
  if (n < 60) return { error: 'K 线不足 60 根，无法回放' };
  const step = bars[1].t - bars[0].t;
  if (!(step > 0)) return { error: 'K 线时间戳异常' };
  const ivBars = Math.max(1, Math.round(ivMs / step));
  const orders = [];
  let i = 50;                            // 等足够历史让指标热身
  while (i < n) {
    const visible = bars.slice(0, i + 1);
    const px = bars[i].c;
    const T = mmTradeOf(AUTO.sym, AUTO.tf, visible);
    if (T.bias !== 'long' && T.bias !== 'short') { i += ivBars; continue; }
    const dist = Math.abs(T.px - T.sl) || T.atr || px * 0.01;
    const L = autoLevels(px, T.bias, dist, rr);
    if (!L) { i += ivBars; continue; }

    /* 与实盘同口径：入场/出场都计滑点，持仓跨越 8 小时结算点计资金费。
     * 回放原本是「零滑点完美成交」，胜率与净盈亏都被系统性高估 —— 用它验证出来的
     * 参数放到实盘只会更差。这里改成跟模拟盘一模一样的口径，才有对比意义。 */
    const spread = autoSpreadPct(), fund = autoFundingRate();
    const entryPx = autoSlipPx(px, T.bias, true, spread);
    let exit = null, exitPx = null, exitIdx = i;
    for (let j = i + 1; j < n; j++) {
      const hit = autoHit(T.bias, L.sl, L.tp1, bars[j].l, bars[j].h);
      if (hit) {
        exit = hit;
        const lvl = hit === 'sl' ? L.sl : L.tp1;
        const gapped = T.bias === 'long'
          ? (hit === 'sl' ? bars[j].o < L.sl : bars[j].o > L.tp1)
          : (hit === 'sl' ? bars[j].o > L.sl : bars[j].o < L.tp1);
        exitPx = autoSlipPx(gapped ? bars[j].o : lvl, T.bias, false, spread);
        exitIdx = j;
        break;
      }
    }
    if (!exit) { exit = 'open'; exitPx = bars[n - 1].c; exitIdx = n - 1; }

    const notional = margin * lev;
    const qty = notional / entryPx;
    const gross = (exitPx - entryPx) * qty * (T.bias === 'long' ? 1 : -1);
    const fee = notional * AUTO_FEE * 2;
    const fund0 = fund == null ? 0
      : -fund * autoFundCount(bars[i].t, bars[exitIdx].t) * notional * (T.bias === 'long' ? 1 : -1);
    const pnl = gross - fee + fund0;

    /* 市况分类：用「区间涨跌 vs 同期噪声尺度」判断，而不是拍一个固定百分比 ——
     * 固定阈值在不同品种、不同周期上会整体偏向趋势或震荡，失去参考价值。
     * 噪声尺度 = 单根平均绝对涨跌 × √根数（随机游走的位移量级）。 */
    const look = Math.min(20, i);
    const prev = bars[i - look].c;
    const chg = (px / prev - 1) * 100;
    let noise = 0;
    for (let k = i - look + 1; k <= i; k++) noise += Math.abs(bars[k].c / bars[k - 1].c - 1) * 100;
    noise = noise / look * Math.sqrt(look);
    const regime = chg > noise ? 'up' : chg < -noise ? 'down' : 'range';

    orders.push({
      idx: i, exitIdx, side: T.bias, entry: entryPx, sl: L.sl, tp1: L.tp1,
      exitPx, status: exit === 'open' ? 'open' : (exit === 'tp' ? 'win' : 'loss'),
      gross, fee, fund: fund0, pnl, pnlPct: pnl / margin * 100, regime,
      mode: T.mode,
    });
    i = exitIdx + ivBars;
  }

  /* 按时间切分：前 70% 样本内，后 30% 样本外。样本外段从未来得及参与「调参」的角度
   * 检验策略，两段表现接近才说明结论稳健。 */
  const cut = Math.floor(n * 0.7);
  return {
    orders, n, cut, from: bars[0].t, to: bars[n - 1].t,
    stats: replayStatsOf(orders),
    ins: replayStatsOf(orders.filter(o => o.idx < cut)),
    oos: replayStatsOf(orders.filter(o => o.idx >= cut)),
  };
}

function renderReplay() {
  const el = $('#replayResult'), meta = $('#replayMeta');
  if (!el) return;
  const symId = AUTO.sym, tfKey = AUTO.tf;
  const s0 = SYMS[symId] || { label: symId }, tf0 = TF_MAP[tfKey] || { label: tfKey };
  const d = (S.klines[symId] || {})[tfKey];
  const setMeta = t => { if (meta) meta.textContent = t; };
  if (!d || !d.bars || d.bars.length < 60) {
    setMeta(`${s0.label} · ${tf0.label} · K 线不足`);
    el.innerHTML = '<span class="mut">当前品种/周期的 K 线不足 60 根，无法回放。点「运行回放」会先尝试拉取。</span>';
    return;
  }
  const r = autoReplay(d.bars, { ivMin: AUTO.ivMin, margin: AUTO.margin, lev: AUTO.lev, rr: AUTO.rr });
  if (r.error) { setMeta('回放失败'); el.innerHTML = `<span class="mut">${r.error}</span>`; return; }

  const day = t => new Date(t).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  setMeta(`${s0.label} · ${tf0.label} · ${r.n} 根 K 线 · ${day(r.from)} – ${day(r.to)} · 前 ${Math.round(r.cut / r.n * 100)}% 样本内 / 后 ${Math.round((r.n - r.cut) / r.n * 100)}% 样本外`);

  const cell = (label, val, cls) => `<div class="st"><span>${label}</span><b class="${cls || ''}">${val}</b></div>`;
  const block = (title, s, note) => {
    if (!s || !s.total) return `<div class="mut" style="margin-top:6px">${title}：无成交样本</div>`;
    return `<div style="margin-top:8px;font-size:11px;font-weight:700">${title}${note ? ` <span class="mut" style="font-weight:400">${note}</span>` : ''}</div>`
      + `<div class="auto-stat" style="margin-top:4px">`
      + cell('单数', s.total)
      + cell('胜率', s.rate == null ? '—' : s.rate.toFixed(0) + '%')
      + cell('净盈亏', (s.net >= 0 ? '+' : '') + fmt(s.net, 2), s.net >= 0 ? 'up' : 'down')
      + cell('最大回撤', fmt(s.maxDd, 2), 'down')
      + cell('手续费', fmt(s.fees, 2))
      + `</div>`;
  };
  const reg = s => {
    if (!s || !s.total) return '';
    const nm = { up: '上升', down: '下降', range: '震荡' };
    return ['up', 'down', 'range'].map(k => {
      const x = s.regimes[k];
      return `${nm[k]} ${x.n} 单 · ${(x.net >= 0 ? '+' : '') + fmt(x.net, 2)} · 胜率 ${x.n ? Math.round(x.win / x.n * 100) : '—'}%`;
    }).join(' ／ ');
  };
  el.innerHTML = block('全段', r.stats, '已平 ' + r.stats.closed + ' 单')
    + `<div class="mut" style="margin-top:4px;line-height:1.7">市况：${reg(r.stats)}</div>`
    + block('样本内 · 前 70%', r.ins)
    + block('样本外 · 后 30%', r.oos, r.oos && r.oos.total ? '未参与调参' : '')
    + `<div class="mut" style="margin-top:8px;line-height:1.7">`
    + `样本外与样本内表现接近 → 参数较稳健；样本外明显劣化 → 大概率过拟合，勿用于真实资金。<br>`
    + `回放为离线模拟，已计入买卖价差滑点与资金费率，口径与实时自动下单一致；`
    + `但它跑的是单周期（${tf0.label}）结论，不含四周期融合过滤，因此比实时模拟盘更宽松 —— 这是保守方向的偏差。`
    + `</div>`;
}
// 端到端测试访问（app.js 在严格模式下求值，内部函数不会挂到 window）
if (typeof window !== 'undefined') {
  window.autoReplay = autoReplay;
  window.replayStatsOf = replayStatsOf;
  window.renderReplay = renderReplay;
}

