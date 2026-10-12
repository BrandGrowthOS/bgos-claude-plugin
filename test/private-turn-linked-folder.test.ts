/**
 * A private turn started in an agent folder reached through a LINK (a Windows
 * junction or a symlink) is adopted by the daemon (plugin 0.67.5).
 *
 * Claude Code names everything about a session from its own
 * `fs.realpathSync(process.cwd())` (its originalCwd): the transcript under
 * <config dir>/projects/<that folder, munged>, the hook payload's cwd and
 * transcript_path, and the CLAUDE_PROJECT_DIR it hands its MCP servers. The
 * daemon gets the CLI's cwd as SPELLED: bin/bgos-launch.mjs passes its own
 * process.cwd() on as BGOS_LAUNCH_CWD. On macOS and Linux getcwd() is already
 * the real folder, so the two agree. On Windows it keeps the junction's
 * spelling, the daemon looked for the CLI's transcripts in a projects folder
 * nobody writes, and the hook intake refused every event of the agent's own
 * session as foreign-project. privateTurns.begin() never ran, no .ready was
 * written, browser-turn.json kept turnId null and every boards, schedule and
 * browser call refused (Data, 2026-10-12, on a Windows PC at 0.67.2).
 *
 * The daemon's own statements are sliced out of server.ts and executed, so
 * these tests hold the real wiring, not a copy of it.
 *
 * Run with: npx tsx --test test/private-turn-linked-folder.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { startHookIntake } from '../lib/hook-intake.ts'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { UsageTracker } from '../lib/usage-report.ts'
import { RestingWatcher } from '../lib/resting.ts'
import { ClaudeLoginWatcher } from '../lib/claude-login.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { createPrivateTurnTracker, privateContextPath, privateMarkerPath, publishPrivateContext, readPrivateJson, requirePrivateTurn } from '../lib/private-turn.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = readFileSync(join(REPO, 'server.ts'), 'utf8')
const binding: Record<string, any> = await import('../lib/session-binding.ts')
// Before 0.67.5 the daemon used the launch folder exactly as given.
const claudeProjectCwd: (launchCwd: string) => string = binding.claudeProjectCwd ?? ((launchCwd: string) => launchCwd)
const win = process.platform === 'win32'

/** One module scope statement of server.ts, `const <name> = ...` up to its end. */
function serverStatement(name: string): string {
  const at = SERVER.indexOf(`\nconst ${name} = `)
  assert.ok(at >= 0, `server.ts declares ${name} at module scope`)
  const line = SERVER.slice(at + 1, SERVER.indexOf('\n', at + 1))
  return line.endsWith('({') || line.endsWith(', {') ? SERVER.slice(at + 1, SERVER.indexOf('\n})\n', at) + 3) : line
}

/** Run server.ts's own statements for `name`, with the folder rule it declares (if any). */
function buildFromServer(name: string, bindings: Record<string, unknown>): any {
  const folderRule = SERVER.includes('\nconst CLAUDE_PROJECT_CWD = ') ? serverStatement('CLAUDE_PROJECT_CWD') : ''
  const body = `${folderRule}\n${serverStatement(name)}\nreturn ${name}`
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const all = { claudeProjectCwd, ...bindings }
  return new Function(...Object.keys(all), js)(...Object.values(all))
}

/**
 * An agent folder reached through a link, as it is on the reported PC:
 * <root>\hoai-agents is a junction (a symlink off Windows) to <root>\agents,
 * and the agent runs in <root>\hoai-agents\vera.
 */
function linkedAgent(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-linked-folder-')))
  const realFolder = join(root, 'agents', 'vera')
  mkdirSync(realFolder, { recursive: true })
  symlinkSync(join(root, 'agents'), join(root, 'hoai-agents'), 'junction')
  const linkedFolder = join(root, 'hoai-agents', 'vera')
  t.after(() => {
    try { unlinkSync(join(root, 'hoai-agents')) } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true })
  })
  // What a process started in the linked folder sees. bin/bgos-launch.mjs
  // hands its process.cwd() to the daemon as BGOS_LAUNCH_CWD, and Claude Code
  // takes realpathSync(process.cwd()) as the folder it names the session by.
  const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify({ cwd: process.cwd(), real: require('fs').realpathSync(process.cwd()) }))"], { cwd: linkedFolder, encoding: 'utf8', windowsHide: true })
  const seen = JSON.parse(probe.stdout) as { cwd: string; real: string }
  const claudeHome = join(root, '.claude')
  // The CLI's projects folder: every character that is not a letter or a digit becomes '-'.
  const cliProjectDir = join(claudeHome, 'projects', seen.real.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(cliProjectDir, { recursive: true })
  return { root, realFolder, linkedFolder, launchCwd: seen.cwd, cliCwd: seen.real, claudeHome, cliProjectDir }
}

