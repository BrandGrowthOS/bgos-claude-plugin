"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const LINE = "This browser is private. Finish here, then press Hand back so I can carry on.";
const text = r => (r?.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
const ref = (s, name) => new RegExp(`${name}[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(s)?.[1];
module.exports = function register(rig, host) {
  require("./page-routing-cases.cjs")(rig, host);
  require("./round12-cases.cjs")(rig, host);
  require("./round13-cases.cjs")(rig, host);
  for (const lang of ["en", "ar"]) {
    const LINE = lang === "ar" ? "هذا المتصفح خاص. أكمل هنا، ثم اضغط على إعادة التحكم لأتابع." : "This browser is private. Finish here, then press Hand back so I can carry on.";
    const localized = async t => { const r = await rig(t); const set = r.set; r.set = html => set(`<html lang=${lang}>${html}</html>`); return r; };
    const word = lang === "ar" ? "كلمة مرور" : "Password";
    const made = lang === "ar" ? "تجريبي٩٨٧٦" : "SAMPLE9876";
    const pages = [
      ["composed content", `<x-s>${made}</x-s><script>document.querySelector('x-s').attachShadow({mode:'open'}).innerHTML='<slot style="-webkit-text-security:disc"></slot>'</script>`],
      ["closed component", `<x-s></x-s><script>const s=document.querySelector('x-s').attachShadow({mode:'closed'});s.innerHTML='<input type=password value=${made}>';window.reveal=()=>s.querySelector('input').type='text'</script>`, true],
      ["typed continuity", `<input id=p type=password><p id=o></p>`, false, true],
      ["search privacy", `<input type=password value=${made}><p>${made}</p>`],
      ["replacement continuity", `<input id=p type=password value=4821><button id=b>Show</button><script>window.reveal=()=>{document.getElementById('p').outerHTML='<input value=4821>'}</script>`],
      ["card privacy", `<input type=password value=${made}><button>Delete ${made}</button>`],
      ["accessible names", `<input type=password aria-label=${made} placeholder=${made} value=${made}><span role=img style="-webkit-text-security:disc" aria-label=${made}>${made}</span>`],
      ["field recognition", `<span id=l>${word}</span><input aria-labelledby=l value=${made}>`],
      ["passphrase recognition", `<input name=passphrase value=${made}>`],
      ["time code recognition", `<input name=totp value=${made}>`],
      ["verification recognition", `<input aria-label="Verification code" value=${made}>`],
      ["identity recognition", `<input aria-label="Social security number" value=${made}>`],
      ["font recognition", `<input style="font-family:text-security-disc" value=${made}>`],
    ];
    for (const [label, html, closed, typed] of pages) test(`${host} ${lang} ${label}`, { timeout: 90000 }, async t => {
      const r = await localized(t); await r.set(`<html lang=${lang}><h1>Public heading</h1>${html}<button id=save>Save</button></html>`);
      if (typed) { await r.call("browser_snapshot"); await r.page.locator('#p').pressSequentially(made); }
      assert.equal(text(await r.call("browser_snapshot")), LINE);
      if (closed || label === "replacement continuity") await r.page.evaluate(() => window.reveal());
      for (const [tool, args] of [["browser_snapshot", {}], ["browser_find", {regex:made.slice(0,3)}], ["browser_find", {regex:"ZZZZZZ"}], ["browser_wait_for", {text:made.slice(0,3),time:0.01}], ["browser_wait_for", {text:"ZZZZZZ",time:0.01}], ["browser_take_screenshot", {}], ["browser_click", {target:"e2",element:"Delete"}], ["browser_fill_form", {fields:[{target:"e2",name:"Field",type:"textbox",value:"ok"}]}]]) {
        const result = await r.call(tool,args); assert.equal(text(result), LINE, tool); assert.equal(result.content.some(p=>p.type==='image'), false);
      }
      assert.equal(r.cards?.length || 0, 0, "no page words reach a gate");
      assert.equal(r.intentChecks?.length || 0, 0, "no private facts reach the intent model");
      await r.page.evaluate(() => { document.body.innerHTML='<h1>Changed in place</h1>'; history.pushState({},'', '#next'); });
      assert.equal(text(await r.call("browser_snapshot")), LINE, "same document stays private");
      assert.equal(text(await r.call('browser_find',{regex:'Public|'+made})),LINE);
      assert.equal(text(await r.call('browser_take_screenshot')),LINE);
      await r.set('<h1>Welcome back</h1><p>SAMPLE9876</p>');
      assert.equal(text(await r.call("browser_snapshot")), LINE); await r.handBack();
      assert.match(text(await r.call("browser_snapshot")), /Welcome back/);
    });
    test(`${host} ${lang} sealed reader remains a second wall`,{timeout:90000},async t=>{
      const r=await localized(t);
      for(const html of [`<input type=password placeholder=${made}>`, `<input type=password aria-label=${made} value=${made}>`, `<x-s>${made}</x-s><script>document.querySelector('x-s').attachShadow({mode:'open'}).innerHTML='<slot style="-webkit-text-security:disc"></slot>'</script>`, `<span role=img aria-label=${made} data-text=${made} style="-webkit-text-security:disc">${made}</span>`]) {
        await r.set(html);await r.call('browser_snapshot');
        const ctx=await r.page._connection.toImpl(r.page.mainFrame()).utilityContext();
        const injected=await ctx.injectedScript();
        const json=await injected.evaluate(i=>globalThis[Symbol.for('hoai.browser.answerPrivacy')].sealedSnapshot.call(i,document.body,{mode:'ai'}).json);
        assert.match(JSON.stringify(json),/hoai-proof-/); assert.equal(JSON.stringify(json).includes(made),false);
      }
    });
    test(`${host} ${lang} cached closed inventory refreshes`,{timeout:90000},async t=>{
      const r=await localized(t);await r.set('<h1>Public</h1><div id=c></div>');await r.call('browser_snapshot');await r.call('browser_snapshot');
      await r.page.evaluate(v=>document.getElementById('c').attachShadow({mode:'closed'}).innerHTML=`<input type=password value=${v}>`,made);
      assert.equal(text(await r.call('browser_snapshot')),LINE);
    });
    test(`${host} ${lang} large stable pages reuse the closed inventory`,{timeout:90000},async t=>{
      const r=await localized(t);await r.set('<h1>Rows</h1><table>'+Array.from({length:20000},(_,i)=>`<tr><td>Row ${i}</td></tr>`).join('')+'</table>');await r.call('browser_snapshot');
      const utility=await r.page._connection.toImpl(r.page.mainFrame()).utilityContext(); const client=utility.delegate._client;const send=client.send;let discoveries=0;
      client.send=function(method,...args){if(method==='DOM.getDocument')discoveries++;return send.call(this,method,...args)};
      try {for(let i=0;i<3;i++)assert.match(text(await r.call('browser_snapshot')),/Rows/);assert.ok(discoveries<=1,`${discoveries} full DOM discoveries`);}finally{client.send=send;}
    });
    test(`${host} ${lang} changed fields`, {timeout:90000}, async t=>{
      const r=await localized(t); await r.set('<style>.m{-webkit-text-security:disc}</style><div id=h></div>'); await r.call('browser_snapshot');
      await r.page.evaluate(v=>{ const i=document.createElement('input'); i.className='m';i.value=v;document.getElementById('h').append(i); },made);
      await r.page.waitForTimeout(30); await r.page.evaluate(()=>document.querySelector('input').className='');
      assert.equal(text(await r.call('browser_snapshot')), LINE);
      await r.set('<x-s></x-s>'); await r.call('browser_snapshot');
      await r.page.evaluate(v=>{document.querySelector('x-s').attachShadow({mode:'open'}).innerHTML=`<input type=password value=${v}>`;},made);
      await r.page.waitForTimeout(30); await r.page.evaluate(()=>document.querySelector('x-s').shadowRoot.querySelector('input').type='text');
      assert.equal(text(await r.call('browser_snapshot')), LINE);
    });
    for (const [label, controls, keys] of [
      ["submit spellings", ['<input id=q aria-label=Note>'], ['Enter','\n','\r','Shift+Enter']],
      ["form control submissions", ['<input id=q type=checkbox aria-label=Copy>', '<select id=q aria-label=Reason><option>Other</option></select>', '<textarea id=q aria-label=Message></textarea>', '<input id=q form=f aria-label=Query>'], ['Enter']],
    ]) test(`${host} ${lang} ${label}`, {timeout:90000}, async t=>{
      const r=await localized(t);
      for(const control of controls) {
        await r.set(`<form id=f onsubmit="document.title='submitted';return false">${control.includes('form=f')?'':control}</form>${control.includes('form=f')?control:''}<button form=f>Delete account</button>`);
        await r.route('browser_snapshot',{},['allow_once']);
        for(const key of keys) {
          await r.page.locator('#q').focus();const before=r.cards.length;const result=await r.call('browser_press_key',{key});
          assert.equal(result.isError,true,JSON.stringify({control,key,result}));assert.match(text(result),/separate.*browser_click/);assert.equal(r.cards.length,before);
          assert.notEqual(await r.page.title(),'submitted');
        }
      }
    });
    test(`${host} ${lang} formless search and message`,{timeout:90000},async t=>{
      const r=await localized(t);
      await r.set('<input id=q aria-label=Message>');await r.call('browser_snapshot');await r.page.locator('#q').focus();const message=await r.call('browser_press_key',{key:'Enter'});assert.equal(message.isError,true);assert.match(text(message),/separate.*browser_click/);
      await r.set('<input id=q role=combobox aria-label=Search onkeydown="if(event.key===\'Enter\')document.title=\'searched\'"><button onclick="document.title=\'searched\'">Find results</button>');
      const tree=text(await r.call('browser_snapshot'));await r.page.locator('#q').focus();
      const search=await r.call('browser_press_key',{key:'Enter'});assert.equal(search.isError,true);assert.match(text(search),/separate.*browser_click/);assert.notEqual(await r.page.title(),'searched');
      const clicked=await r.route('browser_click',{target:ref(tree,'Find results'),element:'Find results'},['allow_once']);assert.notEqual(clicked.result.isError,true,text(clicked.result));
      assert.equal(await r.page.title(),'searched');
    });
    test(`${host} ${lang} dialog words`, {timeout:90000}, async t=>{
      const r=await localized(t); const message=lang==='ar'?'هل أنت متأكد؟':'Are you sure?';
      await r.set(`<button onclick="confirm('${message}')">Open</button>`); const tree=text(await r.call('browser_snapshot'));
      await r.call('browser_click',{target:ref(tree,'Open'),element:'Open'});
      const result=await r.gate('browser_handle_dialog',{accept:true}); assert.equal(result.kind,'sensitive'); assert.ok(result.summary.includes(message),result.summary);
    });
    test(`${host} ${lang} unknown fields stay ordinary without cards`,{timeout:90000},async t=>{
      const r=await localized(t);await r.set('<input aria-label=Code value=4821><h1>Public</h1>');
      const first=await r.route('browser_snapshot',{},[]);assert.equal(first.cards.length,0);assert.match(text(first.result),/4821|Public/);
      await r.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input aria-label=Code value=9731>'));
      const next=await r.route('browser_snapshot',{},[]);assert.equal(next.cards.length,0);assert.match(text(next.result),/9731/);
    });
    test(`${host} ${lang} agent cannot fill a secret`,{timeout:90000},async t=>{
      const r=await localized(t);await r.set('<input aria-label=Note><input type=password aria-label=Access>');
      const tree=text(await r.call('browser_snapshot'));
      const targets=Array.from(tree.matchAll(/textbox[^\n]*?ref=((?:f\d+)?e\d+)/g),m=>m[1]);assert.equal(targets.length,2);
      await r.gate('browser_type',{target:targets[1],element:'Access',text:made},'allow_once');
      assert.equal(await r.page.locator('input[type=password]').inputValue(),'');
      await r.gate('browser_fill_form',{fields:[{target:targets[0],name:'Note',type:'textbox',value:'ordinary'},{target:targets[1],name:'Access',type:'textbox',value:made}]},'allow_once');
      assert.equal(await r.page.locator('input').first().inputValue(),'');assert.equal(await r.page.locator('input[type=password]').inputValue(),'');
      await r.page.locator('input[type=password]').focus();await r.gate('browser_press_key',{key:'x'},'allow_once');
      assert.equal(await r.page.locator('input[type=password]').inputValue(),'');
      await r.set('<div id=c></div><script>const s=document.getElementById("c").attachShadow({mode:"closed"});s.innerHTML="<input type=password>";window.secretBox=s.querySelector("input");secretBox.focus()</script>');
      await r.call('browser_snapshot');await r.gate('browser_press_key',{key:'x'},'allow_once');
      assert.equal(await r.page.evaluate(()=>window.secretBox.value),'');
    });
    test(`${host} ${lang} site navigation retains only complete final values`,{timeout:90000},async t=>{
      const r=await localized(t);await r.set('<input id=p type=password name=customField>');await r.call('browser_snapshot');
      await r.page.locator('#p').pressSequentially('Welcome1!');assert.equal(text(await r.call('browser_snapshot')),LINE);
      await r.set('<h1>Welcome back</h1><button>Delete Welcome1!</button>');
      assert.equal(text(await r.call('browser_snapshot')),LINE);await r.handBack();
      const tree=text(await r.call('browser_snapshot'));assert.match(tree,/Welcome back/);assert.doesNotMatch(tree,/Welcome1!/);
      const card=await r.gate('browser_click',{target:ref(tree,'Delete'),element:'button'});assert.doesNotMatch(card.summary||'',/Welcome1!/);
    });
    test(`${host} ${lang} ordinary fields and person typing`, {timeout:90000},async t=>{
      const r=await localized(t); await r.set('<input aria-label="Postal address"><input aria-label="Token name"><input aria-label="Recovery email"><input aria-label="Max tokens"><input aria-label="Code"><input type=password aria-label="Password">');
      const tree=text(await r.call('browser_snapshot'));
      await r.page.locator('input[aria-label=Code]').focus();await r.call('browser_press_key',{key:'x'});
      assert.match(text(await r.call('browser_snapshot')),/Code/);
      for(const name of ['Postal address','Token name','Recovery email','Max tokens','Code']) {
        const answer=await r.call('browser_type',{target:ref(tree,name),element:name,text:made}); assert.doesNotMatch(text(answer), /Protected|password is on|permission/i);
      }
      assert.match(text(await r.call('browser_snapshot')),new RegExp(made));
      await r.call('browser_type',{target:ref(tree,'Password'),element:'Password',text:made});
      assert.equal(await r.page.locator('input[type=password]').inputValue(),'');
      await r.page.locator('input[type=password]').pressSequentially(made);
      assert.equal(text(await r.call('browser_snapshot')),LINE);
      await r.page.locator('input[type=password]').fill(''); assert.equal(text(await r.call('browser_snapshot')),LINE);
      await r.set('<h1>Welcome back</h1>'); assert.equal(text(await r.call('browser_snapshot')),LINE);await r.handBack(); assert.match(text(await r.call('browser_snapshot')),/Welcome back/);
    });
  }
};
