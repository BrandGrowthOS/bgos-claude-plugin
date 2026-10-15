import { test } from 'node:test'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
import assert from 'node:assert/strict'
import { createPinnedProfileTargetSessions } from '../lib/browser-profile-cdp-targets.mjs'
import { ProfileTargetLedger } from '../lib/browser-profile-runtime.mjs'
import { bindFakeProfileNativePipe } from './helpers/browser-profile-flat-native'
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve))
const gate=()=>{let resolve!:(value?:unknown)=>void;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
function fixture(t:any,timeoutMs=1000){const native=bindFakeProfileNativePipe(),adapter=createPinnedProfileTargetSessions({...native,timeoutMs}),receipts:any[]=[],events:any[]=[],detached:any[]=[],failures:any[]=[];adapter.subscribe({attached:(v:any)=>receipts.push(v),event:(v:any)=>events.push(v),detached:(v:any)=>detached.push(v),failure:(v:any)=>failures.push(v)});t.after(()=>{adapter.dispose();native.disconnect()});return{...native,adapter,receipts,events,detached,failures,claim(){native.attach();return adapter.claim(receipts[0])}}}

test('native attachment receipt is one-use and its original private pipe owns exactly one routed child',async t=>{
 const f=fixture(t),cap=f.claim();assert.equal(f.wire._sessions.size,3);await f.adapter.send(cap,'Network.enable');assert.equal(f.calls.length,1);assert.equal(f.calls[0].sessionId,'child-a');assert.throws(()=>f.adapter.claim(f.receipts[0]),{code:'profile_target_native_attachment_invalid'});assert.equal(f.wire._sessions.size,3)
})
test('a serialized copy cannot claim a native attachment and a foreign session ID is never overwritten',t=>{
 const f=fixture(t);f.attach();const foreign={foreign:true};f.wire._sessions.set('child-a',foreign);assert.throws(()=>f.adapter.claim(f.receipts[0]),{code:'profile_target_native_attachment_invalid'});assert.strictEqual(f.wire._sessions.get('child-a'),foreign)
 const g=fixture(t);g.attach();assert.throws(()=>g.adapter.claim(structuredClone(g.receipts[0])),{code:'profile_target_native_attachment_invalid'});assert.equal(g.wire._sessions.size,2)
})
test('root browser dispatcher wire and native parent identities cannot be replaced after review',async t=>{
 for(const mutate of [(f:any)=>{f.root._connection={}},(f:any)=>{f.browser._connection={}},(f:any)=>{f.serverRoot._session={}},(f:any)=>{f.serverBrowser._connection={}},(f:any)=>{const original=f.dispatcher._dispatcherByGuid.get(f.root._guid);f.dispatcher._dispatcherByGuid.set(f.root._guid,{_object:{}});return()=>f.dispatcher._dispatcherByGuid.set(f.root._guid,original)},(f:any)=>{f.wire._transport={send(){}}},(f:any)=>{f.wire._rawSend=()=>{}},(f:any)=>{f.wire._sessions.set('browser-root',{})}]){
  const f=fixture(t),cap=f.claim(),restore:unknown=mutate(f);try{await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.calls.length,0);assert.equal(f.adapter.activity().cleanupUnknown,true)}finally{if(typeof restore==='function')restore()}
 }
})
test('child parent connection registration and send replacement refuse before any native command',async t=>{
 for(const mutate of [(f:any)=>{f.wire._sessions.set('child-a',{})},(f:any)=>{f.wire._sessions.get('child-a')._parentSession={}},(f:any)=>{f.wire._sessions.get('child-a')._connection={}},(f:any)=>{f.wire._sessions.get('child-a').send=()=>Promise.resolve({})},(f:any)=>{f.wire._sessions.get('child-a')._eventListener=()=>{}},(f:any)=>{f.wire._sessions.get('child-a')._callbacks=new Map()}]){const f=fixture(t),cap=f.claim();mutate(f);await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.calls.length,0)}
})
test('nested native sessions retain the exact observed parent and forward each original event once',async t=>{
 const f=fixture(t),cap=f.claim();f.attach('nested-a','nested-target','child-a');const child=f.adapter.claim(f.receipts[1]);await f.adapter.send(child,'Debugger.enable');const native=f.wire._sessions.get('nested-a');assert.strictEqual(native._parentSession,f.wire._sessions.get('child-a'));native.event('Network.requestWillBeSent',{requestId:'original'});assert.deepEqual(f.events,[{sessionId:'nested-a',method:'Network.requestWillBeSent',params:{requestId:'original'}}]);assert.equal(f.calls.length,1)
})
test('target detach retires only its owned registration and fences late events and future sends',async t=>{
 const f=fixture(t),cap=f.claim(),native=f.wire._sessions.get('child-a');f.detach('child-a');assert.equal(f.wire._sessions.has('child-a'),false);assert.equal(f.detached.length,1);native.event('Network.loadingFinished',{requestId:'late'});assert.equal(f.events.length,0);await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.calls.length,0)
})
test('a timed-out native command keeps its physical slot and latches refusal without resending',async t=>{
 const f=fixture(t,10),held=gate(),cap=f.claim();f.wire.handler=()=>held.promise;await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.adapter.activity().pendingCommands,1);await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.calls.length,1);held.resolve();await turn();assert.equal(f.adapter.activity().pendingCommands,0);assert.equal(f.adapter.activity().cleanupUnknown,true)
})
test('local owned-session closure retains work until the original callback promise actually settles',async t=>{
 const f=fixture(t),held=gate(),cap=f.claim();f.wire.handler=()=>held.promise;const command=f.adapter.send(cap,'Network.enable');void command.catch(()=>{});assert.equal(f.adapter.activity().pendingCommands,1);f.adapter.dispose();assert.equal(f.adapter.activity().pendingCommands,1);await assert.rejects(command);assert.equal(f.adapter.activity().pendingCommands,0);f.disconnect();held.resolve()
})
test('root close invalidates its exact registration and never disposes another replacement session',async t=>{
 const f=fixture(t),cap=f.claim(),native=f.wire._sessions.get('child-a'),foreign={foreign:true};f.wire._sessions.set('child-a',foreign);f.root.emit('close');assert.strictEqual(f.wire._sessions.get('child-a'),foreign);assert.equal(native._closed,false);await assert.rejects(f.adapter.send(cap,'Network.enable'));assert.equal(f.calls.length,0)
})
test('native command capacity is reserved synchronously and clears only after actual settlement',async t=>{
 const f=fixture(t),held=gate(),cap=f.claim();f.wire.handler=()=>held.promise;const tasks=Array.from({length:128},()=>f.adapter.send(cap,'Network.enable'));await assert.rejects(f.adapter.send(cap,'Network.enable'),{code:'profile_inventory_limit'});assert.equal(f.calls.length,128);assert.equal(f.adapter.activity().pendingCommands,128);held.resolve();await Promise.all(tasks);assert.equal(f.adapter.activity().pendingCommands,0)
})
test('duplicate cleanup resumes and detaches its own native session without touching the primary',async t=>{
 const f=fixture(t),cap=f.claim();f.attach('duplicate','target-a');await f.adapter.releaseDuplicate(f.receipts[1]);assert.equal(f.wire._sessions.has('duplicate'),false);assert.equal(f.wire._sessions.has('child-a'),true);assert.deepEqual(f.calls.map(row=>[row.sessionId,row.method]),[['duplicate','Runtime.runIfWaitingForDebugger'],['browser-root','Target.detachFromTarget']]);await f.adapter.send(cap,'Network.enable')
})
test('malformed and replayed native attachment receipts latch an explicit refusal',t=>{
 const f=fixture(t);f.attach();f.attach();assert.equal(f.failures.length,1);assert.throws(()=>f.adapter.assertQualified());const g=fixture(t);g.root.emit('Target.attachedToTarget',{sessionId:'bad',targetInfo:{targetId:'x'},waitingForDebugger:true});assert.throws(()=>g.adapter.assertQualified())
})
test('disposal removes only owned listeners and cannot publish later native events',t=>{
 const f=fixture(t),foreign=()=>{};f.root.on('Target.attachedToTarget',foreign);f.claim();const native=f.wire._sessions.get('child-a');f.adapter.dispose();assert.deepEqual(f.root.listeners('Target.attachedToTarget'),[foreign]);native.event('Network.loadingFinished',{requestId:'late'});assert.equal(f.events.length,0);f.attach('late','late');assert.equal(f.receipts.length,1)
})


