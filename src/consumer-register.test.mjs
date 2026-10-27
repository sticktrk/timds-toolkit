import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerConsumer, consumerUpdates, registrationSurface, runConsumerRegistration } from './consumer-register.mjs';

const sourceId='22222222-2222-4222-8222-222222222222';
const manifest=()=>({schemaVersion:1,designSystem:{systemId:'timds-example/core',version:'2026.10.27-1',path:'design-system',url:'https://public.example.com'},apps:{web:{cwd:'web',preview:{build:['npm','run','build'],output:'dist'},designSurface:['src/**/*.css','components/*.tsx'],protected:['src/server/**']}}});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'timds-register-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['remote','add','origin','git@github.com:timds-example/product.git'],{cwd:root});await fs.mkdir(path.join(root,'web'));await fs.writeFile(path.join(root,'timds.consumer.json'),JSON.stringify(manifest()));return root;}
function host({ loseFirst=false }={}){const calls=[];let saved=null,lost=false;return{calls,fetchImpl:async(url,init)=>{calls.push({url,init});assert.ok(url.startsWith('https://host.example.com/api/timds/'));assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer test-only');assert.equal(init.headers['X-TimDS-API-Version'],'1');let body;if(url.endsWith('/design-systems'))body={systems:[{id:sourceId,systemId:'timds-example/core'}]};else if(url.includes('/github/app/install?'))body={installUrl:'https://github.com/apps/timds-example/installations/new?state=example'};else if(init.method==='POST'){const input=JSON.parse(init.body);saved={...input,sourceId,status:'pending_install'};if(loseFirst&&!lost){lost=true;throw new Error('Simulated lost response');}body={consumer:saved};}else if(url.endsWith('/updates'))body={updates:[{id:'example-run',consumerId:saved.id,label:'2026.10.27-2',status:'opened',pullRequestUrl:'https://github.com/timds-example/product/pull/1'}]};else body={update:{id:'example-run',consumerId:saved.id,label:'2026.10.27-2',status:'opened'}};return new Response(JSON.stringify({apiVersion:1,...body}),{status:init.method==='POST'?201:200,headers:{'Content-Type':'application/json'}});}};}

test('registration discovers source and GitHub repository, saves one id and reads host receipts',async t=>{const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl};const first=await registerConsumer(root,options);assert.equal(first.consumer.locator,'timds-example/product');assert.equal(first.consumer.sourceId,sourceId);assert.match(first.installUrl,/^https:\/\/github.com\/apps\//);assert.deepEqual(first.consumer.designSurface,['timds.consumer.json','web/components','web/src']);const updated=manifest();updated.designSystem.version='2026.10.27-2';await fs.writeFile(path.join(root,'timds.consumer.json'),JSON.stringify(updated));const second=await registerConsumer(root,options);assert.equal(second.consumer.id,first.consumer.id);const posts=server.calls.filter(call=>call.init.method==='POST');assert.equal(posts[0].init.body,posts[1].init.body,'later registration reuses the exact original request');assert.equal((await consumerUpdates(root,options)).updates[0].consumerId,first.consumer.id);assert.equal((await consumerUpdates(root,{...options,label:'2026.10.27-2'})).update.label,'2026.10.27-2');await assert.rejects(registerConsumer(root,{...options,delivery:'approve'}),/different policy/);});

test('an uncertain registration retries the same saved UUID and request',async t=>{const root=await fixture(t),server=host({loseFirst:true}),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl};await assert.rejects(registerConsumer(root,options),/lost response/);await registerConsumer(root,options);const posts=server.calls.filter(call=>call.init.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].init.body,posts[1].init.body);});

test('receipt lookup accepts host release labels, encodes plus signs and enforces the 100-character limit',async t=>{
  const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl};
  const registered=await registerConsumer(root,options),base=`${options.portalUrl}/api/timds/sources/${sourceId}/consumers/${registered.consumer.id}/updates/`;
  for(const label of ['1','2026.10.27-2+build.7','a'.repeat(99)+'+']){
    const output=[];
    await runConsumerRegistration('updates',[label,'--root',root,'--portal-url',options.portalUrl,'--json'],{...options,output:line=>output.push(line)});
    assert.equal(server.calls.at(-1).url,base+encodeURIComponent(label));
    assert.equal(JSON.parse(output.join('\n')).update.consumerId,registered.consumer.id);
  }
  assert.ok(server.calls.some(call=>call.url===base+'2026.10.27-2%2Bbuild.7'));
  const before=server.calls.filter(call=>call.url.includes('/updates/')).length;
  for(const label of ['a'.repeat(101),'a'.repeat(128),'+build','version/name','version name','version%2Bbuild'])
    await assert.rejects(consumerUpdates(root,{...options,label}),/valid release label/);
  assert.equal(server.calls.filter(call=>call.url.includes('/updates/')).length,before,'invalid labels never reach the receipt endpoint');
});

test('registration rejects ambiguous roots, foreign remotes and root-wide globs without widening them',async t=>{const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl};await assert.rejects(registerConsumer(root,{...options,portalUrl:'https://host.example.com/private'}),/HTTPS origin/);execFileSync('git',['remote','set-url','origin','https://example.com/timds-example/product.git'],{cwd:root});await assert.rejects(registerConsumer(root,options),/GitHub/);assert.equal(server.calls.filter(call=>call.init.method==='POST').length,0);const input=manifest();input.apps.web.cwd='.';input.apps.web.designSurface=['*.css'];assert.throws(()=>registrationSurface(input),/explicit --surface/);assert.deepEqual(registrationSurface(input,['styles.css']),['styles.css','timds.consumer.json']);assert.throws(()=>registrationSurface(input,['../outside']),/safe repository/);await assert.rejects(runConsumerRegistration('register',['--delivery']),/requires a value/);await assert.rejects(runConsumerRegistration('updates',['--notify']),/Invalid/);});

for(const remote of ['https://github.com/TimDS-Example/Product.git','ssh://git@github.com/TimDS-Example/Product.git','git@github.com:TimDS-Example/Product.git'])test(`registration normalizes a supported GitHub remote: ${remote}`,async t=>{
  const root=await fixture(t),server=host();execFileSync('git',['remote','set-url','origin',remote],{cwd:root});
  const result=await registerConsumer(root,{portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl});
  assert.equal(result.consumer.locator,'timds-example/product');
});

test('registration refuses a nested manifest before contacting the host or saving retry state',async t=>{
  const root=await fixture(t),nested=path.join(root,'packages','site'),server=host();
  await fs.mkdir(nested,{recursive:true});await fs.rename(path.join(root,'timds.consumer.json'),path.join(nested,'timds.consumer.json'));
  await assert.rejects(registerConsumer(nested,{portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl}),/Git repository root/);
  assert.equal(server.calls.length,0);await assert.rejects(fs.access(path.join(root,'.git','timds-consumers')));
});

test('registration rejects dot repositories and caps the distinct surface before its POST',async t=>{
  const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl};
  for(const repository of ['timds-example/.','timds-example/..'])await assert.rejects(registerConsumer(root,{...options,repository}),/owner\/repository locator/);
  const surface=Array.from({length:100},(_,index)=>`src/${index}`);
  await assert.rejects(registerConsumer(root,{...options,surface}),/at most 100/);
  assert.equal(registrationSurface(manifest(),surface.slice(0,99)).length,100);
  const input=manifest();input.apps.web.designSurface=surface.map(prefix=>`${prefix}/**`);
  assert.throws(()=>registrationSurface(input),/at most 100/);
  assert.equal(server.calls.filter(call=>call.init.method==='POST').length,0);
});

