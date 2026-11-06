import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BrowserPool,ChromiumEngine,resolveChromeExecutable} from '../bin/hoai-browser-host.mjs'
import {RemoteBrowserViews} from '../lib/remote-view.mjs'
import {serveSite} from './browser-site-fixture.ts'

for(const language of ['en','ar'])test(`round18 remote ${language} offers exact-tab Reload and preserves later person input`,{timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'round18-remote-'))
 const site=await serveSite(()=>`<html lang=${language}><h1>Public</h1><input></html>`)
 const pool=new BrowserPool({agentRoot:root,createEngine:(args:any)=>new ChromiumEngine({...args,executable:resolveChromeExecutable().path!,headless:true})})
 const views=new RemoteBrowserViews({pool}),frames:any[]=[]
 try{
  const context={assistantId:901,principal:'user-fixture'},slot=await pool.acquire(context),page=slot.engine.pages()[0]
  await page.goto(site.origin)
  assert.equal(await views.open({viewId:'reload-view',...context},{connectionId:'owner-socket',sendFrame:(frame:any)=>{frames.push(frame);return true},sendClose:()=>{}}),true)
  const ready=frames[0].frame.params
  await page.evaluate((language:string)=>{document.open();document.write(`<html lang=${language}><input><script>window.addEventListener('keydown',()=>{},true)<`+`/script></html>`);document.close()},language)
  const snapshot=await slot.engine.callTool('browser_snapshot',{})
  assert.match(JSON.stringify(snapshot),language==='ar'?/إعادة تحميل/:/reloaded/)
  assert.equal(slot.engine.pagePrivacy(page).reloadRequired,true)
  assert.ok(frames.some(m=>m.frame.method==='hoai.privacy'&&m.frame.params.reloadRequired===true))
  const make=(id:number,method:string,tabId=ready.tabId)=>({viewId:'reload-view',frame:{id,method,params:{},sessionId:ready.sessionId,tabId}})
  await views.command(make(1,'hoai.input.handBack'),'owner-socket')
  assert.equal(frames.find(m=>m.frame.id===1).frame.error.code,'reload_required')
  await views.command(make(2,'hoai.input.reload','other-tab'),'owner-socket')
  assert.equal(slot.engine.pagePrivacy(page).reloadRequired,true)
  assert.equal(await views.command(make(3,'hoai.input.reload'),'other-socket'),false)
  await views.command(make(4,'hoai.input.reload'),'owner-socket')
  assert.deepEqual(frames.find(m=>m.frame.id===4).frame.result,{})
  assert.equal(slot.engine.pagePrivacy(page).reloadRequired,false)
  assert.match(JSON.stringify(await slot.engine.callTool('browser_snapshot',{})),/Public/)
  const cdp=await page.context().newCDPSession(page)
  try{await cdp.send('Runtime.evaluate',{expression:'document.querySelector("input").focus()'});await cdp.send('Input.insertText',{text:'MADEUP-REMOTE9876'})}finally{await cdp.detach()}
  const held=await slot.engine.callTool('browser_snapshot',{})
  assert.doesNotMatch(JSON.stringify(held),/MADEUP/)
  assert.match(JSON.stringify(held),language==='ar'?/يستخدم الشخص/:/The person is using/)
 }finally{await views.stop();await pool.stopAll();await site.close();rmSync(root,{recursive:true,force:true})}
})
