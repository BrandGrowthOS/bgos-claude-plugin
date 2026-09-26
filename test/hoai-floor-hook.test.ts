/**
 * bin/hoai-floor-hook.mjs: the ONE blocking hook, stdin to stdout.
 *
 * Three promises are pinned here because breaking any of them is worse than
 * having no floor at all:
 *   - it only ever ASKS: never `deny`, never exit 2, whatever it is fed (a
 *     deny is a stop the owner cannot override from the phone, part 24 D2);
 *   - it FAILS OPEN: bad JSON, a classifier that throws, a core that will not
 *     load, a stdin that never ends, all print nothing and exit 0, because a
 *     floor that failed closed would stop every shell call of every install;
 *   - it keeps a hard BUDGET under two seconds, inside the manifest's 3 s.
 * And the contract itself: for every case of the shared fixture that a hook
 * can see, the ask line with the rule's words on a match and nothing
 * otherwise; ONLY in a session a HOAI daemon is attached to (its marker for
 * the session's folder, with a live pid), and with a floor record left for
 * the relay before the ask.
 *
 * Run with: npx tsx --test test/hoai-floor-hook.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PassThrough, Readable } from 'node:stream'

import * as core from '../lib/hard-floor-core.mjs'
import {
  FLOOR_HOOK_BUDGET_MS,
  decideFloorHook,
  floorAskOutput,
  isEntryPoint,
  main,
} from '../bin/hoai-floor-hook.mjs'
import { HARD_FLOOR_FIXTURE } from '../lib/hard-floor-fixture.ts'
import {
  attachedMarkerPath,
  floorAsksDir,
  floorKey,
  markFloorAttached,
} from '../lib/floor-state.mjs'

const HOOK_PATH = fileURLToPath(new URL('../bin/hoai-floor-hook.mjs', import.meta.url))
const DELETE_WORDS = 'deleting a folder and everything in it'

/** The verbatim hook input of map part 24, run D1. */
const D1_PAYLOAD = {
  session_id: 'b399572a-a744-4da7-beba-21870ba88b8e',
  transcript_path: '/home/karim/.claude/projects/x/b399572a.jsonl',
  cwd: '/mnt/e/bgos-worktrees/_tools-p2/probes/scratch-claude-floor/repo',
  permission_mode: 'bypassPermissions',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf doomed', description: 'Remove doomed directory' },
  tool_use_id: 'toolu_01BToCV2A7vtoRfgQCM1pY1G',
}

const hookInput = (toolName: string, toolInput: unknown) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })

const stdinOf = (text: string) => Readable.from([Buffer.from(text, 'utf8')])

/** A plugin state folder in which a live daemon (this test's own pid) is attached to `folder`. */
const attachedRoot = (folder: string, pid = process.pid) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-floor-state-'))
  markFloorAttached({ root, folders: [folder], pid })
  return root
}

/** The records the hook left under a folder's key. */
const recordsIn = (root: string, folder: string) => {
  try {
    const dir = floorAsksDir(root, floorKey(folder))
    return readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  } catch {
    return []
  }
}

test('a listed action prints exactly the ask line, with the rule words as the reason', () => {
  const out = decideFloorHook(JSON.stringify(D1_PAYLOAD), core)
  assert.equal(
    out,
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",' +
      `"permissionDecisionReason":"${DELETE_WORDS}"}}`,
  )
  assert.equal(out, floorAskOutput(DELETE_WORDS))
})

test('every fixture case a hook can see: the ask on a match, nothing otherwise', () => {
  let asked = 0
  let silent = 0
  for (const c of HARD_FLOOR_FIXTURE) {
    let input: string
    if (c.input.kind === 'command') input = hookInput('Bash', { command: c.input.command })
    else if (c.input.kind === 'path') input = hookInput('Write', { file_path: c.input.path, content: 'x' })
    else if (c.input.kind === 'tool') input = hookInput(c.input.toolName, {})
    else continue // a request is the relay's input, not the hook's
    const out = decideFloorHook(input, core)
    const rule = core.HARD_FLOOR_RULES.find((r) => r.id === c.ruleId)
    if (rule) {
      asked += 1
      assert.equal(out, floorAskOutput(rule.words), c.name)
    } else {
      silent += 1
      assert.equal(out, '', c.name)
    }
  }
  assert.ok(asked > 40 && silent > 30, `the corpus was really walked (${asked} asked, ${silent} silent)`)
})

