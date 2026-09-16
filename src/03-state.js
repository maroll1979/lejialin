/* ============================ 状态 ============================ */
const S = {
  sym: localStorage.getItem('mb_sym') || 'BTC',
  tf: localStorage.getItem('mb_tf') || '1h',
  quotes: {},        // sym -> { rows:[], median, hi, lo, spread, spreadPct, ts, realCount }
  klines: {},        // sym -> { tf -> { bars:[], real:bool, stale:bool, staleSince:number } }
  kErr: {},          // "sym|tf" -> 最近一次取 K 线失败的原因，成功即清空
  venues: {},        // venueId -> { ok, ms, err }
  pos: JSON.parse(localStorage.getItem('mb_pos') || '[]'),
  side: 'long', type: 'market', lev: 10,
  hover: null,
  heat: null,        // 当前选中的热力图数据
  heats: {},         // sym -> tf -> heat：四格信号每个周期一份
  cgLiq: {},         // sym -> { list, ts }：Coinglass 真实清算记录缓存
  heatErr: '',       // Coinglass 取数失败原因
  acLiq: {},         // sym -> AiCoin 1 小时爆仓统计（real / 失败原因）
  kvCount: 130,      // K 线可视根数（滚轮缩放）
  kvEnd: null,       // K 线可视右端索引，null = 贴住最新；向左拖可回看历史
  drag: null,        // 平移中的拖拽状态
};
if (typeof window !== 'undefined') window.MB_STATE = S;   // 端到端测试访问状态

