/* test-volprofile.js — volprofile.js 单元测试
   重点测三件事：
     1) 成交量守恒（摊分不能凭空造量或丢量）
     2) 稀疏度基线不被巨墙抬高（band-proto 踩过的坑）
     3) ★ 窗口严格不含未来数据（回放的生命线）                       */
'use strict';
const V = require('./volprofile.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, e, m) => ok(Math.abs(a - b) <= (e || 1e-9), m + ' (得到 ' + a + ' 期望 ' + b + ')');
const sec = m => console.log('\n── ' + m + ' ──');

const mk = rows => {
  const n = rows.length;
  const s = { n: n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  rows.forEach((r, i) => { s.t[i] = r[0]; s.o[i] = r[1]; s.h[i] = r[2]; s.l[i] = r[3]; s.c[i] = r[4]; s.v[i] = r[5]; });
  return s;
};

sec('1. buildProfile — 成交量守恒与区间');
{
  /* 3 根 K 线，视野 [10,20]，每根 100 量 */
  const s = mk([[0, 10, 12, 10, 12, 100], [60, 12, 15, 12, 15, 100], [120, 15, 20, 15, 20, 100]]);
  const p = V.buildProfile(s, 0, 3, 10);
  ok(p !== null, '正常区间应返回 profile');
  let sum = 0; for (let i = 0; i < 10; i++) sum += p.vol[i];
  near(sum, 300, 1e-6, '总成交量守恒');
  ok(p.bins === 10, '格数');
  ok(p.nbars === 3, '根数');
  near(p.step, 1, 1e-6, '格宽 = (20-10)/10');

  /* 单根跨越全部格 → 每格均等 */
  const s2 = mk([[0, 10, 20, 10, 20, 100]]);
  const p2 = V.buildProfile(s2, 0, 1, 10);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < 10; i++) { mn = Math.min(mn, p2.vol[i]); mx = Math.max(mx, p2.vol[i]); }
  near(mn, 10, 1e-6, '单根全覆盖时每格 10');
  near(mx, 10, 1e-6, '单根全覆盖时每格相等');

  /* 一根 K 线的跨度只占一格 → 该格吃下全部量，没成交过的格子为 0。
     视野由另一根远处的 K 线撑开（否则视野 = 这根的高低，必然铺满）。 */
  const s3 = mk([[0, 10, 10.5, 10, 10.5, 50], [60, 15, 20, 15, 20, 10]]);
  const p3 = V.buildProfile(s3, 0, 2, 10);            // 视野 [10,20]，格宽 1
  near(p3.vol[0], 50, 1e-6, '只占一格 → 该格吃下全部量');
  near(p3.vol[3], 0, 1e-12, '没成交过的格子为 0');

  /* 退化：high == low */
  const s4 = mk([[0, 10, 10, 10, 10, 10], [60, 10, 10, 10, 10, 10]]);
  ok(V.buildProfile(s4, 0, 2, 10) === null, 'high==low 应返回 null');

  /* 区间太短 */
  ok(V.buildProfile(s, 0, 1, 10) !== null, '单根也允许');
  ok(V.buildProfile(s, 0, 0, 10) === null, '空区间返回 null');

  /* 索引越界要夹住 */
  const p5 = V.buildProfile(s, -5, 999, 10);
  ok(p5 !== null && p5.nbars === 3, '越界索引被夹到 [0,n]');
}

sec('2. pocOf / valueArea');
{
  const a = new Float64Array([1, 5, 2, 9, 3]);
  ok(V.pocOf(a) === 3, 'POC = 最大值所在格');

  /* 全同 → 任取其一，不崩 */
  const b = new Float64Array(5).fill(7);
  ok(V.pocOf(b) >= 0, '全同数组不崩');

  /* target=1.0 必须扩张到覆盖全部格 */
  const c = new Float64Array([1, 2, 3, 4, 5]);
  const va = V.valueArea(c, 1.0);
  ok(va.lo === 0 && va.hi === 4, 'target=100% → 覆盖全部格');
  near(va.share, 1.0, 1e-9, 'share = 1');

  /* 单调性：target 越大，区间越宽 */
  let prevW = -1;
  for (const t of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    const v = V.valueArea(c, t);
    const w = v.hi - v.lo + 1;
    ok(w >= prevW, 'target 增大区间不缩窄 (t=' + t + ')');
    prevW = w;
  }

  /* 全部为 0 */
  ok(V.valueArea(new Float64Array(5), 0.7) === null, '总量为 0 返回 null');

  /* 单格数组不越界 */
  const d = new Float64Array([5]);
  const vd = V.valueArea(d, 0.7);
  ok(vd && vd.lo === 0 && vd.hi === 0, '单格数组 VA 不越界');
}

sec('3. thinBand — 稀疏度与中位数基线（band-proto 的坑）');
{
  /* 常数数组：任何窗口均值都等于中位数 → sparsity = 1（没有薄带） */
  const flat = new Float64Array(20).fill(10);
  const b1 = V.thinBand(flat, 0, 19, 4);
  ok(b1 !== null, '常数数组能找到窗口');
  near(b1.sparsity, 1, 1e-9, '均匀时稀疏度 = 1（不谎报薄带）');

  /* 明确空洞：第 10~13 格为 0，其余 10 */
  const hol = new Float64Array(20).fill(10);
  for (let i = 10; i <= 13; i++) hol[i] = 0;
  const b2 = V.thinBand(hol, 0, 19, 4);
  ok(b2.lo === 10 && b2.hi === 13, '空洞定位准确 (得到 ' + b2.lo + '~' + b2.hi + ')');
  near(b2.sparsity, 0, 1e-12, '真空洞稀疏度 = 0');

  /* ★ 巨墙不抬高基线：均值会被墙拉高，中位数不会 */
  const wall = new Float64Array(20).fill(10);
  wall[2] = 100000;                                  // 一根巨墙
  const b3 = V.thinBand(wall, 0, 19, 4);
  near(b3.baseline, 10, 1e-9, '中位数基线 = 10（不被巨墙抬高）');
  /* 对照：均值基线会是 (19*10 + 100000)/20 = 5009.5 */
  let s = 0; for (let i = 0; i < 20; i++) s += wall[i];
  ok(s / 20 > 1000, '（对照）均值基线确实被抬高到 ' + (s / 20).toFixed(0));
  const b4 = V.thinBand(wall, 0, 19, 4);
  ok(b4.lo !== 2, '最薄窗口不会选在巨墙上');

  /* 区间不足 win → null */
  ok(V.thinBand(hol, 0, 2, 4) === null, '区间 < win 返回 null');
  /* 越界要夹住 */
  ok(V.thinBand(hol, -3, 999, 4) !== null, '越界索引被夹住');
}

sec('4. windowBefore — ★ 未来函数防线');
{
  /* t = 0,60,120,...,540（10 根 1 分钟） */
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([i * 60, 100, 101, 99, 100, 1]);
  const s = mk(rows);

  const w1 = V.windowBefore(s, 300, 5);              // tEnd=300 → 只能用 t<300 即 0..4
  ok(w1.to === 5, '右端点 = 第一个 t>=tEnd 的索引 (得到 ' + w1.to + ')');
  ok(s.t[w1.to - 1] < 300, '窗口最后一根严格早于 tEnd');
  ok(w1.from === 0, '左端点');

  /* 取少于可用根数 */
  const w2 = V.windowBefore(s, 600, 3);
  ok(w2.to - w2.from === 3, '窗口长度 = wBars');
  ok(s.t[w2.to - 1] < 600, '仍然严格早于 tEnd');

  /* 全表扫描：窗口内绝不能出现 t >= tEnd */
  let bad = 0;
  for (const tEnd of [1, 60, 61, 300, 301, 540, 541, 99999]) {
    const w = V.windowBefore(s, tEnd, 4);
    for (let i = w.from; i < w.to; i++) if (s.t[i] >= tEnd) bad++;
  }
  ok(bad === 0, '★ 所有 tEnd 下窗口内都没有未来数据（违例 ' + bad + ' 次）');

  /* tEnd 早于全部数据 → 空窗口 */
  const w3 = V.windowBefore(s, 0, 4);
  ok(w3.to === 0 && w3.from === 0, 'tEnd 早于全部 → 空窗口');
  /* tEnd 晚于全部 → 用到最后一根 */
  const w4 = V.windowBefore(s, 1e12, 4);
  ok(w4.to === 10, 'tEnd 晚于全部 → 用到末尾');
}

sec('5. structureAt — 特征定义');
{
  /* 构造：视野 [100,110]，中间 104~106 成交最密（POC 附近），
     上方 108~110 和下方 100~101 成交稀薄 */
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const mid = 105 + (i % 7 - 3) * 0.2;               // 大部分成交堆在 105 附近
    rows.push([i * 60, mid, mid + 0.3, mid - 0.3, mid, 10]);
  }
  /* 少量成交扫到高位和低位，撑开视野 */
  rows.push([200 * 60, 109.5, 110, 109, 110, 1]);
  rows.push([201 * 60, 100.5, 101, 100, 100, 1]);
  const s = mk(rows);
  const p = V.buildProfile(s, 0, s.n, 40);
  ok(p !== null, 'profile 构建成功');

  const f = V.structureAt(p, 105, { winPct: 0.12, vaShare: 0.70 });
  ok(f !== null, 'structureAt 返回特征');
  ok(f.pocPx > 100 && f.pocPx < 110, 'POC 落在视野内 (' + f.pocPx.toFixed(2) + ')');
  ok(f.upLo !== null && f.dnLo !== null, '上下薄带都存在');
  ok(f.upLo > 105, '上方薄带在现价之上 (' + f.upLo.toFixed(2) + ')');
  ok(f.dnHi !== null && f.dnHi < 105, '下方薄带在现价之下 (' + f.dnHi.toFixed(2) + ')');
  ok(f.upDist > 0 && f.dnDist > 0, '两个距离都为正');
  ok(f.upSp >= 0 && f.dnSp >= 0, '稀疏度非负');
  ok(Math.abs(f.thinBias - (f.dnSp - f.upSp)) < 1e-12, 'thinBias = dnSp − upSp');

  /* posVA 的语义：现价放在 VA 下沿之下应 < 0，上沿之上应 > 1 */
  const fLow = V.structureAt(p, f.vaLo - 1, {});
  const fHigh = V.structureAt(p, f.vaHi + 1, {});
  ok(fLow.posVA < 0, '现价在 VA 下方 → posVA<0 (' + fLow.posVA.toFixed(3) + ')');
  ok(fHigh.posVA > 1, '现价在 VA 上方 → posVA>1 (' + fHigh.posVA.toFixed(3) + ')');
  ok(f.posVA >= 0 && f.posVA <= 1, '现价在 VA 内 → posVA∈[0,1] (' + f.posVA.toFixed(3) + ')');

  /* dPoc 符号 */
  ok(V.structureAt(p, 108, {}).dPoc > 0, '现价高于 POC → dPoc>0');
  ok(V.structureAt(p, 102, {}).dPoc < 0, '现价低于 POC → dPoc<0');

  /* anchor='poc' 与 'price' 都要能跑，且不崩 */
  const fp = V.structureAt(p, 105, { anchor: 'poc' });
  ok(fp !== null && fp._anchor === 'poc', "anchor='poc' 生效");
  ok(V.structureAt(p, 105, { anchor: 'price' })._anchor === 'price', "默认 anchor='price'");

  /* posSpan：现价在整个窗口视野中的位置 0=最低 1=最高。
     ★ 为什么必须有它：现价贴窗口顶时「上方」不足一个薄带窗口，薄带返回 null，
       但「贴顶」= 追高，恰恰是最有信息量的事实 —— 不能因为算不出薄带就丢样本。 */
  const fTop = V.structureAt(p, p.hi, {});
  const fBot = V.structureAt(p, p.lo, {});
  ok(Math.abs(fTop.posSpan - 1) < 1e-6, '现价 = 窗口最高 → posSpan=1 (' + fTop.posSpan.toFixed(4) + ')');
  ok(Math.abs(fBot.posSpan) < 1e-6, '现价 = 窗口最低 → posSpan=0 (' + fBot.posSpan.toFixed(4) + ')');
  ok(f.posSpan >= 0 && f.posSpan <= 1, 'posSpan 恒在 [0,1]');
  /* 薄带为 null 的场合，posSpan 必须仍然有值 —— 这就是它存在的意义 */
  const narrow = V.buildProfile(s, 0, s.n, 200);     // 格子很细 → 薄带窗口要求更多格
  const fn = V.structureAt(narrow, 105, { winPct: 0.5 });
  ok(fn != null, '极细格距下 structureAt 仍返回');
  ok(fn.posSpan != null && isFinite(fn.posSpan), '★ 即使薄带算不出来，posSpan 也必须有值');

  /* 视野极窄（价格全挤一格）不会崩 */
  const s2 = mk([[0, 100, 100.01, 100, 100.01, 5], [60, 100, 100.01, 100, 100.01, 5]]);
  const p2 = V.buildProfile(s2, 0, 2, 10);
  ok(p2 !== null, '极窄视野也能建 profile');
  ok(V.structureAt(p2, 100, {}) !== null, '极窄视野 structureAt 不崩');

  /* profile 为 null 时 safe */
  ok(V.structureAt(null, 100, {}) === null, 'profile=null 安全返回');
}

