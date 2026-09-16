/* ============================ K 线：全部来自交易所真实接口 ============================ */
/* ---- 各平台「永续合约」K 线适配器：统一返回升序 bars ---- */
const KLINE = {
  binance: { name: 'Binance 永续', async run(sym, tf) {
    const r = await jget(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf.k}&limit=240`, 9000);
    if (!Array.isArray(r) || !r.length) throw new Error('empty');
    return r.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } },
  okx: { name: 'OKX 永续', async run(sym, tf) {
    const r = await jget(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${tf.okx}&limit=240`, 9000);
    if (!r || r.code !== '0' || !r.data || !r.data.length) throw new Error('empty');
    return r.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  } },
  bybit: { name: 'Bybit 永续', async run(sym, tf) {
    const r = await jget(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${tf.bybit}&limit=240`, 9000);
    const l = r && r.result && r.result.list;
    if (!l || !l.length) throw new Error('empty');
    return l.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  } },
  bingx: { name: 'BingX 永续', async run(sym, tf) {
    const r = await jget(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${sym}&interval=${tf.bingx}&limit=240`, 9000);
    const l = r && r.data;
    if (!l || !l.length) throw new Error('empty');
    return l.map(k => ({ t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume })).reverse();
  } },
  yahoo: { name: 'Yahoo 期货', async run(sym, tf) {
    const r = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${tf.yh}&range=${tf.yr}`, 9000);
    const res = r?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error('empty');
    const q = res.indicators.quote[0];
    let bars = res.timestamp.map((t, i) => ({
      t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0,
    })).filter(b => b.o && b.h && b.l && b.c);
    if (!bars.length) throw new Error('empty');
    if (tf.agg) bars = aggBars(bars, tf.m * 60000, tf.agg);   // 4h 由 1h 聚合，按时间桶而非下标
    return bars;
  } },
};

// 永续优先，逐级回退；全部失败交由上层合成兜底
async function fetchReal(symId, tfKey) {
  const s = SYMS[symId], tf = TF_MAP[tfKey];
  const chain = [];
  if (s.perp) {
    if (s.perp.binance) chain.push(['binance', s.perp.binance]);
    if (s.perp.okx)     chain.push(['okx', s.perp.okx]);
    if (s.perp.bybit)   chain.push(['bybit', s.perp.bybit]);
    if (s.perp.bingx)   chain.push(['bingx', s.perp.bingx]);
  }
  if (s.yh) chain.push(['yahoo', s.yh]);

  let lastErr = new Error('无可用永续 K 线源');
  for (const [vid, sym] of chain) {
    try {
      const bars = await KLINE[vid].run(sym, tf);
      const clean = bars.filter(b => isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c));
      if (clean.length >= 30) return { bars: clean.slice(-240), real: true, src: KLINE[vid].name };
      lastErr = new Error(KLINE[vid].name + ' 返回数据不足');
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* 确定性随机 K 线序列。
 * ⚠️ 仅用于测试构造样本（tests/_test.js 等把它当 fixture），
 *    任何线上渲染路径都禁止调用 —— 页面上不允许出现一根编造出来的 K 线。
 *    若你在业务代码里看到 mkBars 的调用，那就是 bug。 */
function mkBars(symId, tfKey, anchor) {
  const s = SYMS[symId], tf = TF_MAP[tfKey], n = 240;
  const rnd = mulberry32(seedOf(symId + tfKey));
  const sigma = s.vol * Math.sqrt(tf.m / 1440);
  const drift = (rnd() - 0.45) * sigma * 0.12;
  const g = mulberry32(seedOf(symId + tfKey + 'g'));
  const gauss = () => { let u = 0, v = 0; while (!u) u = g(); while (!v) v = g(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  let p = 1, seq = [];
  for (let i = 0; i < n; i++) { p *= Math.exp(drift + gauss() * sigma); seq.push(p); }
  const k = anchor / seq[n - 1];
  seq = seq.map(x => x * k);

  const step = tf.m * 60000;
  const bars = [];
  let prev = seq[0] * (1 - sigma * 0.2);
  for (let i = 0; i < n; i++) {
    const c = seq[i], o = prev;
    const w = Math.abs(c - o) + c * sigma * (0.25 + rnd() * 0.6);
    bars.push({
      t: now() - (n - 1 - i) * step,
      o, c, h: Math.max(o, c) + w * rnd() * 0.6, l: Math.min(o, c) - w * rnd() * 0.6,
      v: (0.55 + rnd() * 0.9) * (1 + Math.abs(c / o - 1) * 24),
    });
    prev = c;
  }
  return { bars, real: false, src: '合成' };
}

/* 序列保留上限。取数一次给 240 根，跨周期合并后序列会持续增长；
 * 1000 根足够任何指标热身（MACD 26 + DEA 9 也只要几十根），同时防止挂机数周后数组无界膨胀。 */
const KBAR_CAP = 1000;

/* ===== KBAR-MERGE-START ===== */
/* 按时间戳合并两段 K 线序列。
 *
 * 旧实现只改最后一根的 c/h/l，有四个后果：
 *   1) 跨周期后永不追加新 bar —— 序列长度冻结在首次加载那一刻，
 *      MACD / OBV / KDJ / ATR 全在一条停止生长的序列上算，页面价格却在动；
 *   2) 最高最低用「旧 h 与新收盘价取 max/min」凑，不是接口返回的真实高低
 *      （实测 140 被压成 120 —— 因为只跟收盘价比）；
 *   3) 成交量永不更新 —— OBV 累积的是过期量；
 *   4) 断线重连后中间缺失的区间补不回来。
 *
 * 正确做法：以时间戳为键，同键**整根替换**。
 * 为什么不逐字段拼：同一时间桶里接口返回的就是权威值，把「旧 open + 新 close + 旧 volume」
 * 拼在一起，会造出一根市场上从未存在过的 bar，比直接用旧值更糟。
 * 新键追加 → 按时间排序 → 裁剪到 cap。
 * 不修改入参，返回新数组（旧实现原地 mutate，调用方拿不到「有没有新增」的信号）。 */
function mergeBars(oldBars, newBars, cap) {
  const byT = new Map();
  for (const list of [oldBars, newBars]) {
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!b || !isFinite(b.t)) continue;
      byT.set(b.t, b);       // 后一段覆盖前一段：接口对同一时间桶的数据是权威的
    }
  }
  const out = Array.from(byT.values()).sort((a, b) => a.t - b.t);
  return (cap > 0 && out.length > cap) ? out.slice(out.length - cap) : out;
}
/* 把细粒度 bar 聚合成粗粒度（Yahoo 只给到 1h，4h 要自己凑）。
 *
 * 桶键 = Math.floor(t / stepMs)，不是数组下标：
 * 下标分组依赖取数窗口起点，窗口一滑整个桶序列就错位 1~3 小时，
 * 后续按时间戳合并时每个桶都被当成「新时间戳」重复追加，序列里出现时段重叠的 bar。
 *
 * minCount：一个完整桶应含几根细粒度 bar。窗口边缘必然产生残缺桶，
 * 必须丢掉（只保留最后那个正在形成的桶），否则残缺桶会被写进缓存，
 * 下次合并时反过来把之前存好的完整桶替换成一个「只有 1 根 1h 的 4h bar」。 */
function aggBars(bars, stepMs, minCount) {
  const need = minCount > 0 ? minCount : 1;
  const buckets = new Map();
  for (const b of bars) {
    if (!b || !isFinite(b.t) || !(stepMs > 0)) continue;
    const k = Math.floor(b.t / stepMs);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const out = [];
  keys.forEach((k, i) => {
    const g = buckets.get(k);
    if (g.length < need && i !== keys.length - 1) return;   // 残缺桶：只放行最后那个（正在形成）
    out.push({
      t: k * stepMs, o: g[0].o, h: Math.max.apply(null, g.map(x => x.h)),
      l: Math.min.apply(null, g.map(x => x.l)), c: g[g.length - 1].c,
      v: g.reduce((a, x) => a + x.v, 0),
    });
  });
  return out;
}
/* P0-1：检测 K 线序列时间空洞。返回值 { gaps:[], maxGapMs, ok }，
 * 用于界面提示「数据不连续」，也是自动交易禁止开仓的辅助依据。 */
function klineGaps(bars, stepMs) {
  if (!Array.isArray(bars) || bars.length < 2 || !(stepMs > 0)) return { gaps: [], maxGapMs: 0, ok: true };
  const sorted = bars.slice().sort((a, b) => a.t - b.t);
  const gaps = [];
  let maxGapMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].t - sorted[i - 1].t;
    if (g > stepMs * 1.5) {           // 允许 50% 的容差（交易所偶发缺失一根）
      gaps.push({ from: sorted[i - 1].t, to: sorted[i].t, missing: Math.round(g / stepMs) - 1 });
      if (g > maxGapMs) maxGapMs = g;
    }
  }
  return { gaps, maxGapMs, ok: gaps.length === 0 };
}
/* ===== KBAR-MERGE-END ===== */

/* K 线加载：只接受交易所真实返回。
 * 取不到就抛错，由上层把「取数失败 + 原因」显示出来并自动重试 —— 绝不用合成序列顶替。
 * 唯一保留旧数据的情形：已经拉到过真实 K 线、只是这一次刷新没成功。
 * 这时沿用上一次的真实历史（那本来就是真实市场数据），但打上 stale 标记，
 * 界面显著提示「已停止更新 3 分 12 秒」，用户一眼能看出这不是当前行情。 */
async function loadKlines(symId, tfKey) {
  S.klines[symId] = S.klines[symId] || {};
  const cached = S.klines[symId][tfKey];
  let data;
  try {
    data = await fetchReal(symId, tfKey);
    S.kErr[symId + '|' + tfKey] = '';
  } catch (e) {
    S.kErr[symId + '|' + tfKey] = String(e.message || e);
    if (cached && cached.real && cached.bars.length) {
      cached.stale = true;
      cached.staleSince = cached.staleSince || now();
      return cached;
    }
    throw e;
  }

  /* 与已有序列按时间戳合并：同一根整根替换、新时间戳追加、断线缺口补齐。
   * 已收盘的历史 bar 不会被改写（新旧值本来相同），所以整图不会跳动 ——
   * 旧实现为「避免跳动」干脆不追加新 bar，等于把指标钉死在首次加载的序列上。 */
  if (cached && cached.bars.length && cached.real === data.real) {
    cached.bars = mergeBars(cached.bars, data.bars, KBAR_CAP);
    cached.src = data.src;
    cached.ts = now();                  // P2-1：记录取数时刻，界面要显示「这是几点的数据」
    cached.stale = false; cached.staleSince = 0;
    return cached;
  }
  data.stale = false; data.staleSince = 0;
  data.ts = now();
  data.bars = mergeBars([], data.bars, KBAR_CAP);
  S.klines[symId][tfKey] = data;
  return data;
}

