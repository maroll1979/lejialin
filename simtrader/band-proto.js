/* ============================================================================
 * band-proto.js — 「挂单能量分布带」算法原型 v2（离线验证，真实盘口）
 *
 * 目标：把订单簿读成一张流动性地图。四个结构：
 *   1) POC    最密集价位（单位价位内挂单金额最大处）
 *   2) VA     价值区：包含 X% 总挂单金额的**最窄**价格区间 → 中间聚集的量能带
 *   3) UPPER  上方流动性空洞（只在 **卖盘侧** 找）→ 往上突破时最快的路径
 *   4) LOWER  下方流动性空洞（只在 **买盘侧** 找）→ 往下砸时最快的路径
 *
 * v1 的三个错误（真实数据打出来的）：
 *   · 空洞曾用 bid+ask 合成数组来找 → 但两侧在价格上互斥（买一以下才有买单、
 *     卖一以上才有卖单），合成后「上方空洞」实际在比废话更小的集合里选 ➜ 必须按侧算
 *   · 「全局最小窗口」必然落在 VA 内部（因为 VA 占了 80% 视野）➜ 语义错误
 *   · 没有诚实的「这段到底稀不稀」判断 ➜ 补 sparsity = 窗口均值 / 同侧基线均值
 *
 * 用法：node band-proto.js [CONTRACT] [needTicks] [vaShare] [winPct]
 * ========================================================================== */
