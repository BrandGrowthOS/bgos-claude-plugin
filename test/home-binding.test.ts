/**
 * Home-folder identity binding tests (board 01a068f7).
 *
 * THE DEFECT UNDER TEST. On a host with one paired agent, every process under
 * that OS user resolves to that agent's credentials by elimination, so a
 * `claude` session started in any folder becomes that agent and answers in its
 * name. The 0.38.6 pairing lock guarantees one daemon per pairing but not the
 * RIGHT one, so it cannot close this.
 *
 * The tests below pin the three properties that make the binding safe to roll
 * to a live fleet, because each one is a way this could take the fleet down:
 *   - explicit pins are never refused (the env-pinned Windows hosts),
 *   - an agent with no home keeps starting rather than refusing (upgrade safety),
 *   - the kill-switch works (a wedge is one variable from cleared).
 * and the one property that makes it worth shipping: a session in a foreign
 * folder REFUSES instead of speaking as the agent.
 *
 * 0.65.0 (board fc75c7c3) adds who may WRITE the home: pairing (homeSource
 * 'pairing') and a start from the agent's pinned folder ('pin'). A daemon that
 * found its identity by elimination never writes it, and a home with no source
 * (written up to 0.64.3) is unconfirmed. test/identity-race.test.ts drives the
 * race end to end.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  confirmHomeDir,
  decideHomeBinding,
  formatHomeBindingRefusal,
  formatNoHomeWarning,
  homeCheckPassed,
  homeStepWhileHolding,
  isHomeConfirmed,
  lockRouteFor,
  normalizeHomeDir,
  readFolderPinId,
  ALLOW_ANY_FOLDER_ENV,
  FOLDER_PIN_FILE,
  type HomeBindingDecision,
} from '../lib/agent-credentials.ts'

const HOME = '/Users/kc/agents/ares'
const STRAY = '/Users/kc/BGOS'

// ── The defect itself ────────────────────────────────────────────────────────

test('a session in a foreign folder refuses instead of answering as the agent', () => {
  for (const via of ['sole-per-assistant', 'legacy'] as const) {
    const d = decideHomeBinding({
      via,
      cwd: STRAY,
      recordedHomeDir: HOME,
      assistantId: '1040',
      platform: 'linux',
    })
    assert.equal(d.action, 'refuse', `via ${via} must refuse a foreign folder`)
    if (d.action === 'refuse') {
      assert.equal(d.recordedHomeDir, HOME)
      assert.equal(d.cwd, STRAY)
      assert.equal(d.assistantId, '1040')
    }
  }
})

test('the agent booting from its own folder is allowed', () => {
  const d = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: HOME,
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.deepEqual(d, { action: 'allow', reason: 'match' })
})

// ── The three fleet-safety properties ────────────────────────────────────────

test('explicit per-process pins are never constrained, whatever the folder', () => {
  // The 12-agent env-pinned Windows host: it launches from anywhere and must
  // keep booting. An explicit pin IS an identity signal; nothing to second-guess.
  for (const via of ['env-path', 'env-assistant', 'folder-pin'] as const) {
    const d = decideHomeBinding({
      via,
      cwd: STRAY,
      recordedHomeDir: HOME,
      platform: 'linux',
    })
    assert.deepEqual(d, { action: 'allow', reason: 'explicit-pin' }, `via ${via}`)
  }
})

test('an elimination start with no home still starts, but claims nothing and has not passed the check', () => {
  // Upgrade safety: an agent with no home must keep starting, so this is
  // never refuse. Until 0.64.3 it was 'record': the first daemon to hold the
  // channel for 60 s claimed its own folder, and on a one agent computer that
  // was whichever stray booted first while the agent was down (fc75c7c3).
  for (const via of ['sole-per-assistant', 'legacy'] as const) {
    const d = decideHomeBinding({ via, cwd: STRAY, recordedHomeDir: null, platform: 'linux' })
    assert.deepEqual(d, { action: 'allow', reason: 'no-home' }, `via ${via}`)
    assert.equal(homeCheckPassed(d), false, 'no home to compare against is not a passed check')
  }
})

test('the kill-switch clears the binding for one boot', () => {
  for (const value of ['1', 'true', 'TRUE']) {
    const d = decideHomeBinding({
      via: 'sole-per-assistant',
      cwd: STRAY,
      recordedHomeDir: HOME,
      env: { [ALLOW_ANY_FOLDER_ENV]: value },
      platform: 'linux',
    })
    assert.deepEqual(d, { action: 'allow', reason: 'override' }, `value ${value}`)
  }
  // An unrelated value must NOT disable the guard.
  const off = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: STRAY,
    recordedHomeDir: HOME,
    env: { [ALLOW_ANY_FOLDER_ENV]: '0' },
    platform: 'linux',
  })
  assert.equal(off.action, 'refuse')
})

// ── False-refusal guards (a guard that fires wrongly gets disabled) ──────────

test('a trailing separator or a case difference is not a foreign folder', () => {
  const withSlash = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: `${HOME}/`,
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.equal(withSlash.action, 'allow')

  // Windows and macOS are case-insensitive; Linux is not, and must stay strict.
  const winCase = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: 'C:\\Agents\\Ares',
    recordedHomeDir: 'c:\\agents\\ares',
    platform: 'win32',
  })
  assert.equal(winCase.action, 'allow')

  const linuxCase = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: '/agents/Ares',
    recordedHomeDir: '/agents/ares',
    platform: 'linux',
  })
  assert.equal(linuxCase.action, 'refuse')
})

test('an empty launch folder allows rather than fails closed', () => {
  // No cwd says nothing about identity, so refusing on it would be a guard
  // firing on a condition it cannot actually read.
  const d = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: '',
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.deepEqual(d, { action: 'allow', reason: 'no-cwd' })
})

test('normalizeHomeDir keeps a root path from collapsing to nothing', () => {
  assert.equal(normalizeHomeDir('/', { platform: 'linux' }), '/')
  assert.equal(normalizeHomeDir('  ', { platform: 'linux' }), '')
})

// ── The refusal message has to be actionable without reading the source ──────

test('the refusal names the agent, both folders, and every escape', () => {
  const d = decideHomeBinding({
    via: 'legacy',
    cwd: STRAY,
    recordedHomeDir: HOME,
    assistantId: '1040',
    platform: 'linux',
  })
  const msg = formatHomeBindingRefusal(d)
  assert.match(msg, /1040/)
  assert.ok(msg.includes(HOME), 'names the home folder')
  assert.ok(msg.includes(STRAY), 'names the folder it was launched from')
  assert.ok(msg.includes(FOLDER_PIN_FILE), 'names the folder-pin escape')
  assert.match(msg, /BGOS_ASSISTANT_ID/)
  assert.match(msg, new RegExp(ALLOW_ANY_FOLDER_ENV))
  assert.equal(formatHomeBindingRefusal({ action: 'allow', reason: 'match' }), '')
})

// ── Rule 3: elimination never writes a home ─────────────────────────────────

/** A credentials file in memory, so a test can see every write. */
function memoryFile(initial: Record<string, unknown>) {
  let text = `${JSON.stringify(initial, null, 2)}\n`
  const writes: string[] = []
  return {
    io: {
      readText: () => text,
      writeFile: (_path: string, data: string) => {
        writes.push(data)
        text = data
      },
    },
    writes,
    json: () => JSON.parse(text) as Record<string, unknown>,
  }
}

