import { chromium } from '/home/nate/Oxy/.agent-evidence/i04-handoff-i08-20261003/browser-tools/node_modules/playwright-core/index.mjs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json','utf8'));
const originalLog=console.log;console.log=(...args)=>{appendFileSync('/home/nate/Oxy/.agent-evidence/i04-registry-web-third-party-20261004/transcript-mismatch-green.log',args.join(' ')+'\n');originalLog(...args);};
const browser=await chromium.launch({executablePath:'/home/nate/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',headless:true});
const context=await browser.newContext();
await context.grantPermissions(['local-network-access'],{origin:manifest.origins.a});
const log='/home/nate/Oxy/.agent-evidence/i04-registry-web-third-party-20261004/network-mismatch-green.jsonl';
const artifact=JSON.parse(readFileSync('/home/nate/Oxy/.agent-evidence/i04-registry-web-third-party-20261004/artifact.json','utf8'));
const hashes=new Map(artifact.files.map(x=>['/'+x.path,x.sha256]));
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());
 if(u.origin===manifest.origins.a){
  const path=u.pathname==='/'?'/index.html':u.pathname;
  if(req.method()!=='GET'||!hashes.has(path)){await route.abort();return;}
  // The local artifact transport never receives callback queries, cookies or authorization.
  const response=await context.request.get('http://127.0.0.1:17979'+path,{headers:{},maxRedirects:0});
  const body=await response.body();const digest=createHash('sha256').update(body).digest('hex');
  if(response.status()!==200||digest!==hashes.get(path))throw Error('Artifact bytes changed');
  appendFileSync('/home/nate/Oxy/.agent-evidence/i04-registry-web-third-party-20261004/routed-responses.jsonl',JSON.stringify({path,status:200,sha256:digest,bytes:body.length})+'\n');
  await route.fulfill({status:200,headers:{'content-type':response.headers()['content-type'],'cache-control':'no-store'},body});
 }else if(u.hostname==='127.0.0.1'&&['17960','17961','17972','17973'].includes(u.port))await route.continue();
 else{appendFileSync(log,JSON.stringify({blocked:u.origin+u.pathname})+'\n');await route.abort();}
});
function fingerprints(value,path='') {
 const out={}; if(!value || typeof value!=='object')return out;
 for(const [k,v] of Object.entries(value)) { const key=path?path+'.'+k:k;
  if(typeof v==='string' && /device|secret|token|sessionId/i.test(k))out[key]={sha256:createHash('sha256').update(v).digest('hex'),length:v.length};
  else if(v && typeof v==='object')Object.assign(out,fingerprints(v,key));
 } return out;
}
context.on('response',async r=>{try{
 const u=new URL(r.url()); if(u.port!=='17960')return;
 const path=u.pathname.replace(/(\/auth\/session\/status\/).*/, '$1[redacted]');
 const record={at:new Date().toISOString(),method:r.request().method(),path,status:r.status()};
 if(['/auth/signin/password','/session/device/add','/session/device/switch','/session/device/token'].includes(path)) {
  try{record.request=fingerprints(r.request().postDataJSON());}catch{}
  try{const body=await r.json();record.response=fingerprints(body);if(r.status()>=400){record.error={code:body.error?.code??body.code,message:String(body.error?.message??body.message??body.error??'').replace(/[A-Za-z0-9_-]{35,}/g,'[redacted]').slice(0,400)};}}catch{}
 }
 appendFileSync(log,JSON.stringify(record)+'\n');
}catch(e){console.log(JSON.stringify({observerError:e.message}));}});
context.on('page',p=>{p.on('pageerror',e=>console.log(JSON.stringify({pageerror:e.message})));p.on('console',m=>{if(m.type()==='error')console.log(JSON.stringify({console:m.text().slice(0,1000)}));});});
const page=await context.newPage();await page.goto(manifest.origins.a);console.log('READY');
const rl=createInterface({input:process.stdin});
for await (const line of rl){try{const a=JSON.parse(line);let p=context.pages()[a.page??0];let out;
if(a.op==='snapshot'){out=[];for(const [i,t] of context.pages().entries())out.push({page:i,url:new URL(t.url()).origin+new URL(t.url()).pathname,text:(await t.locator('body').innerText()).slice(0,14000)});}
else if(a.op==='click'){await p.getByRole(a.role??'button',{name:a.name,exact:a.exact??false}).click({timeout:10000});out='clicked';}
else if(a.op==='fields'){out=await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,name:x.name,placeholder:x.placeholder,aria:x.getAttribute('aria-label')})));}
else if(a.op==='fill'){await p.locator(a.selector).fill(a.fixture==='password'?manifest.password:a.fixture==='person'?manifest.person.username:a.value);out='filled';}
else if(a.op==='newpage'){p=await context.newPage();await p.goto(manifest.origins[a.lane]);out={page:context.pages().indexOf(p)};}
else if(a.op==='reload'){await p.reload();out='reloaded';}
else if(a.op==='buttons'){out=await p.getByRole('button').allTextContents();}
else if(a.op==='goto'){await p.goto(manifest.origins[a.lane]??manifest.clients[a.lane].origin);out='navigated';}
else if(a.op==='wait'){await p.waitForTimeout(Math.min(a.ms??1000,5000));out='waited';}
else if(a.op==='cookies'){out=await context.cookies();if(out.length)out=out.map(c=>({name:c.name,domain:c.domain}));}
else if(a.op==='close'){await browser.close();rl.close();process.exit(0);}
console.log(JSON.stringify(out));}catch(e){console.log(JSON.stringify({error:e.message.slice(0,1500)}));}}

await browser.close();
