// 清算引力方向的真实数据验证：真实永续 K 线 + 真实多空比 → 热力图 → 四格方向
const BASE = 'C:/Users/windos/WorkBuddy/2026-09-14-20-21-18/outputs/market-board';
const fs = require('fs');
const src = fs.readFileSync(BASE + '/app.js', 'utf8');

const cutA = src.indexOf('/* ============================ K 线绘制');
const hS = src.indexOf('/* ============================ 多空筹码热力图');
const hE = src.indexOf('/* --- 绘制 --- */');
if (cutA < 0 || hS < 0 || hE < 0) throw new Error('切分点未找到');
const code = src.slice(0, cutA) + '\n' + src.slice(hS, hE);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

// 浏览器同源策略在 Node 里不存在，用 curl 与浏览器一致地走系统代理
const { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
async function jget(url, ms = 12000) {
  const out = execFileSync('curl', ['-s', '-m', String(Math.ceil(ms / 1000)), '-A', UA, url],
    { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.toString('utf8'));
}
function raw(url, headers = [], ms = 12000) {
  const args = ['-s', '-m', String(Math.ceil(ms / 1000)), '-A', UA];
  for (const hh of headers) args.push('-H', hh);
  args.push(url);
  return execFileSync('curl', args, { maxBuffer: 8 * 1024 * 1024 }).toString('utf8');
}

global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.window = {};
global.fetch = () => Promise.reject(new Error('no net in node'));
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.localStorage = { getItem: () => null, setItem: () => {} };

const mod = {};
new Function('module', 'exports', '__jget', code +
  '\n;jget=__jget;module.exports={SYMS,TF_MAP,TFS,KLINE,fetchReal,buildHeatFromBars,' +
  'buildHeatFromCG,finishHeat,liqSignal,fetchBinanceLS,fetchCoinglassLiq,binSym,clamp,fmt,TF_SPAN};'
)(mod, {}, jget);
const A = mod.exports;

const TFS = ['15m', '30m', '1h', '4h'];

(async () => {
  console.log('=== 1) CoinGlass 接口探测（未配置 Key 时的真实响应）===');
  try {
    const txt = raw('https://open-api-v3.coinglass.com/api/futures/liquidation/history?symbol=BTCUSDT&interval=1h');
    const j = JSON.parse(txt);
    ok(j && (j.code != null || j.data != null), '接口可达并返回结构体',
       'code=' + (j && j.code) + ' msg=' + (j && j.msg));
    ok(String(j.code) !== '0', '未带 Key 时不返回清算数据（需自备 Key）',
       'code=' + j.code + ' msg=' + j.msg);
  } catch (e) {
    ok(false, 'CoinGlass 接口探测', String(e.message).slice(0, 60));
  }
  try { await A.fetchCoinglassLiq('BTC'); ok(false, '无 Key 时应抛出明确错误'); }
  catch (e) { ok(/Key/.test(String(e.message)), '无 Key 时给出可读错误：' + e.message); }

  for (const id of Object.keys(A.SYMS)) {
    const s = A.SYMS[id];
    console.log(`\n=== [${id}] ${s.label} · ${s.cn} ===`);
    let px = null, fund = null;
    if (A.binSym(s)) {
      try {
        const j = await jget('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + A.binSym(s));
        px = parseFloat(j.markPrice); fund = parseFloat(j.lastFundingRate);
      } catch (e) { /* 后续用 K 线末价兜底 */ }
    }
    const ls = await A.fetchBinanceLS(id).catch(() => null);
    if (ls) ok(isFinite(ls.ls) || isFinite(ls.tk), `多空比可取（ls=${ls.ls} tk=${ls.tk}）`);
    else console.log('  - 该品种无币安多空比（非合约品种，走纯 K 线推算）');

    const dirs = [];
    for (const tf of TFS) {
      let bars;
      try { bars = (await A.fetchReal(id, tf)).bars; }
      catch (e) { ok(false, `${tf} K 线`, String(e.message).slice(0, 50)); continue; }
      const last = bars[bars.length - 1].c;
      const p0 = px || last;
      const heat = A.buildHeatFromBars(bars, p0, ls, 'live', ls ? 'semi' : 'est', A.TF_SPAN[tf]);
      if (!heat) { ok(false, `${tf} 热力图构建`); continue; }
      // 边界堆积检查：位移越界的量若被夹到边界，底部几档会吃掉大部分筹码，制造假的清算墙
      const tot = heat.rows.reduce((a, r) => a + r.long + r.short, 0) || 1;
      const edge = heat.rows.slice(0, 3).concat(heat.rows.slice(-3))
        .reduce((a, r) => a + r.long + r.short, 0) / tot * 100;
      ok(edge < 32, `${tf} 边界无假墙堆积（首尾 3 档占 ${edge.toFixed(1)}%）`, edge.toFixed(1));
      const r = A.liqSignal(bars, heat, { funding: fund, ls: ls ? ls.ls : null, dp: s.dp });

      const nums = [r.score, r.upPct, r.dnPct, r.tp, r.sl, r.trigger ?? 0, r.atrPct, r.posPct];
      const clean = nums.every(Number.isFinite) && !/NaN|undefined/.test(r.reasons.join(''));
      const legal = ['long', 'short', 'wait'].includes(r.dir)
        && (r.dir === 'wait' || (r.dir === 'long' ? r.sl < r.px && r.tp > r.px : r.sl > r.px && r.tp < r.px));
      ok(clean && legal, `${tf} 方向=${r.dir} 分数=${r.score.toFixed(1)} 上${r.upPct.toFixed(1)}%/下${r.dnPct.toFixed(1)}%`,
         JSON.stringify({ clean, legal, sl: r.sl, px: r.px, tp: r.tp }));
      dirs.push(`${tf}:${r.dir}(${r.score.toFixed(0)})`);
      if (tf === '1h') console.log('    依据：' + r.reasons.slice(0, 3).join('；'));
    }
    ok(dirs.length === TFS.length, `四周期全部产出方向 → ${dirs.join(' ')}`);
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
