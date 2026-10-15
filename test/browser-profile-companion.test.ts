import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import * as fs from 'node:fs/promises'
import { randomUUID,sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { AgentBrowserProfileCompanion } from '../lib/browser-profile-companion.mjs'
import {AgentProfilePeerPins} from '../lib/browser-profile-peer-pins.mjs'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
async function until(predicate:()=>boolean){const deadline=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<deadline,'expected physical phase did not settle');await new Promise(resolve=>setImmediate(resolve))}}
async function fixture(t:{after:(callback:()=>unknown)=>void}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hoai-companion-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}))
  const endpoint=codec.createEndpointIdentity(randomUUID()),scope={profileId:randomUUID(),actingUserId:'recipient',assistantId:42,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:7,ownerUserId:'machine-owner'},entry={profile:{id:scope.profileId,actingUserId:scope.actingUserId,assistantId:42,revision:0,headManifestHash:null,contentKeyEpoch:1,writerEpoch:0,writerState:'idle',endpointId:null,bootId:null,runtimeId:null,sessionId:null},grant:{generation:1,backgroundUse:true},pendingDestinations:[]}
  const logs:string[]=[],calls:string[]=[],saved:Row[]=[],connection:any={bootId:randomUUID(),_stopped:false,pairing:{token:'synthetic',pairingId:7,backendUrl:'https://hoai.test',assistantIds:[42]},socketId:'socket-a',socket:{connected:true}}
  const client:any={activity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false}),pending:async()=>({intents:[],truncated:false}),discover:async()=>({profiles:[entry]}),pendingRuntimeRequests:async()=>[],ready:async()=>{calls.push('ready')},runtimeRequest:async()=>({state:'ready'})}
  const stateStore:any={loadAll:async()=>[],saveNew:async(row:Row)=>{saved.push(row);return row}},keyStore:any={protect:async()=>{calls.push('protect');return{encrypted:true}}}
  const returnClient:any={activity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false}),pending:async()=>[],read:async()=>{throw Error('unexpected return read')},checkpoint:async()=>{throw Error('unexpected return checkpoint')}}
  let options:Row|null=null
  const companion:any=new AgentBrowserProfileCompanion({connection,agentRoot:directory,deviceLabel:'Fixture agent',client,stateStore,keyStore,returnClient,statusClient:{status:async()=>({current:true})}as any,loadBrowser:async()=>({chromium:{},executable:'fixture'}),preloadExtras:async()=>({preflightExtras(){},captureExtras(){},commitExtras(){},dispose(){calls.push('extras-dispose')}})as any,createRuntime:async(input:Row)=>{options=input;calls.push('runtime-blocked');const runtime:any={authority:input.authority,state:'new',network:'blocked',async activate(authority:Row){await input.authorizeActivation();assert.deepEqual(authority,this.authority);this.state='active';this.network='active';calls.push('activate')},assertCurrent(){if(this.state!=='active')throw Error('inactive')},async newPage(){calls.push('page')},async dispose(){this.state='disposed';this.network='blocked';calls.push('dispose')}};return runtime},createEngine:async()=>({roster:()=>[],selectedPage:()=>({url:()=> 'https://fixture.test'}),callTool:async()=>{calls.push('tool');return{content:[]}},stop:async()=>{calls.push('engine-stop')}}),createRelay:()=>({relay:async()=>({ok:true,message:{}}),close(){}}),log:(line:string)=>logs.push(line)})
  companion._prove=async()=>{calls.push('prove')}
  const record:any={version:1,scope,identity:endpoint.identity,keyRecord:{},endpoint,runtime:null,admission:'blocked',revoked:false,uncertain:false,attempted:new Set(),engineTasks:new Set(),state:'saved'}
  const request:any={version:1,kind:'agent-runtime-request',requestId:randomUUID(),endpointId:scope.endpointId,purpose:'start',expectedWriterEpoch:0,expectedRevision:0,expectedHeadManifestHash:null,profileId:scope.profileId,actingUserId:scope.actingUserId,assistantId:42,endpointOwnerUserId:scope.ownerUserId,pairingId:7,nonce:'a'.repeat(64),expiresAt:Date.now()+200000,grantVersion:1,keyFingerprint:scope.keyFingerprint,contentKeyEpoch:1}
  return{companion,connection,record,scope,endpoint,entry,client,returnClient,calls,logs,saved,request,get options(){return options}}
}

async function activationFixture(t:{after:(callback:()=>unknown)=>void}){
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record)
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1}
  await f.companion._prepare(f.record,authority);Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key as keyof typeof authority]]))})
  return{...f,authority}
}

function proofSocket(f:any,holdBinding=false){
  let release!:()=>void;const events:string[]=[],socketId='socket-'+randomUUID(),socket:any={connected:true,emit(event:string,body:any,reply:(value:unknown)=>void){events.push(event);if(event==='browser_profile_challenge')reply({ok:true,challenge:{version:1,kind:'runtime-socket-binding',challengeId:randomUUID(),nonce:'a'.repeat(43),socketId,expiresAt:Date.now()+30000,authority:f.authority}});else if(event==='browser_profile_bind'){const complete=()=>reply({ok:true,binding:{bindingId:randomUUID(),socketId,authority:f.authority}});if(holdBinding)release=complete;else complete()}else if(event==='browser_profile_release')reply({ok:true,released:true});else throw Error('unexpected fixture proof event')}}
  f.connection.socket=socket;f.connection.socketId=socketId
  return{events,socket,socketId,get held(){return typeof release==='function'},release:()=>release()}
}

test('activation owns one exact promise before its first await and monitoring never proves a held engine',async t=>{
  const f=await activationFixture(t);let release!:(value:unknown)=>void
  f.companion.createEngine=()=>new Promise(resolve=>{release=resolve});const activating=f.companion._activate(f.record,f.authority),duplicate=f.companion._activate(f.record,{...f.authority});assert.equal(activating,duplicate);assert.equal(f.companion.activity().pendingPhysicalOperations,1)
  const mismatch=assert.rejects(f.companion._activate(f.record,{...f.authority,runtimeId:randomUUID()}),{code:'profile_companion_context_changed'});await until(()=>!!release)
  await f.companion.monitor();assert.equal(f.record.monitorTask,undefined);await f.companion._active(f.record);assert.equal(f.calls.includes('prove'),false);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  release({roster:()=>[],stop:async()=>{}});await activating;await mismatch;assert.equal(f.calls.filter(value=>value==='activate').length,1);assert.equal(f.calls.filter(value=>value==='prove').length,1);await f.companion._dispose(f.record);await f.companion.stop()
})

