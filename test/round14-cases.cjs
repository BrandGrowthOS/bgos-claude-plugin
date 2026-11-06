"use strict";
// Round 14 probes run unchanged on both real Chromium hosts. Invented values only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const text = r => (r?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
module.exports = (rig, host) => {
 for (const lang of ['en','ar']) {
  const check = (name, work) => test(`${host} ${lang} round14 ${name}`, {timeout:90000}, async t => {
   const r=await rig(t), set=r.set; r.set=html=>set(`<html lang=${lang}>${html}</html>`); await work(r,t);
  });
  check('P1 ordinary signup selects prefills search editors and 70 fields have zero cards', async r => {
   await r.set('<h1>Signup</h1><label>Country<select><option>Oman</option><option>UAE</option></select></label><select aria-label=Language><option>English</option><option>Arabic</option></select><label>View<select><option>Password summary</option><option>Credit card summary</option></select></label><input aria-label="Full name" value="Fixture Person"><input aria-label=Email value="fixture@example.invalid"><input type=search placeholder="Find products" value="running shoes"><div contenteditable>Meeting notes</div>'+Array.from({length:70},(_,i)=>`<input aria-label="Reference ${i}" value="ordinary${i}">`).join(''));
   const reply=await r.route('browser_snapshot',{},[]); assert.equal(reply.cards.length,0); assert.match(text(reply.result),/Signup|Meeting notes/); assert.match(text(reply.result),/ordinary69/);
   await r.page.locator('select').first().selectOption({label:'UAE'}); await r.page.locator('[contenteditable]').fill('Edited notes');
   assert.match(text(await r.call('browser_snapshot')),/Edited notes/); assert.equal(r.cards.length,0);
  });
  check('new SECRET words and every cc autocomplete seal before agent typing',async(r,t)=>{
   for(const attr of (lang==='ar'?['aria-label="كلمة السر"','aria-label="كلمة المرور"','aria-label="رقم البطاقة"','aria-label="رقم بطاقة الائتمان"']:['aria-label=PIN','aria-label=IBAN','aria-label="Credit card"']).concat(['autocomplete=cc-name','autocomplete=cc-exp-month','autocomplete=cc-type','autocomplete="section-pay billing cc-given-name"'])) await t.test(attr,async()=>{
    await r.set(`<input ${attr}>`); const first=await r.route('browser_snapshot',{},[]); const target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(text(first.result))?.[1]; assert.ok(target,text(first.result));
    await r.route('browser_type',{target,text:'MADEUP9876',element:'Field'},['allow_once']); assert.equal(await r.page.locator('input').inputValue(),'');
   });
  });
  for(const hop of ['meta','replace','post-password','post-api_key']) check(`P2 P4 ${hop} stays blind through every document until Hand back`,async(r,t)=>{
   const value='MADEUPSECRET9876';
   const server=createServer((req,res)=>{req.resume();res.setHeader('content-type','text/html; charset=utf-8');
    if(req.url.startsWith('/check') && hop==='meta')res.end('<meta http-equiv=refresh content="0;url=/done">');
    else if(req.url.startsWith('/check') && hop==='replace')res.end("<script>location.replace('/done')</script>");
    else res.end(`<html lang=${lang}><title>Hi ${value}</title><h1>Welcome ${value}</h1></html>`);
   }); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
   const origin=`http://127.0.0.1:${server.address().port}`;
   await r.set(`<form action=${origin}/${hop.startsWith('post')?'done':'check'} method=${hop.startsWith('post')?'post':'get'}><input name=${hop==='post-api_key'?'api_key':'customField'} ${hop==='post-api_key'?'aria-label="API key"':'type=password'}><button>Continue</button></form>`);
   await r.call('browser_snapshot');
   // No agent read between person input and navigation.
   await r.page.locator('input').fill(value); await Promise.all([r.page.waitForURL(origin+'/done'),r.page.locator('button').click()]);
   const blind=async()=>{for(const [name,args] of [['browser_snapshot',{}],['browser_tabs',{action:'list'}],['browser_take_screenshot',{}],['browser_find',{text:'Welcome'}]]){const reply=await r.call(name,args);assert.doesNotMatch(decodeURIComponent(text(reply)),/MADEUPSECRET9876|Welcome|Hi /,name);assert.equal((reply.content||[]).some(p=>p.type==='image'),false,name);}};
   await blind(); await r.set('<h1>Still private after another origin and document</h1>');
   assert.doesNotMatch(text(await r.call('browser_snapshot')),/Still private/);
   // The owner control route, never a tool or a timer, releases the tab.
   if(r.reconnect){await r.reconnect();assert.doesNotMatch(text(await r.call('browser_snapshot')),/Still private/,'driver reconnect cannot clear the tab lock');}
   await r.handBack(); assert.match(text(await r.call('browser_snapshot')),/Still private/);
  });
  check('Hand back releases an SPA sign-in but never a still-filled sealed field',async r=>{
   await r.set('<input type=password>');await r.call('browser_snapshot');await r.page.locator('input').fill('MADEUP-SPA9876');
   await r.page.evaluate(()=>{document.body.innerHTML='<h1>Finished in place</h1>';});
   assert.doesNotMatch(text(await r.call('browser_snapshot')),/Finished in place/);
   await r.handBack();assert.match(text(await r.call('browser_snapshot')),/Finished in place/);
   await r.page.evaluate(()=>{document.body.innerHTML='<input type=password value=MADEUP-NEXT9876>';});
   assert.doesNotMatch(text(await r.call('browser_snapshot')),/MADEUP-NEXT9876/);
   await r.handBack();const still=await r.call('browser_snapshot');assert.doesNotMatch(text(still),/MADEUP-NEXT9876/);assert.equal((still.content||[]).some(p=>p.type==='image'),false);
  });
  if(host==='desktop') check('Hand back clears only the selected physical tab after owner selection while held',async r=>{
   await r.set('<input type=password value=MADEUP9876>');await r.call('browser_snapshot');
   const session=r.host.session,firstId=session.bridge.targetIdOf(session.tabs[0].view.webContents);
   const arriving=r.page.context().waitForEvent('page');
   const other=await r.host._createTab(r.origin+'/second',{activate:false});
   session.bridge.addView(other.view.webContents);
   const secondId=await session.bridge.readyTargetId(other.view.webContents);
   await arriving;await other.view.webContents.loadURL(r.origin+'/second');
   const second=await r.engine.resolveTarget(secondId);await r.engine.inspectPrivacy(second);
   r.nextPage(`<html lang=${lang}><h1>Clean destination</h1></html>`);
   await r.page.goto(r.origin+'/clean-first');await second.page.goto(r.origin+'/clean-second');
   const first=await r.engine.resolveTarget(firstId);
   assert.equal((await r.engine.inspectPrivacy(first)).blocked,true);assert.equal((await r.engine.inspectPrivacy(second)).blocked,true);
   const context=await r.engine._toolsContext();await context.selectTab(context.tabs().findIndex(tab=>tab.page===first.page));
   r.host.control('take_over');await r.host._humanTab('select',1);
   assert.equal((await r.host.control('hand_back')).ok,true);await r.host._readyDriver(session);
   const reconnectedFirst=await r.engine.resolveTarget(firstId),reconnectedSecond=await r.engine.resolveTarget(secondId);
   assert.equal((await r.engine.inspectPrivacy(reconnectedFirst)).blocked,true,'the old driver tab stays blind');
   assert.equal((await r.engine.inspectPrivacy(reconnectedSecond)).blocked,false,'only the selected physical tab is handed back');
  });
  check('agent ordinary typing and person edits of ordinary controls never lock',async r=>{
   await r.set('<input aria-label="Other reference"><h1>Ordinary</h1>'); const first=text(await r.call('browser_snapshot')),target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(first)?.[1];
   await r.route('browser_type',{target,text:'MADEUP-AGENT9876',element:'Other reference'},['allow_once']);
   assert.match(text(await r.call('browser_snapshot')),/MADEUP-AGENT9876/);await r.page.locator('input').fill('MADEUP-PERSON9876');assert.match(text(await r.call('browser_snapshot')),/MADEUP-PERSON9876/);assert.equal(r.cards.length,0);
  });
 }
};