test('the ordinary calls of a working agent print nothing', () => {
  for (const [tool, input] of [
    ['Bash', { command: 'git status --short' }],
    ['Bash', { command: 'true', description: 'No-op' }],
    ['Bash', { command: 'npm test' }],
    ['Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/w/README.md', content: 'rm -rf is dangerous' }],
    ['mcp__plugin_hoai_bgos__reply', { text: 'done' }],
    ['Read', { file_path: '/w/.env' }],
  ] as const) {
    assert.equal(decideFloorHook(hookInput(tool, input), core), '', tool)
  }
})

test('it never answers deny: every output of every input is an ask or nothing', () => {
  const inputs = [
    JSON.stringify(D1_PAYLOAD),
    ...HARD_FLOOR_FIXTURE.map((c) =>
      c.input.kind === 'command' ? hookInput('Bash', { command: c.input.command }) : '',
    ),
    hookInput('mcp__bank__transfer_funds', {}),
    hookInput('Edit', { file_path: '~/.ssh/config' }),
  ]
  for (const input of inputs) {
    const out = decideFloorHook(input, core)
    if (!out) continue
    const parsed = JSON.parse(out)
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'ask')
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'], 'no continue:false, no decision field')
  }
  // And there is no path to one in the code at all, comments aside.
  const code = readFileSync(HOOK_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/deny/i.test(code), false, 'the word deny appears nowhere in its code')
  assert.equal(/exit\(\s*2\s*\)|exitCode\s*=\s*2/.test(code), false, 'it never exits 2')
  assert.equal(/"block"|'block'/.test(code), false, 'no legacy decision:block either')
})

test('fails open: junk, the wrong event, and a missing input print nothing', () => {
  for (const junk of [
    '',
    '   ',
    'not json',
    '{"tool_name":"Bash","tool_input":{"command":"rm -rf x"',
    '[1,2,3]',
    'null',
    '"rm -rf x"',
    JSON.stringify({ ...D1_PAYLOAD, hook_event_name: 'PostToolUse' }),
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'rm -rf x' }),
  ]) {
    assert.equal(decideFloorHook(junk, core), '', junk)
  }
})

test('fails open: a classifier that throws, or answers nonsense, prints nothing', () => {
  const throwing = {
    classifyToolCall: () => {
      throw new Error('boom')
    },
  }
  assert.equal(decideFloorHook(JSON.stringify(D1_PAYLOAD), throwing), '')
  for (const nonsense of [{}, { words: '' }, { words: 42 }, 'deleting', true]) {
    assert.equal(
      decideFloorHook(JSON.stringify(D1_PAYLOAD), { classifyToolCall: () => nonsense as never }),
      '',
    )
  }
})