const PAIRED = {
  backendUrl: 'https://api.example.test',
  pairingToken: 'secret-token-value',
  pairingId: 113,
  userId: 'user_abc',
  assistantId: 1040,
  pairedAt: '2026-08-01T00:00:00.000Z',
}

test('a daemon that found its identity by elimination never writes the home, however long it holds the channel', () => {
  const homes: Array<Record<string, unknown>> = [
    {},
    { homeDir: HOME },
    { homeDir: HOME, homeSource: 'pairing' },
    { homeDir: HOME, homeSource: 'pin' },
  ]
  for (const via of ['sole-per-assistant', 'legacy'] as const) {
    for (const home of homes) {
      const file = memoryFile({ ...PAIRED, ...home })
      const binding = decideHomeBinding({
        via,
        cwd: HOME,
        recordedHomeDir: (home.homeDir as string) ?? null,
        recordedHomeSource: (home.homeSource as string) ?? null,
        platform: 'linux',
      })
      const step = homeStepWhileHolding({ binding, path: '/creds.json', io: file.io })
      assert.equal(step.wrote, null, `via ${via}, home ${JSON.stringify(home)}`)
      assert.equal(step.done, true, 'nothing is left for an elimination start to do')
      assert.deepEqual(file.writes, [], `via ${via}, home ${JSON.stringify(home)}: not one write`)
    }
  }
})

