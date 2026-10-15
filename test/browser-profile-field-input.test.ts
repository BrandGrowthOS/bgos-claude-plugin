import {test} from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {EventEmitter} from 'node:events'
import {AgentProfileFieldInput,applyPlaintextTicket,preparePlaintextTicket} from '../lib/browser-profile-field-input.mjs'
type Row=Record<string,any>
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
class Page extends EventEmitter{address='https://site.test/task';closed=false;_connection:Row={};url(){return this.address}isClosed(){return this.closed}}
function fixture(t:{after:(callback:()=>unknown)=>void}){
  const calls:Row[]=[],hooks:Row={},state={current:true,now:1000},page=new Page(),nativeFrame:Row={},nativePage={mainFrame:()=>nativeFrame},runtime={},handles:Row[]=[],nativeHandles=new Map(),signal=new AbortController()
  const ticket:Row={async evaluate(callback:any,values:any){if(callback===applyPlaintextTicket){calls.push({kind:'apply',values:[...values]});if(hooks.apply)return hooks.apply(values);return{state:'applied',fields:values.length}}calls.push({kind:'inspect'});if(hooks.inspect)return hooks.inspect();return false},dispose(){calls.push({kind:'ticket-dispose'});if(hooks.ticketDispose)return hooks.ticketDispose()}}
  const utility:Row={world:'utility',async evaluateHandle(callback:any,args:any){assert.equal(callback,preparePlaintextTicket);calls.push({kind:'capture',args});if(hooks.capture)return hooks.capture(args);return ticket}}
  nativeFrame.utilityContext=async()=>{if(hooks.utility)return hooks.utility();return utility}
  page._connection.toImpl=(value:any)=>value===page?nativePage:nativeHandles.get(value)
  const tab:Row={page,async targetLocator(input:any){calls.push({kind:'resolve',input});if(hooks.resolve)await hooks.resolve(input);return{locator:{async elementHandle(options:any){calls.push({kind:'handle',options});const handle:Row={_connection:page._connection,dispose(){calls.push({kind:'handle-dispose',handle});if(hooks.handleDispose)return hooks.handleDispose(handle)}};handles.push(handle);nativeHandles.set(handle,{_page:nativePage,_frame:nativeFrame});if(hooks.handle)return hooks.handle(handle);return handle}}}}}
  const context:Row={currentTab:()=>tab},backend={_context:context},engine:Row={_backend:backend,selectedPage:()=>page},check=()=>{if(!state.current)throw Error('private_context_changed')}
  const fields=new AgentProfileFieldInput({engine,runtime,assertCurrent:check,now:()=>state.now})
  const args={target:'e12',element:'Title field',text:'SYNTHETIC_KNOWN_TEXT'},input=(extra:Row={})=>({name:'browser_type',args,signal:signal.signal,deadlineAt:new Date(state.now+60000).toISOString(),...extra})
  t.after(async()=>{await fields.dispose().catch(()=>{})})
  return{fields,calls,hooks,state,page,nativeFrame,nativePage,utility,ticket,handles,nativeHandles,context,backend,engine,runtime,signal,args,input}
}

