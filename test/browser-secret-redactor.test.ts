import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserSecretRedactor } from '../lib/browser-secret-redactor.mjs'
import { BrowserHostCore, ChromiumEngine } from '../bin/hoai-browser-host.mjs'

test('a status response includes passwords registered while its page read waits, even after engine close', async () => {
  const secrets = new BrowserSecretRedactor()
  const engine: any = new ChromiumEngine({ profileDir: '/fixture', outputDir: '/fixture', executable: 'unused' })
  engine._engine = { _secrets: secrets }
  let titleReady: (value: string) => void = () => {}
  const title = new Promise<string>(resolve => { titleReady = resolve })
  engine.pages = () => [{ title: () => title, url: () => 'https://example.test' }]
  const core = new BrowserHostCore({ pool: { peek: () => ({ engine }) } as any, browserTools: [], deviceLabel: 'fixture' })
  const response = core.callTool({ assistantId: 901, principal: 'user-fixture' }, 'hoai_browser_status', {})
  const secret = 'SYNTHETIC_LATE_PASSWORD_51'
  secrets.register(secret)
  secrets.clear(); engine._engine = null
  titleReady(secret)
  const result = JSON.stringify(await response)
  assert.equal(result.includes(secret), false)
  assert.ok(result.includes('[REDACTED]'))
})

test('registered secrets and normal JSON, URL and native input serializations redact with bounded capacity', () => {
  const redactor = new BrowserSecretRedactor()
  const secret = 'quoted"\\line\nbreak'
  redactor.register(secret)
  for (const value of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), secret.replace(/\n/g, '')]) {
    assert.equal(redactor.text(value), '[REDACTED]')
  }
  for (let i = 1; i < 1000; i++) redactor.register(`bounded-fixture-${i}`)
  assert.throws(() => redactor.register('overflow-fixture'), { code: 'credential_storage' })
  redactor.clear(); redactor.register('fresh-fixture')
})
