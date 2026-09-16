/* ============================ 行情聚合 ============================ */
// 确定性伪随机：保证“参考报价”稳定，不随刷新闪烁
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seedOf(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

async function loadQuotes(symId) {
  const s = SYMS[symId];
  const t0 = now();
  const list = VENUES.filter(v => {
    if (v.id === 'yahoo') return !!s.yh;              // 商品期货对照（非永续）
    if (v.spotRef) return !!s.cg;                     // 现货指数对照（非永续）
    return true;                                       // 永续源全部参与
  });

  const res = await Promise.all(list.map(async v => {
    const t = now();
    const note = typeof v.note === 'function' ? v.note(s) : v.note;
    try {
      const d = await v.get(s);
      S.venues[v.id] = { ok: true, ms: now() - t };
      return { id: v.id, name: v.name, note, price: d.price, mark: d.mark,
               funding: d.funding, perp: !!v.perp, real: true, ms: now() - t };
    } catch (e) {
      S.venues[v.id] = { ok: false, err: String(e.message || e) };
      return { id: v.id, name: v.name, note, price: null, perp: !!v.perp,
               real: false, err: String(e.message || e) };
    }
  }));

  // 只有「永续合约源」参与多平台价差对比；现货/期货源仅作基差参考
  const ok = res.filter(r => r.price != null);
  const perpRows = ok.filter(r => r.perp);
  const refRows  = ok.filter(r => !r.perp);

  const rows = perpRows.slice();
  const realCount = rows.length;
  /* 真实永续源不足 2 个时，不再补任何「参考报价」。
   * 旧版会按真实价 ±0.08% 造三个假平台出来演示价差算法 —— 那三行数字不属于任何交易所，
   * 却和真实报价并排显示在同一张表里，等于把编造数据混进真实数据。
   * 价差表宁可空着、宁可显示「真实源不足」，也不能造。 */

  const vals = rows.map(r => r.price).sort((a, b) => a - b);
  const median = vals.length
    ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2)
    : null;
  const hi = vals.length ? vals[vals.length - 1] : null;
  const lo = vals.length ? vals[0] : null;
  const mid = rows.find(r => r.real) || rows[0] || null;

  // 平台最低价≥？按用户规则：以“交易价格”为基准，阈值 0.10%
  const basePx = mid ? mid.price : median;
  const spread = (hi != null && lo != null) ? hi - lo : null;
  const spreadPct = (spread != null && lo > 0) ? spread / lo * 100 : null;

  if (median) {
    rows.forEach(r => {
      r.dev = (r.price - median) / median * 100;
      r.isHi = r.price === hi; r.isLo = r.price === lo;
    });
    refRows.forEach(r => { r.dev = (r.price - median) / median * 100; });
  }

  // 资金费率：取各永续源中位数，用于展示多头/空头付费方向
  const fr = perpRows.map(r => r.funding).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  const funding = fr.length
    ? (fr.length % 2 ? fr[(fr.length - 1) / 2] : (fr[fr.length / 2 - 1] + fr[fr.length / 2]) / 2)
    : null;

  S.quotes[symId] = {
    rows, refRows, median, hi, lo, spread, spreadPct, realCount, basePx,
    funding, fundingCount: fr.length,
    ts: now(),             // 数据更新时间戳（用于判断过期）
    dur: now() - t0,       // 本次请求耗时（毫秒）
    // 价差阈值判定必须显式判空：spreadPct 为 null 时 `null >= 0.10` 是 false，语义正确但容易被误读
    hit: spreadPct != null && spreadPct >= 0.10,
    price: mid ? mid.price : median,
  };
  return S.quotes[symId];
}

/* 没有「断网兜底锚定价」。
 * 旧版在拿不到任何报价时会用一组写死的价格（BTC 78000 之类）顶上去，
 * 页面看起来有数，实际那个数跟市场毫无关系。现在一律显示「—」并给出取数失败原因。 */

