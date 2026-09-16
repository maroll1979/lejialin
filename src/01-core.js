/* Market Board v1.0 — 多平台行情聚合 / 指标演算 / 模拟下单提示
 * 说明：本文件不连接任何真实交易账户，不具备自动下单能力。 */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const fmt = (n, d = 2) => (n == null || !isFinite(n)) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();

/* ============================ 品种定义 ============================ */
// vol = 日化波动率（用于合成 K 线的尺度），dp = 小数位
// perp = 各交易所「永续合约」代码；null 表示该平台无此品种的永续合约
const SYMS = {
  BTC:    { id:'BTC',    label:'BTC',    cn:'比特币',      cg:'bitcoin', vol:0.026, dp:2, min:0.01,
            perp:{ binance:'BTCUSDT', okx:'BTC-USDT-SWAP', bybit:'BTCUSDT', gate:'BTC_USDT', bingx:'BTC-USDT' } },
  ETH:    { id:'ETH',    label:'ETH',    cn:'以太坊',      cg:'ethereum', vol:0.033, dp:2, min:0.01,
            perp:{ binance:'ETHUSDT', okx:'ETH-USDT-SWAP', bybit:'ETHUSDT', gate:'ETH_USDT', bingx:'ETH-USDT' } },
  BNB:    { id:'BNB',    label:'BNB',    cn:'币安币',      cg:'binancecoin', vol:0.031, dp:2, min:0.01,
            perp:{ binance:'BNBUSDT', okx:'BNB-USDT-SWAP', bybit:'BNBUSDT', gate:'BNB_USDT', bingx:'BNB-USDT' } },
  XAUUSD: { id:'XAUUSD', label:'XAU/USD',cn:'伦敦金',      vol:0.009, dp:2, min:0.01, gold:true,
            perp:{ binance:'XAUUSDT', okx:'XAU-USDT-SWAP', bybit:'XAUUSDT', gate:'XAU_USDT', bingx:'XAUT-USDT' } },
  // 布伦特：加密所中仅 BingX 挂出永续；其余平台无永续，故支持源较少
  UKOIL:  { id:'UKOIL',  label:'BRENT',  cn:'布伦特原油',  yh:'BZ=F', vol:0.019, dp:3, min:0.001, oil:true,
            perp:{ binance:null, okx:null, bybit:null, gate:null, bingx:'NCCO1OILBRENT2USD-USDT' } },
};
const SYM_LIST = Object.values(SYMS);

// okx / bybit / bingx = 各平台永续 K 线的周期参数
const TFS = [
  { k:'15m', label:'15分钟', m:15,  yh:'15m', yr:'5d',  okx:'15m', bybit:15,  bingx:'15m' },
  { k:'30m', label:'30分钟', m:30,  yh:'30m', yr:'10d', okx:'30m', bybit:30,  bingx:'30m' },
  { k:'1h',  label:'1小时',  m:60,  yh:'60m', yr:'1mo', okx:'1H',  bybit:60,  bingx:'1h'  },
  { k:'4h',  label:'4小时',  m:240, yh:'1h',  yr:'3mo', okx:'4H',  bybit:240, bingx:'4h', agg:4 },
];
const TF_MAP = Object.fromEntries(TFS.map(t => [t.k, t]));

