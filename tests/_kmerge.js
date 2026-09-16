/* K 线序列合并回归测试。
 *
 * 背景：loadKlines 旧实现只改最后一根的 c/h/l —— 不追加新时间戳、不更新成交量、
 * 最高最低拿「旧值 vs 新收盘价」凑。MACD / OBV / KDJ / ATR 全在一条停止生长的序列上算。
 * 这里用受控样本逐条钉死正确行为。
 *
 * 只切 KBAR-MERGE 标记之间的纯函数，不加载 DOM。 */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const A = src.indexOf('/* ===== KBAR-MERGE-START ===== */');
const B = src.indexOf('/* ===== KBAR-MERGE-END ===== */');
if (A < 0 || B < 0) throw new Error('未找到 KBAR-MERGE 标记，app.js 结构已变');
const m = {};
new Function('module', 'exports', src.slice(A, B) + '\n;module.exports={mergeBars,aggBars,klineGaps};')(m, {});
const { mergeBars, aggBars, klineGaps } = m.exports;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => {
  c ? (pass++, console.log('  ✓ ' + msg))
    : (fail++, console.log('  ✗ ' + msg + (extra !== '' ? '  → ' + extra : '')));
};
const H = t => console.log('\n' + t);

const HOUR = 3600000;
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
const ts = a => a.map(b => b.t);

H('[1] 用户复现样本：跨周期后应追加新 K 线');
{
  // 第一次加载：1 根（第 1 小时），收 100、量 100
  const old = [bar(HOUR, 100, 110, 90, 100, 100)];
  // 第二次加载：第 1 小时已走完（真实高 140、量 500），并出现第 2 小时
  const fresh = [bar(HOUR, 100, 140, 80, 120, 500), bar(2 * HOUR, 120, 130, 115, 125, 300)];
  const r = mergeBars(old, fresh, 0);
  ok(r.length === 2, '跨小时后 K 线数量 = 2 根', r.length);
  ok(r[r.length - 1].t === 2 * HOUR, '最后一根时间是新小时', r[r.length - 1].t === 2 * HOUR ? 'ok' : '旧小时');
  ok(r[0].v === 500, '同根成交量更新为 500（旧实现恒为 100）', r[0].v);
  ok(r[0].h === 140, '同根最高价取接口真实值 140（旧实现被压成 120）', r[0].h);
  ok(r[0].l === 80, '同根最低价取接口真实值 80', r[0].l);
  ok(r[0].c === 120, '同根收盘价更新为 120', r[0].c);
  ok(r[1].v === 300, '新根成交量正确带入', r[1].v);
}

H('[2] 不修改入参（旧实现原地 mutate，调用方拿不到「有没有新增」）');
{
  const old = [bar(HOUR, 100, 110, 90, 100, 100)];
  const fresh = [bar(HOUR, 100, 140, 80, 120, 500)];
  const snapOld = JSON.stringify(old), snapNew = JSON.stringify(fresh);
  const r = mergeBars(old, fresh, 0);
  ok(JSON.stringify(old) === snapOld, 'oldBars 未被修改', JSON.stringify(old));
  ok(JSON.stringify(fresh) === snapNew, 'newBars 未被修改');
  ok(r !== old && r !== fresh, '返回的是新数组');
}

H('[3] 断线后补齐缺失区间');
{
  // 缓存停在 t=3；断线期间 4、5 两根没拉到，重连后接口一次给到 3..7
  const old = [1, 2, 3].map(h => bar(h * HOUR, 100, 105, 95, 100, 10));
  const fresh = [3, 4, 5, 6, 7].map(h => bar(h * HOUR, 100, 105, 95, 100, 10));
  const r = mergeBars(old, fresh, 0);
  ok(r.length === 7, '缺失的第 4、5 根被补齐，共 7 根', r.length);
  ok(JSON.stringify(ts(r)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7].map(h => h * HOUR)), '时间戳连续无空洞');
}

H('[4] 乱序输入也能排好序');
{
  const old = [bar(3 * HOUR, 1, 1, 1, 1, 1), bar(HOUR, 1, 1, 1, 1, 1)];
  const fresh = [bar(2 * HOUR, 1, 1, 1, 1, 1)];
  const r = mergeBars(old, fresh, 0);
  ok(JSON.stringify(ts(r)) === JSON.stringify([1, 2, 3].map(h => h * HOUR)), '结果按时间升序', JSON.stringify(ts(r)));
}

