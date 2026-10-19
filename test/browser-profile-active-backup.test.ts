import{test}from'node:test'
import assert from'node:assert/strict'
import{createRequire}from'node:module'
import{mkdtempSync,rmSync}from'node:fs'
import{join}from'node:path'
import{tmpdir}from'node:os'
import{randomUUID}from'node:crypto'
import{AgentActiveBackup}from'../lib/browser-profile-active-backup.mjs'
import{AgentLiveBackupCapture}from'../lib/browser-profile-live-capture.mjs'
import{liveReadFixture}from'./helpers/browser-profile-live-fixture.js'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js'),{EncryptedBackupJournal}=require('../lib/browser-profile-core/backup-journal.js')
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function fixture(t:any){
 const f=liveReadFixture(t),peer=codec.createEndpointIdentity(randomUUID()),contentKeyEpoch=codec.createContentKeyEpoch(1),directory=mkdtempSync(join(tmpdir(),'hoai-agent-backup-')),journal=new EncryptedBackupJournal({directory}),scope={profileId:f.authority.profileId,actingUserId:f.authority.actingUserId,assistantId:f.authority.assistantId},state:any={pins:[peer.identity],keyReads:0,contexts:0,uploads:0,reads:0,retained:[],contextHook:null,uploadHook:null,drainHook:null},profile={id:scope.profileId,actingUserId:scope.actingUserId,assistantId:scope.assistantId,revision:0,headManifestHash:null,contentKeyEpoch:1,writerEpoch:1,writerState:'active',endpointId:f.authority.endpointId,bootId:f.authority.bootId,runtimeId:f.authority.runtimeId,sessionId:f.authority.sessionId},recipients=[{identity:f.endpoint.identity,keyFingerprint:f.authority.keyFingerprint,grantVersion:1,kind:'agent',ownerUserId:'owner',pairingId:3},{identity:peer.identity,keyFingerprint:codec.identityFingerprint(peer.identity),grantVersion:4,kind:'desktop',ownerUserId:scope.actingUserId,pairingId:null}],extras={passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'bing'}},client:any={async endpointContext(options:any){state.contexts++;options.assertCurrent();await state.contextHook?.();return{request:{version:2,requestId:randomUUID(),sourceAuthority:f.authority,expiresAt:Date.now()+9000},profile,head:null,retained:state.retained,recipients}},async endpointHead(options:any){state.reads++;options.assertCurrent();return{profile,head:state.retained[0]||null,retained:state.retained}},async upload(options:any){state.uploads++;options.assertCurrent();await journal.markUnknown(options.handle,{assertCurrent:options.assertCurrent});if(state.uploadHook)return state.uploadHook(options);state.retained=[journal.metadata(options.handle)];return{}},cancelPending(){},async whenDrained(){if(state.drainHook)return state.drainHook()}},helpers:AgentActiveBackup[]=[]
 const create=(options:any={})=>{const backup=new AgentActiveBackup({origin:'https://hoai.test',directory,endpoint:f.endpoint,authority:f.authority,ownerUserId:'owner',pairingId:3,runtime:f.runtime,assertCurrent:()=>{if(!f.state.current)throw Error('revoked')},authorizePairing:async()=>({}),peerIdentities:async (current:()=>unknown)=>{current();return state.pins},readExtras:()=>extras,currentContentKey:()=>{state.keyReads++;return contentKeyEpoch},journal,client,...options});helpers.push(backup);return backup}
 t.after(async()=>{await Promise.allSettled(helpers.map(helper=>helper.dispose()));await journal.whenDrained();contentKeyEpoch.key.fill(0);rmSync(directory,{recursive:true,force:true})})
 return{...f,scope,peer,profile,recipients,extras,state,create,journal,contentKeyEpoch,directory,client}
}
test('full locally reviewed recipient set seals and confirms advisory backup through actual shipped workers while original source stays active',async t=>{
 const f=fixture(t),backup=f.create();assert.equal((backup.scheduler as any).debounceMs,60000);backup.start();const result=await backup.captureNow();await backup.whenDrained();assert.equal(result.state,'confirmed');assert.equal(f.state.uploads,1);assert.ok(f.state.keyReads>0);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');assert.equal(f.contentKeyEpoch.key.some((byte:number)=>byte!==0),true);const rows=await f.journal.inspect({scope:f.scope,pins:[f.endpoint.identity,f.peer.identity],assertCurrent:()=>true});assert.equal(rows.length,1);assert.equal(rows[0].status,'confirmed');assert.deepEqual(rows[0].metadata.bundle.recipients.map((row:any)=>row.grantVersion).sort(),[1,4]);assert.equal(backup.activity().pendingPhysicalOperations,0)
})
test('every unknown/replaced identity, peer role and own source party refuses before any retained key access or seal',async t=>{
 for(const fault of ['unknown','replaced','other-agent','peer-owner','peer-pairing','source-kind','source-owner','source-pairing','source-grant','missing-source','duplicate']){
  const f=fixture(t),backup=f.create(),own=f.recipients[0],peer=f.recipients[1];if(fault==='unknown')f.state.pins=[];else if(fault==='replaced'){peer.identity=codec.createEndpointIdentity(peer.identity.endpointId).identity;peer.keyFingerprint=codec.identityFingerprint(peer.identity)}else if(fault==='other-agent'){peer.kind='agent';peer.pairingId=3}else if(fault==='peer-owner')peer.ownerUserId='sharer';else if(fault==='peer-pairing')peer.pairingId=3;else if(fault==='source-kind')own.kind='desktop';else if(fault==='source-owner')own.ownerUserId='other';else if(fault==='source-pairing')own.pairingId=4;else if(fault==='source-grant')own.grantVersion=2;else if(fault==='missing-source')f.recipients.splice(0,1);else f.recipients.push(own);backup.start();const result=await backup.captureNow();await backup.whenDrained();assert.equal(result.state,'skipped',fault);assert.equal(f.state.keyReads,0,fault);assert.equal(f.calls.some(row=>row.method==='new-session'),false,fault);assert.equal(f.state.uploads,0);await backup.dispose()
 }
})
test('source context and full authority changes during metadata fetch refuse before key access',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>();f.state.contextHook=async()=>{entered.resolve();await release.promise};const backup=f.create();backup.start();const pending=backup.captureNow();await entered.promise;try{f.runtime.context={}}finally{release.resolve()}assert.equal((await pending).state,'skipped');await backup.whenDrained();assert.equal(f.state.keyReads,0);assert.equal(f.state.uploads,0)
})
test('pause drains held original metadata work before resume and never starts a late native capture',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>();f.state.contextHook=async()=>{entered.resolve();await release.promise};const backup=f.create();backup.start();const pending=backup.captureNow();await entered.promise;let done=false;const pausing=backup.pause().then(()=>{done=true});try{await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.ok(backup.activity().pendingPhysicalOperations>0);assert.throws(()=>backup.start(),/cleanup_unknown/)}finally{release.resolve()}await pending;await pausing;assert.equal(f.state.keyReads,0);assert.equal(f.calls.some(row=>row.method==='new-session'),false);f.state.contextHook=null;backup.start();assert.equal((await backup.captureNow()).state,'confirmed')
})
test('possible upload failure is never automatically resent, including durable journal rediscovery after helper replacement',async t=>{
 const f=fixture(t),backup=f.create();f.state.uploadHook=()=>{throw Object.assign(Error('unknown'),{code:'profile_backup_outcome_unknown'})};backup.start();assert.equal((await backup.captureNow()).state,'unknown');await backup.whenDrained();assert.equal(f.state.uploads,1);assert.equal((await backup.captureNow()).state,'unknown');assert.equal(f.state.uploads,1);await backup.dispose();const replacement=f.create();replacement.start();assert.equal((await replacement.reconcile()).state,'unknown');assert.equal(f.state.uploads,1);assert.equal(f.state.retained.length,0);const rows=await f.journal.inspect({scope:f.scope,pins:[f.endpoint.identity,f.peer.identity],assertCurrent:()=>true});f.state.retained=[rows[0].metadata];assert.equal((await replacement.reconcile()).state,'confirmed');assert.equal(f.state.uploads,1)
})
test('retained key identity changes after initial proof prevent native capture and upload',async t=>{
 const f=fixture(t);let count=0;const backup=f.create({currentContentKey:()=>{count++;return count===1?f.contentKeyEpoch:{epoch:1,key:f.contentKeyEpoch.key}}});backup.start();assert.equal((await backup.captureNow()).state,'skipped');await backup.whenDrained();assert.equal(f.state.uploads,0);assert.equal(f.calls.some(row=>row.method==='new-session'),false)
})
test('automatic scheduling waits the production60s debounce under a synthetic clock and keeps the source active',async t=>{
 const f=fixture(t),backup=f.create();t.mock.timers.enable({apis:['setTimeout','Date']});backup.start();t.mock.timers.tick(59999);assert.equal(f.state.contexts,0);t.mock.timers.tick(1);await backup.whenDrained();assert.equal(f.state.uploads,1);assert.equal(backup.status().state,'confirmed');assert.equal(f.runtime.network,'active');assert.equal(f.runtime.state,'active');t.mock.timers.reset()
})
test('bounded periodic hints capture storage-only changes without a command or network hint and stop synchronously on pause',async t=>{
 const f=fixture(t),backup=f.create();t.mock.timers.enable({apis:['setTimeout','Date']});backup.start();t.mock.timers.tick(60000);await backup.whenDrained();assert.equal(f.state.uploads,1);f.hooks.send=(method:string,params:any)=>{if(method==='Runtime.evaluate'&&params.awaitPromise===true)return{result:{value:JSON.stringify({schema:'hoai-origin-storage-v1',origin:'https://site.test',localStorage:[{name:'storage-only',value:'changed'}],indexedDB:[]})}}};t.mock.timers.tick(60000);await backup.whenDrained();assert.equal(f.state.uploads,2);assert.equal(f.state.retained[0].bundle.sequence,2);await backup.pause();const contexts=f.state.contexts;t.mock.timers.tick(300000);await backup.whenDrained();assert.equal(f.state.contexts,contexts);assert.equal(f.state.uploads,2);backup.start();await backup.whenDrained();assert.equal(f.state.uploads,3);await backup.dispose();const stopped=f.state.contexts;t.mock.timers.tick(300000);assert.equal(f.state.contexts,stopped);t.mock.timers.reset()
})

