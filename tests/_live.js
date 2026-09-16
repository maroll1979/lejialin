// 真实网络验证：按 app.js 中 VENUES/KLINE 的解析逻辑，对真实接口取数并校验字段
const BASE = 'C:/Users/windos/WorkBuddy/2026-09-14-20-21-18/outputs/market-board';
const fs = require('fs');
const src = fs.readFileSync(BASE + '/app.js', 'utf8');

// 抽取 app.js 中从「品种定义」到「平台适配器结束」的代码，确保测的是真实实现
const a = src.indexOf('const SYMS = {');
const b = src.indexOf('/* ============================ 状态');
const code = src.slice(a, b).replace(/const VENUE_BY_ID[\s\S]*$/, '');
// 覆盖抽取代码内的 jget，让适配器走 curl（否则 VENUES 用的是代码段里基于 fetch 的版本）
const mod = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
new Function('module', 'exports', '__jget',
  code + '\n;jget=__jget;module.exports={SYMS,VENUES,TF_MAP};')(mod, {}, jget);
const { SYMS, VENUES, TF_MAP } = mod.exports;
const TF_MAP_KEYS = Object.keys(TF_MAP);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

// 用 curl 取数：与浏览器一致地走系统代理，避免 Node fetch 不走代理造成误判
const { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
async function jget(url, ms = 12000) {
  const sec = Math.ceil(ms / 1000);
  const out = execFileSync('curl', ['-s', '-m', String(sec), '-A', UA, url], { maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out.toString('utf8')); }
  catch (e) { throw new Error('JSON 解析失败'); }
}

(async () => {
  for (const id of Object.keys(SYMS)) {
    const s = SYMS[id];
    console.log(`\n[${id}] ${s.label} · ${s.cn}`);
    const got = [];
    for (const v of VENUES) {
      let r;
      try { r = await v.get(s); }
      catch (e) { console.log(`    - ${v.name.padEnd(10)} 失败: ${String(e.message).slice(0, 40)}`); continue; }
      const okPx = isFinite(r.price) && r.price > 0;
      got.push({ name: v.name, price: r.price, perp: !!v.perp, funding: r.funding });
      console.log(`    ✓ ${v.name.padEnd(10)} ${String(r.price).padEnd(12)} perp=${v.perp ? 'Y' : 'n'} funding=${r.funding == null ? '—' : (r.funding * 100).toFixed(4) + '%'}`);
      ok(okPx, `${id}/${v.name} 价格有效`);
    }
    const perps = got.filter(g => g.perp);
    ok(perps.length >= 1, `${id} 至少有 1 个永续源`, 'got ' + perps.length);
    if (perps.length >= 2) {
      const vals = perps.map(g => g.price);
      const hi = Math.max(...vals), lo = Math.min(...vals);
      const sp = (hi - lo) / lo * 100;
      // 同品种跨平台永续价差应极小，超过 2% 说明取错了标的
      ok(sp < 2, `${id} 跨平台价差合理 (<2%)`, sp.toFixed(3) + '%');
      console.log(`    → 极差 ${(hi - lo).toFixed(4)} (${sp.toFixed(4)}%)`);
    }
  }

  // ---- 永续 K 线真实链路 ----
  const k1 = src.indexOf('/* ---- 各平台「永续合约」K 线适配器');
  const k2 = src.indexOf('function mkBars');
  const kcode = src.slice(k1, k2);
  const kmod = {};
  new Function('module', 'exports', '__jget', 'SYMS', 'TF_MAP', 'jget',
    'let jget2 = jget;\n' + kcode + '\nmodule.exports={KLINE,fetchReal};')
    .call(null, kmod, {}, jget, SYMS, TF_MAP, jget);
  const { fetchReal } = kmod.exports;

  console.log('\n[永续 K 线] 真实链路');
  for (const id of Object.keys(SYMS)) {
    for (const tf of TF_MAP_KEYS) {
      try {
        const d = await fetchReal(id, tf);
        const b = d.bars;
        const asc = b.every((x, i) => i === 0 || x.t > b[i - 1].t);
        const clean = b.every(x => isFinite(x.o) && isFinite(x.h) && isFinite(x.l) && isFinite(x.c));
        ok(b.length >= 30 && asc && clean, `${id}/${tf} ${d.src} ${b.length} 根` +
           (asc ? '' : ' [时间序异常]') + (clean ? '' : ' [含 NaN]'));
      } catch (e) {
        ok(false, `${id}/${tf} K 线获取`, String(e.message).slice(0, 60));
      }
    }
  }

  console.log('\n==============================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==============================================');
})();
