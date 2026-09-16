/* 测试总入口：一次跑完全部用例。
 * jsdom 装在受管的 node workspace 下，用 NODE_WORKSPACE 指过去即可（见 README 说明）。
 * 用法：node tests/run.js  [--live]   （--live 会额外跑联网用例 _live.js / _liq_live.js） */
const { spawnSync } = require('child_process');
const path = require('path');

const UNIT = ['_test.js', '_fuse.js', '_heat.js', '_liq.js', '_entry.js', '_kmerge.js', '_domid.js', '_auto.js', '_build.js'];
const DOM = ['_smoke.js', '_heat_dom.js', '_auto_dom.js', '_gate.js', '_replay.js'];
const LIVE = ['_live.js', '_liq_live.js'];

const files = [...UNIT, ...DOM, ...(process.argv.includes('--live') ? LIVE : [])];
let failed = [];

for (const f of files) {
  const p = path.join(__dirname, f);
  console.log('\n──────── ' + f + ' ────────');
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed.push(f);
}

console.log('\n════════ 汇总 ════════');
if (failed.length) { console.log('失败：' + failed.join(', ')); process.exit(1); }
console.log(`全部通过（${files.length} 个文件）`);
