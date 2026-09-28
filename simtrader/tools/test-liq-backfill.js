// 验证 Gate 强平接口按 1 小时窗口回溯的可行性
const HOURS = 25;
const now = Math.floor(Date.now() / 1000);
const CONTRACTS = ['BTC_USDT', 'ETH_USDT', 'BNB_USDT', 'XAU_USDT'];

async function fetchWindow(contract, from, to) {
  const url = `https://api.gateio.ws/api/v4/futures/usdt/liq_orders?contract=${contract}&limit=1000&from=${from}&to=${to}`;
  const r = await fetch(url);
  if (!r.ok) return { err: r.status, from, to };
  const a = await r.json();
  return { n: a.length, from, to, sample: a[0] };
}

(async () => {
  for (const c of CONTRACTS) {
    const jobs = [];
    for (let h = 0; h < HOURS; h++) {
      const to = now - h * 3600;
      const from = to - 3600 + 1;
      jobs.push(fetchWindow(c, from, to));
    }
    const t0 = Date.now();
    const res = await Promise.all(jobs);
    const total = res.reduce((s, x) => s + (x.n || 0), 0);
    const errs = res.filter(x => x.err).length;
    console.log(`${c}: windows=${HOURS} total=${total} errs=${errs} ms=${Date.now() - t0}`);
    const cnt = res.filter(x => x.n > 0).length;
    console.log(`   有数据的窗口数=${cnt}/${HOURS}, 样例=${JSON.stringify(res.find(x => x.n > 0)?.sample || null)}`);
  }
})();
