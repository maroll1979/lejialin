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

  /* 交易计划三条水平线：入场 / 止损 / 止盈①。
   * 画在图上是为了让「结论卡的四个数字」和 K 线对得上 —— 否则用户要在两个区域之间来回比价。
   * 只画落在当前视野内的线：为了让止损线可见而拉伸纵轴，会把自己最关心的那几根 K 线压扁。 */
  try {
    const T = mmTradeOf(S.sym, S.tf, bars);
    const lv = [
      ['入场', T.entry.mid, '#3355ff'],
      ['止损', T.sl, CD],
      ['止盈①', T.tp1, CU],
      ['止盈②', T.tp2, 'rgba(18,161,80,.62)'],
    ];
    ctx.font = '9px ui-monospace,Menlo,Consolas,monospace';
    for (const [lab, p, col] of lv) {
      if (!isFinite(p) || p < lo || p > hi) continue;
      const y = Y(p);
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(PL, y + .5); ctx.lineTo(PL + cW, y + .5); ctx.stroke();
      ctx.setLineDash([]);
      const w = ctx.measureText(lab + ' ' + fmt(p, dp)).width + 8;
      ctx.fillStyle = col; ctx.fillRect(PL + 2, y - 7, w, 14);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(lab + ' ' + fmt(p, dp), PL + 6, y);
    }
    ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  } catch (e) { /* 交易计划画不出来不影响 K 线本身 */ }

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

