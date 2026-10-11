import { writeFileSync } from 'node:fs';
export function installIoGuard(require, receipt) {
  const allowed = new Set([5598, 5599, 17974, 17975]);
  let externalAttempts = 0;
  writeFileSync(receipt, JSON.stringify({ externalAttempts }), { mode: 0o600, flag: 'wx' });
  function check(host, p) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(Number(p))) {
      externalAttempts++;
      writeFileSync(receipt, JSON.stringify({ externalAttempts }), { mode: 0o600 });
      throw new Error('rollback_external_io_denied');
    }
  }
  const net = require('node:net');
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    if (options && typeof options === 'object') check(options.host ?? 'localhost', options.port);
    else check(typeof args[1] === 'string' ? args[1] : 'localhost', options);
    return originalConnect.apply(this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    check(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80));
    return originalFetch(input, init);
  };
}
