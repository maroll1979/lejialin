# -*- coding: utf-8 -*-
"""用迷你转译器直接执行生成的 AIScript 文件，验证数值正确性。"""
import sys, os, math, random, io
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aiscript_runner import VM, NA

OUT = r'C:\Users\windos\WorkBuddy\2026-09-14-20-21-18\outputs'
ROLL = os.path.join(OUT, 'AiCoin-VP24-滚动窗口版.txt')
SESS = os.path.join(OUT, 'AiCoin-VP24-每日08点重置版.txt')

def make_bars(n=80, seed=1, base=3000.0, start_hour=8):
    rnd = random.Random(seed)
    bars = []; px = base
    for i in range(n):
        px *= (1 + rnd.uniform(-0.003, 0.003))
        h = px*(1+abs(rnd.gauss(0,0.0015))); l = px*(1-abs(rnd.gauss(0,0.0015)))
        bars.append(dict(open=px, high=h, low=l, close=rnd.uniform(l,h),
                         volume=rnd.uniform(300,1200),
                         hour=(start_hour+i) % 24))
    return bars

def check(path, tag, bars, warm=30):
    src = io.open(path, encoding='utf-8').read()
    vm = VM(src)
    res = vm.run(bars)
    print('=== %s ===' % tag)
    print('转译并执行的赋值语句数: %d' % len(vm.lines))
    bad = []
    nvalid = 0
    for i in range(warm, len(res)):
        r = res[i]
        if 'VAL_' not in r or 'VAH_' not in r:
            bad.append((i, '缺少输出字段')); continue
        lo, hi = r.get('lo'), r.get('hi')
        VAL_, VAH_, POC_ = r['VAL_'], r['VAH_'], r['POC_']
        if not (math.isfinite(VAL_) and math.isfinite(VAH_)):
            continue  # 无效根（na）
        nvalid += 1
        if not (hi > lo):
            bad.append((i, '价格区间为零: lo=%.4f hi=%.4f' % (lo, hi)))
            continue
        if not (lo - 1e-6 <= VAL_ <= VAH_ <= hi + 1e-6):
            bad.append((i, 'VAL/VAH 越界: lo=%.2f VAL=%.2f VAH=%.2f hi=%.2f'
                        % (lo, VAL_, VAH_, hi)))
        if not (VAL_ <= POC_ + 1e-6):
            bad.append((i, 'POC < VAL: VAL=%.2f POC=%.2f' % (VAL_, POC_)))
        if not (POC_ <= VAH_ + 1e-6):
            bad.append((i, 'POC > VAH: POC=%.2f VAH=%.2f' % (POC_, VAH_)))
    if nvalid == 0:
        print('!! 没有任何一根 K 线产出有效值 —— 转译或代码有问题')
        print()
        return False
    if bad:
        print('异常根数: %d / 有效根数 %d' % (len(bad), nvalid))
        for i, m in bad[:5]:
            print('   K线%d: %s' % (i, m))
    else:
        print('数值约束检查: 全部通过（有效根数 %d）' % nvalid)
    # 抽样（取前 3 个有效根）
    print('抽样输出:')
    shown = 0
    for i in range(warm, len(res)):
        r = res[i]
        if not math.isfinite(r.get('VAL_', NA)): continue
        print('   idx=%d lo=%.2f hi=%.2f VAL_=%.2f POC_=%.2f VAH_=%.2f'
              % (i, r.get('lo', 0), r.get('hi', 0), r['VAL_'], r['POC_'], r['VAH_']))
        shown += 1
        if shown >= 3: break
    print()
    return len(bad) == 0 and nvalid > 0

ok = True
bars = make_bars(80, seed=1)
ok &= check(ROLL, '滚动窗口版', bars)
ok &= check(SESS, '每日08点重置版', bars)
print('总判定:', '通过' if ok else '存在问题')
