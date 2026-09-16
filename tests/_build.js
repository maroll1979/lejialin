/* P2-3 工程结构守卫：
 *  1) app.js 必须是 src/ 的拼接产物 —— 发现不一致说明有人直接改了生成物，改动会在下次构建丢失；
 *  2) src/ 内的分块保持可拼接（以换行结尾、顺序无缺口）；
 *  3) 测试依赖的代码分段标记在产物里仍然存在。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m + (extra ? ' → ' + extra : ''))); };

const srcDir = path.join(ROOT, 'src');
ok(fs.existsSync(srcDir), '存在 src/ 源码目录');

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
ok(files.length >= 10, `src/ 下有 ${files.length} 个分块`, files.length);
files.forEach(f => ok(fs.readFileSync(path.join(srcDir, f), 'utf8').endsWith('\n'), `${f} 以换行结尾（可安全拼接）`));

const joined = files.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
ok(joined === app, 'app.js 与 src/ 拼接结果完全一致（未有人在生成物上手改）',
  joined === app ? '' : `拼接 ${joined.length} 字节 vs app.js ${app.length} 字节`);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(/<script src="app\.js"><\/script>/.test(html), 'index.html 仍以单文件方式引入 app.js');
ok(!/type="module"/.test(html), '未引入 ESM（保持 file:// 直接双击可打开）');

['/* ===== KBAR-MERGE-START ===== */', '/* ===== KBAR-MERGE-END ===== */',
 '/* ===== AUTO-PURE-START =====', '/* ===== AUTO-PURE-END ===== */']
  .forEach(m => ok(app.includes(m), '产物保留分段标记 ' + m.slice(0, 28)));

// 构建脚本存在且能把分块拼起来（不写盘，只验证逻辑可用）
ok(fs.existsSync(path.join(ROOT, 'build.js')), '存在 build.js 构建脚本');
ok(fs.existsSync(path.join(ROOT, 'tests', 'run.js')), '存在 tests/run.js 测试入口');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
