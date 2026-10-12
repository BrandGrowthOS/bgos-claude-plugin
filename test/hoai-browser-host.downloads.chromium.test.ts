/**
 * DOWNLOADS IN THE AGENT'S OWN BROWSER, END TO END (HOAI board row 67562770).
 *
 * The host process is started with what the daemon's supervisor hands it
 * (node bin/hoai-browser-host.mjs, the pairing env, stdin as the stop),
 * against a fake backend, with a real Chrome, and an agent clicks links on a
 * 127.0.0.1 page that answer with Content-Disposition: attachment. It keeps
 * the full environment, as the host end to end case in hoai-browser-host.test.ts
 * does: on GitHub's Windows runner PowerShell times out under the daemon's
 * allow-listed environment, so the vault refuses every profile there
 * (unsafe_profile), which is not about downloads (vaultProbe says so if it
 * ever shows here). The measurement of this row used the supervisor itself.
 *
 * What it pins, measured on main 0a4c96a before the fix: Chrome raised the
 * download, Playwright's own tab code saved it into the agent's output folder
 * and into a playwright-artifacts folder in the system temp folder, the agent
 * was told the path, and the owner was never asked. The rules now are the
 * desktop app's (BGOS #2198): a download is asked for like any gated action,
 * Deny leaves no file, Allow puts it where the ask said, one nobody answers
 * is kept for the owner in an owner only folder and the agent reads it as
 * kept, the owner is told it was kept and one tap (Deny) deletes it, and no
 * byte is written outside the agent's own folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

import { resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { hostEnv } from '../lib/browser-host-supervisor.ts'
import { startFakeRelay } from './helpers/fake-browser-relay.ts'

const HOST_BIN = join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs')
const chrome = resolveChromeExecutable()
const skip = !chrome.path ? 'no Chrome or Chromium is installed on this machine' : false

const TAG = randomBytes(3).toString('hex').toUpperCase()
const CASES = {
  deny: { name: `Deny_${TAG}.p8`, marker: `PLUGDL-DENY-${TAG}` },
  kept: { name: `AuthKey_${TAG}.p8`, marker: `PLUGDL-KEPT-${TAG}` },
  stays: { name: `Stays_${TAG}.p8`, marker: `PLUGDL-STAYS-${TAG}` },
  allow: { name: `billing_${TAG}.csv`, marker: `PLUGDL-ALLOW-${TAG}` },
} as const
type CaseKey = keyof typeof CASES

test(
  'a download the agent starts is asked for: Deny leaves no file, Allow lands where the ask said, no answer keeps it owner only and the agent reads it as kept, Deny on the kept card deletes it, nothing outside the agent folder',
  { timeout: 300_000, skip },
  async () => {
    if (skip) return
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-dl-')))
    // A whole profile, as the host end to end case explains (hoai-browser-host.test.ts):
    // Chrome refuses remote debugging without one on Windows.
    // The exact Chrome the skip check found: never a first use download from the network.
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, HOAI_BROWSER_EXECUTABLE: chrome.path! }
    if (process.platform === 'win32') {
      for (const [name, rel] of [['LOCALAPPDATA', join('AppData', 'Local')], ['APPDATA', join('AppData', 'Roaming')]] as const) {
        mkdirSync(join(home, rel), { recursive: true })
        env[name] = join(home, rel)
      }
    }
    // The host's own temp folder, inside this home, so a byte Chrome or Playwright writes
    // there is seen by the walk below (on a real machine that is the system temp folder).
    const hostTmp = join(home, 'tmp')
    mkdirSync(hostTmp, { recursive: true })
    Object.assign(env, { TMP: hostTmp, TEMP: hostTmp, TMPDIR: hostTmp })
    const agentRoot = join(home, '.bgos-agent')
    const agentDir = join(agentRoot, '900')
    mkdirSync(agentRoot, { recursive: true, mode: 0o700 })

    const site = await startDownloadSite()
    const relay = await startFakeRelay({ token: 'tok-dl', admissible: [900] })
    // Navigations and clicks are allowed for the session; each download card is
    // answered from this queue, in order, and an empty queue leaves it open.
    const downloadAnswers: Array<{ state: string; choice: string | null } | null> = []
    relay.answerCardsBy((card) => (card.kind === 'download' ? (downloadAnswers.shift() ?? null) : { state: 'answered', choice: 'allow_session' }))

    // The variables lib/browser-host-supervisor.ts adds for the one pairing it serves.
    const logs: string[] = []
    const child = spawn(process.execPath, [HOST_BIN], {
      env: { ...env, HOAI_BROWSER_HOST_PAIRING_TOKEN: 'tok-dl', HOAI_BROWSER_HOST_BACKEND_URL: relay.backendUrl, HOAI_BROWSER_HOST_ASSISTANT_ID: '900', HOAI_BROWSER_HOST_PARENT_PID: String(process.pid), HOAI_BROWSER_HOST_STOP_ON_STDIN_EOF: '1' } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    child.stderr!.on('data', (c: Buffer) => logs.push(c.toString()))
    const hostLog = () => logs.join('') || '(no host log)'
    // Every file under the home holding one of this run's markers, and where.
    const markerFiles = (key?: CaseKey) =>
      walk(home).filter((p) => {
        try {
          const st = statSync(p)
          if (st.size > 65_536) return false
          const body = readFileSync(p, 'utf8')
          return key ? body.includes(CASES[key].marker) : Object.values(CASES).some((c) => body.includes(c.marker))
        } catch {
          return false
        }
      })
    const where = () => markerFiles().map((p) => relative(home, p)).join(', ') || '(none)'
    const cardsOf = (kind: string) => relay.gateCards.filter((c) => c.kind === kind)

    let bodyPassed = false
    try {
      const sock = await relay.waitForHost(30_000)
      let id = 0
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const { post } = await relay.rpc(sock, { assistantId: 900, clientId: 'shim-dl', message: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } }, 110_000)
        assert.ok(post && post.body.ok === true, `answered: ${name}\n${hostLog()}`)
        const result = post.body.message.result
        return { isError: result.isError === true, text: (result.content ?? []).map((c: any) => c.text ?? '').join('\n') }
      }
      await relay.rpc(sock, { assistantId: 900, clientId: 'shim-dl', message: { jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hoai-browser-mcp', version: '0' } } } })
      const nav = await call('browser_navigate', { url: `${site.url}/` })
      assert.equal(nav.isError, false, `${nav.text}\n${nav.isError ? vaultProbe(home, env) : ''}\n--- host log ---\n${hostLog()}`)
      const status = async () => (await call('hoai_browser_status')).text
      const click = async (key: CaseKey) => {
        const snap = await call('browser_snapshot')
        const ref = new RegExp(`link "Get ${key}" \\[ref=(e\\d+)\\]`).exec(snap.text)?.[1]
        assert.ok(ref, `the ${key} link is on the page:\n${snap.text}`)
        const before = cardsOf('download').length
        const clicked = await call('browser_click', { target: ref, element: `Get ${key} link` })
        assert.equal(clicked.isError, false, clicked.text)
        await waitFor(
          () => cardsOf('download').length > before,
          () => `a download card for ${CASES[key].name}. Cards posted: ${relay.gateCards.map((c) => c.kind).join(', ')}. Files holding this run's bytes: ${where()}. The click told the agent:\n${clicked.text}`,
        )
        assert.equal(site.hits(key), 1, `Chrome fetched ${key} once`)
        return { card: cardsOf('download').at(-1)!, clicked }
      }

      // ── 1. DENY: the owner says no. No byte of it is left anywhere. ──────────
      downloadAnswers.push({ state: 'answered', choice: 'deny' })
      const denied = await click('deny')
      assert.match(denied.card.summary, new RegExp(`^download ${escapeRe(CASES.deny.name)}`), 'the owner is asked about this file by name')
      assert.deepEqual(denied.card.choices, ['allow_once', 'allow_session', 'trust_site', 'deny'], "the desktop's download choices (policy.gateChoices)")
      assert.equal(denied.card.origin, site.url, 'the card names the site the file came from')
      assert.match(denied.clicked.text, /your owner is asked/, `the click tells the agent the owner is asked:\n${denied.clicked.text}`)
      assert.doesNotMatch(denied.clicked.text, /Downloaded file/, 'never the Playwright line that hands the agent a path')
      await waitFor(async () => /Deny_\w+\.p8.*your owner said no/.test(await status()), async () => `status reads the Deny:\n${await status()}`)
      assert.deepEqual(markerFiles('deny'), [], `a denied download leaves no file: ${where()}`)

      // ── 2. NO ANSWER: the card expires. Kept for the owner, owner only. ──────
      downloadAnswers.push({ state: 'expired', choice: null }, null)
      const unanswered = await click('kept')
      const display = `~/.bgos-agent/900/browser-output/owner`
      assert.match(unanswered.card.summary, /If you don't answer, the file is kept for you/, 'the ask says what no answer does')
      await waitFor(() => cardsOf('download').length >= 3, () => `the owner is told the moment it is kept (a second card). Cards: ${JSON.stringify(cardsOf('download').map((c) => c.summary))}`)
      const keptCard = cardsOf('download').at(-1)!
      assert.match(keptCard.summary, new RegExp(`${escapeRe(CASES.kept.name)}.*kept for you`), keptCard.summary)
      assert.match(keptCard.summary, /Deny deletes it/, 'one tap deletes it')
      assert.ok(keptCard.waitSeconds > 60, 'the kept card waits longer than the ask did')
      await waitFor(async () => /AuthKey_\w+\.p8.*kept for your owner \(no answer\)/.test(await status()), async () => `status reads it as kept:\n${await status()}`)
      const statusKept = await status()
      assert.match(statusKept, /Do not download it again/, statusKept)
      const keptFiles = markerFiles('kept')
      assert.equal(keptFiles.length, 1, `exactly one copy is kept: ${where()}`)
      const keptFile = keptFiles[0]!
      assert.ok(keptFile.startsWith(join(agentDir, 'browser-downloads') + sep), `kept inside the agent's own folder: ${relative(home, keptFile)}`)
      assert.ok(!statusKept.includes(keptFile) && !statusKept.includes(relative(home, keptFile)), 'the agent is never given a kept file path')
      assertOwnerOnly(keptFile)

      // A second one nobody answers, left kept when the host stops.
      downloadAnswers.push({ state: 'expired', choice: null }, null)
      await click('stays')
      await waitFor(() => markerFiles('stays').length === 1 && cardsOf('download').length >= 5, () => `Stays is kept and its owner told: ${where()}`)

      // ── 3. DELETE: Deny on the kept card removes the kept file. ──────────────
      relay.answerGate('deny', { gateId: String(keptCard.gateId) })
      await waitFor(() => markerFiles('kept').length === 0, () => `Deny on the kept card deletes it: ${where()}`)
      await waitFor(async () => /AuthKey_\w+\.p8.*deleted by your owner/.test(await status()), async () => `status reads the delete:\n${await status()}`)

      // ── 4. ALLOW: lands exactly where the ask said, and the agent gets the path. ─
      downloadAnswers.push({ state: 'answered', choice: 'allow_once' })
      const allowed = await click('allow')
      assert.ok(allowed.card.summary.includes(display), `the ask says where an allowed file goes (${display}): ${allowed.card.summary}`)
      const landed = join(agentDir, 'browser-output', 'owner', CASES.allow.name)
      await waitFor(() => existsSync(landed), () => `the allowed file lands at ${relative(home, landed)}: ${where()}`)
      assert.ok(readFileSync(landed, 'utf8').includes(CASES.allow.marker))
      await waitFor(async () => (await status()).includes(landed), async () => `status gives the agent its path:\n${await status()}`)
      assert.deepEqual(markerFiles('allow'), [landed], `one copy, where the ask said: ${where()}`)

      // ── 5. NOTHING OUTSIDE THE AGENT FOLDER, ever. ───────────────────────────
      for (const p of markerFiles()) assert.ok(p.startsWith(agentDir + sep), `outside the agent folder: ${relative(home, p)}`)
      bodyPassed = true
    } finally {
      // The daemon's stop: close the host's stdin.
      child.stdin!.end()
      const deadline = Date.now() + 30_000
      while (child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
      if (child.exitCode === null) child.kill('SIGKILL')
      await relay.close()
      site.server.close()
    }
    if (bodyPassed) {
      assert.match(hostLog(), /stopped cleanly/, hostLog())
      // A host stop is not a Deny: the one still kept stays, owner only, and the
      // playwright folder in the temp folder never existed.
      assert.equal(markerFiles('stays').length, 1, `a host stop keeps the kept file: ${where()}`)
      assertOwnerOnly(markerFiles('stays')[0]!)
      assert.deepEqual(markerFiles('deny'), [])
      assert.deepEqual(markerFiles('kept'), [])
      for (const p of markerFiles()) assert.ok(p.startsWith(agentDir + sep), `outside the agent folder after stop: ${relative(home, p)}`)
      assert.deepEqual(readdirSync(hostTmp).filter((n) => n.startsWith('playwright-artifacts-')), [], 'no Playwright download folder in the temp folder')
    }
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
  },
)

/**
 * When the host refuses its profile folder (unsafe_profile), say why: the
 * vault's own Windows ACL step (lib/agent-browser-vault.mjs), run once with
 * the environment the daemon gives the host and once with the full one.
 */