H('[5] cap 裁剪保留最新');
{
  const old = [1, 2, 3, 4, 5].map(h => bar(h * HOUR, 1, 1, 1, 1, 1));
  const r = mergeBars(old, [], 3);
  ok(r.length === 3, '裁剪到 cap=3', r.length);
  ok(ts(r).join() === [3, 4, 5].map(h => h * HOUR).join(), '保留的是最新的 3 根');
}

H('[6] 重复时间戳去重');
{
  const old = [bar(HOUR, 1, 1, 1, 1, 1), bar(HOUR, 1, 1, 1, 1, 1)];
  const r = mergeBars(old, [], 0);
  ok(r.length === 1, '同一时间戳只保留一根', r.length);
}

H('[7] 非法输入容错');
{
  ok(mergeBars(null, null, 0).length === 0, '全 null 返回空数组');
  ok(mergeBars(undefined, [{ t: NaN, o: 1 }], 0).length === 0, 't 为 NaN 的 bar 被丢弃');
  ok(mergeBars([{ t: HOUR, o: 1 }], [null, undefined], 0).length === 1, 'null/undefined 项被跳过');
  ok(mergeBars([bar(HOUR, 1, 1, 1, 1, 1)], [], -1).length === 1, 'cap<=0 视为不裁剪');
}

H('[8] 新数据只覆盖尾部窗口时，更老的历史不丢');
{
  // 缓存 240 根，接口只回最后 60 根窗口 → 前 180 根必须原样保留
  const old = Array.from({ length: 240 }, (_, i) => bar((i + 1) * HOUR, 1, 2, 0.5, 1.5, i));
  const fresh = Array.from({ length: 60 }, (_, i) => bar((181 + i) * HOUR, 9, 9, 9, 9, 999));
  const r = mergeBars(old, fresh, 0);
  ok(r.length === 240, '总数仍为 240', r.length);
  ok(r[0].t === HOUR && r[0].v === 0, '最老一根未被抹掉');
  ok(r[179].v === 179 && r[179].c === 1.5, '窗口之前的第 180 根保持原值（未被替换成 9）', r[179].v);
  ok(r[239].v === 999, '窗口内被正确更新', r[239].v);
}

H('[9] 连续刷新时序列持续增长（旧实现长度冻结）');
{
  let cache = [];
  const lens = [];
  for (let k = 0; k < 4; k++) {
    const fresh = [k + 1, k + 2, k + 3].map(h => bar(h * HOUR, 1, 1, 1, 1, 1));
    cache = mergeBars(cache, fresh, 0);
    lens.push(cache.length);
  }
  ok(lens[0] === 3, '第 1 次：3 根', lens[0]);
  ok(lens[1] === 4, '第 2 次：新增 1 根 → 4 根', lens[1]);
  ok(lens[2] === 5, '第 3 次：5 根', lens[2]);
  ok(lens[3] === 6, '第 4 次：6 根', lens[3]);
  const inc = ts(cache);
  ok(inc.every((t, i) => i === 0 || t > inc[i - 1]), '时间戳严格递增无重复');
}

H('[10] aggBars：按时间桶聚合，窗口滑动不产生错位');
{
  const step = 4 * HOUR;
  // 窗口 A：0~7 点，共 8 根 1h
  const winA = Array.from({ length: 8 }, (_, i) => bar(i * HOUR, 10 + i, 11 + i, 9 + i, 10.5 + i, 1));
  const a = aggBars(winA, step, 4);
  ok(a.length === 2, '8 根 1h → 2 根 4h', a.length);
  ok(a[0].t === 0 && a[1].t === 4 * HOUR, '桶起点落在 4h 网格上', JSON.stringify(ts(a)));
  // 桶内 i=0..3：o=10, h=max(11..14)=14, l=min(9..12)=9, c=末根 13.5, v=4
  ok(a[0].o === 10 && a[0].c === 13.5 && a[0].h === 14 && a[0].l === 9 && a[0].v === 4,
    'OHLCV 聚合正确', JSON.stringify(a[0]));

  // 窗口 B 整体偏移 2 小时（2~9 点）：按时间桶仍应落在同一批桶起点上
  const winB = Array.from({ length: 8 }, (_, i) => bar((i + 2) * HOUR, 20 + i, 21 + i, 19 + i, 20.5 + i, 1));
  const b = aggBars(winB, step, 4);
  const merged = mergeBars(a, b, 0);
  const uniq = new Set(ts(merged));
  ok(uniq.size === merged.length, '两个错位窗口合并后无重复时间戳（下标分组会在这里爆）', merged.length + ' vs ' + uniq.size);
  ok(ts(merged).every(t => t % step === 0), '合并后所有桶仍在 4h 网格上');
}

