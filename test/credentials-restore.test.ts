/**
 * A daemon writes back a lost credentials file from the pairing token it still holds (stability,
 * 2026-11-14).
 *
 * What happened 2026-11-13: an accident deleted ~/.bgos-agent/credentials-<id>.json for every agent
 * on a Mac. Every daemon kept running on the pairing token in memory, but a restart of any of them
 * would have come up unpaired, and the Helper read the missing file as "agent not on this machine"
 * and refused its check up. Recovery took a token rotation per agent by hand.
 *
 * lib/credentials-restore.ts runs on the auth recheck cadence. When the file this daemon booted
 * from is gone AND the backend still accepts the in-memory token for this same assistant
 * (GET integrations/me answers 200 and lists it), it writes the file back with bgos-pair's own
 * writeCredentialsFile (mode 0600, exclusive create), logs one WARN naming the path and posts
 * nothing. It never overwrites a file, never writes on a failing token, and never writes another
 * assistant's file or the shared credentials.json.
 *
 * Run with: npx tsx --test test/credentials-restore.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCredentialsFile, resolveAuth, type CredentialsFile } from '../lib/agent-credentials.ts'
import {
  CredentialsFileRestorer,
  meVouchesFor,
  restoreEligibility,
  restoredCredentials,
  type CredentialsRestoreDeps,
} from '../lib/credentials-restore.ts'
import { writeCredentialsFile } from '../bin/bgos-pair.mjs'

const TOKEN = 'bgp_secret_pairing_token_871_do_not_log'
const BACKEND = 'https://api.example.test/api/v1'

function paired(assistantId: number | string, extra: Partial<CredentialsFile> = {}): CredentialsFile {
  return {
    backendUrl: BACKEND,
    pairingToken: TOKEN,
    pairingId: 144,
    userId: 'user_1',
    assistantId,
    pairedAt: '2026-11-01T08:00:00.000Z',
    homeDir: '/agents/ares',
    homeSource: 'pairing',
    ...extra,
  }
}

function tempAgentDir(): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'creds-restore-')))
  const dir = join(root, '.bgos-agent')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { root, dir }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

const ME_871 = { pairing_id: 144, user_id: 'user_1', assistants: [{ assistant_id: 871, name: 'Ares' }] }

/** A restorer over the real file system, with the real exclusive writer and a stand in backend. */
function rig(opts: {
  path: string
  via?: string
  creds?: CredentialsFile | null
  env?: Record<string, string>
  me?: () => Promise<{ status: number; body: unknown }>
}) {
  const creds = opts.creds === undefined ? paired(871) : opts.creds
  const auth = resolveAuth({ env: opts.env ?? {}, creds })
  const logs: string[] = []
  let probes = 0
  const deps: CredentialsRestoreDeps = {
    path: opts.path,
    via: opts.via ?? 'folder-pin',
    auth,
    bootCreds: creds,
    exists: existsSync,
    readCreds: loadCredentialsFile,
    probeMe: async () => {
      probes += 1
      return opts.me ? opts.me() : { status: 200, body: ME_871 }
    },
    writeExclusive: async (path, value) => {
      await writeCredentialsFile(path, value, { exclusive: true })
    },
    log: (line) => logs.push(line),
  }
  return { restorer: new CredentialsFileRestorer(deps), logs, probes: () => probes }
}

