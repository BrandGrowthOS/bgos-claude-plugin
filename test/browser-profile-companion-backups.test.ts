import{test}from'node:test'
import assert from'node:assert/strict'
import{EventEmitter}from'node:events'
import{randomUUID}from'node:crypto'
import{createRequire}from'node:module'
import os from'node:os'
import path from'node:path'
import{AgentBrowserProfileCompanion}from'../lib/browser-profile-companion.mjs'
import{RelaySessions}from'../bin/hoai-browser-host.mjs'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
class Page extends EventEmitter{url(){return'https://site.test/safe'}isClosed(){return false}}
async function fixture(t:{after:(callback:()=>unknown)=>void},initialHooks:Row={}){
 const calls:Row[]=[],hooks:Row={...initialHooks},page=new Page(),context:Row=new EventEmitter(),pages=[page],endpoint=codec.createEndpointIdentity(randomUUID()),scope={profileId:randomUUID(),actingUserId:'recipient',assistantId:42,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:7,ownerUserId:'sharer'},key=codec.createContentKeyEpoch(1),extras={passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'bing'}}
 context.pages=()=>pages
 const connection:Row={bootId:randomUUID(),_stopped:false,pairing:{token:'synthetic-pairing',backendUrl:'https://hoai.test',pairingId:7,ownerUserId:'sharer',assistantIds:[42]},socketId:'socket-a',socket:{connected:true}},authority={...Object.fromEntries(['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].map(key=>[key,scope[key as keyof typeof scope]])),bootId:connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1},state:Row={frame:null,factory:null,paused:true,pending:0,cleanupUnknown:false,backupStatus:{state:'idle',busy:false,captureKind:'live-best-effort',uploadOutcome:'none'}}
 const runtime:Row={authority,context,operation:null,state:'active',network:'active',assertCurrent(){if(this.state!=='active')throw Error('synthetic runtime inactive');return authority},async activate(){},async newPage(){},async dispose(){calls.push({kind:'native-dispose'});this.state='disposed';this.network='blocked'},async finalize(input:Row){calls.push({kind:'finalize',input});if(hooks.finalize)return hooks.finalize(input);throw Error('synthetic finalization unavailable')}}
 const backup={start(){calls.push({kind:'backup-start'});state.factory.assertCurrent();state.paused=false;return this.status()},notify(){calls.push({kind:'backup-hint'});if(hooks.notify)hooks.notify()},async pause(){calls.push({kind:'backup-pause'});state.paused=true;state.pending++;try{if(hooks.pause)await hooks.pause()}finally{state.pending--}return{drained:true}},async whenDrained(){calls.push({kind:'backup-drain'});if(hooks.drain)await hooks.drain()},async dispose(){calls.push({kind:'backup-dispose'});state.paused=true;state.pending++;try{if(hooks.dispose)await hooks.dispose()}finally{state.pending--}},status(){return{...state.backupStatus,paused:state.paused,cleanupUnknown:state.cleanupUnknown}},activity(){return{pendingPhysicalOperations:state.pending,cleanupUnknown:state.cleanupUnknown}},async reconcile(){calls.push({kind:'backup-reconcile'});state.factory.assertCurrent();return this.status()}}
 const engine={selectedPage:()=>page,roster:()=>[{name:'browser_snapshot',description:'Synthetic readonly snapshot',inputSchema:{type:'object',additionalProperties:false}}],async callTool(name:string,args:Row){calls.push({kind:'engine',name,args});if(hooks.engine)await hooks.engine();return{content:[{type:'text',text:'Synthetic snapshot.'}]}},async stop(){calls.push({kind:'engine-stop'})}}
 const entry={profile:{...authority,id:scope.profileId,writerState:'active',headManifestHash:null},grant:{generation:1,backgroundUse:true}},client={discover:async()=>({profiles:[entry]}),activity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false})},companion:any=new AgentBrowserProfileCompanion({connection,agentRoot:path.join(os.tmpdir(),'hoai-backup-hooks-'+randomUUID()),deviceLabel:'Synthetic backup hooks',client,keyStore:{},stateStore:{},loadBrowser:async()=>({}),createEngine:async()=>engine,createRelay:(core:Row)=>new RelaySessions({core,serverInfo:{name:'fixture',version:'1'},instructions:'Fixture',callCapMs:2000}),createBackups:(input:Row)=>{state.factory=input;calls.push({kind:'backup-factory',input});return hooks.createBackups?hooks.createBackups(input,backup):backup}}as any)
 const record:Row={scope,identity:endpoint.identity,endpoint,runtime,contentKeyEpoch:key,extras:{preflightExtras:()=>structuredClone(extras),dispose(){}},admission:'blocked',revoked:false,uncertain:false,engineTasks:new Set(),state:'saved'};companion.records.set(scope.endpointId,record);companion._prove=async()=>{record.rpc.binding=Object.freeze({bindingId:randomUUID(),socketId:connection.socketId,authority})};
 t.after(async()=>{record.relay?.close();record.rpc?.disconnect();await Promise.allSettled([...record.engineTasks]);await companion._dispose(record).catch(()=>{});key.key.fill(0)})
 if(hooks.beforeActivate)hooks.beforeActivate({companion,record,context,page,backup,runtime,calls,state});await companion._activate(record,authority)
 companion.rpcClient.dispatch=async()=>({frame:structuredClone(state.frame)});companion.rpcClient.result=async(_authority:Row,_endpoint:Row,input:Row)=>{calls.push({kind:'completion',payload:input.payload});return{accepted:true}};companion.rpcClient.cancellation=async()=>({requested:true})
 const run=(name='browser_snapshot')=>{state.frame={event_type:'browser_profile_rpc',version:1,rpcId:randomUUID(),rpcNonce:'a'.repeat(43),bindingId:record.rpc.binding.bindingId,authority,clientId:'fixture-agent',assistantId:42,message:{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:{}}},deadlineAt:new Date(Date.now()+120000).toISOString()};return companion.receive(state.frame,connection.socketId)}
 return{companion,record,state,calls,hooks,run,backup,runtime,engine,context,pages,page,authority,scope,endpoint,connection,key,extras}
}
test('successful activation creates exact paired backup context and only starts the original active source',async t=>{
 const f=await fixture(t);assert.ok(f.state.factory);const input=f.state.factory;assert.strictEqual(input.runtime,f.runtime);assert.strictEqual(input.endpoint,f.endpoint);assert.deepEqual(input.authority,f.authority);assert.equal(input.ownerUserId,'sharer');assert.equal(input.pairingId,7);assert.equal(input.directory.includes(f.authority.runtimeId),false);assert.strictEqual(input.currentContentKey(),f.key);assert.deepEqual(input.readExtras(),f.extras);assert.equal(f.calls.filter(row=>row.kind==='backup-start').length,1);assert.equal(f.state.paused,false)
})
test('ordinary signed commands wait for positive original backup pause before native execution and resume only after cleanup',async t=>{
 const f=await fixture(t),entered=deferred<void>(),release=deferred<void>();f.hooks.pause=async()=>{entered.resolve();await release.promise};const pending=f.run();await entered.promise;try{assert.equal(f.calls.some(row=>row.kind==='engine'),false);assert.equal(f.record.engineTasks.size,1);assert.throws(()=>f.state.factory.assertCurrent())}finally{release.resolve()}await pending;assert.equal(f.calls.filter(row=>row.kind==='engine').length,1);assert.equal(f.calls.filter(row=>row.kind==='backup-start').length,2);assert.equal(f.record.engineTasks.size,0);assert.equal(f.state.paused,false)
})
test('original context, account, endpoint, engine and full authority changes invalidate retained backup callbacks',async t=>{
 for(const fault of ['context','account','endpoint','engine','authority','revoked']){const f=await fixture(t);if(fault==='context')f.runtime.context={};else if(fault==='account')f.record.scope={...f.scope,actingUserId:'other'};else if(fault==='endpoint')f.record.endpoint={...f.endpoint};else if(fault==='engine')f.record.engine={...f.engine};else if(fault==='authority')f.runtime.authority={...f.authority,writerEpoch:2};else f.record.revoked=true;assert.throws(()=>f.state.factory.assertCurrent(),()=>true,fault)}
})
test('only original native request/navigation hints notify and all listeners are removed on disposal',async t=>{
 const f=await fixture(t),before=f.calls.filter(row=>row.kind==='backup-hint').length;f.context.emit('requestfinished',{});f.page.emit('framenavigated',{});assert.equal(f.calls.filter(row=>row.kind==='backup-hint').length,before+2);const original=f.runtime.context;f.runtime.context={};f.context.emit('requestfinished',{});assert.equal(f.calls.filter(row=>row.kind==='backup-hint').length,before+2);f.runtime.context=original;await f.companion._dispose(f.record);assert.equal(f.context.listenerCount('requestfinished'),0);assert.equal(f.context.listenerCount('page'),0);assert.equal(f.page.listenerCount('framenavigated'),0)
})
test('disconnect fences backup immediately and physical revocation starts independently of a held backup disposer',async t=>{
 const f=await fixture(t);f.companion.disconnected();assert.equal(f.state.paused,true);const release=deferred<void>();f.hooks.dispose=()=>release.promise;let stopped=false;const stopping=f.companion.revoke().then(()=>{stopped=true});try{await tick();assert.equal(f.calls.some(row=>row.kind==='native-dispose'),true);assert.equal(f.calls.some(row=>row.kind==='backup-dispose'),true);assert.equal(stopped,false);assert.ok(f.companion.activity().pendingPhysicalOperations>0)}finally{release.resolve()}await stopping;assert.equal(f.record.runtime,null)
})
test('backup cleanup uncertainty blocks new commands and remains visible in positive activity',async t=>{
 const f=await fixture(t);f.state.cleanupUnknown=true;assert.throws(()=>f.companion._admit(f.record));assert.equal(f.companion.activity().cleanupUnknown,true);assert.equal(f.calls.some(row=>row.kind==='engine'),false)
})
test('existing signed status gives safe backup state and reconciles unknown read-only without native input',async t=>{
 const f=await fixture(t);f.state.backupStatus={state:'unknown',busy:false,captureKind:'live-best-effort',uploadOutcome:'unknown',reason:'profile_backup_unconfirmed'};await f.run('hoai_browser_status');assert.equal(f.calls.filter(row=>row.kind==='backup-reconcile').length,1);assert.equal(f.calls.some(row=>row.kind==='engine'),false);const payload=JSON.stringify(f.calls.find(row=>row.kind==='completion')?.payload);assert.match(payload,/live-best-effort/);assert.match(payload,/unknown/);assert.equal(payload.includes(f.key.key.toString('hex')),false)
})
test('normal retirement drains backups before entering native finalization and a pre-stop refusal keeps source usable',async t=>{
 const f=await fixture(t),entered=deferred<void>(),release=deferred<void>();f.hooks.pause=async()=>{entered.resolve();await release.promise};const retiring=f.companion.retire(f.record),refused=assert.rejects(retiring);await entered.promise;try{assert.equal(f.calls.some(row=>row.kind==='finalize'),false)}finally{release.resolve()}await refused;assert.equal(f.calls.filter(row=>row.kind==='finalize').length,1);assert.equal(f.runtime.state,'active');assert.equal(f.state.paused,false)
})
test('account revocation starts native disposal while an original backup factory is held and disposes its late runner',async t=>{
 const entered=deferred<void>(),release=deferred<void>(),original:Row={}
 const starting=fixture(t,{beforeActivate(value:Row){Object.assign(original,value)},async createBackups(_input:Row,backup:Row){entered.resolve();await release.promise;return backup}}),refused=assert.rejects(starting)
 await entered.promise;const stopping=original.companion.revoke();try{await tick();assert.ok(original.calls.some((row:Row)=>row.kind==='native-dispose'));assert.ok(original.companion.activity().pendingPhysicalOperations>0);assert.equal(original.calls.some((row:Row)=>row.kind==='backup-start'),false)}finally{release.resolve()}
 await refused;await stopping;assert.equal(original.calls.filter((row:Row)=>row.kind==='backup-dispose').length,1);assert.equal(original.record.runtime,null);await tick();assert.deepEqual(original.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
})
test('failed native listener setup rolls back every attempted listener and the exact created backup',async t=>{
 const original:Row={};await assert.rejects(fixture(t,{beforeActivate(value:Row){Object.assign(original,value);const on=value.context.on.bind(value.context);value.context.on=(event:string,callback:()=>void)=>{on(event,callback);if(event==='page')throw Error('synthetic setup failure');return value.context}}}))
 await original.companion._dispose(original.record);assert.equal(original.context.listenerCount('requestfinished'),0);assert.equal(original.context.listenerCount('page'),0);assert.equal(original.calls.filter((row:Row)=>row.kind==='backup-dispose').length,1)
})
test('failed listener removal cannot skip other native cleanup and retains unknown admission',async t=>{
 const f=await fixture(t),remove=f.context.removeListener.bind(f.context);f.context.removeListener=(event:string,callback:()=>void)=>{if(event==='requestfinished')throw Error('synthetic remove failure');return remove(event,callback)}
 await assert.rejects(f.companion._dispose(f.record));assert.equal(f.context.listenerCount('page'),0);assert.equal(f.page.listenerCount('framenavigated'),0);assert.ok(f.calls.some(row=>row.kind==='native-dispose'));assert.ok(f.calls.some(row=>row.kind==='backup-dispose'));assert.equal(f.companion.activity().cleanupUnknown,true);assert.throws(()=>f.companion._admit(f.record))
})
test('successful authority monitoring does not pause a running backup or reset its absolute cadence',async t=>{
 const f=await fixture(t);f.companion.statusClient={status:async()=>({current:true})};const pauses=f.calls.filter(row=>row.kind==='backup-pause').length,starts=f.calls.filter(row=>row.kind==='backup-start').length
 for(let i=0;i<4;i++)await f.companion._active(f.record)
 assert.equal(f.calls.filter(row=>row.kind==='backup-pause').length,pauses);assert.equal(f.calls.filter(row=>row.kind==='backup-start').length,starts)
})
test('reviewed return closes backup admission and awaits its exact pause before handover drain, then resumes a refused source',async t=>{
 const f=await fixture(t),entered=deferred<void>(),release=deferred<void>();let drained=false
 f.hooks.pause=async()=>{entered.resolve();await release.promise};f.companion.returnClient.pending=async()=>[{state:'pending',request:{requestId:randomUUID(),sourceAuthority:f.authority,expectedHeadManifestHash:null}}]
 f.companion.returnHandover={state:()=>({state:'blocked'}),async start(input:Row){input.closeAdmission();await input.drain();drained=true;input.resumeAdmission();throw Error('synthetic pre-stop refusal')}}
 const returning=f.companion._returnStep(f.record);await entered.promise;try{assert.equal(drained,false);assert.equal(f.state.paused,true);assert.equal(f.record.admission,'stopping')}finally{release.resolve()}await returning;assert.equal(drained,true);assert.equal(f.record.admission,'active');assert.equal(f.state.paused,false);assert.equal(f.record.returnRequestId,null)
})
test('an advisory unknown upload does not become an input authority failure or an automatic resend',async t=>{
 const f=await fixture(t);f.state.backupStatus={state:'unknown',busy:false,captureKind:'live-best-effort',uploadOutcome:'unknown'};await f.run();assert.equal(f.calls.filter(row=>row.kind==='engine').length,1);assert.equal(f.calls.filter(row=>row.kind==='backup-reconcile').length,0);assert.equal(f.state.backupStatus.state,'unknown')
})
test('normal daemon stop fences the backup timer synchronously before awaiting retirement producers',async t=>{
 const f=await fixture(t),stopping=f.companion.stop(),refused=assert.rejects(stopping);assert.equal(f.state.paused,true);await refused;assert.equal(f.state.paused,true);assert.equal(f.calls.filter(row=>row.kind==='backup-start').length,1)
})
