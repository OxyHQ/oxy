import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Peable as EsmPeable } from '@peable.to/sdk';
const require = createRequire(import.meta.url);
const { Peable: CjsPeable } = require('@peable.to/sdk');
const prior = JSON.parse(readFileSync('/home/nate/Oxy/.agent-evidence/i04-handoff-i08-20261003/sdk-0.2.2-published/installed-byte-comparison.json','utf8'));
const root = new URL('./node_modules/@peable.to/sdk/', import.meta.url);
const expected = prior.files.filter((file)=>file.package==='sdk');
for (const file of expected) assert.equal(createHash('sha256').update(readFileSync(new URL(file.path,root))).digest('hex'), file.sha256);
assert.equal(expected.length,53);
assert.equal(JSON.parse(readFileSync(new URL('package.json',root),'utf8')).version,'0.2.2');
const rows = new Map();
const keys=[];
let creates=0,requests=0;
const server=createServer(async(req,res)=>{
 if (++requests>32) { res.writeHead(429).end();return; }
 const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 if(req.url==='/auth/service-token') { req.resume();reply(200,{data:{token:'synthetic-loopback-service',expiresIn:3600}});return; }
 if(req.url!=='/v1/checkout_sessions'||req.method!=='POST') { req.resume();reply(404,{});return; }
 assert.equal(req.headers.authorization,'Bearer synthetic-loopback-service');
 const chunks=[];for await(const chunk of req) chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks).toString());
 const key=req.headers['idempotency-key'];assert.equal(typeof key,'string');keys.push(key);
 const prior=rows.get(key);
 if(prior&&JSON.stringify(prior.params)!==JSON.stringify(body)) {
  reply(409,{error:{type:'idempotency_error',message:'Synthetic fixture parameter conflict'}});return;
 }
 const row=prior??{params:body,id:`cs_fixture_${++creates}`};rows.set(key,row);
 if(!prior) { setTimeout(() => { if (!res.destroyed) reply(200, {id:row.id}); }, 1500);return; } // commit observed, answer genuinely lost
 reply(200,{id:row.id,object:'checkout_session',paymentIntentId:`pi_${row.id}`,clientSecret:'synthetic-fixture',amount:body.amount,network:body.network,metadata:{},url:'https://fixture.invalid/checkout'});
});
await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
 for(const [format,Constructor] of [['ESM',EsmPeable],['CJS',CjsPeable]]) {
  const sdk=new Constructor({publicKey:'synthetic-loopback-public',secret:'synthetic-loopback-secret',baseURL:origin,oxyApiUrl:origin,requestTimeoutMs:100});
  const key=`i06-${format}-stable`;const params={amount:'100000',network:'testnet'};
  const before=creates;
  await assert.rejects(sdk.checkout.sessions.create(params,{idempotencyKey:key}),/Failed to reach the Peable Gateway/);
  const retry=await sdk.checkout.sessions.create(params,{idempotencyKey:key});
  const replay=await sdk.checkout.sessions.create(params,{idempotencyKey:key});
  assert.equal(retry.id,replay.id);assert.equal(creates,before+1);
  await assert.rejects(sdk.checkout.sessions.create({...params,amount:'200000'},{idempotencyKey:key}),(error)=>error.statusCode===409);
  assert.equal(creates,before+1);
  assert.deepEqual(keys.filter((value)=>value===key),[key,key,key,key]);
  console.log(JSON.stringify({format,registryVersion:'0.2.2',path:'checkout.sessions.create /v1/checkout_sessions',responseDeadlineExpired:true,stableKey:true,retryReplaySameSession:true,parameterConflict:409,fixtureCreates:1,providerRequests:0}));
 }
 console.log(JSON.stringify({installedRegistrySdkFilesEqual:53,formats:2,behaviorGroups:4,providerRequests:0,realGateway:false,monetaryEffects:false}));
} finally { await new Promise((resolve)=>server.close(resolve)); }