// ── Rule 2: a pinned start confirms an unconfirmed home ─────────────────────

test('a home written up to 0.64.3 (no homeSource) is unconfirmed; pairing and pin are the only sources', () => {
  assert.equal(isHomeConfirmed({ homeDir: HOME, homeSource: 'pairing' }), true)
  assert.equal(isHomeConfirmed({ homeDir: HOME, homeSource: 'pin' }), true)
  assert.equal(isHomeConfirmed({ homeDir: HOME }), false, 'the 0.64.3 self-record')
  assert.equal(isHomeConfirmed({ homeDir: HOME, homeSource: 'elimination' }), false)
  assert.equal(isHomeConfirmed({ homeDir: HOME, homeSource: 'PIN' }), false, 'exact words only')
  assert.equal(isHomeConfirmed({ homeDir: '  ', homeSource: 'pairing' }), false, 'a source with no folder')
  assert.equal(isHomeConfirmed(null), false)
})

test('a daemon started from its pinned folder confirms an unconfirmed home with its own folder', () => {
  const cases: Array<{ name: string; home: Record<string, unknown> }> = [
    { name: 'no home yet (every pinned agent before this release)', home: {} },
    { name: 'a 0.64.3 self-record elsewhere (the Ares case)', home: { homeDir: STRAY } },
    { name: 'a 0.64.3 self-record of this same folder', home: { homeDir: HOME } },
    { name: 'a source this version does not know', home: { homeDir: STRAY, homeSource: 'guess' } },
  ]
  for (const { name, home } of cases) {
    const binding = decideHomeBinding({
      via: 'folder-pin',
      cwd: HOME,
      recordedHomeDir: (home.homeDir as string) ?? null,
      recordedHomeSource: (home.homeSource as string) ?? null,
      folderPinId: '1040',
      assistantId: '1040',
      platform: 'linux',
    })
    assert.deepEqual(binding, { action: 'confirm', homeDir: HOME }, name)
    assert.equal(homeCheckPassed(binding), true, `${name}: a pinned start is the agent`)
    const file = memoryFile({ ...PAIRED, ...home })
    // At once, on the first held tick: the pin is the proof, so no 60 s filter.
    const step = homeStepWhileHolding({ binding, path: '/creds.json', io: file.io })
    assert.deepEqual(step, { done: true, wrote: HOME }, name)
    const after = file.json()
    assert.equal(after.homeDir, HOME, name)
    assert.equal(after.homeSource, 'pin', name)
    for (const [k, v] of Object.entries(PAIRED)) assert.deepEqual(after[k], v, `${name}: field ${k} survives`)
  }
})

test('a pinned start never moves a confirmed home', () => {
  for (const homeSource of ['pairing', 'pin']) {
    const binding = decideHomeBinding({
      via: 'folder-pin',
      cwd: HOME,
      recordedHomeDir: STRAY,
      recordedHomeSource: homeSource,
      folderPinId: '1040',
      assistantId: '1040',
      platform: 'linux',
    })
    assert.deepEqual(binding, { action: 'allow', reason: 'explicit-pin' }, homeSource)
    const file = memoryFile({ ...PAIRED, homeDir: STRAY, homeSource })
    homeStepWhileHolding({ binding, path: '/creds.json', io: file.io })
    assert.deepEqual(file.writes, [], `${homeSource}: not one write`)
  }
})

