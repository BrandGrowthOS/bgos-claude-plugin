import{test}from'node:test'
import assert from'node:assert/strict'
import{liveReadFixture as fixture}from'./helpers/browser-profile-live-fixture.js'
type Row=Record<string,any>
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}

test('synthetic CDP fixed native read capability preserves full fragment identity and readonly storage codec without stopping source',async t=>{
 const f=fixture(t),cap=await f.open();assert.deepEqual(cap.origins,['https://site.test']);assert.deepEqual(await cap.readCookies(),[]);const origin=JSON.parse(await cap.readOrigin('https://site.test'));assert.equal(origin.schema,'hoai-origin-storage-v1');await cap.verify();assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');assert.equal(f.runtime.operation,null);assert.equal(f.calls.some(row=>/setOffline|setCookies|Debugger.pause|Target.close/.test(row.method)),false);cap.release();await cap.whenDrained();assert.deepEqual(cap.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false});assert.equal(f.calls.filter(row=>row.method==='detach').length,1);assert.equal(f.page.listenerCount('framenavigated'),0)
})
test('four physical source scopes are bounded until independent native cleanup settles',async t=>{
 const rows=Array.from({length:5},()=>fixture(t)),caps=[];for(let i=0;i<4;i++)caps.push(await rows[i].open());await assert.rejects(rows[4].open(),/busy_or_invalid/);caps[0].release();await caps[0].whenDrained();const fresh=await rows[4].open();fresh.release();await fresh.whenDrained();for(let i=1;i<4;i++){caps[i].release();await caps[i].whenDrained()}
})
test('full runtime/page/frame/context/network/credential changes refuse before another native read',async t=>{
 for(const fault of ['authority','tuple','page','frame','url','generation','context','network','operation','protected','version']){const f=fixture(t),cap=await f.open(),before=f.calls.length;if(fault==='authority')f.state.current=false;else if(fault==='tuple')f.authority.writerEpoch++;else if(fault==='page')f.pages[0]=Object.assign(Object.create(Object.getPrototypeOf(f.page)),f.page);else if(fault==='frame')f.page.frame={...f.page.frame};else if(fault==='url')f.page.address+='changed';else if(fault==='generation')f.runtime.ledger.generation++;else if(fault==='context')f.runtime.context={...f.context};else if(fault==='network')f.runtime.network='private';else if(fault==='operation')f.runtime.operation={};else if(fault==='protected')f.state.blocked=true;else f.state.version='two';await assert.rejects(Promise.resolve().then(()=>cap.readCookies()));assert.equal(f.calls.length,before,fault);cap.release();await cap.whenDrained()}
})
test('native context, partition, loader and changed database metadata cannot retarget an origin',async t=>{
 for(const fault of ['target','partition','loader','schema']){const f=fixture(t),cap=await f.open();let inventory=0;f.hooks.send=(method:string)=>{if(method==='Target.getTargetInfo'&&fault==='target')return{targetInfo:{targetId:'wrong',type:'page',browserContextId:'context-a'}};if(method==='Storage.getStorageKeyForFrame'&&fault==='partition')return{storageKey:'foreign/'};if(method==='Page.getFrameTree'&&fault==='loader')return{frameTree:{frame:{id:'frame-a',loaderId:'wrong',url:'https://site.test/page',urlFragment:'#fragment'}}};if(method==='IndexedDB.requestDatabaseNames'&&fault==='schema'){inventory++;return{databaseNames:inventory===1?[]:['changed']}}};await assert.rejects(cap.readOrigin('https://site.test'));cap.release();await cap.whenDrained()}
})
test('a release during pending native read retains the exact physical source and prevents late data publication',async t=>{
 const f=fixture(t),cap=await f.open(),entered=deferred<void>(),release=deferred<Row>();f.hooks.send=async(method:string)=>{if(method==='Network.getAllCookies'){entered.resolve();return release.promise}};const reading=cap.readCookies(),refused=assert.rejects(reading);await entered.promise;cap.release();let drained=false;const drain=cap.whenDrained().then(()=>{drained=true});try{await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);assert.ok(cap.activity().pendingPhysicalOperations>0);assert.equal(f.calls.some(row=>row.method==='detach'),false);await assert.rejects(f.open(),/busy_or_invalid/)}finally{release.resolve({cookies:[]})}await refused;await drain;assert.equal(cap.activity().pendingPhysicalOperations,0)
})
test('partial native listener setup rolls back every attempted registration and unqualified safety has no read',async t=>{
 const f=fixture(t),original=f.page.on;f.page.on=function(event:string,listener:any){original.call(this,event,listener);if(event==='close')throw Error('synthetic listener failure');return this};await assert.rejects(f.open());assert.equal(f.page.listenerCount('framenavigated'),0);assert.equal(f.page.listenerCount('close'),0);assert.equal(f.context.listenerCount('page'),0);assert.equal(f.calls.some(row=>row.method==='Runtime.evaluate'),false)
 const g=fixture(t);g.hooks.safety=()=>{throw Error('synthetic protected document')};await assert.rejects(g.open());assert.equal(g.calls.some(row=>row.method==='Runtime.evaluate'),false);assert.equal(g.calls.filter(row=>row.method==='detach').length,1)
})
test('false or asynchronous native transport qualification refuses before any owned storage session',async t=>{
 for(const value of [false,Promise.resolve(true)]){const f=fixture(t);f.hooks.qualified=()=>value;await assert.rejects(f.open(),/async_proof|context_changed/);assert.equal(f.calls.some(row=>row.method==='new-session'),false)}
})
test('failed native detach attempts independent listener cleanup and retains private reservation',async t=>{
 const f=fixture(t),cap=await f.open();f.hooks.detach=()=>{throw Error('synthetic native cleanup failure')};cap.release();await assert.rejects(cap.whenDrained(),/cleanup_unknown/);assert.equal(f.page.listenerCount('framenavigated'),0);assert.equal(cap.activity().cleanupUnknown,true);assert.ok(cap.activity().pendingPhysicalOperations>0);await assert.rejects(f.open(),/busy_or_invalid/)
})