test('registration refuses both update-mode changes and changed explicit surfaces on replay',async t=>{
  for(const notify of [false,true]){
    const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl,notify};
    if(notify){const input=manifest();delete input.designSystem.version;delete input.designSystem.url;await fs.writeFile(path.join(root,'timds.consumer.json'),JSON.stringify(input));}
    await registerConsumer(root,options);
    await assert.rejects(registerConsumer(root,{...options,notify:!notify}),/different update mode/,'mode mismatch must be diagnosed before a submodule pin restriction');
    await registerConsumer(root,options);
    assert.equal(server.calls.filter(call=>call.init.method==='POST').length,2);
  }
  const root=await fixture(t),server=host(),options={portalUrl:'https://host.example.com',token:'test-only',fetchImpl:server.fetchImpl,surface:['web/src']};
  const first=await registerConsumer(root,options);
  assert.equal((await registerConsumer(root,{...options,surface:['web/src','web/src']})).consumer.id,first.consumer.id);
  await assert.rejects(registerConsumer(root,{...options,surface:['web/components']}),/different policy or surface/);
  assert.equal(server.calls.filter(call=>call.init.method==='POST').length,2);
});

test('registration uses documented host fallbacks and both commands support -h',async t=>{
  for(const command of ['register','updates']){
    const lines=[];await runConsumerRegistration(command,['-h'],{output:line=>lines.push(line)});
    assert.match(lines.join('\n'),/register \[--portal-url URL\]/);assert.match(lines.join('\n'),/--base-branch REF/);assert.match(lines.join('\n'),/--surface PATH/);
    assert.match(lines.join('\n'),/TIMDS_PORTAL_URL/);
  }
  const root=await fixture(t),server=host(),credentialsPath=path.join(root,'.git','test-credentials.json'),previous=process.env.TIMDS_PORTAL_URL;
  await fs.writeFile(credentialsPath,JSON.stringify({schemaVersion:1,defaultPortal:'https://host.example.com',portals:{'https://host.example.com':{accessToken:'test-only'}}}));
  try{
    delete process.env.TIMDS_PORTAL_URL;
    assert.equal((await registerConsumer(root,{token:'test-only',credentialsPath,fetchImpl:server.fetchImpl})).portal,'https://host.example.com');
    process.env.TIMDS_PORTAL_URL='https://host.example.com';
    assert.equal((await registerConsumer(root,{token:'test-only',credentialsPath:path.join(root,'.git','absent.json'),fetchImpl:server.fetchImpl})).portal,'https://host.example.com');
  }finally{if(previous===undefined)delete process.env.TIMDS_PORTAL_URL;else process.env.TIMDS_PORTAL_URL=previous;}
});
