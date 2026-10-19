import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {readFileSync,readdirSync} from 'node:fs'
import {BrowserProfileRuntime,profileCrypto as crypto} from '../lib/browser-profile-runtime.mjs'
import {terminateBrowserDaemon} from '../lib/browser-profile-daemon-stop.mjs'
const require=createRequire(import.meta.url),{chromium}=require(process.env.HOAI_PROBE_PLAYWRIGHT)
const website=createServer((_,response)=>{response.setHeader('Content-Type','text/html');response.end('<input id="draft" value="baseline"><script>globalThis.ticks=0;setInterval(()=>globalThis.ticks++,10)</script>')});await new Promise(resolve=>website.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${website.address().port}`,source=crypto.createEndpointIdentity(randomUUID()),key=crypto.createContentKeyEpoch(1),authority={profileId:randomUUID(),actingUserId:'disposable-fixture',assistantId:42,endpointId:source.identity.endpointId,bootId:randomUUID(),runtimeId:randomUUID(),sessionId:randomUUID(),writerEpoch:1,revision:0,contentKeyEpoch:1,grantVersion:1,keyFingerprint:crypto.identityFingerprint(source.identity)},context={version:1,schemaVersion:1,profileId:authority.profileId,actingUserId:authority.actingUserId,assistantId:42,transitionId:randomUUID(),revision:1,previousManifestHash:null,keyEpoch:1,source:Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch'].map(name=>[name,authority[name]])),destination:Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint'].map(name=>[name,authority[name]]))}
let runtime,receipts=0,owned,cleanup
try{
  runtime=await BrowserProfileRuntime.create({chromium,executable:'/usr/bin/google-chrome',authority,transferQualification:{kind:'restricted-disposable-fixture',origins:[origin],assertQualified:()=>true},onOwnedProcess:cap=>owned=cap,closeAndDrain:async()=>({admissionClosed:true,drained:true}),checkpoint:async()=>{receipts++;throw Error('must not write')},authorizeActivation:async()=>({authority,assertCurrent(){}}),preflightExtras:()=>({passwordVault:{v:1,entries:[],neverOrigins:[]},preferences:{v:1,searchEngine:'google'}}),captureExtras:()=>{throw Error('must not capture')},commitExtras:()=>({committed:true}),timeoutMs:5000})
  await runtime.activate(authority);const page=await runtime.newPage(origin);await page.locator('#draft').fill('unsaved-shutdown-canary')
  const pid=runtime.processIdentity.pid,stat=readFileSync(`/proc/${pid}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');assert.equal(Number(parts[2]),pid);assert.equal(parts[19],runtime.processIdentity.started);assert.equal(typeof owned.stop,'function')
  const nativeProcesses=(await runtime.root.send('SystemInfo.getProcessInfo')).processInfo
  for(const child of nativeProcesses){const value=readFileSync(`/proc/${child.id}/stat`,'utf8');assert.equal(Number(value.slice(value.lastIndexOf(')')+2).split(' ')[2]),pid)}
  const stop=()=>runtime.finalize({context,source,destinationIdentity:source.identity,contentKeyEpoch:key})
  await assert.rejects(stop(),{reason:'profile_unsaved_form_state'});assert.equal(runtime.state,'active');assert.equal(runtime.network,'active');assert.equal(await page.inputValue('#draft'),'unsaved-shutdown-canary');const before=await page.evaluate(()=>globalThis.ticks);await new Promise(resolve=>setTimeout(resolve,50));assert.ok(await page.evaluate(()=>globalThis.ticks)>before);assert.equal(receipts,0)
  runtime.processIdentity={pid:process.pid,started:'mutable-untrusted-field'}
  const lines=[],exit=await terminateBrowserDaemon({stop,emergencyStop:async()=>cleanup=await runtime.emergencyStopOwnedProcess(),log:line=>lines.push(line),ms:10000});assert.equal(exit,1);assert.deepEqual(cleanup,{stopped:true,recoveryRequired:true});assert.equal(receipts,0);assert.equal(runtime.state,'disposed');assert.equal(runtime.contentKeyEpoch,null)
  assert.throws(()=>readFileSync(`/proc/${pid}/stat`),{code:'ENOENT'})
  const remaining=readdirSync('/proc').filter(name=>/^\d+$/.test(name)).filter(name=>{try{const line=readFileSync(`/proc/${name}/stat`,'utf8');return Number(line.slice(line.lastIndexOf(')')+2).split(' ')[2])===pid}catch{return false}});assert.deepEqual(remaining,[])
  process.stdout.write(JSON.stringify({ok:true,scope:'disposable real Chrome155 shutdown; coordinator/activation/empty extras/restricted origin are fixtures',browserVersion:runtime.browserVersion,exitCode:exit,receipts,checks:['native_root_pgid_equals_pid','immutable_root_start_token','normal_stop_refusal_preserves_page_edit_timer','explicit_shutdown_exits_nonzero','all_owned_group_processes_zero','no_stopped_receipt_or_failover','recovery_required_reported'],lines})+'\n');process.exitCode=exit
}finally{key.key.fill(0);if(runtime)await runtime.browser.close().catch(()=>{});await new Promise(resolve=>website.close(resolve))}
