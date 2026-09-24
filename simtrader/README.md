# SimTrader · 永续模拟交易看板（多空清算图 + 多空热力图）

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
| `liq-map.js` | **多空清算图**：抓 Gate 强平单 → 按价位聚合 → K 线左侧绘图 + 关键价位虚线标注 |
| `lsmap.js` | **多空热力图**：按价位分档的背靠背分布图（真实爆仓 + 潜在强平推算），窗口 实时/5m/15m/1h/4h |

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

图表头部有「清算图」开关，关闭后 K 线占满宽度；旁边的 **24h / 3天 / 7天** 切统计窗口；
美债等无永续合约的品种自动关闭。

### 历史爆仓会保留

抓到的强平订单写入 localStorage `simtrader_liq_v1`（按合约保留 **7 天**），启动顺序是：

1. 先把本地已累积的历史画出来（**打开页面即可见，不必等网络**）
2. 补齐最近 24 小时
3. 后台分块回补，一直往前补到 7 天（每次 24 小时，补完落盘再补下一段）

写满配额时逐级裁剪而不是静默丢弃（先砍条数、再丢其它合约的旧缓存）。
面值 `quanto_multiplier` 也进缓存，否则离线那一瞬间金额会全算成 0。

## 多空热力图（订单簿口径）

数据 = 永续订单簿在**现价上下 N 个 tick** 内的挂单分布。面板按价位分档画**背靠背柱**：
**价格下方的买盘挂单向左（绿，多头阵营）**、**价格上方的卖盘挂单向右（红，空头阵营）**，
中间竖线是多空分界，蓝线是现价，左右是价格刻度（右侧标出相对现价百分比）。
可**滚轮上下缩放**（以光标所在价位为锚）、**按住拖动平移**、**双击复位**。

**视野**：`±200` / `±500`（默认）/ `±2000` / `±5000` tick。tick 取合约的 `order_price_round`
（BTC 0.1、ETH 与 XAU 0.01、BNB 0.05、PAXG 0.1），所以 ±500 tick 对应的实际幅度随品种变化很大
（BTC 约 ±50 USDT / 0.06%，BNB 约 ±25 USDT / 3.26%）。

**柱长** = 该价位区间内的挂单名义金额 = `张数 × quanto_multiplier × 价位`（USDT）。

> ⚠ **挂单 ≠ 未平仓合约（OI）**。订单簿上的挂单是尚未成交的委托，随时可撤改；
> OI 是已成交未平仓的持仓。右侧卡片里 OI 单独一行并标注来源，不与挂单量混排。

### 订单簿接口的两个硬限制（改这块前必须知道）

1. **单侧最多 300 档**：`limit` > 300 直接报 `TOO_BIG: limit 300`
2. **`interval`（价格分组粒度）只接受离散值** `{0} ∪ {1,5}×10^k`
   —— `interval=2`、`20` 会返回 `INVALID_PARAM_VALUE: Invalid request parameter interval value`

实测覆盖（BTC，tick=0.1）：

| interval | 覆盖范围 | 粒度 |
| --- | --- | --- |
| `0`（原始价位） | ±1600~2100 tick | 每个 tick 可见 |
| `1` | ±3600 tick | 10 tick/格 |
| `5` | ±15000 tick | 50 tick/格 |

所以代码里做了**粒度自适应**：按当前视野估算需要的 tick 数 → 选最小够用的 interval →
取回来发现覆盖不够就换更粗的重取（最多 4 次）。滚轮缩小到超出覆盖范围会自动取更深的簿，
放大回来则换回更细粒度。分档用的是同一份订单簿重新分桶，**不重新联网**。

标注线：最厚买盘墙、最厚卖盘墙、24h 高低（落在视野内才画）、现价；标签按 y 排序自动下推防重叠。
右侧 10 张卡片：盘口方向（按挂单失衡）、买/卖盘挂单量与占比、买卖挂单比、最厚买盘墙/卖盘墙、
**真实未平仓合约（来自 tickers，标注「非挂单」）**、资金费率、现价/标记价、买一/卖一与价差。

真实发生的爆仓走势仍保留在 **K 线左侧的多空清算图**（`liq-map.js`，按 24h/3天/7天 统计真实强平单）。

### 为什么不是 CoinGlass

最初想直接抓 `https://www.coinglass.com/zh`，实测**免密抓不到**：网页自身数据走签名接口，
`capi.coinglass.com`（官网自用域名，不是 API 域名）返回 Spring 风格 404 或空壳
`{"code":"0","msg":"success","success":true}`。

后来拿到一枚 CoinGlass API Key 实测，结论是 **Key 有效、但账号没有套餐**：