test('an initial held proof coalesces exact calls and blocks monitor until original activation completes',async t=>{
  const f=await activationFixture(t),socket=proofSocket(f,true);f.companion._prove=AgentBrowserProfileCompanion.prototype._prove
  const activating=f.companion._activate(f.record,f.authority);await until(()=>socket.held);const one=f.companion._prove(f.record),two=f.companion._prove(f.record);assert.equal(one,two);await f.companion.monitor();await f.companion._active(f.record);assert.equal(socket.events.filter(value=>value==='browser_profile_challenge').length,1);assert.equal(f.companion.activity().pendingPhysicalOperations,2)
  socket.release();await Promise.all([activating,one]);assert.ok(f.record.rpc.binding);assert.equal(f.companion.activity().pendingPhysicalOperations,0);await f.companion._dispose(f.record);await f.companion.stop()
})

test('normal stop begins physical native disposal before held engine activation settles',async t=>{
  const f=await activationFixture(t);let release!:(value:unknown)=>void,stopped=false,engines=0
  f.companion.createEngine=()=>new Promise(resolve=>{release=resolve});const activating=f.companion._activate(f.record,f.authority);void activating.catch(()=>{});await until(()=>!!release)
  const stopping=f.companion.stop().then(()=>{stopped=true});await until(()=>f.calls.includes('dispose'));assert.equal(stopped,false);assert.equal(f.record.runtime.state,'disposed');assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  release({roster:()=>[],stop:async()=>{engines++}});await assert.rejects(activating,{code:'profile_companion_context_changed'});await stopping;assert.equal(engines,1);assert.equal(f.calls.includes('prove'),false);assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
})

test('revoke starts native disposal independently and drains the original held socket proof',async t=>{
  const f=await activationFixture(t),socket=proofSocket(f,true);f.companion._prove=AgentBrowserProfileCompanion.prototype._prove
  const activating=f.companion._activate(f.record,f.authority);void activating.catch(()=>{});await until(()=>socket.held);let stopped=false;const revoking=f.companion.revoke().then(()=>{stopped=true});await until(()=>f.calls.includes('dispose'));assert.equal(stopped,false);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  socket.release();await assert.rejects(activating);await revoking;assert.equal(f.record.runtime,null);assert.equal(f.companion.activity().pendingPhysicalOperations,0)
})

test('failed activation cannot automatically reactivate or monitor an incompletely proved runtime',async t=>{
  const f=await activationFixture(t);let proofs=0;f.companion._prove=async()=>{proofs++;throw Error('synthetic proof refused')}
  const activating=f.companion._activate(f.record,f.authority);await assert.rejects(activating,/synthetic proof refused/);assert.equal(f.companion._activate(f.record,f.authority),activating);await assert.rejects(activating);await f.companion.monitor();await f.companion._active(f.record);assert.equal(proofs,1);assert.equal(f.record.admission,'unknown');await f.companion._dispose(f.record);await f.companion.stop()
})

test('a proved runtime retains legitimate same-authority reconnect after actual endpoint disconnect',async t=>{
  const f=await activationFixture(t),first=proofSocket(f);f.companion._prove=AgentBrowserProfileCompanion.prototype._prove;await f.companion._activate(f.record,f.authority);assert.equal(f.record.rpc.binding.socketId,first.socketId)
  f.companion.disconnected();first.socket.connected=false;assert.equal(f.record.rpc.binding,null);const next=proofSocket(f);await f.companion._active(f.record);assert.equal(f.record.rpc.binding.socketId,next.socketId);assert.equal(next.events.filter(value=>value==='browser_profile_challenge').length,1);assert.equal(f.record.admission,'active');await f.companion._dispose(f.record);await f.companion.stop()
})

test('a changed socket cannot borrow a held proof and original activation never replays it',async t=>{
  const f=await activationFixture(t),first=proofSocket(f,true);f.companion._prove=AgentBrowserProfileCompanion.prototype._prove;const activating=f.companion._activate(f.record,f.authority);void activating.catch(()=>{});await until(()=>first.held)
  f.companion.disconnected();first.socket.connected=false;const next=proofSocket(f);f.record.admission='active';const crossed=assert.rejects(f.companion._prove(f.record),{code:'profile_companion_context_changed'});assert.deepEqual(next.events,[]);first.release();await crossed;await assert.rejects(activating);await f.companion.monitor();assert.deepEqual(next.events,[]);await f.companion._dispose(f.record);await f.companion.stop()
})

test('disposal retains original activation before engine or RPC creation until its physical promise settles',async t=>{
  const f=await activationFixture(t);let release!:()=>void,entered=false,done=false
  f.record.runtime.activate=async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve});throw Error('synthetic activation cancelled')}
  const activating=f.companion._activate(f.record,f.authority);void activating.catch(()=>{});await until(()=>entered);const disposing=f.companion._dispose(f.record).then(()=>{done=true});await until(()=>f.calls.includes('dispose'));assert.equal(done,false);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  release();await assert.rejects(activating,/synthetic activation cancelled/);await disposing;assert.equal(f.record.runtime,null);await f.companion.stop()
})

