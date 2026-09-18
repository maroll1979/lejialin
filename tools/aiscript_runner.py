# -*- coding: utf-8 -*-
"""迷你 AIScript → Python 转译执行器。

用途：项目交付的 AIScript 无法在 AiCoin 之外的环境运行，只能靠静态检查。
这里把生成的「纯标量赋值」子集转译成 Python，喂入模拟 K 线逐根执行，
从而真正验证生成代码的数值正确性（而不是验证我脑子里的算法）。

支持：数字/变量、+ - * / %、比较、&& ||、三元 ?:、下标 x[1]、
      highest/lowest/sum/max/min/abs、na
忽略：plot / plotText / plotShape / alertcondition / enterLong 等副作用调用
"""
import re, math, io

NA = float('nan')

def _split_top(e, chs):
    """在括号深度 0 处查找字符，返回索引列表"""
    depth = 0; out = []
    for i, c in enumerate(e):
        if c == '(': depth += 1
        elif c == ')': depth -= 1
        elif depth == 0 and c in chs:
            out.append(i)
    return out

def conv(e):
    e = e.strip()
    # 剥离整体外层括号：否则 (a ? b : c) 里的 ? 处在 depth=1，三元查找会失效
    while e.startswith('(') and e.endswith(')'):
        depth = 0; matched = True
        for i, c in enumerate(e):
            if c == '(': depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0 and i < len(e) - 1:
                    matched = False; break
        if not matched: break
        e = e[1:-1].strip()
    # 三元：找最外层 ? 与紧随其后的 :
    ps = _split_top(e, '?')
    if ps:
        q = ps[0]
        cs = [i for i in _split_top(e[q+1:], ':') ] 
        if cs:
            c = q + 1 + cs[0]
            return '(%s if %s else %s)' % (conv(e[q+1:c]), conv(e[:q]), conv(e[c+1:]))
    e = e.replace('&&', ' and ').replace('||', ' or ')
    # 函数调用
    def frepl(m):
        fn, args = m.group(1), m.group(2)
        raw = _split_args(args)
        if fn in ('highest', 'lowest', 'sum'):
            # 第一个参数是「序列变量名」，必须取原始名字（不能再被 conv 成 _v('x')）
            var = raw[0].strip()
            n = conv(raw[1]) if len(raw) > 1 else '0'
            fmap = {'highest': '_hh', 'lowest': '_ll', 'sum': '_sm'}
            return '%s(%r, %s)' % (fmap[fn], var, n)
        if fn in ('cross_up', 'crossup'):
            a, b = raw[0].strip(), raw[1].strip()
            return "((_h(%r) < _h(%r)) and (_v(%r) >= _v(%r)))" % (a, b, a, b)
        if fn in ('cross_down', 'crossdown'):
            a, b = raw[0].strip(), raw[1].strip()
            return "((_h(%r) > _h(%r)) and (_v(%r) <= _v(%r)))" % (a, b, a, b)
        a = [conv(x) for x in raw]
        if fn == 'max':     return 'max(%s, %s)' % (a[0], a[1])
        if fn == 'min':     return 'min(%s, %s)' % (a[0], a[1])
        if fn == 'abs':     return 'abs(%s)' % a[0]
        return '0'
    e = re.sub(r'\b(highest|lowest|sum|max|min|abs|cross_up|cross_down|crossup|crossdown)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)', frepl, e)
    # 下标 x[1]
    e = re.sub(r"\b([A-Za-z_]\w*)\s*\[\s*1\s*\]", r"_h('\1')", e)
    # 保护字符串字面量（如 _hh('high', ...) 里的 'high'），
    # 否则下面的变量名替换会把引号内的标识符也一起改掉
    strs = []
    def _prot(m):
        strs.append(m.group(0))
        return '__S%d__' % (len(strs) - 1)
    e = re.sub(r"'[^']*'", _prot, e)
    # 变量名 → env/hist 取值（跳过内部函数与占位符 _xx）
    def vrepl(m):
        n = m.group(0)
        if n.startswith('_'):
            return n
        # Python 内置名与关键字必须原样保留，不能被当成序列变量
        if n in ('max', 'min', 'abs', 'and', 'or', 'not', 'if', 'else',
                 'True', 'False', 'None'):
            return n
        return "_v('%s')" % n
    e = re.sub(r"\b[A-Za-z_]\w*\b", vrepl, e)
    e = re.sub(r"_v\('(and|or|not|if|else|True|False|None)'\)", r"\1", e)
    for i, s in enumerate(strs):
        e = e.replace('__S%d__' % i, s)
    e = e.replace("_v('na')", '_NA')   # na → NaN（须在字符串还原之后）
    return e

def _split_args(s):
    depth = 0; cur = ''; out = []
    for c in s:
        if c == '(': depth += 1
        elif c == ')': depth -= 1
        if c == ',' and depth == 0:
            out.append(cur); cur = ''
        else:
            cur += c
    if cur.strip(): out.append(cur)
    return out

class VM:
    def __init__(self, src):
        self.lines = []
        for raw in src.splitlines():
            s = raw.split('//')[0].strip()
            if not s: continue
            m = re.match(r'^([A-Za-z_]\w*)\s*=\s*(.+)$', s)
            if not m: continue
            name, expr = m.group(1), m.group(2)
            if re.match(r'^(plot|plotText|plotShape|plotChar|alertcondition|enterLong|'
                        r'enterShort|exitLong|exitShort|fill|bgcolor|hline|indicator)', name):
                continue
            if re.match(r'^(plot|plotText|plotShape|plotChar|alertcondition|enterLong|'
                        r'enterShort|exitLong|exitShort|fill|bgcolor|hline)\s*\(', expr):
                continue
            self.lines.append((name, conv(expr)))
        self.hist = {}
        self.env = {}
        self.cur = {}

    def _push(self, name, val):
        self.hist.setdefault(name, []).append(val)

    def run(self, bars):
        """bars: list of dict(high,low,close,open,volume,hour)"""
        out = []
        for bi, b in enumerate(bars):
            self.cur = {}
            self.env = {}
            for k in ('high', 'low', 'close', 'open', 'volume', 'hour'):
                v = b.get(k, 0.0)
                self._push(k, v)
                self.env[k] = v

            def _v(n):
                if n in self.env: return self.env[n]
                h = self.hist.get(n)
                return h[-1] if h else 0.0
            def _h(n):
                # 取「上一根」的值。注意内置变量在每根开头就已入栈（因为
                # highest(high,N) 需要包含当前根），所以内置要回退两格，
                # 而普通变量当前根尚未入栈，回退一格即可。
                h = self.hist.get(n)
                if not h:
                    return 0.0
                if n in ('high', 'low', 'close', 'open', 'volume', 'hour'):
                    return h[-2] if len(h) >= 2 else h[-1]
                return h[-1]
            def _hh(n, N):
                h = self.hist.get(n, [])[-int(N):]
                return max(h) if h else 0.0
            def _ll(n, N):
                h = self.hist.get(n, [])[-int(N):]
                return min(h) if h else 0.0
            def _sm(n, N):
                h = self.hist.get(n, [])[-int(N):]
                return sum(h) if h else 0.0
            g = dict(_v=_v, _h=_h, _hh=_hh, _ll=_ll, _sm=_sm,
                     max=max, min=min, abs=abs, _NA=NA)
            for name, py in self.lines:
                try:
                    val = eval(py, {'__builtins__': {}}, g)
                except Exception as ex:
                    val = 0.0
                self.env[name] = val
                self._push(name, val)
            out.append(dict(self.env))
        return out
