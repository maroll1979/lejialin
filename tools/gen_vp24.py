# -*- coding: utf-8 -*-
"""生成 AiCoin AIScript「成交量分布 VP-24」指标源码（两个版本）。

设计约束：AIScript 是逐 K 线求值的向量语言（已确认：标量序列、三元表达式、
&&/not、历史引用 x[1]、sum/cum/ma/ema/crossup/crossdown、plot/plotText/plotShape）。
未见公开的 for 循环与数组支持 → **不使用循环与数组**：
  · 24 个价格档位展开为独立标量
  · 分位查找用「累加步进」而非嵌套三元
  · 成交量按「K线区间与档位的重叠比例」摊分，避免整根重复计入
"""
import io

ROWS = 24
OUT = r'C:\Users\windos\WorkBuddy\2026-09-14-20-21-18\outputs'

L = []
def w(s=''):
    L.append(s)

def head(title, note):
    w('// @version=2')
    w('// ===================================================================')
    w('//  成交量分布 VP-24 · Volume Profile（24 档）  —— %s' % title)
    w('// -------------------------------------------------------------------')
    for n in note:
        w('//  %s' % n)
    w('// ===================================================================')
    w()

def common_after_vol(session=False):
    """v0..v23 已定义之后的公共部分"""
    w()
    w('// ---------- 自下而上累积（用于求 VAL） ----------')
    w('c0 = v0')
    for i in range(1, ROWS):
        w('c%d = c%d + v%d' % (i, i - 1, i))
    w()
    w('// ---------- 自上而下累积（用于求 VAH） ----------')
    w('d%d = v%d' % (ROWS - 1, ROWS - 1))
    for i in range(ROWS - 2, -1, -1):
        w('d%d = d%d + v%d' % (i, i + 1, i))
    w()
    w('// ---------- POC：成交量最大的那一档 ----------')
    w('m0 = v0')
    w('poc0 = P0')
    for i in range(1, ROWS):
        w('m%d = v%d > m%d ? v%d : m%d' % (i, i, i - 1, i, i - 1))
        w('poc%d = v%d > m%d ? P%d : poc%d' % (i, i, i - 1, i, i - 1))
    w('POC = poc%d' % (ROWS - 1))
    w()
    w('// ---------- 总成交量与两侧尾部阈值 ----------')
    w('total = c%d' % (ROWS - 1))
    w('T = total * (100 - VA_PCT) / 200')
    w()
    w('// ---------- VAL：自下而上累积到 15% 处 ----------')
    w('// 从区间下沿 lo 出发，累积量不足 T 就往上走一格。起点必须是 lo 而非 P0，')
    w('// 否则结果整体偏高半格。步进量先存进 s0..s22，避免写出超长表达式。')
    for i in range(ROWS - 1):
        w('s%d = c%d < T ? step : 0' % (i, i))
    w('VAL = lo + ' + ' + '.join('s%d' % i for i in range(ROWS - 1)))
    w()
    w('// ---------- VAH：自上而下累积到 15% 处 ----------')
    for i in range(1, ROWS):
        w('t%d = d%d < T ? step : 0' % (i, i))
    w('VAH = hi - ' + ' - '.join('t%d' % i for i in range(1, ROWS)))
    w()
    w('// ---------- 强制把 POC 包进价值区 ----------')
    w('// 分位数口径在分布极分散时可能把 POC 甩在价值区外，违反「价值区必含 POC」，')
    w('// 故做一次夹逼修正。')
    w('pocLo = POC - step / 2')
    w('pocHi = POC + step / 2')
    w('VAL = VAL > pocLo ? pocLo : VAL')
    w('VAH = VAH < pocHi ? pocHi : VAH')
    w()
    w('// ---------- 数据有效性 ----------')
    w('valid = total > 0 && rng > 0')
    if session:
        w('// 会话版额外要求：当日已走够 K 线，否则 08:00 刚重置时区间过窄会出假信号')
        w('valid = valid && barCount >= MIN_BARS')
    w('VAH_ = valid ? VAH : na')
    w('VAL_ = valid ? VAL : na')
    w('POC_ = valid ? POC : na')
    w()
    w('// ---------- 绘制线条 ----------')
    w("plot(VAH_, title='VAH 价值区上沿', color='red', linewidth=2)")
    w("plot(VAL_, title='VAL 价值区下沿', color='green', linewidth=2)")
    w("plot(POC_, title='POC 成交最密集价', color='orange', linewidth=1)")
    w()
    w('// ---------- 区域判定 ----------')
    w('shortZone = valid && close > VAH_    // 高于 VAH：高位低量区 → 做空区域')
    w('longZone  = valid && close < VAL_    // 低于 VAL：低位低量区 → 做多区域')
    w()
    w('// ---------- 进出场信号 ----------')
    w('enterShort = crossup(close, VAH_)     // 上穿 VAH → 进入做空区')
    w('enterLong  = crossdown(close, VAL_)   // 下穿 VAL → 进入做多区')
    w('exitShort  = crossdown(close, VAH_)   // 回落价值区 → 平空')
    w('exitLong   = crossup(close, VAL_)     // 回升价值区 → 平多')
    w()
    w('// ---------- 图表标注 ----------')
    w("plotText(enterShort, title='做空', text='做空', color='red', refSeries=high, placement='top')")
    w("plotText(enterLong, title='做多', text='做多', color='green', refSeries=low, placement='bottom')")
    w("plotText(exitShort, title='平空', text='平空', color='gray', refSeries=high, placement='top')")
    w("plotText(exitLong, title='平多', text='平多', color='gray', refSeries=low, placement='bottom')")
    w()
    w('// ---------- 预警 ----------')
    w("alertcondition(enterShort, title='价格进入 VAH 上方做空区', direction='sell')")
    w("alertcondition(enterLong, title='价格进入 VAL 下方做多区', direction='buy')")
    w("alertcondition(exitShort, title='回落价值区·平空', direction='buy')")
    w("alertcondition(exitLong, title='回升价值区·平多', direction='sell')")
    w()
    w('// ---------- 如需自动化交易，取消下面四行注释 ----------')
    w("// enterShort(enterShort, price='market', amount=1)")
    w("// exitShort(exitShort, price='market', amount=1)")
    w("// enterLong(enterLong, price='market', amount=1)")
    w("// exitLong(exitLong, price='market', amount=1)")
    w()