test('confirmHomeDir re-reads the file and never overwrites a home confirmed meanwhile', () => {
  // A re-pair landed between boot and the first held tick.
  const file = memoryFile({ ...PAIRED, homeDir: STRAY, homeSource: 'pairing' })
  assert.equal(confirmHomeDir({ path: '/creds.json', homeDir: HOME, io: file.io }), false)
  assert.deepEqual(file.writes, [])
})

test('confirmHomeDir writes to the real file with every field kept, and degrades quietly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-binding-'))
  try {
    const path = join(dir, 'credentials-1040.json')
    writeFileSync(path, JSON.stringify({ ...PAIRED, homeDir: STRAY }, null, 2))
    assert.equal(confirmHomeDir({ path, homeDir: HOME }), true)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(after.homeDir, HOME)
    assert.equal(after.homeSource, 'pin')
    for (const [k, v] of Object.entries(PAIRED)) assert.deepEqual(after[k], v, `field ${k}`)
    // Confirmed now, so a second call is a no-op.
    assert.equal(confirmHomeDir({ path, homeDir: STRAY }), false)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).homeDir, HOME)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // A missing or read-only file leaves the agent working: a guard that cannot
  // write must never fail the boot.
  assert.equal(confirmHomeDir({ path: join(tmpdir(), 'definitely-absent-creds.json'), homeDir: HOME }), false)
  assert.equal(
    confirmHomeDir({
      path: '/x',
      homeDir: HOME,
      io: {
        readText: () => '{"assistantId":1040}',
        writeFile: () => {
          throw new Error('EROFS')
        },
      },
    }),
    false,
  )
  assert.equal(confirmHomeDir({ path: '/x', homeDir: '   ' }), false)
})

test('a pin naming another agent than the file it resolved confirms nothing', () => {
  const binding = decideHomeBinding({
    via: 'folder-pin',
    cwd: HOME,
    recordedHomeDir: null,
    folderPinId: '1040',
    assistantId: '999',
    platform: 'linux',
  })
  assert.deepEqual(binding, { action: 'allow', reason: 'explicit-pin' })
})

// ── Rule 6: the env route keeps working; it confirms only with the folder pin ─

test('an env route is never refused, and confirms a home only when its folder carries the same agent pin', () => {
  for (const via of ['env-assistant', 'env-path'] as const) {
    // No pin in the folder: the env var says which agent, never where it lives.
    // It is inherited by every child process in any folder, so it cannot name a home.
    const bare = decideHomeBinding({ via, cwd: STRAY, recordedHomeDir: null, folderPinId: '', assistantId: '1040', platform: 'linux' })
    assert.deepEqual(bare, { action: 'allow', reason: 'explicit-pin' }, `${via}, no pin`)
    assert.equal(homeCheckPassed(bare), true, `${via}: an explicit route is the agent`)
    // Its folder carries the pin for the same agent (the Windows logon task in
    // the agent folder): that pin is the location proof.
    const pinned = decideHomeBinding({ via, cwd: HOME, recordedHomeDir: STRAY, folderPinId: '1040', assistantId: '1040', platform: 'linux' })
    assert.deepEqual(pinned, { action: 'confirm', homeDir: HOME }, `${via}, same agent pin`)
    // A pin for a different agent proves nothing about this one.
    const other = decideHomeBinding({ via, cwd: HOME, recordedHomeDir: null, folderPinId: '777', assistantId: '1040', platform: 'linux' })
    assert.deepEqual(other, { action: 'allow', reason: 'explicit-pin' }, `${via}, other agent pin`)
    // And a confirmed home elsewhere does not stop it.
    const confirmed = decideHomeBinding({ via, cwd: STRAY, recordedHomeDir: HOME, recordedHomeSource: 'pairing', folderPinId: '', assistantId: '1040', platform: 'linux' })
    assert.equal(confirmed.action, 'allow', `${via} is never refused`)
  }
})

// ── The home check, for every outcome ────────────────────────────────────────