test('disposal retains a reconnect proof independently after original activation ownership completed',async t=>{
  const f=await activationFixture(t),first=proofSocket(f);f.companion._prove=AgentBrowserProfileCompanion.prototype._prove;await f.companion._activate(f.record,f.authority);f.companion.disconnected();first.socket.connected=false;const next=proofSocket(f,true)
  const monitoring=f.companion._active(f.record);void monitoring.catch(()=>{});await until(()=>next.held);let done=false;const disposing=f.companion._dispose(f.record).then(()=>{done=true});await until(()=>f.calls.includes('dispose'));assert.equal(done,false);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  next.release();await assert.rejects(monitoring);await disposing;await f.companion.stop();assert.equal(f.companion.activity().pendingPhysicalOperations,0)
})
test('fresh host with no explicit recipient intent never invents a profile, key or native runtime',async t=>{const f=await fixture(t);await f.companion.poll();assert.deepEqual(f.calls,[]);assert.equal(f.companion.records.size,0);assert.ok(f.logs.some(line=>line.includes('setup_required')))})
test('activity counts held creation and actual disposal even after public native state becomes disposed',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let launch!:(value:unknown)=>void,finish!:()=>void,entered=false
  f.companion.createRuntime=()=>{entered=true;return new Promise(resolve=>{launch=resolve})}
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1}
  assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
  const preparing=f.companion._prepare(f.record,authority);while(!entered)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.companion.activity().activeProfiles,1);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  const runtime:any={authority,state:'new',dispose(){this.state='disposed';return new Promise<void>(resolve=>{finish=resolve})}};launch(runtime);await preparing
  assert.deepEqual(f.companion.activity(),{activeProfiles:1,pendingPhysicalOperations:0,cleanupUnknown:false});assert.ok(f.record.runtimeCreating);assert.ok(f.record.extrasCreating)
  const disposing=f.companion._dispose(f.record);while(!finish)await new Promise(resolve=>setImmediate(resolve));assert.equal(runtime.state,'disposed');assert.equal(f.companion.activity().activeProfiles,1);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  finish();await disposing;assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false});assert.ok(Object.isFrozen(f.companion.activity()))
})
test('failed native stop remains busy and unknown and is never automatically retried',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let stops=0
  f.record.runtime={state:'active',async dispose(){this.state='disposed';stops++;throw Error('physical stop unknown')}}
  await assert.rejects(f.companion._dispose(f.record));const activity=f.companion.activity();assert.equal(activity.activeProfiles,1);assert.ok(activity.pendingPhysicalOperations>0);assert.equal(activity.cleanupUnknown,true)
  await assert.rejects(f.companion._dispose(f.record));assert.equal(stops,1);assert.deepEqual(f.companion.activity(),activity)
})
test('activity counts extras and engine factories until their actual promises settle',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let extras!:(value:unknown)=>void,engine!:(value:unknown)=>void,started=false
  f.companion.preloadExtras=()=>{started=true;return new Promise(resolve=>{extras=resolve})}
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1},preparing=f.companion._prepare(f.record,authority)
  while(!started)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.companion.activity().activeProfiles,0);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  extras({preflightExtras(){},captureExtras(){},commitExtras(){},dispose(){}});await preparing;Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key as keyof typeof authority]]))})
  f.companion.createEngine=()=>new Promise(resolve=>{engine=resolve});const activating=f.companion._activate(f.record,authority);while(!engine)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.companion.activity().activeProfiles,1);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  engine({roster:()=>[],stop:async()=>{}});await activating;assert.deepEqual(f.companion.activity(),{activeProfiles:1,pendingPhysicalOperations:0,cleanupUnknown:false});await f.companion._dispose(f.record);await f.companion.stop();assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
})
test('activity aggregates retained transport work and treats missing or malformed occupied client evidence as unknown',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record)
  f.returnClient.activity=()=>({pendingPhysicalOperations:1,cleanupUnknown:false});assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:1,cleanupUnknown:false})
  f.returnClient.activity=()=>({pendingPhysicalOperations:0,cleanupUnknown:true});assert.equal(f.companion.activity().cleanupUnknown,true)
  for(const value of [undefined,()=>({pendingPhysicalOperations:-1,cleanupUnknown:false}),()=>Promise.resolve({pendingPhysicalOperations:0,cleanupUnknown:false})]){f.returnClient.activity=value;const state=f.companion.activity();assert.ok(state.pendingPhysicalOperations>0);assert.equal(state.cleanupUnknown,true)}
})
test('a pending return prevents stale signed status from reopening source command admission',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let reply!:(value:unknown)=>void
  f.record.runtime={state:'active',authority:{},dispose:async()=>{}};f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()}};f.record.admission='active'
  f.companion.statusClient={status:()=>new Promise(resolve=>{reply=resolve})};const work=f.companion._active(f.record)
  f.record.returnRequestId=randomUUID();f.record.admission='stopping';reply({current:true});await work;assert.equal(f.record.admission,'stopping')
})
test('a stale unbound discovery cannot rebind a returning source',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let reply!:(value:unknown)=>void
  const authority={...f.scope,bootId:'boot',runtimeId:'runtime',sessionId:'session',writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1};f.record.runtime={state:'active',authority};f.record.rpc={binding:null};f.record.admission='active'
  f.client.discover=()=>new Promise(resolve=>{reply=resolve});const work=f.companion._active(f.record);f.record.returnRequestId=randomUUID();f.record.admission='stopping'
  reply({profiles:[f.entry]});await work;assert.equal(f.record.admission,'stopping');assert.equal(f.calls.includes('prove'),false)
})
test('normal daemon stop waits for an in-flight return and never substitutes self retirement',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let finish!:()=>void,done=false,retired=0
  f.record.runtime={state:'active',dispose:async()=>{f.calls.push('dispose')}};f.record.returnRequestId=randomUUID();f.record.returnTask=new Promise<void>(resolve=>{finish=()=>{f.record.runtime.state='stopped';f.record.returnTask=null;resolve()}})
  f.companion.retire=async()=>{retired++};const stopping=f.companion.stop().then(()=>{done=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(retired,0)
  finish();await stopping;assert.equal(retired,0);assert.equal(f.calls.includes('dispose'),true)
})

test('normal stop fences a held setup poll before publication and waits for its later physical cleanup',async t=>{
  const f=await fixture(t);let release!:(value:unknown)=>void,finish!:()=>void,entered=false,producerSettled=false,physical=false,drains=0,done=false
  const cleanup=new Promise<void>(resolve=>{finish=()=>{physical=false;resolve()}})
  f.client.pending=async()=>{entered=true;const value=await new Promise(resolve=>{release=resolve});producerSettled=true;physical=true;return value}
  f.client.activity=()=>({pendingPhysicalOperations:physical?1:0,cleanupUnknown:false});f.client.whenDrained=async()=>{drains++;assert.equal(producerSettled,true);await cleanup}
  const polling=f.companion.poll();await until(()=>entered)
  const stopping=f.companion.stop().then(()=>{done=true});assert.equal(f.companion.stop(),f.companion.stopTask);await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(drains,0)
  release({intents:[{intentId:randomUUID(),offer:null}],truncated:false});await polling;await until(()=>drains>0)
  assert.equal(f.companion.candidates.size,0);assert.equal(done,false);assert.ok(f.companion.activity().pendingPhysicalOperations>0);finish();await stopping
  assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false});assert.equal(f.companion.stopped,true)
})

test('normal stop waits for the original monitor and its retained physical status read',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let reply!:(value:unknown)=>void,finish!:()=>void,done=false
  f.record.runtime={state:'active',authority:{},dispose:async()=>{f.calls.push('dispose')}};f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()},disconnect(){},close:async()=>{}};f.record.admission='active'
  const status:any={status:()=>new Promise(resolve=>{reply=resolve}),physical:new Promise<void>(resolve=>{finish=()=>{status.physical=null;resolve()}})};f.companion.statusClient=status
  const monitoring=f.companion.monitor(),stopping=f.companion.stop().then(()=>{done=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(f.calls.includes('dispose'),false)
  f.record.runtime.state='stopped';reply({current:false});await monitoring;await until(()=>f.calls.includes('dispose'));assert.equal(f.record.revoked,false);assert.equal(done,false)
  finish();await stopping;assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
})

test('normal stop retains an RPC close producer before its later completion HTTP and avoids self-close deadlock',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let release!:()=>void,finish!:()=>void,closing=false,closeSettled=false,http=false,done=false,drains=0
  const cleanup=new Promise<void>(resolve=>{finish=()=>{http=false;resolve()}})
  f.record.runtime={state:'stopped',dispose:async()=>{}};f.record.rpc={disconnect(){},close:async()=>{closing=true;await new Promise<void>(resolve=>{release=resolve});closeSettled=true;http=true}}
  f.client.activity=()=>({pendingPhysicalOperations:http?1:0,cleanupUnknown:false});f.client.whenDrained=async()=>{drains++;assert.equal(closeSettled,true);await cleanup}
  const stopping=f.companion.stop().then(()=>{done=true});await until(()=>closing);assert.equal(done,false);assert.equal(drains,0);assert.ok(f.companion.activity().pendingPhysicalOperations>0)
  release();await until(()=>drains>0);assert.equal(done,false);finish();await stopping;assert.deepEqual(f.companion.activity(),{activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false})
})

