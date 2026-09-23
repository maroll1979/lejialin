> **lejialin** — mybestAI
> <sub>（仓库创建时的原始说明，已保留）</sub>

## 仓库导航

本仓库目前存放两个**互相独立**的静态站点，代码不共用：

| 目录 | 项目 | 线上地址 |
| --- | --- | --- |
| 仓库根目录（`src/` + `build.js` + `app.js`） | **Market Board** · 五品种永续行情看板 | https://e6cf4c9fa8d941b6b5dcebf2b00f82a9.app.workbuddy.host |
| [`simtrader/`](simtrader/) | **SimTrader** · 永续模拟交易看板（含多空清算图） | https://ab382104b589442e974dd50ce7cf9965.app.workbuddy.host |

---

# Market Board · 五品种永续行情看板

纯前端静态站点，**无后端**。源码按 `src/` 分模块编写，用 `build.js` 拼成单文件 `app.js`，
产物与 `index.html` 一起即可直接部署；双击 `index.html` 也能跑。

线上地址：https://e6cf4c9fa8d941b6b5dcebf2b00f82a9.app.workbuddy.host

## 功能

- **五品种**：BTC / ETH / BNB / 伦敦金(XAU) / 布伦特原油，永续合约行情
- **四周期融合决策**：`4h 定趋势 → 1h 筛选机会 → 30m 观察回调 → 15m 触发进场`，
  四层全部通过才给方向，任一层不通过即观望。页面顶部结论与模拟盘共用同一个 `mtfDecision()`
- **五因子技术面**：结构（摆动高低点）· MACD · OBV · BOLL · KDJ(9,3,3)，权重 22 / 16 / 14 / 14 / 12，
  外加清算因子（仅做 ±32% 幅度修正，翻不了技术面正负号）
- **因子同源折减**：MACD / KDJ / BOLL / 结构吃同一份 OHLC，按组内相关折扣折算成
  「有效独立证据份数」，堆同源指标涨不上一篮子分数（详见下方「口径」）
- **清算热力图**：点阵渲染 + 清算区间虚线框与价格数字标注；默认是基于成交量与杠杆假设的
  **潜在清算区模型**，只有真实链路（CoinGlass / AiCoin）才标注为「历史爆仓记录」
- **扫单倾向**：只给 高 / 中 / 低 三档，未经历史样本校准，**不显示概率**
- **自动交易（模拟盘）**：按融合决策开仓，含滑点、跳价、资金费、K 线区间双路径出场、
  强平线、账户权益与风险预算约束；单据永不清除并按天归档，支持 CSV 导出
- **历史回放**：样本内 / 样本外分段验证
- **多平台报价**：多源实时报价中位数，最小差价阈值 0.1% 提示
- **实时数据链路**：7 条转发通道 + 通道打分排序（直连优先、单通道 3 秒上限）

## 数据来源

全部为**公开行情接口实时拉取**，不使用任何合成/离线数据：

- K 线：Binance Futures `fapi.binance.com`
- 报价：Binance / OKX / Bybit 等永续合约公开接口
- 贵金属与原油：Yahoo Finance 公开接口
- 浏览器直连受 CORS 限制时自动切换转发通道（AllOrigins / CodeTabs / ThingProxy / cors.lol / corsproxy）

取数失败时显示 `—` 并在顶部弹出告警条 + 指数退避重试，**绝不用编造数据顶替**；
报价过期、K 线断档或四周期不齐备时禁止开仓。

## 目录结构

```
.
├── index.html      界面骨架 + 全部 CSS
├── app.js          构建产物（由 src/ 拼接，勿直接编辑）
├── build.js        拼接脚本：src/*.js → app.js，带字节级一致校验
├── package.json    构建 / 测试脚本入口
├── src/            源码模块（真正的编辑对象）
│   ├── 01-core.js       工具、常量、格式化
│   ├── 02-net.js        网络层与转发通道
│   ├── 03-state.js      全局状态
│   ├── 04-quotes.js     多源报价
│   ├── 05-klines.js     K 线拉取与按时间戳合并
│   ├── 06-indicators.js 指标计算
│   ├── 07-fusion.js     五因子融合、同源折减、扫单倾向、校准闸门
│   ├── 08a-mtf.js       四周期融合决策
│   ├── 08-plan.js       交易计划四价位
│   ├── 09-chart.js      K 线与热力图绘制
│   ├── 10-render.js     界面渲染
│   ├── 11-aicoin.js     AiCoin 清算数据
│   ├── 12-heat.js       清算热力图与模型假设
│   ├── 13-overview.js   总览
│   ├── 14-trade.js      手动交易
│   ├── 15-bind.js       事件绑定
│   ├── 16-loop.js       主循环
│   ├── 17-auto.js       模拟盘执行（滑点/强平/资金费/仓位预算）
│   ├── 18-replay.js     历史回放
│   └── 19-sec.js        安全与输入校验
├── versions/       历史版本备份（每目录均为可独立部署的完整站点）
├── aicoin/         AiCoin AIScript 指标（独立于本站点，粘贴到 AiCoin 自定义指标中使用）
│   ├── AiCoin-VP24-使用说明.md        参数、安装、备选写法、已知限制
│   ├── AiCoin-VP24-滚动窗口版.txt     最近 N 根滚动计算（推荐先试这版）
│   └── AiCoin-VP24-每日08点重置版.txt 每日 08:00 起算（需 hour() 与自引用支持）
├── tools/          Python 侧工具链（生成与验证 AIScript 指标）
│   ├── gen_vp24.py         生成两版 AIScript 源码
│   ├── aiscript_runner.py  迷你 AIScript → Python 转译器
│   ├── e2e_run_generated.py 直接执行生成的代码并校验数值约束
│   ├── verify_vp24.py      与暴力参考实现逐位对比
│   ├── verify_session.py   验证每日 08:00 重置与 MIN_BARS 过滤
│   └── bench_va.py         分位数法 vs 行业标准贪心法差异实测
├── docs/
│   └── 验收报告-2026-09-16.md   P0/P1/P2 验收清单逐项核对结果
└── tests/          Node 测试套件（14 个，共 1000+ 项断言）
    ├── run.js           全量运行器
    ├── _test.js         基础指标
    ├── _fuse.js         融合、同源折减、扫单校准闸门
    ├── _heat.js         清算模型与假设披露
    ├── _liq.js / _liq_live.js   清算区间（含真实链路）
    ├── _kmerge.js       K 线时间戳合并
    ├── _entry.js        建仓提示
    ├── _gate.js / _auto.js / _auto_dom.js   模拟盘（闸门 / 计算 / 端到端）
    ├── _replay.js       回放
    ├── _smoke.js / _heat_dom.js             DOM 端到端
    ├── _build.js        构建守卫 + 产物一致性（检测到直改 app.js 时报错）
    └── _domid.js        DOM id 一致性校验工具
```

