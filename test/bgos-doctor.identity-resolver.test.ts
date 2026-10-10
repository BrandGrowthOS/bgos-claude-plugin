/**
 * resolveDoctorIdentity: the doctor's mirror of how the daemon finds its agent (0.65.2).
 *
 * The doctor is plain JavaScript and never imports a .ts source, so its identity
 * resolution is a mirror of lib/agent-credentials.ts resolveCredentialsSelection,
 * fed the env the daemon really gets: the shell's env under the agent's .mcp.json
 * env block (Claude Code hands the block to the daemon it starts). A mirror
 * drifts, so this suite pins it to the real resolver over every combination of
 * the signals that exist: an env path, an env id (with and without its file, the
 * unsubstituted placeholder), a folder pin (good, stale, junk), 0 to 3 paired
 * agents, and the legacy file. The end to end shapes are in
 * bgos-doctor.identity.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  resolveDoctorIdentity,
  probeCredentials,
  buildDoctorRows,
  preflightVerdict,
} from '../bin/bgos-doctor.mjs'
import { resolveCredentialsSelection } from '../lib/agent-credentials.ts'

const HOME = join(tmpdir(), 'doctor-resolver-fake-home')
const AGENT_DIR = join(HOME, '.bgos-agent')
const DEFAULT_PATH = join(AGENT_DIR, 'credentials.json')
const FOLDER = join(tmpdir(), 'doctor-resolver-fake-folder')

/** An in-memory file system: path -> text. Nothing here touches a disk. */
function fakeFs(files: Record<string, string>) {
  const names = Object.keys(files)
  return {
    exists: (path: string) => path in files,
    readFile: (path: string): string | null => (path in files ? files[path] : null),
    listDir: (dir: string): string[] =>
      names.filter((p) => dirname(p) === dir).map((p) => p.slice(dir.length + 1)),
  }
}

function mcpJson(env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { bgos: { command: 'bun', env: { BGOS_API_KEY: 'TESTKEY-secret', ...env } } } })
}

const NO_FILES: Record<string, string> = {}

// ── Parity with the real resolver ────────────────────────────────────────────

