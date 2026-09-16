/* ============================ 主循环 ============================ */
S.openRef = {};
async function refresh(hard) {
  const sym = S.sym;
  await loadQuotes(sym);
  if (S.openRef[sym] == null) S.openRef[sym] = S.quotes[sym].price;
  if (S.quotes[sym] && S.quotes[sym].realCount) _lastOkT = now();   // 新鲜度只认「拿到了真实源」
  renderQuote(); renderVenues(); renderEst(); renderRfAge();

  const tfs = hard ? TFS.map(t => t.k) : [S.tf];
  /* 每个周期单独 catch：一个周期取不到不该拖垮整页。
   * loadKlines 现在取不到就抛错（没有合成兜底），错误记进 S.kErr，由告警条显示并退避重试。 */
  await Promise.all(tfs.map(async k => {
    try { await loadKlines(sym, k); }
    catch (e) { S.kErr[sym + '|' + k] = String(e.message || e); }
  }));
  await loadAllHeat(sym, tfs);                 // 四格方向依赖各周期的清算热力图
  await loadAcLiq(sym);                        // 建仓前提示依赖 1 小时真实爆仓量
  if (S.sym !== sym) return;
  renderChartHead(); renderSignals(); renderMM(); renderDirCell(); renderEntry(); draw(); checkTPSL(); renderPos(); renderOverview();
  if (hard) refreshHeat(sym, S.tf).catch(() => {});   // 热力图跟随 60s 硬刷新，避免频繁请求
  renderNetAlert();
  scheduleRetry(dataBroken());

  $('#footClock').textContent = '本地时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
}

/* 当前是否处于「数据不完整」状态：没有任何真实报价，或有周期的 K 线取不到。 */
function dataBroken() {
  const q = S.quotes[S.sym];
  if (!q || !q.realCount) return true;
  return Object.keys(S.kErr).some(k => k.startsWith(S.sym + '|') && S.kErr[k]);
}

/* 显著告警条：数据不完整时必须让用户看见，而不是静默显示旧图。
 * 旧版此时已经在用合成 K 线画图了，界面上完全看不出异常 —— 这是最危险的地方。 */
function renderNetAlert() {
  const el = $('#netAlert');
  if (!el) return;
  const q = S.quotes[S.sym];
  const badTf = Object.keys(S.kErr)
    .filter(k => k.startsWith(S.sym + '|') && S.kErr[k])
    .map(k => (TF_MAP[k.split('|')[1]] || {}).label || k.split('|')[1]);
  const noSrc = !q || !q.realCount;

  if (!noSrc && !badTf.length) { el.className = 'alert-bar'; el.style.display = 'none'; el.innerHTML = ''; return; }

  const parts = [];
  if (noSrc) parts.push(`<b>${SYMS[S.sym].label} 当前没有任何交易所返回报价</b>，页面不显示任何价格（不会用估算价顶替）。`);
  if (badTf.length) parts.push(`<b>${badTf.join(' / ')}</b> K 线取数失败，图表沿用上一次成功拉取的真实数据。`);
  const lastOk = NET.lastOk ? new Date(NET.lastOk).toLocaleTimeString('zh-CN', { hour12: false }) : '从未成功';
  el.className = 'alert-bar on';
  el.style.display = '';
  el.innerHTML = `<span class="ab-dot"></span>
    <div>${parts.join(' ')}
      <div class="ab-sub">最后一次成功取数：${lastOk}${NET.relay !== 'direct' ? ` · 经 ${NET.relayName} 转发` : ' · 直连'}。
      正在自动重试${_retryN > 1 ? `（第 ${_retryN} 次）` : ''}。若长时间失败，请检查网络或到「数据源」填写自建代理。</div>
    </div>
    <button class="btn" id="abRetry">立即重试</button>`;
  const b = $('#abRetry');
  if (b) b.onclick = () => { _retryN = 0; refresh(true); };
}

/* 退避重试：数据不完整时自动重拉，间隔 5s → 8s → 13s … 上限 60s，成功后清零。 */
let _retryT = null, _retryN = 0;
function scheduleRetry(broken) {
  if (!broken) { _retryN = 0; if (_retryT) { clearTimeout(_retryT); _retryT = null; } return; }
  if (_retryT) return;
  _retryN++;
  const wait = Math.min(5000 * Math.pow(1.6, _retryN - 1), 60000);
  _retryT = setTimeout(async () => { _retryT = null; await refresh(true); }, wait);
}

/* ============================ 刷新间隔（右上角） ============================ */
/* 设计取舍：报价始终保持实时（价格滞后会直接导致误判），间隔只控制 K 线 / 四格信号 /
   热力图 / 爆单这类重数据的刷新，既能降请求频率与 AiCoin 配额消耗，又不牺牲价格新鲜度。 */
const RF_MODES = [0, 5, 10, 15, 30];
let RF_MODE = (() => {
  const v = parseInt(localStorage.getItem('mb_refresh') || '0', 10);
  return RF_MODES.includes(v) ? v : 0;
})();
let _rfTimers = [], _nextRf = 0;
let _rfPaused = localStorage.getItem('mb_rfpause') === '1';
let _rfBusy = false;                 // 正在刷新：按钮禁用 + 旋转，避免连点把请求叠起来
let _lastOkT = 0;                    // 最后一次「整页刷新成功」的时刻，用于显示数据新鲜度

/* 数据新鲜度：报价每 8 秒拉一次，但用户真正想知道的是「我现在看的这个数有多旧」。
 * 超过 90 秒没有成功取数就转红 —— 静默的陈旧数据比报错更危险。 */