test('a foreign package connection is refused without replacing the canonical resolver',t=>{
 const foreign=require('playwright-core/lib/coreBundle').inprocess.createInProcessPlaywright().chromium._connection;const f=bindFakeProfileNativePipe(undefined,undefined,foreign);t.after(()=>f.disconnect());assert.notStrictEqual(f.client,require('playwright-core').chromium._connection);assert.throws(()=>createPinnedProfileTargetSessions(f),{code:'profile_target_native_binding_invalid'})
})

test('disconnect retains reservations until the original rejected native callbacks settle',async t=>{
 const f=fixture(t),held=gate(),cap=f.claim();f.wire.handler=()=>held.promise;const command=f.adapter.send(cap,'Network.enable');void command.catch(()=>{});f.disconnect();assert.equal(f.adapter.activity().pendingCommands,1);await assert.rejects(command);assert.equal(f.adapter.activity().pendingCommands,0);held.resolve()
})

test('failed owned-session cleanup stays unknown and retained until actual native callback settlement',async t=>{
 const f=fixture(t),held=gate(),cap=f.claim(),native=f.wire._sessions.get('child-a');f.wire.handler=()=>held.promise;const command=f.adapter.send(cap,'Network.enable');void command.catch(()=>{});const original=native.dispose;native.dispose=()=>{throw Error('foreign replacement')};f.adapter.dispose();assert.equal(native._closed,false);assert.equal(f.adapter.activity().pendingCommands,1);assert.equal(f.adapter.activity().cleanupUnknown,true);native.dispose=original;held.resolve();await assert.rejects(command);assert.equal(f.adapter.activity().pendingCommands,0);assert.equal(f.adapter.activity().cleanupUnknown,true)
})

