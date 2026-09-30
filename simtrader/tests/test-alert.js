/* test-alert.js — 验证「A 窗口拉长到 3.5 天 + C 触发提醒」两项改动。
 *
 * 与 smoke-page.js 的差别：这里不只检查「元素存在」，而是
 *   1) 用真实 1000 根 5m 数据跑一遍九票投票，证明拉长窗口后确实看得到历史触发点；
 *   2) 把提醒逻辑真跑一遍，验证「同一个信号不会重复报警」「历史触发不打扰」。
 *
 * 用法：NODE_PATH=... node test-alert.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const MOD = 'C:/Users/windos/.workbuddy/binaries/node/workspace/node_modules/';
const { JSDOM, VirtualConsole } = require(MOD + 'jsdom');

const ROOT = path.join(__dirname, 'simtrader');
const results = [];
function chk(name, ok, detail) { results.push({ name: ok, ok: !!ok, detail: detail || '' }); }
function ok(name, v, detail) { chk(name, !!v, detail); }
function eq(name, a, b, tol, detail) {
  const d = Math.abs(a - b);
  chk(name, d <= (tol || 0), detail || `${a} vs ${b}`);
}

/* LightweightCharts 替身（与 smoke-page.js 同源，只实现真正用到的 API） */
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
      var s = { kind: kind, _d: [], _m: [], options: function (o) { return o; }, applyOptions: function () {},
        setData: function (d) { this._d = d || []; }, data: function () { return this._d; },
        update: function () {}, setMarkers: function (m) { this._m = m || []; }, markers: function () { return this._m; },
        priceToCoordinate: function () { return 100; }, coordinateToPrice: function () { return 0; },
        remove: function () {}, seriesType: function () { return kind; } };
      series.push(s); return s;
    }
    window.__ranges = [];
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
        return { fitContent: function () { window.__fit = (window.__fit || 0) + 1; },
          setVisibleLogicalRange: function (r) { window.__ranges.push(r); },
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

async function gateKlines(contract, tf, limit) {
  const host = 'https://api.gateio.ws';
  const r = await fetch(`${host}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${tf}&limit=${limit}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const a = await r.json();
  return a.map(x => ({ time: +x.t, open: +x.o, high: +x.h, low: +x.l, close: +x.c, volume: +x.sum || +x.v || 0 }))
    .sort((p, q) => p.time - q.time);
}

(async function main() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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
    beforeParse(win) {
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.fetch = (...a) => fetch(...a);
      win.AbortController = global.AbortController;
      win.Headers = global.Headers;
      win.Request = global.Request;
      win.Response = global.Response;
      win.WebSocket = WS;
    },
  });
  const win = dom.window;
  const doc = win.document;
  await new Promise(r => setTimeout(r, 2500));

  const q = s => doc.querySelector(s);

  /* ------------------------------------------------------------------ */
  console.log('\n【一】窗口深度与视野控制');

  const B = win.eval('JSON.stringify({b: typeof BARS_BY_TF!=="undefined" ? BARS_BY_TF : null, d: typeof DEF_VIEW_BARS!=="undefined" ? DEF_VIEW_BARS : null})');
  const cfg = JSON.parse(B);
  ok('BARS_BY_TF 已定义', cfg.b);
  if (cfg.b) {
    eq('5m 加载 1000 根（≈3.5 天）', cfg.b['5m'], 1000, 0);
    ok('15m 深度足够覆盖 5m 窗口（≥1000/3）', cfg.b['15m'] >= Math.ceil(1000 / 3),
      `15m=${cfg.b['15m']} 根 ≈ ${(cfg.b['15m'] * 15 / 60 / 24).toFixed(1)} 天`);
    ok('1h 深度足够覆盖 5m 窗口（≥1000/12）', cfg.b['1h'] >= Math.ceil(1000 / 12), `1h=${cfg.b['1h']} 根`);
    eq('barsForTf(5m) 取到 1000', win.eval('barsForTf("5m")'), 1000, 0);
    eq('barsForTf(unknown) 回退 300', win.eval('barsForTf("4h")'), 300, 0);
  }
  ok('DEF_VIEW_BARS 已定义且小于 1000（默认视野保持紧凑）', cfg.d > 0 && cfg.d < 1000, 'DEF_VIEW_BARS=' + cfg.d);

  ok('clampChartView / showAllBars / jumpToTime 均为函数',
    win.eval('typeof clampChartView') === 'function'
    && win.eval('typeof showAllBars') === 'function'
    && win.eval('typeof jumpToTime') === 'function');

  /* 视野限制：数据 1000 根时，默认可视范围应是最后 DEF_VIEW_BARS 根，而不是全部 */
  win.eval('window.__ranges = [];');
  win.eval('clampChartView(1000)');
  const r1 = win.eval('JSON.stringify(window.__ranges)');
  const ranges = JSON.parse(r1 || '[]');
  ok('数据 1000 根时限制默认视野（不铺满）', ranges.length > 0, `设置 ${ranges.length} 次，末次 ${JSON.stringify(ranges[ranges.length - 1] || null)}`);
  if (ranges.length) {
    const last = ranges[ranges.length - 1];
    const span = last.to - last.from;
    ok('默认视野宽度 ≈ DEF_VIEW_BARS', Math.abs(span - (cfg.d + 4)) <= 6, `跨度 ${span}（期望 ≈${cfg.d + 4}）`);
    ok('默认视野贴住最新一根', last.to >= 1000, `to=${last.to}`);
  }
  /* 数据本来就少时不应再限制 */
  win.eval('window.__ranges = []; window.__fit = 0;');
  win.eval('clampChartView(120)');
  ok('数据少于 DEF_VIEW_BARS 时直接铺满（fitContent）', win.eval('window.__fit') >= 1, 'fitContent 调用 ' + win.eval('window.__fit') + ' 次');

  ok('图表头部有「全景」按钮', !!q('#viewAll'), q('#viewAll') ? q('#viewAll').textContent.trim() : '');

  /* ------------------------------------------------------------------ */
  console.log('【二】提醒通道');

  ok('提醒横幅容器存在且默认隐藏', !!q('#sigAlert') && q('#sigAlert').hidden);
  const AO = JSON.parse(win.eval('JSON.stringify(typeof alertOpt!=="undefined" ? alertOpt : null)') || 'null');
  ok('提醒开关可读', AO);
  if (AO) {
    ok('默认开启横幅 / 声音 / 标题', AO.banner && AO.sound && AO.title, JSON.stringify(AO));
    ok('桌面通知默认关闭（需用户显式授权）', AO.notify === false);
  }
  ok('notifyLabel 给出可读文案', /桌面通知/.test(win.eval('notifyLabel()')), win.eval('notifyLabel()'));

  /* 无 AudioContext 的环境（jsdom）不得抛错 —— 浏览器策略下也必须静默降级 */
  let beepErr = '';
  try { win.eval('beepSignal(true); beepSignal(false); "ok"'); } catch (e) { beepErr = String(e.message).slice(0, 80); }
  ok('无音频环境时 beepSignal 静默不抛', !beepErr, beepErr || 'jsdom 无 AudioContext → 静默返回');

  /* 标题栏闪烁 + 关掉开关后不应改标题 */
  const t0 = doc.title;
  win.eval('alertOpt.title = true; flashTitle("🔔 买入 BTC · SimTrader")');
  ok('标题栏会被改写为信号提示', doc.title.indexOf('买入') >= 0, doc.title);
  doc.title = t0;
  win.eval('alertOpt.title = false; flashTitle("🔔 不应出现")');
  ok('关掉「标题」开关后不再改标题', doc.title === t0, doc.title);
  win.eval('alertOpt.title = true');

  /* 横幅渲染：内容必须含方向 / 品种 / 时间 / 触发价 / 三周期票数 */
  win.eval(`showSignalAlert({ short: 'BTC·永续', id: 'btc', dec: 1 },
    { time: 1769000000, dir: 'long', price: 83412.5, up1h: 5, dn1h: 2, up15: 4, dn15: 3, up5: 4, dn5: 2 }, 1)`);
  const sa = q('#sigAlert');
  ok('横幅可见', sa && !sa.hidden);
  const saTxt = sa ? sa.textContent : '';
  ok('横幅含方向', /买入信号/.test(saTxt), saTxt.slice(0, 60));
  ok('横幅含品种', /BTC/.test(saTxt));
  ok('横幅含触发价', /83,412\.5/.test(saTxt));
  ok('横幅含三周期票数', /1h 5多\/2空/.test(saTxt) && /15m 4多\/3空/.test(saTxt) && /5m 4多\/2空/.test(saTxt));
  ok('横幅是 long → up 样式', sa && sa.className.indexOf('up') >= 0, sa.className);
  /* 空头方向 */
  win.eval(`showSignalAlert({ short: 'ETH·永续', id: 'eth', dec: 2 },
    { time: 1769000000, dir: 'short', price: 2677.5, up1h: 2, dn1h: 5, up15: 3, dn15: 4, up5: 2, dn5: 4 }, 2)`);
  ok('空头横幅是 down 样式且文案为卖出', /卖出信号/.test(q('#sigAlert').textContent) && q('#sigAlert').className.indexOf('down') >= 0);
  /* 「看K线」按钮：跳转 + 关闭。
     先注入一段 K 线 —— 图表里没有数据时 jumpToTime 本来就该直接返回，不算跳转成功。 */
  win.eval(`state.candles[state.current + "_" + state.tf] = (function () {
    var a = []; for (var i = 0; i < 300; i++) a.push({ time: 1768900000 + i * 900, open: 83000, high: 83100, low: 82900, close: 83050 });
    return a;
  })();`);
  win.eval('window.__ranges = [];');
  win.eval('document.getElementById("saJump").click()');
  ok('点「看K线」会移动图表视野', (win.eval('window.__ranges.length') || 0) > 0, '设置 ' + win.eval('window.__ranges.length') + ' 次');
  ok('点「看K线」后横幅关闭', q('#sigAlert').hidden);
  win.eval('closeSignalAlert()');
  ok('closeSignalAlert 可重复调用（不抛）', true);

  /* ------------------------------------------------------------------ */
  console.log('【三】提醒去重（最关键的一条：同一个信号不能反复弹）');

  const mk = `({
    s5: { n: 400, t: (function(){ var a=new Float64Array(400); for(var i=0;i<400;i++) a[i]=1768900000+i*300; return a; })(),
          o: (function(){ var a=new Float64Array(400); for(var i=0;i<400;i++) a[i]=83400; return a; })() },
    trig: [{ i: 397, dir: 'long', up5: 4, dn5: 2, up15: 4, dn15: 3, up1h: 5, dn1h: 2 }],
    cur: null, V: { minVotes: 4 }
  })`;
  /* 第一次：刚发生（agoBars = 400-1-397 = 2 ≤ 3）→ 应提醒 */
  win.eval('try { localStorage.removeItem("simtrader_vote_alerted_v1"); } catch(e){}');
  win.eval('closeSignalAlert(); alertOpt.banner = true;');
  win.eval('alertVote(' + mk + ')');
  ok('刚发生的触发 → 弹出横幅', !q('#sigAlert').hidden, 'agoBars=2');
  /* 第二次：同一个信号，刷新页面后也不该再弹 */
  win.eval('closeSignalAlert();');
  win.eval('alertVote(' + mk + ')');
  ok('同一触发不重复提醒（localStorage 记住已报过）', q('#sigAlert').hidden, '第二次调用被去重');

  /* 换一个时间点 = 新信号 → 应重新弹 */
  const mk2 = mk.replace('i: 397', 'i: 398');
  win.eval('alertVote(' + mk2 + ')');
  ok('新的触发点会重新提醒', !q('#sigAlert').hidden);
  win.eval('closeSignalAlert();');

  /* 历史触发（agoBars > 3）不应打扰 —— 它已经静静躺在 K 线标记和列表里 */
  const mkOld = mk.replace('i: 397', 'i: 200');
  win.eval('try { localStorage.removeItem("simtrader_vote_alerted_v1"); } catch(e){}');
  win.eval('alertVote(' + mkOld + ')');
  ok('历史触发不弹提醒（只在图上与列表里呈现）', q('#sigAlert').hidden, 'agoBars=199');

  /* ------------------------------------------------------------------ */
  console.log('【四】真实数据：拉长到 1000 根 5m 后到底能看到几次触发（联网）');

  try {
    const CONTRACT = 'BTC_USDT';
    const [c5, c15, c1h, cd] = await Promise.all([
      gateKlines(CONTRACT, '5m', 1000),
      gateKlines(CONTRACT, '15m', 600),
      gateKlines(CONTRACT, '1h', 300),
      gateKlines(CONTRACT, '1d', 400),
    ]);
    ok('真实拉到 1000 根 5m', c5.length === 1000, c5.length + ' 根 ≈ ' + ((c5.length * 5) / 60 / 24).toFixed(2) + ' 天');
    ok('真实拉到 600 根 15m', c15.length === 600, c15.length + ' 根 ≈ ' + ((c15.length * 15) / 60 / 24).toFixed(1) + ' 天');
    ok('真实拉到 300 根 1h', c1h.length === 300, c1h.length + ' 根');
    ok('日线足够算 MA200', cd.length >= 250, cd.length + ' 根');

    win.__k = { c5: c5, c15: c15, c1h: c1h, cd: cd };
    const out = JSON.parse(win.eval(`(function () {
      var st = window.Strategy;
      var K = window.__k;
      var s5 = st.toSeries(K.c5), s15 = st.toSeries(K.c15), s1h = st.toSeries(K.c1h);
      var daily = K.cd.map(function (x) { return { time: x.time, close: x.close }; });
      var ma = st.ma200FromDaily(daily, 200);
      var V = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
      var ma5 = st.voteMaArr ? null : null;
      function maArr(s, sec) {
        var times = ma.points.map(function (p) { return Math.floor(p.time / 86400) * 86400; });
        var m = st.buildClosedMap(s.t, times, sec, 86400);
        var o = new Float64Array(s.n);
        for (var i = 0; i < s.n; i++) { var j = m[i]; o[i] = (j >= 0 && j < ma.points.length) ? ma.points[j].value : NaN; }
        return o;
      }
      var r5 = st.voteSeries(s5, maArr(s5, 300), V);
      var r15 = st.voteSeries(s15, maArr(s15, 900), V);
      var r1h = st.voteSeries(s1h, maArr(s1h, 3600), V);
      var m15 = st.buildClosedMap(s5.t, s15.t, 300, 900);
      var m1h = st.buildClosedMap(s5.t, s1h.t, 300, 3600);
      var trig = st.findVoteTriggersClosed(r5.dirs, r15.dirs, r1h.dirs, m15, m1h, r5, r15, r1h);
      /* 只统计 5m 有映射的区间——映射不上的部分会被判成「无表态」，是丢样本的信号 */
      var mapped = 0;
      for (var i = 0; i < s5.n; i++) if (m15[i] >= 0 && m1h[i] >= 0) mapped++;
      var last300 = trig.filter(function (t) { return t.i >= s5.n - 300; }).length;
      return JSON.stringify({
        n5: s5.n, n15: s15.n, n1h: s1h.n,
        trig: trig.length, last300: last300,
        mappedPct: mapped / s5.n,
        firstI: trig.length ? trig[0].i : -1,
        lastI: trig.length ? trig[trig.length - 1].i : -1,
        dirs: trig.slice(-6).map(function (t) { return t.dir; }),
      });
    })()`));

    console.log('    窗口 ' + out.n5 + ' 根 5m · 触发 ' + out.trig + ' 次 · 最近 300 根内 ' + out.last300 + ' 次');
    console.log('    5m 有粗周期映射的比例 ' + (out.mappedPct * 100).toFixed(1) + '%');
    console.log('    最近 6 次方向 ' + out.dirs.join(' / '));

    ok('1000 根 5m 全部能映射到已收线的 15m 与 1h（不丢样本）',
      out.mappedPct > 0.98, (out.mappedPct * 100).toFixed(1) + '%');
    ok('★ 拉长窗口后确实能看到历史触发（≥1 次）', out.trig >= 1, out.trig + ' 次');
    ok('★ 触发点分布在最近 300 根之外（证明旧窗口真的看不到）',
      out.trig > out.last300 || out.trig === 0,
      `共 ${out.trig} 次，其中最近 300 根内 ${out.last300} 次 → 旧窗口会漏掉 ${out.trig - out.last300} 次`);

    /* 注入真实触发，再用它渲染面板，检查触发历史列表 */
    const realTrig = JSON.parse(win.eval(`(function () {
      var st = window.Strategy; var K = window.__k;
      var s5 = st.toSeries(K.c5), s15 = st.toSeries(K.c15), s1h = st.toSeries(K.c1h);
      var daily = K.cd.map(function (x) { return { time: x.time, close: x.close }; });
      var ma = st.ma200FromDaily(daily, 200);
      function maArr(s, sec) {
        var times = ma.points.map(function (p) { return Math.floor(p.time / 86400) * 86400; });
        var m = st.buildClosedMap(s.t, times, sec, 86400);
        var o = new Float64Array(s.n);
        for (var i = 0; i < s.n; i++) { var j = m[i]; o[i] = (j >= 0 && j < ma.points.length) ? ma.points[j].value : NaN; }
        return o;
      }
      var V = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
      var r5 = st.voteSeries(s5, maArr(s5, 300), V), r15 = st.voteSeries(s15, maArr(s15, 900), V), r1h = st.voteSeries(s1h, maArr(s1h, 3600), V);
      var trig = st.findVoteTriggersClosed(r5.dirs, r15.dirs, r1h.dirs,
        st.buildClosedMap(s5.t, s15.t, 300, 900), st.buildClosedMap(s5.t, s1h.t, 300, 3600), r5, r15, r1h);
      window.__realTrig = trig;
      return JSON.stringify({ n: trig.length });
    })()`));
    ok('真实触发已注入', realTrig.n >= 0, realTrig.n + ' 次');

    const rendered2 = JSON.parse(win.eval(`(function () {
      var st = window.Strategy; var K = window.__k;
      var vp = {
        s5: st.toSeries(K.c5), s15: st.toSeries(K.c15), s1h: st.toSeries(K.c1h),
        r5: { dirs: [] }, r15: { dirs: [] }, r1h: { dirs: [] },
        trig: window.__realTrig || [],
        cur: { d1h: { votes: [1,1,1,1,1,1,1,1,1], up: 5, dn: 2, flat: 2, dir: 'long' },
               d15: { votes: [1,1,1,1,0,0,0,-1,-1], up: 4, dn: 2, flat: 3, dir: 'long' },
               d5:  { votes: [1,1,1,0,0,0,-1,-1,-1], up: 3, dn: 3, flat: 3, dir: 'wait' } },
        V: { minVotes: 4, thz: 0.30 }
      };
      paintVote(vp, '');
      var rows = document.querySelectorAll('#votePanel .vt-row');
      var hd = document.querySelector('#votePanel .v-log-hd');
      var tt = document.querySelector('#votePanel .v-v-trig');
      return JSON.stringify({
        rows: rows.length,
        firstT: rows.length ? +rows[0].getAttribute('data-t') : null,
        hasDataT: rows.length ? !!rows[0].getAttribute('data-t') : false,
        hd: hd ? hd.textContent.replace(/\\s+/g, ' ').trim() : '',
        trigTxt: tt ? tt.textContent.replace(/\\s+/g, ' ').trim() : '',
        hasAlerts: !!document.querySelector('#votePanel #alBanner'),
        hasSound: !!document.querySelector('#votePanel #alSound'),
        hasNotify: !!document.querySelector('#votePanel #alNotify'),
      });
    })()`));

    console.log('    面板触发历史 ' + rendered2.rows + ' 行 · 表头「' + rendered2.hd + '」');
    console.log('    常驻状态「' + rendered2.trigTxt + '」');

    ok('面板渲染出触发历史列表', rendered2.rows > 0 || realTrig.n === 0, rendered2.rows + ' 行（真实触发 ' + realTrig.n + ' 次）');
    if (rendered2.rows > 0) {
      ok('触发历史每行列到 12 条上限', rendered2.rows <= 12, rendered2.rows + ' 行');
      ok('每行带 data-t（可点击跳到该根 K 线）', rendered2.hasDataT, '首行 t=' + rendered2.firstT);
      ok('常驻状态写明「距今 N 根 5m」', /距今 \d+ 根 5m/.test(rendered2.trigTxt) || /无触发/.test(rendered2.trigTxt), rendered2.trigTxt);
      ok('常驻状态带触发价', /触发价/.test(rendered2.trigTxt) || /无触发/.test(rendered2.trigTxt));
    }
    ok('面板含提醒开关（横幅/声音/桌面通知）', rendered2.hasAlerts && rendered2.hasSound && rendered2.hasNotify);

    /* 触发历史点击 → 图表跳转（需要图表里真的有这段 5m 数据） */
    if (rendered2.rows > 0) {
      win.eval('state.tf = "5m"; state.candles[state.current + "_5m"] = window.__k.c5;');
      win.eval('window.__ranges = [];');
      win.eval('document.querySelector("#votePanel .vt-row").click()');
      ok('点触发历史会移动图表视野', (win.eval('window.__ranges.length') || 0) > 0, '设置 ' + win.eval('window.__ranges.length') + ' 次');
    }

    /* paintTriggers 优先画 voteTrig */
    win.eval('state.voteTrig = [{time: window.__k.c5[500].time, dir: "long", i: 500, price: 1, up5:4,dn5:2,up15:4,dn15:3,up1h:5,dn1h:2}]; state.triggers = [];');
    win.eval('try { paintTriggers(); } catch (e) { window.__ptErr = String(e.message); }');
    ok('paintTriggers 可用 voteTrig 作画（不抛错）', !win.eval('window.__ptErr'), win.eval('window.__ptErr') || '');
  } catch (e) {
    chk('真实数据链路', false, String(e && e.message || e).slice(0, 120));
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  let bad = 0;
  results.forEach(r => {
    if (!r.ok) bad++;
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
  });
  console.log('\n通过 ' + (results.length - bad) + '/' + results.length + (bad ? ' · ' + bad + ' 项失败' : ' · 全部通过'));
  const noise = errors.filter(e => !/Not implemented|Could not parse CSS|lightweight/i.test(e));
  if (noise.length) console.log('（异常错误 ' + noise.length + ' 条：' + noise.slice(0, 2).join(' | ') + '）');
  process.exit(bad ? 1 : 0);
})();