test('resolveDoctorIdentity agrees with the daemon resolver over every combination of signals (shell env, .mcp.json block, folder pin, paired files)', () => {
  const shellPaths = ['', join(HOME, 'elsewhere.json')]
  const shellIds = ['', '871', '999', ' 871 ', '${user_config.assistant_id}']
  const blockEnvs: Array<Record<string, string>> = [
    {},
    { BGOS_ASSISTANT_ID: '872' },
    { BGOS_ASSISTANT_ID: '999' },
    { BGOS_CREDENTIALS_PATH: join(HOME, 'block.json') },
    { BGOS_ASSISTANT_ID: '871', BGOS_CREDENTIALS_PATH: join(HOME, 'block.json') },
    // A block that sets the key to nothing, or to the unsubstituted placeholder, still
    // overrides the shell's value: the daemon is handed an empty id, not the shell's.
    { BGOS_ASSISTANT_ID: '' },
    { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' },
    { BGOS_CREDENTIALS_PATH: '' },
  ]
  const pins = ['', '871', '999', 'junk']
  const pairedSets = [[], [871], [871, 872], [871, 872, 873]]
  let combos = 0
  for (const shellPath of shellPaths)
    for (const shellId of shellIds)
      for (const block of blockEnvs)
        for (const pin of pins)
          for (const paired of pairedSets)
            for (const legacy of [false, true]) {
              const files: Record<string, string> = {}
              for (const id of paired) files[join(AGENT_DIR, `credentials-${id}.json`)] = '{}'
              if (legacy) files[DEFAULT_PATH] = '{}'
              if (pin) files[join(FOLDER, '.bgos-agent-id')] = `${pin}\n`
              const hasBlock = Object.keys(block).length > 0
              if (hasBlock) files[join(FOLDER, '.mcp.json')] = mcpJson(block)
              const fs = fakeFs(files)

              const shell: Record<string, string> = {}
              if (shellPath) shell.BGOS_CREDENTIALS_PATH = shellPath
              if (shellId) shell.BGOS_ASSISTANT_ID = shellId
              // What Claude Code starts the daemon with: the block over the shell.
              const daemonEnv = { ...shell, ...block }

              const daemon = resolveCredentialsSelection({
                env: daemonEnv,
                defaultPath: DEFAULT_PATH,
                cwd: FOLDER,
                exists: fs.exists,
                readText: fs.readFile,
                listDir: fs.listDir,
              })
              const doctor = resolveDoctorIdentity({ env: shell, home: HOME, folder: FOLDER, ...fs })

              const label = JSON.stringify({ shell, block, pin, paired, legacy })
              if (daemon.kind === 'refuse') {
                assert.equal(doctor.via, 'refuse', label)
                assert.deepEqual(doctor.candidateIds, daemon.candidateIds, label)
                assert.equal(doctor.path, '', label)
              } else {
                assert.equal(doctor.via, daemon.via, label)
                assert.equal(doctor.path, daemon.path, label)
              }
              combos++
            }
  assert.equal(combos, shellPaths.length * shellIds.length * blockEnvs.length * pins.length * pairedSets.length * 2)
  assert.equal(combos, 2560, 'the changelog and the PR quote this number')
})

// ── What the handshake child is handed ───────────────────────────────────────

test('the child is handed what Claude Code would hand the daemon: the .mcp.json id and path, never the folder pin, never anything else from the file', () => {
  const fs = fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '867', BGOS_CREDENTIALS_PATH: join(AGENT_DIR, 'credentials-867.json') }),
  })
  const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fs })
  assert.deepEqual(id.env, { BGOS_ASSISTANT_ID: '867', BGOS_CREDENTIALS_PATH: join(AGENT_DIR, 'credentials-867.json') })
  assert.ok(!JSON.stringify(id).includes('TESTKEY'), 'the .mcp.json key must never leave the reader')

  const pinned = fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.bgos-agent-id')]: '867\n',
  })
  const byPin = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...pinned })
  assert.equal(byPin.via, 'folder-pin')
  assert.deepEqual(byPin.env, {}, 'a folder pin is found by the daemon itself, from its launch folder: nothing is injected')
  assert.equal(byPin.assistantId, '867')
})

test('--assistant-id is handed to the child as BGOS_ASSISTANT_ID and is expected in the file, but it is not how a session started in the folder would resolve', () => {
  const fs = fakeFs({
    [join(AGENT_DIR, 'credentials-871.json')]: '{}',
    [join(AGENT_DIR, 'credentials-872.json')]: '{}',
  })
  const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, assistantIdFlag: '871', ...fs })
  assert.equal(id.via, 'env-assistant')
  assert.deepEqual(id.env, { BGOS_ASSISTANT_ID: '871' })
  assert.equal(id.expectedAssistantId, '871')
  assert.equal(id.sessionVia, 'refuse', 'a bare session in this folder would still be refused')
})

test('the sole paired agent names the assistant (for the log and marker paths) but is not an expectation to check the file against', () => {
  const fs = fakeFs({ [join(AGENT_DIR, 'credentials-871.json')]: '{}' })
  const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fs })
  assert.equal(id.via, 'sole-per-assistant')
  assert.equal(id.assistantId, '871')
  assert.equal(id.expectedAssistantId, '')
})

// ── The .mcp.json reader ─────────────────────────────────────────────────────

test('a UTF-8 BOM in .mcp.json does not hide the pin (the daemon still gets it from Claude Code)', () => {
  const fs = fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: `﻿${mcpJson({ BGOS_ASSISTANT_ID: '867' })}`,
  })
  assert.equal(resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fs }).via, 'env-assistant')
})

