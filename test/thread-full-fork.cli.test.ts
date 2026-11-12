/**
 * The owner's full access thread and a recipient's confined thread against the
 * REAL Claude Code CLI (0.88.0). Opt in: set THREADS_FULL_CLAUDE to a local
 * CLI executable. A scripted Messages API on 127.0.0.1 stands in for the
 * model (no account, no real key), and everything lives in one throwaway
 * folder under the home folder (the CLI's sandbox lets every command write
 * the temp folders, so a probe under the temp folder proves nothing), with
 * its own CLAUDE_CONFIG_DIR. Nothing of a real agent is read or written.
 *
 * What it proves, through the real ThreadLaneManager, the real spawn and
 * real files:
 *
 *  OWNER      Bash runs unsandboxed: it writes outside the agent folder and
 *             reaches the network; the session is in the main session's own
 *             permission mode; the owner's own hook and MCP server load;
 *             this plugin's own launcher does not start a second copy; a
 *             prompt reaches the approval path; git checkout is refused; an
 *             active /goal of the main chat does not come along; closing the
 *             thread leaves nothing of it on disk.
 *  RECIPIENT  the same command as before 0.88.0: Bash cannot write outside
 *             its worktree; on a repository above the copy limit it has no
 *             Bash and no editing tool at all.
 */

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ThreadLaneManager, type ThreadLaneDeps, type ThreadTurnInput } from '../lib/thread-lanes.ts'
import { spawnStreamJson } from '../lib/stream-json-child.ts'
import { clearActiveGoal, copyTranscriptClearingGoal, findActiveGoalRow, latestPermissionMode } from '../lib/thread-transcript.ts'
import { diskUsage } from '../lib/thread-access.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'
import { startFakeAnthropicApi } from './helpers/fake-anthropic-api.ts'

const claude = process.env.THREADS_FULL_CLAUDE
const run = promisify(execFile)
const repoFile = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))

