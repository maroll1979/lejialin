# -*- coding: utf-8 -*-
"""验证 VP-24 指标算法。
对照两个基准：
  A. 同算法参考（比例摊分 + 分位数）  → 应当逐位一致，用于验证生成代码无误
  B. 行业标准（比例摊分 + 从 POC 贪心扩展） → 量化两者在多峰分布下的差异
"""
import random

ROWS = 24
VAPCT = 70

# ---------- 基准：真正的分箱（按重叠比例摊分） ----------
def ref_profile(bars, rows=ROWS):
    hi = max(b['h'] for b in bars)
    lo = min(b['l'] for b in bars)
    rng = hi - lo
    if rng <= 0:
        return None
    step = rng / rows
    vol = [0.0] * rows
    for b in bars:
        bl, bh, bv = b['l'], b['h'], b['v']
        span = bh - bl
        for i in range(rows):
            p_lo = lo + i * step
            p_hi = lo + (i + 1) * step
            ov = min(bh, p_hi) - max(bl, p_lo)
            if ov > 0:
                vol[i] += bv * (ov / span if span > 0 else 1.0)
    return hi, lo, step, vol

def va_quantile(vol, lo, step, poc_mid, rows=ROWS, vapct=VAPCT):
    """分位数法 + POC 夹逼（本指标采用）；poc_mid 为 POC 档位中点"""
    total = sum(vol)
    if total <= 0:
        return None
    T = total * (100 - vapct) / 200.0
    c = 0.0; k = 0
    for i in range(rows):
        c += vol[i]
        if c >= T:
            k = i; break
    d = 0.0; m = rows - 1
    for i in range(rows - 1, -1, -1):
        d += vol[i]
        if d >= T:
            m = i; break
    val, vah = lo + k * step, lo + (m + 1) * step
    val = min(val, poc_mid - step / 2)   # 强制含 POC
    vah = max(vah, poc_mid + step / 2)
    return val, vah

def va_greedy(vol, rows=ROWS, vapct=VAPCT):
    """行业标准：从 POC 向两侧贪心扩展至 vapct%"""
    total = sum(vol)
    if total <= 0:
        return None
    poc = max(range(rows), key=lambda i: vol[i])
    lo_i = hi_i = poc
    acc = vol[poc]
    target = total * vapct / 100.0
    while acc < target and (lo_i > 0 or hi_i < rows - 1):
        up = vol[hi_i + 1] if hi_i < rows - 1 else -1
        dn = vol[lo_i - 1] if lo_i > 0 else -1
        if up >= dn:
            hi_i += 1; acc += vol[hi_i]
        else:
            lo_i -= 1; acc += vol[lo_i]
    return lo_i, hi_i

# ---------- 待测：完全照搬生成的 AIScript 逻辑 ----------
def gen_profile(bars, n, rows=ROWS, vapct=VAPCT):
    win = bars[-n:]
    hi = max(b['h'] for b in win)
    lo = min(b['l'] for b in win)
    rng = hi - lo
    if rng <= 0:
        return None
    step = rng / rows
    P = [lo + (i + 0.5) * step for i in range(rows)]
    v = []
    for i in range(rows):
        s = 0.0
        for b in win:
            sp = b['h'] - b['l']
            ov = min(b['h'], lo + (i + 1) * step) - max(b['l'], lo + i * step)
            if ov > 0:
                s += b['v'] * ov / sp if sp > 0 else b['v']
        v.append(s)
    c = [0.0] * rows; c[0] = v[0]
    for i in range(1, rows):
        c[i] = c[i - 1] + v[i]
    d = [0.0] * rows; d[rows - 1] = v[rows - 1]
    for i in range(rows - 2, -1, -1):
        d[i] = d[i + 1] + v[i]
    m = v[0]; pocP = P[0]
    for i in range(1, rows):
        if v[i] > m:
            m = v[i]; pocP = P[i]
    total = c[rows - 1]
    T = total * (100 - vapct) / 200.0
    VAL = lo + sum(step for i in range(rows - 1) if c[i] < T)
    VAH = hi - sum(step for i in range(rows - 1, 0, -1) if d[i] < T)
    # 强制把 POC 包进价值区
    pocLo, pocHi = pocP - step / 2, pocP + step / 2
    pocClamped = (VAL > pocLo) or (VAH < pocHi)
    VAL = min(VAL, pocLo)
    VAH = max(VAH, pocHi)
    return dict(hi=hi, lo=lo, step=step, v=v, POC=pocP, VAL=VAL, VAH=VAH,
                total=total, clamped=pocClamped)

def make_bars(k=24, base=3000.0, seed=1, trend=0.0, spread=0.004):
    rnd = random.Random(seed)
    bars = []; px = base
    for i in range(k):
        px *= (1 + trend + rnd.uniform(-spread, spread))
        o = px
        h = px * (1 + abs(rnd.gauss(0, 0.0015)))
        l = px * (1 - abs(rnd.gauss(0, 0.0015)))
        c = rnd.uniform(l, h)
        bars.append(dict(o=o, h=h, l=l, c=c, v=rnd.uniform(100, 1000)))
    return bars

print('=== VP-24 验证（比例摊分 + POC夹逼）===')
print('%-16s %-10s %-10s %-8s %s' % ('场景', 'vs同算法', 'vs贪心法', 'POC夹逼', '判定'))
allok = True
for name, bars in [
    ('随机震荡 s=1', make_bars(seed=1)),
    ('随机震荡 s=2', make_bars(seed=2)),
    ('上升趋势', make_bars(seed=3, trend=0.0015)),
    ('下降趋势', make_bars(seed=4, trend=-0.0015)),
    ('窄幅横盘', make_bars(seed=5, spread=0.001)),
    ('剧烈波动', make_bars(seed=6, spread=0.012)),
    ('单峰集中', make_bars(seed=7, spread=0.002)),
]:
    g = gen_profile(bars, 24)
    r = ref_profile(bars[-24:])
    hi, lo, step, vol = r
    span = hi - lo
    q_val, q_vah = va_quantile(vol, lo, step, g['POC'])
    e_a = max(abs(g['VAL'] - q_val), abs(g['VAH'] - q_vah)) / span * 100
    lo_i, hi_i = va_greedy(vol)
    g_val, g_vah = lo + lo_i * step, lo + (hi_i + 1) * step
    e_b = max(abs(g['VAL'] - g_val), abs(g['VAH'] - g_vah)) / span * 100
    ok = e_a < 0.5
    allok &= ok
    print('%-16s %-10s %-10s %-8s %s'
          % (name, '%.4f%%' % e_a, '%.2f%%' % e_b,
             '是' if g['clamped'] else '否', '一致' if ok else '**不一致**'))

g = gen_profile(make_bars(seed=7), 24)
lo, step, v = g['lo'], g['step'], g['v']
inside = sum(vv for vv, i in zip(v, range(ROWS))
             if g['VAL'] <= lo + i * step <= g['VAH'])
print('\n价值区实际占比 = %.1f%%（目标 70%%）' % (inside / g['total'] * 100))
print('lo=%.2f hi=%.2f POC=%.2f VAL=%.2f VAH=%.2f'
      % (g['lo'], g['hi'], g['POC'], g['VAL'], g['VAH']))

flat = [dict(o=100, h=100, l=100, c=100, v=10) for _ in range(24)]
print('全平盘返回 None：', gen_profile(flat, 24) is None)
print('\n与同算法参考：', '全部逐位一致' if allok else '存在不一致，需修')