def gen_rolling():
    """版本A：滚动 N 根窗口。不依赖任何时间函数，最稳。"""
    del L[:]
    head('滚动窗口版（推荐先用这个验证平台）', [
        '1. 取最近 N 根 K 线的最高/最低构成价格区间，均分为 24 档',
        '2. 按「K线区间与档位的重叠比例」把成交量摊分到各档',
        '3. 中间 70% 成交量所在区间 = 价值区；上沿 VAH，下沿 VAL，最密档 POC',
        '4. 收盘 > VAH → 高位低量区 → 做空；收盘 < VAL → 低位低量区 → 做多',
        '',
        '周期与 N 的对应：1小时→24（≈一整日）；30分钟→48；15分钟→96；4小时→6',
        '本版不依赖任何时间函数，只要平台有 highest/lowest/sum/max/min 即可运行。',
    ])
    w('// ---------- 参数 ----------')
    w('N = 24        // 回溯 K 线根数')
    w('VA_PCT = 70   // 价值区包含的成交量百分比，标准值 70')
    w()
    w('// ---------- 价格区间 ----------')
    w('// 若平台不支持 highest/lowest，改用 hhv(high, N) / llv(low, N)')
    w('hi = highest(high, N)')
    w('lo = lowest(low, N)')
    w('rng = hi - lo')
    w('step = rng > 0 ? rng / 24 : 0')
    w()
    w('// ---------- 24 档价格（取每档中点） ----------')
    for i in range(ROWS):
        w('P%d = lo + (%.1f) * step' % (i, i + 0.5))
    w()
    w('// ---------- 逐档成交量：按重叠比例摊分 ----------')
    w('// 不能整根计入 —— 否则一根大阳线会把全部成交量重复算进它覆盖的每一档，')
    w('// 把分布图抹平。ov = 重叠长度，占比 = ov / (high - low)。')
    w('sp = high - low')
    for i in range(ROWS):
        w('ov%d = min(high, lo + %d * step) - max(low, lo + %d * step)' % (i, i + 1, i))
        # 一字线（high==low）时 sp=0 且 ov=0，必须改用「价格是否落在该档」判断，
        # 否则这类 K 线的成交量会被整个丢掉。整条表达式写在一行，避免跨行三元解析失败。
        w('hit%d = sp > 0 ? (ov%d > 0 ? volume * ov%d / sp : 0) : (high >= lo + %d * step && high <= lo + %d * step ? volume : 0)'
          % (i, i, i, i, i + 1))
        w('v%d = sum(hit%d, N)' % (i, i))
    common_after_vol(session=False)
    return '\n'.join(L) + '\n'

