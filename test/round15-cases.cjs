"use strict";
const {createServer}=require('node:http');
const {test}=require('node:test');const assert=require('node:assert/strict');
const text=r=>(r?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
module.exports=(rig,host)=>{for(const lang of ['en','ar']){
 const check=(name,work)=>test(`${host} ${lang} round15 ${name}`,{timeout:90000},async t=>{const r=await rig(t),set=r.set;r.set=html=>set(`<html lang=${lang}>${html}</html>`);await work(r,t)});
 const blind=async r=>{for(const [name,args]of [['browser_snapshot',{}],['browser_tabs',{action:'list'}],['browser_take_screenshot',{}],['browser_find',{text:'Welcome'}],['browser_navigate',{url:r.origin+'/escape'}],['browser_close',{}],['browser_press_key',{key:'Backspace'}],['browser_tabs',{action:'new',url:r.origin+'/new'}]]){const reply=await r.call(name,args);assert.doesNotMatch(text(reply),/MADEUP|Welcome|SECRET-TITLE/,name);assert.equal(reply.content?.some(p=>p.type==='image'),false,name);assert.match(text(reply),/Hand back|إعادة التحكم/,name)}};
 check('Q3b unread form submitted across origins during wait stays blind',async (r,t)=>{
  let received=null;
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');
    if(req.url.startsWith('/check')){received=new URL(req.url,'http://fixture.invalid').searchParams.get('customField');res.end('<meta http-equiv=refresh content="0;url=/done">')}
    else res.end(`<html lang=${lang}><title>Welcome ${received}</title><h1>Welcome ${received}</h1></html>`);
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const destination=`http://127.0.0.1:${server.address().port}`;
  await r.set('<h1>Ready</h1>');await r.call('browser_snapshot');const pending=r.call('browser_wait_for',{time:2});
  await new Promise(resolve=>setTimeout(resolve,150));await r.set(`<form action=${destination}/check method=get><input type=password name=customField><button>Submit</button></form>`);
  await r.person('document.querySelector("input").focus()');await Promise.all([r.page.waitForURL(destination+'/done'),r.page.evaluate(()=>document.querySelector('form').requestSubmit())]);
  assert.equal(received,'MADEUP-PERSON9876');assert.doesNotMatch(text(await pending),/MADEUP|Welcome|SECRET-TITLE/);await blind(r);
 });
 check('after Hand back input before next read relocks immediately',async r=>{
  await r.set('<input>');await r.person('document.querySelector("input").focus()');await blind(r);await r.page.evaluate(()=>document.querySelector('input').value='');await r.handBack();await r.person('document.querySelector("input").focus()');await r.page.evaluate(()=>{document.title='Welcome MADEUP-PERSON9876';document.body.innerHTML='<h1>Welcome MADEUP-PERSON9876</h1>'});await blind(r);
 });
 check('postal PIN code and Pin to top stay ordinary until person input',async r=>{
  for(const label of ['PIN code','Pin to top']){await r.set(`<h1>Ordinary</h1><input aria-label="${label}" autocomplete=postal-code>`);const first=text(await r.call('browser_snapshot'));assert.match(first,/Ordinary/);const target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(first)?.[1];await r.route('browser_type',{target,text:'560001',element:label},['allow_once']);assert.match(text(await r.call('browser_snapshot')),/560001/);await r.person('document.querySelector("input").focus()');await blind(r);await r.page.evaluate(()=>document.querySelector('input').value='');await r.handBack()}
 });
 check('agent fills and keys keep ordinary page readable',async r=>{
  await r.set('<h1>Ordinary</h1><input aria-label=Reference>');let first=text(await r.call('browser_snapshot'));const target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(first)?.[1];await r.route('browser_type',{target,text:'MADEUP-AGENT9876',element:'Reference'},['allow_once']);assert.match(text(await r.call('browser_snapshot')),/MADEUP-AGENT9876/);await r.route('browser_press_key',{key:'ArrowLeft'},['allow_once']);assert.match(text(await r.call('browser_snapshot')),/Ordinary/);
 });
 check('person input and Hand back are confined to one physical tab',async r=>{
  await r.set('<input><h1>First public</h1>');const first=r.page;
  const other=await first.context().newPage();await other.goto(r.origin+'/second');
  await r.engine._privacy.watchPersonInput(other);
  await r.person('document.querySelector("input").focus()',first);
  assert.equal(r.engine._privacy.personMode(first),true);assert.equal(r.engine._privacy.personMode(other),false);
  await r.person('document.querySelector("input").focus()',other);
  assert.equal(r.engine._privacy.personMode(other),true);
  r.engine._privacy.handBack(first);
  assert.equal(r.engine._privacy.personMode(first),false);assert.equal(r.engine._privacy.personMode(other),true);
  const firstRead=await r.engine._privacy.forPage(first,async()=>{await r.engine._privacy.read(first);return r.engine._privacy.privacyState()});
  const otherRead=await r.engine._privacy.forPage(other,async()=>{await r.engine._privacy.read(other);return r.engine._privacy.privacyState()});
  assert.equal(firstRead.blocked,false);assert.equal(otherRead.blocked,true);
 });
 check('a real body key and a drop lock without a field or a first read',async r=>{
  await r.set('<h1>Public body</h1>');
  await r.raw(send=>send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Shift',code:'ShiftLeft',modifiers:8}));
  await blind(r);await r.handBack();
  await r.set('<h1 ondragover="event.preventDefault()" ondrop="event.preventDefault();document.title=\'Welcome MADEUP9876\'" style="height:400px">Drop here</h1>');
  await r.raw(async send=>{for(const type of ['dragEnter','dragOver','drop'])await send('Input.dispatchDragEvent',{type,x:40,y:40,data:{items:[{mimeType:'text/plain',data:'MADEUP9876'}],dragOperationsMask:1}})});
  await blind(r);
 });
 check('real Chromium autofill of an ordinary address locks at input',async r=>{
  await r.set('<form><input id=name autocomplete=name><input autocomplete=address-line1><input autocomplete=address-level2><input autocomplete=postal-code></form>');
  await r.raw(async send=>{
    const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'#name'});const {node}=await send('DOM.describeNode',{nodeId});
    await send('Autofill.enable');await send('Autofill.trigger',{fieldId:node.backendNodeId,address:{fields:[{name:'NAME_FULL',value:'Madeup Person'},{name:'ADDRESS_HOME_LINE1',value:'123 Fiction Road'},{name:'ADDRESS_HOME_CITY',value:'Madeup City'},{name:'ADDRESS_HOME_ZIP',value:'560001'}]}});
  });
  await blind(r);
 });
 check('person input in a fresh cross-site iframe locks its physical parent tab',async (r,t)=>{
  const child=createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html lang=${lang}><input><h1>Child</h1></html>`)});
  await new Promise(resolve=>child.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>child.close(resolve)));
  await r.set(`<h1>Parent public</h1><iframe src="http://localhost:${child.address().port}/child"></iframe>`);
  for(let attempt=0;attempt<60&&!r.page.frames().some(frame=>frame.url().includes('/child'));attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  const frame=r.page.frames().find(frame=>frame.url().includes('/child'));assert.ok(frame);
  await r.raw(async send=>{await send('Runtime.evaluate',{expression:'document.querySelector("input").focus()'});await send('Input.insertText',{text:'MADEUP-CHILD9876'})},frame);
  await blind(r);
 });
 check('removed sequential typing refuses before entry and person input blocks later fills',async r=>{
  await r.set('<input aria-label=Reference>');const tree=text(await r.call('browser_snapshot'));const target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(tree)?.[1];assert.ok(target,tree);
  const words='MADEUPAGENT'.repeat(10);const refused=await r.route('browser_type',{target,text:words,element:'Reference',slowly:true},['allow_once']);
  assert.equal(refused.result.isError,true);assert.match(text(refused.result),/separate.*browser_click/);assert.equal(refused.cards.length,0);
  assert.equal(await r.page.locator('input').inputValue(),'');
  await r.raw(send=>send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Shift',code:'ShiftLeft',modifiers:8}));
  const reply=await r.route('browser_type',{target,text:words,element:'Reference'},['allow_once']);
  assert.match(text(reply.result),/Hand back|إعادة التحكم/);assert.equal(await r.page.locator('input').inputValue(),'');await blind(r);
 });
 if(host==='desktop')check('native credential driver replacement preserves every other tab lock',async r=>{
  await r.set('<input><h1>Clean first</h1>');const session=r.host.session;
  const firstId=session.bridge.targetIdOf(session.tabs[0].view.webContents);
  const other=await r.page.context().newPage();await other.goto(r.origin+'/other');
  const secondId=session.bridge.targetIdOf(session.tabs[1].view.webContents);
  r.host.holdPersonTab(session,session.tabs[0],lang);r.host.holdPersonTab(session,session.tabs[1],lang);
  const privacy=r.engine._privacy;r.host._protectNativeEntry(session,null);
  assert.equal(session.credentialDriverDetached,true);
  await r.host._humanTab('select',1);
  assert.equal((await r.host.control('hand_back')).ok,true);
  assert.equal(r.engine._privacy,privacy,'the new driver retains the session privacy owner');
  const first=await r.engine.resolveTarget(firstId),second=await r.engine.resolveTarget(secondId);
  assert.equal(r.engine._privacy.personMode(first.page),true);assert.equal(r.engine._privacy.personMode(second.page),false);
  assert.equal(session.tabs[0].personMode,lang);assert.equal(session.tabs[1].personMode,undefined);
 });
 check('Arabic strong labels stay sealed',async r=>{for(const label of ['الرقم السري','الآيبان','رمز المرور']){await r.set(`<input aria-label="${label}" value=MADEUP9876>`);assert.doesNotMatch(text(await r.call('browser_snapshot')),/MADEUP9876/);await r.page.evaluate(()=>document.querySelector('input').value='');await r.handBack()}});
}};
