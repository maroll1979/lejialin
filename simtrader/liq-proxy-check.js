/* ============================================================================
 * liq-proxy-check.js — 方案 A 的前提验证：K 线 Volume Profile 能不能当挂单结构的代理？
 * ============================================================================
 * 历史任何时点的真实挂单都拿不到（order_book 只有当下，liq_orders 只能回溯 1 小时），
 * 所以回放只能用 VP 代理。但代理成不成立，不能靠感觉，要对着真实盘口量。
 *
 * 做法：同一时刻，一边抓真实订单簿，一边用最近 N 根 1m K 线重建 VP，
 *      **投影到同一个价格区间**，然后比四件事：
 *        1) POC     最密集价位差多少（bp）
 *        2) VA      价值区重合度 IoU
 *        3) 薄带    上/下最薄带的中心价差多少、是否落在同一侧
 *        4) 随机基线 如果 VP 的表现和「随手一点」差不多，代理就不成立
 *
 * ★ 最重要的设计：必须有随机基线。没有基线，任何"看起来挺接近"的判断都是自欺。
 *
 * 用法：node liq-proxy-check.js [SHOTS] [GAP_SEC]
 * ========================================================================== */
'use strict';
const https = require('https');
const V = require('./volprofile.js');

const GATE = 'api.gateio.ws';
const SHOTS = +(process.argv[2] || 8);
const GAP = +(process.argv[3] || 150);              // 采样间隔（秒）
const WINDOWS = [60, 240, 720];                     // 1h / 4h / 12h（1m 根数）
const BINS = 72;
/* ★ 视野不能窄：±400 tick（BTC ±0.05%）比单根 1m K 线的跨度还小，
     每根 K 线都会均匀铺满全部格子 → VP 被摊平、POC 落在边缘格，毫无分辨力。
     必须让订单簿用分组档位撑到最大覆盖，使视野宽度 >> 单根 K 线跨度。
     这里给一个上限，实际视野取「订单簿能达到的最大覆盖」。 */
const NEED_TICKS = 12000;
const MIN_TICKS = 3000;                             // 低于此值就诚实警告分辨力不足
const VASHARE = 0.70;
const WINPCT = 0.12;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: GATE, path: path, timeout: 20000, headers: { accept: 'application/json' } }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
const fmt = v => Number(v.toFixed(10)).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => String(s).padStart(n);
const f2 = (v, d) => v == null ? '  --  ' : v.toFixed(d == null ? 2 : d);

