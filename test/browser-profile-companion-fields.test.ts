import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {AgentBrowserProfileCompanion} from '../lib/browser-profile-companion.mjs'
import {AgentRuntimePermissionRunner} from '../lib/browser-profile-permission-runner.mjs'
import {RelaySessions} from '../bin/hoai-browser-host.mjs'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
class Page extends EventEmitter{url(){return'https://site.test/task'}isClosed(){return false}}
async function fixture(t:{after:(callback:()=>unknown)=>void}){
 const calls:Row[]=[],hooks:Row={},page=new Page(),endpoint=codec.createEndpointIdentity(randomUUID()),scope={profileId:randomUUID(),actingUserId:'recipient',assistantId:42,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:7,ownerUserId:'sharer'}
 const connection:Row={bootId:randomUUID(),_stopped:false,pairing:{token:'synthetic-pairing',backendUrl:'https://hoai.test',pairingId:7,ownerUserId:'sharer',assistantIds:[42]},socketId:'socket-a',socket:{connected:true}}
 const authority={...Object.fromEntries(['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].map(key=>[key,scope[key as keyof typeof scope]])),bootId:connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1}
 const state:Row={now:Date.now(),frame:null,outcomeUnknown:false,permission:{state:'answered',choice:'allow_once'},factory:null},permissionHandle=Object.freeze({}),nativeCap=Object.freeze({})
 const client={async request(input:Row){calls.push({kind:'request',input});input.assertCurrent();if(hooks.request)await hooks.request(input);return{handle:permissionHandle,status:state.permission}},async read(){calls.push({kind:'read'});return state.permission},async consume(){calls.push({kind:'consume'});if(hooks.consume)return hooks.consume();return{state:'consumed',choice:'allow_once'}},async whenDrained(){calls.push({kind:'http-drain'})}}
 const engine={selectedPage:()=>page,roster:()=>['browser_type','browser_fill_form'].map(name=>({name,description:'Synthetic field fixture',inputSchema:{type:'object',additionalProperties:true}})),async callTool(){calls.push({kind:'unrestricted-engine'});return{content:[]}},async stop(){calls.push({kind:'engine-stop'})}}
 const runtime:Row={authority,state:'active',network:'active',assertCurrent(){if(this.state!=='active')throw Error('synthetic runtime inactive');return authority},async activate(){},async newPage(){},async dispose(){calls.push({kind:'native-dispose'});this.state='disposed';this.network='blocked'}}
 const fields={async prepare(input:Row){calls.push({kind:'prepare',input});state.factory.assertCurrent();if(hooks.prepare)await hooks.prepare(input);return nativeCap},async execute(input:Row){calls.push({kind:'native-execute',input});assert.strictEqual(input.capability,nativeCap);state.factory.assertCurrent();if(hooks.execute)return hooks.execute(input);return{content:[{type:'text',text:'Approved fields changed.'}]}},async cancel(cap:object){assert.strictEqual(cap,nativeCap);calls.push({kind:'cancel-field'})},async whenDrained(){calls.push({kind:'field-drain'});if(hooks.drain)await hooks.drain()},async dispose(){calls.push({kind:'field-dispose'});if(hooks.dispose)await hooks.dispose()},activity(){return{pendingPhysicalOperations:0,cleanupUnknown:false,outcomeUnknown:state.outcomeUnknown}}}
 const runner=new AgentRuntimePermissionRunner({client,now:()=>state.now,delay:async()=>{if(hooks.wait)await hooks.wait();state.now+=1000}}),companion:any=new AgentBrowserProfileCompanion({connection,agentRoot:path.join(os.tmpdir(),'hoai-field-fixture'),deviceLabel:'Fixture',client:{discover:async()=>({profiles:[entry]})},keyStore:{},stateStore:{},statusClient:null,permissionClient:client,permissionRunner:runner,loadBrowser:async()=>({}),createEngine:async()=>engine,createRelay:(core:Row)=>new RelaySessions({core,serverInfo:{name:'fixture',version:'1'},instructions:'Fixture',callCapMs:2000}),createFields:(input:Row)=>{state.factory=input;calls.push({kind:'field-factory',input});return fields as any}})
 const record:Row={scope,identity:endpoint.identity,endpoint,runtime,admission:'blocked',revoked:false,uncertain:false,engineTasks:new Set(),state:'saved'},entry={profile:{...authority,id:scope.profileId,writerState:'active',headManifestHash:null},grant:{generation:1,backgroundUse:true}}
 companion.records.set(scope.endpointId,record);companion._prove=async()=>{record.rpc.binding=Object.freeze({bindingId:randomUUID(),socketId:connection.socketId,authority})};await companion._activate(record,authority)
 companion.rpcClient.dispatch=async()=>({frame:structuredClone(state.frame)});companion.rpcClient.result=async(_authority:Row,_endpoint:Row,input:Row)=>{calls.push({kind:'completion',payload:input.payload});return{accepted:true}};companion.rpcClient.cancellation=async()=>({requested:true})
 const run=(name='browser_type',args:Row={target:'e1',element:'Title',text:'SYNTHETIC_KNOWN_TEXT'})=>{state.frame={event_type:'browser_profile_rpc',version:1,rpcId:randomUUID(),rpcNonce:'a'.repeat(43),bindingId:record.rpc.binding.bindingId,authority,clientId:'fixture-agent',assistantId:42,message:{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}},deadlineAt:new Date(state.now+120000).toISOString()};return companion.receive(state.frame,connection.socketId)}
 t.after(async()=>{record.relay?.close();record.rpc?.disconnect();await Promise.allSettled([...record.engineTasks]);runtime.state='disposed'})
 return{companion,record,state,calls,hooks,run,fields,runtime,engine,authority,scope,endpoint,connection}
}
test('actual endpoint and unchanged MCP relay prepare the original native fields before one typed approval and execution',async t=>{
 const f=await fixture(t);await f.run();assert.deepEqual(f.calls.filter(row=>['prepare','request','consume','native-execute'].includes(row.kind)).map(row=>row.kind),['prepare','request','consume','native-execute']);assert.equal(f.calls.some(row=>row.kind==='unrestricted-engine'),false)
 const input=f.calls.find(row=>row.kind==='native-execute')!.input;assert.equal(input.name,'browser_type');assert.deepEqual(input.args,f.state.frame.message.params.arguments);assert.strictEqual(f.state.factory.engine,f.engine);assert.strictEqual(f.state.factory.runtime,f.runtime);assert.equal(f.record.engineTasks.size,0);assert.equal(f.record.uncertain,false)
})
test('a native preflight refusal creates no permission or unrestricted engine call',async t=>{
 const f=await fixture(t);f.hooks.prepare=()=>{throw Object.assign(Error('profile_field_handover_required'),{code:'profile_field_handover_required'})};await f.run();assert.equal(f.calls.some(row=>['request','consume','native-execute','unrestricted-engine'].includes(row.kind)),false);assert.equal(f.record.engineTasks.size,0)
})
test('deny and unknown consume clean the original native capability without executing it',async t=>{
 for(const mode of ['deny','unknown-consume']){const f=await fixture(t);if(mode==='deny')f.state.permission={state:'answered',choice:'deny'};else f.hooks.consume=()=>{throw Error('synthetic lost acknowledgement')};await f.run();assert.equal(f.calls.some(row=>row.kind==='native-execute'),false);assert.equal(f.calls.filter(row=>row.kind==='prepare').length,1);assert.equal(f.calls.filter(row=>row.kind==='cancel-field').length,1);assert.equal(f.calls.filter(row=>row.kind==='request').length,1)}
})
test('credential wording, keys and direct text calls without original RPC cannot enter native field preparation',async t=>{
 const f=await fixture(t);await f.run('browser_type',{target:'e1',element:'Password',text:'known'});await f.companion._tool(f.record,'browser_type',{target:'e1',element:'Title',text:'known'},new AbortController().signal);await f.companion._tool(f.record,'browser_press_key',{key:'Enter'},new AbortController().signal);assert.equal(f.calls.some(row=>['prepare','request','native-execute','unrestricted-engine'].includes(row.kind)),false)
})
test('an unknown native field write remains explicit recovery after physical cleanup and cannot be replayed or handed over',async t=>{
 const f=await fixture(t);f.hooks.execute=()=>{f.state.outcomeUnknown=true;throw Object.assign(Error('profile_field_outcome_unknown'),{code:'profile_field_outcome_unknown'})};await f.run();assert.equal(f.record.uncertain,true);assert.equal(f.record.state,'field_outcome_unknown');assert.equal(f.record.engineTasks.size,0);assert.equal(f.runtime.state,'active');f.record.admission='active';assert.throws(()=>f.companion._admit(f.record));assert.equal(f.companion._returnStep(f.record),undefined);assert.throws(()=>f.run(),/authority_unknown/);assert.equal(f.calls.filter(row=>row.kind==='request').length,1);assert.equal(f.calls.filter(row=>row.kind==='native-execute').length,1)
})
test('runtime revocation starts physical shutdown independently of a held field disposer',async t=>{
 const f=await fixture(t);await f.run();const release=deferred<void>();f.hooks.dispose=()=>release.promise;let done=false;const stopping=f.companion.revoke().then(()=>{done=true});try{await tick();assert.equal(f.calls.some(row=>row.kind==='native-dispose'),true);assert.equal(f.calls.some(row=>row.kind==='field-dispose'),true);assert.equal(done,false)}finally{release.resolve()}await stopping;assert.equal(f.record.runtime,null)
})
test('original full authority and engine substitutions invalidate the retained native factory proof',async t=>{
 const f=await fixture(t);await f.run();f.runtime.authority={...f.authority,writerEpoch:2};assert.throws(()=>f.state.factory.assertCurrent());f.runtime.authority=f.authority;f.record.engine={...f.engine};assert.throws(()=>f.state.factory.assertCurrent())
})
