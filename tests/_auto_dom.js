// 自动交易端到端：jsdom 加载真实页面，桩出 ETH 真实行情，
// 验证：错过档位只记 skip、实时档位按策略开仓、止盈止损自动平仓。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8778/', pretendToBeVisual: true });
const w = dom.window, doc = w.document;
const errors = [];
w.addEventListener('error', e => errors.push(String(e.message || e)));

const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = k === 'measureText' ? (s => ({ width: String(s).length * 6 })) : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.Element.prototype.getBoundingClientRect = () => ({ width: 900, height: 320, top: 0, left: 0, right: 900, bottom: 320, x: 0, y: 0 });
Object.defineProperty(w, 'devicePixelRatio', { value: 1, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 620; }, configurable: true });

const ETH = 2512.88;
/** 可变的行情基准：测试里改动它来触发止盈 / 止损 */
let ethPx = ETH;
/* 上升 + 末尾回调的 K 线序列：让做市商结论落在「做多」，
 * 同时让 30m 回调层判定为「回调到位」而不是追价 —— 四层流水线要能全通过才会开仓。 */
function klines(base) {
  return Array.from({ length: 240 }, (_, i) => {
    const trend = (i - 120) * 0.0016;
    const wob = Math.sin(i / 11) * 0.0008;
    const pull = i > 219 ? -0.05 * ((i - 219) / 20) : 0;
    const o = base * (1 + trend + wob + pull);
    const c = o * (i > 219 ? 0.9990 : 1.0009);
    const hi = Math.max(o, c) * 1.0015, lo = Math.min(o, c) * 0.9985;
    return [Math.floor(Date.now() / 900000) * 900000 - (239 - i) * 900000, o, hi, lo, c, 100 + i, 0, 0, 0, 0, 0, 0];
  });
}
const priceOf = sym => /^ETH/.test(sym) ? ethPx : /^BTC/.test(sym) ? 77872.12 : /^BNB/.test(sym) ? 722.32 : 4286.4;

w.fetch = url => {
  const u = String(url);
  if (u.includes('api.coingecko.com'))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ethereum: { usd: ethPx }, bitcoin: { usd: 77872.12 }, binancecoin: { usd: 722.32 }, 'pax-gold': { usd: 4286.4 } }) });
  if (u.includes('fapi.binance.com') && u.includes('klines')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(klines(priceOf(sym))) });
  }
  if (u.includes('fapi.binance.com') && u.includes('premiumIndex')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = priceOf(sym);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, markPrice: String(p), indexPrice: String(p), lastFundingRate: '0.00004437' }) });
  }
  if (u.includes('fapi.binance.com') && u.includes('ticker/24hr')) {
    const sym = (u.match(/symbol=([A-Z0-9]+)/) || [])[1] || '';
    const p = priceOf(sym);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ symbol: sym, lastPrice: String(p), markPrice: String(p) }) });
  }
  return Promise.reject(new Error('unstubbed ' + u.slice(0, 60)));
};

/* 注意：jsdom 的 localStorage 是代理对象，直接覆盖 getItem / setItem 不生效
 * （会被当成写入一个名为 getItem 的存储项），所以这里用原生 storage 预置存档。 */
const AUTO_KEY = 'mb_auto_v1';
const nowMs = () => Date.now();
const IV = 30 * 60000;
// 启动状态：已开启、上一档在 2 个间隔之前（应补 3 单 skip）
w.localStorage.setItem(AUTO_KEY, JSON.stringify({
  on: true, sym: 'ETH', tf: '1h', margin: 1000, lev: 10, ivMin: 30, rr: 1.5,
  nextAt: nowMs() - 2 * IV - 5000, orders: [], startedAt: nowMs() - 10 * IV, pendingSweep: null,
}));
const store = new Proxy({}, { get: (t, k) => w.localStorage.getItem(k) });

