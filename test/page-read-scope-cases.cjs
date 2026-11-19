"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const text=reply=>(reply.content||[]).filter(p=>p.type==="text").map(p=>p.text).join("\n");
module.exports=function register(rig,label){
  for(const lang of ["en","ar"])for(const privateActive of [true,false])test(`${label} ${lang} response stays with its page (${privateActive?"private":"public"})`,{timeout:60000},async t=>{
    const r=await rig(t,lang),boundary=r.privacy,active=r.pages[0],others=r.pages.slice(1),fake="FictionScope9876";
    const line=lang==="ar"?"هذا المتصفح خاص. أكمل هنا، ثم اضغط على إعادة التحكم لأتابع.":"This browser is private. Finish here, then press Hand back so I can carry on.";
    for(const p of r.pages)await boundary.read(p);
    if(!privateActive)for(const p of others)await p.evaluate(v=>{document.body.innerHTML=`<input type=password value=${v}><p>${v}</p>`;document.title=v;},fake);
    const states=[];
    for(const page of others){
      const utility=await page._connection.toImpl(page.mainFrame()).utilityContext(),injected=await utility.injectedScript(),original=injected.evaluate.bind(injected);
      let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
      injected.evaluate=async(...args)=>{const value=await original(...args);entered();await gate;return value;};
      states.push({page,injected,original,release,ready});
    }
    const originalRead=boundary.read.bind(boundary),pending=states.map(s=>originalRead(s.page));
    await Promise.all(states.map(s=>s.ready));
    if(privateActive)await active.evaluate(v=>document.body.innerHTML=`<h1>Public page</h1><input type=password value=${v}><p>${v}</p>`,fake);
    let count=0;
    boundary.read=async(page,options)=>{const facts=await originalRead(page,options);if(page===active&&count<states.length){const i=count++;states[i].release();await pending[i];}return facts;};
    try{
      const reply=await r.call("browser_snapshot",{}),out=text(reply);
      assert.ok(count>0,"another page completed a read inside the active request");
      assert.equal(out.includes(fake),false,"another page's words cannot cross the response boundary");
      if(privateActive)assert.equal(out===line,true,"the private response is the fixed handoff");
      else{assert.match(out,/Public page/);assert.equal(out===line,false,"a private background page cannot blind the public response");const listed=text(await r.call("browser_tabs",{action:"list"}));assert.equal(listed.includes(fake),false,"private tab metadata stays private");}
    }finally{boundary.read=originalRead;for(const s of states){s.release();s.injected.evaluate=s.original;}await Promise.allSettled(pending);}
  });
  for(const lang of ["en","ar"])test(`${label} ${lang} capture keeps its own document verdict`,{timeout:60000},async t=>{
    const r=await rig(t,lang),page=r.pages[0],boundary=r.privacy,original=boundary.read.bind(boundary),fake="FictionScope9876";
    const line=lang==="ar"?"هذا المتصفح خاص. أكمل هنا، ثم اضغط على إعادة التحكم لأتابع.":"This browser is private. Finish here, then press Hand back so I can carry on.";
    await page.evaluate(()=>document.body.innerHTML='<h1>Public page</h1><input id=p type=password><p id=echo></p>');
    let reads=0;
    boundary.read=async(target,options)=>{
      if(target===page&&++reads===2)await page.goto(page.url()+"?moved=1");
      const facts=await original(target,options);
      if(target===page&&reads===1)await page.evaluate(v=>{document.getElementById('p').value=v;document.getElementById('echo').textContent=v;},fake);
      return facts;
    };
    try{
      const reply=await r.callEngine("browser_snapshot",{});
      assert.ok(reads>=2,"the test entered the post-capture read");assert.match(page.url(),/moved=1/);
      assert.equal(text(reply)===line,true,"a new document cannot release words captured from a private document");
      assert.equal(text(reply).includes(fake),false);assert.doesNotMatch(text(reply),/hoai-private-|hoai-proof-/);
    }finally{boundary.read=original;}
    assert.equal(text(await r.callEngine("browser_snapshot",{})),line);boundary.handBack(page);
    assert.match(text(await r.callEngine("browser_snapshot",{})),/Public page/);
  });

};
