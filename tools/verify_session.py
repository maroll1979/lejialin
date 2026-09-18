# -*- coding: utf-8 -*-
"""模拟「每日 08:00 重置版」的逐 K 线求值过程，验证重置与累积是否正确。"""
import random, math
ROWS, VAPCT = 24, 70

def run_session(bars):
    """逐根 K 线求值，完全照搬 AIScript 版本B 的逻辑"""
    out = []
    dayHigh = dayLow = None
    v = [0.0] * ROWS
    resets = []
    for idx, b in enumerate(bars):
        isNewDay = (b['hour'] == 8 and (idx == 0 or bars[idx-1]['hour'] != 8))
        if isNewDay:
            resets.append(idx)
        # 当日高低点（重置式累积）
        dayHigh = b['h'] if isNewDay else max(b['h'], dayHigh)
        dayLow = b['l'] if isNewDay else min(b['l'], dayLow)
        hi, lo = dayHigh, dayLow
        rng = hi - lo
        step = rng / ROWS if rng > 0 else 0.0
        if rng <= 0:
            out.append(None); continue
        sp = b['h'] - b['l']
        sh = []
        for i in range(ROWS):
            ov = min(b['h'], lo + (i+1)*step) - max(b['l'], lo + i*step)
            sh.append(b['v'] * ov / sp if (ov > 0 and sp > 0) else (b['v'] if ov > 0 else 0.0))
        v = [sh[i] if isNewDay else v[i] + sh[i] for i in range(ROWS)]
        # 公共部分
        c = [0.0]*ROWS; c[0] = v[0]
        for i in range(1, ROWS): c[i] = c[i-1] + v[i]
        d = [0.0]*ROWS; d[ROWS-1] = v[ROWS-1]
        for i in range(ROWS-2, -1, -1): d[i] = d[i+1] + v[i]
        poc = max(range(ROWS), key=lambda i: v[i])
        m = v[0]; pocP = lo + (0+0.5)*step
        for i in range(1, ROWS):
            if v[i] > m:
                m = v[i]; pocP = lo + (i+0.5)*step
        total = c[ROWS-1]
        T = total * (100-VAPCT)/200
        VAL = lo + sum(step for i in range(ROWS-1) if c[i] < T)
        VAH = hi - sum(step for i in range(ROWS-1, 0, -1) if d[i] < T)
        pocLo, pocHi = pocP - step/2, pocP + step/2
        VAL = min(VAL, pocLo); VAH = max(VAH, pocHi)
        out.append(dict(idx=idx, hour=b['hour'], hi=hi, lo=lo, step=step,
                        VAL=VAL, VAH=VAH, POC=pocP, total=total, v=list(v)))
    return out, resets

def make_day(seed=1, days=3, base=3000.0):
    """生成 3 天 × 24 根 1小时 K 线，hour 为北京时间"""
    rnd = random.Random(seed)
    bars = []
    px = base
    for d in range(days):
        center = px
        for h in range(24):
            hour = (8 + h) % 24          # 每天从 08:00 开始
            px *= (1 + rnd.uniform(-0.0025, 0.0025))
            hi_ = px*(1+abs(rnd.gauss(0,0.0012))); lo_ = px*(1-abs(rnd.gauss(0,0.0012)))
            mid = (hi_+lo_)/2
            vol = math.exp(-((mid-center)/(0.008*base))**2)
            bars.append(dict(hour=hour, o=px, h=hi_, l=lo_,
                             c=rnd.uniform(lo_,hi_), v=max(vol,0.03)*rnd.uniform(700,1300)))
        center = px
    return bars

bars = make_day(seed=11)
out, resets = run_session(bars)

print('=== 每日 08:00 重置版 · 逐K线模拟验证 ===')
print('重置发生在 K 线索引:', resets, '（对应 hour =',
      [bars[i]['hour'] for i in resets], '）')
assert all(bars[i]['hour'] == 8 for i in resets), '重置点必须是 hour==8'
print('重置点全部落在 hour==8 :', 'OK')
print('重置次数 =', len(resets), '（3 天数据，期望 3 次）')

print('\n--- 基本性质检查 ---')
bad = 0
for r in out:
    if r is None: continue
    if not (r['lo'] <= r['VAL'] <= r['VAH'] <= r['hi'] + 1e-9):
        bad += 1
    if not (r['VAL'] <= r['POC'] <= r['VAH'] + 1e-9):
        bad += 1
print('违反 lo <= VAL <= VAH <= hi 或 POC 在区间外的根数:', bad, '（期望 0）')

# 检查每根 K 线后，当日累积成交量是否等于当日已发生的成交量之和（用同一分档近似检查单调性）
print('\n--- 累积单调性（非重置点当日成交量应递增）---')
mono_bad = 0
for i in range(1, len(out)):
    if out[i] is None or out[i-1] is None: continue
    if out[i]['idx'] not in resets:
        if out[i]['total'] < out[i-1]['total'] - 1e-6:
            mono_bad += 1
print('非重置点出现累计量下降的根数:', mono_bad, '（期望 0）')

# 重置点：当日总量应重置为单根 K 线的量
print('\n--- 重置点：累计量应回落到单根水平 ---')
for i in resets[1:]:
    prev = out[i-1]['total']
    cur = out[i]['total']
    print('  索引 %3d: 重置前累计 %9.1f → 重置后 %9.1f  %s'
          % (i, prev, cur, 'OK' if cur < prev else '**未重置**'))

print('\n--- 抽样输出（第 2 天 08:00 后若干根）---')
start = resets[1]
for i in range(start, min(start+26, len(out))):
    r = out[i]
    if r is None: continue
    print('  hour=%2d  lo=%8.2f hi=%8.2f  VAL=%8.2f POC=%8.2f VAH=%8.2f'
          % (r['hour'], r['lo'], r['hi'], r['VAL'], r['POC'], r['VAH']))

print('\n结论:', '通过' if (bad == 0 and mono_bad == 0) else '存在问题')
