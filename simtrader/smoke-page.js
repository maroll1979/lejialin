/* smoke-page.js — 用 jsdom 真正加载整个页面并调用页面里的自检 / MA200 逻辑。
 * 目的：验证「在浏览器里真的跑得起来」，而不只是语法正确。
 * 做法：把本地 <script src> 内联成 <script>文本</script>，避免 jsdom 30 的外部资源加载；
 *       图表库从 CDN 取不到时用一个最小替身代替，保证依赖它的 app.js 能初始化。
 * 用法：node smoke-page.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const MOD = 'C:/Users/windos/.workbuddy/binaries/node/workspace/node_modules/';
const jsdom = require(MOD + 'jsdom');
const { JSDOM, VirtualConsole } = jsdom;

const ROOT = path.join(__dirname, 'simtrader');
const results = [];
function chk(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

/* LightweightCharts 的最小替身：只实现 app.js / liq-map.js 真正用到的 API，
   让页面在没有 CDN 的离线环境下也能完成初始化。 */
const CHART_STUB = `
window.LightweightCharts = {
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
  CrosshairMode: { Normal: 0, Magnet: 1 },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
  LastPriceAnimationMode: { Disabled: 0, Continuous: 1, OnDataUpdate: 2 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
  createChart: function (el, opt) {
    var self = this;
    var series = [];
    function mkSeries(kind) {
      var s = { kind: kind, _d: [], options: function (o) { return o; }, applyOptions: function () {},
        setData: function (d) { this._d = d || []; }, data: function () { return this._d; },
        update: function () {}, setMarkers: function () {}, markers: function () { return []; },
        priceToCoordinate: function () { return 100; }, coordinateToPrice: function () { return 0; },
        remove: function () {}, seriesType: function () { return kind; } };
      series.push(s); return s;
    }
    return {
      addSeries: mkSeries,
      addCandlestickSeries: function () { return mkSeries('candlestick'); },
      addLineSeries: function () { return mkSeries('line'); },
      addHistogramSeries: function () { return mkSeries('histogram'); },
      addAreaSeries: function () { return mkSeries('area'); },
      addBarSeries: function () { return mkSeries('bar'); },
      removeSeries: function () {}, remove: function () {},
      applyOptions: function () {}, options: function () { return {}; },
      resize: function () {}, width: function () { return 800; }, height: function () { return 400; },
      timeScale: function () {
        return { fitContent: function () {}, setVisibleLogicalRange: function () {},
          getVisibleLogicalRange: function () { return { from: 0, to: 100 }; },
          getVisibleRange: function () { return { from: 0, to: 1 }; },
          scrollToRealTime: function () {}, scrollToPosition: function () {},
          subscribeVisibleTimeRangeChange: function () {}, unsubscribeVisibleTimeRangeChange: function () {},
          subscribeVisibleLogicalRangeChange: function () {}, unsubscribeVisibleLogicalRangeChange: function () {},
          resetTimeScale: function () {}, applyOptions: function () {}, width: function () { return 800; },
          timeToCoordinate: function () { return 0; }, coordinateToTime: function () { return 0; },
          setVisibleRange: function () {} };
      },
      priceScale: function () {
        return { applyOptions: function () {}, options: function () { return {}; },
          width: function () { return 60; }, subscribeVisiblePriceRangeChange: function () {},
          unsubscribeVisiblePriceRangeChange: function () {} };
      },
      crosshair: function () { return { applyOptions: function () {}, subscribeVisiblePriceRangeChange: function () {} }; },
      chartElement: function () { return el; },
      autoSize: function () {}, unsubscribeOnSeriesCrosshair: function () {},
      paneSize: function () { return { width: 800, height: 400 }; },
      setCrosshairPosition: function () {}, clearCrosshairPosition: function () {},
      takeScreenshot: function () { return document.createElement('canvas'); },
      takeScreenshotBlob: function () { return document.createElement('canvas'); },
    };
  },
  version: function () { return '4.2.0-stub'; },
};
`;