function renderRfAge() {
  const el = $('#lastUpd');
  if (!el) return;
  if (!_lastOkT) { el.textContent = '尚未取到数据'; el.className = 'rf-age'; return; }
  const sec = Math.max(0, Math.round((now() - _lastOkT) / 1000));
  const txt = sec < 60 ? sec + ' 秒前' : sec < 3600 ? Math.floor(sec / 60) + ' 分前' : Math.floor(sec / 3600) + ' 小时前';
  /* P2-1：相对时间说不清「这一版数据是几点拉的」，补上绝对时刻。 */
  const abs = new Date(_lastOkT).toLocaleTimeString('zh-CN', { hour12: false });
  el.innerHTML = `数据 <b>${abs}</b> · ${txt}`;
  el.className = 'rf-age' + (sec > 90 ? ' stale' : '');
  el.title = `本页最后一次成功取数：${new Date(_lastOkT).toLocaleString('zh-CN', { hour12: false })}\n`
    + `通道：${NET.relay === 'direct' ? '直连' : '转发 · ' + NET.relayName}\n`
    + `超过 90 秒未更新会变红，此时下单判断不可靠。`;
}

async function refreshQuotes() {                  // 轻量：只刷新多平台报价与估算，不碰 K 线
  if (_rfPaused) return;                          // 暂停时连报价一起停，否则「暂停」名不副实
  const sym = S.sym;
  await loadQuotes(sym).catch(() => {});
  if (S.sym !== sym) return;
  if (S.openRef[sym] == null && S.quotes[sym]) S.openRef[sym] = S.quotes[sym].price;
  if (S.quotes[sym] && S.quotes[sym].realCount) _lastOkT = now();
  renderQuote(); renderVenues(); renderEst(); checkTPSL(); renderPos();
  renderRfAge();
}

function renderRf() {
  // 段控（#rfSeg）取代了原来的下拉框：五个档位一眼看全，不必展开才知道当前是几秒
  $('#rfSeg').querySelectorAll('[data-rf]').forEach(b =>
    b.classList.toggle('on', parseInt(b.dataset.rf, 10) === RF_MODE));
  const p = $('#rfPause');
  if (p) { p.textContent = _rfPaused ? '▶' : '⏸'; p.title = _rfPaused ? '恢复自动刷新' : '暂停自动刷新'; }
  const n = $('#rfNext');
  if (!n) return;
  if (_rfPaused) { n.textContent = '已暂停'; return; }
  if (RF_MODE === 0) { n.textContent = '实时 8s'; return; }
  const left = Math.max(0, _nextRf - now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  n.textContent = m + ':' + String(sec).padStart(2, '0');
}
function tickRf() {
  const c = $('#footClock');
  if (c) c.textContent = '本地时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
  renderRf(); renderRfAge();
}
function applyRefresh() {
  _rfTimers.forEach(clearInterval); _rfTimers = [];
  if (_rfPaused) { renderRf(); renderRfAge(); return; }
  _rfTimers.push(setInterval(() => refreshQuotes(), 8000));        // 报价：始终实时
  _rfTimers.push(setInterval(() => { if (S.quotes[S.sym]) renderQuote(); }, 1000));
  if (RF_MODE === 0) {
    _rfTimers.push(setInterval(() => refresh(true), 60000));
    _rfTimers.push(setInterval(() => refreshOverview(), 30000));
    _nextRf = now() + 60000;
  } else {
    const ms = RF_MODE * 60000;
    _rfTimers.push(setInterval(() => {
      refresh(true); refreshOverview(); _nextRf = now() + ms;
    }, ms));
    _nextRf = now() + ms;
  }
  _rfTimers.push(setInterval(tickRf, 1000));
  renderRf();
}

/* 手动刷新：报价 + K 线 + 热力图 + 爆单一次全拉，不受间隔限制。
 * 加了 busy 锁：连点会同时发出好几组请求，后回来的旧响应覆盖新数据，价格反而不准。 */
async function manualRefresh() {
  if (_rfBusy) return;
  _rfBusy = true; _rfPaused = false;
  localStorage.setItem('mb_rfpause', '0');
  const btn = $('#btnRefreshIcon');
  if (btn) { btn.classList.add('busy'); btn.textContent = '⟳ 刷新中…'; }
  _retryN = 0;
  try {
    await Promise.all([refresh(true), refreshOverview(), refreshHeat(S.sym, S.tf).catch(() => {})]);
    _lastOkT = now();
  } finally {
    _rfBusy = false;
    if (btn) { btn.classList.remove('busy'); btn.textContent = '⟳ 立即刷新'; }
    _nextRf = now() + (RF_MODE || 1) * 60000;
    applyRefresh(); renderRf();
  }
}

function bindRefresh() {
  $('#rfSeg').querySelectorAll('[data-rf]').forEach(b => b.onclick = () => {
    const v = parseInt(b.dataset.rf, 10);
    RF_MODE = RF_MODES.includes(v) ? v : 0;
    localStorage.setItem('mb_refresh', String(RF_MODE));
    _rfPaused = false; localStorage.setItem('mb_rfpause', '0');
    applyRefresh();
  });
  const pause = $('#rfPause');
  if (pause) pause.onclick = () => {
    _rfPaused = !_rfPaused;
    localStorage.setItem('mb_rfpause', _rfPaused ? '1' : '0');
    applyRefresh();
  };
  // 顶栏 ⟳ 按钮：立即全量重拉一次，不等待下一个周期
  const icon = $('#btnRefreshIcon');
  if (icon) icon.onclick = manualRefresh;
}

