import{test}from'node:test'
import assert from'node:assert/strict'
import{EventEmitter}from'node:events'
import{randomUUID}from'node:crypto'
import{createRequire}from'node:module'
import{openAgentLiveReadScope}from'../../lib/browser-profile-live-read.mjs'
const require=createRequire(import.meta.url),codec=require('../../lib/browser-profile-core/crypto.js')
type Row=Record<string,any>
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
class Page extends EventEmitter{address='https://site.test/page#fragment';closed=false;frame:Row={url:()=>this.address,isDetached:()=>false};url(){return this.address}mainFrame(){return this.frame}isClosed(){return this.closed}}
export function liveReadFixture(t:{after:(callback:()=>unknown)=>void}){
 const endpoint=codec.createEndpointIdentity(randomUUID()),authority={profileId:randomUUID(),actingUserId:'recipient',assistantId:7,endpointId:endpoint.identity.endpointId,bootId:'fixture-boot',runtimeId:'fixture-runtime',sessionId:'fixture-session',writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1,keyFingerprint:codec.identityFingerprint(endpoint.identity)},page=new Page(),pages=[page],calls:Row[]=[],hooks:Row={},state={current:true,blocked:false,version:'one'},context:Row=new EventEmitter(),caps:any[]=[]
 const session={async send(method:string,params:Row={}){calls.push({method,params});if(hooks.send){const value=await hooks.send(method,params);if(value!==undefined)return value}if(method==='Target.getTargetInfo')return{targetInfo:{targetId:'target-a',type:'page',browserContextId:'context-a'}};if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame-a',loaderId:'loader-a',url:'https://site.test/page',urlFragment:'#fragment'}}};if(method==='Storage.getStorageKeyForFrame')return{storageKey:'https://site.test/'};if(method==='IndexedDB.requestDatabaseNames')return{databaseNames:[]};if(method==='Network.getAllCookies')return{cookies:[]};if(method==='Page.createIsolatedWorld')return{executionContextId:9};if(method==='Runtime.evaluate'&&params.awaitPromise!==true)return{result:{value:{ready:true,credentials:false,unsaved:false}}};if(method==='Runtime.evaluate'){assert.equal(params.awaitPromise,true);assert.equal(params.returnByValue,true);assert.match(params.expression,/transaction\(info.name, "readonly"\)/);return{result:{value:JSON.stringify({schema:'hoai-origin-storage-v1',origin:'https://site.test',localStorage:[],indexedDB:[]})}}}throw Error('unexpected fixture method')},async detach(){calls.push({method:'detach'});if(hooks.detach)await hooks.detach()}}
 context.pages=()=>pages;context.newCDPSession=async(target:unknown)=>{assert.strictEqual(target,page);calls.push({method:'new-session'});if(hooks.session)await hooks.session();return session}
 const runtime:Row={authority,context,browser:{},root:{},contextId:'context-a',ledger:{generation:0,assertIdle(){if(hooks.idle)hooks.idle()}},privatePages:new Set(),pages:new Set(pages),operation:null,state:'active',network:'active',assertCurrent(){if(!state.current)throw Error('revoked');return authority},async assertMovable(){if(hooks.movable)await hooks.movable();return{origins:['https://site.test']}},async assertTransferAllowed(){calls.push({method:'safety'});if(hooks.safety)await hooks.safety()},_assertTransportQualified(){calls.push({method:'qualified'});if(hooks.qualified)return hooks.qualified()}}
 const input=()=>({runtime,authority,assertCurrent:()=>{if(!state.current)throw Error('revoked')},protection:()=>({blocked:state.blocked,version:state.version}),timeoutMs:5000})
 const open=async()=>{const cap=await openAgentLiveReadScope(input());caps.push(cap);return cap}
 t.after(async()=>{for(const cap of caps){cap.release();await cap.whenDrained().catch(()=>{})}})
 return{endpoint,authority,page,pages,context,session,runtime,calls,hooks,state,input,open}
}