H('[11] aggBars：丢弃残缺桶，只放行正在形成的最后一根');
{
  const step = 4 * HOUR;
  // 只有 0、1、2 三个小时 —— 桶 0 只凑到 3 根，不足 4
  const g = aggBars([0, 1, 2].map(h => bar(h * HOUR, 1, 1, 1, 1, 1)), step, 4);
  ok(g.length === 1, '不足 4 根的首个桶被丢弃', g.length);
  ok(g[0].t === 0, '正在形成的最后一根保留，桶起点为 0');

  // 0~5 点：桶 0 完整（4 根）保留，桶 1 只有 2 根但是最后一根 → 保留
  const g2 = aggBars(Array.from({ length: 6 }, (_, i) => bar(i * HOUR, 1, 1, 1, 1, 1)), step, 4);
  ok(g2.length === 2, '完整桶 + 正在形成的桶 = 2 根', g2.length);
  ok(g2[0].t === 0 && g2[1].t === 4 * HOUR, '桶起点正确', JSON.stringify(ts(g2)));
}

H('[12] klineGaps：时间序列空洞检测');
{
  const seq = n => Array.from({ length: n }, (_, i) => bar(i * HOUR, 1, 1, 1, 1, 1));
  const g0 = klineGaps(seq(10), HOUR);
  ok(g0.ok && g0.gaps.length === 0, '连续序列无空洞');

  // 中间挖掉 3 根（索引 3、4、5）
  const holed = seq(10).filter((_, i) => i < 3 || i > 5);
  const g1 = klineGaps(holed, HOUR);
  ok(!g1.ok && g1.gaps.length === 1, '挖掉 3 根 → 检出 1 段空洞', g1.gaps.length);
  ok(g1.gaps[0].missing === 3, '缺失根数 = 3', JSON.stringify(g1.gaps[0]));
  ok(g1.maxGapMs === 4 * HOUR, '最大间隔 = 4 小时', g1.maxGapMs / HOUR);

  // 只缺 1 根：间隔 2h = step×2 > step×1.5 → 仍然报警（不允许静默吞掉）
  const one = seq(10).filter((_, i) => i !== 4);
  ok(klineGaps(one, HOUR).gaps.length === 1, '缺 1 根也要报警');

  // 容差：同间隔抖动（市场偶发延迟的那几秒）不应误报
  ok(klineGaps(seq(5).map(b => Object.assign({}, b, { t: b.t + 1000 })), HOUR).ok, '秒级抖动不误报');

  // 输入异常
  ok(klineGaps([], HOUR).ok && klineGaps(seq(1), HOUR).ok, '空序列 / 单根不算空洞');
  ok(klineGaps(seq(5), 0).ok, 'stepMs 非法时保守返回无空洞');
  // 乱序输入也要能检出
  const shuffled = [seq(10)[0], seq(10)[9], seq(10)[1]];
  ok(!klineGaps(shuffled, HOUR).ok, '乱序输入仍能检出空洞');
}

H('[13] 源码守卫：旧的原地改写法必须已消失');
{
  ok(!/b\.c = last\.c/.test(src), '不再有「只改最后一根收盘价」的写法');
  ok(/cached\.bars = mergeBars\(/.test(src), 'loadKlines 走 mergeBars 合并');
  ok(!/for \(let i = 0; i < bars\.length; i \+= tf\.agg\)/.test(src), 'Yahoo 4h 不再按数组下标分组');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
