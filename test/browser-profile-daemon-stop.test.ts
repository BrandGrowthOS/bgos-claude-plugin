import {test} from 'node:test'
import assert from 'node:assert/strict'
import {terminateBrowserDaemon} from '../lib/browser-profile-daemon-stop.mjs'

test('successful guarded process shutdown exits zero without invoking physical emergency cleanup',async()=>{
  let emergency=0;const lines:string[]=[]
  assert.equal(await terminateBrowserDaemon({stop:async()=>{},emergencyStop:async()=>{emergency++;return{stopped:true}},ms:30,log:(line:string)=>lines.push(line)}),0)
  assert.equal(emergency,0);assert.deepEqual(lines,['stopped cleanly'])
})
test('explicit termination after save refusal stops only owned native processes and exits nonzero without a saved receipt claim',async()=>{
  const events:string[]=[],lines:string[]=[]
  const code=await terminateBrowserDaemon({stop:async()=>{events.push('save-refused');throw Error('unsaved form')},emergencyStop:async()=>{events.push('owned-physical-stop');return{stopped:true,recoveryRequired:true}},ms:30,log:(line:string)=>lines.push(line)})
  assert.equal(code,1);assert.deepEqual(events,['save-refused','owned-physical-stop']);assert.ok(lines.some(line=>line.includes('recovery_required')));assert.ok(lines.some(line=>line.includes('prior encrypted journal retained')));assert.equal(lines.includes('stopped cleanly'),false)
})
test('hung guarded save is never retried and cleanup must finish before termination outcome',async()=>{
  let attempts=0,release!:(value:unknown)=>void,done=false
  const task=terminateBrowserDaemon({stop:()=>{attempts++;return new Promise(()=>{})},emergencyStop:()=>new Promise(resolve=>{release=resolve}),ms:10,cleanupMs:500}).then(code=>{done=true;return code})
  for(let count=0;count<50&&!release;count++)await new Promise(resolve=>setTimeout(resolve,2))
  assert.equal(done,false);assert.equal(attempts,1);release({stopped:true});assert.equal(await task,1);assert.equal(attempts,1)
})
test('failed or timed-out physical cleanup remains explicitly unconfirmed and never becomes a zero exit',async()=>{
  for(const emergencyStop of [async()=>{throw Error('unknown process')},()=>new Promise(()=>{})]){
    const lines:string[]=[];assert.equal(await terminateBrowserDaemon({stop:async()=>{throw Error('save failed')},emergencyStop,ms:10,cleanupMs:10,log:(line:string)=>lines.push(line)}),1)
    assert.ok(lines.some(line=>line.includes('cleanup is unconfirmed')));assert.equal(lines.some(line=>line.includes('processes stopped')),false)
  }
})
