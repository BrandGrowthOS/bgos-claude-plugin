"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const text=r=>(r?.content||[]).filter(p=>p.type==="text").map(p=>p.text).join("\n");
module.exports=(rig,host)=>{
 for(const language of ["en","ar"]){
  const reload=language==="ar"?/إعادة تحميل/:/reload/i;
  const using=language==="ar"?/يستخدم الشخص/:/The person is using/;
  const check=(name,work)=>test(`${host} ${language} round18 ${name}`,{timeout:60000},async t=>{
   const r=await rig(t),set=r.set;r.set=html=>set(`<html lang=${language}>${html}</html>`);
   r.capture=async phase=>{
    if(!process.env.BROWSER18_EVIDENCE_DIR)return;
    const reply=text(await r.call("browser_snapshot"));
    await r.page.evaluate(reply=>{const p=document.createElement("pre");p.id="proof18";p.textContent=reply;p.style="position:fixed;inset:0 0 auto;background:#153b30;color:white;padding:24px;z-index:2147483647;white-space:pre-wrap";document.documentElement.append(p)},reply);
    try{const shot=await r.raw(send=>send("Page.captureScreenshot",{format:"png"}));fs.writeFileSync(path.join(process.env.BROWSER18_EVIDENCE_DIR,`${host}-${language}-${name.replace(/[^a-z0-9]+/gi,"-")}-${phase}.png`),Buffer.from(shot.data,"base64"));}
    finally{await r.page.evaluate(()=>document.getElementById("proof18")?.remove())}
   };
   await work(r);
  });
  const unavailable=async r=>{
   for(const name of ["browser_snapshot","browser_take_screenshot","browser_tabs"]){
    const result=await r.call(name,name==="browser_tabs"?{action:"list"}:{});
    assert.match(text(result),reload);assert.doesNotMatch(text(result),using);assert.doesNotMatch(text(result),/MADEUP/);assert.equal(result.content?.some(p=>p.type==="image"),false);
   }
   assert.equal(r.engine._privacy.personMode(r.page),false,"failed proof is not person input");
   const state=await r.engine._privacy.forPage(r.page,()=>r.engine._privacy.privacyState());
   assert.equal(state.reloadRequired,true);assert.equal(state.blocked,true);
   if(r.host)assert.equal(r.host.getState().session.reloadRequired,true,"the actual desktop state offers Reload");
  };
  const typed=async r=>{
   await r.person('document.querySelector("input").focus()');
   const result=await r.call("browser_snapshot");assert.match(text(result),using);assert.doesNotMatch(text(result),/MADEUP/);assert.equal(r.engine._privacy.personMode(r.page),true);
   const url=r.page.url();await r.call("browser_navigate",{url});assert.equal(r.page.url(),url);assert.equal(r.engine._privacy.personMode(r.page),true);
   await r.capture("person-held");
  };
  const recover=async r=>{
   await unavailable(r);await r.capture("reload-required");
   // Hand back must not claim to repair a failed order proof.
   const hb=await r.handBack();assert.notEqual(hb?.ok,true);assert.equal(hb?.reason,"reload_required");await unavailable(r);
   const denied=await r.route("browser_navigate",{url:r.page.url()},["deny"]);
   assert.equal(denied.cards.length,1);assert.match(denied.cards[0].summary,reload);await unavailable(r);
   r.nextPage(`<html lang=${language}><h1>Public after reload</h1><input aria-label=Reference></html>`);
   const accepted=await r.route("browser_navigate",{url:r.page.url()},["allow_once"]);
   assert.equal(accepted.cards.length,1);assert.match(accepted.cards[0].summary,reload);
   assert.match(text(await r.call("browser_snapshot")),/Public after reload/);
   assert.equal(r.engine._privacy.personMode(r.page),false);await r.capture("readable");await typed(r);
  };
  for(const type of ["keydown","input"])check(`DOCOPEN-BENIGN ${type} recovers through gated reload`,async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(({type,language})=>{document.open();document.write(`<html lang=${language}><h1>Public rewritten</h1><input><script>window.addEventListener('${type}',()=>{},true)<`+`/script></html>`);document.close()},{type,language});
   await recover(r);
  });
  check("a fragment URL reload replaces the document",async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(language=>{history.replaceState(null,"","#section");document.open();document.write(`<html lang=${language}><h1>Public</h1><input><script>window.addEventListener('keydown',()=>{},true)<`+`/script></html>`);document.close()},language);
   await recover(r);
  });
  check("ADFRAME recovers through gated reload",async r=>{
   await r.set('<h1>Public</h1><input><iframe></iframe>');
   await r.page.evaluate(language=>{const d=document.querySelector("iframe").contentDocument;d.open();d.write(`<html lang=${language}><input><script>window.addEventListener('input',()=>{},true)<`+`/script></html>`);d.close()},language);
   await recover(r);
  });
  check("stopImmediatePropagation never releases typed text",async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(language=>{document.open();document.write(`<html lang=${language}><h1>Public</h1><input><script>for(const t of ['keydown','keypress','keyup','beforeinput','input'])window.addEventListener(t,e=>e.stopImmediatePropagation(),true)<`+`/script></html>`);document.close()},language);
   await unavailable(r);await r.person('document.querySelector("input").focus()');
   assert.match(await r.page.locator("input").inputValue(),/MADEUP/);
   for(const name of ["browser_snapshot","browser_take_screenshot","browser_tabs"]){const result=await r.call(name,name==="browser_tabs"?{action:"list"}:{});assert.doesNotMatch(text(result),/MADEUP/);assert.equal(result.content?.some(p=>p.type==="image"),false)}
   await r.capture("blocked-person-text");
  });
  check("person input interrupts an approved reload before native dispatch",async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(language=>{document.open();document.write(`<html lang=${language}><h1>Public</h1><input><script>window.addEventListener('keydown',()=>{},true)<`+`/script></html>`);document.close()},language);
   await unavailable(r);
   r.nextPage(`<html lang=${language}><h1>AFTER-AGENT-RELOAD</h1><input></html>`);
   const client=r.page._connection.toImpl(r.page).delegate._mainFrameSession._client,send=client.send;
   let raced=false;
   client.send=async(method,...args)=>{
    if(method==="Page.reload"){
     raced=true;await r.person('document.querySelector("input").focus()');
     for(let i=0;i<25&&!r.engine._privacy.personMode(r.page);i++)await new Promise(resolve=>setTimeout(resolve,4));
     assert.equal(r.engine._privacy.personMode(r.page),true);
    }
    return send.call(client,method,...args);
   };
   let result;
   try{result=await r.route("browser_navigate",{url:r.page.url()},["allow_once"])}finally{client.send=send}
   assert.equal(raced,true,"the person interrupted the actual native reload dispatch");
   assert.equal(result.cards.length,1);
   assert.match(await r.page.locator("input").inputValue(),/MADEUP/);
   assert.match(text(result.result),using);assert.doesNotMatch(text(result.result),/MADEUP/);
   await r.capture("reload-interrupted-by-person");
  });
  check("removed blocker child cannot release its echo or metadata",async r=>{
   await r.set('<h1>Public</h1><p></p><iframe></iframe>');
   await r.page.evaluate(language=>{const d=document.querySelector("iframe").contentDocument;d.open();d.write(`<html lang=${language}><input><script>window.addEventListener('beforeinput',e=>e.stopImmediatePropagation(),true);window.addEventListener('input',e=>{e.stopImmediatePropagation();parent.document.querySelector('p').textContent=e.target.value;frameElement.remove()},true)<`+`/script></html>`);d.close()},language);
   await unavailable(r);
   await r.person('document.querySelector("iframe").contentDocument.querySelector("input").focus()');
   await r.page.waitForFunction(()=>!document.querySelector("iframe"));
   await r.page.evaluate(()=>{document.title="MADEUP-ECHO9876";history.replaceState(null,"","?q=MADEUP-ECHO9876")});
   await unavailable(r);await r.capture("removed-child-withheld");
   if(r.reconnect){await r.reconnect();await unavailable(r)}
  });
  check("a page navigation cannot clear an unapproved reload hold",async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(language=>{document.open();document.write(`<html lang=${language}><input><script>window.addEventListener('keydown',()=>{},true)<`+`/script></html>`);document.close()},language);
   await unavailable(r);
   r.nextPage(`<html lang=${language}><h1>MADEUP-REDIRECT9876</h1><input></html>`);
   await r.page.goto(r.origin+"/page-redirect");
   await unavailable(r);await r.capture("page-redirect-withheld");
   await recover(r);
  });
  check("same-document rewrite cannot clear the reload requirement",async r=>{
   await r.set('<h1>Public</h1><input>');
   await r.page.evaluate(language=>{document.open();document.write(`<html lang=${language}><input><script>window.addEventListener('keydown',()=>{},true)<`+`/script></html>`);document.close()},language);
   await unavailable(r);
   await r.page.evaluate(language=>{document.open();document.write(`<html lang=${language}><h1>MADEUP-ECHO9876</h1></html>`);document.close()},language);
   await unavailable(r);await r.capture("rewritten-withheld");
  });
  check("a rejected agent dialog answer never covers an external answer",async r=>{
   await r.set('<h1>Public</h1><button onclick="document.querySelector(\'p\').textContent=prompt(\'Membership number\')">Answer</button><p></p>');
   await r.raw(async send=>{
    await send("Page.enable");await send("Runtime.evaluate",{expression:'setTimeout(()=>document.querySelector("button").click(),0)'});
    await new Promise(resolve=>setTimeout(resolve,80));
    const client=r.page._connection.toImpl(r.page).delegate._mainFrameSession._client;
    await assert.rejects(r.engine._privacy.agentAction(r.page,()=>client.send("Page.handleJavaScriptDialog",{accept:"invalid",promptText:"MADEUP-AGENT9876"})));
    await send("Page.handleJavaScriptDialog",{accept:true,promptText:"MADEUP-EXTERNAL9876"});
   });
   assert.match(text(await r.call("browser_snapshot")),using);assert.doesNotMatch(text(await r.call("browser_snapshot")),/MADEUP/);await r.capture("rejected-agent-answer-held");
  });
  check("an externally accepted prompt holds person text",async r=>{
   await r.set('<h1>Public</h1><button onclick="document.querySelector(\'p\').textContent=\'Saved \'+prompt(\'Membership number\')">Answer</button><p></p>');
   await r.raw(async send=>{await send("Page.enable");await send("Runtime.evaluate",{expression:'setTimeout(()=>document.querySelector("button").click(),0)'});await new Promise(resolve=>setTimeout(resolve,80));await send("Page.handleJavaScriptDialog",{accept:true,promptText:"MADEUP-PROMPT9876"})});
   await r.page.waitForFunction(()=>document.querySelector("p").textContent.includes("MADEUP"));
   assert.match(text(await r.call("browser_snapshot")),using);assert.equal(r.engine._privacy.personMode(r.page),true);assert.doesNotMatch(text(await r.call("browser_snapshot")),/MADEUP/);await r.capture("prompt-held");
  });
  check("agent prompt answers remain gated and readable",async r=>{
   await r.set('<h1>Public</h1><button onclick="document.querySelector(\'p\').textContent=\'Saved \'+prompt(\'Membership number\')">Answer</button><p></p>');
   const result=await r.raw(async send=>{
    await send("Runtime.evaluate",{expression:'setTimeout(()=>document.querySelector("button").click(),0)'});
    await new Promise(resolve=>setTimeout(resolve,80));return r.route("browser_handle_dialog",{accept:true,promptText:"MADEUP-AGENT9876"},["allow_once"]);
   });
   assert.equal(result.cards.length,1);assert.equal(r.engine._privacy.personMode(r.page),false);assert.match(text(await r.call("browser_snapshot")),/MADEUP-AGENT9876/);await r.capture("agent-prompt-readable");
  });
 }
};
