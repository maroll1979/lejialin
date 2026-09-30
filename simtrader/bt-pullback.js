/* bt-pullback.js · 方案 B：限价回踩入场的回测实验
   ------------------------------------------------------------------
   病根（vote-focus.js 第七段实测）：99.3% 的入场是「顺着价格偏离方向追进去」的，
   81% 入场时已偏离 1h 中轨 ≥1.6σ —— 多周期九票确认太慢，凑齐时价格已跑远。

   方案：信号触发后**不追市价**，挂一张回踩 pb% 的限价单，
        在 wait 根 5m 内触及则成交（成交价以 1m 精确定位），否则放弃该信号。

   ★ 这个实验最重要的不是「能不能赚钱」，而是**把收益拆成两笔账**：

     R_pull          回踩版实际收益
     R_base_filled   同一批「成交了的信号」，如果按基线（立即市价）执行会赚多少
     R_base_missed   被放弃的那批信号，如果按基线执行会赚多少

     入场价改善 = R_pull        − R_base_filled
     筛选效应   = R_base_filled − R_base_all

   只有拆开才知道：回踩带来的好处到底是「买得更便宜」，
   还是「恰好只在行情走弱时才成交，于是筛掉了一批本来要亏的信号」——
   后者是逆向选择，不是alpha。两者必须分开算，否则会自我欺骗。

   用法：node bt-pullback.js BTCUSDT 2
   ------------------------------------------------------------------ */
const S = require('./simtrader/strategy.js');
const fs = require('fs');

const sym = process.argv[2] || 'BTCUSDT';
const YEARS = +(process.argv[3] || 2);
const CACHE = 'data/m1_' + sym + '_' + YEARS + 'y.json';
const SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

/* 回踩幅度（相对触发后第一根开盘价） */
const PB = [0.001, 0.002, 0.003, 0.005, 0.008, 0.010, 0.015, 0.020];
/* 等待窗口（5m 根数）→ 6=30min 12=1h 24=2h 48=4h 96=8h 288=24h */
const WAIT = [6, 12, 24, 48, 96, 288];
/* 两套结算：用户给过的 1:2，以及宽一档的 1:2 */
const PLANS = [
  { lab: '1.5%:3%', stop: 0.015, tp: 0.030 },
  { lab: '2%:4%', stop: 0.020, tp: 0.040 },
];
const MAX_HOLD = Math.round(7 * 86400 / 300);      // 7 天（5m 根）
const FEE = S.FEE_RATE;

const pad = (s, n) => String(s).padStart(n);
const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(4);

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/* 触发点（同 findVoteTriggersClosed：只在刚凑齐那一根响一次） */
function triggersOf(r5, r15, r1h, m15, m1h, n) {
  const out = [];
  let prev = false;
  for (let i = 1; i < n; i++) {
    const j15 = m15[i], j1h = m1h[i];
    let on = false;
    if (j15 >= 0 && j1h >= 0) {
      const a = r1h.dirs[j1h];
      on = a !== 0 && r15.dirs[j15] === a && r5.dirs[i] === a;
    }
    if (on && !prev) out.push({ i, dir: r1h.dirs[j1h] });
    prev = on;
  }
  return out;
}

/* 从 5m 索引 k0 起、以 entry 成交、方向 dir(1多/2空) 走到出场，返回 R
   —— 口径与基线完全一致：先判止损再判止盈（同根双触算止损），最多 7 天 */
function outcome(s5, k0, entry, dir, stopPct, tpPct, fee) {
  const up = dir === 1;
  const stop = up ? entry * (1 - stopPct) : entry * (1 + stopPct);
  const tp = up ? entry * (1 + tpPct) : entry * (1 - tpPct);
  const end = Math.min(s5.n, k0 + MAX_HOLD);
  for (let j = k0; j < end; j++) {
    if (up ? s5.l[j] <= stop : s5.h[j] >= stop) return { r: -(stopPct + fee * (2 - stopPct)) / stopPct, how: 'stop' };
    if (up ? s5.h[j] >= tp : s5.l[j] <= tp) return { r: (tpPct - fee * (2 + tpPct)) / stopPct, how: 'tp' };
  }
  const last = Math.min(s5.n - 1, k0 + MAX_HOLD - 1);
  const pnl = up ? (s5.c[last] - entry) / entry : (entry - s5.c[last]) / entry;
  return { r: (pnl - fee * 2) / stopPct, how: 'expire' };
}