test('two servers naming different agents is unreadable, not a guess; the same id twice is fine', () => {
  const two = fakeFs({
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: JSON.stringify({
      mcpServers: { a: { env: { BGOS_ASSISTANT_ID: '866' } }, b: { env: { BGOS_ASSISTANT_ID: '867' } } },
    }),
  })
  const conflict = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...two })
  assert.equal(conflict.via, 'unreadable')
  assert.equal(conflict.path, '')
  assert.ok(conflict.problem.includes('866') && conflict.problem.includes('867'), conflict.problem)

  const same = fakeFs({
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: JSON.stringify({
      mcpServers: { a: { env: { BGOS_ASSISTANT_ID: '866' } }, b: { env: { BGOS_ASSISTANT_ID: '866' } } },
    }),
  })
  assert.equal(resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...same }).via, 'env-assistant')
})

test('${VAR} and ${VAR:-default} in the block are expanded from the shell as Claude Code does; one that cannot be is named, not used literally', () => {
  const base = { [join(AGENT_DIR, 'credentials-867.json')]: '{}', [join(AGENT_DIR, 'credentials-866.json')]: '{}' }
  const expands = fakeFs({
    ...base,
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_CREDENTIALS_PATH: '${AGENT_HOME}/credentials-${AGENT_NUM:-867}.json' }),
  })
  const ok = resolveDoctorIdentity({ env: { AGENT_HOME: AGENT_DIR }, home: HOME, folder: FOLDER, ...expands })
  assert.equal(ok.via, 'env-path')
  assert.equal(ok.path, `${AGENT_DIR}/credentials-867.json`)

  const unset = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...expands })
  assert.equal(unset.via, 'unreadable')
  assert.ok(unset.problem.includes('AGENT_HOME'), unset.problem)
  assert.equal(unset.path, '')
})

test('a folder with no .mcp.json, an unreadable one, or one with no server of ours declares nothing', () => {
  for (const mcp of [null, '{ not json', '{}', JSON.stringify({ mcpServers: { other: { command: 'x' } } })]) {
    const files: Record<string, string> = { [join(AGENT_DIR, 'credentials-871.json')]: '{}' }
    if (mcp != null) files[join(FOLDER, '.mcp.json')] = mcp
    const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fakeFs(files) })
    assert.equal(id.via, 'sole-per-assistant', String(mcp))
  }
})

// ── Review findings (0.65.2) ─────────────────────────────────────────────────

test('a block that sets the id to nothing or to the placeholder shadows the shell, so a daemon with 7 agents would refuse and so does the doctor', () => {
  const base: Record<string, string> = {}
  for (const id of [861, 862, 863, 864, 865, 866, 867]) base[join(AGENT_DIR, `credentials-${id}.json`)] = '{}'
  for (const written of ['', '   ', '${user_config.assistant_id}']) {
    const fs = fakeFs({ ...base, [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: written }) })
    const id = resolveDoctorIdentity({ env: { BGOS_ASSISTANT_ID: '867' }, home: HOME, folder: FOLDER, ...fs })
    assert.equal(id.via, 'refuse', JSON.stringify(written))
    assert.equal(id.env.BGOS_ASSISTANT_ID, '', 'the child is handed the empty id too, not the shell value')
    assert.match(id.problem, /867/, 'the shadowed shell value is named')
  }
})

test('an id that came from a ${VAR} expansion must be a number, and the value is never printed: a block can not turn the doctor into a printer of shell variables', () => {
  const fs = fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '${SOME_SHELL_SECRET}' }),
  })
  const bad = resolveDoctorIdentity({ env: { SOME_SHELL_SECRET: 'sk-live-do-not-print' }, home: HOME, folder: FOLDER, ...fs })
  assert.equal(bad.via, 'unreadable')
  assert.ok(!JSON.stringify(bad).includes('sk-live-do-not-print'), JSON.stringify(bad))
  assert.ok(bad.problem.includes('${SOME_SHELL_SECRET}'), 'the template as written is named')

  const good = resolveDoctorIdentity({ env: { AGENT_NUM: '867' }, home: HOME, folder: FOLDER, ...fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '${AGENT_NUM}' }),
  }) })
  assert.equal(good.via, 'env-assistant')
  assert.equal(good.assistantId, '867')
})

