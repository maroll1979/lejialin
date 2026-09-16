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
      ? `${modeTxt} · 因子一致度 ${mm.conf}%（非胜率）· 独立口径 ${mm.confInd}% · 有效独立证据 ${fmt(mm.nEff, 2)} 份\n`
        + mm.reasons.join('\n') + `\n${INDEP_NOTE}`
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
  const tf = TF_MAP[S.tf];
  const gap = d && d.bars ? klineGaps(d.bars, (tf ? tf.m : 60) * 60000) : { ok: true, gaps: [] };
  let txt = d ? (d.real ? `真实 K 线 · ${d.src}` : `合成 K 线 · ${d.src}`) : '—';
  if (d && !gap.ok) txt += ` · 缺失 ${gap.gaps.length} 段`;
  /* P2-1：K 线来源后面直接跟取数时刻。stale 时显示的是「上一次成功取数」的时刻，
   * 不是当前时刻 —— 否则界面上看起来数据是新的。 */
  if (d && d.ts) txt += ` · ${new Date(d.ts).toLocaleTimeString('zh-CN', { hour12: false })}`;
  el.textContent = txt;
  el.className = 'src ' + (d && d.real ? (gap.ok ? 'real' : '') : 'syn');
  if (!gap.ok) el.classList.add('warn');
  if (d) {
    const lastBar = d.bars && d.bars.length ? d.bars[d.bars.length - 1] : null;
    el.title = [
      `K 线来源：${d.src}`,
      `取数时间：${d.ts ? new Date(d.ts).toLocaleString('zh-CN', { hour12: false }) : '—'}`,
      lastBar ? `最后一根：${new Date(lastBar.t).toLocaleString('zh-CN', { hour12: false })}（${TF_MAP[S.tf].label}）` : '',
      d.bars ? `共 ${d.bars.length} 根` : '',
      d.stale ? '⚠ 本次刷新失败，沿用上一次成功拉取的真实数据' : '',
    ].filter(Boolean).join('\n');
  }
  renderLegend(d, gap);
}

/* 图例由 JS 渲染：读数必须跟着最新一根 K 线走，写死在 HTML 里的静态图例会给出过期数字，
 * 而且加一个因子（KDJ）就要手工改一次 HTML —— 这里改成按指标数组自动出列。 */
function renderLegend(d, gap) {
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
  const gapHtml = (gap && !gap.ok)
    ? `<span class="lg" style="border-color:#f6cccc;background:#fff2f2;color:#8a2626" title="K 线时间序列存在空洞，指标与自动交易均可能失真">数据不连续 <b style="color:#8a2626">缺失 ${gap.gaps.length} 段</b></span>`
    : '';
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
    + gapHtml
    + (d.stale ? `<span class="lg" style="border-color:#f6cccc;background:#fff2f2;color:#8a2626">已停止更新 <b style="color:#8a2626">${d.staleSince ? new Date(d.staleSince).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</b></span>` : '');
}

