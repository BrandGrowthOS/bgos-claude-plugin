"use strict";
const {test}=require('node:test');
const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const text=r=>(r?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
module.exports=(rig,host)=>{for(const lang of ['en','ar']){
 const check=(name,work)=>test(`${host} ${lang} round16 ${name}`,{timeout:60000},async t=>{const r=await rig(t),set=r.set;r.set=html=>set(`<html lang=${lang}>${html}</html>`);await work(r,t);
  if(process.env.BROWSER16_EVIDENCE_DIR){
   const fs=require('node:fs'),path=require('node:path');const reply=text(await r.call('browser_snapshot'));
   await r.page.evaluate(({reply,lang})=>{const note=document.createElement('pre');note.textContent=(lang==='ar'?'إجابة الأداة: ':'Tool reply: ')+reply+(Array.isArray(globalThis.stamps)?'\n'+(lang==='ar'?'أوقات المفاتيح: ':'Key times: ')+globalThis.stamps.map(stamp=>new Date(stamp).toISOString()).join(', '):'');note.style='position:fixed;top:0;right:0;left:0;z-index:2147483647;background:#163b2d;color:white;padding:16px;white-space:pre-wrap;font:16px sans-serif';document.documentElement.append(note)},{reply,lang});
   const file=path.join(process.env.BROWSER16_EVIDENCE_DIR,`${host}-${lang}-${name.replace(/[^a-z0-9]+/gi,'-')}.png`);fs.mkdirSync(path.dirname(file),{recursive:true});const picture=await r.raw(send=>send('Page.captureScreenshot',{format:'png'}));fs.writeFileSync(file,Buffer.from(picture.data,'base64'));
  }
 });
 const blind=async r=>{for(const [name,args] of [['browser_snapshot',{}],['browser_tabs',{action:'list'}],['browser_take_screenshot',{}]]){const reply=await r.call(name,args);assert.doesNotMatch(text(reply),/MADEUP/);assert.equal(reply.content?.some(p=>p.type==='image'),false);assert.match(text(reply),/Hand back|إعادة التحكم/)}assert.equal(r.engine._privacy.personMode(r.page),true)};
 check('document.open re-arms before trusted person text and a POST echo',async (r,t)=>{
  let received='';const destination=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{if(req.method==='POST')received=body;res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html lang=${lang}><title>${body}</title><h1>${body}</h1></html>`);});});
  await new Promise(resolve=>destination.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>destination.close(resolve)));
  const endpoint=`http://127.0.0.1:${destination.address().port}/saved`;
  await r.set('<h1>Public</h1>');
  for(let i=0;i<2;i++){
   await r.page.evaluate(({language,endpoint})=>{document.open();document.write(`<html lang=${language}><form action="${endpoint}" method=post><input name=member aria-label=Membership><button>Save</button></form></html>`);document.close()},{language:lang,endpoint});
   await r.person('document.querySelector("input").focus()');
   await Promise.all([r.page.waitForURL(endpoint),r.page.evaluate(()=>document.querySelector('form').requestSubmit())]);
   assert.match(received,/MADEUP-PERSON9876/);
   await blind(r);if(i===0){await r.handBack();await r.set('<h1>Public again</h1>')}
  }
 });
 check('blank iframe editor document.write and nested replacement lock the physical tab',async r=>{
  await r.set('<h1>Public</h1><iframe></iframe>');
  await r.page.evaluate(language=>{const d=document.querySelector('iframe').contentDocument;d.open();d.write(`<html lang=${language}><iframe></iframe></html>`);d.close();const nested=d.querySelector('iframe').contentDocument;nested.open();nested.write(`<html lang=${language}><body contenteditable=true></body></html>`);nested.close()},lang);
  await r.person('document.querySelector("iframe").contentDocument.querySelector("iframe").contentDocument.body.focus()');
  await blind(r);
 });
 for(const kind of ['checkbox','radio'])check(`agent ${kind} click stays readable then person key locks`,async r=>{
  await r.set(`<h1>Public</h1><label><input type=${kind}>Choice</label>`);
  const tree=text(await r.call('browser_snapshot')),target=new RegExp(`${kind}[^\\n]*ref=((?:f\\d+)?e\\d+)`).exec(tree)?.[1];assert.ok(target,tree);
  const reply=await r.route('browser_click',{target,element:'Choice'},['allow_once']);assert.doesNotMatch(text(reply.result),/Hand back|إعادة التحكم/);
  assert.equal(await r.page.locator('input').isChecked(),true);assert.match(text(await r.call('browser_snapshot')),/Public/);
  await r.raw(send=>send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Shift',code:'ShiftLeft'}));await blind(r);
 });
 check('page execCommand and agent editor button do not impersonate a person',async r=>{
  await r.set('<h1>Public</h1><div contenteditable=true></div><button onclick="document.querySelector(\'div\').focus();document.execCommand(\'insertText\',false,\'MADEUP-SCRIPT\')">Signature</button>');
  await r.page.evaluate(()=>{document.querySelector('div').focus();document.execCommand('insertText',false,'MADEUP-SCRIPT')});
  let tree=text(await r.call('browser_snapshot'));assert.match(tree,/Public/);assert.equal(r.engine._privacy.personMode(r.page),false);
  const target=/button[^\n]*ref=((?:f\d+)?e\d+)/.exec(tree)?.[1];assert.ok(target,tree);
  await r.route('browser_click',{target,element:'Signature'},['allow_once']);assert.match(text(await r.call('browser_snapshot')),/Public/);
  await r.person('document.querySelector("div").focus()');await blind(r);
 });
 check('slow agent text and editing keys complete and synthetic events stay ordinary',async r=>{
  await r.set('<h1>Public</h1><input aria-label=Reference>');const tree=text(await r.call('browser_snapshot')),target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(tree)?.[1];assert.ok(target);
  await r.route('browser_type',{target,element:'Reference',text:'ATLAS',slowly:true},['allow_once']);assert.equal(await r.page.locator('input').inputValue(),'ATLAS');
  await r.page.evaluate(()=>{const e=document.querySelector('input');for(const type of ['keydown','paste','drop','beforeinput','input'])e.dispatchEvent(new Event(type,{bubbles:true}))});
  assert.match(text(await r.call('browser_snapshot')),/ATLAS/);for(const key of ['Backspace','Home','Delete'])await r.route('browser_press_key',{key},['allow_once']);assert.equal(await r.page.locator('input').inputValue(),'TLA');assert.match(text(await r.call('browser_snapshot')),/TLA/);await r.person('document.querySelector("input").focus()');await blind(r);
 });
 check('closing a different person tab by index is refused',async r=>{
  await r.set('<input><h1>Public</h1>');const personPage=r.page;
  await r.call('browser_tabs',{action:'new',url:r.origin+'/agent'});
  await r.person('document.querySelector("input").focus()',personPage);
  const reply=await r.route('browser_tabs',{action:'close',index:0},['allow_once']);
  assert.equal(personPage.isClosed(),false,text(reply.result));assert.equal(reply.cards.length,0,'no card can release person mode');
 });
 check('agent keys use current advancing timestamps',async r=>{
  await r.set('<input><h1>Public</h1>');await r.page.evaluate(()=>{globalThis.stamps=[];addEventListener('keydown',e=>stamps.push(e.timeStamp+performance.timeOrigin))});
  for(let i=0;i<2;i++){await r.route('browser_press_key',{key:'ArrowLeft'},['allow_once']);await new Promise(resolve=>setTimeout(resolve,12))}
  const stamps=await r.page.evaluate(()=>stamps);assert.equal(stamps.length,2);for(const stamp of stamps)assert.ok(Math.abs(stamp-Date.now())<5000,`current timing: ${stamp}`);assert.ok(stamps[1]>stamps[0]);
  assert.match(text(await r.call('browser_snapshot')),/Public/);
 });
 check('punctuated PIN and Arabic secret descriptions seal prefilled values',async r=>{
  for(const label of ['PIN:','PIN*','(PIN)','Card PIN code','ATM PIN code','رقم التعريف الشخصي','الرمز السري','رقم الحساب المصرفي الدولي']){
   await r.set(`<input aria-label="${label}" value=MADEUP9876>`);assert.doesNotMatch(text(await r.call('browser_snapshot')),/MADEUP/,label);
   if(label!=='رقم الحساب المصرفي الدولي'){await r.page.evaluate(()=>document.querySelector('input').value='');await r.handBack()}
  }
 });
}};
