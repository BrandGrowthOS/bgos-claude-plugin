import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {BrowserProfileRuntime,profileCrypto} from '../lib/browser-profile-runtime.mjs'
import {bindFakeProfileNativePipe} from './helpers/browser-profile-flat-native'

// Native protocol doubles exercise Runtime.create ordering. Actual Chrome155
// observer qualification is a separate sandboxed native process proof.
function fixture(options:any={}){
 const calls:string[]=[],ids:string[]=[],targets=new Map<string,any>(),root:any=new EventEmitter(),context:any=new EventEmitter();let connected=true,created=0
 root.send=async(method:string,params:any={})=>{
  if(method==='SystemInfo.getProcessInfo')return{processInfo:[{type:'browser',id:123}]}
  if(method==='Target.getBrowserContexts')return{browserContextIds:[...ids]}
  if(method==='Target.getTargets')return{targetInfos:[...targets.values()]}
  if(method==='Target.attachToTarget')return{sessionId:'legacy-'+params.targetId}
  if(method==='Target.sendMessageToTarget'){const command=JSON.parse(params.message);setImmediate(()=>root.emit('Target.receivedMessageFromTarget',{sessionId:params.sessionId,message:JSON.stringify({id:command.id,result:{}})}))}
  return{}
 }
 const pages:any[]=[];context.pages=()=>[...pages];context.route=async()=>calls.push('route');context.newPage=async()=>{calls.push('seed');created++;const page:any=new EventEmitter();page.url=()=> 'about:blank';page.close=async()=>{pages.splice(pages.indexOf(page),1);targets.delete('seed')};pages.push(page);context.emit('page',page);const info={targetId:'seed',browserContextId:options.wrongSeed?'wrong-context':'owned-context',type:'page',url:'about:blank'};targets.set('seed',info);root.emit('Target.targetCreated',{targetInfo:info});root.emit('Target.attachedToTarget',{sessionId:'flat-seed',targetInfo:info,waitingForDebugger:true});return page}
 context.newCDPSession=async()=>({send:async()=>({targetInfo:targets.get('seed')}),detach:async()=>{}})
 const browser:any=Object.assign(new EventEmitter(),{newBrowserCDPSession:async()=>root,version:async()=> '155.0.8059.39',newContext:async()=>{calls.push('owned-context');if(!options.missingContext)ids.push('owned-context');if(options.extraContext)ids.push('foreign-context');return context},close:async()=>{calls.push('browser-close');connected=false;browser.emit('disconnected')},isConnected:()=>connected});bindFakeProfileNativePipe(browser,root);if(options.foreignNativeConnection){root._connection={...root._connection};browser._connection=root._connection}
 const endpoint=profileCrypto.createEndpointIdentity('bootstrap-endpoint'),authority={profileId:'bootstrap-profile',actingUserId:'recipient',assistantId:7,endpointId:'bootstrap-endpoint',bootId:'boot',runtimeId:'runtime',sessionId:'session',writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1,keyFingerprint:profileCrypto.identityFingerprint(endpoint.identity)}
 const observer:any={kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',privateContextId:'private-context',assertQualified:()=>true,confirmStopped:async()=>true,bindContext:async({context:owned,contextId}:any)=>{calls.push('bind');assert.equal(owned,context);assert.equal(contextId,'owned-context');assert.equal(pages.length,0);if(options.bind)await options.bind();if(options.pageDuringBind)pages.push({})},dispose:async()=>{calls.push('observer-dispose');if(options.dispose)await options.dispose()}}
 const factory=async(input:any)=>{calls.push('factory');assert.equal(input.browser,browser);assert.equal(input.root,root);assert.deepEqual(input.authority,authority);assert.equal(input.browserVersion,'155.0.8059.39');assert.deepEqual(input.processIdentity,{pid:123,started:'1234'});assert.equal(ids.length,0);assert.equal(created,0);if(options.factory)await options.factory();ids.push(options.wrongPrivate?'wrong-private':'private-context');return observer}
 const extras=()=>({passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'google'}})
 const config:any={chromium:{launch:async()=>{calls.push('launch');return browser}},authority,transferQualificationFactory:factory,captureProcessIdentity:()=>({pid:123,started:'1234'}),assertProcessExited:async()=>{calls.push('exit-proof');return true},closeAndDrain:async()=>({admissionClosed:true,drained:true}),checkpoint:async()=>({durable:true}),authorizeActivation:async()=>({authority,assertCurrent(){}}),preflightExtras:extras,captureExtras:()=>({bundle:extras(),assertCurrent(){},release(){}}),commitExtras:()=>({committed:true}),timeoutMs:100}
 return{calls,config,observer,context,browser,root,pages,get created(){return created}}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
async function ready(check:()=>unknown){for(let index=0;index<100&&!check();index++)await turn();assert.ok(check(),'expected pending bootstrap boundary was not reached')}
test('runtime factory is awaited before owned context and bind is awaited before the first private seed',async()=>{
 let factoryDone:any,bindDone:any;const f=fixture({factory:()=>new Promise(resolve=>factoryDone=resolve),bind:()=>new Promise(resolve=>bindDone=resolve)}),work=BrowserProfileRuntime.create(f.config);void work.catch(()=>{})
 await ready(()=>factoryDone);assert.equal(f.calls.includes('owned-context'),false);factoryDone();await ready(()=>bindDone);assert.equal(f.created,0);bindDone();const runtime=await work as BrowserProfileRuntime&{contextId:string;transportObserver:unknown}
 assert.equal(runtime.contextId,'owned-context');assert.equal(runtime.transportObserver,f.observer);assert.ok(f.calls.indexOf('factory')<f.calls.indexOf('owned-context'));assert.ok(f.calls.indexOf('bind')<f.calls.indexOf('seed'));await runtime.dispose();assert.ok(f.calls.indexOf('browser-close')<f.calls.indexOf('observer-dispose'))
})
test('unknown or ambiguous native context delta and targets during bind refuse before seed and clean the new browser',async()=>{
 for(const option of [{extraContext:true},{wrongPrivate:true},{pageDuringBind:true},{missingContext:true}]){const f=fixture(option);await assert.rejects(BrowserProfileRuntime.create(f.config),{reason:'profile_context_unqualified'});assert.equal(f.created,0);assert.ok(f.calls.includes('observer-dispose'));assert.ok(f.calls.includes('browser-close'))}
})
test('seed context must equal the context proved before any owned seed creation',async()=>{
 const f=fixture({wrongSeed:true});await assert.rejects(BrowserProfileRuntime.create(f.config),{reason:'profile_context_unqualified'});assert.equal(f.created,1);assert.ok(f.calls.includes('observer-dispose'));assert.ok(f.calls.includes('browser-close'))
})
test('mixed proof factories fail before launch and disposal failure cannot skip physical close or DEK zeroing',async()=>{
 const f=fixture();await assert.rejects(BrowserProfileRuntime.create({...f.config,transferQualification:{kind:'restricted-disposable-fixture',origins:['http://127.0.0.1'],assertQualified:()=>true}}),{reason:'profile_transport_qualification_required'});assert.equal(f.calls.length,0)
 const g=fixture({dispose:async()=>{throw Error('observer_cleanup_failed')}}),runtime=await BrowserProfileRuntime.create(g.config),key=Buffer.alloc(32,17);runtime.contentKeyEpoch={epoch:1,key};await assert.rejects(runtime.dispose(),/observer_cleanup_failed/);assert.equal(g.browser.isConnected(),false);assert.ok(g.calls.includes('exit-proof'));assert.ok(key.every(value=>value===0))
})


test('a noncanonical native package binding refuses without fallback and positively closes the newly owned browser',async()=>{
 const f=fixture({foreignNativeConnection:true});await assert.rejects(BrowserProfileRuntime.create(f.config),{code:'profile_target_native_binding_invalid'});assert.equal(f.created,0);assert.equal(f.calls.includes('owned-context'),false);assert.ok(f.calls.includes('browser-close'));assert.equal(f.browser.isConnected(),false)
})