test('a failed RPC close stays physically unknown and daemon stop is never retried automatically',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let closes=0;f.record.runtime={state:'stopped',dispose:async()=>{}};f.record.rpc={disconnect(){},close:async()=>{closes++;throw Error('PRIVATE_CLOSE')}}
  await assert.rejects(f.companion.stop(),/stop_unconfirmed/);assert.equal(f.companion.activity().cleanupUnknown,true);assert.ok(f.companion.activity().pendingPhysicalOperations>0);await assert.rejects(f.companion.stop(),/stop_unconfirmed/);assert.equal(closes,1)
})

test('closing invalidates captured discovery proofs but preserves only the exact accepted retirement',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,writerEpoch:1,revision:0,contentKeyEpoch:1}
  f.record.runtime={state:'active',authority,assertCurrent(){},dispose:async()=>{}};f.record.admission='active';let release!:()=>void,entered=false,retirements=0
  const ordinary=await f.companion.rpcClient.authorizePairing({purpose:'endpoint-discovery',...f.scope})
  f.companion._retire=async()=>{retirements++;entered=true;await new Promise<void>(resolve=>{release=resolve});const context={purpose:'retirement',actingUserId:f.scope.actingUserId,assistantId:42,authority}
    const proof=await f.companion.rpcClient.authorizePairing(context);proof.assertCurrent()
    for(const change of [{purpose:'endpoint-discovery'},{authority:{...authority,profileId:randomUUID()}},{actingUserId:'sharer'}])await assert.rejects(f.companion.rpcClient.authorizePairing({...context,...change}),/context_changed/)
    const original=f.record.endpoint;f.record.endpoint={...original};assert.throws(proof.assertCurrent,/context_changed/);f.record.endpoint=original;proof.assertCurrent();f.record.runtime.state='stopped'
  }
  const retiring=f.companion.retire(f.record);while(!entered)await new Promise(resolve=>setImmediate(resolve));const stopping=f.companion.stop();assert.throws(ordinary.assertCurrent,/context_changed/);release();await retiring;await stopping;assert.equal(retirements,1)
  await assert.rejects(f.companion.rpcClient.authorizePairing({purpose:'retirement',actingUserId:f.scope.actingUserId,assistantId:42,authority}),/context_changed/)
})