test('storage-only cadence follows asynchronous confirmation rather than the earlier periodic tick',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>(),backup=f.create();
 f.state.uploadHook=async(options:any)=>{entered.resolve();await release.promise;f.state.retained=[f.journal.metadata(options.handle)];return{}};
 t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  backup.start();t.mock.timers.tick(60000);await entered.promise;
  // Real sealing, durable journaling and HTTP confirmation finish after the
  // original timer. This delay must not add a second debounce interval.
  t.mock.timers.tick(250);release.resolve();await backup.whenDrained();
  assert.equal(backup.status().state,'confirmed');assert.equal(f.state.uploads,1);
  f.state.uploadHook=null;
  t.mock.timers.tick(59999);await backup.whenDrained();assert.equal(f.state.uploads,1);
  t.mock.timers.tick(1);await backup.whenDrained();assert.equal(f.state.uploads,2);
  assert.equal(f.state.retained[0].bundle.sequence,2);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');
 }finally{release.resolve();await backup.dispose();t.mock.timers.reset()}
})

test('an automatic tick coalesced with original manual work cannot release its cooldown on pause',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>(),backup=f.create();
 f.state.contextHook=async()=>{entered.resolve();await release.promise};t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  backup.start();const manual=backup.captureNow();await entered.promise;t.mock.timers.tick(60000);
  const paused=backup.pause();release.resolve();await manual;await paused;assert.equal(f.state.contexts,1);
  f.state.contextHook=null;backup.start();await backup.whenDrained();assert.equal(f.state.contexts,1);
  t.mock.timers.tick(59999);await backup.whenDrained();assert.equal(f.state.contexts,1);
  t.mock.timers.tick(1);await backup.whenDrained();assert.equal(f.state.contexts,2);
 }finally{release.resolve();await backup.dispose();t.mock.timers.reset()}
})