function cands(tick) {
  const out = [0];
  for (let k = -8; k <= 6; k++) for (const m of [1, 5]) {
    const v = m * Math.pow(10, k);
    if (v >= tick * 0.999) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/* ---- 订单簿 → 分格金额（买/卖分开，不做合成） ---- */
function bookBins(bids, asks, mult, lo, hi, BINS) {
  const step = (hi - lo) / BINS;
  const bid = new Float64Array(BINS), ask = new Float64Array(BINS);
  const put = (arr, p, s) => {
    if (!(p >= lo && p < hi) || !(s > 0)) return;
    const i = Math.max(0, Math.min(BINS - 1, Math.floor((p - lo) / step)));
    arr[i] += s * mult * p;                          // 金额（USDT），与 VP 的 sum 对齐
  };
  bids.forEach(r => put(bid, r[0], r[1]));
  asks.forEach(r => put(ask, r[0], r[1]));
  return { bid: bid, ask: ask, step: step, lo: lo, hi: hi, bins: BINS };
}

/* 一次扫描所有分组档位，挑覆盖面最大的那个（结果按品种缓存，避免重复打接口） */
const IV_CACHE = {};
async function pickInterval(contract, tick, P) {
  if (IV_CACHE[contract]) return IV_CACHE[contract];
  let best = { iv: 0, cover: 0, bids: [], asks: [] };
  for (const cand of cands(tick)) {
    const b = await get('/api/v4/futures/usdt/order_book?contract=' + contract + '&limit=300&interval=' + (cand === 0 ? 0 : fmt(cand)));
    const bb = b.bids.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    const aa = b.asks.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
    if (!bb.length || !aa.length) continue;
    const loB = Math.min.apply(null, bb.map(r => r[0])), hiA = Math.max.apply(null, aa.map(r => r[0]));
    const cover = Math.max(P - loB, hiA - P) / tick;
    if (cover > best.cover) best = { iv: cand, cover: cover, bids: bb, asks: aa };
    if (best.cover >= NEED_TICKS) break;
  }
  IV_CACHE[contract] = best;
  return best;
}

/* ---- 一次采样：返回 {book结构, 三种窗口的VP结构} ---- */
async function shot(contract) {
  const ci = await get('/api/v4/futures/usdt/contracts/' + contract);
  const mult = +ci.quanto_multiplier, tick = +ci.order_price_round;
  const tk = (await get('/api/v4/futures/usdt/tickers?contract=' + contract))[0];
  const P = +tk.last;

  /* 订单簿：用覆盖面最大的分组档位（视野越宽，VP 才越有分辨力） */
  let picked = await pickInterval(contract, tick, P);
  /* 档位缓存的买卖盘是旧时点的，每次采样仍要重拉当前快照 */
  const snap = await get('/api/v4/futures/usdt/order_book?contract=' + contract + '&limit=300&interval=' + (picked.iv === 0 ? 0 : fmt(picked.iv)));
  let bids = snap.bids.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
  let asks = snap.asks.map(x => [+x.p, +x.s]).filter(r => r[0] > 0 && r[1] > 0);
  const loB = Math.min.apply(null, bids.map(r => r[0])), hiA = Math.max.apply(null, asks.map(r => r[0]));
  const cover = Math.max(P - loB, hiA - P) / tick;
  const iv = picked.iv;
  /* K 线：最近 720 根 1m */
  const cs = await get('/api/v4/futures/usdt/candlesticks?contract=' + contract + '&interval=1m&limit=' + WINDOWS[WINDOWS.length - 1]);
  const rows = cs.map(r => ({ time: +r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.sum }))
    .sort((a, b) => a.time - b.time);
  const ser = {
    n: rows.length,
    t: Float64Array.from(rows, r => r.time),
    o: Float64Array.from(rows, r => r.open),
    h: Float64Array.from(rows, r => r.high),
    l: Float64Array.from(rows, r => r.low),
    c: Float64Array.from(rows, r => r.close),
    v: Float64Array.from(rows, r => r.volume)
  };

  const half = Math.min(cover, NEED_TICKS) * tick;
  const LO = P - half, HI = P + half;
  /* ★ 分辨力体检：格宽 vs 单根 1m K 线的平均跨度。
       格宽 < K 线跨度 ⇒ 每根 K 线都会铺满好几格 ⇒ VP 被摊平，读不出结构。 */
  let spanSum = 0, spanN = 0;
  for (let i = Math.max(0, ser.n - 60); i < ser.n; i++) { spanSum += ser.h[i] - ser.l[i]; spanN++; }
  const avgSpan = spanN ? spanSum / spanN : 0;
  const cellW = (HI - LO) / BINS;
  const resolv = avgSpan > 0 ? cellW / avgSpan : null;

  /* 订单簿结构：薄带必须分侧（上方只有卖单、下方只有买单） */
  const bz = bookBins(bids, asks, mult, LO, HI, BINS);
  const tot = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) tot[i] = bz.bid[i] + bz.ask[i];
  const pocB = V.pocOf(tot);
  const vaB = V.valueArea(tot, VASHARE);
  const row = Math.max(0, Math.min(BINS - 1, Math.floor((P - LO) / ((HI - LO) / BINS))));
  const winW = Math.max(2, Math.round(BINS * WINPCT));
  const upB = V.thinBand(bz.ask, Math.min(BINS - 1, row + 1), BINS - 1, winW);
  const dnB = V.thinBand(bz.bid, 0, Math.max(0, row - 1), winW);

  /* VP 结构：同一个 [LO,HI] 视野，只比这一段 */
  const vps = {};
  for (const W of WINDOWS) {
    const from = Math.max(0, ser.n - W);
    const prof = V.buildProfile(ser, from, ser.n, BINS, { lo: LO, hi: HI });
    if (!prof) { vps[W] = null; continue; }
    const f = V.structureAt(prof, P, { winPct: WINPCT, vaShare: VASHARE, anchor: 'price' });
    const pocV = V.pocOf(prof.vol);
    const vaV = V.valueArea(prof.vol, VASHARE);
    vps[W] = {
      f: f,
      pocRow: pocV,
      pocPx: V.binPx(prof, pocV),
      vaLo: vaV ? prof.lo + vaV.lo * prof.step : null,
      vaHi: vaV ? prof.lo + (vaV.hi + 1) * prof.step : null,
      upC: f && f.upLo != null ? (f.upLo + f.upHi) / 2 : null,
      dnC: f && f.dnLo != null ? (f.dnLo + f.dnHi) / 2 : null,
      upSp: f ? f.upSp : null,
      dnSp: f ? f.dnSp : null,
      span: HI - LO
    };
  }
  const stepB = (HI - LO) / BINS;
  return {
    P: P, LO: LO, HI: HI, tick: tick, cover: cover, iv: iv, nbars: ser.n,
    cellW: cellW, avgSpan: avgSpan, resolv: resolv,
    book: {
      pocRow: pocB, pocPx: LO + (pocB + 0.5) * stepB,
      vaLo: vaB ? LO + vaB.lo * stepB : null,
      vaHi: vaB ? LO + (vaB.hi + 1) * stepB : null,
      upC: upB ? LO + (upB.lo + upB.hi + 1) / 2 * stepB : null,
      dnC: dnB ? LO + (dnB.lo + dnB.hi + 1) / 2 * stepB : null,
      upSp: upB ? upB.sparsity : null,
      dnSp: dnB ? dnB.sparsity : null
    },
    vps: vps
  };
}

/* ---- 对比指标 ---- */
const bp = (diff, P) => diff / P * 1e4;             // 相对偏差 → bp
function iou(aLo, aHi, bLo, bHi) {
  if (aLo == null || bLo == null) return null;
  const i = Math.max(0, Math.min(aHi, bHi) - Math.max(aLo, bLo));
  const u = Math.max(aHi, bHi) - Math.min(aLo, bLo);
  return u > 0 ? i / u : null;
}

(async () => {
  const contracts = (process.argv[4] || 'BTC_USDT,ETH_USDT').split(',');
  console.log('\n════════ 代理验证：真实订单簿 vs K 线 Volume Profile ════════');
  console.log('每个品种采样 ' + SHOTS + ' 次，间隔 ' + GAP + ' 秒 · 视野 ±' + NEED_TICKS
    + ' tick · ' + BINS + ' 格 · VA=' + VASHARE + ' · 薄带窗口 ' + (WINPCT * 100) + '%\n');

  const agg = {};                                    // contract -> W -> 指标数组
  for (const c of contracts) {
    agg[c] = {};
    for (const W of WINDOWS) agg[c][W] = { dPoc: [], pocRow: [], iou: [], upD: [], dnD: [], upSide: 0, dnSide: 0, n: 0, upSpB: [], upSpV: [], dnSpB: [], dnSpV: [] };
  }

  for (let k = 0; k < SHOTS; k++) {
    for (const c of contracts) {
      let r;
      try { r = await shot(c); } catch (e) { console.log('  [' + c + '] 采样失败: ' + e.message); continue; }
      for (const W of WINDOWS) {
        const v = r.vps[W];
        const a = agg[c][W];
        if (!v || !v.pocPx) continue;
        a.n++;
        a.dPoc.push(bp(Math.abs(v.pocPx - r.book.pocPx), r.P));
        a.pocRow.push(Math.abs(v.pocRow - r.book.pocRow) / BINS);
        const io = iou(v.vaLo, v.vaHi, r.book.vaLo, r.book.vaHi);
        if (io != null) a.iou.push(io);
        if (v.upC != null && r.book.upC != null) {
          a.upD.push(bp(Math.abs(v.upC - r.book.upC), r.P));
          if ((v.upC > r.P) === (r.book.upC > r.P)) a.upSide++;
        }
        if (v.dnC != null && r.book.dnC != null) {
          a.dnD.push(bp(Math.abs(v.dnC - r.book.dnC), r.P));
          if ((v.dnC < r.P) === (r.book.dnC < r.P)) a.dnSide++;
        }
        if (v.upSp != null && r.book.upSp != null) { a.upSpB.push(r.book.upSp); a.upSpV.push(v.upSp); }
        if (v.dnSp != null && r.book.dnSp != null) { a.dnSpB.push(r.book.dnSp); a.dnSpV.push(v.dnSp); }
      }
      if (k === 0) {
        console.log('  [' + c + '] 现价 ' + r.P + ' · 视野 ±' + ((r.HI - r.LO) / 2).toFixed(1) + ' (' + ((r.HI - r.LO) / r.P * 100).toFixed(2) + '%)'
          + ' · 订单簿覆盖 ±' + Math.round(r.cover) + ' tick (interval=' + fmt(r.iv) + ') · 有 ' + r.nbars + ' 根 1m');
        console.log('      分辨力：格宽 ' + r.cellW.toFixed(3) + ' vs 1m K 线平均跨度 ' + r.avgSpan.toFixed(3)
          + ' → 比值 ' + (r.resolv == null ? '--' : r.resolv.toFixed(2))
          /* 单根 K 线占 1/resolv 格：≤3 格（resolv≥0.33）就有分辨力，
             ≤10 格（≥0.1）勉强；再低就真被摊平了 */
          + (r.resolv == null ? '' : r.resolv >= 0.33 ? '  (可分辨，单根约占 '
              + (1 / r.resolv).toFixed(1) + ' 格)' : r.resolv >= 0.1 ? '  (勉强)' : '  ★ 摊平，无分辨力'));
        if (r.cover < MIN_TICKS) console.log('      ★ 订单簿覆盖不足 ' + MIN_TICKS + ' tick，对比结论不可靠');
      }
    }
    if (k < SHOTS - 1) await sleep(GAP * 1000);
  }

  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  /* 随机基线：POC 若随手落在 [LO,HI] 上，与订单簿 POC 的期望距离 */
  console.log('\n── 结果（POC 偏差单位 bp = 万分之一；IoU = 价值区重合度）──');
  console.log('品种      窗口  样本  POC偏差  随机基线  比值   POC格差   VA-IoU   上薄带差  同侧率   下薄带差  同侧率');
  for (const c of contracts) {
    for (const W of WINDOWS) {
      const a = agg[c][W];
      if (!a.n) { console.log('  ' + c.padEnd(9) + (W + 'm').padEnd(6) + '  无样本'); continue; }
      const mD = mean(a.dPoc), mR = mean(a.pocRow), mI = mean(a.iou);
      const mU = mean(a.upD), mDn = mean(a.dnD);
      console.log('  ' + c.replace('_USDT', '').padEnd(8)
        + pad(W + 'm', 6) + pad(a.n, 5)
        + pad(f2(mD, 1), 9) + pad('~', 9) + pad('', 5)
        + pad((mR * 100).toFixed(1) + '%', 9)
        + pad(mI == null ? '--' : (mI * 100).toFixed(1) + '%', 9)
        + pad(mU == null ? '--' : f2(mU, 1), 10)
        + pad(a.upSide + '/' + a.n, 9)
        + pad(mDn == null ? '--' : f2(mDn, 1), 10)
        + pad(a.dnSide + '/' + a.n, 8));
    }
  }

  /* 随机基线单列：E|Δ| 对均匀分布 = 视野宽度/3（转成 bp 需要视野宽度） */
  console.log('\n── 随机基线对照（POC 偏差）──');
  console.log('  若「VP 的 POC 偏差」和随机基线同量级 → VP 没有携带结构信息，代理不成立。');
  for (const c of contracts) {
    for (const W of WINDOWS) {
      const a = agg[c][W];
      if (!a.n) continue;
      const mD = mean(a.dPoc);
      /* 用 POC 格差的随机期望做同尺度对照：
         随机取格时 E|i-j|/BINS ≈ 1/3，故格差 33.3% 即等于随机 */
      const randRow = 1 / 3;
      const mR = mean(a.pocRow);
      console.log('  ' + c.replace('_USDT', '').padEnd(8) + pad(W + 'm', 6)
        + ' 实测格差 ' + (mR * 100).toFixed(1) + '%  随机期望 ' + (randRow * 100).toFixed(1)
        + '%  →  ' + (mR < randRow * 0.5 ? '优于随机（有信息）' : mR < randRow * 0.8 ? '略优于随机' : '★ 与随机无异，代理不成立'));
    }
  }

  /* 稀疏度对照：VP 的薄带稀疏度和订单簿的差多少 */
  console.log('\n── 稀疏度对照（越小越薄；看 VP 是否系统性低估/高估）──');
  console.log('品种      窗口   上方:订单簿  上方:VP    下方:订单簿  下方:VP');
  for (const c of contracts) {
    for (const W of WINDOWS) {
      const a = agg[c][W];
      if (!a.upSpB.length && !a.dnSpB.length) continue;
      console.log('  ' + c.replace('_USDT', '').padEnd(8) + pad(W + 'm', 6)
        + pad(f2(mean(a.upSpB), 3), 12) + pad(f2(mean(a.upSpV), 3), 10)
        + pad(f2(mean(a.dnSpB), 3), 13) + pad(f2(mean(a.dnSpV), 3), 10));
    }
  }
})().catch(e => { console.error('FAIL', e && e.stack); process.exit(1); });