function vaultProbe(home: string, env: Record<string, string | undefined>): string {
  if (process.platform !== 'win32') return ''
  const script = (dir: string) => `$ErrorActionPreference = 'Stop'\n$target = '${dir.replaceAll("'", "''")}'\n$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()\n$acl = New-Object System.Security.AccessControl.DirectorySecurity\n$acl.SetOwner($identity.User)\n$acl.SetAccessRuleProtection($true, $false)\n$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')\n$acl.AddAccessRule($rule)\n[System.IO.Directory]::SetAccessControl($target, $acl)\n`
  const out: string[] = []
  for (const [label, e] of [['daemon env', hostEnv(env as Record<string, string>, { platform: 'win32' })], ['full env', env]] as const) {
    const dir = join(home, `probe-${label.replace(' ', '-')}`)
    mkdirSync(dir, { recursive: true })
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: script(dir), env: e as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    out.push(`vault ACL step with the ${label}: status ${r.status} ${r.error ? `error ${r.error.message}` : ''} ${String(r.stderr || '').trim().slice(0, 600)}`)
  }
  return out.join('\n')
}

/** Owner only, read from the real file system: 0600 in a 0700 folder off Windows; on Windows an ACL of the user's SID alone with no inherited entry above the kept folder. */
function assertOwnerOnly(file: string) {
  const dir = join(file, '..')
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o077, 0, `${file} is owner only`)
    assert.equal(statSync(dir).mode & 0o077, 0, `${dir} is owner only`)
    return
  }
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim()
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(who)?.[1]
  assert.ok(sid, 'the current user SID')
  for (const target of [file, dir]) {
    const sddl = sddlOf(target)
    const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!)
    assert.ok(aces.length > 0, `${target} has an ACL: ${sddl}`)
    for (const ace of aces) assert.ok(ace.endsWith(`;;;${sid}`) && ace.startsWith('A;'), `${target}: only the user may open it, found ${ace} in ${sddl}`)
  }
  // The guarded folder itself does not inherit from above it.
  let guarded = dir
  while (!guarded.endsWith(`${sep}browser-downloads`)) guarded = join(guarded, '..')
  assert.match(sddlOf(guarded), /^D:P/, `${guarded} is protected from inheritance`)
}

