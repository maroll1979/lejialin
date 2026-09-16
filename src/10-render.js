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
  txt.title = relaySummary();
  if (NET.switches) txt.title += `\n\n已自动切换通道 ${NET.switches} 次`;
  renderQuoteStamp();
}

/* P2-1：把「数据时间 + 来源」钉在价格正下方。
 * 价格是决策依据，但不知道它是几点几分、来自哪几个交易所，这个价格本身就不可信 ——
 * 之前只有顶栏一个「N 秒前」，看不出具体时刻，也看不出是直连还是转发。 */
function renderQuoteStamp() {
  const el = $('#qStamp');
  if (!el) return;
  const q = S.quotes[S.sym];
  if (!q) { el.innerHTML = '<span class="mut">尚无报价</span>'; return; }
  const age = Math.max(0, Math.round((now() - (q.ts || 0)) / 1000));
  const abs = (q.ts ? new Date(q.ts) : new Date()).toLocaleTimeString('zh-CN', { hour12: false });
  const via = NET.relay === 'direct' ? '直连' : '转发 · ' + NET.relayName;
  const names = (q.rows || []).map(r => r.name).join(' / ') || '无';
  const refNames = (q.refRows || []).map(r => r.name).join(' / ') || '无';
  el.innerHTML = `数据时间 <b>${abs}</b>`
    + ` · <span class="${age > 30 ? 'stale' : ''}">${age} 秒前</span>`
    + ` · ${q.realCount} 源永续 · ${via}`;
  el.title = [
    `报价时间：${(q.ts ? new Date(q.ts) : new Date()).toLocaleString('zh-CN', { hour12: false })}`,
    `参与价差对比（永续）：${names}`,
    `仅作参考（现货 / 期货）：${refNames}`,
    `取数耗时 ${q.dur || 0} ms · 通道：${via}`,
    age > 30 ? '⚠ 报价超过 30 秒未更新' : '',
  ].filter(Boolean).join('\n');
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
    /* 分级标签：只有 CoinGlass / AiCoin 的真实清算记录才配叫「历史爆仓」，
     * 其余两条链路都是「潜在清算区模型」—— 用词上不许让人误以为是真实爆仓位置。 */
    const gTag = L ? (a.grade === 'real' ? '历史爆仓记录' : '潜在清算区模型')
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
      <div class="sig-act">${act}<br><span class="mut" title="${CONF_NOTE} ${INDEP_NOTE}">五因子合成 ${Math.round(a.score)} · 因子一致度 ${Math.round((FZ ? FZ.conf : 0) * 100)}%（非胜率）`
        + (FZ ? ` · 独立口径 ${Math.round(FZ.confInd * 100)}% · 有效独立证据 ${fmt(FZ.nEff, 2)} 份` : '')
        + ` · 建议仓位 ≤ 保证金的 ${Math.round(a.posPct)}%</span></div>
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
      + `判定为<b>扫单后反转（Judas）</b>，不是趋势延续。最终偏向 <b>${dirW}</b>，扫单倾向 <b>${sweepLabel(el.sweep.score).txt}</b>（模型相对评分，未经样本校准，不是概率）。`;
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
    opCard(el.bands.find(b => b.kind === 'sweep'), el.sweep ? `先扫区间 · 倾向${sweepLabel(el.sweep.score).txt}` : '先扫区间', 'o-sweep'),
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

/* 报价条里的「做市商方向」：把做市商结论提到最显眼的位置，一眼看到结论再往下看理由。
 * 方向取自四周期融合决策（不是当前选中的周期），价位仍按选中周期的结构给出。 */
function renderDirCell() {
  const d = S.klines[S.sym]?.[S.tf];
  const elCell = $('#qDir'), sub = $('#qDirSub'), tfEl = $('#qDirTf');
  if (!elCell) return;
  if (tfEl) tfEl.textContent = '四周期融合 · 价位按 ' + ((TF_MAP[S.tf] || {}).label || S.tf);
  if (!d || !d.bars.length) { elCell.textContent = '—'; elCell.className = 'q-v'; sub.textContent = 'K 线加载中…'; return; }
  const dec = mtfDecision(S.sym);
  const mtf = mtfPlan(S.sym, S.tf);
  const el = (mtf.plan && mtf.plan.mm) || mmView(S.sym, S.tf, d.bars);
  const s = SYMS[S.sym];
  const bias = dec.bias;
  const txt = bias === 'long' ? '做多' : bias === 'short' ? '做空' : '观望';
  const cls = bias === 'long' ? 'up' : bias === 'short' ? 'down' : 'flat';
  elCell.textContent = txt;
  elCell.className = 'q-v ' + cls;

  const modeW = !dec.ok ? '四层未通过'
    : dec.need === 'sweep' ? '等扫单收回' : el.mode === 'sweep' ? '扫单后反转' : el.mode === 'follow' ? '顺势' : '观望';
  const b = el.bands.find(x => x.kind === 'target');
  const tail = !dec.ok
    ? (dec.reasons[dec.reasons.length - 1] || '多周期未达成一致')
    : el.mode === 'sweep' && el.sweep
      ? `先扫${el.sweep.side === 'up' ? '上' : '下'} ${fmt(el.sweep.lo, s.dp)}–${fmt(el.sweep.hi, s.dp)}，再${txt}`
      : b ? `目标 ${fmt(b.lo, s.dp)}–${fmt(b.hi, s.dp)}` : '无明确目标带';
  sub.innerHTML = `${modeW} · ${tail}`;
  sub.title = `${modeW}｜四层一致度 ${dec.conf}%（非胜率，四层同源）｜${tail}\n${dec.reasons.join('\n')}\n${MTF_CONF_NOTE}`;
}

/* ---- 结论区：一句话方向 + 四个可执行价位 ----
 * 这一块是本页的核心输出，其余（五因子、价格带、多周期）都收进折叠里当依据。
 * 理由很直接：看板打开时人要先知道「做多还是做空、在哪进、错了在哪跑、对了在哪收」，
 * 因子分值属于论证过程，挡在结论前面会让人先看到一堆数字却不知道该干什么。 */
function renderVerdict(el, T, s) {
  const dp = s.dp, vd = $('#mmVerdict'), lvs = $('#mmLevels'), rrb = $('#mmRr');
  if (!vd) return;
  const biasTxt = T.bias === 'long' ? '做多' : T.bias === 'short' ? '做空' : '观望';
  const modeTxt = el.mode === 'follow' ? '顺势 · 流动性与结构同向'
    : el.mode === 'sweep' ? '扫单后反转 · 流动性背离'
    : '观望 · 因子矛盾或挤压';

  const sub = [];
  if (el.trap) sub.push(`<b style="color:var(--warn)">陷阱</b>：${el.trap.why}`);
  if (el.mode === 'sweep' && el.sweep)
    sub.push(`先扫${el.sweep.side === 'up' ? '上方' : '下方'} ${fmt(el.sweep.lo, dp)}–${fmt(el.sweep.hi, dp)}（扫单倾向${sweepLabel(el.sweep.score).txt}），扫完再${biasTxt}。`);
  if (!F_hasHeat(el)) sub.push('本周期无清算数据，价位由 ATR 与结构推导，精度低于有清算带时。');
  sub.push(`依据：结构 ${Math.round(el.F.st.s * 100)} · MACD ${Math.round(el.F.mc.s * 100)} · OBV ${Math.round(el.F.ob.s * 100)} · BOLL ${Math.round(el.F.bl.s * 100)} · KDJ ${Math.round(el.F.kd.s * 100)}。`);

  vd.innerHTML =
    `<span class="vd-badge ${T.bias}">${biasTxt}</span>
     <div class="vd-main">
       <div class="vd-t">${modeTxt} —— ${mmThesis(el, s)}</div>
       <div class="vd-s">${sub.join(' ')}</div>
     </div>
     <div class="vd-meta">
       <div title="${CONF_NOTE} ${INDEP_NOTE}"><span>因子一致度</span><b>${T.conf}%</b>
         <u class="vd-sub">独立口径 ${T.confInd == null ? '—' : T.confInd + '%'} · 证据 ${fmt(T.nEff == null ? 0 : T.nEff, 2)} 份</u></div>
       <div title="合成分 = 原始合成分（技术五因子加权分，再经清算因子最多 ±32% 的乘性修正）× 一致性加成；加成按有效独立证据折算，详见因子一致度说明"><span>合成分</span><b>${T.score >= 0 ? '+' : ''}${Math.round(T.score)}</b>
         <u class="vd-sub">原始 ${Math.round(el.F.raw)} × ${fmt(el.F.confMult, 2)}</u></div>
       <div><span>现价</span><b>${fmt(T.px, dp)}</b></div>
     </div>`;

  if (!lvs) return;
  const cell = (k, t, sub2, v, pc, d) => `<div class="lv k-${k}">
      <div class="t"><span>${t}</span><u>${sub2}</u></div>
      <div class="v">${v}</div>
      <div class="s">${pc}</div>
      <div class="d">${d}</div>
    </div>`;
  const pc = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  lvs.innerHTML =
    cell('entry', '入场区间', '挂单', `${fmt(T.entry.lo, dp)} – ${fmt(T.entry.hi, dp)}`,
      `${pc(T.entryPctLo)} ~ ${pc(T.entryPctHi)}`,
      T.bias === 'long' ? '回踩不破再进，破了说明结构已变' : T.bias === 'short' ? '反抽不过再进，过了说明结构已变' : '方向未定，不建议挂单')
    + cell('sl', '止损 SL', '失效位', fmt(T.sl, dp), pc(T.slPct), T.slWhy)
    + cell('tp1', '止盈 TP1', '第一目标', fmt(T.tp1, dp), pc(T.tp1Pct), T.tp1Why)
    + cell('tp2', '止盈 TP2', '第二目标', fmt(T.tp2, dp), pc(T.tp2Pct), T.tp2Why);

  if (!rrb) return;
  const rrTxt = T.rr == null ? '—' : T.rr.toFixed(2) + ' : 1';
  const rrPct = T.rr == null ? 0 : clamp(T.rr / 3 * 100, 2, 100);   // 3:1 打满
  const low = T.rr != null && T.rr < 1.2;
  rrb.innerHTML =
    `<div><div class="rr-k">盈亏比（TP1 / SL）</div><div class="rr-v" style="color:${low ? 'var(--warn)' : 'var(--up)'}">${rrTxt}</div></div>
     <div class="rr-bar"><i class="${low ? 'low' : ''}" style="width:${rrPct.toFixed(1)}%"></i><u></u></div>
     <div><div class="rr-k">单笔风险</div><div class="rr-v">${fmt(T.riskPct, 2)}%</div></div>
     <div><div class="rr-k">建议保证金</div><div class="rr-v">≤ ${Math.round(T.posPct)}%</div></div>
     <div><div class="rr-k">预计持有</div><div class="rr-v" style="font-size:13px">${T.hold}</div></div>`
    + (low && T.bias !== 'wait'
      ? `<div class="mut" style="font-size:11px;width:100%">盈亏比低于 1.2，性价比不足 —— 要么等回踩到入场区下沿再进，要么直接放弃这笔。</div>`
      : '');
}
function F_hasHeat(el) { return !!(el && el.F && el.F.hasHeat); }

/* ============================ 渲染：四周期融合决策（唯一总决策） ============================
 * 四个周期之前只是并排展示，结论却是各读各的 —— 顶部跟随选中周期、模拟盘跟随设置周期，
 * 于是「15m 做多 / 4h 做空」的行情里模拟盘仍照着 1h 开多。
 * 这里把流水线画出来：4h 定趋势 → 1h 筛选机会 → 30m 观察回调 → 15m 触发进场，
 * 任何一层不过就整体观望。顶部结论的价位、模拟盘的开仓，都只认这一个结论。 */
const MTF_STEPS = [
  { tf: '4h', key: 'trend', n: 1, role: '趋势层', duty: '定方向' },
  { tf: '1h', key: 'setup', n: 2, role: '机会层', duty: '定位置' },
  { tf: '30m', key: 'pullback', n: 3, role: '回调层', duty: '定时机' },
  { tf: '15m', key: 'trigger', n: 4, role: '触发层', duty: '定发令' },
];
function renderMtf() {
  const box = $('#mtfBox');
  if (!box) return null;
  const dec = mtfDecision(S.sym);
  const dirTxt = dec.bias === 'long' ? '做多' : dec.bias === 'short' ? '做空' : '观望';
  const dirCls = dec.bias === 'long' ? 'up' : dec.bias === 'short' ? 'down' : 'flat';
  const nPass = MTF_STEPS.filter(x => dec.layers[x.key] && dec.layers[x.key].pass).length;

  const steps = MTF_STEPS.map(x => {
    const L = dec.layers[x.key];
    const st = !L ? 'nodata' : L.pass ? 'pass' : 'fail';
    let val = '—', sub = '';
    if (L) {
      if (x.key === 'pullback') {
        val = L.state === 'ok' ? '回调到位' : L.state === 'extension' ? '追价中' : L.state === 'deep' ? '回撤过深' : '无数据';
        sub = L.retrace != null ? `回撤 ${Math.round(L.retrace * 100)}%` : '';
      } else {
        val = L.bias === 'long' ? '做多' : L.bias === 'short' ? '做空' : '观望';
        sub = L.score != null ? `合成分 ${Math.round(L.score)}` : '';
      }
    }
    return `<div class="mtf-step ${st}">
      <div class="mtf-n">${x.n}</div>
      <div class="mtf-b"><span>${MTF_LABEL[x.tf]}</span><b>${x.role} · ${x.duty}</b></div>
      <div class="mtf-v ${st === 'pass' ? dirCls : ''}">${val}</div>
      <div class="mtf-s">${sub || (st === 'nodata' ? '数据未就绪' : st === 'fail' ? '未通过' : '')}</div>
    </div>`;
  }).join('<i class="mtf-arrow">›</i>');

  const why = dec.reasons.map(r => `<li>${r}</li>`).join('');
  box.innerHTML = `
    <div class="mtf-hd">
      <span class="mtf-t">四周期融合决策</span>
      <span class="mtf-badge ${dirCls}">${dirTxt}</span>
      <span class="mut" style="font-size:11px">四层流水线 · 通过 ${nPass}/4 · ${mtfStageTxt(dec)}</span>
      <span class="mtf-conf" title="${MTF_CONF_NOTE}">四层一致度 ${dec.ok ? dec.conf + '%' : '—'}（非胜率 · 四层同源）</span>
      ${dec.degraded ? '<span class="atag skip">降级：缺 ' + dec.missing.map(t => MTF_LABEL[t]).join('/') + '</span>' : ''}
    </div>
    <div class="mtf-pipe">${steps}</div>
    <ul class="mtf-why">${why}</ul>`;
  return dec;
}

function renderMM() {
  const d = S.klines[S.sym]?.[S.tf];
  const s = SYMS[S.sym];
  const src = $('#mmSrc'), ts = $('#mmTs');
  const tfl = $('#mmTf'); if (tfl) tfl.textContent = (TF_MAP[S.tf] || {}).label || S.tf;
  if (!d || !d.bars.length) {
    $('#mmHd').innerHTML = '<span class="mut">K 线加载中…</span>';
    $('#mmGrid').innerHTML = ''; $('#mmPlan').innerHTML = '—';
    const zb = $('#mmZones'); if (zb) zb.innerHTML = '';
    $('#mmFac5').innerHTML = '';          // 不清的话会留着上一个品种的因子分，与新标题对不上
    src.textContent = '—'; src.className = 'src'; ts.textContent = '';
    // 结论区同样要清空：留着上一个品种的入场/止损会让人照着错的价位下单
    const vd = $('#mmVerdict'), lvs = $('#mmLevels'), rrb = $('#mmRr');
    if (vd) vd.innerHTML = '<div class="vd-main"><div class="vd-t mut">等待真实 K 线…</div></div>';
    if (lvs) lvs.innerHTML = '';
    if (rrb) rrb.innerHTML = '';
    return;
  }
  /* 方向一律取自四周期融合决策；价位按当前选中的周期给（15m 的 ATR 太窄、4h 太宽，
   * 用选中周期的结构风险距离当止损基准最合适）。mmTrade 的 forceBias 保证二者不会打架。 */
  const dec = renderMtf();
  const mtf = mtfPlan(S.sym, S.tf);
  const el = (mtf.plan && mtf.plan.mm) || mmView(S.sym, S.tf, d.bars);
  const F = el.F;
  const T = mtf.plan || mmTrade(S.sym, S.tf, d.bars, F);
  S.trade = T;                              // 供「套用结论价」按钮与下单面板复用
  src.textContent = `方向＝四周期融合 · 价位＝${TF_MAP[S.tf].label}结构 · ${F.hasHeat ? F.src : '无清算数据'}`;
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
    `<span class="mm-sub" title="${CONF_NOTE} ${INDEP_NOTE}">因子一致度 ${el.conf}%（非胜率） · 独立口径 ${el.confInd}% · 有效独立证据 ${fmt(el.nEff, 2)} 份 · 合成 ${Math.round(F.score)} · 现价 ${fmt(el.px, s.dp)}</span>`;

  renderVerdict(el, T, s);                  // 结论 + 四个可执行价位（本页重点）

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
  const sw = el.sweep ? sweepLabel(el.sweep.score) : null;
  const swCard = `<div class="mm-c">
    <div class="k" title="${SWEEP_TENDENCY_NOTE}"><span>扫单倾向${sw && !sw.calib ? '<i class="mut" style="font-style:normal;opacity:.65">未校准</i>' : ''}</span><em class="${sw ? sw.cls : ''}">${sw ? sw.txt : '—'}</em></div>
    <div class="v">${el.sweep ? `${el.sweep.side === 'up' ? '先扫上方' : '先扫下方'} <b>${fmt(el.sweep.p, s.dp)}</b>` : (el.mode === 'follow' ? '与结构同向，无需扫单' : '未定位到扫单位')}</div>
    <div class="v mut" style="font-size:10.5px;margin-top:4px">${el.sweep ? `${el.sweep.side === 'up' ? '空单' : '多单'}清算带 · 强度 ${Math.round(el.sweep.v * 100)}% · 距现价 ${fmt(el.sweep.dpct, 2)}%` : '做市商需流动性才推得动价格'}</div>
    <div class="v mut" style="font-size:10px;margin-top:4px;color:var(--tx-3)">${SWEEP_TENDENCY_NOTE}</div>
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
    + '该结论由清算热力图、K 线结构、MACD、OBV、BOLL 五项共同给出，<b>任一因子都不能单独定方向</b>。'
    + '<br><b>方向来自四层流水线</b>：4h 定趋势 → 1h 筛选机会 → 30m 观察回调 → 15m 触发进场，'
    + '任何一层不过就整体观望；本卡片的价位按当前选中周期的结构给出，方向则强制与总决策一致。'
    + `<br>${CONF_NOTE}`
    + `<br>${INDEP_NOTE}`
    + `<br>${MTF_CONF_NOTE}`
    + `<br>${SWEEP_TENDENCY_NOTE}`
    + '不构成投资建议。';
}

