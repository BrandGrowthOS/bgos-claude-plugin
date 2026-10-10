/**
 * hoai doctor finds the agent's identity the way the daemon does (0.65.2).
 *
 * THE DEFECT. kc-server runs seven agents under systemd. Each is identified by
 * an env pin in its own .mcp.json (BGOS_ASSISTANT_ID, or BGOS_CREDENTIALS_PATH)
 * and holds its own credentials-<id>.json; no folder carries a .bgos-agent-id.
 * `hoai doctor` run in one agent's folder started its handshake child WITHOUT
 * that pin, so the daemon answered "REFUSING to start: this host has 7 paired
 * agents ... no identity pin", and the credentials row went looking for a
 * single credentials.json that does not exist. A healthy agent read as broken.
 *
 * These tests run the doctor end to end (main()) in the shapes a host really
 * has. The handshake child is a stub that boots exactly as server.ts does for
 * identity: the REAL resolveCredentialsSelection, loadCredentialsFile and
 * decideHomeBinding from lib/agent-credentials.ts, then answers initialize.
 * No real daemon starts, no real home is read (the stub refuses to run unless
 * its home is the temp one a test made), nothing leaves the machine (the
 * backend probe goes to a closed local port), and the doctor is handed a
 * stand-in for the claude CLI.
 *
 * Every run also asserts the doctor's two hard rules: it never prints a token
 * (the credentials files and the .mcp.json hold fake ones), and it never writes
 * a file (the temp tree is identical before and after).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { main as doctorMain } from '../bin/bgos-doctor.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CREDENTIALS_LIB = pathToFileURL(join(REPO_ROOT, 'lib', 'agent-credentials.ts')).href

/** The seven agents of the kc-server shape; 867 is the one the doctor runs for. */
const KC_IDS = [861, 862, 863, 864, 865, 866, 867]

// A stand-in for bin/bgos-launch.mjs + server.ts. Identity is decided by the
// real library functions server.ts calls at boot, in the order it calls them
// (server.ts, the CREDENTIALS_SELECTION and HOME_BINDING blocks), so a refusal
// here is the daemon's own refusal, word for word.
const STUB_DAEMON = `
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.env.DOCTOR_TEST_ROOT || ''
const home = resolve(homedir()).toLowerCase()
if (!root || !home.startsWith(resolve(root).toLowerCase())) {
  process.stderr.write('[stub] refusing to run: this home is not the temp home a test made\\n')
  process.exit(3)
}
const lib = await import(process.env.DOCTOR_TEST_LIB)
const launchCwd = process.env.BGOS_LAUNCH_CWD?.trim() || process.cwd()
const selection = lib.resolveCredentialsSelection({
  env: process.env,
  defaultPath: join(homedir(), '.bgos-agent', 'credentials.json'),
  cwd: launchCwd,
})
if (selection.kind === 'refuse') {
  process.stderr.write('[bgos] ' + lib.formatCredentialsRefusal(selection) + '\\n')
  process.exit(1)
}
const creds = lib.loadCredentialsFile(selection.path)
const binding = lib.decideHomeBinding({
  via: selection.via,
  cwd: launchCwd,
  recordedHomeDir: creds?.homeDir ?? null,
  recordedHomeSource: creds?.homeSource ?? null,
  folderPinId: lib.readFolderPinId(launchCwd),
  assistantId: String(creds?.assistantId ?? ''),
  env: process.env,
})
process.stderr.write('[bgos] stub identity via ' + selection.via + ', file ' + selection.path + '\\n')
const channel = creds != null && binding.action !== 'refuse'
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method !== 'initialize') return
  reply(message.id, {
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'bgos', version: 'stub' },
    capabilities: channel ? { tools: {}, experimental: { 'claude/channel': {} } } : { tools: {} },
  })
})
`

interface Fixture {
  root: string
  home: string
  agentsDir: string
  stub: string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'doctor-identity-'))
  const home = join(root, 'home')
  const agentsDir = join(root, 'agents')
  mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  const stub = join(root, 'stub-daemon.mjs')
  writeFileSync(stub, STUB_DAEMON)
  return { root, home, agentsDir, stub }
}

