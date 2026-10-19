import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {AgentBrowserProfileCompanion} from '../lib/browser-profile-companion.mjs'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
async function fixture(t:{after:(callback:()=>unknown)=>void}){
 const endpoint=codec.createEndpointIdentity(randomUUID()),scope={profileId:randomUUID(),actingUserId:'recipient',assistantId:42,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:7,ownerUserId:'sharer'},connection:Row={bootId:randomUUID(),_stopped:false,pairing:{token:'synthetic-pairing',backendUrl:'https://hoai.test',pairingId:7,ownerUserId:'sharer',assistantIds:[42]},socket:{connected:true}},authority={...Object.fromEntries(['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].map(key=>[key,scope[key as keyof typeof scope]])),bootId:connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1},entry={profile:{...authority,id:scope.profileId,writerState:'active',headManifestHash:null},grant:{generation:1,backgroundUse:true}},context={},state:Row={options:null,field:{pendingPhysicalOperations:0,cleanupUnknown:false,outcomeUnknown:false},file:{pendingPhysicalOperations:0,cleanupUnknown:false}}
 const runner=(kind:string)=>({activity:()=>state[kind],whenDrained:async()=>{},dispose:async()=>{}}),runtime:Row={authority,context,state:'active',network:'active',assertCurrent(){assert.equal(this.state,'active');return this.authority},dispose:async()=>{runtime.state='disposed';runtime.network='blocked'}}
 const companion:any=new AgentBrowserProfileCompanion({connection,agentRoot:path.join(os.tmpdir(),'hoai-transfer-'+randomUUID()),deviceLabel:'Synthetic transfer safety',client:{discover:async()=>({profiles:[entry]})},keyStore:{},stateStore:{},loadBrowser:async()=>({}),preloadExtras:async()=>({dispose(){}}),createRuntime:async(input:Row)=>{state.options=input;return runtime},createEngine:async()=>({}),createRelay:()=>({}),createDownloads:async()=>null,createBackups:()=>null,createFields:()=>runner('field')as any,createFiles:()=>runner('file')as any}as any)
 const record:Row={scope,identity:structuredClone(endpoint.identity),endpoint,runtime:null,entry,admission:'blocked',revoked:false,uncertain:false,engineTasks:new Set(),state:'saved'};companion.records.set(scope.endpointId,record);await companion._prepare(record,authority);record.admission='active'
 t.after(async()=>{record.engineTasks.clear();await companion._dispose(record).catch(()=>{})})
 const check=(input:Row={authority,context})=>state.options.assertTransferAllowed(input)
 return{companion,record,runtime,scope,authority,endpoint,connection,entry,context,state,check}
}

test('the actual Companion factory supplies a synchronous transfer safety callback for the original active source',async t=>{
 const f=await fixture(t);assert.equal(typeof f.state.options.assertTransferAllowed,'function');assert.notStrictEqual(f.record.identity,f.endpoint.identity);assert.deepEqual(f.record.identity,f.endpoint.identity);assert.strictEqual(f.runtime.context,f.context);assert.equal(f.check(),true);f.record.admission='stopping';assert.equal(f.check(),true)
})

test('the retained factory callback refuses changed input context or any full authority component',async t=>{
 const f=await fixture(t);assert.throws(()=>f.check({authority:f.authority,context:{}}),/transfer_changed/)
 const authority:Row=f.authority;for(const key of Object.keys(authority)){const changed={...authority,[key]:typeof authority[key]==='number'?authority[key]+1:'changed'};assert.throws(()=>f.check({authority:changed,context:f.context}),()=>true,key)}
})

test('the original runtime, native context, enrolled identity, endpoint and recipient scope cannot be replaced',async t=>{
 for(const fault of ['runtime','context','endpoint','identity','pairing','owner','recipient','epoch','revoked','disposed']){
  const f=await fixture(t)
  if(fault==='runtime')f.record.runtime={...f.runtime};else if(fault==='context')f.runtime.context={};else if(fault==='endpoint')f.record.endpoint={...f.endpoint};else if(fault==='identity')f.record.identity={...f.endpoint.identity};else if(fault==='pairing')f.record.scope={...f.scope,pairingId:8};else if(fault==='owner')f.record.scope={...f.scope,ownerUserId:'recipient'};else if(fault==='recipient')f.record.scope={...f.scope,actingUserId:'sharer'};else if(fault==='epoch')f.runtime.authority={...f.authority,writerEpoch:2};else if(fault==='revoked')f.record.revoked=true;else{await f.companion._dispose(f.record);f.record.runtime=f.runtime;f.runtime.state='active';f.runtime.network='active'}
  assert.throws(f.check,()=>true,fault)
 }
})

test('cached current writer and grant must still match before any read or finalization',async t=>{
 for(const fault of ['writer','source','generation','background']){const f=await fixture(t);if(fault==='writer')f.entry.profile.writerState='quiescing';else if(fault==='source')f.entry.profile.sessionId=randomUUID();else if(fault==='generation')f.entry.grant.generation=2;else f.entry.grant.backgroundUse=false;assert.throws(f.check,/transfer_changed/,fault)}
})

test('physical commands, live permissions, uncertain admission and unknown file or field activity refuse transfer',async t=>{
 const f=await fixture(t);f.companion._fileRunner(f.record);f.companion._fieldRunner(f.record)
 for(const kind of ['file','field'])for(const value of [undefined,{},Promise.resolve({}),{pendingPhysicalOperations:1,cleanupUnknown:false},{pendingPhysicalOperations:0,cleanupUnknown:true},{pendingPhysicalOperations:0,cleanupUnknown:false,outcomeUnknown:true}]){const original=f.state[kind];f.state[kind]=value;assert.throws(f.check,/transfer_busy/,kind);f.state[kind]=original}
 const pending=Promise.resolve();f.record.engineTasks.add(pending);assert.throws(f.check,/transfer_busy/);f.record.engineTasks.delete(pending)
 f.record.permissionAbort=new AbortController();assert.throws(f.check,/transfer_busy/);f.record.permissionAbort=null
 for(const admission of ['unknown','blocked','revoked']){f.record.admission=admission;assert.throws(f.check,/transfer_busy/)}f.record.admission='active';f.record.uncertain=true;assert.throws(f.check,/transfer_busy/);f.record.uncertain=false;assert.equal(f.check(),true)
})

test('closing needs the existing exact private retirement permit and cannot borrow it for a replacement',async t=>{
 const f=await fixture(t);f.companion.closing=true;assert.throws(f.check,/transfer_changed/)
 let checked=0;f.runtime.finalize=async()=>{f.record.admission='stopping';assert.equal(f.check(),true);checked++;const original=f.record.endpoint;f.record.endpoint={...original};assert.throws(f.check,/transfer_changed/);f.record.endpoint=original;throw Object.assign(Error('synthetic pre-stop refusal'),{code:'profile_unsaved_form_state'})}
 await assert.rejects(f.companion.retire(f.record,true),{code:'profile_unsaved_form_state'});assert.equal(checked,1);assert.equal(f.runtime.state,'active');assert.throws(f.check,/transfer_changed/)
})

test('account lifetime and independent disposal revoke the callback even if a caller restores public runtime flags',async t=>{
 const f=await fixture(t);f.connection.pairing.token='replaced';assert.throws(f.check,/context_changed/);f.connection.pairing.token='synthetic-pairing';assert.equal(f.check(),true)
 await f.companion._dispose(f.record);f.record.runtime=f.runtime;f.runtime.state='active';f.runtime.network='active';f.record.admission='active';assert.throws(f.check,/context_changed/)
})