test('pending attachment and total registration history have independent synchronous bounds',t=>{
 const f=fixture(t);for(let i=0;i<2048;i++)f.attach('pending-'+i,'target-'+i);assert.equal(f.adapter.activity().pendingRegistrations,2048);f.attach('pending-excess','target-excess');assert.equal(f.adapter.activity().pendingRegistrations,2048);assert.equal(f.adapter.activity().cleanupUnknown,true)
 const g=fixture(t);for(let i=0;i<8192;i++){g.attach('history-'+i,'target-'+i);g.adapter.claim(g.receipts[i]);g.detach('history-'+i)}assert.equal(g.adapter.activity().activeSessions,0);g.attach('history-excess','target-excess');assert.equal(g.adapter.activity().cleanupUnknown,true)
})

test('native global command capacity cannot be bypassed with multiple sessions',async t=>{
 const f=fixture(t),held=gate(),caps:any[]=[];for(let i=0;i<33;i++){f.attach('session-'+i,'target-'+i);caps.push(f.adapter.claim(f.receipts[i]))}f.wire.handler=()=>held.promise;const tasks=caps.slice(0,32).flatMap(cap=>Array.from({length:128},()=>f.adapter.send(cap,'Network.enable')));await assert.rejects(f.adapter.send(caps[32],'Network.enable'),{code:'profile_inventory_limit'});assert.equal(f.calls.length,4096);assert.equal(f.adapter.activity().pendingCommands,4096);held.resolve();await Promise.all(tasks);assert.equal(f.adapter.activity().pendingCommands,0)
})


test('nested registration refuses a replaced parent before creating any child session',t=>{
 const f=fixture(t);f.claim();f.attach('nested-a','nested-target','child-a');f.wire._sessions.set('child-a',{foreign:true});assert.throws(()=>f.adapter.claim(f.receipts[1]));assert.equal(f.wire._sessions.has('nested-a'),false)
})


test('flat target initialization queues native observers before release and requires their actual answers',async t=>{
 const f=fixture(t),held=gate();f.wire.handler=(_session:any,method:string)=>method==='Network.enable'?held.promise:{};f.adapter.dispose();const adapter=createPinnedProfileTargetSessions(f),ledger=new ProfileTargetLedger(f.root,{targetSessions:adapter});t.after(()=>ledger.dispose());f.attach();const target=ledger.targets.get('child-a');assert.deepEqual(f.calls.map(row=>row.method),['Network.enable','Debugger.enable','Target.setAutoAttach','Runtime.runIfWaitingForDebugger']);await turn();assert.equal(target.ready,false);held.resolve();await target.initialization;assert.equal(target.ready,true)
})

test('frozen births remain paused and failed observer answers cannot use a legacy resume fallback',async t=>{
 for(const frozen of [true,false]){const f=fixture(t);f.adapter.dispose();const adapter=createPinnedProfileTargetSessions(f),ledger=new ProfileTargetLedger(f.root,{targetSessions:adapter});t.after(()=>ledger.dispose());ledger.frozen=frozen;let publicCommands=0;f.root.send=async()=>{publicCommands++;return{}};f.wire.handler=(_session:any,method:string)=>{if(!frozen&&method==='Network.enable')throw Error('synthetic observer refusal');return{}};f.attach();const target=ledger.targets.get('child-a');await target.initialization;assert.equal(publicCommands,0);if(frozen){assert.equal(target.ready,true);assert.equal(target.paused,true);assert.equal(f.calls.some(row=>row.method==='Runtime.runIfWaitingForDebugger'),false)}else{assert.equal(target.ready,false);assert.equal(target.unqualified,true);assert.equal(ledger.failure,'profile_target_tracking_unavailable');assert.equal(f.calls.filter(row=>row.method==='Runtime.runIfWaitingForDebugger').length,1)}}
})
