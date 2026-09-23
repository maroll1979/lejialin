# SimTrader · 永续模拟交易看板（含多空清算图）

纯前端静态站点，**无后端、无构建步骤**。四个文件丢到任意静态服务器即可跑，
双击 `index.html` 也能用（数据靠浏览器直连 Gate.io，接口 CORS 全开）。

线上地址：https://ab382104b589442e974dd50ce7cf9965.app.workbuddy.host

> 本目录与仓库根目录的 **Market Board**（`src/` 分模块 + `build.js` 拼成根目录 `app.js`）
> 是**两个互相独立的项目**，代码不共用，可分别部署。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构与文案，含数据源说明 |
| `style.css` | 全部样式；K 线左侧清算图宽度由 `--liqw` 控制 |
| `app.js` | 主逻辑：行情拉取、K 线、模拟盘、比价面板 |
| `liq-map.js` | **多空清算图**：抓 Gate 强平单 → 按价位聚合 → 左侧绘图 + 关键价位虚线标注 |

## 数据源

**只有一家：Gate.io USDT 永续**（`https://api.gateio.ws/api/v4/futures/usdt/...`），
无现货兜底，取不到就显示离线快照。WebSocket 走 `wss://fx-ws.gateio.ws/v4/ws/usdt`，频道 `futures.trades`。

品种映射：`BTCUSDT→BTC_USDT`、`ETHUSDT→ETH_USDT`、`BNBUSDT→BNB_USDT`、`XAUUSDT→XAU_USDT`
（黄金走 XAU 永续；若不可用回落 `PAXG_USDT`，仍属永续口径）。

## 多空清算图

K 线图整体右移 118px，让出的左侧整条就是清算图：顶部是近 24h 多空爆仓总额，
下方是按价位分桶的横向强度条；强度最高的 5 个价位会自动画虚线横贯 K 线，
左端标注 `86,120 · 多头爆仓 $1.2M`，标签按 y 排序自动下推防重叠。

数据来自 Gate 公开强平接口 `GET /futures/usdt/liq_orders`。实测三个限制，改动前务必知道：

1. **`from`/`to` 窗口跨度不得超过 1 小时**，超出直接报
   `INVALID_PARAM_VALUE: range from/to must in 1 hour` → 代码按小时切片并发回溯
2. **没有强平 WebSocket 频道**，`futures.liq_orders` 订阅返回 `Unknown channel`（错误码 2）
   → 只能 REST 轮询（60s 增量拉最近 2h，手动全量回溯 24h）
3. `offset` 参数无效（不分页），`limit` 上限内返回该窗口全部记录

口径：
- `size < 0`（卖出成交）= **多头被强平**（绿）；`size > 0`（买入成交）= **空头被强平**（红）
- 名义金额 = `|张数| × quanto_multiplier × fill_price`，面值取自 `/futures/usdt/contracts/{contract}`
  （BTC 与 XAU 都是 0.0001）
- 实测 BTC 24h 约 700 笔、ETH 约 1200 笔

图表头部有「清算图」开关，关闭后 K 线占满宽度；美债等无永续合约的品种自动关闭。
缓存写 localStorage `simtrader_liq_v1`（按合约，保留 48h / 8000 条），切品种秒出图。

## 测试

```bash
node tests/test-liq-map.js    # 抓真实 Gate 数据校验聚合与绘图（需联网）
node tests/test-liq-app.js    # mock DOM 加载真实 app.js 跑 boot 冒烟
```

`test-liq-map.js` 会真实联网；若本机只走代理，用 `NODE_USE_ENV_PROXY=1 node tests/test-liq-map.js`。

## 部署注意

改了 `style.css` 或 `app.js` 后，**必须同步 bump `index.html` 里的 `?v=` 版本号**，
否则线上可能仍是旧文件；校验线上内容时再加一个独立 cache-buster `?cb=$(date +%s)`，
只靠 `?v=` 同一个值仍可能被 CDN 缓存。
