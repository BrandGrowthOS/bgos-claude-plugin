import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {DOCUMENT_SAFETY_EXPRESSION} from '../lib/browser-profile-document-safety.mjs'
const require=createRequire(import.meta.url),{chromium}=require(process.env.HOAI_PROBE_PLAYWRIGHT)
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,chromiumSandbox:true})
const checks=[]
try{
  const context=await browser.newContext(),page=await context.newPage()
  await page.setContent('<input id="draft" value="baseline"><input name="append"><input name="reset"><input type="range"><input type="range" min="10" max="20"><input type="color"><input type="number" value="invalid"><input type="date" value="invalid"><input type="radio" name="group" checked><input type="radio" name="group" checked><input type="checkbox" checked><textarea id="area">baseline</textarea><select id="plain"><option>A</option><option>B</option></select><select><option disabled>A</option><option>B</option></select><select><optgroup disabled><option>A</option></optgroup><option>B</option></select><select size="3"><option>A</option><option>B</option></select><select multiple><option selected>A</option><option>B</option></select><select><option selected>A</option><option selected>B</option></select><script>globalThis.ticks=0;setInterval(()=>globalThis.ticks++,10)</script>')
  const cdp=await context.newCDPSession(page);await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Debugger.enable')
  const {frameTree}=await cdp.send('Page.getFrameTree'),world=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'private-form-proof',grantUniveralAccess:false})
  const inspect=async()=>{const value=await cdp.send('Runtime.evaluate',{expression:DOCUMENT_SAFETY_EXPRESSION,contextId:world.executionContextId,returnByValue:true});assert.equal(value.exceptionDetails,undefined);return value.result.value}
  assert.deepEqual(await inspect(),{ready:true,credentials:false,unsaved:false});checks.push('native_reset_select_baselines_clean')
  const paused=new Promise(resolve=>cdp.once('Debugger.paused',resolve));await cdp.send('Debugger.pause');await paused;const before=(await cdp.send('Runtime.evaluate',{expression:'globalThis.ticks',returnByValue:true})).result.value
  assert.equal((await inspect()).unsaved,false);checks.push('private_evaluation_while_paused')
  await cdp.send('Runtime.evaluate',{expression:'document.getElementById("draft").value="unsaved-canary";true',contextId:world.executionContextId,returnByValue:true})
  assert.deepEqual(await inspect(),{ready:true,credentials:false,unsaved:true});checks.push('paused_race_detected_without_field_output')
  await new Promise(resolve=>setTimeout(resolve,60));const tickResult=await cdp.send('Runtime.evaluate',{expression:'globalThis.ticks',returnByValue:true});assert.equal(tickResult.result.value,before);checks.push('website_scripts_stay_paused')
  await cdp.send('Debugger.resume');await new Promise(resolve=>setTimeout(resolve,60));assert.ok(await page.evaluate(()=>globalThis.ticks)>before);assert.equal(await page.inputValue('#draft'),'unsaved-canary');checks.push('same_document_edit_and_timer_survive_refusal')
  await page.evaluate(()=>{document.querySelector('#draft').value='baseline';document.querySelector('#area').value='different'})
  assert.equal((await inspect()).unsaved,true);checks.push('textarea_changes_refuse')
  await page.evaluate(()=>{document.querySelector('#area').value='baseline';document.querySelector('#plain').selectedIndex=1})
  assert.equal((await inspect()).unsaved,true);checks.push('select_changes_refuse')
  await page.evaluate(()=>{document.querySelector('#plain').selectedIndex=0;const input=document.createElement('input');input.autocomplete='ONE-TIME-CODE';input.value='synthetic';document.body.append(input)})
  assert.equal((await inspect()).credentials,true);checks.push('case_insensitive_credential_tokens')
  await page.setContent('<div id="many"></div>');await page.evaluate(()=>{const host=document.querySelector('#many');for(let count=0;count<4097;count++)host.append(document.createElement('input'))})
  const bounded=await page.evaluate(DOCUMENT_SAFETY_EXPRESSION);assert.equal(bounded.ready,false);checks.push('form_inventory_refuses_before_reconstruction')
  process.stdout.write(JSON.stringify({ok:true,version:await browser.version(),checks,simulation:false,scope:'fresh sandboxed Chrome155, boolean DOM/form guard primitive, no live profile or transfer'})+'\n')
}finally{await browser.close()}