/** The folder an agent lives in; pairing records it as the agent's home. */
function agentFolder(fx: Fixture, id: number | string): string {
  const dir = join(fx.agentsDir, String(id))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A paired agent: credentials-<id>.json under the temp home, with a fake token. */
function pair(fx: Fixture, id: number, opts: { homeDir?: string | null; file?: string } = {}) {
  const homeDir = opts.homeDir === undefined ? agentFolder(fx, id) : opts.homeDir
  const body: Record<string, unknown> = {
    backendUrl: 'http://127.0.0.1:9/api/v1',
    pairingToken: `TESTTOKEN-secret-${id}`,
    pairingId: id * 10,
    userId: 'u1',
    assistantId: id,
  }
  if (homeDir) {
    body.homeDir = homeDir
    body.homeSource = 'pairing'
  }
  writeFileSync(join(fx.home, '.bgos-agent', opts.file ?? `credentials-${id}.json`), JSON.stringify(body))
}

function pairAll(fx: Fixture, ids: number[] = KC_IDS) {
  for (const id of ids) pair(fx, id)
}

/** An agent's .mcp.json the way the plugin's own writers lay it out, fake key included. */
function writeMcp(dir: string, env: Record<string, string>, server = 'bgos') {
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        [server]: {
          command: 'bun',
          args: ['wrapper.mjs'],
          env: { BGOS_BACKEND_URL: 'http://127.0.0.1:9/api/v1', BGOS_API_KEY: 'TESTKEY-secret', ...env },
        },
      },
    }),
  )
}

function writePin(dir: string, id: number | string) {
  writeFileSync(join(dir, '.bgos-agent-id'), `${id}\n`)
}

/** Every file under dir with its size and mtime: equal before and after means nothing was written. */
function listTree(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name)
      const st = statSync(path)
      if (st.isDirectory()) {
        out.push(`${path}/`)
        walk(path)
      } else out.push(`${path} ${st.size} ${st.mtimeMs}`)
    }
  }
  walk(dir)
  return out.join('\n')
}

/** A clean environment: nothing of the developer's shell, no BGOS_* pin, the temp home as home. */
function baseEnv(fx: Fixture): Record<string, string> {
  const env: Record<string, string> = {
    HOME: fx.home,
    USERPROFILE: fx.home,
    PATH: process.env.PATH ?? '',
    TMP: process.env.TMP ?? process.env.TMPDIR ?? '',
    TEMP: process.env.TEMP ?? process.env.TMPDIR ?? '',
    DOCTOR_TEST_ROOT: fx.root,
    DOCTOR_TEST_LIB: CREDENTIALS_LIB,
  }
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key] as string
  }
  return env
}

interface Row {
  id: string
  label: string
  ok: boolean | null | string
  detail: string
  fix: string
}

/** Run the doctor in `folder` as an operator would (cwd = the agent's folder) and return its rows. */
async function runDoctor(fx: Fixture, folder: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  const before = listTree(fx.root)
  const written: string[] = []
  const code = await doctorMain(['--backend', 'http://127.0.0.1:9', '--json', ...extraArgs], {
    env: { ...baseEnv(fx), ...extraEnv },
    home: fx.home,
    cwd: folder,
    launchArgv: [fx.stub],
    claude: { found: false },
    write: (text: string) => written.push(text),
  })
  const text = written.join('')
  assert.equal(listTree(fx.root), before, 'the doctor wrote or changed a file')
  assert.doesNotMatch(text, /TESTTOKEN|TESTKEY/, 'the doctor printed a token or a key')
  const rows = JSON.parse(text) as Row[]
  const row = (id: string): Row => {
    const found = rows.find((r) => r.id === id)
    assert.ok(found, `no ${id} row in: ${rows.map((r) => r.id).join(', ')}`)
    return found as Row
  }
  return { code, rows, row, text }
}

const SLOW = { timeout: 90_000 }

// ── The kc-server shape: 7 agents, the pin is the env block of the agent's .mcp.json ──

test('kc-server: BGOS_ASSISTANT_ID in the agent .mcp.json, 7 credentials files, no folder pin: the doctor finds the agent and the handshake passes', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })

  const { row } = await runDoctor(fx, folder)

  const handshake = row('handshake')
  assert.equal(handshake.ok, true, `handshake: ${handshake.detail}`)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, `credentials: ${credentials.detail}`)
  assert.ok(credentials.detail.includes('credentials-867.json'), credentials.detail)
  assert.match(credentials.detail, /\(assistant 867\)/)
  assert.ok(credentials.detail.includes('.mcp.json'), `the row says where the identity came from: ${credentials.detail}`)
  assert.ok(credentials.detail.includes(`home ${folder}, set by pairing`), `the home and its source: ${credentials.detail}`)
})

