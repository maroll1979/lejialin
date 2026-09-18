# -*- coding: utf-8 -*-
"""在「真实感成交量分布」下，比较分位数法与标准贪心法的差异。
真实市场的成交量通常围绕某个"公允价"呈单峰分布，价格越远成交越稀疏。
若两者在单峰下接近，则差异只出现在多峰/极端行情，可接受。
"""
import random, math
ROWS, VAPCT = 24, 70

def profile(bars):
    hi = max(b['h'] for b in bars); lo = min(b['l'] for b in bars)
    step = (hi - lo) / ROWS
    vol = [0.0] * ROWS
    for b in bars:
        sp = b['h'] - b['l']
        for i in range(ROWS):
            ov = min(b['h'], lo + (i+1)*step) - max(b['l'], lo + i*step)
            if ov > 0:
                vol[i] += b['v'] * (ov/sp if sp > 0 else 1.0)
    return lo, hi, step, vol

def quantile_va(vol, lo, step):
    tot = sum(vol); T = tot * (100-VAPCT)/200
    c = 0; k = 0
    for i in range(ROWS):
        c += vol[i]
        if c >= T: k = i; break
    d = 0; m = ROWS-1
    for i in range(ROWS-1, -1, -1):
        d += vol[i]
        if d >= T: m = i; break
    poc = max(range(ROWS), key=lambda i: vol[i])
    val = min(lo + k*step, lo + (poc+0.5)*step - step/2)
    vah = max(lo + (m+1)*step, lo + (poc+0.5)*step + step/2)
    return val, vah

def greedy_va(vol, lo, step):
    tot = sum(vol); tgt = tot*VAPCT/100
    poc = max(range(ROWS), key=lambda i: vol[i])
    a = b = poc; acc = vol[poc]
    while acc < tgt and (a > 0 or b < ROWS-1):
        up = vol[b+1] if b < ROWS-1 else -1
        dn = vol[a-1] if a > 0 else -1
        if up >= dn: b += 1; acc += vol[b]
        else: a -= 1; acc += vol[a]
    return lo + a*step, lo + (b+1)*step

def make(seed, peaks, k=24, base=3000.0, vol_spread=0.006):
    """peaks: [(中心价, 权重)] —— 单峰或双峰"""
    rnd = random.Random(seed)
    bars = []; px = base
    tot_w = sum(w for _, w in peaks)
    for _ in range(k):
        px *= (1 + rnd.uniform(-0.003, 0.003))
        h = px*(1+abs(rnd.gauss(0,0.0015))); l = px*(1-abs(rnd.gauss(0,0.0015)))
        mid = (h+l)/2
        v = 0.0
        for c, w in peaks:
            v += w/tot_w * math.exp(-((mid-c)/(vol_spread*base))**2)
        v = max(v, 0.02) * rnd.uniform(600, 1400)
        bars.append(dict(o=px, h=h, l=l, c=rnd.uniform(l,h), v=v))
    return bars

print('=== 分位数法 vs 标准贪心法（真实感分布）===')
print('%-26s %-10s %s' % ('分布形态', '最大偏差', '说明'))
cases = [
    ('单峰·居中', make(1, [(3000, 1.0)])),
    ('单峰·偏上', make(2, [(3015, 1.0)])),
    ('单峰·偏下', make(3, [(2985, 1.0)])),
    ('单峰·很集中', make(4, [(3000, 1.0)], vol_spread=0.002)),
    ('单峰·很分散', make(5, [(3000, 1.0)], vol_spread=0.02)),
    ('双峰·对称', make(6, [(2960, 1.0), (3040, 1.0)])),
    ('双峰·一强一弱', make(7, [(2960, 3.0), (3040, 1.0)])),
    ('三峰', make(8, [(2950,1.0),(3000,1.0),(3050,1.0)])),
]
for name, bars in cases:
    lo, hi, step, vol = profile(bars)
    span = hi - lo
    qv, qh = quantile_va(vol, lo, step)
    gv, gh = greedy_va(vol, lo, step)
    e = max(abs(qv-gv), abs(qh-gh)) / span * 100
    tag = '一致' if e < 2 else ('接近' if e < 6 else '差异明显')
    print('%-26s %-10s %s' % (name, '%.2f%%' % e, tag))

print('\n注：偏差以「占当日价格区间」的百分比表示；4.17%% = 1 个档位')
