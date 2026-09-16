// 浏览器端冒烟测试：在 jsdom 中加载真实页面，模拟用户操作，验证渲染与交互链路
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(process.env.NODE_WORKSPACE || '.', 'node_modules', 'jsdom'));

const DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8777/', pretendToBeVisual: true });
const w = dom.window, doc = w.document;
const errors = [];
w.addEventListener('error', e => errors.push(String(e.message || e)));

/* ---- stub：Canvas / 尺寸 / 网络 ---- */
const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = k === 'measureText' ? (s => ({ width: String(s).length * 6 })) : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.Element.prototype.getBoundingClientRect = () => ({ width: 900, height: 320, top: 0, left: 0, right: 900, bottom: 320, x: 0, y: 0 });
Object.defineProperty(w, 'devicePixelRatio', { value: 1, configurable: true });

// 五家永续源 + 现货参考全部成功 —— 覆盖「多平台永续真实报价」分支
const PX = [
  { re: /BTC/i,                      p: 77872.12, spot: 77860.0 },
  { re: /ETH/i,                      p: 2512.88,  spot: 2511.5 },
  { re: /BNB/i,                      p: 722.32,   spot: 721.9 },
  { re: /XAU/i,                      p: 4286.40,  spot: 4285.0 },
  { re: /OILBRENT|BRENT|BZ=F/i,      p: 104.07,   spot: 104.0 },
];
const pxOf = u => { const m = PX.find(x => x.re.test(u)); return m ? m.p : null; };
const spotOf = u => { const m = PX.find(x => x.re.test(u)); return m ? m.spot : null; };
const CG = { bitcoin: { usd: 77860.0 }, ethereum: { usd: 2511.5 }, binancecoin: { usd: 721.9 } };

// 永续 K 线：生成 240 根升序 K 线，覆盖真实 K 线分支
const klinesOf = p => Array.from({ length: 240 }, (_, i) => {
  const base = p * (1 + Math.sin(i / 9) * 0.004 + (i - 120) * 0.00004);
  return [Date.now() - (239 - i) * 900000, base, base * 1.0012, base * 0.9988, base * 1.0004, 100 + i, 0, 0, 0, 0, 0, 0];
});

w.fetch = (url) => {
  const u = String(url);
  const p = pxOf(u), sp = spotOf(u);
  const R = data => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

  if (u.includes('api.coingecko.com')) {
    const ids = decodeURIComponent((u.match(/ids=([^&]+)/) || [])[1] || '');
    const data = {};
    ids.split(',').forEach(i => { if (CG[i]) data[i] = CG[i]; });
    if (!Object.keys(data).length) return Promise.reject(new Error('no id'));
    return R(data);
  }
  if (p == null) return Promise.reject(new Error('no symbol: ' + u.slice(0, 48)));

  if (u.includes('fapi.binance.com') && u.includes('premiumIndex'))
    return R({ symbol: 'X', markPrice: String(p), indexPrice: String(p), lastFundingRate: '0.00004437' });
  if (u.includes('fapi.binance.com') && u.includes('klines')) return R(klinesOf(p));
  if (u.includes('www.okx.com') && u.includes('ticker')) return R({ code: '0', data: [{ last: String(p) }] });
  if (u.includes('www.okx.com') && u.includes('candles')) return R({ code: '0', data: [] });
  if (u.includes('api.bybit.com') && u.includes('tickers'))
    return R({ retCode: 0, result: { list: [{ symbol: 'X', markPrice: String(p * 1.000008), fundingRate: '0.00005' }] } });
  if (u.includes('api.gateio.ws'))
    return R([{ contract: 'X', mark_price: String(p * 0.999992), last: String(p), funding_rate: '0.00006' }]);
  if (u.includes('open-api.bingx.com') && u.includes('klines')) return R({ code: 0, data: [] });
  if (u.includes('open-api.bingx.com')) return R({ code: 0, data: { symbol: 'X', lastPrice: String(p * 1.000004) } });
  if (u.includes('query1.finance.yahoo.com'))
    return R({ chart: { result: [{ meta: { regularMarketPrice: p }, timestamp: [], indicators: { quote: [{}] } }] } });

  return Promise.reject(new Error('blocked: ' + u.slice(0, 48)));
};
w.confirm = () => true;
w.prompt = () => null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = s => ((doc.querySelector(s) || {}).textContent || '').trim();

