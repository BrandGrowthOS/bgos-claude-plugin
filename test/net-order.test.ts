import { test } from 'node:test'
import assert from 'node:assert/strict'
import privacy from '../lib/browser-host-core/answer-privacy.js'
import fixture from './privacy-fixture.cjs'
const {AnswerPrivacy,COPY}=privacy
const {privacyPage}=fixture
for (const [language, values] of [["en", ["abcdef", "xxabcdefgh"]], ["ar", ["تجريبي", "سرتجريبي٩٨"]]] as const) {
  test(`${language} the final net takes the longest match first`, async () => {
    const p = new AnswerPrivacy(); await p.read(privacyPage([...values]));
    assert.equal(p.text(values[1]), "(masked)");
  });
  test(`${language} a typed prefix is replaced only for its own field`, async () => {
    const p = new AnswerPrivacy(), values = ["Welcome"], fields = [{ id: "typed", value: "Welcome" }];
    const page = privacyPage(values, fields);
    await p.read(page); values[0] = "Welcome1!"; fields[0] = { id: "typed", value: "Welcome1!" }; await p.read(page);
    assert.equal(p.text("Welcome back"), "Welcome back");
    assert.equal(p.text("Welcome1!"), "(masked)");
    const q = new AnswerPrivacy(); await q.read(privacyPage(["abcdef", "abcdefgh"], [{id:"one",value:"abcdef"},{id:"two",value:"abcdefgh"}]));
    assert.equal(q.text("abcdef"), "(masked)");
    const mixed = new AnswerPrivacy(); await mixed.read(privacyPage(["Welcome", "Welcome1!"], [{id:"typing",value:"Welcome"},{id:"typing",value:"Welcome1!"}]));
    assert.equal(mixed.text("Welcome back"), "Welcome back");
    const independent = new AnswerPrivacy(), nextValues = ["abcdef"], nextFields = [{id:"one",value:"abcdef"}];
    const nextPage = privacyPage(nextValues, nextFields); await independent.read(nextPage);
    nextValues.splice(0, 1, "abcdef", "abcdefgh"); nextFields.splice(0, 1, {id:"two",value:"abcdef"}, {id:"one",value:"abcdefgh"});
    await independent.read(nextPage);
    assert.equal(independent.text("abcdef"), "(masked)");
  });
  test(`${language} another page never inherits the final net`, async () => {
    const p = new AnswerPrivacy(); await p.read(privacyPage(["ordinaryLater"])); await p.read(privacyPage());
    assert.equal(p.text("ordinaryLater"), "ordinaryLater");
  });
  test(`${language} privacy copy is complete`, () => {
    for (const key of ["handoff", "person", "question"]) assert.equal(typeof (COPY as any)[language][key], "string");
  });
}
