import{test}from'node:test'
import assert from'node:assert/strict'
import{randomUUID}from'node:crypto'
import{createRequire}from'node:module'
import{AgentLiveBackupCapture}from'../lib/browser-profile-live-capture.mjs'
import{liveReadFixture}from'./helpers/browser-profile-live-fixture.js'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js'),{validateEncryptedBackup}=require('../lib/browser-profile-core/active-backup-wire.js')
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function fixture(t:any,options:any={}){
 const f=liveReadFixture(t),contentKeyEpoch=codec.createContentKeyEpoch(1),request={snapshotId:randomUUID(),sequence:1,previousBundleHash:null,source:f.endpoint,recipients:[{identity:f.endpoint.identity,keyFingerprint:f.authority.keyFingerprint,grantVersion:1}],contentKeyEpoch},extras={passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'bing'}},capture=new AgentLiveBackupCapture({...f.input(),readExtras:()=>extras,...options});t.after(async()=>{await capture.dispose().catch(()=>{});contentKeyEpoch.key.fill(0)});return{...f,capture,request,extras}
}
test('synthetic native scope composes actual seal worker into a signed encrypted advisory backup without stopping source',async t=>{
 const f=fixture(t),result=await f.capture.capture(f.request);assert.equal(result.state,'captured');await f.capture.whenDrained();const metadata=validateEncryptedBackup((result as any).result,{scope:{profileId:f.authority.profileId,actingUserId:f.authority.actingUserId,assistantId:f.authority.assistantId},pins:[f.endpoint.identity]});assert.equal(metadata.bundle.captureKind,'live-best-effort');assert.deepEqual(metadata.bundle.sourceAuthority,f.authority);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');assert.deepEqual(f.capture.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false});assert.equal(f.request.contentKeyEpoch.key.some((byte:number)=>byte!==0),true);assert.equal(f.calls.filter(row=>row.method==='detach').length,1)
})
test('request recipients are captured before asynchronous native setup and never retarget from a mutable caller object',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<void>(),replacement=codec.createEndpointIdentity(randomUUID());f.hooks.session=async()=>{entered.resolve();await release.promise};const pending=f.capture.capture(f.request);await entered.promise;try{f.request.recipients=[{identity:replacement.identity,keyFingerprint:codec.identityFingerprint(replacement.identity),grantVersion:9}]}finally{release.resolve()}const result=await pending;assert.equal(result.state,'captured');assert.deepEqual((result as any).result.bundle.recipients.map((row:any)=>row.endpointId),[f.authority.endpointId]);await f.capture.whenDrained()
})
test('protected, unfinished and changed original documents refuse before sealing',async t=>{
 for(const fault of ['protected','credentials','loading','unsaved','changed']){
  let sealed=0;const seal={physical:null,async seal(){sealed++;return{}},async whenDrained(){}},f=fixture(t,{seal});if(fault==='protected')f.state.blocked=true;else f.hooks.send=(method:string,params:any)=>{if(method==='Runtime.evaluate'&&params.awaitPromise!==true){if(fault==='changed')f.page.address+='changed';return{result:{value:{ready:fault!=='loading',credentials:fault==='credentials',unsaved:fault==='unsaved'}}}}};const result=await f.capture.capture(f.request);assert.equal(result.state,'skipped');await f.capture.whenDrained();assert.equal(sealed,0,fault);assert.equal(f.capture.activity().pendingPhysicalOperations,0)
 }
})
test('credential state appearing after readonly storage capture is refused by the final native safety check before sealing',async t=>{
 let credentials=false,sealed=0;const seal={physical:null,async seal(){sealed++;return{}},async whenDrained(){}},f=fixture(t,{seal});f.hooks.send=(method:string,params:any)=>{if(method==='Network.getAllCookies')credentials=true;if(method==='Runtime.evaluate'&&params.awaitPromise!==true)return{result:{value:{ready:true,credentials,unsaved:false}}}};assert.equal((await f.capture.capture(f.request)).state,'skipped');await f.capture.whenDrained();assert.equal(sealed,0)
})
test('logical timeout retains actual native read and concurrent capture refuses until positive physical cleanup',async t=>{
 const f=fixture(t,{timeoutMs:30}),entered=deferred<void>(),release=deferred<any>();f.hooks.send=async(method:string)=>{if(method==='Network.getAllCookies'){entered.resolve();return release.promise}};const pending=f.capture.capture(f.request);await entered.promise;try{assert.equal((await pending).reason,'profile_live_timeout');assert.equal(f.capture.activity().pendingPhysicalOperations,1);assert.equal((await f.capture.capture(f.request)).reason,'profile_live_busy_or_closed');assert.equal(f.calls.some(row=>row.method==='detach'),false)}finally{release.resolve({cookies:[]})}await f.capture.whenDrained();assert.equal(f.capture.activity().pendingPhysicalOperations,0)
})
test('disposal starts a release fence while native work stays held and late data never seals',async t=>{
 let sealed=0;const seal={physical:null,async seal(){sealed++;return{}},async whenDrained(){}},f=fixture(t,{seal}),entered=deferred<void>(),release=deferred<any>();f.hooks.send=async(method:string)=>{if(method==='Network.getAllCookies'){entered.resolve();return release.promise}};const pending=f.capture.capture(f.request);await entered.promise;let stopped=false;const disposal=f.capture.dispose().then(()=>{stopped=true});try{await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(f.capture.activity().pendingPhysicalOperations,1)}finally{release.resolve({cookies:[]})}assert.equal((await pending).state,'skipped');await disposal;assert.equal(sealed,0);assert.equal(f.capture.activity().pendingPhysicalOperations,0);assert.equal((await f.capture.capture(f.request)).reason,'profile_live_busy_or_closed')
})
test('a credential version change after encryption cannot publish captured data',async t=>{
 const entered=deferred<void>(),release=deferred<void>(),seal={physical:null,async seal(){entered.resolve();await release.promise;return{}},async whenDrained(){}},f=fixture(t,{seal}),pending=f.capture.capture(f.request);await entered.promise;try{f.state.version='changed'}finally{release.resolve()}assert.equal((await pending).state,'skipped');await f.capture.whenDrained();assert.equal(f.capture.activity().cleanupUnknown,false)
})
test('failed native detach retains a private cleanup latch and independently drains the seal worker',async t=>{
 let sealDrains=0;const seal={physical:null,async seal(){return{}},async whenDrained(){sealDrains++}},f=fixture(t,{seal});f.hooks.detach=()=>{throw Error('synthetic detach failure')};await assert.rejects(f.capture.capture(f.request),/cleanup_unknown/);await assert.rejects(f.capture.whenDrained(),/cleanup_unknown/);assert.deepEqual(f.capture.activity(),{pendingPhysicalOperations:1,cleanupUnknown:true});assert.ok(sealDrains>0);assert.equal(f.context.listenerCount('page'),0);assert.equal((await f.capture.capture(f.request)).reason,'profile_live_cleanup_unknown')
})