test('a folder pin that names a different agent than the .mcp.json block is a conflict hoai refuses to launch: the identity is still the daemon\'s (the env pin), and the conflict is reported', () => {
  const fs = fakeFs({
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(FOLDER, '.bgos-agent-id')]: '866\n',
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '867' }),
  })
  const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fs })
  assert.equal(id.via, 'env-assistant')
  assert.equal(id.path, join(AGENT_DIR, 'credentials-867.json'))
  assert.ok(id.conflict.includes('866') && id.conflict.includes('867'), id.conflict)

  const agree = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fakeFs({
    [join(AGENT_DIR, 'credentials-867.json')]: '{}',
    [join(AGENT_DIR, 'credentials-866.json')]: '{}',
    [join(FOLDER, '.bgos-agent-id')]: '867\n',
    [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '867' }),
  }) })
  assert.equal(agree.conflict, '')
})

test('--assistant-id: the row says what a session started here WITHOUT the flag would do, when that differs', () => {
  const seven: Record<string, string> = {}
  for (const id of [861, 862, 863, 864, 865, 866, 867]) seven[join(AGENT_DIR, `credentials-${id}.json`)] = '{}'

  const refused = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, assistantIdFlag: '867', ...fakeFs(seven) })
  assert.equal(refused.via, 'env-assistant')
  assert.match(refused.source, /without --assistant-id a session started in .* would be refused/)

  const other = resolveDoctorIdentity({
    env: {},
    home: HOME,
    folder: FOLDER,
    assistantIdFlag: '867',
    ...fakeFs({ ...seven, [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '866' }) }),
  })
  assert.match(other.source, /without --assistant-id a session started here runs as 866, not 867/)

  const same = resolveDoctorIdentity({
    env: {},
    home: HOME,
    folder: FOLDER,
    assistantIdFlag: '867',
    ...fakeFs({ ...seven, [join(FOLDER, '.mcp.json')]: mcpJson({ BGOS_ASSISTANT_ID: '867' }) }),
  })
  assert.doesNotMatch(same.source, /without --assistant-id/)
})

test('a refusal says which places the doctor looked, so a pin set somewhere it cannot see is not mistaken for no pin', () => {
  const seven: Record<string, string> = {}
  for (const id of [861, 862, 863, 864, 865, 866, 867]) seven[join(AGENT_DIR, `credentials-${id}.json`)] = '{}'
  const id = resolveDoctorIdentity({ env: {}, home: HOME, folder: FOLDER, ...fakeFs(seven) })
  assert.equal(id.via, 'refuse')
  assert.match(id.problem, /systemd Environment=/)
  assert.match(id.problem, /HOAI_SUPERVISED_ASSISTANT_ID/)
  assert.match(id.problem, /agent's own environment/)
})

// ── The row ──────────────────────────────────────────────────────────────────

test('probeCredentials on disk, kc-server shape: the .mcp.json id names the file, the home is read, no refusal is reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-resolver-'))
  const folder = join(root, 'agents', '867')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(root, '.bgos-agent'), { recursive: true })
  for (const id of [865, 866, 867]) {
    writeFileSync(
      join(root, '.bgos-agent', `credentials-${id}.json`),
      JSON.stringify({ assistantId: id, pairingToken: 'TESTTOKEN', homeDir: join(root, 'agents', String(id)), homeSource: 'pairing' }),
    )
  }
  writeFileSync(join(folder, '.mcp.json'), mcpJson({ BGOS_ASSISTANT_ID: '867' }))

  const creds = probeCredentials({ env: {}, home: root, workdir: folder })
  assert.equal(creds.path, join(root, '.bgos-agent', 'credentials-867.json'))
  assert.equal(creds.exists, true)
  assert.equal(creds.assistantId, 867)
  assert.equal(creds.expectedAssistantId, '867')
  assert.equal(creds.homeDir, folder)
  assert.equal(creds.workdirRefused, false)
  assert.equal(creds.refusal, undefined)
  assert.ok(!JSON.stringify(creds).includes('TEST'), 'never the token, never the key')
})

