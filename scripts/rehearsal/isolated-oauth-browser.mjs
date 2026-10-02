import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {chromium} = await import(process.env.OXY_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true});
const arguments_=process.argv.slice(2);
const expectedRed=arguments_.includes('--expect-published-red');
const ports=arguments_.filter(value=>!value.startsWith('--')).map(Number);
if(!ports.length)ports.push(17857);
const user={id:'fixture-external-user',username:'fixturehandle',name:{displayName:'Fixture User'},email:'fixture@example.invalid'};
const token=[{alg:'none'},{userId:user.id,exp:Math.floor(Date.now()/1000)+3600},'fixture'].map(x=>typeof x==='string'?x:Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
try {for(const port of ports) for(const mismatch of [false,true]) {
 const context=await browser.newContext();const page=await context.newPage();const requests=[],errors=[],authorize=[],exchanges=[];
 page.on('pageerror',e=>errors.push(e.stack));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());requests.push({url:request.url(),method:request.method()});
  if(url.hostname==='localhost'&&url.port===String(port))return route.continue();
  if(url.origin==='https://auth.oxy.so'&&url.pathname==='/authorize'){
   authorize.push(Object.fromEntries(url.searchParams));
   const state=url.searchParams.get('state'),target=new URL(url.searchParams.get('redirect_uri')).origin;
   return route.fulfill({contentType:'text/html',body:`<script>setTimeout(()=>{window.opener.postMessage(${JSON.stringify({type:'oxy:oauth:code',code:'fixture-code',state:mismatch?'mismatched-state':state})},${JSON.stringify(target)});},100);</script>`});
  }
  if(url.hostname!=='127.0.0.1'||url.port!=='17855')return route.abort();
  const headers={'Access-Control-Allow-Origin':`http://localhost:${port}`,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Credentials':'true'};
  const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(body)});
  if(request.method()==='OPTIONS')return reply({});
  if(url.pathname==='/auth/oauth/client/oxy_dk_fixture_not_registered')return reply({application:{id:'fixture-third-party-app',name:'External fixture',type:'third_party',isOfficial:false,isInternal:false,redirectUris:[`http://localhost:${port}/`],scopes:['user:read']}});
  if(url.pathname==='/auth/oauth/token'){
   exchanges.push(Object.fromEntries(new URLSearchParams(request.postData())));
   // A legitimate isolated third-party response has NO shared-device credentials.
   return reply({access_token:token,token_type:'Bearer',expires_in:3600,session_id:'fixture-session',user});
  }
  if(url.pathname==='/users/me')return reply(user);
  if(url.pathname.startsWith('/session/validate/'))return reply({valid:true,user,sessionId:'fixture-session',expiresAt:new Date(Date.now()+3600000).toISOString(),lastActivity:new Date().toISOString()});
  if(url.pathname.startsWith('/session/logout/'))return reply({success:true});
  if(url.pathname.startsWith('/session/device/'))return reply({error:{code:'DEVICE_PROOF_REQUIRED',message:'An isolated external session has no shared-device credential.'}},403);
  return reply({error:{code:'FIXTURE_UNSUPPORTED_ROUTE',message:url.pathname}},404);
 });
 await page.goto(`http://localhost:${port}/`);try { await page.getByRole('button',{name:'Sign in with Oxy',exact:true}).waitFor({timeout:15000}); } catch(error) { console.error(JSON.stringify({body:await page.locator('body').innerText(),errors,requests})); throw error; }
 assert.equal(authorize.length,0,'no authorize request before user action');assert.equal(exchanges.length,0);
 await page.getByRole('button',{name:'Sign in with Oxy',exact:true}).click();
 if(mismatch){await page.waitForTimeout(1500);assert.equal(exchanges.length,0,'mismatched state must not exchange');assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),0);}
 else {await page.getByRole('button',{name:'Sign out',exact:true}).waitFor({timeout:15000});assert.match(await page.locator('body').innerText(),/Fixture User|fixturehandle/);assert.equal(exchanges.length,1);assert.equal(exchanges[0].client_id,'oxy_dk_fixture_not_registered');assert.equal(exchanges[0].redirect_uri,`http://localhost:${port}/`);assert.equal(exchanges[0].grant_type,'authorization_code');assert.equal(createHash('sha256').update(exchanges[0].code_verifier).digest('base64url'),authorize[0].code_challenge);assert.equal(authorize[0].code_challenge_method,'S256');assert.equal(page.url(),`http://localhost:${port}/`);await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.waitForTimeout(1000);assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),expectedRed?1:0,'self logout signed-in state');assert.equal(requests.filter(r=>new URL(r.url).pathname==='/session/logout/fixture-session').length,expectedRed?0:1,'self-revocation count');if(!expectedRed)assert.equal(requests.filter(r=>new URL(r.url).pathname.startsWith('/session/device/')).length,0,'isolated lifecycle must never request shared device');}
 assert.equal((await context.cookies()).length,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({port,scenario:mismatch?'state-mismatch':'device-less-oauth-and-logout',result:expectedRed&&!mismatch?'RED: published logout remains signed-in':'PASS',authorize:authorize.length,exchanges:exchanges.length,assetRequests:requests.length,requests:requests.filter(r=>new URL(r.url).hostname!=='localhost')}));await context.close();
 }}finally{await browser.close();}



if(expectedRed)process.exitCode=1; // Published baseline reproduces the outstanding defect.