test('main: a match is written once, and the exit code is 0', async () => {
  const root = attachedRoot(D1_PAYLOAD.cwd)
  try {
    const written: string[] = []
    process.exitCode = 3
    const out = await main({
      stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
      env: {},
      stateRoot: root,
      write: async (text: string) => {
        written.push(text)
      },
    })
    assert.equal(out, floorAskOutput(DELETE_WORDS))
    assert.deepEqual(written, [floorAskOutput(DELETE_WORDS)])
    assert.equal(process.exitCode, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('main: with NO HOAI daemon attached to the session, a listed action asks nothing', async () => {
  // Spec 2 moment 1 and spec 8: a plain `claude` on a machine that has the
  // plugin enabled, or a headless `claude -p`, must not get a prompt it never
  // had. Only a session whose folder a live daemon marked is a HOAI session.
  const empty = mkdtempSync(join(tmpdir(), 'hoai-floor-state-'))
  const elsewhere = attachedRoot('/srv/some/other/agent')
  const dead = attachedRoot(D1_PAYLOAD.cwd, 2 ** 31 - 3)
  try {
    for (const root of [empty, elsewhere, dead]) {
      const written: string[] = []
      const out = await main({
        stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
        env: {},
        stateRoot: root,
        write: async (text: string) => {
          written.push(text)
        },
      })
      assert.equal(out, '', root)
      assert.deepEqual(written, [])
      assert.deepEqual(recordsIn(root, D1_PAYLOAD.cwd), [], 'and leaves no record')
    }
  } finally {
    for (const root of [empty, elsewhere, dead]) rmSync(root, { recursive: true, force: true })
  }
})

test('main: attached through CLAUDE_PROJECT_DIR, or through a folder above the cwd', async () => {
  const project = '/mnt/e/agents/hoai-dev'
  const root = attachedRoot(project)
  try {
    const inSub = { ...D1_PAYLOAD, cwd: `${project}/packages/web/src` }
    const viaCwd = await main({ stdin: stdinOf(JSON.stringify(inSub)), env: {}, stateRoot: root, write: async () => {} })
    assert.equal(viaCwd, floorAskOutput(DELETE_WORDS), 'an agent that cd-ed into a subfolder is still attached')
    const noCwd = { ...D1_PAYLOAD, cwd: undefined }
    const viaEnv = await main({
      stdin: stdinOf(JSON.stringify(noCwd)),
      // The Windows spelling of the same folder: a Windows daemon behind a WSL session.
      env: { CLAUDE_PROJECT_DIR: 'E:\\agents\\hoai-dev' },
      stateRoot: root,
      write: async () => {},
    })
    assert.equal(viaEnv, floorAskOutput(DELETE_WORDS))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('main: the ask leaves a floor record for the relay, with what the hook saw whole', async () => {
  const root = attachedRoot(D1_PAYLOAD.cwd)
  try {
    const command = `echo ${'a'.repeat(2500)} ; rm -rf ~/work ; echo ${'b'.repeat(2000)}`
    const payload = { ...D1_PAYLOAD, tool_input: { command, description: 'Clean up' } }
    const out = await main({ stdin: stdinOf(JSON.stringify(payload)), env: {}, stateRoot: root, write: async () => {} })
    assert.equal(out, floorAskOutput(DELETE_WORDS))
    const records = recordsIn(root, D1_PAYLOAD.cwd)
    assert.equal(records.length, 1)
    assert.equal(records[0].ruleId, 'recursive_delete')
    assert.equal(records[0].evidence, 'rm -rf ~/work', 'the command in the middle, not the head')
    assert.equal(records[0].toolName, 'Bash')
    assert.equal(records[0].permissionMode, 'bypassPermissions')
    assert.equal(records[0].toolUseId, D1_PAYLOAD.tool_use_id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('main: a record that cannot be written still asks', async () => {
  const root = attachedRoot(D1_PAYLOAD.cwd)
  try {
    // A FILE where the records folder must go: every write under it fails.
    writeFileSync(join(root, 'floor', 'asks'), 'not a folder')
    const out = await main({ stdin: stdinOf(JSON.stringify(D1_PAYLOAD)), env: {}, stateRoot: root, write: async () => {} })
    assert.equal(out, floorAskOutput(DELETE_WORDS))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('main: stdin is read as bytes, so a multi byte path is not garbled', async () => {
  const root = attachedRoot('/w/agent')
  try {
    const payload = hookInput('Write', { file_path: '/home/kc/.ssh/clés', content: '☃' })
    const bytes = Buffer.from(payload, 'utf8')
    // Split the stream inside a multi byte character: a text mode read that
    // decoded chunk by chunk would mangle it.
    const cut = bytes.indexOf(0xc3) + 1
    const out = await main({
      stdin: Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]),
      env: { CLAUDE_PROJECT_DIR: '/w/agent' },
      stateRoot: root,
      write: async () => {},
    })
    assert.equal(out, floorAskOutput('changing a settings file in your home folder'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const failOpenRuns: Array<[string, Parameters<typeof main>[0]]> = [
  ['bad JSON on stdin', { stdin: stdinOf('{{{') }],
  [
    'a classifier that throws',
    {
      stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
      loadCore: async () => ({
        classifyToolCall: () => {
          throw new Error('boom')
        },
      }),
    },
  ],
  [
    'a core that will not load',
    {
      stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
      loadCore: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')),
    },
  ],
  [
    'a state module that will not load',
    {
      stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
      loadState: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')),
    },
  ],
  [
    'a stdin that errors mid read',
    {
      stdin: Readable.from(
        (async function* () {
          yield Buffer.from('{"tool_name":')
          throw new Error('EPIPE')
        })(),
      ),
    },
  ],
  ['a payload over the byte bound', { stdin: stdinOf(JSON.stringify(D1_PAYLOAD)), maxBytes: 16 }],
  [
    'a write that throws',
    {
      stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
      write: () => Promise.reject(new Error('EPIPE')),
    },
  ],
]

for (const [name, opts] of failOpenRuns) {
  test(`main fails open with exit code 0: ${name}`, async () => {
    process.exitCode = 3
    const written: string[] = []
    const out = await main({
      write: async (text: string) => {
        written.push(text)
      },
      ...opts,
    })
    assert.equal(process.exitCode, 0, 'a hook that exits non zero is not a hook that asked')
    if (name !== 'a write that throws') {
      assert.equal(out, '')
      assert.deepEqual(written, [])
    }
  })
}

test('the budget: a stdin that never ends gives up in time, prints nothing, exits 0', async () => {
  const stdin = new PassThrough()
  stdin.write('{"hook_event_name":"PreToolUse","tool_name":"Bash",')
  const written: string[] = []
  process.exitCode = 3
  const started = performance.now()
  const out = await main({
    stdin,
    budgetMs: 60,
    write: async (text: string) => {
      written.push(text)
    },
  })
  const took = performance.now() - started
  stdin.destroy()
  assert.equal(out, '')
  assert.deepEqual(written, [])
  assert.equal(process.exitCode, 0)
  assert.ok(took < 1000, `gave up after ${took.toFixed(0)} ms`)
})

test('the budget: a core that never loads gives up in time too', async () => {
  const out = await main({
    stdin: stdinOf(JSON.stringify(D1_PAYLOAD)),
    budgetMs: 60,
    loadCore: () => new Promise(() => {}),
    write: async () => {},
  })
  assert.equal(out, '')
})

test('the budget is under two seconds and inside the manifest timeout', () => {
  assert.ok(FLOOR_HOOK_BUDGET_MS < 2000)
  const manifest = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const floor = manifest.hooks.PreToolUse.flatMap((m: { hooks: Array<{ args: string[]; timeout: number }> }) => m.hooks)
    .find((h: { args: string[] }) => h.args.some((a) => a.endsWith('/bin/hoai-floor-hook.mjs')))
  assert.ok(floor, 'the manifest registers this script')
  // The script's own hard stop is the budget plus 300 ms; the CLI's kill is the timeout.
  assert.ok(FLOOR_HOOK_BUDGET_MS + 300 < floor.timeout * 1000)
})

// ── The real process, the way the CLI runs it ─────────────────────────────────

/** The real process, with the plugin state folder the test chose. */
const runHook = (input: string, root = PROCESS_ROOT) =>
  spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: '' },
  })

/** A daemon that stays alive for the whole file: this test process. */
const PROCESS_ROOT = attachedRoot(D1_PAYLOAD.cwd)
process.on('exit', () => rmSync(PROCESS_ROOT, { recursive: true, force: true }))

test('as a process: a listed action prints the ask line and exits 0', () => {
  const run = runHook(JSON.stringify(D1_PAYLOAD))
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, floorAskOutput(DELETE_WORDS))
  assert.equal(run.stderr, '')
})

test('as a process: with no daemon attached, a listed action prints nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'hoai-floor-state-'))
  try {
    const run = runHook(JSON.stringify(D1_PAYLOAD), empty)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '')
    assert.ok(attachedMarkerPath(empty, floorKey(D1_PAYLOAD.cwd)).length > 0)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('as a process: an unlisted action and junk print nothing and exit 0', () => {
  for (const input of [hookInput('Bash', { command: 'git status' }), 'not json', '']) {
    const run = runHook(input)
    assert.equal(run.status, 0, `${input}: ${run.stderr}`)
    assert.equal(run.stdout, '', input)
  }
})

test('as a process: a stdin that is never closed still ends, inside the budget, with exit 0', async () => {
  const child = spawn(process.execPath, [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.write('{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":')
  let stdout = ''
  child.stdout.on('data', (d) => {
    stdout += String(d)
  })
  const started = performance.now()
  const code = await new Promise<number | null>((resolve) => {
    const guard = setTimeout(() => {
      child.kill()
      resolve(-1)
    }, 8000)
    child.on('exit', (exitCode) => {
      clearTimeout(guard)
      resolve(exitCode)
    })
  })
  const took = performance.now() - started
  assert.equal(code, 0, 'the CLI must never see a non zero exit from this hook')
  assert.equal(stdout, '')
  // Node start plus the budget; the manifest's 3 s timeout is the outer wall.
  assert.ok(took < 3000, `took ${took.toFixed(0)} ms`)
})

test('the entry point check: the script itself, through a link, and nothing else', () => {
  const url = pathToFileURL(HOOK_PATH).href
  assert.equal(isEntryPoint(HOOK_PATH, url), true)
  assert.equal(isEntryPoint(undefined as never, url), false)
  assert.equal(isEntryPoint('', url), false)
  assert.equal(isEntryPoint(join(tmpdir(), 'no-such-hoai-floor-hook.mjs'), url), false)
  // Imported by this test, it is NOT the entry point, so importing it ran nothing.
  assert.equal(isEntryPoint(), false)
  // A plugin root reached through a symlink: argv keeps the link, node resolves
  // the module URL. Where the OS refuses an unprivileged symlink (Windows
  // without developer mode) the link half cannot be built and is skipped.
  const dir = mkdtempSync(join(tmpdir(), 'hoai-floor-link-'))
  try {
    const link = join(dir, 'hoai-floor-hook.mjs')
    let linked = true
    try {
      symlinkSync(HOOK_PATH, link)
    } catch {
      linked = false
    }
    if (linked) assert.equal(isEntryPoint(link, url), true, 'a symlinked root still runs the floor')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
