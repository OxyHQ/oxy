/** Isolated SDK receiver. IPC is memory-only; no bearer in env/args/files/logs. */
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

export async function createCanaryReceiver({ apiPackage, baseURL, principalId, bearer }) {
  const require = createRequire(apiPackage);
  const { OxyServer } = require('@oxy.so/core/server');
  const { configureLogger } = require('@oxy.so/core/logger');
  configureLogger({ level: 'silent' });
  const express = require('express');
  let directory = dirname(require.resolve('@oxy.so/core/server')), coreVersion;
  for (let depth=0; depth<5; depth++, directory=dirname(directory)) {
    const metadata=join(directory,'package.json');
    if (existsSync(metadata)) { const value=JSON.parse(readFileSync(metadata,'utf8')); if (value.name==='@oxy.so/core') { coreVersion=value.version; break; } }
  }
  if (coreVersion !== '4.2.0') throw new Error('unexpected_core_version');
  const oxy = new OxyServer({ baseURL, serviceIdentity: 'when-anonymous' });
  let effectCount = 0;
  const app = express();
  // Default middleware always fresh; only the explicit prewarm is read-only cached.
  app.post('/effect', oxy.middleware.auth(), oxy.middleware.requireScope('inference:invoke'), (_req, res) => {
    effectCount++; res.json({ effectCount });
  });
  const server = http.createServer(app);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('receiver_bind_failed');
  const decoded = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8'));
  async function probe() {
    const response = await fetch(`http://127.0.0.1:${address.port}/effect`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'X-Oxy-User-Id': principalId },
      redirect: 'error', signal: AbortSignal.timeout(5500),
    });
    const body = await response.json();
    if (response.status === 200 && Number.isSafeInteger(body.effectCount)) return { outcome: 'ALLOW', effectCount, status: 200, observedAtMillis: Date.now() };
    if (response.status === 403 && body.code === 'SERVICE_ACTING_AS_UNAUTHORIZED') {
      // Core uses the same refusal for network failure. Independently require a
      // successful authenticated oracle response, not a timeout disguised as DENY.
      const verifier = await oxy.serviceToken();
      const url = new URL('/internal/service-acting-as/verify', baseURL);
      for (const [key, value] of Object.entries({ appId: decoded.appId, userId: principalId,
        credentialId: decoded.credentialId, ownerAccountId: decoded.ownerAccountId, environment: decoded.environment })) url.searchParams.set(key,value);
      const check = await fetch(url, { headers: { Authorization: `Bearer ${verifier}` }, redirect: 'error', signal: AbortSignal.timeout(4500) });
      const result = await check.json();
      const data = result.data ?? result;
      if (check.status === 200 && data.authorized === false && Array.isArray(data.scopes) && data.scopes.length === 0
        && typeof data.epoch === 'string' && /^(?:0|[1-9][0-9]*)$/.test(data.epoch)) {
        return { outcome: 'DENY', effectCount, status: 403, observedAtMillis: Date.now() };
      }
    }
    return { outcome: 'ERROR', effectCount, status: response.status };
  }
  return {
    async warm() {
      const context = { cache: true, credentialId: decoded.credentialId, ownerAccountId: decoded.ownerAccountId, environment: decoded.environment };
      const granted = await oxy.verifyActingAs(decoded.appId,principalId,context);
      if (!granted?.authorized || !granted.scopes.includes('inference:invoke')) throw new Error('prewarm_denied');
      const verifier = await oxy.serviceToken();
      const claims = JSON.parse(Buffer.from(verifier.split('.')[1], 'base64url').toString('utf8'));
      if (!/^wl_[a-f0-9]{24}$/.test(claims.credentialId ?? '') || claims.credentialId === decoded.credentialId
        || claims.appId !== decoded.appId || claims.exp-claims.iat > 300) throw new Error('verifier_identity_mismatch');
      return { coreVersion, verifierCredentialId: claims.credentialId, cachePrewarmed: true, ...await probe() };
    },
    probe,
    async close() { bearer = ''; await new Promise(done => server.close(done)); },
  };
}
async function main() {
  let receiver;
  let chain = Promise.resolve();
  const send = data => process.send?.(data);
  process.on('message', message => { chain = chain.then(async () => {
    if (message.command === 'init') {
      receiver = await createCanaryReceiver(message.input);
      send({ id: message.id, result: await receiver.warm() });
    } else if (message.command === 'probe' && receiver) send({ id: message.id, result: await receiver.probe() });
    else if (message.command === 'close' && receiver) { await receiver.close(); send({ id: message.id, result: { closed: true } }); process.disconnect(); }
    else throw new Error('receiver_protocol_error');
  }).catch(() => send({ id: message.id, result: { outcome: 'ERROR', reason: 'receiver_failed' } })); });
  process.on('disconnect', () => { void receiver?.close(); });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