def gen_session():
    """版本B：每日上海时间 08:00 重置。依赖时间函数。"""
    del L[:]
    head('每日 08:00 重置版（严格按需求）', [
        '1. 以上海时间每日 08:00 为新交易日起点，重置当日高低点与逐档成交量',
        '2. 把当日价格区间均分为 24 档，按重叠比例摊分成交量',
        '3. 中间 70% 成交量所在区间 = 价值区；上沿 VAH，下沿 VAL，最密档 POC',
        '4. 收盘 > VAH → 做空区域；收盘 < VAL → 做多区域',
        '',
        '【必读】本版依赖时间函数 hour() 与自引用 x[1]：',
        '  · 若报错，请先跑通「滚动窗口版」确认基础函数可用，再回来调这里',
        '  · 若平台的 hour 是 UTC，把 8 改成 0（北京时间 08:00 = UTC 00:00）',
        '  · 盘中档位边界随当日高低点扩张，早期 K 线的归属会略有失真，',
        '    越接近次日 08:00 越准确。若需要全天稳定的参考位，请用滚动窗口版。',
    ])
    w('// ---------- 参数 ----------')
    w('VA_PCT = 70   // 价值区包含的成交量百分比，标准值 70')
    w()
    w('// ---------- 新交易日判定（上海时间 08:00） ----------')
    w('// 常见写法三选一，按平台实际支持情况启用：')
    w("//   1) isNewDay = hour == 8 && hour[1] != 8        // hour 为北京时间")
    w("//   2) isNewDay = hour == 0 && hour[1] != 23       // hour 为 UTC")
    w("//   3) isNewDay = day != day[1]                    // 有 day 函数时按自然日切")
    w('isNewDay = hour == 8 && hour[1] != 8')
    w()
    w('// ---------- 当日已走完的 K 线根数 ----------')
    w('// 刚重置时只有 1 根 K 线，价格区间极窄，此时算出的 VAH/VAL 没有参考价值，')
    w('// 必须设一个最小根数门槛，否则会在每个 08:00 附近刷出一堆假信号。')
    w('MIN_BARS = 4      // 当日至少走完 4 根 K 线才认为指标有效')
    w('barCount = isNewDay ? 1 : barCount[1] + 1')
    w()
    w('// ---------- 当日高低点（重置式累积） ----------')
    w('dayHigh = isNewDay ? high : max(high, dayHigh[1])')
    w('dayLow = isNewDay ? low : min(low, dayLow[1])')
    w('hi = dayHigh')
    w('lo = dayLow')
    w('rng = hi - lo')
    w('step = rng > 0 ? rng / 24 : 0')
    w()
    w('// ---------- 24 档价格（取每档中点） ----------')
    for i in range(ROWS):
        w('P%d = lo + (%.1f) * step' % (i, i + 0.5))
    w()
    w('// ---------- 当前 K 线摊分到各档 ----------')
    w('sp = high - low')
    for i in range(ROWS):
        w('ov%d = min(high, lo + %d * step) - max(low, lo + %d * step)' % (i, i + 1, i))
        w('sh%d = sp > 0 ? (ov%d > 0 ? volume * ov%d / sp : 0) : (high >= lo + %d * step && high <= lo + %d * step ? volume : 0)'
          % (i, i, i, i, i + 1))
    w()
    w('// ---------- 当日逐档累积（08:00 重置） ----------')
    for i in range(ROWS):
        w('v%d = isNewDay ? sh%d : v%d[1] + sh%d' % (i, i, i, i))
    common_after_vol(session=True)
    return '\n'.join(L) + '\n'

a = gen_rolling()
b = gen_session()
pa = OUT + r'\AiCoin-VP24-滚动窗口版.txt'
pb = OUT + r'\AiCoin-VP24-每日08点重置版.txt'
io.open(pa, 'w', encoding='utf-8').write(a)
io.open(pb, 'w', encoding='utf-8').write(b)
print('written A:', pa, len(a.splitlines()), 'lines')
print('written B:', pb, len(b.splitlines()), 'lines')