test('kc-server: BGOS_CREDENTIALS_PATH in the agent .mcp.json names the file, and that file is the one read', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  const file = join(fx.home, '.bgos-agent', 'credentials-867.json')
  writeMcp(folder, { BGOS_CREDENTIALS_PATH: file })

  const { row } = await runDoctor(fx, folder)

  const handshake = row('handshake')
  assert.equal(handshake.ok, true, `handshake: ${handshake.detail}`)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, `credentials: ${credentials.detail}`)
  assert.ok(credentials.detail.includes(file), credentials.detail)
  assert.match(credentials.detail, /\(assistant 867\)/)
  assert.ok(credentials.detail.includes('BGOS_CREDENTIALS_PATH'), credentials.detail)
})

test('kc-server: the pin in the launch env (the shell the doctor runs in), no .mcp.json pin: still found', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)

  const { row } = await runDoctor(fx, folder, { BGOS_ASSISTANT_ID: '867' })

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  assert.equal(row('credentials').ok, true, row('credentials').detail)
  assert.ok(row('credentials').detail.includes('credentials-867.json'), row('credentials').detail)
})

test('kc-server: an env pinned agent run from a folder that is not its recorded home is not refused (the env route is never refused)', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  pair(fx, 867, { homeDir: join(fx.root, 'somewhere-else') })
  const folder = agentFolder(fx, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, credentials.detail)
  assert.doesNotMatch(credentials.detail, /is refused as this agent/, 'an env pin is never refused, so the doctor must not say it is')
})

test('the .mcp.json block outranks the shell, as it does for the daemon Claude Code starts', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })

  const { row } = await runDoctor(fx, folder, { BGOS_ASSISTANT_ID: '861' })

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, credentials.detail)
  assert.ok(credentials.detail.includes('credentials-867.json'), credentials.detail)
  assert.ok(credentials.detail.includes('861'), `the overridden shell value is named: ${credentials.detail}`)
})

// ── The folder-pinned shape: Guru may be writing .bgos-agent-id into the 7 folders ──

test('folder pin only, 7 agents, no env: found through the pin', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writePin(folder, 867)

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, credentials.detail)
  assert.ok(credentials.detail.includes('credentials-867.json'), credentials.detail)
  assert.ok(credentials.detail.includes('.bgos-agent-id'), `the row names the pin: ${credentials.detail}`)
  assert.ok(credentials.detail.includes(`home ${folder}, set by pairing`), credentials.detail)
})

test('folder pin AND the .mcp.json pin, agreeing (pins written into folders that already had an env pin): still found', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writePin(folder, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  assert.equal(row('credentials').ok, true, row('credentials').detail)
  assert.ok(row('credentials').detail.includes('credentials-867.json'), row('credentials').detail)
})

test('folder pin and the .mcp.json pin DISAGREE: the daemon still answers as the env pin, so the handshake passes, but hoai refuses such a folder, so the credentials row fails and names both', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writePin(folder, 866)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, false, credentials.detail)
  assert.ok(credentials.detail.includes('credentials-867.json'), credentials.detail)
  assert.ok(!credentials.detail.includes('credentials-866.json'), credentials.detail)
  assert.ok(credentials.detail.includes('866') && credentials.detail.includes('867'), credentials.detail)
  assert.match(credentials.fix, /same agent/)
})

test('a .mcp.json block that sets the id to the placeholder shadows the pin in the shell: 7 agents, so the daemon refuses and the doctor says refused', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' })

  const { row } = await runDoctor(fx, folder, { BGOS_ASSISTANT_ID: '867' })

  const handshake = row('handshake')
  assert.equal(handshake.ok, false, `the daemon is handed an empty id and refuses: ${handshake.detail}`)
  assert.match(handshake.detail, /REFUSING to start: this host has 7 paired agents/)
  assert.equal(row('credentials').ok, false, row('credentials').detail)
})

test('--assistant-id 867 on 7 agents with no pin anywhere: the doctor expects that agent and passes, and says a session started here without the flag would be refused', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 'stray')

  const { row } = await runDoctor(fx, folder, {}, ['--assistant-id', '867'])

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, credentials.detail)
  assert.match(credentials.detail, /without --assistant-id a session started in .* would be refused/)
})

// ── Single agent hosts ──

test('single agent, the shared credentials.json, no pin: found by elimination, handshake passes', SLOW, async () => {
  const fx = fixture()
  const folder = agentFolder(fx, 871)
  pair(fx, 871, { homeDir: folder, file: 'credentials.json' })

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  const credentials = row('credentials')
  assert.equal(credentials.ok, true, credentials.detail)
  assert.ok(credentials.detail.includes(join(fx.home, '.bgos-agent', 'credentials.json')), credentials.detail)
  assert.ok(/elimination/i.test(credentials.detail), `the row says it was found by elimination: ${credentials.detail}`)
})

