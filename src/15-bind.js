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
    const { padL, padT, gw, gh, cw, ch, nCol, dp, H, zones } = heatBox;
    if (x < padL || x > padL + gw || y < padT || y > padT + gh) { tip.style.display = 'none'; return; }
    const j = clamp(Math.floor((x - padL) / cw), 0, nCol - 1);
    const i = clamp(HEAT_NB - 1 - Math.floor((y - padT) / ch), 0, HEAT_NB - 1);
    const c = H.grid[j][i], tot = c.l + c.s, p = H.pLo + (i + 0.5) * H.step;
    const t = H.times && H.times[Math.min(H.times.length - 1, j)];
    const net = tot > 0 ? (c.l - c.s) / tot * 100 : 0;
    const zi = (zones || []).findIndex(z => i >= z.i0 && i <= z.i1);
    const um = v => v >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(2) + '万' : fmt(v, 0);
    tip.innerHTML = `<div class="num">${fmt(p, dp)}</div>` +
      `<div class="mut" style="font-size:10px">${t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'}</div>` +
      `<div style="margin-top:4px">密度 ${H.maxV > 0 ? (tot / H.maxV * 100).toFixed(0) : 0}% · ` +
      `净向 <b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '多' : '空'} ${Math.abs(net).toFixed(0)}%</b></div>` +
      `<div class="mut" style="margin-top:3px">多 ${um(c.l)} / 空 ${um(c.s)}</div>` +
      (zi >= 0
        ? `<div style="margin-top:3px;color:${zones[zi].side === 'up' ? 'var(--down)' : 'var(--up)'}">`
          + `属清算区间 #${zi + 1} · 强度 ${Math.round(zones[zi].v * 100)}%</div>`
        : '');
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
/* 把结论卡的价位搬进下单面板：省掉手抄四个数字，也避免抄错一位。
 * 方向一并同步 —— 结论是做空时，面板还停在「买入/做多」会让人下出反向单。 */
$('#btnUsePlan').onclick = () => {
  const T = S.trade;
  if (!T || T.bias === 'wait') { flash(); return; }
  const dp = SYMS[S.sym].dp;
  S.side = T.bias;
  $('#tSide').querySelectorAll('button').forEach(x => {
    x.className = (x.dataset.v === T.bias ? 'on ' : '') + (x.dataset.v === 'long' ? 'b' : 's');
  });
  $('#tType').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === 'limit'));
  S.type = 'limit';
  $('#limitWrap').style.display = '';
  $('#fLimit').value = T.entry.mid.toFixed(dp);
  $('#fTP').value = T.tp1.toFixed(dp);
  $('#fSL').value = T.sl.toFixed(dp);
  renderEst();
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
const PUB_URL = 'https://e6cf4c9fa8d941b6b5dcebf2b00f82a9.app.workbuddy.host';
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

