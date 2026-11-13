"use strict";
// Shared behavioral probes on both real browser hosts. All values are invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const text = r => (r?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
module.exports = (rig, host) => {
 for (const lang of ['en', 'ar']) {
  const check = (name, work) => test(`${host} ${lang} round13 ${name}`, { timeout: 90000 }, async t => {
   const r = await rig(t), set = r.set; r.set = html => set(`<html lang=${lang}>${html}</html>`); await work(r, t);
  });
  const secret = lang === 'ar'
   ? ['كلمة المرور', 'مفتاح API', 'رمز الوصول', 'رقم البطاقة', 'CVC', 'CVV', 'عبارة الاسترداد', 'مفتاح خاص', 'رقم الضمان الاجتماعي', 'رمز الاسترداد', 'رمز لمرة واحدة', 'رمز المصادقة الثنائية', 'رمز التحقق من البطاقة']
   : ['Password', 'API key', 'Token', 'Card number', 'CVC', 'CVV', 'Seed phrase', 'Private key', 'SSN', 'Recovery code', 'One time code', '2FA code', 'Card verification code'];
  const ordinary = lang === 'ar'
   ? ['رمز الدولة', 'الرمز البريدي', 'رمز القسيمة', 'رمز الخصم', 'الرمز الترويجي', 'البحث', 'ZIP']
   : ['Country code', 'Postal code', 'Coupon code', 'Discount code', 'Promo code', 'Search', 'Zip'];
  for (const attribute of ['aria-label', 'name']) check(`1 SECRET by ${attribute} seals empty fields and masks a submitted echo`, async (r, t) => {
   for (const [i, label] of secret.entries()) await t.test(label, async () => {
    const value = `MADEUP-${lang}-${i}-987654`;
    await r.set(`<form method=post><input ${attribute}="${label}"><button>Save</button></form>`);
    const empty = await r.route('browser_snapshot', {}, []);
    assert.equal(empty.cards.length, 0, label);
    const target = /textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(text(empty.result))?.[1]; assert.ok(target, text(empty.result));
    await r.route('browser_type', { target, element: 'Search', text: value }, ['allow_once']);
    assert.equal(await r.page.locator('input').inputValue(), '', `${label} seals before entry`);
    await r.page.locator('input').fill(value);
    const held = await r.route('browser_snapshot', {}, ['allow_once']);
    assert.equal(held.cards.length, 0, `${label} cannot be approved as ordinary`);
    assert.doesNotMatch(text(held.result), new RegExp(value));
    r.nextPage(`<html lang=${lang}><title>Saved ${value}</title><h1>Your value ${value}</h1></html>`);
    await Promise.all([r.page.waitForEvent('domcontentloaded'), r.page.locator('button').click()]);
    const echo = text(await r.call('browser_snapshot')); assert.doesNotMatch(echo, /Your value/);await r.handBack();assert.match(text(await r.call('browser_snapshot')),/Your value/); assert.doesNotMatch(echo, new RegExp(value), `${label} feeds the site net`);
   });
  });
  check('1 unmasked secret POST echoes stay blind until Hand back', async (r, t) => {
   for (const label of [secret[1], secret[3], secret[6]]) await t.test(label, async () => {
    await r.set(`<form method=post><input aria-label="${label}" value=MADEUPSECRET9876><button>Save</button></form>`);
    await r.route('browser_snapshot', {}, []);
    r.nextPage(`<html lang=${lang}><title>Saved</title><h1>Your key MADEUPSECRET9876</h1></html>`);
    await Promise.all([r.page.waitForEvent('domcontentloaded'), r.page.locator('button').click()]);
    assert.doesNotMatch(text(await r.call('browser_snapshot')),/Your key|MADEUPSECRET9876/); await r.handBack();
    const reply=await r.call('browser_snapshot');assert.match(text(reply),/Your key/);assert.doesNotMatch(text(reply),/MADEUPSECRET9876/);
   });
  });
  check('1 agent fills and person edits of unknown controls stay ordinary', async r => {
   await r.set('<input aria-label="Other reference">');
   const first=text(await r.call('browser_snapshot')),target=/textbox[^\n]*ref=((?:f\d+)?e\d+)/.exec(first)?.[1];
   await r.route('browser_type',{target,text:'AGENTMADEUP',element:'Other reference'},['allow_once']);assert.match(text(await r.call('browser_snapshot')),/AGENTMADEUP/);
   await r.page.locator('input').fill('PERSONMADEUP');const reply=await r.route('browser_snapshot',{},[]);assert.equal(reply.cards.length,0);assert.match(text(reply.result),/PERSONMADEUP/);
  });
  check('1 SECRET autocomplete and masking override ordinary labels', async (r, t) => {
   for (const extra of ['autocomplete=current-password', 'autocomplete=new-password', 'autocomplete=cc-number', 'autocomplete=cc-csc', 'autocomplete=one-time-code', 'name=totp', 'name=otp', 'name=api_key', 'style="-webkit-text-security:disc"', 'type=password']) await t.test(extra, async () => {
    await r.set(`<input aria-label="${ordinary[0]}" ${extra} value=MADEUPSECRET>`);
    const reply = await r.route('browser_snapshot', {}, ['allow_once']); assert.equal(reply.cards.length, 0, extra); assert.doesNotMatch(text(reply.result), /MADEUPSECRET/);
   });
  });
  check('1 ORDINARY list never locks and stays fillable', async (r, t) => {
   for (const label of ordinary) await t.test(label, async () => {
    await r.set(`<h1>Ordinary</h1><input aria-label="${label}" value=ORDINARY123>`);
    const reply = await r.route('browser_snapshot', {}, []); assert.equal(reply.cards.length, 0, label); assert.match(text(reply.result), /ORDINARY123/);
    const target = /(?:textbox|searchbox)[^\n]*ref=((?:f\d+)?e\d+)/.exec(text(reply.result))?.[1]; assert.ok(target);
    const filled = await r.route('browser_type', { target, text: 'ORDINARY456', element: label }, ['allow_once']); assert.notEqual(filled.result.isError, true, text(filled.result)); assert.equal(await r.page.locator('input').inputValue(), 'ORDINARY456');
   });
  });
  check('1 and 5 unknown prefills are ordinary without approval', async r => {
   await r.set('<input aria-label="First reference" value=MADEUPFIRST><input aria-label="Second reference" value=MADEUPSECOND>');
   const reply=await r.route('browser_snapshot',{},[]);assert.equal(reply.cards.length,0);assert.match(text(reply.result),/MADEUPFIRST/);assert.match(text(reply.result),/MADEUPSECOND/);
  });
  for (const kind of ['password', 'secret label']) for (const hop of ['redirect', 'replaceState']) check(`2 ${kind} GET blind follows ${hop}`, async (r, t) => {
   const value = `MADEUP-${lang}-SECRET9876`;
   const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/check') && hop === 'redirect') { res.writeHead(302, { location: '/middle' }); res.end(); }
    else if (req.url === '/middle') { res.writeHead(303, { location: '/done' }); res.end(); }
    else res.end(`<html lang=${lang}><title>Hi ${value}</title><h1>Welcome ${value}</h1><script>history.replaceState({},'', '/done')</script></html>`);
   });
   await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
   const origin = `http://127.0.0.1:${server.address().port}`;
   await r.set(`<form action=${origin}/check method=get><input name=customField ${kind === 'password' ? 'type=password' : `aria-label="${kind === 'secret label' ? secret[1] : 'Other reference'}"`}><button>Continue</button></form>`);
   await r.call('browser_snapshot'); await r.page.locator('input').fill(value);
   if (kind !== 'unanswered unknown') await r.route('browser_snapshot', {}, ['deny']);
   else await r.engine.inspectPrivacy();
   await Promise.all([r.page.waitForURL(origin + '/done'), r.page.locator('button').click()]);
   for (const [name, args] of [['browser_snapshot', {}], ['browser_tabs', { action: 'list' }], ['browser_take_screenshot', {}], ['browser_find', { text: 'Welcome' }]]) {
    const reply = await r.call(name, args); assert.doesNotMatch(decodeURIComponent(text(reply)), /SECRET9876|Welcome|Hi /, name); assert.equal((reply.content || []).some(p => p.type === 'image'), false, name);
   }
  });
  check('4 visible agent tab survives finish then closes only on its own close call', async r => {
   await r.set('<h1>Person</h1>');
   await r.route('browser_tabs', { action: 'new' }, ['allow_once']);
   const page = r.host ? r.host.session.tabs[1] : r.page.context().pages().at(-1);
   await r.route('browser_tabs', { action: 'finish' }, []);
   assert.equal(r.host ? page.view.webContents.isDestroyed() : page.isClosed(), false);
   const close = await r.route('browser_tabs', { action: 'close', index: 1 }, []); assert.equal(close.cards.length, 0); assert.notEqual(close.result.isError, true, text(close.result));
   assert.equal(r.host ? page.view.webContents.isDestroyed() : page.isClosed(), true);
  });
  check('6 last person tab refuses before asking for a close card', async r => {
   await r.set('<h1>Person draft</h1>'); if (!r.host) r.engine._agentPages.delete(r.page);
   for (const [name, args] of [['browser_close', {}], ['browser_tabs', { action: 'close', index: 0 }]]) {
    const reply = await r.route(name, args, ['allow_once']); assert.equal(reply.cards.length, 0); assert.equal(reply.result.isError, true); assert.equal(r.page.isClosed(), false);
   }
  });
 }
};