## 运行

```bash
# 方式一：直接打开
start index.html

# 方式二：起个本地静态服务（推荐，避免 file:// 下的 fetch 限制）
python -m http.server 8000
# 然后访问 http://localhost:8000
```

## 开发

```bash
node build.js          # src/*.js → app.js（逐字节校验）
node build.js dist-v5  # 同时产出部署目录
node tests/run.js      # 全量 14 个套件
```

改代码请改 `src/` 下的模块，再跑 `node build.js`；直接改 `app.js` 会被
`_build.js` 守卫拦下，且下次构建会被覆盖。

## 测试

```bash
cd tests
npm i jsdom          # 仅 DOM 类测试需要
node run.js          # 全量
```

## AiCoin 指标：VP-24 成交量分布（独立工具）

与本站点无关的独立产物，供 AiCoin 自定义指标使用。价格分 24 档，按成交量分布定价值区：

- 中间 70% 成交量为价值区，**VAH 之上为做空区，VAL 之下为做多区**，另给 POC
- 两个版本：滚动窗口版（最近 N 根）与每日 08:00 重置版

实现约束与取舍（详见 `aicoin/AiCoin-VP24-使用说明.md`）：

- AIScript 公开资料中**无 for 循环与数组**，24 档展开为独立标量，价值区查找用「累加步进」
- 因此采用**分位数口径**（上下各切 15%）而非 TradingView 常用的「从 POC 向两侧贪心扩展」；
  实测在真实感分布下两者相差 0~2 个档位，分位数语义也更贴近「70% 上方/下方」的原始描述
- 成交量按 K 线区间与档位的**重叠比例摊分**，而非整根重复计入（后者偏差最高 35%）
- `high == low` 的一字线按价格是否落档判断，避免成交量丢失
- 会话版带 `MIN_BARS` 过滤，避免 08:00 刚重置时区间过窄刷假信号

验证方式：本仓库无法直接执行 AIScript，故用 `tools/aiscript_runner.py` 把生成的源码
转译成 Python 逐根 K 线执行，校验 `lo ≤ VAL ≤ POC ≤ VAH ≤ hi` 等约束。

```bash
python tools/gen_vp24.py           # 生成两版源码
python tools/e2e_run_generated.py  # 转译执行 + 数值约束校验
python tools/verify_vp24.py        # 与暴力参考实现逐位对比（应 0.0000%）
python tools/verify_session.py     # 每日 08:00 重置逻辑
python tools/bench_va.py           # 分位数法 vs 贪心法差异
```

需用户确认的平台函数：`highest/lowest`（备选 `hhv/llv`）、`sum`、`max/min`、`na`。

## 口径与免责

这一节是刻意写在这儿的——页面上的每个数字该怎么读，都在这里：

- **因子一致度** = 参与评分的因子中同方向因子的占比，衡量证据的一致性，**不是胜率**。
  MACD / KDJ / BOLL / 结构同源，四个同向不等于四份独立验证，因此另给「独立口径」与
  「有效独立证据 X 份」两个折算后的数字。
- **扫单倾向**（高 / 中 / 低）由固定公式拼出，**未经历史样本校准，不是概率**。
  代码里留了 `SWEEP_CALIB` 闸门：只有凑够 200 笔样本、且填了各档实测频率，才允许显示百分比。
- **清算热力图**默认是「基于成交量与杠杆假设的潜在清算区模型」，页面上有独立的
  「模型假设与偏差」面板披露五条关键假设（成交量 ≠ 未平仓量、收盘位置不能定真实开仓方向等）。
  只有真实链路数据才标为「历史爆仓记录」。
- **模拟盘**有独立的「模拟盘假设与偏差」面板，分列已计入（手续费、滑点、资金费、双路径出场、
  四条仓位约束、强平线）与仍未计入（无盘口深度、资金费时变未跟踪、不模拟延迟宕机、
  止盈按 taker 偏保守、错过档位不补开、逐仓不交叉）。
- 浏览器关闭期间无法运行；重新打开时**按规则不补开错过的档位**（记为「错过档位」，
  不会用重开时刻的价格与信号去回填历史）。
- 自动交易为**纯模拟盘**，不连接任何交易所 API，不产生真实成交。
- 行情数据仅供参考，不构成投资建议。
