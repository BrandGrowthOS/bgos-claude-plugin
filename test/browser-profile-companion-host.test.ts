import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import path from 'node:path'
import {PairingConnection,handshakeOptions,PlaywrightEngine,BrowserHost} from '../bin/hoai-browser-host.mjs'
test('agent host advertises one fresh native boot and typed frames never enter the legacy MCP relay or result route',async()=>{let legacy=0,posted=0;const received:unknown[]=[],pairing={token:'fixture',assistantIds:[42],backendUrl:'https://hoai.test',pairingId:7},connection:any=new PairingConnection({pairing,deviceLabel:'Agent',relay:{relay:async()=>{legacy++;return{}}},fetchImpl:(async()=>{posted++;return new Response('{}')})as unknown as typeof fetch});assert.match(connection.bootId,/^[a-f0-9-]{36}$/);assert.equal(handshakeOptions(pairing,'Agent',connection.bootId).auth.deviceBootId,connection.bootId);connection.profileCompanion={receive:async(frame:unknown,socketId:string)=>received.push({frame,socketId})};const frame={event_type:'browser_profile_rpc',rpcId:randomUUID(),message:{malicious:'wake body is not execution authority'}};await connection.handleFrame(frame,'original-socket');assert.deepEqual(received,[{frame,socketId:'original-socket'}]);assert.equal(legacy,0);assert.equal(posted,0);connection.profileCompanion=null;await connection.handleFrame(frame,'original-socket');assert.equal(legacy,0);assert.equal(posted,0)})
test('managed engine refuses inactive runtime before attempting any second CDP browser connection',async()=>{const engine:any=new PlaywrightEngine({endpoint:'http://127.0.0.1:1',caps:[],outputDir:process.cwd(),clientName:'fixture',clientVersion:'1',managedRuntime:{assertCurrent(){throw Error('inactive-fixture')}}});await assert.rejects(engine.start(),/inactive-fixture/);assert.equal(engine._browser,null)})

test('known managed recipient namespace refuses legacy MCP without affecting another person',async()=>{
  let legacy=0;const posted:any[]=[],connection:any=new PairingConnection({pairing:{token:'fixture',assistantIds:[42],backendUrl:'https://hoai.test',pairingId:7},deviceLabel:'Agent',relay:{relay:async()=>{legacy++;return{ok:true,message:{jsonrpc:'2.0',id:1,result:{}}}}},fetchImpl:(async(_url:unknown,options:any)=>{posted.push(JSON.parse(options.body));return new Response('{}')})as unknown as typeof fetch})
  connection.profileCompanion={hasNamespace:(value:any)=>value.assistantId===42&&value.principal==='user-recipient'}
  const frame={rpcId:randomUUID(),assistantId:42,clientId:'fixture',principal:'user-recipient',message:{jsonrpc:'2.0',id:1,method:'tools/list'}}
  await connection.handleFrame(frame,'socket');assert.equal(legacy,0);assert.equal(posted[0].ok,false);assert.equal(posted[0].error.code,'browser_profile_managed')
  await connection.handleFrame({...frame,rpcId:randomUUID(),principal:'user-other'},'socket');assert.equal(legacy,1);assert.equal(posted[1].ok,true)
})

test('legacy live views cannot open a second browser for the known managed recipient',async()=>{
  const socket:any=new EventEmitter();socket.connected=true;socket.id='socket';socket.disconnect=()=>{}
  const opened:any[]=[],closed:any[]=[],connection:any=new PairingConnection({pairing:{token:'fixture',assistantIds:[42],backendUrl:'https://hoai.test',pairingId:7},deviceLabel:'Agent',relay:{relay:async()=>({})},io:(()=>socket)as any,remoteViews:{open:async(input:unknown)=>opened.push(input),close:async()=>{},closeConnection:async()=>{}}as any})
  connection.profileCompanion={hasNamespace:(value:any)=>value.assistantId===42&&value.principal==='user-recipient',revoke:async()=>{},disconnected(){}}
  socket.on('browser_view_close',(input:unknown)=>closed.push(input));connection.start();connection.socketId='socket'
  socket.emit('browser_view_open',{assistantId:42,principal:'user-recipient',viewId:'managed'});socket.emit('browser_view_open',{assistantId:42,principal:'user-other',viewId:'other'});await new Promise(resolve=>setImmediate(resolve))
  assert.equal(opened.length,1);assert.equal(opened[0].viewId,'other');assert.ok(closed.some(value=>value.viewId==='managed'&&value.reason==='profile_namespace_managed'));connection.stop()
})

test('rotated pairing retains its physical stop reservation and only reconnects after actual disposal',async()=>{
  let token='old',made=0,release!:()=>void;const host:any=new BrowserHost({agentRoot:process.cwd(),env:{},browserTools:[],createEngine:async()=>{throw Error('must not start legacy')},listDir:()=>['credentials-42.json'],readText:()=>JSON.stringify({backendUrl:'https://hoai.test',pairingToken:token,pairingId:7,assistantId:42}),io:(()=>{const socket:any=new EventEmitter();socket.disconnect=()=>{};return socket})as any,createProfileCompanion:(()=>{made++;return{stop:async()=>{},revoke:made===1?()=>new Promise<void>(resolve=>{release=resolve}):async()=>{},emergencyTerminate:async()=>({stopped:true})}})as any})
  host.reconcile();const original=[...host.connections.values()][0]as any;token='new';host.reconcile();host.reconcile();await new Promise(resolve=>setImmediate(resolve));assert.equal(made,1);assert.equal(host.connections.size,0);assert.equal(host.retiringConnections.size,1);assert.equal(original.stop(),original.stopTask)
  release();await original.stopTask;await new Promise(resolve=>setImmediate(resolve));assert.equal(made,2);assert.equal(host.retiringConnections.size,0);assert.equal(host.connections.size,1);await host.stop()
})

test('failed revoked disposal remains tracked for explicit emergency cleanup and cannot be replaced',async()=>{
  let token='old',made=0,emergency=0;const host:any=new BrowserHost({agentRoot:process.cwd(),env:{},browserTools:[],createEngine:async()=>{throw Error('must not start legacy')},listDir:()=>['credentials-42.json'],readText:()=>JSON.stringify({backendUrl:'https://hoai.test',pairingToken:token,pairingId:7,assistantId:42}),io:(()=>{const socket:any=new EventEmitter();socket.disconnect=()=>{};return socket})as any,createProfileCompanion:(()=>{made++;return{stop:async()=>{},revoke:async()=>{throw Error('physical failure')},emergencyTerminate:async()=>{emergency++;return{stopped:true}}}})as any})
  host.reconcile();token='new';host.reconcile();await new Promise(resolve=>setImmediate(resolve));host.reconcile();assert.equal(made,1);assert.equal(host.retiringConnections.size,1);assert.equal((await host.emergencyStopOwnedProfiles()).stopped,true);assert.equal(emergency,1);assert.equal(host.retiringConnections.size,1);await assert.rejects(host.stop(),/physical failure/);host.relay.close()
})
