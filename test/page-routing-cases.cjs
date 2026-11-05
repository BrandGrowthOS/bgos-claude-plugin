"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const text=r=>(r?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
const ref=(s,name)=>new RegExp(`${name}[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(s)?.[1];
module.exports=(rig,host)=>{
 for(const lang of ['en','ar']){
  const LINE=lang==='ar'?'توجد كلمة مرور في هذه الصفحة. أكملها هنا، وسأتابع عندما تتغير الصفحة.':'A password is on this page. You finish it here, and I will carry on when the page changes.';
  const value=lang==='ar'?'تجريبي٩٨٧٦':'SAMPLE9876';
  const local=async t=>{const r=await rig(t),set=r.set;r.set=html=>set(`<html lang=${lang}>${html}</html>`);return r;};
  const check=(label,work)=>test(`${host} ${lang} round11 ${label}`,{timeout:90000},async t=>work(await local(t),t));
  check('1 schemes and unknown tools never run',async r=>{
   for(const locked of [false,true]){
    await r.set(`<h1>Public</h1>${locked?`<input type=password value=${value}>`:''}`);await r.call('browser_snapshot');
    const original=r.page.url();
    for(const url of ['javascript:document.title="STOLEN";void 0','javascript:"<h1>REWRITE</h1>"','data:text/html,<h1>REWRITE</h1>','file:///fake','about:blank','madeup:secret']){
     const reply=await r.route('browser_navigate',{url},['allow_once']);
     assert.equal(r.page.url(),original,url);assert.notEqual(await r.page.title(),'STOLEN');assert.equal(reply.cards.length,0,url);
    }
    await r.call('browser_unknown',{url:'javascript:document.title="STOLEN"'});assert.equal(r.page.url(),original);
   }
  });
  check('2 privacy answer still asks about deleting',async r=>{
   await r.set('<input aria-label=Code><button onclick="document.title=\'DELETED\'">Delete account</button>');
   const tree=text(await r.call('browser_snapshot'));await r.page.locator('input').fill('4821');
   const {cards}=await r.route('browser_click',{target:ref(tree,'Delete account'),element:'Open'},['allow_once','deny']);
   assert.equal(cards.length,2,JSON.stringify(cards));assert.equal(cards[0].kind,'credential');assert.equal(cards[1].kind,'sensitive');assert.match(cards[1].summary,/Delete account/);assert.notEqual(await r.page.title(),'DELETED');
  });
  check('3 failed closed inspection refuses a tree and retries',async r=>{
   r.engine._privacy.busy=true;
   await r.set(`<h1>Public heading</h1><x-box></x-box><script>document.querySelector('x-box').attachShadow({mode:'closed'}).innerHTML='<input type=password value=${value}>'</script>`);
   const utility=await r.page._connection.toImpl(r.page.mainFrame()).utilityContext(),client=utility.delegate._client,send=client.send;
   client.send=function(method,...args){if(method==='DOM.getDocument')throw new Error('injected inventory failure');return send.call(this,method,...args)};
   try{assert.doesNotMatch(text(await r.call('browser_snapshot')),/Public heading/);}finally{client.send=send;}
   assert.equal(text(await r.call('browser_snapshot')),LINE);
  });
  check('3 overlapping inspections share their inventory',async r=>{
   r.engine._privacy.busy=true;
   await r.set(`<h1>Public heading</h1><x-box></x-box><script>document.querySelector('x-box').attachShadow({mode:'closed'}).innerHTML='<input type=password value=${value}>'</script>`);
   const utility=await r.page._connection.toImpl(r.page.mainFrame()).utilityContext(),client=utility.delegate._client,send=client.send;
   let entered;const start=new Promise(resolve=>entered=resolve);let release;const hold=new Promise(resolve=>release=resolve);
   client.send=async function(method,...args){if(method==='DOM.getDocument'){entered();await hold;}return send.call(this,method,...args)};
   try{
    const first=r.engine.inspectPrivacy();await start;
    const second=r.call('browser_snapshot');await new Promise(resolve=>setTimeout(resolve,100));release();
    await first;assert.equal(text(await second),LINE);
   }finally{release();client.send=send;}
  });
  check('4 locked navigation requires a card and succeeds once',async r=>{
   await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');
   const old=r.page.url(),url=old.replace(/\/[^/]*$/,'/escaped');
   const denied=await r.route('browser_navigate',{url},['deny']);assert.equal(r.page.url(),old);assert.equal(denied.cards.length,1);assert.equal(denied.cards[0].kind,'sensitive','the native card must render the discard warning');assert.match(denied.cards[0].summary,lang==='ar'?/التخلي/:/discard/);
   r.nextPage(`<html lang=${lang}><h1>Welcome back</h1></html>`);
   const allowed=await r.route('browser_navigate',{url},['allow_once']);assert.equal(r.page.url(),url,JSON.stringify(allowed));assert.equal(allowed.cards.length,1);assert.notEqual(allowed.result.isError,true,'14 a completed move reports success '+JSON.stringify(allowed.result));assert.match(text(await r.call('browser_snapshot')),/Welcome back/);
  });
  check('4 back navigation asks before a real new document',async r=>{
   await r.set('<h1>First</h1>');const first=r.page.url();await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');
   const denied=await r.route('browser_navigate_back',{},['deny']);assert.equal(denied.cards.length,1);assert.notEqual(r.page.url(),first);
   r.nextPage(`<html lang=${lang}><h1>Welcome back</h1></html>`);
   const allowed=await r.route('browser_navigate_back',{},['allow_once']);assert.equal(allowed.cards.length,1);assert.equal(r.page.url(),first,JSON.stringify(allowed));assert.match(text(await r.call('browser_snapshot')),/Welcome back/);
  });
  if(host==='machine')check('14 successful departure reports success',async r=>{
   await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');const url=r.page.url().replace(/\/[^/]*$/,'/after');r.nextPage(`<html lang=${lang}><h1>Welcome</h1></html>`);
   const reply=await r.route('browser_navigate',{url},['allow_once']);assert.equal(r.page.url(),url);assert.notEqual(reply.result.isError,true);assert.doesNotMatch(text(reply.result),/failed/i);
  });
  check('4 same document and tab tricks cannot discard the lock',async r=>{
   await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');const old=r.page.url();
   for(const [name,args] of [['browser_navigate',{url:old+'#next'}],['browser_tabs',{action:'new'}],['browser_tabs',{action:'select',index:0}],['browser_resize',{width:900,height:700}]]){
    const result=await r.route(name,args,['allow_once']);assert.equal(r.page.url(),old);assert.equal(result.cards.length,0);assert.equal(text(result.result),LINE);
   }
  });
  check('5 locked dialogs go to the person then close works',async r=>{
   await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');
   await r.page.evaluate(()=>{setTimeout(()=>confirm('PRIVATE DIALOG'),0)});await new Promise(resolve=>setTimeout(resolve,80));
   const denied=await r.route('browser_handle_dialog',{accept:true},['deny']);assert.equal(denied.cards.length,1);assert.doesNotMatch(JSON.stringify(denied.cards),/PRIVATE DIALOG/);
   const allowed=await r.route('browser_handle_dialog',{accept:false},['allow_once']);assert.equal(allowed.cards.length,1);
   const closed=await r.route('browser_close',{},[]);assert.ok((r.isClosed?r.isClosed():r.page.isClosed()),text(closed.result));
  });
  check('6 unreadable page can navigate with permission',async r=>{
   await r.set('<h1>Stuck</h1>');await r.call('browser_snapshot');const old=r.page.url();
   await r.page.evaluate(()=>{setTimeout(()=>{for(;;){}},20)});await new Promise(resolve=>setTimeout(resolve,80));
   const reply=await r.route('browser_navigate',{url:old.replace(/\/[^/]*$/,'/rescue')},['allow_once']);assert.notEqual(r.page.url(),old,JSON.stringify(reply));
  });
  check('6 stuck page always closes',async r=>{
   await r.set('<h1>Stuck</h1>');await r.call('browser_snapshot');
   await r.page.evaluate(()=>{setTimeout(()=>{for(;;){}},20)});await new Promise(resolve=>setTimeout(resolve,80));
   await r.route('browser_close',{},[]);assert.ok((r.isClosed?r.isClosed():r.page.isClosed()));
  });
  check('7 keys cannot write through an unreadable frame focus',async r=>{
   await r.set('<iframe srcdoc="<input type=password id=p>"></iframe>');await r.call('browser_snapshot');const box=r.page.frames()[1].locator('#p');await box.focus();
   await r.route('browser_press_key',{key:'x'},['allow_once']);assert.equal(await box.inputValue(),'');
  });
  check('7 drag and drop cannot write a secret',async r=>{
   await r.set('<button draggable=true ondragstart="event.dataTransfer.setData(\'text/plain\',\'DRAGME\')">Drag text</button><input type=password aria-label=Access>');
   const tree=text(await r.call('browser_snapshot')),to=/textbox[^\n]*?ref=((?:f\d+)?e\d+)/.exec(tree)?.[1];assert.ok(to,tree);
   for(const [name,args] of [['browser_drag',{startTarget:ref(tree,'Drag text'),endTarget:to,startElement:'Drag text',endElement:'Access'}],['browser_drop',{target:to,element:'Access',data:{'text/plain':'DRAGME'}}]]){
    const answer=await r.route(name,args,['allow_once']);assert.equal(await r.page.locator('input').inputValue(),'');assert.equal(answer.cards.length,0,name+JSON.stringify(answer));
   }
  });
  if(host==='desktop')check('8 approval bypass cannot answer privacy',async r=>{
   await r.set('<input aria-label=Pin value=4821>');r.host.session.approvalBypass=true;
   const reply=await r.route('browser_snapshot',{},['deny']);assert.equal(reply.cards.length,1);assert.doesNotMatch(text(reply.result),/4821/);
  });
  check('9 cross origin GET secrets never appear in addresses',async(r,t)=>{
   const other=createServer((_q,res)=>{res.setHeader('content-type','text/html');res.end(`<html lang=${lang}><h1>Welcome</h1></html>`)});await new Promise(resolve=>other.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>other.close(resolve)));
   const origin=`http://127.0.0.1:${other.address().port}`;
   await r.set(`<form action=${origin}/echo method=get><input id=p type=password name=customField><button>Continue</button></form>`);await r.call('browser_snapshot');await r.page.locator('#p').fill(value);await r.call('browser_snapshot');
   await Promise.all([r.page.waitForURL(origin+'/**'),r.page.locator('button').click()]);
   for(const name of ['browser_snapshot','browser_tabs']){const answer=await r.call(name,name==='browser_tabs'?{action:'list'}:{});assert.doesNotMatch(decodeURIComponent(text(answer)),new RegExp(value));}
  });
  check('10 common secret labels ask only once',async r=>{
   for(const label of ['PIN code','Your PIN','MFA code','2FA code','Authenticator code','Backup code','ssn','Credit card','Security answer','pass','user_pass','userpassword','Passwort','Mot de passe','Contraseña','رمز المصادقة']){
    await r.set(`<input aria-label="${label}" value=4821><h1>Public</h1>`);
    const first=await r.route('browser_snapshot',{},['deny']);assert.ok(first.cards.length===1||text(first.result)===LINE,label);assert.doesNotMatch(text(first.result),/4821/,label);
    const next=await r.route('browser_snapshot',{},['deny']);assert.equal(next.cards.length,0,label);
   }
  });
  check('11 script document replacement keeps the lock',async r=>{
   await r.set(`<input type=password value=${value}>`);await r.call('browser_snapshot');
   await r.page.evaluate(()=>{location.href='javascript:"<h1>Rewritten</h1>"'});await new Promise(resolve=>setTimeout(resolve,100));assert.equal(text(await r.call('browser_snapshot')),LINE);
  });
  check('11 early input interception cannot hide person typing',async r=>{
   await r.set('<input id=p type=password><h1 id=o></h1><script>window.addEventListener("input",e=>{e.stopImmediatePropagation();document.getElementById("o").textContent=e.target.value;e.target.value=""},true)</script>');
   await r.call('browser_snapshot');await r.page.locator('#p').pressSequentially(value);
   assert.equal(text(await r.call('browser_snapshot')),LINE);
  });
  check('15 reloading the same site cannot repeat the privacy question',async r=>{
   for(let i=0;i<3;i++){
    await r.set('<input aria-label=Code value=4821>');const reply=await r.route('browser_snapshot',{},['deny']);
    assert.equal(reply.cards.length,i===0?1:0);assert.doesNotMatch(text(reply.result),/4821/);
   }
  });
  check('13 ordinary search and email do not become passwords',async r=>{
   for(const field of ['<input type=email aria-label="Enter your email to reset your password">','<input placeholder="Search passwords">','<input aria-label="Password hint">','<input aria-label="Credential name">']){
    await r.set(field);const tree=text(await r.call('browser_snapshot')),target=/ref=((?:f\d+)?e\d+)/.exec(tree)?.[1];
    await r.route('browser_type',{target,element:'Field',text:'ordinary'},['allow_once']);assert.equal(await r.page.locator('input').inputValue(),'ordinary',field);
   }
  });
 }
};
