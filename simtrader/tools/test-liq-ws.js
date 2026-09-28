const WebSocket = require('ws');
const ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
ws.on('open', () => {
  console.log('open');
  ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.liq_orders', event: 'subscribe', payload: ['BTC_USDT'] }));
});
ws.on('message', m => console.log('MSG', String(m).slice(0, 500)));
ws.on('error', e => console.log('ERR', e.message));
setTimeout(() => { try { ws.close(); } catch (e) {} process.exit(0); }, 15000);
