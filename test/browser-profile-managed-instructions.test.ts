import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {createManagedProfileRelay,hostInstructions,managedHostInstructions,SESSION_TOOLS} from '../bin/hoai-browser-host.mjs'
import {AgentBrowserProfileCompanion} from '../lib/browser-profile-companion.mjs'
const require=createRequire(import.meta.url),codec=require('../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
const initialize={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'managed-guidance-fixture',version:'1'}}

test('actual managed relay MCP initialize reports managed lifecycle and original permission boundaries',async t=>{
 const relay=createManagedProfileRelay({core:{roster:()=>[],callTool:async()=>({content:[]})},deviceLabel:'fixture-machine'});t.after(()=>relay.close())
 const reply:any=await relay.relay({clientId:'fixture',assistantId:42,principal:'user-recipient',message:{jsonrpc:'2.0',id:1,method:'initialize',params:initialize}})
 assert.equal(reply.ok,true);assert.equal(reply.message.result.instructions,managedHostInstructions('fixture-machine'))
 const text=reply.message.result.instructions;assert.match(text,/^HOAI managed browser profile on fixture-machine/);assert.match(text,/approved agent-machine runtime/);assert.match(text,/exact session confirmation/);assert.match(text,/at most 60 seconds/);assert.match(text,/encrypted stopped checkpoint/);assert.match(text,/opaque file\/artifact tokens/)
 assert.doesNotMatch(text,/Browsing starts without saved logins|30 idle minutes|gate_parked|passphrase|owner is asked as a CARD/);assert.doesNotMatch(text,/[\u2013\u2014]/)
})

test('legacy initialize guidance remains separate with its original ephemeral and parked-gate contract',()=>{
 const text=hostInstructions('fixture-machine');assert.match(text,/your own browser host on fixture-machine/);assert.match(text,/Browsing starts without saved logins/);assert.match(text,/30 idle minutes/);assert.match(text,/gate_parked/);assert.notEqual(text,managedHostInstructions('fixture-machine'))
})

async function managedFixture(t:{after:(callback:()=>unknown)=>void}){
 const endpoint=codec.createEndpointIdentity(randomUUID()),scope={profileId:randomUUID(),actingUserId:'recipient',assistantId:42,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:7,ownerUserId:'sharer'},connection:Row={bootId:randomUUID(),_stopped:false,pairing:{token:'synthetic-pairing',backendUrl:'https://hoai.test',pairingId:7,ownerUserId:'sharer',assistantIds:[42]},socketId:'fixture-socket',socket:{connected:true}}
 const authority={...Object.fromEntries(['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].map(key=>[key,scope[key as keyof typeof scope]])),bootId:connection.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1},entry={profile:{...authority,id:scope.profileId,writerState:'active',headManifestHash:null},grant:{generation:1,backgroundUse:true}}
 const original=structuredClone([...SESSION_TOOLS,{name:'browser_click',description:'Original click',inputSchema:{type:'object',properties:{wait_seconds:{type:'integer',minimum:1,maximum:1800,description:'Original legacy chat wait'}}}},{name:'browser_type',description:'Original type',inputSchema:{type:'object',properties:{}}},{name:'browser_fill_form',description:'Original form',inputSchema:{type:'object',properties:{}}},{name:'browser_close',description:'Original close',inputSchema:{type:'object',properties:{}}}]),before=structuredClone(original)
 const runtime:Row={authority,context:{pages:()=>[]},state:'active',network:'active',assertCurrent(){assert.equal(this.state,'active');return authority},activate:async()=>{},newPage:async()=>{},dispose:async()=>{runtime.state='disposed';runtime.network='blocked'}}
 const companion:any=new AgentBrowserProfileCompanion({connection,agentRoot:path.join(os.tmpdir(),'hoai-guidance-'+randomUUID()),deviceLabel:'fixture-machine',client:{discover:async()=>({profiles:[entry]})},keyStore:{},stateStore:{},loadBrowser:async()=>({}),createEngine:async()=>({roster:()=>original,stop:async()=>{}}),createRelay:(core:Row)=>createManagedProfileRelay({core,deviceLabel:'fixture-machine'}),createBackups:()=>null}as any)
 const record:Row={scope,identity:endpoint.identity,endpoint,runtime,entry,admission:'blocked',revoked:false,uncertain:false,engineTasks:new Set(),state:'saved'};companion.records.set(scope.endpointId,record);companion._prove=async()=>{record.rpc.binding={bindingId:randomUUID(),socketId:connection.socketId,authority}};await companion._activate(record,authority)
 let frame:Row,payload:Row;companion.rpcClient.dispatch=async()=>({frame:structuredClone(frame)});companion.rpcClient.result=async(_a:unknown,_e:unknown,input:Row)=>{payload=input.payload;return{accepted:true}}
 const request=async(method:string,params:Row={})=>{frame={event_type:'browser_profile_rpc',version:1,rpcId:randomUUID(),rpcNonce:'a'.repeat(43),bindingId:record.rpc.binding.bindingId,authority,clientId:'guidance-agent',assistantId:42,message:{jsonrpc:'2.0',...(method==='notifications/initialized'?{}:{id:randomUUID()}),method,params},deadlineAt:new Date(Date.now()+120000).toISOString()};assert.equal((await companion.receive(frame,connection.socketId)).completionAccepted,true);assert.equal(payload.ok,true);return payload.message?.result}
 t.after(async()=>{record.relay.close();record.rpc.disconnect();await companion._dispose(record)})
 return{request,original,before}
}

test('actual managed Companion tools/list removes unsupported wait and truthfully clones session and deadline descriptions',async t=>{
 const f=await managedFixture(t);const init=await f.request('initialize',initialize);assert.match(init.instructions,/^HOAI managed browser profile/);await f.request('notifications/initialized');const result=await f.request('tools/list'),tools:Row[]=result.tools
 assert.equal(tools.some(tool=>tool.name==='hoai_browser_wait_gate'),false)
 for(const name of ['hoai_browser_open_session','hoai_browser_status'])assert.match(tools.find(tool=>tool.name===name)!.description,/authorized.*runtime|JSON state/)
 assert.match(tools.find(tool=>tool.name==='hoai_browser_close_session')!.description,/encrypted stopped checkpoint/);assert.match(tools.find(tool=>tool.name==='hoai_browser_close_session')!.description,/does not prove server commit/);assert.match(tools.find(tool=>tool.name==='browser_close')!.description,/encrypted stopped checkpoint/)
 const open=tools.find(tool=>tool.name==='hoai_browser_open_session')!;assert.doesNotMatch(JSON.stringify(open),/passphrase|remains locked|owner enabled/);assert.match(open.inputSchema.properties.profile.description,/Compatibility/);assert.match(open.inputSchema.properties.caps.description,/Compatibility/)
 const wait=tools.find(tool=>tool.name==='browser_click')!.inputSchema.properties.wait_seconds;assert.equal(wait.minimum,1);assert.equal(wait.maximum,1800);assert.match(wait.description,/at most 60 seconds/);assert.doesNotMatch(wait.description,/owner may be away|gate_parked/)
 assert.match(tools.find(tool=>tool.name==='browser_type')!.description,/submit and slowly are unsupported/);assert.match(tools.find(tool=>tool.name==='browser_fill_form')!.description,/all fields must qualify/)
 assert.deepEqual(f.original,f.before,'managed metadata must not mutate cached legacy schemas');assert.ok(SESSION_TOOLS.some(tool=>tool.name==='hoai_browser_wait_gate'));assert.match(SESSION_TOOLS[0].description,/without saved login state/)
})