- Host 用 `open-api-v4.coinglass.com`，Header 必须是 **`CG-API-KEY`**
  （v3 时代的 `coinglassSecret` 已不认，会回到 `API key missing`）
- 带上 Key 后**所有端点**都返回 `{"code":"401","msg":"Upgrade plan"}`，
  连最基础的 `/api/futures/supported-coins`、`/api/index/fear-greed-history` 都一样
- 路径写错会返回 `404 Endpoint not found`——用这个可以区分「路径不对」和「套餐不够」

**CoinGlass 没有免费额度**（2026-09 官方价）：Hobbyist $29/月、Startup $79/月、
Standard $299/月、Professional $699/月；速率 30/80/300/1200 次每分钟。
Hobbyist 拿不到 1 小时粒度历史，要 1h 历史至少 Startup。

所以改用 **Gate.io 自身的公开真实多空/强平数据**——同样是交易所平台的真实数据，不是合成价，
只是覆盖 Gate 一家而不是全市场聚合。

> 若将来接 CoinGlass：这是纯静态站没有后端，**Key 写进 JS 等于公开**（F12 就能拿走）。
> 真要接就走后端代理，Key 放服务端。相关端点路径见 `docs.coinglass.com/reference/endpoint-overview`
> 的 Liquidation / Long-Short Ratio 两类（`liquidation/heatmap/model1|2|3`、`liquidation/map`、
> `liquidation/order` 等），别再猜路径。

## K线交互

鼠标**滚轮上下缩放**、**按住图表左右拖动平移**、Shift+滚轮横向滚动、拖动时间轴/价格轴缩放、
双击轴复位；也可用图表头部的「－ / ＋ / 复位」按钮。

关键：**数据自动刷新不再重置缩放位置**。`paintChart()` 只在「换品种 / 换周期」时
`fitContent()`，之后刷新都保留用户当前视图（此前每次刷新都会 fitContent，
缩放完一刷新就被打回原样，看起来像"缩放无效"）。

## 止盈止损的三套盈亏比口径

卡片底部同时给出三个数，三者不一致时以**扣费净口径**为准：

| 口径 | 基准 | 含义 |
| --- | --- | --- |
| 参考价口径 | 方案参考价 P | 旧口径，未扣费；会低估实际风险 |
| 预计入场价口径 | 入场区中点 | 挂单实际面对的风险收益 |
| 扣费净口径 | 入场区中点 | 再扣掉开仓 + 平仓两道手续费（市价 0.10% / 限价 0.05%） |

差额可能很大：PDF 审计的截图例子里，做空时参考价口径是 1:1.00，换成入场区中点口径是 1:1.86。

另外两处已按审计结论修正：
- **`maxAtrK` 是最终风险的硬上限**，ATR 回退分支同样受它约束（此前只筛结构止损，
  指标系数叠加后可能突破，例如 4h 的 2.4 × 1.15 × 1.08 = 2.98 > 2.8）
- 卡片右侧正负百分比**按持仓方向折算**（做空时价格下跌才是盈利，止损显示负值、止盈显示正值），
  不再是单纯的价格方向距离
- 综合价标注了**归一化权重明细**（哪几个周期、各占多少），并写明它只是加权参考值，
  不是另行识别的支撑压力位

## 测试

```bash
node tests/test-liq-map.js        # 抓真实 Gate 数据校验聚合与绘图（需联网）
node tests/test-lsmap.js          # 多空热力图：分档复算 / 5 个窗口 / 图层 / 缩放拖动（需联网）
node tests/test-liq-app.js        # mock DOM 加载真实 app.js 跑 boot 冒烟
node tests/test-liq-history.js    # 模拟「关掉页面再打开」，验证历史爆仓仍在（需联网，约 40s）
node tests/test-tpsl.js           # 止盈止损三口径与 maxAtrK 硬上限（需联网）
```

脚本都用 `path.join(__dirname, '..')` 取源码，**从任意目录运行都可以**。
`test-liq-*.js` / `test-lsmap.js` 会真实联网；若本机只走代理，用 `NODE_USE_ENV_PROXY=1 node tests/xxx.js`。
网络不通时这几个脚本会 `fetch failed`（不是代码问题），可先
`curl https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT` 确认
（不要用 `/futures/usdt/time` 探活——它本身返回 400 且不带 CORS 头，会误判成不可用）。

## 部署注意

改了 `style.css` 或 `app.js` 后，**必须同步 bump `index.html` 里的 `?v=` 版本号**，
否则线上可能仍是旧文件；校验线上内容时再加一个独立 cache-buster `?cb=$(date +%s)`，
只靠 `?v=` 同一个值仍可能被 CDN 缓存。