test('homeCheckPassed: a pin, a match, the override or a confirm pass; no home, no folder or a refusal do not', () => {
  const table: Array<[HomeBindingDecision, boolean]> = [
    [{ action: 'allow', reason: 'explicit-pin' }, true],
    [{ action: 'allow', reason: 'match' }, true],
    [{ action: 'allow', reason: 'override' }, true],
    [{ action: 'confirm', homeDir: HOME }, true],
    [{ action: 'allow', reason: 'no-home' }, false],
    [{ action: 'allow', reason: 'no-cwd' }, false],
    [{ action: 'refuse', recordedHomeDir: HOME, recordedHomeSource: 'pairing', cwd: STRAY, assistantId: '1' }, false],
  ]
  for (const [decision, passed] of table) assert.equal(homeCheckPassed(decision), passed, JSON.stringify(decision))
})

test('an elimination start is checked against a confirmed and an unconfirmed home alike', () => {
  for (const recordedHomeSource of [null, 'pairing', 'pin']) {
    const match = decideHomeBinding({ via: 'sole-per-assistant', cwd: HOME, recordedHomeDir: HOME, recordedHomeSource, platform: 'linux' })
    assert.deepEqual(match, { action: 'allow', reason: 'match' }, String(recordedHomeSource))
    const away = decideHomeBinding({ via: 'sole-per-assistant', cwd: STRAY, recordedHomeDir: HOME, recordedHomeSource, platform: 'linux' })
    assert.equal(away.action, 'refuse', String(recordedHomeSource))
  }
})

test('the refusal says where the home came from and how to fix it without editing a file', () => {
  const confirmed = decideHomeBinding({ via: 'sole-per-assistant', cwd: STRAY, recordedHomeDir: HOME, recordedHomeSource: 'pairing', assistantId: '1040', platform: 'linux' })
  const msg = formatHomeBindingRefusal(confirmed)
  assert.match(msg, /paired/)
  assert.match(msg, /hoai pair/)
  assert.doesNotMatch(msg, /editing homeDir/, 'no hand edits of a credentials file')
  const old = decideHomeBinding({ via: 'sole-per-assistant', cwd: STRAY, recordedHomeDir: HOME, assistantId: '1040', platform: 'linux' })
  assert.match(formatHomeBindingRefusal(old), /unconfirmed/)
})

// ── The lock route and the folder pin reader ─────────────────────────────────

test('the boot warning names an elimination start with no home, and only that', () => {
  const warn = formatNoHomeWarning({ action: 'allow', reason: 'no-home' }, '1040')
  assert.match(warn, /agent 1040/)
  assert.match(warn, /resume pin/)
  assert.match(warn, /pinned folder/)
  assert.match(warn, /hoai pair/)
  for (const other of [
    { action: 'allow', reason: 'match' },
    { action: 'allow', reason: 'explicit-pin' },
    { action: 'allow', reason: 'no-cwd' },
    { action: 'confirm', homeDir: HOME },
  ] as HomeBindingDecision[]) {
    assert.equal(formatNoHomeWarning(other, '1040'), '', JSON.stringify(other))
  }
})

test('lockRouteFor names how a daemon found its identity in one word', () => {
  assert.equal(lockRouteFor('folder-pin'), 'pin')
  assert.equal(lockRouteFor('env-assistant'), 'env')
  assert.equal(lockRouteFor('env-path'), 'env')
  assert.equal(lockRouteFor('sole-per-assistant'), 'elimination')
  assert.equal(lockRouteFor('legacy'), 'elimination')
})

test('readFolderPinId reads the digits in <folder>/.bgos-agent-id and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-binding-pin-'))
  try {
    assert.equal(readFolderPinId(dir), '')
    writeFileSync(join(dir, FOLDER_PIN_FILE), '1040\n')
    assert.equal(readFolderPinId(dir), '1040')
    writeFileSync(join(dir, FOLDER_PIN_FILE), 'not-an-id')
    assert.equal(readFolderPinId(dir), '')
    assert.equal(readFolderPinId(''), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