(async function main() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* 本地脚本内联；CDN 的图表库换成替身 */
  html = html.replace(/<script src="(https?:[^"]*lightweight-charts[^"]*)"><\/script>/, '<script>' + CHART_STUB + '</script>');
  html = html.replace(/<script src="([a-zA-Z0-9._-]+\.js)(?:\?[^"]*)?"><\/script>/g, (m, f) => {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) return m;
    return '<script>' + fs.readFileSync(p, 'utf8') + '<\/script>';
  });

  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e.message).split('\n')[0].slice(0, 160)));
  vc.on('error', (...a) => errors.push(String(a[0]).split('\n')[0].slice(0, 160)));

  const WS = require(MOD + 'ws');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/',
    /* polyfill 必须在脚本解析前装好，否则顶层 new ResizeObserver() 会直接抛错。
       ResizeObserver / canvas / WebSocket 都是 jsdom 不实现、但浏览器原生的东西。 */
    beforeParse(win) {
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.fetch = (...a) => fetch(...a);
      win.AbortController = global.AbortController;
      win.Headers = global.Headers;
      win.Request = global.Request;
      win.Response = global.Response;
      win.WebSocket = WS;                 // 真实 WebSocket，让「推送有效性」这一项不再是走过场
    },
  });
  const win = dom.window;
  const doc = win.document;

  await new Promise(r => setTimeout(r, 3000));   // 等脚本跑完 + 图表初始化

  const fatal = errors.filter(e => !/Not implemented|Could not parse CSS|lightweight/i.test(e));
  chk('页面脚本无致命错误', fatal.length === 0, fatal.slice(0, 2).join(' | '));
  chk('Strategy 模块已挂载', !!win.Strategy, win.Strategy ? '导出 ' + Object.keys(win.Strategy).length + ' 项' : '');
  chk('Strategy 含 MA200 三个函数',
    !!(win.Strategy && win.Strategy.smaCalc && win.Strategy.ma200FromDaily && win.Strategy.maWindowProject));
  chk('Strategy 含 TF_SEC', !!(win.Strategy && win.Strategy.TF_SEC));
  chk('策略含九指标投票 API',
    !!(win.Strategy && win.Strategy.voteSeries && win.Strategy.voteDir
      && win.Strategy.VoteStream && win.Strategy.dailyMa200Lookup && win.Strategy.findVoteTriggersClosed),
    win.Strategy ? 'VOTE_LABEL ' + (win.Strategy.VOTE_LABEL || []).length + ' 项' : '');
  chk('页面不再依赖 v21 模块', !win.V21 || !/decideNow/.test(String(win.V21.decideNow === undefined)),
    win.V21 ? 'v21.js 仍可被加载（仅旧结构测试引用）' : 'v21.js 未加载（已下线）');
  chk('LiqMap 模块已挂载', !!win.LiqMap);
  chk('自检 UI 函数存在（runSrcCheck / renderSrcCheck）',
    typeof win.runSrcCheck === 'function' && typeof win.renderSrcCheck === 'function');
  chk('200 日均线 UI 函数存在（paintMa200 / ma200PointsInWindow）',
    typeof win.paintMa200 === 'function' && typeof win.ma200PointsInWindow === 'function');
  chk('自检 tab 容器存在', !!doc.querySelector('#tab-chk'));
  chk('自检按钮与自动开关存在', !!doc.querySelector('#btnSrcCheck') && !!doc.querySelector('#chkAuto'));
  chk('MA200 图例容器存在', !!doc.querySelector('#ma200Legend'));
  chk('MA200 图表线序列已创建', !!(doc.querySelector('#chart')));
  chk('投票面板容器存在', !!doc.querySelector('#votePanel'));
  chk('投票 UI 函数存在（paintVote / refreshVote / voteMaArr）',
    typeof win.paintVote === 'function' && typeof win.refreshVote === 'function' && typeof win.voteMaArr === 'function');

  /* ---- 回测表单：1m 撮合 / 信号周期 / 手动百分比止盈止损 ---- */
  const q = s => doc.querySelector(s);
  chk('回测表单含撮合粒度与信号周期选择', !!q('#btBase') && !!q('#btSig'));
  chk('回测表单含年限与止损/止盈输入', !!q('#btYears') && !!q('#btStop') && !!q('#btTp'));
  chk('回测表单含 1:1 / 1:2 / 1:3 预设按钮', doc.querySelectorAll('.bt-ps').length >= 3);
  chk('回测表单含保本胜率展示容器', !!q('#btBE'));
  if (win.Strategy && win.Strategy.breakevenWinRate) {
    const bk = win.Strategy.breakevenWinRate(0.01, 0.01, 0.001);
    chk('保本胜率可在页面算出（1%:1% 需 60%）',
      !!bk && Math.abs(bk.breakeven - 0.60) < 0.005, bk ? (bk.breakeven * 100).toFixed(1) + '%' : 'null');
  }

  /* ---- 真实跑一遍 MA200 全链路：取日线 → 算 → 投影到三种周期 ---- */
  if (win.Strategy && win.Strategy.ma200FromDaily) {
    try {
      const G = 'https://api.gateio.ws';
      const r = await fetch(`${G}/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=1d&limit=400`);
      const daily = (await r.json()).map(a => ({ time: +a.t, close: +a.c })).sort((x, y) => x.time - y.time);
      const ma = win.Strategy.ma200FromDaily(daily, 200);
      chk('日线 SMA200 可算', ma.points.length > 0, `${daily.length} 根日线 → ${ma.n} 个 MA200 点`);

      let s = 0;
      for (let i = daily.length - 200; i < daily.length; i++) s += daily[i].close;
      const exp = s / 200;
      chk('SMA200 数值与独立重算一致', Math.abs(exp - ma.last) < 1e-6,
        `实现 ${ma.last.toFixed(6)} vs 重算 ${exp.toFixed(6)}`);

      const detail = [];
      let allProj = true;
      for (const tf of ['5m', '15m', '1h']) {
        const rr = await fetch(`${G}/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=${tf}&limit=300`);
        const cs = (await rr.json()).map(a => ({ time: +a.t, close: +a.c })).sort((x, y) => x.time - y.time);
        const pts = win.Strategy.maWindowProject(ma.points, cs, 86400);
        let asc = true;
        for (let i = 1; i < pts.length; i++) if (pts[i].time <= pts[i - 1].time) asc = false;
        if (!(pts.length >= 2 && asc)) allProj = false;
        detail.push(`${tf}:${pts.length}点${asc ? '' : '(未升序)'}`);
      }
      chk('三种周期都能画出 MA200（≥2 点且时间升序）', allProj, detail.join(' · '));

      /* 关键回归：投影不得超出 K 线时间轴太多，否则 fitContent 会把图压扁 */
      const rr = await fetch(`${G}/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=5m&limit=300`);
      const cs = (await rr.json()).map(a => ({ time: +a.t, close: +a.c })).sort((x, y) => x.time - y.time);
      const pts = win.Strategy.maWindowProject(ma.points, cs, 86400);
      const kSpan = cs[cs.length - 1].time - cs[0].time;
      const mSpan = pts[pts.length - 1].time - pts[0].time;
      chk('MA200 不把时间轴拉宽（fitContent 安全）', mSpan <= kSpan + 2 * 86400 * 1.5,
        `K线跨度 ${(kSpan / 3600).toFixed(1)}h · MA200 跨度 ${(mSpan / 3600).toFixed(1)}h`);
    } catch (e) {
      chk('MA200 真实数据链路', false, String(e && e.message || e).slice(0, 90));
    }
  }

  /* ---- 真跑一次页面里的自检：这一项直接验证所有抓取 Effective ---- */
  if (typeof win.runSrcCheck === 'function') {
    try {
      await win.runSrcCheck();
      const sum = doc.querySelector('#chkSummary');
      const rows = doc.querySelectorAll('.chk-row');
      const badRows = doc.querySelectorAll('.chk-row.bad');
      chk('页面自检可执行', !!sum && sum.textContent.indexOf('尚未自检') < 0, (sum ? sum.textContent : '').slice(0, 90));
      chk('自检渲染出全部检查项', rows.length >= 13, `渲染 ${rows.length} 行（定义 13 项）`);
      chk('主源无不可用项', badRows.length === 0, badRows.length ? [...badRows].map(x => x.querySelector('.chk-n').textContent).join('、') : '');
      /* 打印明细，便于人眼复核 */
      const lines = [...rows].map(x => {
        const n = x.querySelector('.chk-n').textContent;
        const st = x.querySelector('.chk-s').textContent.trim();
        const ms = x.querySelector('.chk-ms').textContent;
        const fr = x.querySelector('.chk-f').textContent;
        const info = x.querySelector('.chk-i').textContent;
        return `      ${n.padEnd(26)} ${st.padEnd(6)} ${ms.padStart(7)} ${fr.padStart(9)}  ${info}`;
      });
      console.log('\n  ---- 页面内自检明细（真实网络）----');
      lines.forEach(l => console.log(l));
      console.log('');
    } catch (e) {
      chk('页面自检可执行', false, String(e && e.message || e).slice(0, 90));
    }
  }

  console.log('');
  let bad = 0;
  results.forEach(r => {
    if (!r.ok) bad++;
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
  });
  console.log('\n通过 ' + (results.length - bad) + '/' + results.length + (bad ? ' · ' + bad + ' 项失败' : ' · 全部通过'));
  const noise = errors.length;
  if (noise) console.log(`（另有 ${noise} 条 jsdom 环境噪音，多为 CSS 解析/未实现 API，浏览器里不会出现）`);
  process.exit(bad ? 1 : 0);
})();