test('single agent, only credentials-<id>.json, no pin: the sole file is found by elimination', SLOW, async () => {
  const fx = fixture()
  const folder = agentFolder(fx, 871)
  pair(fx, 871, { homeDir: folder })

  const { row } = await runDoctor(fx, folder)

  assert.equal(row('handshake').ok, true, row('handshake').detail)
  assert.equal(row('credentials').ok, true, row('credentials').detail)
  assert.ok(row('credentials').detail.includes('credentials-871.json'), row('credentials').detail)
})

// ── A folder nothing identifies ──

test('7 agents and nothing names this folder: refused, never healthy (handshake and credentials both fail)', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 'stray')

  const { row, rows } = await runDoctor(fx, folder)

  const handshake = row('handshake')
  assert.equal(handshake.ok, false, `a refused daemon must not read as healthy: ${handshake.detail}`)
  assert.match(handshake.detail, /REFUSING to start: this host has 7 paired agents/)
  assert.equal(row('credentials').ok, false, row('credentials').detail)
  assert.ok(!rows.some((r) => ['handshake', 'credentials'].includes(r.id) && r.ok === true))
})

test('7 agents and nothing names this folder: the credentials row says refused and names both remedies, not "no credentials.json"', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 'stray')

  const { row } = await runDoctor(fx, folder)

  const credentials = row('credentials')
  assert.equal(credentials.ok, false, credentials.detail)
  assert.match(credentials.detail, /7 paired agents/)
  assert.match(credentials.detail, /861, 862, 863, 864, 865, 866, 867/)
  assert.match(credentials.detail, /refuse/i)
  assert.doesNotMatch(credentials.detail, /no credentials file at/)
  const remedy = `${credentials.detail} ${credentials.fix}`
  assert.ok(remedy.includes('.bgos-agent-id'), remedy)
  assert.ok(remedy.includes('BGOS_ASSISTANT_ID'), remedy)
  assert.ok(remedy.includes('.mcp.json'), remedy)
  // The remedy never guesses which agent this is (0.38.x, fix/recheck-honours-folder-pin).
  assert.ok(!/echo (861|862|863|864|865|866|867) /.test(remedy), remedy)
})

test('a stale pin (names an agent with no credentials file) is not obeyed: with 7 agents the daemon refuses, so the doctor says refused', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 'stale')
  writePin(folder, 999)

  const { row } = await runDoctor(fx, folder)

  const handshake = row('handshake')
  assert.equal(handshake.ok, false, `the stale pin must not be passed to the daemon as if it were good: ${handshake.detail}`)
  assert.match(handshake.detail, /REFUSING to start: this host has 7 paired agents/)
  const credentials = row('credentials')
  assert.equal(credentials.ok, false, credentials.detail)
  assert.ok(credentials.detail.includes('999'), `the stale pin is named: ${credentials.detail}`)
})

test('two .mcp.json servers naming two different agents: the doctor does not guess, it fails the credentials row', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 'two')
  writeFileSync(
    join(folder, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        a: { command: 'bun', env: { BGOS_ASSISTANT_ID: '866' } },
        b: { command: 'bun', env: { BGOS_ASSISTANT_ID: '867' } },
      },
    }),
  )

  const { row } = await runDoctor(fx, folder)

  const credentials = row('credentials')
  assert.equal(credentials.ok, false, credentials.detail)
  assert.ok(credentials.detail.includes('866') && credentials.detail.includes('867'), credentials.detail)
})

// ── The hard rules, on their own ──

test('the doctor never prints a token and never writes a pin or credentials file, in the shape that pairs 7 agents with keys in .mcp.json', SLOW, async () => {
  const fx = fixture()
  pairAll(fx)
  const folder = agentFolder(fx, 867)
  writeMcp(folder, { BGOS_ASSISTANT_ID: '867' })
  const before = listTree(fx.root)

  const { text } = await runDoctor(fx, folder)

  assert.ok(!text.includes('TESTTOKEN') && !text.includes('TESTKEY'))
  assert.equal(listTree(fx.root), before)
  assert.ok(!readdirSync(folder).includes('.bgos-agent-id'), 'the doctor wrote a pin')
  assert.deepEqual(
    readdirSync(join(fx.home, '.bgos-agent')).sort(),
    KC_IDS.map((id) => `credentials-${id}.json`),
    'the doctor added or removed a credentials file',
  )
})
