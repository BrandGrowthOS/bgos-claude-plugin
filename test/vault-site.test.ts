import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registrableSite, siteMatch } from '../lib/vault-site.ts'

// A saved login on another host of the same site: the plugin's twin of the HOAI server's rule
// (BGOS backend/src/agent-vault/vault-site.ts) with the cases of its vault-site.spec.ts and of the
// desktop's agent-browser/__tests__/vault-site-match.test.js. Two https origins match when they are
// the same origin ("exact"), or when they share one registrable domain by the public suffix list,
// private domains included, on the same port ("same_site"). Only obvious fake values.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

test('the same origin is exact', () => {
  assert.equal(siteMatch('https://mail.google.com', 'https://mail.google.com'), 'exact')
  assert.equal(siteMatch('https://10.0.0.1', 'https://10.0.0.1'), 'exact')
  // Its own port, or an address: only a sibling host needs a registrable domain.
  assert.equal(siteMatch('https://login.example.com:8443', 'https://login.example.com:8443'), 'exact')
})

test('same site, different host: a sibling, named by its registrable domain', () => {
  assert.equal(siteMatch('https://mail.google.com', 'https://accounts.google.com'), 'same_site')
  assert.equal(siteMatch('https://google.com', 'https://accounts.google.com'), 'same_site')
  assert.equal(siteMatch('https://www.bbc.co.uk', 'https://account.bbc.co.uk'), 'same_site')
  assert.equal(siteMatch('https://alice.github.io', 'https://docs.alice.github.io'), 'same_site')
  assert.equal(registrableSite('https://accounts.google.com'), 'google.com')
  assert.equal(registrableSite('https://account.bbc.co.uk'), 'bbc.co.uk')
})

test('different sites never match, lookalikes included', () => {
  const punycode = `https://${new URL(`https://g${String.fromCharCode(0x43e, 0x43e)}gle.com`).hostname}`
  for (const [saved, tab] of [
    ['https://mail.google.com', 'https://accounts.google.co'],
    ['https://mail.google.com', 'https://google.com.evil.example'],
    ['https://accounts.google.com', 'https://accounts.google.com.evil.test'],
    ['https://mail.google.com', 'https://accounts-google.com'],
    ['https://mail.google.com', 'https://googIe.com'],
    ['https://mail.google.com', punycode],
    ['https://bank.example.com', 'https://example.co.uk'],
  ]) assert.equal(siteMatch(saved, tab), null, `${saved} and ${tab}`)
})

test('public suffix user sites are separate: one person\'s site never fills another\'s', () => {
  for (const [saved, tab] of [
    ['https://alice.github.io', 'https://bob.github.io'],
    ['https://alice.github.io', 'https://github.io'],
    ['https://shop-a.vercel.app', 'https://shop-b.vercel.app'],
    ['https://one.blogspot.com', 'https://two.blogspot.com'],
    ['https://a.netlify.app', 'https://b.netlify.app'],
    ['https://a.herokuapp.com', 'https://b.herokuapp.com'],
  ]) assert.equal(siteMatch(saved, tab), null, `${saved} and ${tab}`)
})

test('never another scheme, port, an address or a credential', () => {
  for (const [saved, tab] of [
    ['https://mail.google.com', 'http://accounts.google.com'],
    ['http://mail.google.com', 'http://accounts.google.com'],
    ['http://mail.google.com', 'http://mail.google.com'],
    ['https://mail.google.com', 'https://accounts.google.com:8443'],
    ['https://a.google.com:8443', 'https://b.google.com'],
    ['https://10.0.0.1', 'https://10.0.0.2'],
    ['https://[::1]', 'https://[::2]'],
    ['https://user:pw@mail.google.com', 'https://accounts.google.com'],
    ['https://localhost', 'https://app.localhost'],
    ['not a url', 'https://accounts.google.com'],
    ['https://mail.google.com', ''],
  ]) assert.equal(siteMatch(saved, tab), null, `${saved} and ${tab}`)
  for (const odd of [null, undefined, 42, {}, []]) assert.equal(siteMatch(odd, 'https://accounts.google.com'), null)
})

test('a public suffix is nobody\'s site', () => {
  assert.equal(registrableSite('https://github.io'), null)
  assert.equal(registrableSite('https://co.uk'), null)
  assert.equal(registrableSite('https://10.0.0.1'), null)
  assert.equal(registrableSite('http://google.com'), null)
})

test('an origin is compared as an origin: a path, a query, a trailing slash or capitals change nothing', () => {
  assert.equal(siteMatch('https://mail.google.com/', 'https://accounts.google.com/v3/signin?x=1'), 'same_site')
  assert.equal(siteMatch('https://MAIL.google.com', 'https://accounts.GOOGLE.com'), 'same_site')
})

test('the public suffix list is the one the server and the desktop pin', () => {
  // Same pinned tldts as BGOS backend/package.json and frontend/electron-app/package.json, so a list
  // update moves all three together.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies.tldts, '7.4.16')
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  assert.equal(lock.packages[''].dependencies.tldts, '7.4.16')
  assert.equal(lock.packages['node_modules/tldts'].version, '7.4.16')
  assert.match(readFileSync(join(ROOT, 'bun.lock'), 'utf8'), /"tldts": \["tldts@7\.4\.16"/)
})