test('a turn the CLI starts in a linked agent folder is adopted: the intake binds the session and private tools run', async (t) => {
  const f = linkedAgent(t)
  assert.equal(f.cliCwd, f.realFolder, 'Claude Code names the session by the real folder')
  // The Windows shape: GetCurrentDirectory keeps the junction's spelling. On
  // macOS and Linux getcwd() is the real folder, which makes this the control.
  if (win) assert.equal(f.launchCwd, f.linkedFolder)
  else assert.equal(f.launchCwd, f.realFolder)

  const session = randomUUID()
  const transcript = join(f.cliProjectDir, `${session}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'summary', sessionId: session })}\n`)
  const sessionBinder = buildFromServer('sessionBinder', {
    LAUNCH_CWD: f.launchCwd, CLAUDE_CONFIG_DIR: f.claudeHome, SessionTranscriptBinder,
    process: { env: { CLAUDE_CODE_SESSION_ID: session } }, log: () => {},
  })

  // The rest of the daemon's side, as server.ts wires it.
  const pluginRoot = join(f.root, 'plugin')
  const floorFolders = daemonFloorFolders({ launchCwd: f.launchCwd, cwd: pluginRoot, env: { CLAUDE_PROJECT_DIR: f.cliCwd } })
  markFloorAttached({ root: f.root, folders: floorFolders })
  const markerPaths = [...new Set(floorFolders.map((folder: string) => floorKey(folder)))].map((key) => privateMarkerPath(f.root, key))
  const turnChat = createTurnChatTracker()
  const privateTurns = createPrivateTurnTracker()
  const logs: string[] = []
  const intake = startHookIntake({
    stateRoot: f.root,
    projectDir: sessionBinder.projectDirectory,
    baseDir: f.launchCwd,
    onEvent: (payload) => {
      if (payload.hook_event_name !== 'UserPromptSubmit') return
      privateTurns.begin({ prompt: payload.prompt, promptHash: payload.hoai_clipped === true ? payload.prompt_sha256 : undefined, sessionId: String(payload.session_id ?? '').trim() })
    },
    isArmed: () => true,
    provesDelivery: (prompt) => turnChat.matchDelivered(prompt) !== null,
    provenTranscript: () => sessionBinder.provenTranscriptPath(),
    log: (line) => logs.push(line),
  })
  const contextPath = privateContextPath(f.root, '7')
  const publish = () => publishPrivateContext({ path: contextPath, secret: 'synthetic-test-key', assistantId: '7', ownerUserId: 'user_owner', claudePid: process.pid, turn: privateTurns.current({ markerPaths }) })
  const tick = setInterval(() => { intake.pump(); publish() }, 25)
  try {
    // One HOAI message from the owner, delivered and wrapped the way the CLI wraps a channel event.
    const text = 'Please list my boards for the launch plan'
    turnChat.note({ chatId: '101', messageId: 9001, kind: 'user', text, now: Date.now() })
    const content = privateTurns.deliver({ content: text, chatId: '101', actingUserId: 'user_owner' })
    const prompt = `<channel source="bgos" chat_id="101" message_id="9001" user="User" user_id="user_owner">\n${content}\n</channel>`
    const payload = { session_id: session, transcript_path: transcript, cwd: f.cliCwd, prompt_id: randomUUID(), permission_mode: 'bypassPermissions', hook_event_name: 'UserPromptSubmit', prompt }
    // The two shipped UserPromptSubmit handlers, run at once, from the session's folder, as the CLI runs them.
    const hookEnv = { ...process.env, BGOS_PLUGIN_STATE_DIR: f.root, CLAUDE_PROJECT_DIR: f.cliCwd }
    const runHook = (file: string) => new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [join(REPO, file)], { cwd: f.cliCwd, env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`${file} exited ${code}: ${stderr}`))))
      child.stdin.end(`${JSON.stringify(payload)}\n`)
    })
    // Settled, not raced: neither hook may outlive the test when the other fails.
    const hooks = await Promise.allSettled([runHook('bin/hoai-private-turn-hook.mjs'), runHook('bin/hoai-hook.mjs')])
    for (const hook of hooks) if (hook.status === 'rejected') throw hook.reason
    // One more drain and publish, as the daemon's next tick would, so a slow
    // runner whose hook ran out its wait cannot fail the receipt check below.
    intake.pump()
    publish()

    assert.equal(intake.bound(), session, `the daemon must take the CLI's own session; the intake said: ${logs.join(' | ') || '(nothing)'}`)
    const marker = markerPaths.map((path) => readPrivateJson(path, 2048)).find((m: any) => m?.live === true)
    assert.ok(marker, 'the private turn hook wrote a live marker')
    const ready = markerPaths.map((path) => readPrivateJson(`${path}.ready`, 2048)).find(Boolean)
    assert.equal(ready?.turnId, marker.turnId, 'the daemon adopted the turn and released the hook')
    assert.equal(readPrivateJson(contextPath)?.context?.turnId, marker.turnId, 'browser-turn.json names the live turn')
    const turn = requirePrivateTurn(privateTurns, markerPaths, 'user_owner')
    assert.equal(turn.actingUserId, 'user_owner')
  } finally {
    // Before the fixture root goes: nothing may still write into it.
    clearInterval(tick)
    intake.stop()
  }
})