function stats(Rs) {
  if (!Rs.length) return { n: 0, avg: 0, t: 0, win: 0 };
  let sum = 0; for (const v of Rs) sum += v;
  const m = sum / Rs.length;
  let ss = 0; for (const v of Rs) ss += (v - m) * (v - m);
  const sd = Math.sqrt(ss / (Rs.length - 1)) || 1e-9;
  return { n: Rs.length, avg: m, t: m / (sd / Math.sqrt(Rs.length)), win: Rs.filter(v => v > 0).length / Rs.length };
}

(async () => {
  if (!fs.existsSync(CACHE)) { console.error('缺缓存 ' + CACHE + '，请先跑 bt-pct.js 拉数'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const s1m = S.toSeries(raw.rows);
  const s5 = S.aggregate(s1m, SEC['5m']);
  const s15 = S.aggregate(s5, SEC['15m']);
  const s1h = S.aggregate(s5, SEC['1h']);
  const s1d = S.aggregate(s5, SEC['1d']);
  const N = s5.n, days = (s5.t[N - 1] - s5.t[0]) / 86400;

  console.log('════════ ' + sym + ' · ' + N.toLocaleString('en-US') + ' 根 5m · '
    + days.toFixed(0) + ' 天 · 方案B 限价回踩入场 ════════');
  console.log('单边费率 ' + (FEE * 100).toFixed(3) + '% · 出场口径与基线一致（5m 撮合，先判止损）\n');

  const ma5 = S.dailyMa200Lookup(s5, s1d, 200, SEC['5m']);
  const ma15 = S.dailyMa200Lookup(s15, s1d, 200, SEC['15m']);
  const ma1h = S.dailyMa200Lookup(s1h, s1d, 200, SEC['1h']);
  const m15 = S.buildClosedMap(s5.t, s15.t, SEC['5m'], SEC['15m']);
  const m1h = S.buildClosedMap(s5.t, s1h.t, SEC['5m'], SEC['1h']);

  const V = { thz: 0.30, bufPct: 0.005, minVotes: 4 };
  const r5 = S.voteSeries(s5, ma5, V);
  const r15 = S.voteSeries(s15, ma15, V);
  const r1h = S.voteSeries(s1h, ma1h, V);
  const trigs = triggersOf(r5, r15, r1h, m15, m1h, N);

  /* ---------- 每个触发点：基线 + 1m 回踩首次触及（一次遍历，所有 pb 同时求） ---------- */
  const MAXW = WAIT[WAIT.length - 1];
  const recs = [];
  for (const tg of trigs) {
    const i = tg.i;
    const kEntry = i + 1;                       // 基线成交的根
    if (kEntry >= s5.n - 1) continue;
    const P0 = s5.o[kEntry];                    // 基线成交价 = 信号后第一根开盘
    const base = {};
    for (const P of PLANS) base[P.lab] = outcome(s5, kEntry, P0, tg.dir, P.stop, P.tp, FEE).r;

    /* 1m 窗口：从 s5.t[kEntry] 起，最长 MAXW 根 5m */
    const tStart = s5.t[kEntry], tEnd = tStart + MAXW * 300;
    let m = lowerBound(s1m.t, tStart);
    const fillAt = new Array(PB.length).fill(-1);     // 首次触及的 1m 索引
    const fillPx = new Array(PB.length).fill(0);
    const up = tg.dir === 1;
    for (let p = 0; p < PB.length; p++) {
      const lim = up ? P0 * (1 - PB[p]) : P0 * (1 + PB[p]);
      fillPx[p] = lim;
    }
    while (m < s1m.n && s1m.t[m] < tEnd) {
      for (let p = 0; p < PB.length; p++) {
        if (fillAt[p] >= 0) continue;
        if (up ? s1m.l[m] <= fillPx[p] : s1m.h[m] >= fillPx[p]) {
          fillAt[p] = m;
          /* 跳空穿过限价 → 按该根开盘成交（不可能拿到比开盘更好的价） */
          fillPx[p] = up ? Math.min(fillPx[p], s1m.o[m]) : Math.max(fillPx[p], s1m.o[m]);
        }
      }
      m++;
    }
    recs.push({ i, dir: tg.dir, P0, base, fillAt, fillPx, tStart });
  }
  console.log('触发 ' + trigs.length + ' 次 · 可评估 ' + recs.length + ' 次 · 平均 '
    + (days / recs.length * 24).toFixed(1) + ' 小时一次\n');

  /* ---------- 一、基线 ---------- */
  console.log('──── 一、基线：信号后立即市价成交（追高）────');
  for (const P of PLANS) {
    const st = stats(recs.map(x => x.base[P.lab]));
    console.log('  ' + P.lab.padEnd(9) + ' 笔数 ' + pad(st.n, 5)
      + '  胜率 ' + (st.win * 100).toFixed(1).padStart(5) + '%'
      + '  净R ' + pad(f2(st.avg), 9) + '  t=' + pad(st.t.toFixed(2), 6));
  }

  /* ---------- 二、固定 wait=48(4h)，扫回踩幅度 ---------- */
  const W_FIX = 48;
  console.log('\n──── 二、固定等待窗口 4 小时，扫回踩幅度（结算 ' + PLANS[0].lab + '）────');
  console.log('回踩幅度   成交率   笔数   胜率    净R      t      入场改善   筛选效应');
  const rowsA = [];
  for (let p = 0; p < PB.length; p++) {
    const P = PLANS[0];
    const Rpull = [], Rbf = [], Rbm = [];
    for (const x of recs) {
      const fa = x.fillAt[p];
      const inWin = fa >= 0 && s1m.t[fa] < x.tStart + W_FIX * 300;
      if (inWin) {
        const k0 = lowerBound(s5.t, s1m.t[fa]) + 1;
        if (k0 >= s5.n - 1) continue;
        Rpull.push(outcome(s5, k0, x.fillPx[p], x.dir, P.stop, P.tp, FEE).r);
        Rbf.push(x.base[P.lab]);
      } else {
        Rbm.push(x.base[P.lab]);
      }
    }
    const sp = stats(Rpull), sb = stats(Rbf), sm = stats(Rbm);
    const sAll = stats(recs.map(x => x.base[P.lab]));
    const improve = sp.avg - sb.avg;              // 入场价改善
    const select = sb.avg - sAll.avg;             // 筛选效应
    rowsA.push({ pb: PB[p], fill: Rbf.length / recs.length, sp, sb, sm, improve, select });
    console.log('  ' + (PB[p] * 100).toFixed(1) + '%'.padEnd(4)
      + pad((Rbf.length / recs.length * 100).toFixed(1) + '%', 8)
      + pad(sp.n, 7)
      + pad((sp.win * 100).toFixed(1) + '%', 8)
      + pad(f2(sp.avg), 9) + pad(sp.t.toFixed(2), 7)
      + pad(f2(improve), 10) + pad(f2(select), 10));
  }
  console.log('  （入场改善 = 回踩R − 同批信号按基线执行的R；筛选效应 = 同批基线R − 全体基线R）');

  /* ---------- 三、pb × wait 网格 ---------- */
  console.log('\n──── 三、回踩幅度 × 等待窗口 网格（净 R · 结算 ' + PLANS[0].lab + '）────');
  console.log('回踩\\等待  ' + WAIT.map(w => pad(w >= 288 ? '24h' : (w * 5 / 60) + 'h', 8)).join(''));
  const grid = [];
  for (let p = 0; p < PB.length; p++) {
    const line = [];
    for (const w of WAIT) {
      const P = PLANS[0];
      const R = [];
      for (const x of recs) {
        const fa = x.fillAt[p];
        if (fa < 0 || s1m.t[fa] >= x.tStart + w * 300) continue;
        const k0 = lowerBound(s5.t, s1m.t[fa]) + 1;
        if (k0 >= s5.n - 1) continue;
        R.push(outcome(s5, k0, x.fillPx[p], x.dir, P.stop, P.tp, FEE).r);
      }
      const st = stats(R);
      line.push({ avg: st.avg, t: st.t, n: st.n, win: st.win });
    }
    grid.push({ pb: PB[p], line });
    console.log('  ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(9)
      + line.map(c => pad(f2(c.avg) + (Math.abs(c.t) >= 2 ? '*' : ' '), 8)).join(''));
  }
  console.log('  （* = |t|≥2 显著；空白 = 不显著，别当结论）');

  /* ---------- 四、逆向选择检验 ---------- */
  console.log('\n──── 四、★逆向选择检验★：被放弃的信号，本来是赚是亏？ ────');
  console.log('  如果「放弃组按基线执行」也是亏的 → 回踩真的筛掉了坏信号；');
  console.log('  如果放弃组反而是赚的 → 回踩筛掉的是好信号，越等越糟。');
  console.log('回踩幅度   成交组基线R   放弃组基线R   差值(筛选)   成交组回踩R');
  for (const r of rowsA) {
    console.log('  ' + ((r.pb * 100).toFixed(1) + '%').padEnd(9)
      + pad(f2(r.sb.avg), 13) + pad(f2(r.sm.avg), 13)
      + pad(f2(r.sb.avg - r.sm.avg), 12) + pad(f2(r.sp.avg), 13));
  }

  /* ---------- 五、两套结算下的最佳组合 ---------- */
  console.log('\n──── 五、两套结算下净 R 最高的组合（含显著性）────');
  for (const P of PLANS) {
    let best = null;
    for (let p = 0; p < PB.length; p++) {
      for (const w of WAIT) {
        const R = [];
        for (const x of recs) {
          const fa = x.fillAt[p];
          if (fa < 0 || s1m.t[fa] >= x.tStart + w * 300) continue;
          const k0 = lowerBound(s5.t, s1m.t[fa]) + 1;
          if (k0 >= s5.n - 1) continue;
          R.push(outcome(s5, k0, x.fillPx[p], x.dir, P.stop, P.tp, FEE).r);
        }
        const st = stats(R);
        if (!best || st.avg > best.st.avg) best = { pb: PB[p], w, st };
      }
    }
    const bAll = stats(recs.map(x => x.base[P.lab]));
    console.log('  ' + P.lab.padEnd(9)
      + ' 最佳：回踩 ' + (best.pb * 100).toFixed(1) + '% · 窗口 '
      + (best.w >= 288 ? '24h' : (best.w * 5 / 60) + 'h')
      + ' → 净R ' + f2(best.st.avg) + ' (t=' + best.st.t.toFixed(2)
      + ', n=' + best.st.n + ', 胜率 ' + (best.st.win * 100).toFixed(1) + '%)'
      + '  ｜ 基线 ' + f2(bAll.avg));
  }

  /* ---------- 六、入场价改善的直接证据 ---------- */
  console.log('\n──── 六、入场价改善的直接证据（成交价 vs 立即成交价）────');
  console.log('回踩幅度   平均成交价改善   中位改善   跳空成交占比   成交时已等待(中位)');
  for (let p = 0; p < PB.length; p++) {
    const imp = [], waitMs = [];
    let gap = 0, tot = 0;
    for (const x of recs) {
      const fa = x.fillAt[p];
      if (fa < 0 || s1m.t[fa] >= x.tStart + W_FIX * 300) continue;
      const up = x.dir === 1;
      const e = x.fillPx[p];
      imp.push(up ? (x.P0 - e) / x.P0 : (e - x.P0) / x.P0);
      waitMs.push((s1m.t[fa] - x.tStart) / 60);
      /* 跳空：开盘就已经穿过限价 */
      if (up ? s1m.o[fa] <= e : s1m.o[fa] >= e) gap++;
      tot++;
    }
    if (!tot) { console.log('  ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(9) + ' 无成交'); continue; }
    imp.sort((a, b) => a - b); waitMs.sort((a, b) => a - b);
    const mean = imp.reduce((a, b) => a + b, 0) / imp.length;
    console.log('  ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(9)
      + pad((mean * 100).toFixed(3) + '%', 17)
      + pad((imp[imp.length >> 1] * 100).toFixed(3) + '%', 11)
      + pad((gap / tot * 100).toFixed(1) + '%', 14)
      + pad(waitMs[waitMs.length >> 1].toFixed(0) + 'min', 20));
  }

  /* ---------- 七、反向方案：动量入场（窗口内没回踩才做）---------- */
  /* 第四段发现「放弃组基线 R = +0.71」—— 不回踩的信号极强。
     但那是事后视角（t0 就知道它不回踩）。可执行版本必须等窗口结束才知道，
     那时价格已跑远。所以必须实测：等到窗口末再追进去，还赚不赚。 */
  console.log('\n──── 七、★反向方案★ 动量入场：窗口内未回踩 → 窗口末再入场 ────');
  console.log('  （四段已证明「不回踩 = 强」，但真要吃到它就得等窗口走完，届时价格已涨）');
  const P0 = PLANS[0];
  /* 动量入场：窗口内未触及回撤阈值 → 窗口末开盘入场（不做则不计） */
  function momoR(list, p, w, P) {
    const R = [];
    for (const x of list) {
      const fa = x.fillAt[p];
      if (fa >= 0 && s1m.t[fa] < x.tStart + w * 300) continue;      // 回踩过 → 不做
      const k0 = lowerBound(s5.t, x.tStart + w * 300);
      if (k0 >= s5.n - 1) continue;
      R.push(outcome(s5, k0, s5.o[k0], x.dir, P.stop, P.tp, FEE).r);
    }
    return stats(R);
  }
  console.log('  每格 = 净R / 笔数；* = 笔数≥30 且 |t|≥2（够格谈显著）');
  console.log('回踩阈值   ' + WAIT.map(w => pad(w >= 288 ? '24h' : (w * 5 / 60) + 'h', 15)).join(''));
  const momo = [];
  for (let p = 0; p < PB.length; p++) {
    const line = [];
    for (const w of WAIT) line.push(momoR(recs, p, w, P0));
    momo.push({ pb: PB[p], line });
    console.log('  ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(9)
      + line.map(c => pad(f2(c.avg) + ' n' + c.n + (c.n >= 30 && Math.abs(c.t) >= 2 ? '*' : ' '), 15)).join(''));
  }

  /* ---------- 八、天真延迟：不看回踩，固定等 wait 再入场 ---------- */
  /* 用来分离「延迟本身」的影响：如果天真延迟也变好，说明是延迟在起作用，
     不是动量筛选在起作用。这是必须的对照，否则会把延迟的功劳记到筛选头上。 */
  console.log('\n──── 八、对照·天真延迟：不看回踩，信号后固定等 N 小时再入场 ────');
  const dlay = [];
  {
    const P = PLANS[0];
    const R0 = [];
    for (const x of recs) R0.push(x.base[P.lab]);
    const s0 = stats(R0);
    console.log('  等待      笔数    胜率     净R       t      vs基线');
    console.log('  0h(基线)' + pad(s0.n, 8) + pad((s0.win * 100).toFixed(1) + '%', 8)
      + pad(f2(s0.avg), 9) + pad(s0.t.toFixed(2), 7) + pad('—', 9));
    for (const w of WAIT) {
      const R = [];
      for (const x of recs) {
        const k0 = lowerBound(s5.t, x.tStart + w * 300);
        if (k0 >= s5.n - 1) continue;
        R.push(outcome(s5, k0, s5.o[k0], x.dir, P.stop, P.tp, FEE).r);
      }
      const st = stats(R);
      dlay.push({ w, st });
      console.log('  ' + pad(w >= 288 ? '24h' : (w * 5 / 60) + 'h', 10)
        + pad(st.n, 8) + pad((st.win * 100).toFixed(1) + '%', 8)
        + pad(f2(st.avg), 9) + pad(st.t.toFixed(2), 7) + pad(f2(st.avg - s0.avg), 9));
    }
  }

  /* ---------- 九、样本外检验：把两年劈成前后各一年 ---------- */
  /* 网格里挑出来的正收益，最常见的死法是「只在某一段行情里成立」。
     这里强制前一年定参数、后一年验证：两半都得为正，才算不是挑出来的。 */
  console.log('\n──── 九、★样本外检验★ 两年劈成前 1 年 / 后 1 年 ────');
  const tMid = (s5.t[0] + s5.t[s5.n - 1]) / 2;
  const front = recs.filter(x => x.tStart < tMid);
  const back = recs.filter(x => x.tStart >= tMid);
  console.log('  前段 ' + front.length + ' 次 · 后段 ' + back.length + ' 次');
  console.log('  组合                前1年 净R(n)      后1年 净R(n)     两半同号?');
  const bF = stats(front.map(x => x.base[P0.lab])), bB = stats(back.map(x => x.base[P0.lab]));
  console.log('  基线(立即入场)  ' + pad(f2(bF.avg) + '(' + bF.n + ')', 17)
    + pad(f2(bB.avg) + '(' + bB.n + ')', 17)
    + (bF.avg > 0 === bB.avg > 0 ? '  同号' : '  异号'));
  for (const p of [0, 1, 2, 3]) {
    for (const w of [96, 288]) {
      const f = momoR(front, p, w, P0), b = momoR(back, p, w, P0);
      if (f.n < 5 || b.n < 5) continue;
      const same = (f.avg > 0) === (b.avg > 0);
      console.log('  动量 ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(5)
        + (w >= 288 ? '24h' : '8h').padEnd(6)
        + pad(f2(f.avg) + '(' + f.n + ')', 17)
        + pad(f2(b.avg) + '(' + b.n + ')', 17)
        + (same ? '  ✓同号' + (f.avg > 0 ? '且为正' : '但为负') : '  ✗异号（不能当结论）'));
    }
  }

  /* ---------- 十、可用形态：不等待入场，改用「不回踩」做事后加仓 ---------- */
  /* 等待入场的两难：等回踩 = 逆向选择；等不回踩 = 价格已跑远。
     唯一不吃机会成本的用法是**不等待** —— 第一笔照常立即进，
     若 N 小时内价格从未回踩，说明这是强信号，届时**加第二笔**。
     这样「强」的信息被用上了，且没有为了等它而错过第一笔。 */
  console.log('\n──── 十、★可用形态★ 试仓 + 「不回踩」确认后加仓（第一笔不等待）────');
  console.log('  组合            笔数   加仓次数   平均R    vs基线    样本外 前1年/后1年');
  for (const p of [1, 2, 3]) {
    for (const w of [48, 96]) {
      const Rs = [], Rf = [], Rb = [];
      let addN = 0;
      for (const x of recs) {
        const r1 = x.base[P0.lab];
        const fa = x.fillAt[p];
        const strong = !(fa >= 0 && s1m.t[fa] < x.tStart + w * 300);
        let tot = r1, wsum = 1;
        if (strong) {
          const k0 = lowerBound(s5.t, x.tStart + w * 300);
          if (k0 < s5.n - 1) {
            const r2 = outcome(s5, k0, s5.o[k0], x.dir, P0.stop, P0.tp, FEE).r;
            tot += r2; wsum = 2; addN++;
          }
        }
        const v = tot / wsum;
        Rs.push(v);
        if (x.tStart < tMid) Rf.push(v); else Rb.push(v);
      }
      const s = stats(Rs), sf = stats(Rf), sb = stats(Rb);
      const bAll = stats(recs.map(x => x.base[P0.lab]));
      const same = (sf.avg > 0) === (sb.avg > 0);
      console.log('  ' + ((PB[p] * 100).toFixed(1) + '%').padEnd(6)
        + (w >= 288 ? '24h' : (w * 5 / 60) + 'h').padEnd(6)
        + pad(s.n, 7) + pad(addN, 10)
        + pad(f2(s.avg), 9) + pad(f2(s.avg - bAll.avg), 10)
        + '  ' + f2(sf.avg) + ' / ' + f2(sb.avg) + (same ? ' ✓' : ' ✗'));
    }
  }
  console.log('  （平均R = 两笔的均值，所以可与基线的单笔 R 直接比较）');

  console.log('\n（把「五」「七」里最佳组合的 回踩/窗口 拿到另一品种跑一遍：跨品种同号且 t≥2 才算数）');
})();