function sddlOf(target: string): string {
  const saved = join(tmpdir(), `acl-${randomBytes(6).toString('hex')}.txt`)
  try {
    const r = spawnSync('icacls.exe', [target, '/save', saved], { encoding: 'utf8' })
    assert.equal(r.status, 0, `icacls /save ${target}: ${r.stdout} ${r.stderr}`)
    const lines = readFileSync(saved).toString('utf16le').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
    return (lines[1] || '').trim()
  } finally {
    rmSync(saved, { force: true })
  }
}

async function startDownloadSite() {
  const counts = new Map<string, number>()
  const server = createServer((req, res) => {
    const m = /^\/f\/(\w+)$/.exec(req.url ?? '')
    const key = m?.[1] as CaseKey | undefined
    if (key && key in CASES) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const c = CASES[key]
      const body = `-----BEGIN PRIVATE KEY-----\n${c.marker}\n-----END PRIVATE KEY-----\n`
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${c.name}"`, 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><title>Files</title><body><h1>Files</h1>${Object.keys(CASES).map((k) => `<p><a href="/f/${k}">Get ${k}</a></p>`).join('')}</body></html>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: (key: string) => counts.get(key) ?? 0 }
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

async function waitFor(ok: () => boolean | Promise<boolean>, what: () => string | Promise<string>, timeoutMs = 25_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${await what()}`)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
