"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const text = r => (r?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
module.exports = (rig, host) => {
 for (const lang of ['en', 'ar']) {
  const check = (name, work) => test(`${host} ${lang} round12 ${name}`, { timeout: 90000 }, async t => {
   const r = await rig(t), set = r.set; r.set = html => set(`<html lang=${lang}>${html}</html>`); await work(r, t);
  });
  check('1 ordinary forms stay readable and fillable', async r => {
   const labels = lang === 'ar' ? ['رمز الدولة', 'رمز بريدي', 'رمز القسيمة', 'رمز الخصم', 'البحث برمز المنتج'] : ['Country code', 'Postal code', 'Coupon code', 'Discount code', 'Search by product code'];
   for (const [i, label] of labels.entries()) {
    await r.set(`<h1>Ordinary form</h1><input aria-label="${label}" ${i === 1 ? 'autocomplete=postal-code' : i === 3 ? 'name=discount_code' : ''} ${i === 4 ? 'type=search' : ''} value=ORDINARY123>`);
    const reply = await r.route('browser_snapshot', {}, []); assert.equal(reply.cards.length, 0, label); assert.match(text(reply.result), /Ordinary form/);
    const target = /ref=((?:f\d+)?e\d+)/.exec(text(reply.result).split('\n').find(line => /textbox|searchbox/.test(line)) || '')?.[1]; assert.ok(target, text(reply.result));
    const fill = await r.route('browser_type', { target, text: 'MADEUP456', element: label }, ['allow_once']);
    assert.notEqual(fill.result.isError, true, text(fill.result)); assert.equal(await r.page.locator('input').inputValue(), 'MADEUP456');
   }
   await r.set(`<select aria-label="${labels[0]}"><option value=1>One</option><option value=2>Two</option></select>`);
   const reply = await r.route('browser_snapshot', {}, []); assert.equal(reply.cards.length, 0); assert.match(text(reply.result), /combobox/);
   const target = /combobox[^\n]*ref=((?:f\d+)?e\d+)/.exec(text(reply.result))?.[1];
   await r.route('browser_select_option', { target, values: ['2'], element: labels[0] }, ['allow_once']); assert.equal(await r.page.locator('select').inputValue(), '2');
  });
  check('1 PIN seals without a card and unknown fields stay ordinary', async r => {
   await r.set('<input aria-label=Pin value=4821>');
   const sealed = await r.route('browser_snapshot', {}, ['allow_once']); assert.equal(sealed.cards.length, 0); assert.doesNotMatch(text(sealed.result), /4821/);
   await r.set('<input aria-label="Other reference" value=7391>'); assert.doesNotMatch(text(await r.call('browser_snapshot')),/7391/); await r.handBack();
   const ordinary=await r.route('browser_snapshot',{},[]);assert.equal(ordinary.cards.length,0);assert.match(text(ordinary.result),/7391/);
  });
  check('2 a person tab always needs a close card even with a write grant', async r => {
   await r.set('<h1>Person draft</h1>');
   if (r.host) { await r.host._createTab('about:blank', { activate: false }); r.host.session.approvalBypass = true; }
   else { r.engine._agentPages?.delete(r.page); await r.page.context().newPage(); }
   const reply = await r.route('browser_tabs', { action: 'close', index: 0 }, ['deny']);
   assert.equal(reply.cards.length, 1); assert.equal(r.isClosed ? r.isClosed() : r.page.isClosed(), false);
   if (r.host) { r.host.session.approvalBypass = false; r.host.session.grants[r.origin] = { access: 'deny', write: 'deny' }; }
   else r.core._grantsFor = () => ({ [r.origin]: { access: 'deny', write: 'deny' } });
   const denied = await r.route('browser_tabs', { action: 'close', index: 0 }, []);
   assert.equal(denied.cards.length, 0, 'a denied origin cannot be released by a close card');
   assert.equal(denied.result.isError, true); assert.equal(r.isClosed ? r.isClosed() : r.page.isClosed(), false);
  });
  check('2 close keeps one tab and closes only an approved document', async r => {
   await r.set('<h1>Person draft</h1>');
   if (r.host) await r.host._createTab('about:blank', { activate: false });
   else { r.engine._agentPages.delete(r.page); await r.page.context().newPage(); }
   const changed = await r.route('browser_tabs', { action: 'close', index: 0 }, [async () => {
    await r.set('<h1>Replacement draft</h1>');
    // Electron emits native document epochs; this rig uses a Chromium-backed fake webContents.
    if (r.host) r.host.session.tabs[0].documentEpoch++;
    return 'allow_once';
   }]);
   assert.equal(changed.cards.length, 1); assert.equal(r.isClosed ? r.isClosed() : r.page.isClosed(), false); assert.equal(changed.result.isError, true);
  });
  check('2 own tabs close freely and the last tab stays open', async r => {
   await r.set('<h1>Ordinary</h1>');
   const added = await r.route('browser_tabs', { action: 'new' }, ['allow_once']); assert.notEqual(added.result.isError, true, text(added.result));
   const closed = await r.route('browser_tabs', { action: 'close', index: 1 }, []); assert.equal(closed.cards.length, 0); assert.notEqual(closed.result.isError, true, text(closed.result));
   if (!r.host) r.engine._agentPages.add(r.page);
   else r.host.session.tabs[0].agentOwned = true;
   const last = await r.route('browser_tabs', { action: 'close', index: 0 }, []); assert.equal(last.cards.length, 0); assert.equal(last.result.isError, true); assert.equal(r.page.isClosed(), false);
  });
  check('3 private dialog card names the choice and prompt answer', async r => {
   await r.set('<input type=password value=MADEUPSECRET>'); await r.call('browser_snapshot');
   await r.page.evaluate(() => { setTimeout(() => prompt('PRIVATE MESSAGE'), 0); }); await new Promise(resolve => setTimeout(resolve, 80));
   const yes = await r.route('browser_handle_dialog', { accept: true, promptText: 'MADEUP ANSWER' }, ['deny']);
   assert.equal(yes.cards.length, 1); assert.match(yes.cards[0].summary, lang === 'ar' ? /قبول/ : /Accept/); assert.match(yes.cards[0].summary, /MADEUP ANSWER/); assert.doesNotMatch(JSON.stringify(yes.cards), /PRIVATE MESSAGE/);
   const no = await r.route('browser_handle_dialog', { accept: false }, ['allow_once']); assert.match(no.cards[0].summary, lang === 'ar' ? /رفض/ : /Dismiss/);
  });
  check('5 a secret GET destination stays blind even when it echoes', async (r, t) => {
   const server = createServer((req, res) => { const value = new URL(req.url, 'http://fixture').searchParams.get('customField'); res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<html lang=${lang}><title>Hi ${value}</title><h1>Welcome ${value}</h1></html>`); });
   await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
   const origin = `http://127.0.0.1:${server.address().port}`;
   await r.set(`<form action=${origin}/echo method=get><input type=password name=customField><button>Continue</button></form>`); await r.call('browser_snapshot');
   await r.page.locator('input').fill('MADEUPSECRET'); await r.call('browser_snapshot');
   await Promise.all([r.page.waitForURL(origin + '/**'), r.page.locator('button').click()]);
   for (const [name, args] of [['browser_snapshot', {}], ['browser_tabs', { action: 'list' }], ['browser_take_screenshot', {}]]) {
    const reply = await r.call(name, args); assert.doesNotMatch(decodeURIComponent(text(reply)), /MADEUPSECRET|Welcome/); assert.equal((reply.content || []).some(p => p.type === 'image'), false);
   }
  });
  check('6 ordinary descriptions cannot approve a password labelled field', async r => {
   for (const html of ['<label id=p>Password</label><label id=h>Password hint: 12 characters</label><input aria-labelledby="p h" value=MADEUPSECRET>', '<input type=email aria-label=Password value=MADEUPSECRET>']) {
    await r.set(html); const reply = await r.route('browser_snapshot', {}, ['deny']); assert.equal(reply.cards.length, 0); assert.doesNotMatch(text(reply.result), /MADEUPSECRET/);
   }
   await r.set('<input type=email aria-label="Password hint" style="-webkit-text-security:disc" value=MADEUPSECRET>');
   const masked = await r.route('browser_snapshot', {}, []); assert.equal(masked.cards.length, 0); assert.doesNotMatch(text(masked.result), /MADEUPSECRET/);
  });
  if (host === 'machine') check('7 back to initial blank is a harmless no op', async r => {
   const history = await r.page.context().newCDPSession(r.page); const h = await history.send('Page.getNavigationHistory'); await history.send('Page.navigateToHistoryEntry', { entryId: h.entries[1].id }); await history.detach();
   const before = r.page.url(), reply = await r.route('browser_navigate_back', {}, []); assert.notEqual(reply.result.isError, true, text(reply.result)); assert.equal(r.page.url(), before); assert.equal(reply.cards.length, 0);
  });
  check('8 transient closed inventory errors retry without a deep child walk', async r => {
   r.engine._privacy.busy = true;
   await r.set('<h1>Readable page</h1><iframe srcdoc="<h1>Child</h1>"></iframe>');
   const utility = await r.page._connection.toImpl(r.page.mainFrame()).utilityContext(), client = utility.delegate._client, send = client.send;
   let injected = false, deepChild = 0;
   client.send = function(method, params, ...rest) {
    if (method === 'DOM.describeNode' && params.objectId && params.depth === -1) deepChild++;
    if (!injected && method === 'DOM.querySelectorAll') { injected = true; throw new Error('Protocol error (DOM.querySelectorAll): Document is not ready'); }
    return send.call(this, method, params, ...rest);
   };
   try { const reply = await r.call('browser_snapshot'); assert.match(text(reply), /Readable page/); assert.equal(injected, true); assert.equal(deepChild, 0); }
   finally { client.send = send; }
  });
 }
};