'use strict';
const https = require('https');
const GATE = 'api.gateio.ws';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: GATE, path, timeout: 15000, headers: { accept: 'application/json' } }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}
const fmt = v => Number(v.toFixed(10)).toString();
function usd(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}
function cands(tick) {
  const out = [0];
  for (let k = -8; k <= 6; k++) for (const m of [1, 5]) {
    const v = m * Math.pow(10, k);
    if (v >= tick * 0.999) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/* ---------------------------------------------------------------- 算法 */
function buildBins(book, mult, lo, hi, BINS) {
  const step = (hi - lo) / BINS;
  const bid = new Array(BINS).fill(0), ask = new Array(BINS).fill(0);
  const put = (arr, p, s) => {
    if (!(p >= lo && p < hi) || !(s > 0)) return;
    const i = Math.max(0, Math.min(BINS - 1, Math.floor((p - lo) / step)));
    arr[i] += s * mult * p;
  };
  book.bids.forEach(r => put(bid, r[0], r[1]));
  book.asks.forEach(r => put(ask, r[0], r[1]));
  return { bid, ask, step, lo, hi, bins: BINS };
}
function findPoc(arr) {
  let i = 0;
  for (let k = 1; k < arr.length; k++) if (arr[k] > arr[i]) i = k;
  return i;
}
/* 价值区：从 POC 向两侧贪心扩张到 target 占比（Market Profile 标准做法） */
function valueArea(arr, target) {
  const tot = arr.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return null;
  let poc = findPoc(arr), lo = poc, hi = poc, acc = arr[poc];
  while (lo > 0 || hi < arr.length - 1) {
    const dv = lo > 0 ? arr[lo - 1] : -1;
    const uv = hi < arr.length - 1 ? arr[hi + 1] : -1;
    if (dv < 0 && uv < 0) break;
    if (dv >= uv) { lo--; acc += arr[lo]; } else { hi++; acc += arr[hi]; }
    if (acc / tot >= target) break;
  }
  return { lo, hi, poc, acc, share: acc / tot };
}
/* ★ 空洞 v2：只在某一侧的**有效格**上滑窗，且必须落在 searange 内。
 *   返回稀疏度 sparsity = 窗口均值 / 同侧基线均值（越小越真）          */
function voidBandSide(arr, from, to, win) {
  const a = Math.max(0, from), b = Math.min(arr.length - 1, to);
  if (b - a + 1 < win) return null;
  /* ★ baseline 用**非零格的中位数**（与 lsmap.js 保持一致）：订单簿是「少量巨墙 +
     大量普通单」，均值会被巨墙抬高，把均匀的普通挂单误判成稀薄 */
  const nz = [];
  for (let i = a; i <= b; i++) if (arr[i] > 0) nz.push(arr[i]);
  nz.sort((x, y) => x - y);
  let baseline = 0;
  if (nz.length) {
    const m = nz.length >> 1;
    baseline = (nz.length % 2) ? nz[m] : (nz[m - 1] + nz[m]) / 2;
  }
  let pre = 0;
  for (let i = a; i < a + win; i++) pre += arr[i];
  let best = { lo: a, hi: a + win - 1, sum: pre };
  for (let i = a + 1; i + win - 1 <= b; i++) {
    pre += arr[i + win - 1] - arr[i - 1];
    if (pre < best.sum) best = { lo: i, hi: i + win - 1, sum: pre };
  }
  best.avg = best.sum / win;
  best.sparsity = baseline > 0 ? best.avg / baseline : 1;
  best.baseline = baseline;
  return best;
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const CONTRACT = process.argv[2] || 'ETH_USDT';
  const NEED = +(process.argv[3] || 400);
  const VASHARE = +(process.argv[4] || 0.70);
  const WINPCT = +(process.argv[5] || 0.08);

  console.log('\n===== ' + CONTRACT + ' · ±' + NEED + ' tick · VA=' + VASHARE + ' · 窗口=' + (WINPCT * 100) + '% =====\n');
  const ci = await get(`/api/v4/futures/usdt/contracts/${CONTRACT}`);
  const mult = +ci.quanto_multiplier, tick = +ci.order_price_round;
  const tk = (await get(`/api/v4/futures/usdt/tickers?contract=${CONTRACT}`))[0];
  const P = +tk.last;
  console.log('mult=' + mult + ' tick=' + tick + ' last=' + P);

  /* 尽量用最细粒度：先试 interval=0，覆盖不够再逐级变粗 */
  const cs = cands(tick);
  let bids = [], asks = [], iv = 0;
  for (const cand of cs) {
    const b = await get(`/api/v4/futures/usdt/order_book?contract=${CONTRACT}&limit=300&interval=${cand === 0 ? 0 : fmt(cand)}`);
    const bb = b.bids.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    const aa = b.asks.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    const loB = Math.min.apply(null, bb.map(r => r[0])), hiA = Math.max.apply(null, aa.map(r => r[0]));
    const cover = Math.max(P - loB, hiA - P) / tick;
    console.log('  interval=' + fmt(cand) + '  档 ' + bb.length + '/' + aa.length + '  覆盖 ±' + Math.round(cover) + ' tick');
    bids = bb; asks = aa; iv = cand;
    if (cover >= NEED) break;
  }
  const BESTB = bids[0][0], BESTA = asks[0][0];

  const LO = P - NEED * tick, HI = P + NEED * tick;
  const BINS = 72;
  const bz = buildBins({ bids, asks }, mult, LO, HI, BINS);
  const step = bz.step;
  console.log('\n视野 [' + LO.toFixed(2) + ', ' + HI.toFixed(2) + ']  每格 ' + step.toFixed(4) + ' (' + (step / tick).toFixed(1) + ' tick)');

  const tot = new Array(BINS).fill(0);
  for (let i = 0; i < BINS; i++) tot[i] = bz.bid[i] + bz.ask[i];
  const sumAll = tot.reduce((a, b) => a + b, 0);
  const sumB = bz.bid.reduce((a, b) => a + b, 0), sumA = bz.ask.reduce((a, b) => a + b, 0);
  console.log('视野内：买 $' + usd(sumB) + '  卖 $' + usd(sumA) + '  合计 $' + usd(sumAll));

  /* POC / VA —— 用合成能量（两侧互斥，合成 = 该价位的总挂单） */
  const poc = findPoc(tot);
  const va = valueArea(tot, VASHARE);
  console.log('POC  #' + poc + '  价 ' + (LO + (poc + 0.5) * step).toFixed(2) + '  $' + usd(tot[poc]));
  if (va) console.log('VA   #' + va.lo + '~#' + va.hi + '  ' + (LO + va.lo * step).toFixed(2) + ' ~ ' + (LO + (va.hi + 1) * step).toFixed(2)
    + '  带宽 ' + (va.hi - va.lo + 1) + '/' + BINS + ' 格 (' + ((va.hi - va.lo + 1) / BINS * 100).toFixed(0) + '% 视野)  占 '
    + (va.share * 100).toFixed(1) + '%');

  /* ★ 空洞按侧算 */
  const winW = Math.max(2, Math.round(BINS * WINPCT));
  const pocRow = Math.floor((P - LO) / step);
  const up = voidBandSide(bz.ask, pocRow + 1, BINS - 1, winW);
  const dn = voidBandSide(bz.bid, 0, pocRow - 1, winW);
  const bandStr = (b, sideName) => b
    ? '  ' + sideName + ' #' + b.lo + '~#' + b.hi + '  ' + (LO + b.lo * step).toFixed(2) + ' ~ ' + (LO + (b.hi + 1) * step).toFixed(2)
      + '  $' + usd(b.sum) + '  稀疏度 ' + b.sparsity.toFixed(3) + '  (同侧均值 $' + usd(b.baseline) + ')'
    : '  ' + sideName + ' 无（有效区间不足 ' + winW + ' 格）';
  console.log('空洞窗口 ' + winW + ' 格（' + (winW * step).toFixed(2) + ' USDT, ' + (winW * step / tick).toFixed(0) + ' tick）');
  console.log(bandStr(up, '上方'));
  console.log(bandStr(dn, '下方'));

  /* ---- ASCII ---- */
  const maxV = Math.max.apply(null, tot);
  const S = new Set();
  if (va) for (let i = va.lo; i <= va.hi; i++) S.add('va' + i);
  if (up) for (let i = up.lo; i <= up.hi; i++) S.add('up' + i);
  if (dn) for (let i = dn.lo; i <= dn.hi; i++) S.add('dn' + i);
  console.log('\n价格        买盘金额 | 卖盘金额 |        分布(█=买 ▓=卖)             标记');
  console.log('─'.repeat(112));
  for (let i = BINS - 1; i >= 0; i--) {
    const p = LO + i * step;
    const nb = Math.round(bz.bid[i] / maxV * 30), na = Math.round(bz.ask[i] / maxV * 30);
    const bar = ' '.repeat(Math.max(0, 30 - nb)) + '█'.repeat(nb) + '│' + '▓'.repeat(na);
    const tags = [];
    if (i === poc) tags.push('POC');
    if (S.has('va' + i)) tags.push('VA');
    if (S.has('up' + i)) tags.push('上空');
    if (S.has('dn' + i)) tags.push('下空');
    if (p <= P && P < p + step) tags.push('现价');
    console.log(p.toFixed(2).padStart(9) + ' ' + usd(bz.bid[i]).padStart(9) + ' ' + usd(bz.ask[i]).padStart(9) + ' |' + bar.padEnd(62) + '| ' + tags.join(' '));
  }
  console.log('─'.repeat(112));
  console.log('买一 ' + BESTB + '  卖一 ' + BESTA + '  价差 ' + (BESTA - BESTB).toFixed(2) + ' (' + ((BESTA - BESTB) / tick).toFixed(0) + ' tick)');
}
main().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