test('exact original MCP field handles stay private through one-use native execution without another lookup',async t=>{
 const f=fixture(t),cap=await f.fields.prepare(f.input());assert.deepEqual(Object.keys(cap),[]);assert.equal(f.calls.filter(row=>row.kind==='resolve').length,1);assert.equal(f.fields.activity().pendingPhysicalOperations,1)
 const result=await f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal});assert.equal('isError'in result,false);assert.equal(JSON.stringify(result).includes(f.args.text),false);assert.equal(f.calls.filter(row=>row.kind==='resolve').length,1);assert.equal(f.calls.filter(row=>row.kind==='apply').length,1);assert.equal(f.calls.filter(row=>row.kind==='ticket-dispose').length,1);assert.equal(f.calls.filter(row=>row.kind==='handle-dispose').length,1);assert.equal(f.page.listenerCount('framenavigated'),0);await f.fields.whenDrained()
 await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}),/context_changed/)
})
test('global admission remains bounded across eight original controllers until prepared operations physically clean',async t=>{
 const rows=Array.from({length:9},()=>fixture(t)),caps=[]
 for(let index=0;index<8;index++)caps.push(await rows[index].fields.prepare(rows[index].input()))
 await assert.rejects(rows[8].fields.prepare(rows[8].input()),/unavailable/);assert.equal(rows[8].calls.length,0)
 await rows[0].fields.cancel(caps[0]);const fresh=await rows[8].fields.prepare(rows[8].input());await rows[8].fields.cancel(fresh)
 for(let index=1;index<8;index++)await rows[index].fields.cancel(caps[index])
})
test('unsupported mode flags, keys, fields and malformed arguments refuse before native work',async t=>{
 const f=fixture(t)
 for(const extra of [{args:{...f.args,slowly:true}},{args:{...f.args,submit:true}},{args:{...f.args,submit:'false'}},{args:{...f.args,target:'fxe2'}},{args:{...f.args,target:'#title'}},{args:{...f.args,text:'x'.repeat(16385)}},{args:{...f.args,_meta:{raw:true}}},{name:'browser_press_key',args:{key:'Enter'}},{name:'browser_fill_form',args:{fields:[{target:'e1',name:'Title',type:'checkbox',value:'true'}]}}])await assert.rejects(f.fields.prepare(f.input(extra)))
 assert.equal(f.calls.length,0)
})
test('argument accessors and array accessors are never invoked',async t=>{
 const f=fixture(t);let invoked=0;const args=Object.defineProperty({...f.args},'text',{enumerable:true,get(){invoked++;return'private'}})
 await assert.rejects(f.fields.prepare(f.input({args})))
 const array:any[]=[];Object.defineProperty(array,'0',{enumerable:true,get(){invoked++;return{}}});array.length=1
 await assert.rejects(f.fields.prepare(f.input({name:'browser_fill_form',args:{fields:array}})));assert.equal(invoked,0)
})
test('bounded textbox batches bind original field arguments and cannot partially pass duplicate targets',async t=>{
 const f=fixture(t),args={fields:[{target:'e1',name:'Title',type:'textbox',value:'A'},{target:'e2',name:'Notes',type:'textbox',value:'B'}]},cap=await f.fields.prepare(f.input({name:'browser_fill_form',args}))
 await f.fields.execute({capability:cap,name:'browser_fill_form',args,signal:f.signal.signal});assert.deepEqual(f.calls.find(row=>row.kind==='apply')!.values,['A','B'])
 const duplicate={fields:[args.fields[0],args.fields[0]]};await assert.rejects(f.fields.prepare(f.input({name:'browser_fill_form',args:duplicate})));assert.equal(f.calls.filter(row=>row.kind==='capture').length,1)
})
test('another helper, forged capability, changed arguments and replacement signal have no execution authority',async t=>{
 const f=fixture(t),g=fixture(t),cap=await f.fields.prepare(f.input())
 await assert.rejects(g.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}),/context_changed/)
 await assert.rejects(f.fields.execute({capability:{},name:'browser_type',args:f.args,signal:f.signal.signal}),/context_changed/)
 await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:new AbortController().signal}),/context_changed/)
 await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:{...f.args,text:'SUBSTITUTED'},signal:f.signal.signal}),/context_changed/);assert.equal(f.calls.some(row=>row.kind==='apply'),false);await f.fields.whenDrained()
})
test('page, URL, navigation history, backend, tab, cancellation and authority changes refuse before dispatch',async t=>{
 for(const fault of ['url','selection','navigation','closed','crash','backend','tab','signal','authority','clock','deadline']){
  const f=fixture(t),cap=await f.fields.prepare(f.input())
  if(fault==='url')f.page.address+='/changed';else if(fault==='selection')f.engine.selectedPage=()=>new Page();else if(fault==='navigation')f.page.emit('framenavigated',{});else if(fault==='closed')f.page.closed=true;else if(fault==='crash')f.page.emit('crash');else if(fault==='backend')f.engine._backend={...f.backend};else if(fault==='tab')f.context.currentTab=()=>({page:f.page});else if(fault==='signal')f.signal.abort();else if(fault==='authority')f.state.current=false;else if(fault==='clock')f.state.now--;else f.state.now+=60000
  await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}));assert.equal(f.calls.some(row=>row.kind==='apply'),false,fault);assert.equal(f.calls.filter(row=>row.kind==='ticket-dispose').length,1,fault)
 }
})
test('different native page, subframe, handle connection or world cannot borrow the inspected target',async t=>{
 for(const fault of ['page','frame','connection','world']){
  const f=fixture(t);if(fault==='world')f.utility.world='main';else f.hooks.handle=(handle:Row)=>{if(fault==='connection')handle._connection={...f.page._connection};else f.nativeHandles.set(handle,{_page:fault==='page'?{}:f.nativePage,_frame:fault==='frame'?{}:f.nativeFrame});return handle}
  await assert.rejects(f.fields.prepare(f.input()),/native_unqualified/);assert.equal(f.calls.some(row=>row.kind==='capture'),false,fault);assert.equal(f.calls.filter(row=>row.kind==='handle-dispose').length,1,fault)
 }
})
test('native refusal and capture readback failure dispose the already created ticket and every handle',async t=>{
 for(const failure of ['refused','inspect','context']){
  const f=fixture(t);f.hooks.inspect=()=>{if(failure==='inspect')throw Error('private_native_error');if(failure==='context')f.state.current=false;return failure==='refused'}
  await assert.rejects(f.fields.prepare(f.input()));assert.equal(f.calls.filter(row=>row.kind==='ticket-dispose').length,1,failure);assert.equal(f.calls.filter(row=>row.kind==='handle-dispose').length,1,failure);assert.equal(f.fields.activity().pendingPhysicalOperations,0,failure)
 }
})
test('field signature refusal consumes the token without claiming an unknown write or retrying it',async t=>{
 const f=fixture(t);f.hooks.apply=()=>({state:'refused'});const cap=await f.fields.prepare(f.input())
 await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}),/handover_required/);assert.equal(f.fields.activity().outcomeUnknown,false);await f.fields.whenDrained()
 await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}));assert.equal(f.calls.filter(row=>row.kind==='apply').length,1)
})
test('native exception, partial event outcome and invalid receipt latch unknown and refuse a fresh field action',async t=>{
 for(const fault of ['throw','partial','receipt']){
  const f=fixture(t);f.hooks.apply=()=>{if(fault==='throw')throw Error('PRIVATE_NATIVE_TEXT');return fault==='partial'?{state:'outcome-unknown'}:{state:'applied',fields:99}};const cap=await f.fields.prepare(f.input())
  await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}),/profile_field_outcome_unknown/);assert.equal(f.fields.activity().outcomeUnknown,true);assert.equal(f.fields.activity().pendingPhysicalOperations,0);await assert.rejects(f.fields.prepare(f.input()),/unavailable/);assert.equal(f.calls.filter(row=>row.kind==='apply').length,1)
 }
})
test('a context lost after native application is unknown and never returns a successful result',async t=>{
 const f=fixture(t);f.hooks.apply=(values:any[])=>{f.state.current=false;return{state:'applied',fields:values.length}};const cap=await f.fields.prepare(f.input());await assert.rejects(f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal}),/outcome_unknown/);assert.equal(f.fields.activity().outcomeUnknown,true)
})
test('disposal holds original preparation admission until a late handle settles and is cleaned',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<Row>();f.hooks.handle=(handle:Row)=>{entered.resolve();return release.promise.then(()=>handle)}
 const preparing=f.fields.prepare(f.input());void preparing.catch(()=>{});await entered.promise;let stopped=false;const stopping=f.fields.dispose().then(()=>{stopped=true})
 try{await tick();assert.equal(stopped,false);assert.ok(f.fields.activity().pendingPhysicalOperations>0);assert.equal(f.calls.some(row=>row.kind==='handle-dispose'),false)}finally{release.resolve({})}
 await assert.rejects(preparing);await stopping;assert.equal(f.calls.filter(row=>row.kind==='handle-dispose').length,1);assert.equal(f.fields.activity().pendingPhysicalOperations,0)
})
test('disposal cannot release an actual native execution before it settles or manufacture a clean action',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<Row>();f.hooks.apply=()=>{entered.resolve();return release.promise};const cap=await f.fields.prepare(f.input()),work=f.fields.execute({capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal});void work.catch(()=>{});await entered.promise;let stopped=false;const stopping=f.fields.dispose().then(()=>{stopped=true})
 try{await tick();assert.equal(stopped,false);assert.equal(f.calls.some(row=>row.kind==='ticket-dispose'),false);assert.ok(f.fields.activity().pendingPhysicalOperations>0)}finally{release.resolve({state:'applied',fields:1})}
 await assert.rejects(work,/outcome_unknown/);await stopping;assert.equal(f.fields.activity().pendingPhysicalOperations,0)
})
test('independent ticket and handle cleanup failure keeps a private physical reservation and denies later entry',async t=>{
 const f=fixture(t),cap=await f.fields.prepare(f.input());f.hooks.ticketDispose=()=>{throw Error('synthetic ticket cleanup refusal')};await assert.rejects(f.fields.cancel(cap),/cleanup_unconfirmed/);assert.equal(f.calls.filter(row=>row.kind==='handle-dispose').length,1);assert.equal(f.page.listenerCount('framenavigated'),0);assert.equal(f.fields.activity().cleanupUnknown,true);assert.ok(f.fields.activity().pendingPhysicalOperations>0);await assert.rejects(f.fields.whenDrained(),/cleanup_unconfirmed/);await assert.rejects(f.fields.prepare(f.input()),/unavailable/)
})