test('a deleted credentials file is written back with mode 0600 and the right assistant while the token is valid', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    writeJson(path, paired(871))
    const r = rig({ path })
    assert.equal(await r.restorer.check(), 'present')
    rmSync(path)

    assert.equal(await r.restorer.check(), 'restored')
    assert.ok(existsSync(path), 'the file is back')
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    const back = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(back, paired(871), 'the same shape bgos-pair writes, with this agent\'s own values')
    assert.equal(back.assistantId, 871)
    assert.equal(r.probes(), 1, 'one integrations/me check decided it')

    const warns = r.logs.filter((l) => l.startsWith('WARN'))
    assert.equal(warns.length, 1, r.logs.join('\n'))
    assert.ok(warns[0]!.includes(path), 'the WARN names the path')
    assert.ok(!r.logs.join('\n').includes(TOKEN), 'no token is ever logged')

    // Back to quiet: the next check sees the file and probes nothing.
    assert.equal(await r.restorer.check(), 'present')
    assert.equal(r.probes(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the whole .bgos-agent folder gone: the folder comes back at 0700 and the file at 0600', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    writeJson(path, paired(871))
    const r = rig({ path })
    await r.restorer.check()
    rmSync(dir, { recursive: true, force: true })
    assert.equal(await r.restorer.check(), 'restored')
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failing token restores nothing: 401, a 5xx, no answer, or a 200 that does not list this assistant', async () => {
  const answers: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
    ['401', async () => ({ status: 401, body: { message: 'Unauthorized' } })],
    ['503', async () => ({ status: 503, body: {} })],
    ['no answer', async () => { throw new Error('fetch failed') }],
    ['200 for another agent', async () => ({ status: 200, body: { assistants: [{ assistant_id: 935 }] } })],
    ['200 with no list', async () => ({ status: 200, body: {} })],
  ]
  for (const [label, me] of answers) {
    const { root, dir } = tempAgentDir()
    try {
      const path = join(dir, 'credentials-871.json')
      const r = rig({ path, me })
      assert.equal(await r.restorer.check(), 'token-refused', label)
      assert.equal(existsSync(path), false, `${label}: nothing was written`)
      // Said once, not every recheck.
      await r.restorer.check()
      assert.equal(r.logs.length, 1, `${label}: ${r.logs.join('\n')}`)
      assert.ok(!r.logs[0]!.startsWith('WARN credentials file restored'), label)
      assert.ok(!r.logs.join('\n').includes(TOKEN), label)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('an existing file is never touched: not read into a write, not probed, byte for byte the same', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    // A re-pair landed after boot: a different token, a different pairing.
    const newer = paired(871, { pairingToken: 'bgp_newer_token', pairingId: 200 })
    writeJson(path, newer)
    const before = readFileSync(path)
    const mtime = statSync(path).mtimeMs
    const r = rig({ path })
    assert.equal(await r.restorer.check(), 'present')
    assert.equal(r.probes(), 0)
    assert.deepEqual(readFileSync(path), before)
    assert.equal(statSync(path).mtimeMs, mtime)
    assert.deepEqual(r.logs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that comes back while the token is being checked is never overwritten', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    const repaired = paired(871, { pairingToken: 'bgp_repaired_token', pairingId: 201 })
    const r = rig({
      path,
      me: async () => {
        // bgos-pair writes the new pairing while the daemon's probe is in flight.
        writeJson(path, repaired)
        return { status: 200, body: ME_871 }
      },
    })
    assert.equal(await r.restorer.check(), 'raced')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), repaired)
    assert.equal(r.logs.filter((l) => l.startsWith('WARN')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the exclusive writer itself refuses an existing file', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    writeJson(path, paired(871, { pairingToken: 'bgp_keep_me' }))
    await assert.rejects(writeCredentialsFile(path, paired(871), { exclusive: true }), { code: 'EEXIST' })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pairingToken, 'bgp_keep_me')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file for another assistant is untouched, and never written for this one', async () => {
  const { root, dir } = tempAgentDir()
  try {
    // Ares (871) lost its file; Iris (935) still has hers. Only 871's comes back.
    const ours = join(dir, 'credentials-871.json')
    const theirs = join(dir, 'credentials-935.json')
    writeJson(theirs, paired(935, { pairingToken: 'bgp_iris_token', pairingId: 145 }))
    const irisBefore = readFileSync(theirs)
    const r = rig({ path: ours })
    assert.equal(await r.restorer.check(), 'restored')
    assert.deepEqual(readFileSync(theirs), irisBefore, "the other agent's file is byte for byte the same")
    assert.equal(JSON.parse(readFileSync(ours, 'utf8')).assistantId, 871)

    // A daemon whose boot path names ANOTHER assistant (an env path pointing at Iris's file while
    // the daemon runs as Ares) never writes it, even with a valid token.
    rmSync(theirs)
    const wrong = rig({ path: theirs, via: 'env-path' })
    assert.equal(await wrong.restorer.check(), 'ineligible')
    assert.equal(existsSync(theirs), false)
    assert.equal(wrong.probes(), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the shared credentials.json is never restored: bgos-pair deletes it on purpose when it moves an agent to its own file', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const legacy = join(dir, 'credentials.json')
    const r = rig({ path: legacy, via: 'legacy' })
    assert.equal(await r.restorer.check(), 'ineligible')
    assert.equal(existsSync(legacy), false)
    assert.equal(r.probes(), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('only a daemon that booted from a pairing file restores one', () => {
  const path = '/home/agent/.bgos-agent/credentials-871.json'
  const fromFile = resolveAuth({ env: {}, creds: paired(871) })
  assert.deepEqual(restoreEligibility({ path, via: 'folder-pin', auth: fromFile }), { kind: 'eligible' })
  assert.deepEqual(restoreEligibility({ path: '/x/custom.json', via: 'env-path', auth: fromFile }), { kind: 'eligible' })

  const fromEnv = resolveAuth({
    env: { BGOS_PAIRING_TOKEN: TOKEN, BGOS_ASSISTANT_ID: '871', BGOS_BACKEND_URL: BACKEND, BGOS_USER_ID: 'u' },
    creds: null,
  })
  assert.equal(restoreEligibility({ path, via: 'env-assistant', auth: fromEnv }).kind, 'ineligible')
  const apiKey = resolveAuth({
    env: { BGOS_API_KEY: 'ak', BGOS_ASSISTANT_ID: '871', BGOS_BACKEND_URL: BACKEND, BGOS_USER_ID: 'u' },
    creds: null,
  })
  assert.equal(restoreEligibility({ path, via: 'env-assistant', auth: apiKey }).kind, 'ineligible')
  const none = resolveAuth({ env: {}, creds: null })
  assert.equal(restoreEligibility({ path, via: 'folder-pin', auth: none }).kind, 'ineligible')
  // A file for 871 that the daemon read as some other agent never names its own.
  assert.equal(
    restoreEligibility({ path: '/home/agent/.bgos-agent/credentials-935.json', via: 'folder-pin', auth: fromFile }).kind,
    'ineligible',
  )
})

test('integrations/me vouches only with a 200 that lists this assistant', () => {
  assert.equal(meVouchesFor(200, ME_871, '871'), true)
  assert.equal(meVouchesFor(200, { assistants: [{ assistant_id: '871' }] }, '871'), true)
  assert.equal(meVouchesFor(304, ME_871, '871'), false)
  assert.equal(meVouchesFor(401, ME_871, '871'), false)
  assert.equal(meVouchesFor(200, ME_871, '935'), false)
  assert.equal(meVouchesFor(200, null, '871'), false)
  assert.equal(meVouchesFor(200, { assistants: 'nope' }, '871'), false)
})

test('the restored body keeps a home confirmed after boot, and never takes fields from a newer pairing', () => {
  const auth = resolveAuth({ env: {}, creds: paired(871, { homeDir: '', homeSource: undefined }) })
  const boot = paired(871, { homeDir: '', homeSource: undefined })
  // Seen on disk after boot: the same pairing, with a home a pinned start confirmed.
  const seen = paired(871, { homeDir: '/agents/ares', homeSource: 'pin' })
  assert.equal(restoredCredentials({ bootCreds: boot, lastSeen: seen, auth }).homeSource, 'pin')
  // Seen on disk after boot: a NEWER pairing. The daemon cannot write its token, and does not mix
  // its fields with the token it holds: it writes back its own boot file.
  const newer = paired(871, { pairingToken: 'bgp_newer', pairingId: 999, homeDir: '/elsewhere', homeSource: 'pairing' })
  const body = restoredCredentials({ bootCreds: boot, lastSeen: newer, auth })
  assert.equal(body.pairingToken, TOKEN)
  assert.equal(body.pairingId, 144)
  assert.equal(body.homeDir, '')
})

test('a home confirmed on disk after boot survives the restore', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    const boot = paired(871, { homeDir: undefined, homeSource: undefined })
    delete boot.homeDir
    delete boot.homeSource
    writeJson(path, boot)
    const r = rig({ path, creds: boot })
    await r.restorer.check()
    // confirmHomeDir writes the pinned folder into the file while the daemon runs.
    writeJson(path, { ...boot, homeDir: '/agents/ares', homeSource: 'pin' })
    await r.restorer.check()
    rmSync(path)
    assert.equal(await r.restorer.check(), 'restored')
    const back = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(back.homeDir, '/agents/ares')
    assert.equal(back.homeSource, 'pin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('after a refused token the backend is asked again only after the back-off, however often the folder stirs', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    let now = 1_000_000
    let status = 401
    const logs: string[] = []
    let probes = 0
    const creds = paired(871)
    const restorer = new CredentialsFileRestorer({
      path,
      via: 'folder-pin',
      auth: resolveAuth({ env: {}, creds }),
      bootCreds: creds,
      exists: existsSync,
      readCreds: loadCredentialsFile,
      probeMe: async () => {
        probes += 1
        return { status, body: ME_871 }
      },
      writeExclusive: async (p, value) => {
        await writeCredentialsFile(p, value, { exclusive: true })
      },
      log: (line) => logs.push(line),
      now: () => now,
    })
    assert.equal(await restorer.check(), 'token-refused')
    // Lock heartbeats beside the file stir the folder watch every 5 s.
    for (let i = 0; i < 11; i += 1) {
      now += 5_000
      assert.equal(await restorer.check(), 'token-refused')
    }
    assert.equal(probes, 1, 'one probe inside the back-off')
    now += 5_000
    status = 200
    assert.equal(await restorer.check(), 'restored', 'asked again once the back-off passed')
    assert.equal(probes, 2)
    assert.ok(existsSync(path))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('overlapping checks (a file watch and the interval at once) write once', async () => {
  const { root, dir } = tempAgentDir()
  try {
    const path = join(dir, 'credentials-871.json')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const r = rig({ path, me: async () => { await gate; return { status: 200, body: ME_871 } } })
    const first = r.restorer.check()
    assert.equal(await r.restorer.check(), 'busy')
    release()
    assert.equal(await first, 'restored')
    assert.equal(r.probes(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('server.ts wiring: the recheck restores before it resolves, through bgos-pair\'s exclusive writer and a fresh integrations/me', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  const recheck = /async function runAuthRecheck\(\)[\s\S]*?const currentAuth =/.exec(src)
  assert.ok(recheck, 'runAuthRecheck is async and still resolves auth')
  assert.match(recheck[0], /await credentialsRestorer\.check\(\)[\s\S]*resolveCredentialsPath\(/, 'restore runs before the divergence check')
  const restorer = /const credentialsRestorer = new CredentialsFileRestorer\(\{[\s\S]*?\n\}\)/.exec(src)
  assert.ok(restorer, 'the restorer is built once in server.ts')
  assert.match(restorer[0], /path: CREDENTIALS_PATH,/)
  assert.match(restorer[0], /auth: AUTH,/)
  assert.match(restorer[0], /bootCreds: CREDENTIALS_FILE,/)
  assert.match(restorer[0], /writeCredentialsFile\(path, creds, \{ exclusive: true \}\)/)
  assert.match(restorer[0], /integrations\/me/)
  assert.doesNotMatch(restorer[0], /If-None-Match|bgosGetCachedOn304|bgosGet\(/, 'a fresh 200, never a cached 304')
  assert.doesNotMatch(restorer[0], /bgosPost|sendMessage|notify/i, 'it posts nothing to chat')
})
