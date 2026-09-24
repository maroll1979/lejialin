/* 真实 5 年回测端到端验证（Node 直跑 strategy.js） */
const S = require('./strategy.js');
const sym = process.argv[2] || 'BTCUSDT';
const t0 = Date.now();
const fmt = t => new Date(t * 1000).toISOString().slice(0, 10);
S.backtest(sym, 5, {
  onPhase: (ph, p, txt) => {
    const bar = '#'.repeat(Math.round(p * 24)).padEnd(24, '-');
    process.stdout.write('\r[' + ph + '] ' + bar + ' ' + (p * 100).toFixed(1) + '%  ' + (txt || '') + '        ');
  },
}).then(r => {
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const cnt = {};
  r.trades.forEach(t => { cnt[t.how] = (cnt[t.how] || 0) + 1; });
  console.log('\n\n========== 5 年回测 · ' + sym + ' ==========');
  console.log('耗时 ' + dt + 's · 5m K线 ' + r.bars + ' 根 · 分段 ' + r.segTotal + '（失败 ' + r.segFailed + '）');
  console.log('区间 ' + fmt(r.from) + ' → ' + fmt(r.to) + '（' + r.years.toFixed(2) + ' 年）');
  console.log('触发 ' + r.trigCount + ' 次 → 成交 ' + r.count + ' 笔（跳过 ' + r.skipped + '）');
  console.log('胜率 ' + (r.winRate * 100).toFixed(1) + '%  (' + r.wins + '胜 / ' + r.losses + '负)');
  console.log('累计 ' + r.totalR.toFixed(1) + 'R · 期望 ' + r.avgR.toFixed(3) + 'R/笔 · 盈亏比 ' + (r.profitFactor || 0).toFixed(2));
  console.log('  其中 毛利 ' + r.grossR.toFixed(1) + 'R（' + (r.grossR / r.count).toFixed(3) + 'R/笔） · 手续费 ' + (-r.feeR).toFixed(1) + 'R（' + r.avgFeeR.toFixed(3) + 'R/笔）');
  console.log('  平均止损宽度 = 入场价的 ' + (r.avgRiskPct * 100).toFixed(2) + '%');
  console.log('权益 ' + r.finalEq.toFixed(0) + '（起始 10000）· 年化 ' + (r.annRet * 100).toFixed(1) + '% · 最大回撤 ' + (r.maxDD * 100).toFixed(1) + '%');
  console.log('平均持仓 ' + r.avgHoldHours.toFixed(1) + ' 小时 · 多 ' + r.longCount + ' / 空 ' + r.shortCount);
  console.log('出场分布 ' + JSON.stringify(cnt));
}).catch(e => { console.error('\n[X] ' + (e && e.message || e)); process.exit(1); });