test('real CLI: an owner\'s thread is a full fork (Bash, network, the owner\'s mode, hooks and MCP servers) and a recipient\'s thread is confined as before', {
  skip: !claude || process.platform === 'win32', timeout: 200_000,
}, async () => {
  const dir = realpathSync(mkdtempSync(join(homedir(), '.thread-full-probe-')))
  const home = join(dir, 'home')
  const configDir = join(dir, 'config')
  const agent = join(dir, 'agent')
  const outside = join(dir, 'outside')
  const stateDir = join(home, '.bgos-agent', '7', 'threads')
  for (const p of [home, configDir, agent, outside, stateDir]) mkdirSync(p, { recursive: true })
  const emptyMcp = join(stateDir, 'empty-mcp.json')
  writeFileSync(emptyMcp, '{"mcpServers":{}}')
  let judge = 0
  // The script: a goal check is never met; a tool result is read back as the answer; RUN:[[cmd]] asks for Bash once.
  const api = await startFakeAnthropicApi((body) => {
    const b = body as { system?: unknown; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> }
    if (/stop-condition hook/.test(JSON.stringify(b.system ?? '')) && !((b.tools?.length ?? 0) > 0)) {
      judge++
      return '{"ok": false, "reason": "Not satisfied"}'
    }
    const last = b.messages?.at(-1)
    const all = JSON.stringify(b.messages ?? [])
    if (Array.isArray(last?.content) && (last!.content as Array<{ type: string }>).some((x) => x.type === 'tool_result')) return `RESULT ${JSON.stringify(last!.content).slice(0, 600)}`
    const at = all.lastIndexOf('RUN:[[')
    const wanted = at >= 0 && !all.slice(at).includes('tool_result') ? /RUN:\[\[(.+?)\]\]/.exec(all.slice(at)) : null
    const tools = (b.tools ?? []).map((t) => t.name)
    if (wanted && tools.includes('Bash')) return { toolUse: { name: 'Bash', input: { command: wanted[1]!, description: 'probe' } } }
    return `TOOLS ${tools.filter((n) => ['Bash', 'Edit', 'Write', 'Read', 'NotebookEdit'].includes(n) || n.startsWith('mcp__')).sort().join(',')} PELICAN=${all.includes('PELICAN-42')}`
  })
  const env: Record<string, string> = {
    HOME: home, PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp',
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'local-test-not-a-real-key',
    ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // A variable only the owner's own environment has, and one of this plugin's own.
    OWNER_ONLY_VARIABLE: 'owner-env-ok', BGOS_API_KEY: 'must-not-reach-a-thread',
    BUN_INSTALL: process.env.BUN_INSTALL ?? join(homedir(), '.bun'),
  }
  // The owner's own setup: a hook that asks before any Bash command naming ASKME, and two MCP servers:
  // a server of the owner's own, and this plugin's real launcher (which would start a second copy of the plugin).
  const askHook = join(dir, 'ask-hook.mjs')
  writeFileSync(askHook, `let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{const p=JSON.parse(s);if(String(p.tool_input?.command??'').includes('ASKME'))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'the owner asks first'}}))})`)
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '${askHook}'` }] }] } }))
  const ownerServer = join(dir, 'owner-mcp.mjs')
  const started = join(dir, 'plugin-copy-started.txt')
  writeFileSync(ownerServer, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'owner', version: '1' } }
    : m.method === 'tools/list' ? { tools: [{ name: 'probe', description: 'the owner\\'s own tool', inputSchema: { type: 'object', properties: {} } }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });`)
  // What the launcher would start: it only records that it ran.
  const pluginServer = join(dir, 'plugin-server.ts')
  writeFileSync(pluginServer, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(started)}, 'started\\n'); setInterval(() => {}, 1000);`)
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      owner: { command: process.execPath, args: [ownerServer] },
      bgos: { command: process.execPath, args: [repoFile('bin/bgos-launch.mjs'), pluginServer] },
    },
  }))
  await run('git', ['init', '-q', '-b', 'main'], { cwd: agent })
  writeFileSync(join(agent, 'README.md'), 'the agent folder\n')
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'add', '-A'], { cwd: agent })
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-qm', 'first'], { cwd: agent })

  const managers: ThreadLaneManager[] = []
  try {
    // The main session, as an owner runs it: full access.
    const parent = await run(claude!, ['-p', '--dangerously-skip-permissions', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', 'Remember the code word PELICAN-42.'], { cwd: agent, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 1 << 26 })
    const mainId = String(parent.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'system' && f.subtype === 'init')?.session_id)
    const mainPath = sessionTranscriptPath(home, agent, mainId, configDir)
    assert.ok(existsSync(mainPath))
    // An interactive session writes its permission mode into its transcript (measured on 2.1.322); a headless one does not.
    appendFileSync(mainPath, `${JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: mainId })}\n`)
    assert.equal(await latestPermissionMode(mainPath), 'bypassPermissions')

    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const logs: string[] = []
    const frames: Array<{ root: string; frame: Record<string, any> }> = []
    const asked: Array<Record<string, unknown>> = []
    const manager = (over: Partial<ThreadLaneDeps> = {}) => {
      const deps: ThreadLaneDeps = {
        spawn: (command, args, opts) => {
          const saved = process.env
          process.env = env
          try {
            const child = spawnStreamJson(command, args, opts)
            const root = /--resume/.test(args.join(' ')) ? String(opts.env?.HOAI_THREAD_LANE ?? opts.cwd).replace(/\.json$/, '').split('/').pop()! : ''
            let buffer = ''
            child.onStdout((chunk) => {
              buffer += chunk
              let at
              while ((at = buffer.indexOf('\n')) >= 0) {
                try { frames.push({ root, frame: JSON.parse(buffer.slice(0, at)) }) } catch {}
                buffer = buffer.slice(at + 1)
              }
            })
            return child
          } finally {
            process.env = saved
          }
        },
        claudeBin: () => claude!,
        cliProblem: () => null,
        mainSessionId: () => mainId,
        agentFolder: agent,
        stateDir,
        home,
        configDir,
        emptyMcpConfigPath: () => emptyMcp,
        shellSandbox: () => process.platform === 'darwin' || existsSync('/usr/bin/bwrap'),
        platform: process.platform,
        processes: { stamp: async () => null, runsIn: async () => false, kill: () => {} },
        git: async (args, cwd) => {
          try {
            const { stdout } = await run('git', args, { cwd, timeout: 60_000 })
            return { ok: true, stdout: String(stdout) }
          } catch {
            return { ok: false, stdout: '' }
          }
        },
        transcripts: {
          copyClearingGoal: (from, to) => copyTranscriptClearingGoal(from, to),
          clearGoal: (path) => clearActiveGoal(path),
          hasActiveGoal: async (path) => (await findActiveGoalRow(path)) !== null,
        },
        fullAccess: () => true,
        mainPermissionMode: () => latestPermissionMode(mainPath),
        approve: async (input) => { asked.push(input as never); return { allow: true } },
        diskUsage: (path) => diskUsage(path),
        tempRoots: [],
        fs: {
          exists: (p) => existsSync(p),
          mkdir: (p) => { mkdirSync(p, { recursive: true }) },
          readFile: (p) => readFileSync(p, 'utf8'),
          writeFile: (p, d) => writeFileSync(p, d),
          appendFile: (p, d) => appendFileSync(p, d),
          copyFile: (a, b) => copyFileSync(a, b),
          unlink: (p) => unlinkSync(p),
          rmrf: (p) => rmSync(p, { recursive: true, force: true }),
          list: (d) => readdirSync(d),
          createExclusive: (p, d) => writeFileSync(p, d, { flag: 'wx' }),
          rename: (a, b) => renameSync(a, b),
        },
        post: async (path, body) => { posts.push({ path, body }) },
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        log: (msg) => { logs.push(msg) },
        killGraceMs: 2_000,
        ...over,
      }
      const m = new ThreadLaneManager(deps)
      managers.push(m)
      return m
    }
    const replyFor = async (rootId: string, nth = 0): Promise<string> => {
      const until = Date.now() + 90_000
      while (Date.now() < until) {
        const reply = posts.filter((p) => p.path === 'integrations/threads/reply' && p.body.rootId === rootId)[nth]
        if (reply) return String(reply.body.text)
        await new Promise((done) => setTimeout(done, 100))
      }
      assert.fail(`no reply for thread ${rootId}: ${JSON.stringify(posts).slice(0, 1500)} | ${logs.join(' | ')}`)
    }
    const turn = (rootId: string, text: string, over: Partial<ThreadTurnInput> = {}): ThreadTurnInput => ({ chatId: '55', rootId, replyId: `${rootId}${posts.length}`, mode: 'start', text, title: `Thread ${rootId}`, rootText: 'A question.', ...over })
    const initOf = (rootId: string) => frames.find((f) => f.root === rootId && f.frame.type === 'system' && f.frame.subtype === 'init')?.frame

    // ---- OWNER ---------------------------------------------------------------
    const owner = manager()
    const outFile = join(outside, 'owner.txt')
    owner.turn(turn('101', `RUN:[[echo $OWNER_ONLY_VARIABLE:\${BGOS_API_KEY:-none} > ${outFile} && curl -s -o /dev/null -w %{http_code} ${api.url}/ping]]`, { opener: 'owner' }))
    const first = await replyFor('101')
    assert.match(first, /RESULT .*200/, `Bash ran and reached the network: ${first}`)
    assert.equal(readFileSync(outFile, 'utf8').trim(), 'owner-env-ok:none', 'Bash wrote outside the agent folder, with the owner\'s environment and none of this plugin\'s variables')
    const init = initOf('101')!
    assert.equal(init.permissionMode, 'bypassPermissions', 'the owner\'s own permission mode')
    assert.equal(realpathSync(init.cwd), agent, 'it runs in the agent\'s own folder')
    assert.ok(init.tools.includes('Bash') && init.tools.includes('Edit') && init.tools.includes('Write'))
    const servers = Object.fromEntries((init.mcp_servers as Array<{ name: string; status: string }>).map((s) => [s.name, s.status]))
    assert.equal(servers.owner, 'connected', `the owner's own MCP server loads in the thread: ${JSON.stringify(servers)}`)
    assert.notEqual(servers.bgos, 'connected', 'this plugin\'s own server does not start a second copy')
    assert.equal(existsSync(started), false, 'the plugin\'s launcher stopped before it started anything')
    const state = JSON.parse(readFileSync(join(stateDir, '101.json'), 'utf8'))
    assert.equal(state.access, 'full')
    assert.equal(existsSync(join(agent, '.hoai', 'threads', '101')), false, 'no worktree, no copy of the repository')

    // The owner's own hook asks; the thread's prompt reaches the approval path and, allowed, runs.
    owner.turn(turn('101', 'RUN:[[echo ASKME-ran]]', { mode: 'reply', opener: 'owner' }))
    assert.match(await replyFor('101', 1), /ASKME-ran/)
    assert.equal(asked.length, 1, 'the prompt was answered by the approval path')
    assert.equal(asked[0]!.toolName, 'Bash')
    assert.equal(asked[0]!.rootId, '101')

    // Two sessions in one folder: git checkout is refused, the branch does not move.
    owner.turn(turn('101', 'RUN:[[git checkout -b moved]]', { mode: 'reply', opener: 'owner' }))
    assert.match(await replyFor('101', 2), /denied/i)
    assert.equal((await run('git', ['branch', '--show-current'], { cwd: agent })).stdout.trim(), 'main')

    // Closing the thread leaves nothing of it on disk, and says how much it freed.
    const forkId = JSON.parse(readFileSync(join(stateDir, '101.json'), 'utf8')).forkSessionId as string
    assert.ok(existsSync(sessionTranscriptPath(home, agent, forkId, configDir)))
    await owner.close({ rootId: '101', removeWorktree: false })
    await owner.idle()
    assert.equal(existsSync(sessionTranscriptPath(home, agent, forkId, configDir)), false, 'its forked session file is gone')
    assert.equal(existsSync(join(stateDir, '101.json')), false)
    assert.equal(readdirSync(dirname(mainPath)).some((n) => n.includes(forkId)), false)
    assert.ok(existsSync(mainPath), 'the main session\'s transcript stays')
    assert.match(logs.find((l) => /thread 101 closed/.test(l)) ?? '', /freed [1-9]\d* bytes/)

    // An active /goal of the main chat does not come along.
    await run(claude!, ['-p', '--dangerously-skip-permissions', '--strict-mcp-config', '--resume', mainId, '--output-format', 'stream-json', '--verbose', '/goal the file done.txt contains GOALPROBE'], { cwd: agent, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 26 }).catch(() => null)
    assert.ok((await findActiveGoalRow(mainPath)) !== null, 'the main chat has an active goal')
    assert.ok(judge >= 3)
    judge = 0
    const before = readdirSync(dirname(mainPath)).length
    owner.turn(turn('102', 'What is the code word?', { opener: 'owner' }))
    assert.match(await replyFor('102'), /PELICAN=true/, 'the thread knows what the main chat knew')
    assert.equal(judge, 0, 'the goal checker never ran in the thread')
    await owner.close({ rootId: '102', removeWorktree: false })
    await owner.idle()
    assert.equal(readdirSync(dirname(mainPath)).length, before, 'the goal cleared copy and the fork are both gone')
    await owner.stopAll()

    // ---- RECIPIENT -----------------------------------------------------------
    const recipient = manager()
    const recFile = join(outside, 'recipient.txt')
    recipient.turn(turn('201', `RUN:[[echo leaked > ${recFile}]]`, { opener: 'recipient' }))
    await replyFor('201')
    assert.equal(existsSync(recFile), false, 'a recipient\'s Bash cannot write outside its worktree')
    const recInit = initOf('201')
    if (recInit) {
      assert.notEqual(recInit.permissionMode, 'bypassPermissions')
      assert.equal((recInit.mcp_servers as unknown[]).length, 0, 'the empty MCP config: none of the owner\'s servers')
    }
    assert.equal(JSON.parse(readFileSync(join(stateDir, '201.json'), 'utf8')).access, 'confined')
    assert.ok(existsSync(join(agent, '.hoai', 'threads', '201')), 'its own worktree')
    await recipient.close({ rootId: '201', removeWorktree: false })
    await recipient.idle()
    assert.equal(existsSync(join(agent, '.hoai', 'threads', '201')), false, 'and closing it removes that worktree')
    await recipient.stopAll()

    // On a repository above the copy limit a recipient's thread is read only: no Bash, no editing tool.
    const big = manager({ checkoutTooLarge: async () => 'it holds more than 1.0 GB of files' })
    big.turn(turn('202', `RUN:[[echo leaked > ${recFile}]]`, { opener: 'recipient' }))
    const bigAnswer = await replyFor('202')
    assert.match(bigAnswer, /^TOOLS /, `no Bash to ask for: ${bigAnswer}`)
    assert.doesNotMatch(bigAnswer, /Bash|Edit|Write/)
    assert.match(bigAnswer, /Read/)
    assert.equal(existsSync(recFile), false)
    // The owner, same repository, same limit: the full fork.
    big.turn(turn('203', `RUN:[[echo big-repo-ok > ${join(outside, 'big.txt')}]]`, { opener: 'owner' }))
    await replyFor('203')
    assert.equal(readFileSync(join(outside, 'big.txt'), 'utf8').trim(), 'big-repo-ok', 'the owner\'s thread works on a repository of any size')
    console.log(`CLI proof (${(await run(claude!, ['--version'])).stdout.trim()}): owner bypassPermissions, Bash wrote outside and reached the network, owner MCP ${servers.owner}, plugin copy ${servers.bgos}, 1 prompt approved, git checkout denied, goal checks in thread 0; recipient confined, read only on a big repository`)
  } finally {
    for (const m of managers) await m.stopAll().catch(() => {})
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
