/** Executes the compiled production bootstrap; instrumentation does not replace callbacks. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { installIoGuard } from './io-guard.mjs';
const [source, ready] = process.argv.slice(2);
assert(source && ready && process.argv.length===4);
assert(process.env.OXY_RUNTIME_MODE === 'rollback-auth-only' && process.env.PORT === '18002');
assert(['test','production'].includes(process.env.NODE_ENV) && !existsSync(resolve('.env')));
const require = createRequire(join(source,'packages/api/package.json'));
installIoGuard(require,ready+'.external.json');
const intervals=[];
const originalInterval=globalThis.setInterval;
globalThis.setInterval=function(callback,delay,...args) {
 const stack=new Error().stack.split('\n').slice(2).map(line=>line.trim());
 intervals.push({delay,stack});
 return originalInterval(callback,delay,...args);
};
const runtime=require(join(source,'packages/api/dist/server.js'));
const attestation=require(join(source,'packages/api/dist/services/workloadAttestation.service.js'));
attestation.registerAttestationVerifier({provider:'aws-iam',verify:async(payload,nonce)=>{
 assert(payload?.answersNonce===nonce && payload.subject==='rollback-owned-workload');
 return {provider:'aws-iam',subject:payload.subject,attestationId:attestation.workloadAttestationHandle(payload.subject)};
}});
await runtime.bootstrap();
const ownIntervals=intervals.filter(row=>row.stack.some(line=>line.includes('/packages/api/dist/')));
const allowed=['utils/sessionCache.js','utils/userCache.js','services/loginLockout.service.js','config/redis.js'];
for(const row of ownIntervals) assert(allowed.some(file=>row.stack[0]?.includes(file)) || row.stack[0]?.includes('at MemoryStore.init ('),JSON.stringify(row));
assert(ownIntervals.some(row=>row.stack[0].includes('sessionCache.js')));
assert(ownIntervals.some(row=>row.stack[0].includes('userCache.js')));
writeFileSync(ready,JSON.stringify({pid:process.pid,port:18002,compiledBootstrap:true,nodeEnv:process.env.NODE_ENV,intervals:ownIntervals}),{mode:0o600,flag:'wx'});
