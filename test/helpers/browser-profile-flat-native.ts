import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
export function bindFakeProfileNativePipe(browser:any=new EventEmitter(),root:any=new EventEmitter(),connection:any=require('playwright-core').chromium._connection){
 const calls:any[]=[],wire:any={_sessions:new Map(),_closed:false,_transport:{send(){}},_rawSend(){},handler:null},client:any=connection,dispatcher:any=client.toImpl(client);let commandId=0
 class NativeSession {
  _closed=false;_callbacks=new Map<number,any>();_connection=wire;_sessionId:string;_parentSession:any;_eventListener:any
  constructor(parent:any,id:string,event:any=null){this._parentSession=parent;this._sessionId=id;this._eventListener=event}
  createChildSession(id:string,event:any){const child=new NativeSession(this,id,event);wire._sessions.set(id,child);return child}
  send(method:string,params:any={}){const id=++commandId;calls.push({sessionId:this._sessionId,method,params});const answer=new Promise((resolve,reject)=>this._callbacks.set(id,{resolve,reject}));let work:any;try{work=wire.handler?.(this,method,params)}catch(error){work=Promise.reject(error)}void Promise.resolve(work).then(value=>{this._callbacks.get(id)?.resolve(value||{});this._callbacks.delete(id)},error=>{this._callbacks.get(id)?.reject(error);this._callbacks.delete(id)});return answer}
  dispose(){this._closed=true;this._connection._sessions.delete(this._sessionId);this._rejectPendingCallbacks()}
  _rejectPendingCallbacks(){for(const callback of this._callbacks.values())callback.reject(Error('synthetic session closed'));this._callbacks.clear()}
  event(method:string,params:any={}){this._eventListener?.(method,params)}
 }
 wire.rootSession=new NativeSession(null,'');wire._sessions.set('',wire.rootSession);const nativeRoot=wire.rootSession.createChildSession('browser-root',null),serverRoot={_session:nativeRoot},serverBrowser={_connection:wire}
 Object.assign(root,{_guid:'root-fixture-'+randomUUID(),_connection:client});Object.assign(browser,{_guid:'browser-fixture-'+randomUUID(),_connection:client});if(!browser.isConnected)browser.isConnected=()=>!wire._closed
 client._objects.set(root._guid,root);client._objects.set(browser._guid,browser);dispatcher._dispatcherByGuid.set(root._guid,{_object:serverRoot});dispatcher._dispatcherByGuid.set(browser._guid,{_object:serverBrowser})
 const cleanup=()=>{for(const [object,server] of [[root,serverRoot],[browser,serverBrowser]]){if(client._objects.get(object._guid)===object)client._objects.delete(object._guid);if(dispatcher._dispatcherByGuid.get(object._guid)?._object===server)dispatcher._dispatcherByGuid.delete(object._guid)}}
 browser.once('disconnected',()=>{wire._closed=true;cleanup()})
 return{cleanup,browser,root,nativeRoot,wire,client,dispatcher,serverRoot,serverBrowser,calls,disconnect(){browser.emit('disconnected')},attach(sessionId='child-a',targetId='target-a',parent:string|null=null,waitingForDebugger=true){const event={sessionId,targetInfo:{targetId,type:'page',url:'about:blank',browserContextId:'context-a',canAccessOpener:false},waitingForDebugger};if(parent)wire._sessions.get(parent).event('Target.attachedToTarget',event);else root.emit('Target.attachedToTarget',event);return event},detach(sessionId:string){root.emit('Target.detachedFromTarget',{sessionId})}}
}