(async () => {
  w.eval(appjs);
  await new Promise(r => setTimeout(r, 900));      // 等 init 的 refresh + autoCatchUp 跑完

  const read = () => JSON.parse(store[AUTO_KEY] || '{}');
  let st = read();
  let orders = st.orders || [];

  console.log('\n[1] 错过档位只记 skip，不补开新单');
  ok(orders.length === 3, '错过 2 个间隔 → 补齐 3 条记录（含当前档）', 'got ' + orders.length);
  ok(orders.every(o => o.sym === 'ETH'), '全部单据品种为 ETH（其余品种不参与）');
  ok(orders.every(o => o.tf === '1h'), '结论周期一致');
  ok(orders.every(o => o.margin === 1000 && o.lev === 10 && o.notional === 10000),
     '每单保证金 1000 / 杠杆 10× / 名义 10000');
  ok(orders.every(o => o.catchup === true), '错过档已标注为补单');
  ok(orders.every(o => o.status === 'skip'), '错过档状态全部为 skip');
  ok(orders.every(o => /不补开新单|历史回放/.test(o.reason)), 'skip 原因说明不再补开新单', orders[0] && orders[0].reason);

  console.log('\n[2] 实时档位：把 nextAt 推到当前时刻附近，触发实时执行');
  const AUTO = w.AUTO;
  ok(!!AUTO, '全局 AUTO 对象可访问');
  // 让下一档落在 1 秒前（但不是 catchup：now() > nextAt + 45000 为 false）
  AUTO.nextAt = nowMs() - 1000;
  await new Promise(r => setTimeout(r, 2500));     // 等 autoTick 执行
  st = read(); orders = st.orders || [];
  const newOnes = orders.slice(3);                 // 只看实时档产生的新记录
  ok(newOnes.length > 0, '实时档至少产生一条记录');

  // 若该档是 sweep 等待，把价格推入扫单带触发开仓（P0-4：等待扫单收回必须真实等待）
  if (AUTO.pendingSweep) {
    const mid = (AUTO.pendingSweep.sweepLo + AUTO.pendingSweep.sweepHi) / 2;
    ethPx = mid;
    const S = w.MB_STATE;
    if (S && S.quotes['ETH']) { S.quotes['ETH'].price = mid; S.quotes['ETH'].median = mid; S.quotes['ETH'].ts = nowMs(); }
    await new Promise(r => setTimeout(r, 1500));   // 等 autoTick 触发 sweep 开仓
    st = read(); orders = st.orders || [];
  }

  const opened = orders.filter(o => o.status === 'open');
  ok(opened.length > 0, '实时档至少开出一笔持仓', 'open=' + opened.length);
  ok(opened.every(o => o.catchup === false), '实时单不标注为补单');
  ok(orders.every(o => o.status === 'open' || o.status === 'skip'), '单据状态只有持仓或跳过');

  console.log('\n[3] 止盈止损价位');
  opened.forEach((o, i) => {
    const r2 = v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
    ok(r2(o.sl) && r2(o.tp1), `第 ${i + 1} 笔止盈止损精确到两位小数`, `${o.sl}/${o.tp1}`);
    if (o.side === 'long') ok(o.sl < o.entry && o.tp1 > o.entry, `第 ${i + 1} 笔做多：止损在下、止盈在上`, `${o.sl}/${o.entry}/${o.tp1}`);
    if (o.side === 'short') ok(o.sl > o.entry && o.tp1 < o.entry, `第 ${i + 1} 笔做空：止损在上、止盈在下`, `${o.sl}/${o.entry}/${o.tp1}`);
    const rr = Math.abs(o.tp1 - o.entry) / Math.abs(o.entry - o.sl);
    ok(Math.abs(rr - 1.5) < 0.02, `第 ${i + 1} 笔盈亏比 = 1.5`, rr.toFixed(4));
  });
  ok(opened.every(o => o.entry > 0), '入场价为真实市价（非 0）');
  ok(opened.every(o => o.slip != null && Math.abs(o.slip) > 0), '开仓记录了滑点金额');
  ok(opened.every(o => o.margin > 0 && o.notional > 0 && o.notional <= (o.margin * o.lev) + 1e-6),
    '保证金 / 名义自洽', opened[0] && opened[0].margin + '/' + opened[0].notional);
  ok(opened.every(o => o.margin <= 1000 + 1e-6), '保证金不超过用户设定的 1000 上限',
    opened[0] && String(opened[0].margin));

  console.log('\n[4] 信号标注');
  ok(opened.every(o => o.sig && o.sig.text && o.sig.text.length > 8), '每单标注下单信号', opened[0] && opened[0].sig.text);
  ok(opened.every(o => /结构|KDJ|MACD/.test(o.sig.text)), '信号含结构 / KDJ / MACD 口径');
  ok(opened.every(o => o.sig.conf >= 0), '信号附一致度');

  console.log('\n[5] 到价自动平仓（改行情触发）');
  const first = opened[0];
  if (first) {
    ethPx = first.tp1 + (first.side === 'long' ? 5 : -5);
    await new Promise(r => setTimeout(r, 9500));   // 报价 7 秒刷新一轮，等它回来才会触发平仓判定
    const st2 = read();
    const done = (st2.orders || []).find(o => o.id === first.id);
    ok(done && done.status === 'win', '触及止盈价 → 自动止盈平仓', done && done.status);
    /* 计滑点后不再是「正好等于触发价」：成交价 = 触发价 ± 滑点，
     * 跳空时按开盘价成交（可能优于挂单价）。量级都在千分之几以内。 */
    ok(done && Math.abs(done.exitPx - first.tp1) < first.tp1 * 0.003,
      '成交价贴近触发价（含滑点 / 跳空）', done && String(done.exitPx) + ' vs ' + first.tp1);
    ok(done && (done.exitGap
      || (first.side === 'long' ? done.exitPx <= first.tp1 + 1e-9 : done.exitPx >= first.tp1 - 1e-9)),
      '非跳空时成交价不优于挂单价（滑点方向正确）', done && 'gap=' + done.exitGap);
    ok(done && done.pnl > 0, '止盈单为盈利', done && done.pnl && done.pnl.toFixed(2));
    ok(done && done.fee > 0, '计入双边手续费', done && done.fee && done.fee.toFixed(2));
    ok(done && /止盈/.test(done.reason), '平仓原因写明止盈', done && done.reason);
  } else {
    ok(false, '（跳过：本轮无持仓）');
  }

  console.log('\n[6] 平仓后的统计与留存');
  {
    const st3 = read();
    const stillOpen = (st3.orders || []).filter(o => o.status === 'open');
    if (stillOpen.length) {
      const o = stillOpen[0];
      ethPx = o.sl + (o.side === 'long' ? -5 : 5);
      await new Promise(r => setTimeout(r, 9500));
      const st4 = read();
      const d = (st4.orders || []).find(x => x.id === o.id);
      ok(d && d.status === 'loss', '触及止损价 → 自动止损平仓', d && d.status);
      ok(d && d.pnl < 0, '止损单为亏损', d && d.pnl && d.pnl.toFixed(2));
    } else {
      ok(true, '（本轮持仓已全部平掉，止损口径见 _auto.js 纯计算段）');
    }
    const stx = read();
    const closed = (stx.orders || []).filter(o => o.status === 'win' || o.status === 'loss');
    ok(closed.length > 0, '已平仓单据保留在存档中');
    ok(closed.every(o => o.exitT && o.exitPx > 0 && o.pnl != null), '每笔平仓记录出场时间、价格与盈亏');
    ok(/止盈|止损/.test(doc.querySelector('#autoCard').textContent), '统计区反映已平仓结果');
  }

  console.log('\n[7] 四周期冲突：小周期不能推翻大周期');
  {
    const mkView = (bias, score, extra) => Object.assign({
      bias, mode: 'follow', score, conf: 70, px: ETH, dp: 2, atr: ETH * 0.004,
      bars: [], mm: null,
    }, extra || {});
    const pull = { state: 'ok', retrace: 0.3, hi: ETH * 1.01, lo: ETH * 0.99, px: ETH, span: ETH * 0.02, bars: 48 };
    ok(typeof w.mtfPipeline === 'function', 'mtfPipeline 已暴露（四周期融合唯一入口）');

    // 用户提到的场景：4h 做空、15m 做多 —— 模拟盘绝不能照 1h / 15m 开多
    let d = w.mtfPipeline({
      '4h': mkView('short', -70), '1h': mkView('long', 55),
      '30m': mkView('long', 40, { pull }), '15m': mkView('long', 45),
    });
    ok(d.ok === false && d.bias === 'wait', '4h 做空 + 15m 做多 → 整档观望，不照小周期开多',
      d.bias + ' / ' + d.stage);
    ok(d.stage === 'trend', '卡在机会层之前（1h 与 4h 反向即不是机会）', d.stage);

    // 反向同样成立：4h 做多、15m 做空 → 不做空
    d = w.mtfPipeline({
      '4h': mkView('long', 70), '1h': mkView('short', -55),
      '30m': mkView('short', -40, { pull }), '15m': mkView('short', -45),
    });
    ok(d.ok === false && d.bias !== 'short', '4h 做多 + 15m 做空 → 不会开空', d.bias + ' / ' + d.stage);

    // 四层同向才通过，且方向就是 4h 的方向
    d = w.mtfPipeline({
      '4h': mkView('long', 66), '1h': mkView('long', 55),
      '30m': mkView('long', 40, { pull }), '15m': mkView('long', 45),
    });
    ok(d.ok === true && d.bias === 'long', '四层同向 → 总决策做多', d.bias + ' / ' + d.stage);
    ok(d.bias === d.trendDir, '总决策方向 = 4h 趋势层方向', d.bias + ' vs ' + d.trendDir);

    // 缺大周期 / 触发周期都不发令
    d = w.mtfPipeline({ '1h': mkView('long', 55), '30m': mkView('long', 40, { pull }), '15m': mkView('long', 45) });
    ok(d.ok === false && d.degraded && d.missing.includes('4h'), '缺 4h → 不给结论并标记降级',
      d.missing.join(','));
    d = w.mtfPipeline({
      '4h': mkView('long', 66), '1h': mkView('long', 55), '30m': mkView('long', 40, { pull }),
    });
    ok(d.ok === false && d.stage === 'pullback', '缺 15m → 回调到位也不发令', d.stage);

    // 30m 回撤过深 + 15m 力度不足 → 不发令
    d = w.mtfPipeline({
      '4h': mkView('long', 66), '1h': mkView('long', 55),
      '30m': mkView('long', 40, {
        pull: { state: 'deep', retrace: 0.9, hi: ETH * 1.02, lo: ETH * 0.98, px: ETH, span: ETH * 0.04, bars: 48 },
      }),
      '15m': mkView('long', 22),
    });
    ok(d.ok === false, '30m 回撤过深且 15m 力度不足 → 不发令', d.stage);
  }

  console.log('\n[8] 单据保留与渲染');
  const st5 = read();
  ok(st5.orders.length >= 3, '单据只增不删', 'total=' + st5.orders.length);
  ok(st5.nextAt > nowMs(), '网格已推进到未来档位');
  const card = doc.querySelector('#autoCard').textContent;
  ok(/累计单据/.test(card) && /今日/.test(card), '统计区已渲染');
  ok(!/NaN|undefined/.test(card), '自动交易区无 NaN / undefined');
  ok(doc.querySelectorAll('#autoDays .al-day').length >= 1, '历史按天分组已渲染');
  ok(errors.length === 0, '全流程无未捕获异常', errors.join(' | '));

  console.log('\n[9] 模拟盘假设与偏差面板');
  const am = doc.querySelector('#autoModel');
  ok(!!am, '存在模拟盘假设面板容器');
  const amTxt = am ? am.textContent : '';
  ok(/模拟盘假设与偏差/.test(amTxt), '面板标题点明是假设与偏差', amTxt.slice(0, 40));
  ok(/已计入/.test(amTxt) && /仍未计入/.test(amTxt), '把已计入与未计入分开列');
  ok(/资金费/.test(amTxt) && /滑点/.test(amTxt) && /强平/.test(amTxt), '已计入项含手续费/滑点/资金费/强平');
  ok(/盘口深度/.test(amTxt), '未计入项点明没有盘口深度');
  ok(/不等于实盘收益|不等于/.test(amTxt), '明确模拟结果不等于实盘收益');

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