test('a duplicate accepted retirement never creates a second physical finalizer',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.record.runtime={state:'active',authority:{profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,writerEpoch:1,revision:0,contentKeyEpoch:1},assertCurrent(){}};f.record.admission='active';let finalizers=0
  f.companion._retire=async()=>{finalizers++};await Promise.all([f.companion.retire(f.record),f.companion.retire(f.record)]);assert.equal(finalizers,1)
})
test('unknown local journal inspection blocks a fresh runtime instead of falling through to own-head restore',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let prepared=0
  f.record.journal={inspectCandidate:async()=>{throw Error('unknown local journal')}};f.companion._prepare=async()=>{prepared++};f.client.pendingRuntimeRequests=async()=>[{state:'pending',request:f.request}]
  await assert.rejects(f.companion._step(f.record));assert.equal(f.record.uncertain,true);await f.companion._step(f.record);assert.equal(prepared,0)
})
test('an original reviewed return drains and confirms an injected durable encrypted journal before the paired POST',async t=>{
  const f=await fixture(t),desktop=codec.createEndpointIdentity(randomUUID()),shared=require('../lib/browser-profile-core/coordinator-client.js'),wire=require('../lib/browser-profile-core/return-intent.js');f.companion.records.set(f.scope.endpointId,f.record)
  const review={version:1,kind:'agent-peer-pin-review',profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,agentEndpointId:f.scope.endpointId,agentKeyFingerprint:f.scope.keyFingerprint,peerIdentity:desktop.identity,peerKeyFingerprint:codec.identityFingerprint(desktop.identity)}
  await new AgentProfilePeerPins({directory:path.join(f.companion.directory,'peer-pins',f.scope.endpointId)}).review({scope:f.scope,endpoint:f.endpoint,document:review,confirmation:review.peerKeyFingerprint,assertCurrent:()=>true})
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1}
  await f.companion._prepare(f.record,authority);let journalSaved:any=null;f.record.journal={write:async(row:Row)=>{journalSaved=row;return{durability:{fileSynced:true,directorySynced:true}}},read:async()=>journalSaved,inspectCandidate:async()=>({receiptKind:journalSaved.receipt.kind,cryptoTransitionId:journalSaved.checkpoint.manifest.transitionId})};Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key as keyof typeof authority]]))});await f.companion._activate(f.record,authority);f.calls.length=0
  const request={version:1,kind:'agent-browser-return-intent',requestId:randomUUID(),nonce:Buffer.alloc(32,1).toString('base64url'),sourceAuthority:authority,destination:{endpointId:desktop.identity.endpointId,keyFingerprint:review.peerKeyFingerprint,bootId:'desktop-boot',runtimeId:'desktop-runtime',sessionId:'desktop-session',grantVersion:1},expectedHeadManifestHash:null,expiresAt:Date.now()+200000},signature=shared.documentSignature(desktop,request),status={request,signature,intentHash:wire.returnIntentHash({request,signature}),state:'pending',manifestHash:null,writeConsumed:false,transitionPhase:null,sourceStopped:null}
  const epoch=codec.createContentKeyEpoch(1);f.record.contentKeyEpoch=epoch;let physicalFinished=false,finish!:()=>void;const physical=new Promise<void>(resolve=>{finish=()=>{physicalFinished=true;resolve()}});f.record.engineTasks.add(physical);void physical.finally(()=>f.record.engineTasks.delete(physical))
  let stopped:any;f.record.runtime.finalize=async({context,source,destinationIdentity}:Row)=>{assert.equal(physicalFinished,true);const barrier=await f.options!.closeAndDrain();assert.equal(barrier.drained,true);f.calls.push('native-stopped');const plaintext=Buffer.from('SYNTHETIC_COMPANION_RETURN_ONLY'),checkpoint=codec.sealCheckpoint({plaintext,context,source,destinationIdentity,contentKeyEpoch:epoch});plaintext.fill(0);const hash=codec.manifestHash(checkpoint.manifest),receipt={version:1,kind:'source-stopped',profileId:f.scope.profileId,transitionId:request.requestId,manifestHash:hash,revision:1,source:context.source,stopped:true};stopped={checkpoint,receipt,signature:shared.documentSignature(f.endpoint,receipt)};f.record.runtime.state='stopped';f.record.runtime.network='blocked';await f.options!.checkpoint(stopped);f.calls.push('durable-journal');return stopped}
  f.returnClient.pending=async()=>[status];f.returnClient.checkpoint=async()=>{assert.equal(physicalFinished,true);const candidate=await f.record.journal.inspectCandidate({scope:f.record.journalScope,assertCurrent:()=>true});assert.equal(candidate.receiptKind,'source-stopped');assert.equal(candidate.cryptoTransitionId,request.requestId);f.calls.push('paired-return-post');return{...status,state:'checkpoint-committed',manifestHash:codec.manifestHash(stopped.checkpoint.manifest),writeConsumed:true,transitionPhase:'checkpoint_committed',sourceStopped:{receipt:stopped.receipt,signature:stopped.signature}}}
  const returning=f.companion._step(f.record);void returning.catch(()=>{});const deadline=Date.now()+5000;while(f.record.admission!=='stopping'&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.includes('native-stopped'),false);assert.equal(f.record.admission,'stopping');finish();await returning
  assert.deepEqual(f.calls.slice(0,3),['native-stopped','durable-journal','paired-return-post']);assert.equal(f.record.runtime,null);assert.equal(f.record.state,'returned');assert.equal(f.record.admission,'blocked')
})
test('different recipients get distinct generated candidate keys and background consent never acquires a writer',async t=>{const f=await fixture(t),base={intentId:randomUUID(),profileId:f.scope.profileId,actingUserId:'recipient',assistantId:42,ownerUserId:'machine-owner',pairingId:7,requestNonce:'a'.repeat(43),expiresAt:Date.now()+200000,state:'pending',offer:null,acceptedEndpoint:null},other={...base,intentId:randomUUID(),profileId:randomUUID(),actingUserId:'other-recipient'};f.client.pending=async()=>({intents:[base,other],truncated:false});f.client.publish=async()=>({});await f.companion.poll();await f.companion.poll();await f.companion.poll();const rows=[...f.companion.candidates.values()]as Row[];assert.equal(rows.length,2);assert.notEqual(rows[0].scope.endpointId,rows[1].scope.endpointId);assert.notEqual(rows[0].scope.keyFingerprint,rows[1].scope.keyFingerprint);assert.notEqual(rows[0].scope.actingUserId,rows[1].scope.actingUserId);await f.companion._candidate(rows[0]);await f.companion._candidate(rows[0]);assert.equal(f.saved.length,1);assert.equal(f.calls.includes('runtime-blocked'),false);assert.equal(f.calls.includes('activate'),false)})
test('blocked runtime readiness waits for exact human confirmation and fresh active profile before network opens',async t=>{const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.client.pendingRuntimeRequests=async()=>[{state:'pending',request:f.request}];await f.companion._step(f.record);assert.deepEqual(f.calls,['runtime-blocked','ready']);assert.equal(f.record.runtime.state,'new');await f.companion._step(f.record);assert.equal(f.calls.includes('activate'),false);const authority=f.record.runtime.authority;Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key]]))});f.client.runtimeRequest=async()=>({state:'confirmed',confirmation:{authority}});await f.companion._step(f.record);assert.deepEqual(f.calls,['runtime-blocked','ready','activate','page','prove']);assert.equal(f.record.admission,'active');assert.equal(f.record.runtime.network,'active')})
test('lost ready write is never retried or allowed to open the staged destination',async t=>{const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.client.pendingRuntimeRequests=async()=>[{state:'pending',request:f.request}];let writes=0;f.client.ready=async()=>{writes++;throw Object.assign(Error('synthetic missing ack'),{code:'profile_companion_outcome_unknown'})};await assert.rejects(f.companion._step(f.record),{code:'profile_companion_outcome_unknown'});assert.equal(f.record.uncertain,true);assert.equal(f.record.runtime,null);await f.companion._step(f.record);assert.equal(writes,1);assert.equal(f.calls.includes('activate'),false);assert.equal(f.calls.includes('dispose'),true)})
test('known signed status revocation disposes physical runtime while network unknown only closes new admission',async t=>{for(const known of [false,true]){const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.record.runtime={state:'active',authority:{},dispose:async()=>{f.calls.push('dispose')}};f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()},close:async()=>{}};f.record.admission='active';f.companion.statusClient={status:async()=>{if(!known)throw Error('unavailable');return{current:false}}};await f.companion._active(f.record);if(known){assert.equal(f.record.revoked,true);assert.equal(f.calls.includes('dispose'),true);assert.equal(f.record.runtime,null)}else{assert.equal(f.record.admission,'unknown');assert.equal(f.calls.includes('dispose'),false);assert.equal(f.record.runtime.state,'active')}}})
test('managed site policy never treats profile background consent as credential or write permission',async t=>{const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.record.runtime={state:'active',assertCurrent(){}};f.record.admission='active';f.record.engine={selectedPage:()=>({url:()=> 'https://fixture.test'}),callTool:async()=>{f.calls.push('tool');return{content:[]}}};const result=await f.companion._tool(f.record,'browser_type',{ref:'password',text:'synthetic-never-send'},new AbortController().signal);assert.equal(result.isError,true);assert.equal(f.calls.includes('tool'),false);await f.companion._tool(f.record,'browser_snapshot',{},new AbortController().signal);assert.equal(f.calls.filter(value=>value==='tool').length,1)})

test('normal browser close refusal preserves the active page and never uses daemon emergency cleanup',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);f.record.entry=f.entry;f.record.admission='active';f.record.runtime={state:'active',authority:{profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,keyFingerprint:f.scope.keyFingerprint,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,writerEpoch:1,revision:0,contentKeyEpoch:1},assertCurrent(){},finalize:async()=>{throw Object.assign(Error('dirty'),{code:'profile_unsaved_form_state'})},emergencyStopOwnedProcess:async()=>{f.calls.push('emergency')}}
  await assert.rejects(f.companion._tool(f.record,'browser_close',{},new AbortController().signal),{code:'profile_unsaved_form_state'});assert.equal(f.record.runtime.state,'active');assert.equal(f.record.admission,'active');assert.equal(f.record.uncertain,false);assert.equal(f.calls.includes('dispose'),false);assert.equal(f.calls.includes('emergency'),false)
})