test('claudeProjectCwd names the folder the way Claude Code does: a link resolves, a plain or missing folder stays as given', (t) => {
  const f = linkedAgent(t)
  assert.equal(claudeProjectCwd(f.linkedFolder), f.realFolder)
  assert.equal(claudeProjectCwd(f.realFolder), f.realFolder)
  const missing = join(f.root, 'not-created', 'vera')
  assert.equal(existsSync(missing), false)
  assert.equal(claudeProjectCwd(missing), missing)
})

test('claudeProjectCwd keeps an 8.3 short name and the drive letter as spelled, as the CLI realpath does (Windows)', { skip: !win && 'an 8.3 name and a drive letter exist on Windows only' }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-short-name-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const long = join(root, 'LongFolderName', 'vera')
  mkdirSync(long, { recursive: true })
  const lowerDrive = long.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
  assert.notEqual(lowerDrive, long, 'the temp folder sits on a drive letter')
  assert.equal(claudeProjectCwd(lowerDrive), lowerDrive)
  // No quote inside the command: node would escape one as \", which cmd does not read.
  if (/[\s"]/.test(long)) return t.skip('the temp folder has a space in it')
  const shortName = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in (${long}) do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  if (!shortName || shortName === long || !existsSync(shortName)) return t.skip('8.3 names are off on this volume')
  assert.equal(claudeProjectCwd(shortName), shortName)
})

test('every reader of the CLI project folder in server.ts reads the folder the CLI writes when the agent folder is linked', (t) => {
  const f = linkedAgent(t)
  const now = Date.now()
  const file = join(f.cliProjectDir, `${randomUUID()}.jsonl`)
  writeFileSync(file, '')
  // The folder as it may be handed over: what Windows' process.cwd() keeps,
  // and what any inherited BGOS_LAUNCH_CWD can say on every OS.
  const base = { LAUNCH_CWD: f.linkedFolder, CLAUDE_CONFIG_DIR: f.claudeHome }
  const usageTracker = buildFromServer('usageTracker', { ...base, UsageTracker })
  const restingWatcher = buildFromServer('restingWatcher', { ...base, RestingWatcher })
  const claudeLoginWatcher = buildFromServer('claudeLoginWatcher', { ...base, ClaudeLoginWatcher })
  const sessionBinder = buildFromServer('sessionBinder', { ...base, SessionTranscriptBinder, process: { env: {} }, log: () => {} })
  assert.equal(sessionBinder.projectDirectory, f.cliProjectDir)

  // What the CLI then writes: a reply with its usage, a usage cap, a login failure.
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', id: 'msg_linked', role: 'assistant', usage: { input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`)
  assert.equal(usageTracker.collect({})?.inputTokens, 50_000, 'the usage self report reads the CLI transcript')
  appendFileSync(file, `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'cap-linked', timestamp: new Date(now - 60_000).toISOString(), message: { id: 'msg-cap-linked', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 7:40pm (Asia/Dubai)" }], usage: { input_tokens: 0, output_tokens: 0 } }, requestId: 'req_test', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429 })}\n`)
  assert.equal(restingWatcher.scan(now)?.type, 'limit', 'the resting watcher sees the usage cap')
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed', timestamp: new Date(now - 1000).toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })}\n`)
  assert.equal(claudeLoginWatcher.scan(now)?.type, 'login_failed', 'the login watcher sees the failure')
})
