/* ============================ P2-2：密钥与本机数据 ============================
 * 现状：这是纯静态页面，没有后端，所以密钥只能落在浏览器 localStorage。
 * 这里要做三件事：1) 把「配了什么、值是什么（掩码）」显式摆出来；
 * 2) 提供一键清除，不留「配过但忘了在哪」的隐患；
 * 3) 提供持久化记录的备份 / 恢复，避免清缓存把模拟持仓和自动交易单据一起带走。
 * 真正的「后端安全存储」需要服务端：密钥存环境变量、记录存数据库、前端只拿临时票据，
 * 静态页做不到 —— 这一点在页面上写明了，不假称安全。 */
function maskSec(v) {
  if (!v) return '未配置';
  const s = String(v);
  if (s.length <= 7) return s.slice(0, 1) + '•••••';
  return s.slice(0, 4) + '•'.repeat(Math.min(10, s.length - 7)) + s.slice(-3);
}
function backupBlob() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('mb_')) data[k] = localStorage.getItem(k);
  }
  return { app: 'market-board', ver: 2, at: new Date().toISOString(), data };
}
function initSecPanel() {
  const setTxt = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };
  const show = () => {
    const pos = (JSON.parse(localStorage.getItem('mb_pos') || '[]')).length;
    const ord = (JSON.parse(localStorage.getItem('mb_auto_v1') || '{}')).orders;
    setTxt('#kAcKey', maskSec(localStorage.getItem('mb_ackey')));
    setTxt('#kCgKey', maskSec(localStorage.getItem('mb_cgkey')));
    setTxt('#kProxy', PROXY ? PROXY.replace(/^https?:\/\//, '').slice(0, 46) : '未配置（浏览器直连）');
    setTxt('#kRecStat', `模拟持仓 ${pos} 笔 · 自动交易单据 ${Array.isArray(ord) ? ord.length : 0} 条`);
  };
  const clear = (keys, tip) => {
    keys.forEach(k => localStorage.removeItem(k));
    show(); toast(tip);
  };
  const b1 = $('#kAcClear');
  if (b1) b1.onclick = () => {
    AC_KEY = ''; AC_SEC = '';
    clear(['mb_ackey', 'mb_acsec'], 'AiCoin Key 已清除');
  };
  const b2 = $('#kCgClear');
  if (b2) b2.onclick = () => { CG_KEY = ''; clear(['mb_cgkey'], 'CoinGlass Key 已清除'); };
  const b3 = $('#kProxyClear');
  if (b3) b3.onclick = () => {
    PROXY = ''; clear(['mb_proxy'], '代理已清除，改为直连');
    Object.keys(S.venues).forEach(k => delete S.venues[k]); S.klines = {}; refresh(true);
  };
  const bk = $('#kBackup');
  if (bk) bk.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backupBlob(), null, 2)], { type: 'application/json' }));
    a.download = 'market-board-backup-' + dayKey(now()) + '.json';
    a.click();
    toast('已导出备份（含密钥，请妥善保管）');
  };
  const rs = $('#kRestore'), rf = $('#kRestoreFile');
  if (rs && rf) {
    rs.onclick = () => rf.click();
    rf.onchange = () => {
      const f = rf.files && rf.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const j = JSON.parse(String(fr.result));
          if (!j || j.app !== 'market-board' || !j.data) throw new Error('不是本看板的备份文件');
          if (!confirm(`将用备份覆盖当前本机数据（${Object.keys(j.data).length} 项），并重新加载页面。继续？`)) return;
          Object.keys(j.data).forEach(k => localStorage.setItem(k, j.data[k]));
          location.reload();
        } catch (e) { toast('恢复失败：' + (e.message || e)); }
        rf.value = '';
      };
      fr.readAsText(f);
    };
  }
  show();
}

(async function init() {
  renderTabs();
  initShare();
  renderOverview();
  syncLev();
  renderPos();
  fitCanvas();
  bindHeat();
  bindRefresh();
  bindEntry();
  bindAuto();
  initSecPanel();
  renderAuto();
  renderHeatMeta();
  drawHeat();
  renderEntry();
  renderMM(); renderDirCell();
  await refresh(true);
  await refreshOverview();                            // 五品种总览
  applyRefresh();                                     // 按当前刷新间隔启动定时刷新
  if (AUTO.on) await autoCatchUp();                   // 自动交易：按自然时间补齐错过的档位
  if (AUTO.on && AUTO.pendingSweep) autoSweepExpire(); // 页面重开后若扫单已超时，立即 skip

  /* 自动交易用独立心跳，不受顶栏「暂停刷新」影响 —— 暂停只该停界面刷新，
   * 停掉自动交易会让人以为在跑其实没跑。浏览器把后台标签的 timer 节流到分钟级，
   * 所以每次页面重新可见时再补一次单。 */
  setInterval(() => { if (AUTO.on) autoTick(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && AUTO.on) autoCatchUp();
  });
})();