(async () => {
  console.log('\n[1] 页面加载与初始化');
  try { w.eval(appjs); } catch (e) { ok(false, '脚本执行未抛异常', e.message); }

  for (let i = 0; i < 60 && doc.querySelector('#qPx').textContent === '—'; i++) await sleep(50);
  await sleep(200);

  // 品种切换入口已并入顶部五品种大卡，不再有独立的一排小 tab
  ok(doc.querySelectorAll('#ovGrid .ov-i').length === 5, '渲染 5 个品种卡片',
     'got ' + doc.querySelectorAll('#ovGrid .ov-i').length);
  ok(!doc.querySelector('#symTabs'), '旧品种 tab 已移除（避免两处高亮不同步）');
  ok(doc.querySelectorAll('#sigGrid .sig').length === 4, '渲染 4 个周期信号格',
     'got ' + doc.querySelectorAll('#sigGrid .sig').length);
  ok(doc.querySelectorAll('#tfTabs .tf').length === 4, '渲染 4 个周期切换');
  ok(doc.querySelectorAll('#vBody tr').length >= 2, '平台报价表有数据行',
     'got ' + doc.querySelectorAll('#vBody tr').length);
  ok(/[\d,]/.test(doc.querySelector('#qPx').textContent), '主报价已填充',
     doc.querySelector('#qPx').textContent);
  ok(errors.length === 0, '无未捕获异常', errors.join(' | '));

  console.log('\n[2] 永续报价聚合与 0.1% 价差阈值');
  const qPx = parseFloat(doc.querySelector('#qPx').textContent.replace(/,/g, ''));
  ok(Math.abs(qPx - 77872.12) < 0.01, '主报价取永续标记价', 'got ' + qPx);
  ok(/永续/.test(txt('#qName')), '品种名标注永续口径', txt('#qName'));
  ok(/%$/.test(txt('#qFund').trim()), '资金费率已显示', txt('#qFund'));
  // 五家永续源全部在线 + 现货参考源
  ok(doc.querySelectorAll('#vBody tr').length >= 6, '永续源 + 参考源均渲染',
     'got ' + doc.querySelectorAll('#vBody tr').length);
  ok(/不参与价差/.test(doc.querySelector('#vBody').textContent), '现货参考标注不参与价差');
  ok(/永续/.test(txt('#vNote')), '底部说明交代永续口径');
  const hi = parseFloat(doc.querySelector('#qHi').textContent.replace(/,/g, ''));
  const lo = parseFloat(doc.querySelector('#qLo').textContent.replace(/,/g, ''));
  ok(hi >= lo && hi > 0, '最高价 ≥ 最低价', `hi=${hi} lo=${lo}`);
  const spreadTxt = doc.querySelector('#qSpreadPct').textContent;
  ok(spreadTxt.includes('阈值') || spreadTxt.includes('0.1'), '显示 0.1% 阈值判定', spreadTxt.trim());
  const badge = doc.querySelector('#qSpreadPct .badge');
  ok(!!badge && /触发|0\.1%/.test(badge.textContent), '价差徽标存在', badge && badge.textContent);
  ok(doc.querySelector('#qVenues').textContent.includes('/'), '显示在线平台计数',
     doc.querySelector('#qVenues').textContent);

  console.log('\n[3] 信号格内容完整性');
  const sigs = Array.from(doc.querySelectorAll('#sigGrid .sig'));
  const tfs = sigs.map(s => s.querySelector('.sig-tf').textContent);
  ok(JSON.stringify(tfs) === JSON.stringify(['15分钟', '30分钟', '1小时', '4小时']),
     '四格依次为 15m/30m/1h/4h', tfs.join(','));
  ok(sigs.every(s => /做多|做空|观望/.test(s.querySelector('.sig-dir').textContent)), '每格都有多空方向');
  ok(sigs.every(s => s.querySelectorAll('.sig-r').length === 5), '每格 5 行清算指标');
  ok(sigs.every(s => /上方空单清算/.test(s.textContent) && /下方多单清算/.test(s.textContent)),
     '指标改为上下方清算池口径');
  ok(sigs.every(s => /真实|推算|估算|无清算数据/.test(s.querySelector('.sig-src').textContent)),
     '每格标注清算数据来源',
     sigs.map(s => s.querySelector('.sig-src').textContent).join('|'));
  ok(sigs.every(s => /五因子合成/.test(s.querySelector('.sig-act').textContent)), '提示行给出五因子合成分值');
  ok(sigs.every(s => /一致度/.test(s.querySelector('.sig-act').textContent)), '提示行给出因子一致度');
  ok(sigs.every(s => /破|等待|清算/.test(s.querySelector('.sig-act').textContent)), '提示以清算带为触发位');
  ok(sigs.every(s => s.querySelector('.sig-act').textContent.includes('建议仓位')), '每格给出仓位建议');
  ok(sigs.every(s => !/NaN|undefined/.test(s.textContent)), '信号格无 NaN / undefined');

  console.log('\n[4] 五品种总览');
  ok(doc.querySelectorAll('#ovGrid .ov-i').length === 5, '总览渲染 5 个品种卡片',
     'got ' + doc.querySelectorAll('#ovGrid .ov-i').length);
  for (let i = 0; i < 80; i++) {
    await sleep(50);
    if (!doc.querySelector('#ovGrid').textContent.includes('—')) break;
  }
  const ovTxt = doc.querySelector('#ovGrid').textContent;
  ok(!/NaN|undefined/.test(ovTxt), '总览无 NaN / undefined');
  ['BTC', 'ETH', 'BNB', 'XAU', 'BRENT'].forEach(k =>
    ok(ovTxt.includes(k), `总览包含 ${k}`));
  ok(doc.querySelectorAll('#ovGrid .ov-i')[0].classList.contains('on'), '当前品种在总览中高亮');
  doc.querySelector('#ovGrid [data-sym="ETH"]').click();
  for (let i = 0; i < 60 && !doc.querySelector('[data-sym="ETH"]').classList.contains('on'); i++) await sleep(50);
  ok(doc.querySelector('#ovGrid [data-sym="ETH"]').classList.contains('on'), '点击总览可切换品种');
  ok(doc.querySelector('#qName').textContent.includes('ETH'), '切换后主报价同步',
     doc.querySelector('#qName').textContent);

  console.log('\n[5] 切换品种与周期');
  doc.querySelector('[data-sym="XAUUSD"]').click();
  for (let i = 0; i < 60 && !/4,2|4[0-9]{3}/.test(doc.querySelector('#qPx').textContent); i++) await sleep(50);
  await sleep(300);
  const goldPx = parseFloat(doc.querySelector('#qPx').textContent.replace(/,/g, ''));
  ok(goldPx > 3000 && goldPx < 6000, '伦敦金报价合理', 'got ' + goldPx);
  ok(doc.querySelector('[data-sym="XAUUSD"]').classList.contains('on'), '品种标签高亮切换');

  doc.querySelector('[data-sym="UKOIL"]').click();
  for (let i = 0; i < 60; i++) { await sleep(50); if (parseFloat(doc.querySelector('#qPx').textContent.replace(/,/g, '')) < 500) break; }
  await sleep(300);
  const oilPx = parseFloat(doc.querySelector('#qPx').textContent.replace(/,/g, ''));
  ok(oilPx > 20 && oilPx < 300, '布伦特原油报价合理（走兜底/参考）', 'got ' + oilPx);

  doc.querySelector('[data-tf="4h"]').click();
  await sleep(400);
  ok(doc.querySelector('[data-tf="4h"]').classList.contains('on'), '周期切换到 4h');

  doc.querySelector('[data-sym="BTC"]').click();
  await sleep(500);
  // 图例断言放在有真实 K 线的品种上：原油在桩数据里没有 K 线源，图例本就该显示「等待真实 K 线」
  ok(doc.querySelector('#legend').textContent.includes('4小时'), '图例同步周期',
     doc.querySelector('#legend').textContent);
  ok(/KDJ/.test(doc.querySelector('#legend').textContent), '图例含 KDJ 读数',
     doc.querySelector('#legend').textContent.slice(0, 80));

  console.log("\n[6] 下单面板与盈亏试算");
  doc.querySelector('#fMargin').value = '1000';
  doc.querySelector('#fLev').value = '20';
  doc.querySelector('#fLev').dispatchEvent(new w.Event('input'));
  doc.querySelector('#fMargin').dispatchEvent(new w.Event('input'));
  const estTxt = doc.querySelector('#estBox').textContent;
  ok(estTxt.includes('名义价值'), '试算包含名义价值');
  ok(estTxt.includes('强平价'), '试算包含强平价');
  ok(/20×/.test(estTxt) || estTxt.includes('极高风险'), '高杠杆触发风险提示');
  const nom = parseFloat((estTxt.match(/名义价值\s*([\d,\.]+)/) || [])[1]?.replace(/,/g, ''));
  ok(Math.abs(nom - 20000) < 1, '1000 × 20 = 20000 名义价值', 'got ' + nom);

  console.log("\n[7] 手动下单提示 → 确认 → 入持仓");
  doc.querySelector('#fSL').value = '70000';
  doc.querySelector('#fTP').value = '90000';
  doc.querySelector('#fSL').dispatchEvent(new w.Event('input'));
  doc.querySelector('#btnOrder').click();
  await sleep(100);
  ok(doc.querySelector('#mask').classList.contains('on'), '弹出下单提示（非自动下单）');
  const mTxt = doc.querySelector('#mBody').textContent;
  ok(mTxt.includes('手动下单提示'), '提示卡片声明不自动下单');
  ok(mTxt.includes('不会向任何交易所发送指令'), '提示卡片声明不发送指令');
  ok(mTxt.includes('90,000') || mTxt.includes('90000'), '提示含止盈价');
  ok(mTxt.includes('70,000') || mTxt.includes('70000'), '提示含止损价');

  doc.querySelector('#mOk').click();
  await sleep(200);
  ok(!doc.querySelector('#mask').classList.contains('on'), '确认后关闭弹窗');
  const posRows = doc.querySelectorAll('#posBody tr').length;
  ok(posRows === 1, '持仓表新增 1 行', 'got ' + posRows);
  const posTxt = doc.querySelector('#posBody tr').textContent;
  ok(posTxt.includes('BTC'), '持仓品种正确');
  ok(posTxt.includes('20×'), '持仓杠杆正确');
  ok(!/NaN/.test(posTxt), '持仓无 NaN');
  ok(doc.querySelector('#pnlSum').textContent.includes('浮动盈亏'), '显示浮动盈亏汇总');

  console.log("\n[8] 限价单：待触及 → 手动执行");
  doc.querySelector('#tType [data-v="limit"]').click();
  doc.querySelector('#fLimit').value = (qPx * 0.5).toFixed(2);
  doc.querySelector('#fLimit').dispatchEvent(new w.Event('input'));
  ok(doc.querySelector('#limitWrap').style.display !== 'none', '限价模式显示委托价输入');
  doc.querySelector('#btnOrder').click();
  await sleep(80);
  doc.querySelector('#mOk').click();
  await sleep(200);
  ok(doc.querySelectorAll('#posBody tr').length === 2, '限价单进入列表', 'got ' + doc.querySelectorAll('#posBody tr').length);
  ok(doc.querySelector('#posBody').textContent.includes('待触及'), '限价单标记为待触及（不自动成交）');
  const exec = doc.querySelector('#posBody [data-exec]');
  ok(!exec, '未触及时不出现执行按钮');

  console.log("\n[9] 平仓与清空");
  const closeBtns = doc.querySelectorAll('#posBody [data-close]');
  const n0 = doc.querySelectorAll('#posBody tr').length;
  if (closeBtns.length) closeBtns[0].click();
  await sleep(150);
  ok(doc.querySelectorAll('#posBody tr').length === n0 - 1, '平仓后减少一行',
     `${n0} → ${doc.querySelectorAll('#posBody tr').length}`);
  doc.querySelector('#btnClear').click();
  await sleep(150);
  ok(doc.querySelector('#posBody').textContent.includes('暂无模拟持仓'), '清空后显示空态');

  console.log("\n[10] 分享链接与 .top 域名");
  let clip = null;
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(w.navigator, 'clipboard',
    { value: { writeText: async t => { clip = t; } }, configurable: true });

  const pubTxt = txt('#pubLink');
  ok(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(pubTxt), '已上线地址为 https 链接', pubTxt);
  ok(doc.querySelector('#btnOpenPub').getAttribute('href') === pubTxt, '「打开」按钮指向同一地址');
  ok(doc.querySelector('#btnOpenPub').getAttribute('target') === '_blank', '打开按钮在新标签页');

  doc.querySelector('#btnCopyPub').click();
  await sleep(60);
  ok(clip === pubTxt, '复制已上线地址写入剪贴板', String(clip));
  ok(doc.querySelector('#btnCopyPub').textContent === '已复制', '复制按钮反馈「已复制」');
  await sleep(1300);
  ok(doc.querySelector('#btnCopyPub').textContent === '复制', '按钮文案 1.2s 后复原');

  const inp = doc.querySelector('#domInput');
  ok(/\.top$/.test(inp.value.trim()), '默认域名以 .top 结尾', inp.value);
  ok(txt('#domLink') === 'https://' + inp.value.trim(), '自动生成 https:// 域名链接', txt('#domLink'));
  ok(!doc.querySelector('#domHint').className.includes('warn'), '合法 .top 域名无警告');
  ok(doc.querySelector('#domHint').textContent.includes('CNAME'), '提示包含 CNAME 绑定说明');

  inp.value = 'myboard.com'; inp.dispatchEvent(new w.Event('input'));
  ok(doc.querySelector('#domHint').className.includes('warn'), '非 .top 后缀触发警告');
  inp.value = 'https://MyBoard.Top/path'; inp.dispatchEvent(new w.Event('input'));
  ok(txt('#domLink') === 'https://myboard.top', '粘贴完整 URL 归一化（去协议/路径/小写）', txt('#domLink'));
  ok(!doc.querySelector('#domHint').className.includes('warn'), '归一化后警告解除');

  clip = null;
  doc.querySelector('#btnCopyDom').click();
  await sleep(60);
  ok(clip === 'https://myboard.top', '复制自定义 .top 地址', String(clip));

  const chips = doc.querySelectorAll('#domChips .chip');
  ok(chips.length >= 3, '候选域名不少于 3 个', String(chips.length));
  ok([...chips].every(c => /\.top$/.test(c.textContent)), '候选域名均以 .top 结尾');
  chips[0].click();
  ok(inp.value === chips[0].textContent, '点击候选填入输入框');
  ok(txt('#domLink') === 'https://' + chips[0].textContent, '候选域名同步生成链接');

  clip = null;
  doc.querySelector('#btnShare').click();
  await sleep(60);
  ok(clip === pubTxt, '顶栏「复制链接」复制同一地址', String(clip));

  console.log("\n[11] 配色约定：多/涨=绿，空/跌=红");
  ok(/--up:\s*#12a150/.test(html), 'CSS 变量 --up 为绿色（多/涨）');
  ok(/--down:\s*#e13b3b/.test(html), 'CSS 变量 --down 为红色（空/跌）');
  ok(!/--up:\s*#e13b3b|--down:\s*#12a150/.test(html), '未把涨跌色写反');
  ok(/\.tag\.l\{background:#eefaf3;color:var\(--up\)\}/.test(html), '多头标签为绿底绿字');
  ok(/\.tag\.s\{background:#fff1f1;color:var\(--down\)\}/.test(html), '空头标签为红底红字');
  ok(/\.sig\.long::before\{background:var\(--up\)\}/.test(html), '信号格多头用 --up（绿）');
  ok(/\.sig\.short::before\{background:var\(--down\)\}/.test(html), '信号格空头用 --down（红）');
  ok(/linear-gradient\(90deg,#e13b3b,.*#12a150\)/.test(html), '热力图色带左红（空头）右绿（多头）');
  ok(/\.dot\.live\{background:#22c55e\}/.test(html), '在线状态点为绿色');
  ok(/const CU = '#12a150', CD = '#e13b3b'/.test(appjs), 'K 线涨=绿 跌=红');
  ok(/b\.c >= b\.o \? 'rgba\(18,161,80,\.28\)' : 'rgba\(225,59,59,\.28\)'/.test(appjs), '成交量柱涨绿跌红');
  ok(/v >= 0 \? 'rgba\(18,161,80,\.55\)' : 'rgba\(225,59,59,\.55\)'/.test(appjs), 'MACD 柱正绿负红');

  console.log("\n[12] 建仓前提示 · 近 1 小时多空爆单");
  ok(!!doc.querySelector('#entryCard'), '建仓前提示卡片存在');
  ok(!!doc.querySelector('#entCfg'), '「配置 AiCoin」按钮存在');
  ok(/AiCoin|清算热力图/.test(txt('#entSrc')), '标注爆单数据来源', txt('#entSrc'));
  ok(!!doc.querySelector('.ent-lv'), '风险等级徽章存在', txt('.ent-lv'));
  ok(/建议仓位/.test(txt('#entHd')), '给出建议仓位上限', txt('#entHd').replace(/\s+/g, ' ').slice(0, 60));
  ok(doc.querySelector('#entBar').children.length === 2, '多空爆仓对比条为两段');
  ok(/多单爆仓/.test(txt('#entBl')) && /空单爆仓/.test(txt('#entBl')), '标注多空爆仓占比', txt('#entBl'));
  ok(doc.querySelectorAll('#entStats > div').length === 3, '统计 3 格（多爆/空爆/强度）');
  ok(doc.querySelectorAll('#entItems .ent-i').length >= 2, '至少给出 2 条建仓提示',
    String(doc.querySelectorAll('#entItems .ent-i').length));
  ok(!/NaN|undefined/.test(doc.querySelector('#entryCard').textContent), '卡片无 NaN / undefined');
  ok(/不构成投资建议/.test(txt('#entNote')), '提示带免责声明');

  console.log("\n[13] 右上角刷新间隔（段控）");
  const rf = doc.querySelector('#rfSeg');
  ok(!!rf, '刷新间隔段控存在');
  const opts = Array.from(rf.querySelectorAll('[data-rf]')).map(o => o.dataset.rf).join(',');
  ok(opts === '0,5,10,15,30', '五档：实时 / 5 / 10 / 15 / 30 分钟', opts);
  ok(!!doc.querySelector('#rfNext'), '倒计时显示存在');
  ok(!!doc.querySelector('#btnRefreshIcon'), '顶栏「立即刷新」按钮存在');

  const pickRf = v => { rf.querySelector(`[data-rf="${v}"]`).click(); };
  pickRf('15');
  await sleep(120);
  ok(w.localStorage.getItem('mb_refresh') === '15', '选择后写入本机记忆',
    String(w.localStorage.getItem('mb_refresh')));
  ok(rf.querySelector('[data-rf="15"]').classList.contains('on'), '段控高亮当前档位');
  ok(/^\d+:\d{2}$/.test(txt('#rfNext')), '非实时模式显示 mm:ss 倒计时', txt('#rfNext'));

  pickRf('0');
  await sleep(120);
  ok(txt('#rfNext') === '实时 8s', '实时模式显示实时标识', txt('#rfNext'));

  pickRf('30');
  await sleep(60);
  doc.querySelector('#btnRefreshIcon').click();
  await sleep(600);
  ok(errors.length === 0, '切换间隔与立即刷新均无异常', errors.join(' | '));
  ok(/^\d+:\d{2}$/.test(txt('#rfNext')), '立即刷新后倒计时重置', txt('#rfNext'));

  console.log("\n[14] 版面精简与做市商价格带区间");
  ok(!!doc.querySelector('#qDirCell'), '报价条含「做市商方向」区');
  ok(/^(做多|做空|观望)$/.test(txt('#qDir')), '做市商方向给出明确结论', txt('#qDir'));
  ok(/·/.test(txt('#qDirSub')) && txt('#qDirSub').length > 3, '方向副标注出模式与区间', txt('#qDirSub'));
  ok(/^\d+ \/ \d+$/.test(txt('#qVenues')), '头部显示在线平台计数', txt('#qVenues'));
  ok(/做市商结论/.test(txt('#mmCard .card-t')), '做市商卡片标题突出「结论」', txt('#mmCard .card-t'));

  const mz = doc.querySelector('#mmZones');
  ok(!!mz && !!mz.querySelector('.mmz'), '做市商板块内渲染出价格带区块');
  ok(!/NaN|undefined|Infinity/.test(mz ? mz.textContent : 'NaN'), '价格带区块无 NaN / undefined');
  if (mz.querySelector('.mmz-r.px')) {
    ok(mz.querySelectorAll('.mmz-r').length >= 2, '价格阶梯至少含现价行与一条清算带',
       String(mz.querySelectorAll('.mmz-r').length));
    ok(mz.querySelectorAll('.mmz-ax i').length >= 2, '价格轴上渲染出色条');
    ok(mz.querySelectorAll('.mmz-op > div').length >= 3, '至少给出 3 个操作带（先扫/目标/失效/挂单）',
       String(mz.querySelectorAll('.mmz-op > div').length));
    ok(/ATR/.test(mz.textContent), '标注带宽折合多少个 ATR');
    ok(mz.querySelectorAll('.mmz-ax i.px').length === 1, '价格轴上恰好一条现价标线');
  } else {
    ok(/无清算热力图|无可用价格带/.test(mz.textContent), '无清算数据时给出降级说明',
       mz.textContent.trim().slice(0, 40));
  }
  // 次要区块折叠化：热力图 / 建仓前提示 / 模拟持仓 / 风险提示 / 访问地址
  ok(doc.querySelectorAll('details.fold').length >= 4, '次要区块已折叠化',
     String(doc.querySelectorAll('details.fold').length));
  ['#entryCard', '#heatCard', '#posCard'].forEach(id => {
    const e = doc.querySelector(id);
    ok(e && e.tagName === 'DETAILS', id + ' 已改为可折叠块', e && e.tagName);
  });
  ok(!!doc.querySelector('#heatCard[open]'), '热力图默认展开（可手动收起）');

  console.log("\n[15] KDJ 与五方面总体分析");
  const facs = doc.querySelectorAll('#mmFac5 .fac');
  ok(facs.length === 5, '做市商卡片渲染 5 个因子卡', 'got ' + facs.length);
  const facNames = Array.from(facs).map(f => f.querySelector('.n span').textContent);
  ok(JSON.stringify(facNames) === JSON.stringify(['结构', 'MACD', 'OBV', 'BOLL', 'KDJ']),
     '五因子依次为 结构/MACD/OBV/BOLL/KDJ', facNames.join(','));
  ok(Array.from(facs).every(f => /^[+-]?\d+$/.test(f.querySelector('.v').textContent.trim())),
     '每个因子给出整数分值', Array.from(facs).map(f => f.querySelector('.v').textContent).join('|'));
  ok(Array.from(facs).every(f => f.querySelector('.d').textContent.trim().length > 1),
     '每个因子给出一句话读数');
  ok(Array.from(facs).every(f => /权重 \d+/.test(f.querySelector('.n u').textContent)),
     '每个因子标出权重');
  ok(!/NaN|undefined/.test(doc.querySelector('#mmFac5').textContent), '五因子卡无 NaN / undefined');

  // KDJ 必须同时出现在三处：信号格因子条、五因子卡、图例
  const fzCells = Array.from(doc.querySelectorAll('#sigGrid .sig-fz div')).map(d => d.textContent);
  ok(fzCells.some(t => /KDJ/.test(t)), '信号格因子条包含 KDJ', fzCells.slice(0, 6).join('|'));
  ok(doc.querySelectorAll('#sigGrid .sig')[0].querySelectorAll('.sig-fz div').length >= 5,
     '单格至少 5 个技术因子',
     String(doc.querySelectorAll('#sigGrid .sig')[0].querySelectorAll('.sig-fz div').length));
  ok(/K[\d.]+/.test(doc.querySelector('#legend').textContent), '图例给出 K 值读数');

  console.log("\n[16] 交易计划：入场 / 止损 / 止盈两档");
  const vd = doc.querySelector('#mmVerdict');
  ok(!!vd, '结论区已渲染');
  ok(/^(做多|做空|观望)$/.test(txt('#mmVerdict .vd-badge')), '结论区给出方向徽章', txt('#mmVerdict .vd-badge'));
  ok(txt('#mmVerdict .vd-t').length > 12, '结论区给出做市商角度的一句话结论');
  ok(/一致度/.test(vd.textContent) && /现价/.test(vd.textContent), '结论区附一致度与现价');
  const lvs = doc.querySelectorAll('#mmLevels .lv');
  ok(lvs.length === 4, '四格价位：入场 / 止损 / 止盈① / 止盈②', 'got ' + lvs.length);
  const lvKeys = Array.from(lvs).map(l => l.className.replace(/.*k-(\w+).*/, '$1'));
  ok(JSON.stringify(lvKeys) === JSON.stringify(['entry', 'sl', 'tp1', 'tp2']),
     '四格顺序为入场→止损→止盈①→止盈②', lvKeys.join(','));
  ok(Array.from(lvs).every(l => /[\d,]+\.\d+/.test(l.querySelector('.v').textContent)),
     '每格给出具体价位数字',
     Array.from(lvs).map(l => l.querySelector('.v').textContent).join(' '));
  ok(Array.from(lvs).every(l => /[+-]\d+\.\d\d%/.test(l.querySelector('.s').textContent)),
     '每格标出相对现价的百分比');
  ok(!/NaN|undefined|Infinity/.test(doc.querySelector('#mmLevels').textContent), '四格价位无 NaN');
  // 单调性：做多 sl < 入场下沿 < 止盈① < 止盈②；做空全部反向
  const numOf = el => parseFloat(el.querySelector('.v').textContent.replace(/,/g, ''));
  const eLo = parseFloat(doc.querySelector('#mmLevels .k-entry .v').textContent.split('–')[0].replace(/,/g, ''));
  const eHi = parseFloat(doc.querySelector('#mmLevels .k-entry .v').textContent.split('–')[1].replace(/,/g, ''));
  const vSl = numOf(lvs[1]), vT1 = numOf(lvs[2]), vT2 = numOf(lvs[3]);
  const biasTxt = txt('#mmVerdict .vd-badge');
  if (biasTxt === '做多') {
    ok(vSl < eLo && eHi < vT1 && vT1 < vT2, '做多：止损 < 入场 < 止盈① < 止盈②',
       `${vSl} / ${eLo}-${eHi} / ${vT1} / ${vT2}`);
  } else if (biasTxt === '做空') {
    ok(vSl > eHi && eLo > vT1 && vT1 > vT2, '做空：止损 > 入场 > 止盈① > 止盈②',
       `${vSl} / ${eLo}-${eHi} / ${vT1} / ${vT2}`);
  } else {
    ok(isFinite(vSl) && isFinite(vT1), '观望：仍给出 ATR 边界参考价');
  }
  ok(/:\s*1$/.test(txt('#mmRr .rr-v')), '给出盈亏比 x : 1', txt('#mmRr .rr-v'));
  ok(/建议保证金/.test(doc.querySelector('#mmRr').textContent), '给出建议保证金占比');

  console.log("\n[17] 热力图：点阵 + 区间数字标注");
  ok(!!doc.querySelector('#heatZones'), '存在区间数字清单容器');
  const hz = doc.querySelectorAll('#heatZones .hz');
  if (hz.length) {
    ok(Array.from(hz).every(x => /[\d,]+\.\d+ – [\d,]+\.\d+/.test(x.querySelector('.rg').textContent)),
       '每条区间给出上下沿数字');
    ok(Array.from(hz).every(x => /强度 \d+%/.test(x.querySelector('.mt').textContent)),
       '每条区间标出强度百分比');
    ok(Array.from(hz).every(x => /ATR/.test(x.textContent)), '每条区间标出宽度（ATR）');
  } else {
    ok(/无清算|未生效|估算/.test(doc.querySelector('#heatNote').textContent),
       '无清算数据时给出说明而非空列表');
  }
  ok(!/NaN|undefined/.test(doc.querySelector('#heatZones').textContent), '区间清单无 NaN');

  console.log("\n[18] 右上角刷新控件");
  ok(!!doc.querySelector('#btnRefreshIcon'), '存在立即刷新按钮');
  ok(/刷新/.test(txt('#btnRefreshIcon')), '刷新按钮带文字（不只是图标）', txt('#btnRefreshIcon'));
  ok(!!doc.querySelector('#rfPause'), '存在暂停 / 恢复按钮');
  ok(!!doc.querySelector('#lastUpd'), '存在数据新鲜度显示');
  ok(/#|秒前|分前|尚未/.test(txt('#lastUpd')), '新鲜度给出可读时间', txt('#lastUpd'));

  console.log("\n[19] 自动交易（模拟盘）");
  ok(!!doc.querySelector('#autoCard'), '存在自动交易卡片');
  ok(!!doc.querySelector('#autoToggle'), '存在启动 / 停止开关');
  ok(/启动|停止/.test(txt('#autoToggle')), '开关文案为启动或停止', txt('#autoToggle'));
  ok(doc.querySelectorAll('#autoStats .st').length === 6, '统计 6 格：单据/持仓/止盈止损/胜率/净盈亏/今日');
  ok(!!doc.querySelector('#autoToday') && !!doc.querySelector('#autoDays'), '存在今日单据与按天历史');
  ok(!!doc.querySelector('#autoExport'), '存在 CSV 导出（只导出、不删除单据）');
  ok(['#autoIv', '#autoMg', '#autoLv', '#autoRr', '#autoTf'].every(s => !!doc.querySelector(s)),
     '参数面板含间隔 / 保证金 / 杠杆 / 盈亏比 / 周期');
  ok(doc.querySelector('#autoIv').value === '30', '默认间隔 30 分钟', doc.querySelector('#autoIv').value);
  ok(doc.querySelector('#autoMg').value === '1000', '默认保证金 1000', doc.querySelector('#autoMg').value);
  ok(doc.querySelector('#autoLv').value === '10', '默认杠杆 10 倍', doc.querySelector('#autoLv').value);
  ok(doc.querySelector('#autoRr').value === '1.5', '默认盈亏比 1.5', doc.querySelector('#autoRr').value);
  ok(/模拟盘/.test(doc.querySelector('#autoCard').textContent), '卡片标注为模拟盘');
  ok(!/NaN|undefined/.test(doc.querySelector('#autoCard').textContent), '自动交易区无 NaN / undefined');

  console.log("\n[20] 全局无渲染污染");
  const body = doc.body.textContent;
  ok(!/NaN/.test(body), '页面无 NaN');
  ok(!/undefined/.test(body), '页面无 undefined');
  ok(errors.length === 0, '全流程无未捕获异常', errors.join(' | '));

  w.close();
  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