test('bounded prefixed main-frame snapshot refs still require the original mapped native main frame',async t=>{
 const f=fixture(t),args={...f.args,target:'f23e123'},cap=await f.fields.prepare(f.input({args}));await f.fields.execute({capability:cap,name:'browser_type',args,signal:f.signal.signal});assert.equal(f.calls.filter(row=>row.kind==='apply').length,1)
})

test('native synchronous batch validation refuses before any setter and consumes the original ticket',()=>{
 const document={},location={href:'https://site.test/task'},rows=[{node:{name:'title'},form:null,signature:'safe'},{node:{name:'notes'},form:null,signature:'changed'}],calls:string[]=[]
 const context=vm.createContext({document,location}),apply=vm.runInContext('('+applyPlaintextTicket.toString()+')',context),ticket={document,documentURL:location.href,rows,native:{now:()=>100,tag:()=> 'INPUT',inputSet(this:any){calls.push(this.name)},areaSet(){},dispatch(){},Event:class{}},classify:()=> 'safe',formOf:()=>null,started:0,expiresAt:1000,consumed:false}
 assert.equal(apply(ticket,['A','B']).state,'refused');assert.deepEqual(calls,[]);assert.equal(ticket.consumed,true);rows[1].signature='safe';assert.equal(apply(ticket,['A','B']).state,'refused');assert.deepEqual(calls,[])
})

