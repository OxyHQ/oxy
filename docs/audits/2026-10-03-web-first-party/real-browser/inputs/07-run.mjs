import { chromium } from '/home/nate/Oxy/.agent-evidence/i04-handoff-i08-20261003/browser-tools/node_modules/playwright-core/index.mjs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json','utf8'));
const originalLog=console.log;console.log=(...args)=>{appendFileSync('/home/nate/Oxy/.agent-evidence/root-1519-20261003/browser-firstparty-complete-2-1215/transcript.log',args.join(' ')+'\n');originalLog(...args);};
const browser=await chromium.launch({executablePath:'/home/nate/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',headless:true});
const context=await browser.newContext();
const log='/home/nate/Oxy/.agent-evidence/root-1519-20261003/browser-firstparty-complete-2-1215/network.jsonl';
await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(u.hostname)&&['17960','17961','17972','17973'].includes(u.port))await route.continue();else{appendFileSync(log,JSON.stringify({blocked:u.origin+u.pathname})+'\n');await route.abort();}});
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

context.setDefaultTimeout(20000);
const pages=[];
function sql(label) {
 const out=execFileSync('python3',['-B','scripts/rehearsal/read-first-party-browser-state.py','.integration-evidence/oauth1519-1n8d1xvu/manifest.json',label],{cwd:'/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003',encoding:'utf8'});
 console.log(JSON.stringify({sqlRead:JSON.parse(out)}));
}
async function snapshot(label) {
 const states=[];
 for (const [index,p] of pages.entries()) states.push({page:index,text:await p.locator('body').innerText()});
 const cookies=await context.cookies(); assert.equal(cookies.length,0);
 console.log(JSON.stringify({label,states,cookies:0,at:new Date().toISOString()}));
}
async function click(p,name) {await p.getByRole('button',{name,exact:true}).click();}
async function subject(p,account) {
 await p.getByText('Signed in as '+account.username,{exact:true}).waitFor();
 const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/users/me' && r.request().method()==='GET');
 await click(p,'Read API subject');
 assert.equal((await response).status(),200);
 await p.getByText('API subject: '+account.id+' ('+account.username+')',{exact:true}).waitFor();
}
try {
 assert.equal((await context.cookies()).length,0);
 sql('root-complete2-before');
 const a=await context.newPage();pages.push(a);await a.goto(manifest.clients.webFirst.origin);
 await a.getByText('Signed out',{exact:true}).waitFor();
 await click(a,'Sign in with Oxy');await a.locator('input[type="email"]').fill(manifest.person.username);
 await click(a,'Continue');await click(a,'Use your password instead');
 await a.locator('input[type="password"]').fill(manifest.password);await click(a,'Continue');
 await subject(a,manifest.person);await snapshot('A-real-password-person');
 const b=await context.newPage();pages.push(b);await b.goto(manifest.clients.webSecond.origin);
 await b.getByText('Signed out',{exact:true}).waitFor();await click(b,'Sign in with Oxy');
 await subject(b,manifest.person);await snapshot('B-explicit-SDK-join-person');sql('root-complete2-joined');
 for(let cycle=1;cycle<=1;cycle++) {
  await b.bringToFront();await click(b,'Choose account');await click(b,'Switch account');
  await click(b,manifest.organization.username);await subject(b,manifest.organization);
  await a.bringToFront();await subject(a,manifest.organization);await snapshot('org-both-'+cycle);
  await b.bringToFront();await click(b,'Sign out');await subject(b,manifest.person);
  await a.bringToFront();await subject(a,manifest.person);await snapshot('person-fallback-both-no-reload-'+cycle);
 }
 sql('root-complete2-fallback');
 await b.bringToFront();await click(b,'Sign out');
 await b.getByText('Signed out',{exact:true}).waitFor();await a.bringToFront();await a.getByText('Signed out',{exact:true}).waitFor();
 await snapshot('final-signout-both');
 await a.reload();await b.reload();await a.getByText('Signed out',{exact:true}).waitFor();await b.getByText('Signed out',{exact:true}).waitFor();
 await snapshot('final-reload-both');sql('root-complete2-final');
 console.log(JSON.stringify({result:'PASS',orgFallbackCyclesWithoutReload:1,cookies:0,fixtureOnly:true}));
} catch(error) {
 console.log(JSON.stringify({result:'FAIL',error:String(error).slice(0,1600)}));
 try {await snapshot('failure');} catch {}
 process.exitCode=1;
} finally {await browser.close();}