test('persistent extras proofs survive normal closing but reject runtime record scope and revocation changes',async t=>{
  for(const fault of ['replacement-runtime','authority','recipient','disposal','revocation']){
    const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let stored!:()=>void
    f.companion.preloadExtras=async(input:Row)=>{stored=input.assertCurrent;stored();return{preflightExtras(){stored();return{}},captureExtras(){stored();return{}},commitExtras(){stored()},dispose(){}}}
    const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint,writerEpoch:1,revision:0,contentKeyEpoch:1}
    await f.companion._prepare(f.record,authority);f.companion.closing=true;assert.doesNotThrow(stored);assert.doesNotThrow(()=>f.options!.preflightExtras({authority}));assert.doesNotThrow(()=>f.options!.captureExtras({authority}))
    const originalRuntime=f.record.runtime
    if(fault==='replacement-runtime')f.record.runtime={...f.record.runtime}
    else if(fault==='authority')f.record.runtime.authority={...authority,revision:1}
    else if(fault==='recipient')f.record.scope={...f.record.scope,actingUserId:'sharer'}
    else if(fault==='disposal'){await f.companion._dispose(f.record);f.record.runtime=originalRuntime}
    else f.record.revoked=true
    assert.throws(stored,/context_changed/)
  }
})

test('normal closing during extras creation still refuses before native construction',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let entered=false,release!:(value:unknown)=>void
  f.companion.preloadExtras=()=>{entered=true;return new Promise(resolve=>{release=resolve})}
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint,writerEpoch:1,revision:0,contentKeyEpoch:1},work=f.companion._prepare(f.record,authority),rejected=assert.rejects(work,/context_changed/)
  while(!entered)await new Promise(resolve=>setImmediate(resolve));f.companion.closing=true;release({dispose(){}});await rejected;assert.equal(f.calls.includes('runtime-blocked'),false)
})

test('active signed monitoring is independent of slow setup and coalesces one physical operation per runtime',async t=>{
  const f=await fixture(t);let release!:(value:unknown)=>void,reads=0;f.companion.records.set(f.scope.endpointId,f.record);f.record.runtime={state:'active',authority:{},dispose:async()=>{f.calls.push('dispose')}};f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()},close:async()=>{}};f.record.admission='active'
  f.companion.statusClient={status:()=>{reads++;return new Promise(resolve=>{release=resolve})}};f.companion.pending=new Promise(()=>{})
  for(let count=0;count<100;count++)void f.companion.poll()
  assert.equal(reads,1);assert.equal(f.calls.includes('dispose'),false);release({current:false});await f.record.monitorTask;assert.equal(f.record.revoked,true);assert.equal(f.calls.includes('dispose'),true)
})
test('an old signed false status cannot dispose or pause a replacement runtime',async t=>{const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let reply!:(value:unknown)=>void;const old={state:'active',authority:{},dispose:async()=>f.calls.push('wrong-dispose')},replacement={state:'active',authority:{},dispose:async()=>f.calls.push('new-dispose')};f.record.runtime=old;f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()}};f.record.admission='active';f.companion.statusClient={status:()=>new Promise(resolve=>{reply=resolve})};const task=f.companion._active(f.record);f.record.runtime=replacement;f.record.rpc={binding:{socketId:'socket-a',bindingId:randomUUID()}};reply({current:false});await task;assert.equal(f.record.runtime,replacement);assert.equal(f.record.admission,'active');assert.deepEqual(f.calls,[])})
test('revocation during a physical runtime launch waits for and destroys the late native object once',async t=>{const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let release!:(value:unknown)=>void,entered=false,disposed=0;f.companion.createRuntime=()=>{entered=true;return new Promise(resolve=>{release=resolve})};const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint,writerEpoch:1,revision:0,contentKeyEpoch:1},preparing=f.companion._prepare(f.record,authority);void preparing.catch(()=>{});for(let count=0;count<100&&!entered;count++)await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);let done=false;const revoking=f.companion.revoke().then(()=>{done=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);release({state:'new',dispose:async()=>{disposed++}});await assert.rejects(preparing,{code:'profile_companion_context_changed'});await revoking;assert.equal(disposed,1);assert.equal(f.record.runtime,null)})

test('termination before queued factory admission never starts a late browser',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let release!:(value:unknown)=>void,loaded=false,launches=0
  f.companion.loadBrowser=()=>{loaded=true;return new Promise(resolve=>{release=resolve})};f.companion.createRuntime=async()=>{launches++;throw Error('must not launch')}
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint,writerEpoch:1,revision:0,contentKeyEpoch:1},preparing=f.companion._prepare(f.record,authority);void preparing.catch(()=>{})
  while(!loaded)await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.companion.emergencyTerminate()).stopped,true);release({chromium:{},executable:'fixture'});await assert.rejects(preparing,{code:'profile_companion_context_changed'});assert.equal(launches,0)
})

