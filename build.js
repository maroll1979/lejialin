/* 构建脚本：把 src/ 下的分块源码按文件名顺序拼成单一 app.js，并可产出部署目录。
 *
 * 为什么用「拼接」而不是 ES Module：
 *   这是一个只有一个 <script src="app.js"> 的静态页，改 ESM 会引入 file:// 打不开、
 *   旧浏览器不认 type=module、测试要用 import 重写等一系列问题。拼接保留了单文件部署的
 *   简单性，同时让源码按职责分文件 —— 改热力图就只开 12-heat.js，不用在 5000 行里翻。
 *
 * 顺序即依赖顺序：文件名前缀是排序键，新增文件请按职责插入合适位置，
 * 不要引用「排在后面」的文件里在加载期（顶层）就要用的 const / let。
 *
 * 用法：
 *   node build.js              生成 app.js
 *   node build.js dist-v6      生成 app.js 并产出部署目录 dist-v6
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');

function build() {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
  if (!files.length) throw new Error('src/ 下没有 .js 源文件');
  const parts = files.map(f => {
    const p = path.join(SRC, f);
    const code = fs.readFileSync(p, 'utf8');
    if (!code.endsWith('\n')) throw new Error(`${f} 未以换行结尾，拼接后会与下一文件首行粘连`);
    return code;
  });
  const out = parts.join('');
  const target = path.join(ROOT, 'app.js');
  fs.writeFileSync(target, out, 'utf8');
  const lines = out.split('\n').length - 1;
  console.log(`app.js  ← src/ (${files.length} 个文件)  ${(out.length / 1024).toFixed(1)} KB · ${lines} 行`);
  files.forEach(f => process.stdout.write('         · ' + f + '\n'));
  return out;
}

function dist(dir) {
  const out = path.join(ROOT, dir);
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['index.html', 'app.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  }
  console.log(`${dir}/  ← index.html + app.js`);
}

const arg = process.argv[2];
build();
if (arg) dist(arg);