test('a reentrant confirmed observer pause clears the owned hint without timer resurrection',async t=>{
 const f=fixture(t);let stopping:Promise<unknown>|null=null;
 const backup=f.create({onStatus:(value:any)=>{if(value.state==='confirmed'&&!stopping)stopping=backup.pause()}});
 t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  backup.start();t.mock.timers.tick(60000);await backup.whenDrained();await stopping;
  assert.equal(backup.status().paused,true);assert.equal(f.state.uploads,1);const contexts=f.state.contexts;
  t.mock.timers.tick(300000);await backup.whenDrained();assert.equal(f.state.contexts,contexts);assert.equal(f.state.uploads,1);
 }finally{await backup.dispose();t.mock.timers.reset()}
})

test('an unentered due attempt waits for independent physical cleanup before a resumed retry',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>(),backup=f.create();
 t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  backup.start();t.mock.timers.tick(60000);await backup.whenDrained();assert.equal(f.state.uploads,1);
  f.state.drainHook=async()=>{entered.resolve();await release.promise};
  t.mock.timers.tick(60000);const pausing=backup.pause();await entered.promise;
  assert.equal(f.state.contexts,1);assert.throws(()=>backup.start(),/cleanup_unknown/);
  release.resolve();await pausing;f.state.drainHook=null;backup.start();await backup.whenDrained();
  assert.equal(f.state.contexts,2);assert.equal(f.state.uploads,2);
 }finally{release.resolve();await backup.dispose();t.mock.timers.reset()}
})