test('native setter or dispatch interruption after possible mutation is unknown with no rollback or replay',()=>{
 for(const failure of ['setter','dispatch']){
  const document={},location={href:'https://site.test/task'},rows=[{node:{name:'title'},form:null,signature:'safe'},{node:{name:'notes'},form:null,signature:'safe'}],calls:string[]=[]
  const context=vm.createContext({document,location}),apply=vm.runInContext('('+applyPlaintextTicket.toString()+')',context),ticket={document,documentURL:location.href,rows,native:{now:()=>100,tag:()=> 'INPUT',inputSet(this:any){calls.push('set-'+this.name);if(failure==='setter'&&this.name==='notes')throw Error('synthetic partial setter')},areaSet(){},dispatch(){calls.push('dispatch');throw Error('synthetic native dispatch')},Event:class{}},classify:()=> 'safe',formOf:()=>null,started:0,expiresAt:1000,consumed:false}
  assert.equal(apply(ticket,['A','B']).state,'outcome-unknown');assert.deepEqual(calls,failure==='setter'?['set-title','set-notes']:['set-title','set-notes','dispatch']);assert.equal(apply(ticket,['A','B']).state,'refused');assert.equal(calls.filter(row=>row==='set-title').length,1)
 }
})


test('one native capability cannot be claimed by a second concurrent execution',async t=>{
 const f=fixture(t),entered=deferred<void>(),release=deferred<Row>();f.hooks.apply=()=>{entered.resolve();return release.promise};const cap=await f.fields.prepare(f.input()),input={capability:cap,name:'browser_type',args:f.args,signal:f.signal.signal},first=f.fields.execute(input);void first.catch(()=>{});await entered.promise
 const second=f.fields.execute(input);void second.catch(()=>{})
 try{await tick();assert.equal(f.calls.filter(row=>row.kind==='apply').length,1)}finally{release.resolve({state:'applied',fields:1})}
 await first;await assert.rejects(second,/context_changed/)
})