test('probeCredentials on a folder nothing names, 3 agents paired: no path, a refusal that names the ids and both remedies', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-resolver-'))
  const folder = join(root, 'agents', 'stray')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(root, '.bgos-agent'), { recursive: true })
  for (const id of [865, 866, 867]) {
    writeFileSync(join(root, '.bgos-agent', `credentials-${id}.json`), JSON.stringify({ assistantId: id, pairingToken: 'TESTTOKEN' }))
  }
  const creds = probeCredentials({ env: {}, home: root, workdir: folder })
  assert.equal(creds.exists, false)
  assert.ok(creds.refusal, 'a refusal must be reported')
  assert.match(String(creds.refusal.detail), /3 paired agents/)
  assert.match(String(creds.refusal.detail), /865, 866, 867/)
  assert.match(String(creds.refusal.fix), /\.bgos-agent-id/)
  assert.match(String(creds.refusal.fix), /BGOS_ASSISTANT_ID/)
  assert.match(String(creds.refusal.fix), /\.mcp\.json/)
})

function healthy(credentials: Record<string, unknown>) {
  return {
    platform: 'linux',
    claude: { found: true, version: '2.1.239 (Claude Code)', path: '/bin/claude' },
    auth: { ok: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
    node: { found: true, version: 'v24.16.0' },
    bun: { found: true, path: '/bin/bun', via: 'home' },
    bunx: { found: true, path: '/bin/bunx' },
    method: { method: 'marketplace', channelSpec: 'plugin:hoai@hoai', pluginRoot: '/plug' },
    route: { spec: 'plugin:hoai@hoai', source: 'install-method', method: 'marketplace', serverName: '', conflict: false, reason: '' },
    credentials,
    handshake: { ok: true, detail: 'server bgos answered initialize' },
    mcpList: { ok: true, state: 'connected', raw: 'bgos: Connected' },
    backend: { ok: true, status: 200, url: 'http://x' },
    logPath: '/tmp/log',
    liveMarker: { exists: true, ageMs: 1000 },
  }
}

test('buildDoctorRows: a pin conflict fails the credentials row and still shows the file, the identity and the home', () => {
  const rows = buildDoctorRows(
    healthy({
      path: '/h/.bgos-agent/credentials-867.json',
      exists: true,
      assistantId: 867,
      expectedAssistantId: '867',
      identity: 'BGOS_ASSISTANT_ID=867 in the env block of /a/867/.mcp.json',
      conflict: 'the pin names 866 and the block names 867',
    }) as never,
  )
  const row = rows.find((r: { id: string }) => r.id === 'credentials')
  assert.equal(row?.ok, false)
  assert.match(String(row?.detail), /credentials-867\.json \(assistant 867\)/)
  assert.match(String(row?.detail), /the pin names 866 and the block names 867/)
  assert.match(String(row?.fix), /same agent/)
  assert.equal(preflightVerdict(rows).ok, false)
})

test('buildDoctorRows: a refused identity fails the credentials row with its fix and fails the preflight; the identity source is printed when known', () => {
  const refused = buildDoctorRows(
    healthy({ path: '', exists: false, refusal: { detail: 'this host has 7 paired agents', fix: 'write the id into .bgos-agent-id' } }) as never,
  )
  const row = refused.find((r: { id: string }) => r.id === 'credentials')
  assert.equal(row?.ok, false)
  assert.equal(row?.detail, 'this host has 7 paired agents')
  assert.equal(row?.fix, 'write the id into .bgos-agent-id')
  assert.equal(preflightVerdict(refused).ok, false)

  const found = buildDoctorRows(
    healthy({
      path: '/h/.bgos-agent/credentials-867.json',
      exists: true,
      assistantId: 867,
      expectedAssistantId: '867',
      identity: 'BGOS_ASSISTANT_ID=867 in the env block of /a/867/.mcp.json',
    }) as never,
  )
  const ok = found.find((r: { id: string }) => r.id === 'credentials')
  assert.equal(ok?.ok, true)
  assert.match(String(ok?.detail), /identity: BGOS_ASSISTANT_ID=867 in the env block of \/a\/867\/\.mcp\.json/)
})