test('a backward wall clock jump cannot overflow the owned timer into a millisecond loop',async t=>{
 const f=fixture(t),backup=f.create(),delays:number[]=[];t.mock.timers.enable({apis:['setTimeout','Date']});
 const original=globalThis.setTimeout;
 globalThis.setTimeout=((callback:any,delay?:number,...args:any[])=>{delays.push(Number(delay));return original(callback,delay,...args)}) as typeof setTimeout;
 try{
  t.mock.timers.setTime(10**12);backup.start();await backup.pause();t.mock.timers.setTime(0);backup.start();
  assert.ok(delays.length>0);assert.equal(delays.every(value=>value>=1&&value<=60000),true);
  assert.equal(f.state.contexts,0);assert.equal(f.state.uploads,0);
 }finally{await backup.dispose();globalThis.setTimeout=original;t.mock.timers.reset()}
})
test('repeated short command pauses cannot postpone the absolute backup due cadence indefinitely',async t=>{
 const f=fixture(t),backup=f.create();t.mock.timers.enable({apis:['setTimeout','Date']});backup.start();for(let command=0;command<6;command++){t.mock.timers.tick(10000);await backup.pause();if(command===1)f.hooks.send=(method:string,params:any)=>{if(method==='Runtime.evaluate'&&params.awaitPromise===true)return{result:{value:JSON.stringify({schema:'hoai-origin-storage-v1',origin:'https://site.test',localStorage:[{name:'background-storage',value:'changed-without-network'}],indexedDB:[]})}}};backup.start();await backup.whenDrained();assert.equal(f.state.uploads,command<5?0:1)}assert.equal(backup.status().state,'confirmed');assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');await backup.dispose();t.mock.timers.reset()
})
test('overdue skipped and unknown backups have a separate60s automatic attempt cooldown across short command resumes',async t=>{
 for(const fault of ['skipped','unknown']){const f=fixture(t),backup=f.create();if(fault==='skipped')f.state.contextHook=()=>{throw Error('synthetic unavailable metadata')};else f.state.uploadHook=()=>{throw Object.assign(Error('unknown'),{code:'profile_backup_outcome_unknown'})};t.mock.timers.enable({apis:['setTimeout','Date']});backup.start();t.mock.timers.tick(60000);await backup.whenDrained();assert.equal(f.state.contexts,1);assert.equal(backup.status().state,fault);for(let command=0;command<5;command++){t.mock.timers.tick(10000);await backup.pause();backup.start();await backup.whenDrained();assert.equal(f.state.contexts,1,fault)}t.mock.timers.tick(10000);await backup.pause();backup.start();await backup.whenDrained();assert.equal(f.state.contexts,2,fault);assert.equal(f.state.uploads,fault==='unknown'?1:0);await backup.dispose();t.mock.timers.reset()}
})
test('four original active sources remain bounded until positive helper disposal',async t=>{
 const rows=Array.from({length:5},()=>fixture(t)),helpers=rows.slice(0,4).map(row=>row.create());assert.throws(()=>rows[4].create(),/configuration_invalid/);await helpers[0].dispose();const fresh=rows[4].create();await fresh.dispose();for(const helper of helpers.slice(1))await helper.dispose()
})
test('expired metadata or changed original profile refuses before retained key access',async t=>{
 for(const fault of ['expired','profile','authority']){const f=fixture(t),original=f.client.endpointContext;f.client.endpointContext=async(options:any)=>{const value=await original(options);if(fault==='expired')value.request.expiresAt=Date.now()-1;else if(fault==='profile')value.profile={...value.profile,writerState:'stopped'};else value.request.sourceAuthority={...f.authority,writerEpoch:2};return value};const backup=f.create();backup.start();assert.equal((await backup.captureNow()).state,'skipped');await backup.whenDrained();assert.equal(f.state.keyReads,0);assert.equal(f.state.uploads,0);await backup.dispose()}
})
test('synchronous stop failure still attempts every independent physical cleanup and latches admission',async t=>{
 const f=fixture(t),calls:string[]=[],capture:any={authority:f.authority,async capture(){},whenDrained(){calls.push('capture-drain')},activity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false}),dispose(){calls.push('capture-dispose')}},backup=f.create({capture});f.client.cancelPending=()=>{throw Error('synthetic abort failure')};f.client.whenDrained=()=>{calls.push('client-drain')};backup.start();await assert.rejects(backup.dispose(),/cleanup_unknown/);assert.ok(calls.includes('capture-dispose'));assert.ok(calls.includes('capture-drain'));assert.ok(calls.includes('client-drain'));assert.equal(backup.activity().cleanupUnknown,true)
})
test('failed physical HTTP cleanup latches admission and keeps exact source reservation',async t=>{
 const f=fixture(t),backup=f.create();f.state.drainHook=()=>{throw Error('synthetic failed physical response drain')};backup.start();assert.equal((await backup.captureNow()).reason,'profile_backup_cleanup_unknown');await assert.rejects(backup.whenDrained(),/cleanup_unknown/);assert.equal(backup.activity().cleanupUnknown,true);assert.throws(()=>backup.start(),/cleanup_unknown/);await assert.rejects(backup.dispose(),/cleanup_unknown/);assert.throws(()=>f.create(),/configuration_invalid/)
})