sec('6. directional — 方向化符号');
{
  const f = { thinBias: 0.4, dPoc: 0.02, upDist: 0.01, dnDist: 0.03, posVA: 0.5, vaWidth: 0.02, posSpan: 0.7 };
  const L = V.directional(f, 1), Sh = V.directional(f, 2);
  ok(L.thinEdge === 0.4, '做多 thinEdge = +thinBias');
  ok(Sh.thinEdge === -0.4, '做空 thinEdge = −thinBias');
  ok(L.cheapEdge === -0.02, '做多：现价高于 POC → 便宜度为负（追高了）');
  ok(Sh.cheapEdge === 0.02, '做空：现价高于 POC → 便宜度为正');
  ok(L.roomEdge === 0.01 && L.guardEdge === 0.03, '做多 room=上方 guard=下方');
  ok(Sh.roomEdge === 0.03 && Sh.guardEdge === 0.01, '做空 room=下方 guard=上方');
  /* 低位度：做多时现价越靠窗口底部越好 */
  ok(Math.abs(L.posSpanEdge - 0.3) < 1e-12, '做多 posSpanEdge = 1−posSpan = 0.3');
  ok(Math.abs(Sh.posSpanEdge - 0.7) < 1e-12, '做空 posSpanEdge = posSpan = 0.7');

  /* null 特征要安全穿透 */
  const f2 = { thinBias: null, dPoc: 0, upDist: null, dnDist: null, posVA: 0, vaWidth: 0, posSpan: 0.5 };
  const L2 = V.directional(f2, 1);
  ok(L2.thinEdge === null && L2.roomEdge === null, 'null 特征安全穿透');
  ok(V.directional(null, 1) === null, 'null 输入返回 null');
}

console.log('\n════════ ' + (fail ? 'FAIL' : 'PASS') + ' · ' + pass + ' 通过 / ' + fail + ' 失败 ════════');
process.exit(fail ? 1 : 0);
