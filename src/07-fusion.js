/* ============================ 多因子方向融合 ============================ */
/* 技术面五个因子共同决定方向：K 线结构 / MACD / OBV / BOLL / KDJ，权重合计 78。
 * 清算（liq:34）不进这个加权和 —— 它只做乘性修正，见下方 base 计算处。
 * 目的就是让「一张热力图单独定方向」在结构上不可能成立。 */
const FUSE_W = { liq: 34, st: 22, macd: 16, obv: 14, boll: 14, kdj: 12 };

/* ---- 因子同源分组：多个指标一致 ≠ 多份独立证据 ----
 * 结构 / MACD / BOLL / KDJ 四个算法读的都是同一条 OHLC 收盘价序列，四个同向只能说明
 * 「同一份数据被四种算法读出了同一个方向」，不构成互相验证。把它们放在同一个同源组里，
 * 组内相关系数 ρ 是经验取值（不是统计估计）：ρ 越大，组内第 2、3、4 个同向因子
 * 能补进来的独立信息越少。n 个同组因子折算后的「有效独立证据数」= (1-(1-ρ)^n)/ρ：
 *   px 组 ρ=0.7 → 1 个 1.00 · 2 个 1.30 · 3 个 1.39 · 4 个 1.42（第四个几乎不增加信息）
 * OBV 吃的是成交量（vol 组），清算流动性来自热力图（flow 组），与 px 组不同源。 */
const FUSE_GROUP = { st: 'px', macd: 'px', boll: 'px', kdj: 'px', obv: 'vol', liq: 'flow' };
const FUSE_RHO = { px: 0.7, vol: 0.2, flow: 0.15 };
const FUSE_INDEP_FULL = 2.2;   // 拿到满额一致性加成所需的有效独立证据份数
const FUSE_MIN_INDEP = 1.35;   // 低于此视为证据不足：只靠 1~2 个价格同源因子不给方向

/* 有效独立证据数：先按同源组归类，组内按 ρ 折减后求和。 */
function fuseIndep(items) {
  const g = Object.create(null);
  for (let i = 0; i < items.length; i++) {
    const k = FUSE_GROUP[items[i].k] || 'other';
    (g[k] || (g[k] = [])).push(items[i]);
  }
  let n = 0;
  for (const k in g) {
    const r = FUSE_RHO[k] == null ? 0.3 : FUSE_RHO[k];
    const c = g[k].length;
    n += r > 0 ? (1 - Math.pow(1 - r, c)) / r : c;
  }
  return n;
}

/* 「一致度」= 参与评分的因子里同方向因子所占的比例。它衡量的是证据的一致性，
 * 不是胜率、也不是未来盈利概率。 */
const CONF_NOTE = '因子一致度 = 参与评分的因子中同方向因子的占比，衡量证据一致性；'
  + '它不是胜率，也不代表未来盈利概率 —— MACD / KDJ / BOLL / 结构同源，同向不等于互相独立验证。';
const INDEP_NOTE = '有效独立证据：按同源分组折算后的证据份数（结构 / MACD / BOLL / KDJ 同源，'
  + '四个同向只折算成约 1.4 份，不是 4 份；OBV 用成交量、清算用热力图，各算独立来源）。'
  + '合成分的一致性加成按独立口径给：同源因子堆得再多也拿不到满额加成，'
  + '有效独立证据不足 1.35 份时不给方向。';

/* 扫单倾向分级。mmView 里的这个分值是「基础值＋密集区强度×系数＋距离×系数＋技术强度×系数」
 * 拼出来的固定公式，没有任何历史样本校准。把它显示成「80%」会被读成
 * 「十次有八次会扫」—— 那不是这个数的含义。这里保留分值用于排序，对外只给高 / 中 / 低三档。 */
function sweepTendency(score) {
  const p = clamp(score == null ? 0 : score, 0, 1);
  if (p >= 0.62) return { level: 'high', txt: '高', cls: 'up', score: p };
  if (p >= 0.45) return { level: 'mid', txt: '中', cls: 'flat', score: p };
  return { level: 'low', txt: '低', cls: 'down', score: p };
}
const SWEEP_TENDENCY_NOTE = '「扫单倾向」是模型的相对评分（越高越像扫单结构），'
  + '未经历史样本校准，不是概率、更不代表胜率。';