test('termination waits for delayed immutable native ownership and stops it before creation settles',async t=>{
  const f=await fixture(t);f.companion.records.set(f.scope.endpointId,f.record);let captured:any,release!:(value:unknown)=>void,physicalStops=0,done=false
  f.companion.createRuntime=(options:any)=>{captured=options;return new Promise(resolve=>{release=resolve})}
  const authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint,writerEpoch:1,revision:0,contentKeyEpoch:1},preparing=f.companion._prepare(f.record,authority);void preparing.catch(()=>{})
  while(!captured)await new Promise(resolve=>setImmediate(resolve));const stopping=f.companion.emergencyTerminate().then((value:Row)=>{done=true;return value});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false)
  const capability=Object.freeze({stop:async()=>{physicalStops++;return{stopped:true,recoveryRequired:true}}});assert.throws(()=>captured.onOwnedProcess(capability),{code:'profile_companion_context_changed'});assert.equal((await stopping).stopped,true);assert.equal(physicalStops,1)
  release({state:'new',dispose:async()=>{}});await assert.rejects(preparing,{code:'profile_companion_context_changed'});assert.equal(f.record.processStop,capability);assert.equal(physicalStops,1)
})
test('receive readiness cannot borrow a source key from relay metadata',async t=>{const f=await fixture(t),source=codec.createEndpointIdentity(randomUUID());f.companion.records.set(f.scope.endpointId,f.record);Object.assign(f.entry.profile,{writerState:'active',endpointId:source.identity.endpointId,bootId:'source-boot',runtimeId:'source-runtime',sessionId:'source-session',writerEpoch:3});f.client.pendingRuntimeRequests=async()=>[{state:'pending',request:{...f.request,purpose:'receive-transfer',expectedWriterEpoch:3}}];await f.companion._step(f.record);assert.equal(f.calls.includes('runtime-blocked'),false);assert.equal(f.calls.includes('ready'),false);assert.ok(f.logs.some(line=>line.includes('reviewed_source_pin_required')))})
async function resumeFixture(t:any){
  const f=await fixture(t),source=codec.createEndpointIdentity(randomUUID());f.companion.records.set(f.scope.endpointId,f.record)
  const document={version:1,kind:'agent-peer-pin-review',profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,agentEndpointId:f.scope.endpointId,agentKeyFingerprint:f.scope.keyFingerprint,peerIdentity:source.identity,peerKeyFingerprint:codec.identityFingerprint(source.identity)}
  await new AgentProfilePeerPins({directory:path.join(f.companion.directory,'peer-pins',f.scope.endpointId)}).review({scope:f.scope,endpoint:f.endpoint,document,confirmation:document.peerKeyFingerprint,assertCurrent:()=>true})
  Object.assign(f.entry.profile,{writerState:'active',endpointId:source.identity.endpointId,bootId:'source-boot',runtimeId:'source-runtime',sessionId:'source-session',writerEpoch:3})
  const request={...f.request,purpose:'receive-transfer',expectedWriterEpoch:3,version:2,schemaVersion:2,sourceEndpoint:{kind:'desktop',ownerUserId:f.scope.actingUserId,pairingId:null,identity:source.identity,keyFingerprint:codec.identityFingerprint(source.identity),grantVersion:2}}
  const pending={request,state:'pending',ready:null,confirmation:null};f.client.pendingRuntimeRequests=async()=>[pending]
  return Object.assign(f,{source,request,pending})
}
test('version2 receive role owner and exact locally reviewed source identity are proved before runtime preparation or ready',async t=>{
  const foreign=codec.createEndpointIdentity(randomUUID())
  for(const patch of [{kind:'agent'},{ownerUserId:'sharing-owner'},{pairingId:7},{grantVersion:0},{identity:codec.createEndpointIdentity(randomUUID()).identity},{identity:foreign.identity,keyFingerprint:codec.identityFingerprint(foreign.identity)},{keyFingerprint:'0'.repeat(64)}]){
    const f=await resumeFixture(t);Object.assign(f.request.sourceEndpoint,patch);await assert.rejects(f.companion._step(f.record),/source_pin_changed/);assert.equal(f.calls.includes('runtime-blocked'),false);assert.equal(f.calls.includes('ready'),false)
  }
})
test('only exact fresh version2 receive can issue a private reviewed-URL capability, then restore actual selected page without an extra blank',async t=>{
  const f=await resumeFixture(t);await f.companion._step(f.record);const options:any=f.options,authority=f.record.runtime.authority
  assert.equal(Object.isFrozen(f.record.request.sourceEndpoint),true);assert.throws(()=>options.authorizeReviewedResume({}),/review_required/)
  const shared=require('../lib/browser-profile-core/coordinator-client.js'),portable=require('../lib/browser-profile-core/portable-state.js'),sourceIdentity={endpointId:f.source.identity.endpointId,bootId:'source-boot',runtimeId:'source-runtime',sessionId:'source-session',writerEpoch:3},target=Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint'].map(key=>[key,authority[key]]))
  const context={version:1,schemaVersion:2,profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,transitionId:randomUUID(),revision:1,previousManifestHash:null,keyEpoch:1,source:sourceIdentity,destination:target},resumeTabs={version:1,selectedIndex:0,tabs:[{url:'https://site.test/list?view=recent#part',title:'Reviewed source'}]},epoch=codec.createContentKeyEpoch(1)
  const plaintext=portable.encodePortableState({schema:portable.SCHEMA_V2,cookies:[],origins:[],passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'google'},resumeTabs},2);let checkpoint:any
  try{checkpoint=codec.sealCheckpoint({plaintext,context,source:f.source,destinationIdentity:f.endpoint.identity,contentKeyEpoch:epoch})}finally{plaintext.fill(0);epoch.key.fill(0)}
  const manifestHash=codec.manifestHash(checkpoint.manifest),transition={id:context.transitionId,profileId:f.scope.profileId,kind:'transfer',phase:'checkpoint_committed',source:sourceIdentity,destination:target,sourceRevision:0,sourceManifestHash:null,contentKeyEpoch:1,manifestHash}
  Object.assign(f.entry.profile,{writerState:'stopped',revision:1,headManifestHash:manifestHash});(f.entry as Row).pendingDestinations=[{transitionId:transition.id,phase:'checkpoint_committed',destination:target}]
  const document={...f.record.request,kind:'agent-runtime-ready',...Object.fromEntries(['bootId','runtimeId','sessionId'].map(key=>[key,authority[key]]))},body={document,signature:shared.documentSignature(f.endpoint,document),startSignature:null},ready={...body,readyHash:require('node:crypto').createHash('sha256').update(shared.canonical(body)).digest('hex')},status:any={request:f.record.request,state:'confirmed',ready,confirmation:{destination:target}}
  f.client.transition=async()=>({profile:f.entry.profile,transition,admission:{source:{admitted:true,keyFingerprint:codec.identityFingerprint(f.source.identity)},destination:{admitted:true,backgroundUse:true,grantVersion:1,keyFingerprint:f.scope.keyFingerprint}}})
  f.client.runtimeRequest=async()=>{f.calls.push('fresh-source-grant');return status};f.client.capsule=async()=>{f.calls.push('download-original');return checkpoint};f.client.staged=async()=>({writerState:'staged',headManifestHash:manifestHash,revision:1})
  let proof:any,saved:any;f.record.runtime.stage=async(input:Row)=>{f.calls.push('stage-inactive');assert.equal(input.expectedContext.schemaVersion,2);for(const patch of [{checkpoint:{...input.checkpoint,manifest:{...input.checkpoint.manifest,transitionId:randomUUID()}}},{expectedContext:{...input.expectedContext,transitionId:randomUUID()}},{sourceIdentity:codec.createEndpointIdentity(f.source.identity.endpointId).identity}])assert.throws(()=>options.authorizeReviewedResume({...input,...patch,resumeTabs}),/review_required/);proof=options.authorizeReviewedResume({...input,resumeTabs});proof.assertCurrent();assert.throws(()=>options.authorizeReviewedResume({...input,resumeTabs}),/review_required/);f.record.runtime.state='staged';const receipt={version:1,kind:'destination-staged',profileId:f.scope.profileId,transitionId:transition.id,manifestHash,revision:1,destination:target,stagedInactive:true};return{receipt,signature:shared.documentSignature(f.endpoint,receipt)}}
  f.record.journal={write:async(row:Row)=>{saved=row;return{durability:{fileSynced:true,directorySynced:true}}},read:async()=>saved}
  const original=status.request;status.request={...original,sourceEndpoint:{...original.sourceEndpoint,grantVersion:3}};await assert.rejects(f.companion._receiveTransfer(f.record,f.entry,status),/source_pin_changed/);assert.equal(f.calls.includes('download-original'),false);status.request=original
  const originalRead=f.client.runtimeRequest;f.client.runtimeRequest=async()=>{throw Error('current_source_grant_revoked')};await assert.rejects(f.companion._receiveTransfer(f.record,f.entry,status),/current_source_grant_revoked/);assert.equal(f.calls.includes('stage-inactive'),false);f.client.runtimeRequest=originalRead
  await f.companion._receiveTransfer(f.record,f.entry,status);assert.ok(f.calls.indexOf('fresh-source-grant')<f.calls.indexOf('stage-inactive'));assert.equal(f.record.runtime.network,'blocked')
  const old=f.record.sourcePin;f.record.sourcePin=codec.createEndpointIdentity(old.endpointId).identity;assert.throws(()=>proof.assertCurrent(),/review_required/);f.record.sourcePin=old
  const selected={url:()=>resumeTabs.tabs[0].url};let actual:any=null;f.record.runtime.restoredSelectedPage=()=>selected;f.companion.createEngine=async()=>({roster:()=>[],selectedPage:()=>actual,selectPage:async(page:any)=>{f.calls.push('select-restored');actual=page},stop:async()=>{}})
  Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key]]))});await f.companion._receiveTransfer(f.record,f.entry,status)
  assert.equal(f.calls.includes('page'),false);assert.equal(options.selectedPage(),selected);assert.equal(f.record.admission,'active');assert.ok(f.calls.includes('select-restored'));await f.companion._dispose(f.record);assert.throws(()=>proof.assertCurrent(),/review_required/)
})
test('a reviewed source pin permits blocked readiness but confirmed history alone cannot activate the agent',async t=>{const f=await fixture(t),source=codec.createEndpointIdentity(randomUUID());f.companion.records.set(f.scope.endpointId,f.record);const document={version:1,kind:'agent-peer-pin-review',profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,agentEndpointId:f.scope.endpointId,agentKeyFingerprint:f.scope.keyFingerprint,peerIdentity:source.identity,peerKeyFingerprint:codec.identityFingerprint(source.identity)};await new AgentProfilePeerPins({directory:path.join(f.companion.directory,'peer-pins',f.scope.endpointId)}).review({scope:f.scope,endpoint:f.endpoint,document,confirmation:document.peerKeyFingerprint,assertCurrent:()=>true});Object.assign(f.entry.profile,{writerState:'active',endpointId:source.identity.endpointId,bootId:'source-boot',runtimeId:'source-runtime',sessionId:'source-session',writerEpoch:3});f.client.pendingRuntimeRequests=async()=>[{state:'pending',request:{...f.request,purpose:'receive-transfer',expectedWriterEpoch:3}}];await f.companion._step(f.record);assert.deepEqual(f.calls,['runtime-blocked','ready']);assert.equal(f.record.runtime.authority.revision,1);f.client.runtimeRequest=async()=>({state:'confirmed',confirmation:{destination:Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint'].map(key=>[key,f.record.runtime.authority[key]]))}});await f.companion._step(f.record);assert.equal(f.record.runtime.state,'new');assert.equal(f.calls.includes('activate'),false);assert.equal(f.record.runtime.network,'blocked')})

test('direct receive stages original signed bytes, journals before acknowledgement and waits for a separate current CAS',async t=>{
  const f=await fixture(t),source=codec.createEndpointIdentity(randomUUID());f.companion.records.set(f.scope.endpointId,f.record)
  const sourceIdentity={endpointId:source.identity.endpointId,bootId:'human-boot',runtimeId:'human-runtime',sessionId:'human-session',writerEpoch:3},target={endpointId:f.scope.endpointId,bootId:f.connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:1,keyFingerprint:f.scope.keyFingerprint},authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,...target,writerEpoch:4,revision:1,contentKeyEpoch:1},transition={id:randomUUID(),profileId:f.scope.profileId,kind:'transfer',phase:'checkpoint_committed',source:sourceIdentity,destination:target,sourceRevision:0,sourceManifestHash:null,contentKeyEpoch:1,manifestHash:''},context={version:1,schemaVersion:1,profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,transitionId:transition.id,revision:1,previousManifestHash:null,keyEpoch:1,source:sourceIdentity,destination:target}
  const portable=require('../lib/browser-profile-core/portable-state.js'),epoch=codec.createContentKeyEpoch(1),plaintext=portable.encodePortableState({schema:portable.SCHEMA,cookies:[],origins:[],passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'google'}})
  let checkpoint;try{checkpoint=codec.sealCheckpoint({plaintext,context,source,destinationIdentity:f.endpoint.identity,contentKeyEpoch:epoch})}finally{plaintext.fill(0);epoch.key.fill(0)}transition.manifestHash=codec.manifestHash(checkpoint.manifest)
  f.record.peerPins=[source.identity];f.record.sourcePin=source.identity;f.record.expectedSource=sourceIdentity;f.record.request={...f.request,purpose:'receive-transfer'};await f.companion._prepare(f.record,authority)
  Object.assign(f.entry.profile,{writerState:'stopped',...sourceIdentity,revision:1,headManifestHash:transition.manifestHash});(f.entry as Row).pendingDestinations=[{transitionId:transition.id,phase:'checkpoint_committed',destination:target}]
  const read={profile:{...f.entry.profile},transition,admission:{source:{admitted:true,keyFingerprint:codec.identityFingerprint(source.identity)},destination:{admitted:true,backgroundUse:true,grantVersion:1,keyFingerprint:f.scope.keyFingerprint}}}
  f.client.transition=async()=>read;f.client.capsule=async()=>{f.calls.push('download-original');return checkpoint};f.client.staged=async()=>{f.calls.push('http-staged');return{...read.profile,writerState:'staged'}}
  f.record.runtime.stage=async(input:Row)=>{assert.deepEqual(input.checkpoint,checkpoint);assert.deepEqual(input.sourceIdentity,source.identity);f.calls.push('stage-inactive');f.record.runtime.state='staged';const receipt={version:1,kind:'destination-staged',profileId:f.scope.profileId,transitionId:transition.id,manifestHash:transition.manifestHash,revision:1,destination:target,stagedInactive:true};return{receipt,signature:sign(null,require('../lib/browser-profile-core/coordinator-client.js').canonical(receipt),f.endpoint.signingPrivateKey).toString('base64url')}}
  let saved:Row|null=null;f.record.journal={write:async(row:Row)=>{f.calls.push('journal-write');saved=row;return{durability:{fileSynced:true,directorySynced:true}}},read:async()=>{f.calls.push('journal-readback');return saved}}
  const status={confirmation:{destination:target}};read.admission.source.keyFingerprint='a'.repeat(64);await assert.rejects(f.companion._receiveTransfer(f.record,f.entry,status),{code:'profile_companion_transfer_changed'});assert.equal(f.calls.includes('download-original'),false);read.admission.source.keyFingerprint=codec.identityFingerprint(source.identity)
  await f.companion._receiveTransfer(f.record,f.entry,status);assert.deepEqual(f.calls,['runtime-blocked','download-original','stage-inactive','journal-write','journal-readback','http-staged']);assert.equal(f.record.runtime.network,'blocked');await f.companion._receiveTransfer(f.record,f.entry,status);assert.equal(f.calls.includes('activate'),false)
  Object.assign(f.entry.profile,{writerState:'active',...Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].map(key=>[key,authority[key as keyof typeof authority]]))});await f.companion._receiveTransfer(f.record,f.entry,status);assert.deepEqual(f.calls.slice(-3),['activate','page','prove']);assert.equal(f.record.runtime.network,'active')
})
