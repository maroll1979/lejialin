> **lejialin** — mybestAI
> <sub>（仓库创建时的原始说明，已保留）</sub>

# Market Board · 五品种永续行情看板

纯前端静态站点，**无任何后端、无构建步骤**。双击 `index.html` 即可运行，或部署到任意静态托管。

线上地址：https://e6cf4c9fa8d941b6b5dcebf2b00f82a9.app.workbuddy.host

## 功能

- **五品种**：BTC / ETH / BNB / 伦敦金(XAU) / 布伦特原油，永续合约行情
- **五因子技术面**：结构（摆动高低点）· MACD · OBV · BOLL · KDJ(9,3,3)，权重 22 / 16 / 14 / 14 / 12
- **清算热力图**：点阵渲染 + 清算区间虚线框与价格数字标注
- **做市商结论**：方向徽章 + 一句话结论 + 入场 / 止损 / 止盈① / 止盈② 四格价位 + 盈亏比
- **自动交易（模拟盘，仅 ETH）**：按做市商方向自动下单，保证金 1000 / 杠杆 10× / 盈亏比 1:1.5 / 每 30 分钟一档，到价自动止盈止损，单据永不清除并按天归档，支持 CSV 导出
- **多平台报价**：多源实时报价中位数，最小差价阈值 0.1% 提示
- **实时数据链路**：7 条转发通道 + 通道打分排序（直连优先、单通道 3 秒上限）

## 数据来源

全部为**公开行情接口实时拉取**，不使用任何合成/离线数据：

- K 线：Binance Futures `fapi.binance.com`
- 报价：Binance / OKX / Bybit 等永续合约公开接口
- 贵金属与原油：Yahoo Finance 公开接口
- 浏览器直连受 CORS 限制时自动切换转发通道（AllOrigins / CodeTabs / ThingProxy / cors.lol / corsproxy）

取数失败时显示 `—` 并在顶部弹出告警条 + 指数退避重试，**绝不用编造数据顶替**。

## 目录结构

```
.
├── index.html      界面骨架 + 全部 CSS（约 866 行）
├── app.js          全部逻辑：指标计算、多因子融合、绘图、数据链路、自动交易（约 4418 行）
├── versions/       历史版本备份
│   ├── dist/       第一版
│   ├── dist-v3/    第三版（去离线 + KDJ 五因子）
│   ├── dist-v4/    第四版（交易计划四价位 + 热力图点阵）
│   └── dist-v5/    当前线上版本
└── tests/          Node 测试套件（9 个，共 652 项断言）
    ├── _test.js        基础指标
    ├── _fuse.js        五因子融合
    ├── _heat.js        热力图
    ├── _liq.js / _liq_live.js   清算区间（含真实链路）
    ├── _entry.js       建仓提示
    ├── _smoke.js       DOM 端到端
    ├── _heat_dom.js    热力图 DOM
    ├── _auto.js / _auto_dom.js  自动交易（计算 / 端到端）
    └── _domid.js       DOM id 一致性校验工具
```

`versions/` 下每一个目录都是可以直接独立部署的完整站点（各含 `app.js` + `index.html`），
保留它们是为了回溯每一版改了什么，不是运行依赖。

## 运行

```bash
# 方式一：直接打开
start index.html

# 方式二：起个本地静态服务（推荐，避免 file:// 下的 fetch 限制）
python -m http.server 8000
# 然后访问 http://localhost:8000
```

## 测试

```bash
cd tests
npm i jsdom          # 仅 DOM 类测试需要
node _smoke.js
node _auto.js
```

## 说明

- 自动交易为**纯模拟盘**，不连接任何交易所 API，不产生真实成交。
- 浏览器完全关闭期间脚本无法运行；重新打开时按自然时间网格补齐错过的档位（标注「补单」，成交价取补单时刻真实市价）。
- 行情数据仅供参考，不构成投资建议。