/* 扫单分值的校准状态。
 * 上面的分值是固定系数拼出来的，系数本身没有经过历史样本拟合，所以 0.62 / 0.45 这两个
 * 分档阈值也只是「相对强弱」的切分，不代表「倾向高 = 62% 会扫」。
 * 因此：calibrated 为 false 时，界面一律走 sweepTendency 的高 / 中 / 低，
 * 任何地方都不许把这个分值渲染成百分比。等样本外验证（回放 / 实盘累计）凑够
 * minSample 笔扫单样本、统计出每个档位实际被扫中的频率后，才允许切成概率显示。 */
const SWEEP_CALIB = { calibrated: false, sample: 0, minSample: 200, byLevel: null };
/* 唯一的扫单对外展示入口：未校准 → 只给档位；已校准 → 才给百分比。 */
function sweepLabel(score) {
  const t = sweepTendency(score);
  const c = SWEEP_CALIB;
  if (c.calibrated && c.sample >= c.minSample && c.byLevel && c.byLevel[t.level] != null) {
    return Object.assign({}, t, { txt: Math.round(c.byLevel[t.level] * 100) + '%', calib: true });
  }
  return Object.assign({}, t, { calib: false });
}

function fuseSignal(symId, tfKey, bars) {
  const st = structFeat(bars), mc = macdFeat(bars), ob = obvFeat(bars), bl = bollFeat(bars), kd = kdjFeat(bars);
  const heat = (S.heats[symId] || {})[tfKey] || null;
  const q = S.quotes[symId] || {};
  let L = null;
  if (heat) L = liqSignal(bars, heat, {
    funding: q.funding, ls: heat.lsInfo ? heat.lsInfo.ls : null, dp: SYMS[symId].dp,
  });

  /* 技术五因子决定方向。注意分母只取这五项之和 —— 若把清算因子并进同一个加权平均，
   * 清算数据一出现就把分母从 78 撑到 112，等于把每个技术因子都稀释掉 30%，
   * 「加了张热力图，技术面凭空变弱」是不合理的。 */
  const f = [];
  // 注意：isFinite(null) === true，必须显式排除 null，否则缺失因子会被当作 0 分计入分母、稀释其余因子
  const push = (k, w, v, name) => { if (v != null && isFinite(v)) f.push({ k, w, s: clamp(v, -1, 1), name }); };
  push('st', FUSE_W.st, st.s, '结构');
  push('macd', FUSE_W.macd, mc.s, 'MACD');
  push('obv', FUSE_W.obv, ob.s, 'OBV');
  push('boll', FUSE_W.boll, bl.s, 'BOLL');
  push('kdj', FUSE_W.kdj, kd.s, 'KDJ');

  const tw = f.reduce((a, x) => a + x.w, 0) || 1;
  const contrib = f.map(x => ({ k: x.k, name: x.name, s: x.s, w: x.w, c: x.w * x.s / tw * 100 }));
  const base = contrib.reduce((a, x) => a + x.c, 0);          // 技术面基准分 [-100,100]
  const techS = clamp(base / 100, -1, 1);

  /* 清算流动性只做「路径修正」，不参与定方向：
   * 与技术面同向 → 放大至多 32%；反向 → 削弱至多 32%。
   * 这是乘性修正，永远改不了 base 的符号 —— 所以「一张清算热力图定方向」在结构上不可能。
   * 另注：除 CoinGlass / AiCoin 真实清算记录外，这里的「清算带」来自潜在清算区模型
   * （成交量 + 杠杆假设），是模型认为可能有流动性的价格带，不是真实未平仓强平价。 */
  const liqS = L ? clamp(L.score / 100, -1, 1) : null;
  let liqAdj = 0;
  if (liqS != null) liqAdj = (liqS * techS >= 0 ? 1 : -1) * 0.32 * Math.abs(liqS);
  const raw = clamp(base * (1 + liqAdj), -100, 100);
  if (liqS != null) contrib.push({
    k: 'liq', name: '清算流动性', s: liqS, w: FUSE_W.liq,
    c: base * liqAdj, mod: true,
  });

  // 一致性：只有明确表态（|s|>0.15）的因子参与，避免一堆 0 把置信度刷高
  const act = (liqS != null ? f.concat([{ k: 'liq', s: liqS }]) : f).filter(x => Math.abs(x.s) > 0.15);
  const agree = act.filter(x => (x.s > 0) === (raw > 0));
  const conf = act.length ? agree.length / act.length : 0;      // 原始一致度（占比口径，保留展示）

  /* 独立口径一致度：先把表态因子按同源组折算成「有效独立证据数」再算占比。
   * 结构 / MACD / BOLL / KDJ 四个同向 → 折算后只有 1.42 份证据，不是 4 份。
   * 于是「四个价格指标同向、量能与流动性都反着」时，原始一致度是 80%，
   * 独立口径只有 1.42/(1.42+1) ≈ 59% —— 同源的多数票不再能压过不同源的反对票。 */
  const nEffAll = fuseIndep(act);
  const nEff = fuseIndep(agree);
  const confInd = nEffAll > 0 ? nEff / nEffAll : 0;

  /* 加成还要看「独立证据的深度」：只有价格同源四因子同向（≈1.42 份）、
   * 没有量能或流动性佐证时拿不到满额加成（1.42/2.2 ≈ 0.65 折）。
   * 这是同源折减真正起作用的地方 —— 光堆同源指标，合成分涨不上去。 */
  const indepDepth = clamp(nEff / FUSE_INDEP_FULL, 0, 1);
  const confMult = 0.6 + 0.4 * confInd * indepDepth;
  let sc = clamp(raw * confMult, -100, 100);
  let dir = sc > 15 ? 'long' : sc < -15 ? 'short' : 'wait';
  let weak = false;
  /* 证据门槛也换成独立口径：只有 1~2 个价格同源因子表态（≤1.30 份）不给方向。
   * 之前是「表态因子 ≥2 个」，等于承认「MACD + KDJ 同向」算两份证据 —— 那是同一份数据。 */
  if (nEffAll < FUSE_MIN_INDEP && dir !== 'wait') { dir = 'wait'; weak = true; }

  const wd = (v, n) => (v > 0.15 ? '偏多' : v < -0.15 ? '偏空' : '中性') + `(${fmt(v * 100, 0)})`;
  const reasons = [
    `技术面基准 ${Math.round(base)}（因子一致度 ${Math.round(conf * 100)}% → 独立口径 ${Math.round(confInd * 100)}%，`
      + `有效独立证据 ${fmt(nEff, 2)}/${act.length} 份，非胜率）· `
      + contrib.filter(x => x.k !== 'liq').map(x => `${x.name} ${wd(x.s)}`).join(' · ') +
      (liqS != null
        ? `；清算流动性 ${wd(liqS)}${liqAdj < 0 ? '（与技术面反向，合成分下调 ' : '（与技术面同向，合成分上调 '}${Math.abs(liqAdj * 100).toFixed(0)}%）`
        : '；无清算数据，方向完全由技术面给出'),
    ...(L ? L.reasons : []),
  ];
  return {
    dir, score: sc, strength: Math.abs(sc), raw, conf, confInd, nEff, nEffAll, confMult, indepDepth,
    weak, base, techS, liqS, liqAdj,
    liq: L, heat, st, mc, ob, bl, kd, contrib, factors: f, reasons,
    px: bars[bars.length - 1].c,
    hasHeat: !!heat, grade: heat ? heat.grade : 'none', src: heat ? heat.label : '无清算数据',
  };
}

/* ============================ 做市商视角结论 ============================ */
/* 做市商/主力的核心约束：大单需要对手盘。清算带是全市场最密集的被动挂单池，
 * 所以「流动性在哪，价格就倾向于被推到哪」。但他们不会硬顶着结构推 ——
 * 结构反向时会先做一次「扫单（liquidity sweep / Judas）」拿够流动性再掉头。
 * 因此结论分三种：
 *   follow  = 流动性与结构同向 → 顺势；
 *   sweep   = 流动性在一侧、结构动能在另一侧 → 大概率先扫流动性再反转，逆势单要等收回；
 *   stand   = 挤压 / 因子互相矛盾 → 观望。                                                  */
function mmView(symId, tfKey, bars, F0) {
  const F = F0 || fuseSignal(symId, tfKey, bars);
  const { liq: L, st, mc, ob, bl, kd } = F;
  const px = F.px, dp = SYMS[symId].dp;
  const a = st.atr || (L && L.atr) || px * 0.004;

  // 流动性天平：清算带强度 / 距离，越大越「近而厚」
  const pullUp = L && L.magUp ? L.magUp.v / (0.35 + L.magUp.d) : 0;
  const pullDn = L && L.magDn ? L.magDn.v / (0.35 + L.magDn.d) : 0;
  const liqSide = !L ? null : pullUp > pullDn * 1.12 ? 'up' : pullDn > pullUp * 1.12 ? 'down' : 'even';

  // 技术侧方向：结构 / 动能 / 量能（MACD、KDJ 同为动能口径；不含 BOLL —— 它是波动率口径，
  // 也不含清算，避免把流动性重复计一次）。分母由权重表算出，加因子时不用改死数字。
  const techW = FUSE_W.st + FUSE_W.macd + FUSE_W.obv + FUSE_W.kdj;
  const tech = clamp((st.s * FUSE_W.st + mc.s * FUSE_W.macd + ob.s * FUSE_W.obv + kd.s * FUSE_W.kdj) / techW, -1, 1);
  const techSide = tech > 0.12 ? 'up' : tech < -0.12 ? 'down' : 'flat';

  let mode = 'stand';
  if (liqSide && liqSide !== 'even' && techSide !== 'flat') {
    mode = (liqSide === techSide) ? 'follow' : 'sweep';
  } else if (liqSide && liqSide !== 'even') {
    mode = Math.abs(tech) < 0.08 ? 'follow' : 'sweep';
  } else if (techSide !== 'flat') {
    mode = 'follow';
  }
  if (bl.squeeze && Math.abs(F.score) < 22) mode = 'stand';

  // 做市商最终偏向：扫单情形下，方向取「扫完之后要去的方向」= 技术侧，而不是清算侧
  let bias = F.dir;
  if (mode === 'sweep') bias = tech > 0 ? 'long' : 'short';
  else if (mode === 'follow') bias = F.score > 8 ? 'long' : F.score < -8 ? 'short' : 'wait';
  else bias = 'wait';

  /* ---- 价格带区间：把「哪个价」精确到「哪一段价」 ----
   * 做市商扫的不是一根针，是一整片止损。上面算出的 sweep.p 只是带中心，
   * 真正要挂单、要防假突破都必须知道 lo/hi，否则「差 0.2% 没扫到」无法判断。 */
  const Z = F.heat ? liqZones(F.heat, px, a) : [];
  /* 跨越现价的带不构成「磁吸目标」—— 价格已经在带里面了，那不是要去的地方。
   * 上方带按由近及远排，下方带同样由近及远（mid 降序）。 */
  const zUp = Z.filter(z => z.lo > px).sort((x, y) => x.mid - y.mid).slice(0, 2);
  const zDn = Z.filter(z => z.hi < px).sort((x, y) => y.mid - x.mid).slice(0, 2);
  /* 价格已经贴着的那条带不能当目标 / 失效位。近价兜底会补出紧贴现价的带，
   * 直接用最近的一条会出现「失效区间和挂单区间重叠」—— 回踩挂单和逻辑失效成了同一件事。
   * 目标带：整条带必须在现价 0.5 ATR 之外；
   * 失效带：必须整体位于挂单区的远端之外（做多时 hi < px-0.9ATR，做空时 lo > px+0.9ATR）。 */
  const edgeGap = z => (z.lo > px ? z.lo - px : px - z.hi);
  const pickTarget = arr => arr.find(z => edgeGap(z) >= a * 0.5) || arr[0] || null;
  const pickFail = arr => arr.find(z => (bias === 'long' ? z.hi < px - a * 0.9 : z.lo > px + a * 0.9))
    || arr[arr.length - 1] || null;
  const zoneOf = m => {                       // 把 magUp/magDn 单点匹配回带
    if (!m || !Z.length) return null;
    let best = null;
    for (const z of Z) { const dd = Math.abs(z.mid - m.p); if (!best || dd < best.d) best = { z, d: dd }; }
    return best && best.d <= Math.max(zSpan(best.z), a) ? best.z : null;
  };
  function zSpan(z) { return (z.hi - z.lo) * 0.75; }

  // 扫单目标位：与最终偏向相反那一侧的清算带（先扫掉它）
  let sweep = null;
  if (mode === 'sweep') {
    const wantUp = bias === 'short';            // 最终做空 → 先向上扫空单止损
    const m = wantUp ? (L && L.magUp) : (L && L.magDn);
    const z = zoneOf(m) || (wantUp ? zUp[0] : zDn[0]) || null;
    const ref = z || m;
    if (ref) {
      const p = z ? z.mid : m.p;
      const dist = Math.abs(p / px - 1) * 100;
      // 越近、越强、技术面越坚决 → 扫单倾向评分越高。
      // 注意：这只是模型的相对评分（无历史样本校准，0.30~0.92 的上下限也只是为了排序时不至于
      // 出现极端值），界面只展示成 高/中/低 三档，不显示百分比 —— 免得被读成
      // 「十次有八次会扫」的胜率。字段名也刻意不叫 prob，避免以后被直接当概率渲染。
      const v = z ? Math.max(z.v, z.mass) : m.v;
      const score = clamp(0.32 + v * 0.34 + (1 - clamp(dist / 3, 0, 1)) * 0.2 + Math.abs(tech) * 0.16, 0.3, 0.92);
      sweep = {
        side: wantUp ? 'up' : 'down', p, v, dpct: dist, score, tendency: sweepTendency(score),
        lo: z ? z.lo : p - a * 0.25, hi: z ? z.hi : p + a * 0.25,
        atrW: z ? z.atrW : 0.5, mass: z ? z.mass : v, zone: z,
      };
    }
  }

  /* 三个操作价格带（做市商视角的核心输出）：
   *   sweepBand   先被扫掉的那一侧（只有 sweep 模式有）
   *   targetBand  顺着最终偏向，价格要去的下一个流动性区
   *   failBand    反方向的带被击穿 = 这套逻辑失效
   *   entryBand   现在可以挂单的区间（现价顺方向一侧的 0.35~0.9 ATR） */
  const mkBand = (kind, z, why) => z ? {
    kind, lo: z.lo, hi: z.hi, mid: z.mid, v: z.v, mass: z.mass,
    atrW: z.atrW, dpct: z.dpct, side: z.side, why,
  } : null;
  const mkRaw = (kind, lo, hi, side, why, extra) => Object.assign({
    kind, lo: Math.min(lo, hi), hi: Math.max(lo, hi), mid: (lo + hi) / 2,
    side, why, v: 0, mass: 0, dpct: (((lo + hi) / 2) / px - 1) * 100,
    atrW: a > 0 ? Math.abs(hi - lo) / a : 0,
  }, extra || {});
  let targetBand = null, failBand = null, entryBand = null;
  if (bias === 'long') {
    targetBand = mkBand('target', pickTarget(zUp), '上方空单止损带被吃穿后的延续目标');
    failBand = mkBand('fail', pickFail(zDn), '下方多单清算带被击穿，多头结构失效');
    entryBand = mkRaw('entry', px - a * 0.9, px - a * 0.15, 'down', '回踩不破的挂单区');
  } else if (bias === 'short') {
    targetBand = mkBand('target', pickTarget(zDn), '下方多单止损带被吃穿后的延续目标');
    failBand = mkBand('fail', pickFail(zUp), '上方空单清算带被击穿，空头结构失效');
    entryBand = mkRaw('entry', px + a * 0.15, px + a * 0.9, 'up', '反抽不过的挂单区');
  }

  /* 扫单模式下 sweep 带和 fail 带常常是同一条（先向下扫 = 跌破下方带即失效）。
   * 二者必须区分开：扫到带内是剧本的一部分，只有「穿出带的远端且不收回」才算失效。 */
  if (sweep && failBand && Math.abs(failBand.mid - sweep.p) < Math.max(1e-9, a * 0.01)) {
    const ext = Math.max(a * 0.5, (sweep.hi - sweep.lo) * 0.15);
    failBand = sweep.side === 'down'
      ? mkRaw('fail', sweep.lo - ext, sweep.lo, 'down', `扫到 ${fmt(sweep.lo, dp)} 是剧本内；跌穿 ${fmt(sweep.lo - ext, dp)} 不收回才失效`, { v: sweep.v, mass: sweep.mass })
      : mkRaw('fail', sweep.hi, sweep.hi + ext, 'up', `扫到 ${fmt(sweep.hi, dp)} 是剧本内；涨穿 ${fmt(sweep.hi + ext, dp)} 不收回才失效`, { v: sweep.v, mass: sweep.mass });
  }
  /* bands 里每条都统一成带符号的 dpct（相对现价）。
   * 注意不能直接 Object.assign(..., sweep) —— 它自带的 dpct 是距离绝对值（无符号），
   * 会把下面算好的带符号值覆盖掉，导致「下方带」显示成 +0.98%。 */
  const sgn = p => (p / px - 1) * 100;
  const bands = [
    sweep ? {
      kind: 'sweep', lo: sweep.lo, hi: sweep.hi, mid: sweep.p, v: sweep.v, mass: sweep.mass,
      atrW: sweep.atrW, dpct: sgn(sweep.p), side: sweep.side, score: sweep.score,
      tendency: sweepTendency(sweep.score),
      why: `先扫${sweep.side === 'up' ? '上方空单' : '下方多单'}止损拿对手盘，再掉头${bias === 'long' ? '做多' : '做空'}（扫单倾向 ${sweepTendency(sweep.score).txt}）`,
    } : null,
    targetBand, failBand, entryBand,
  ].filter(Boolean);

  // 陷阱提示：价格贴近某侧清算带 + OBV 背离 → 大概率假突破
  let trap = null;
  if (L && L.magUp && Math.abs(L.magUp.p / px - 1) * 100 < 0.6 && ob.bear) trap = { side: 'up', why: '价格贴近上方空单清算带，但 OBV 顶背离，上破缺乏量能承接' };
  if (L && L.magDn && Math.abs(L.magDn.p / px - 1) * 100 < 0.6 && ob.bull) trap = { side: 'down', why: '价格贴近下方多单清算带，但 OBV 底背离，下破缺乏量能承接' };

  const rs = [];
  const zTxt = z => `${fmt(z.lo, dp)} – ${fmt(z.hi, dp)}（强度 ${Math.round(z.v * 100)}%，宽 ${fmt(z.atrW, 1)} ATR，${z.dpct >= 0 ? '+' : ''}${fmt(z.dpct, 2)}%）`;
  rs.push(L
    ? `流动性：上方 ${fmt(L.upPct, 1)}% 空单清算 / 下方 ${fmt(L.dnPct, 1)}% 多单清算`
      + (zUp[0] ? `；上方清算带 ${zTxt(zUp[0])}` : '')
      + (zDn[0] ? `；下方清算带 ${zTxt(zDn[0])}` : '')
    : '流动性：本周期无清算数据，方向由结构 / 动能 / 量能决定');
  rs.push(`结构：${st.trend === 'up' ? 'HH/HL 上升' : st.trend === 'down' ? 'LH/LL 下降' : st.trend === 'expand' ? '高低点扩张（无序）' : st.trend === 'contract' ? '高低点收敛（蓄势）' : '区间震荡'}${st.bos ? ` · 已${st.bos === 'up' ? '上破' : '下破'}最近摆动${st.bos === 'up' ? '高' : '低'}点` : ''}${st.choch ? ` · CHoCH 转${st.choch === 'bull' ? '多' : '空'}` : ''}`);
  rs.push(`动能：MACD 柱 ${fmt(mc.hist, dp)}${mc.cross ? ` · ${mc.cross > 0 ? '近 5 根金叉' : '近 5 根死叉'}` : ''} · ${mc.above0 > 0 ? '零轴上方' : mc.above0 < 0 ? '零轴下方' : '零轴附近'}`);
  rs.push(`量能：OBV ${ob.slope >= 0 ? '走高' : '走低'}${ob.bear ? ' · 顶背离（拉抬无量）' : ''}${ob.bull ? ' · 底背离（抛压衰竭）' : ''}`);
  rs.push(`波动：BOLL %B ${fmt(bl.pb * 100, 0)}% · 带宽分位 ${Math.round(bl.rank * 100)}%${bl.squeeze ? '（挤压，方向未定）' : ''}`);

  return {
    mode, bias, sweep, trap, tech, liqSide, techSide,
    pullUp, pullDn, F, px, reasons: rs,
    zones: Z, zUp, zDn, bands,
    targetBand, failBand, entryBand, atr: a,
    conf: Math.round(F.conf * 100),
    confInd: Math.round(F.confInd * 100), nEff: F.nEff, nEffAll: F.nEffAll,
  };
}

