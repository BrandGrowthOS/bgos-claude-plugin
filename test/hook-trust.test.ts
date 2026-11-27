/**
 * An agent folder's hooks when the folder, or what is in it, was put there by someone else.
 *
 * A clone keeps an agent folder's hooks in that folder's `.claude/settings.local.json`, and a launch, a boot, an
 * update and `hoai hooks` all write them there. Everything in the folder is the folder's to say: its `.mcp.json`,
 * its settings file, a link in place of either. None of it may decide which scripts the hooks run, where the
 * write lands, or whether an owner's own hook stays. This file holds each of those rules on real temp folders.
 *
 * Run: npx tsx --test test/hook-trust.test.ts
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildRunPlan, main } from '../bin/hoai-core.mjs'
import * as preseed from '../lib/claude-preseed.mjs'
import { FLOOR_HOOK_MATCHER, ensureHookEntries } from '../lib/claude-preseed.mjs'
import * as cloneHooks from '../lib/clone-hooks.mjs'
import { registerCloneHooks } from '../lib/clone-hooks.mjs'
import { registersFloorHook } from '../lib/floor-hook-presence.ts'
import { registersPrivateHook } from '../lib/private-hook-presence.ts'
import { fileSymlinkRefused, linkFolder } from './helpers/links.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'

const repoRoot = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'))
const BIN = join(repoRoot, 'bin')
const FORWARDER = join(BIN, 'hoai-hook.mjs')
const SCRIPTS = ['hoai-hook.mjs', 'hoai-floor-hook.mjs', 'hoai-private-turn-hook.mjs', 'hoai-mission-turn-hook.mjs']

/** A folder that looks like a checkout: a server.ts and a bin with every hook script (or `only` of them). */
function lookalikeCheckout(only: readonly string[] = SCRIPTS): string {
  const dir = realpathSync.native(scratchDir('hook-trust-checkout-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'server.ts'), '')
  for (const name of only) writeFileSync(join(dir, 'bin', name), '// not this checkout\n')
  return dir
}

/** An agent folder whose .mcp.json holds `servers` (a bgos entry starting `checkout` by default). */
function agentFolder(checkout = repoRoot, servers?: Record<string, unknown>): string {
  const dir = realpathSync.native(scratchDir('hook-trust-agent-'))
  const entries = servers ?? { bgos: { command: 'bun', args: [join(checkout, 'server.ts')], env: { BGOS_ASSISTANT_ID: '7' } } }
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: entries }))
  return dir
}
const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json')
const settingsText = (dir: string) => readFileSync(settingsPath(dir), 'utf8')

/** Every script path the hooks of a settings text run. */
function hookPaths(text: string): string[] {
  const hooks = JSON.parse(text.replace(/^﻿/, '')).hooks ?? {}
  return (Object.values(hooks) as Array<Array<{ hooks?: Array<{ args?: string[] }> }>>)
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => hook.args?.[0] ?? '')
    .filter(Boolean)
}

/** Run `hoai <argv>` in `cwd` as the launcher of `scriptDir`. Starting claude fails the test. */
async function hoai(argv: string[], cwd: string, more: Record<string, unknown> = {}) {
  const said: string[] = []
  const errors: string[] = []
  const code = await main(argv, {
    env: {},
    home: realpathSync.native(scratchDir('hook-trust-home-')),
    cwd,
    scriptDir: BIN,
    print: (line: string) => said.push(line),
    printError: (line: string) => errors.push(line),
    spawnImpl: (() => assert.fail('hoai hooks starts nothing')) as never,
    ...more,
  } as never)
  return { code, said: said.join('\n'), errors: errors.join('\n') }
}

/** The real file system as lib/clone-hooks.mjs asks it, with `realpath` answered by `realpathOf` first. */
function diskAsked(realpathOf: (path: string) => string | undefined = () => undefined, kindOf: (path: string) => string | undefined = () => undefined) {
  return {
    readFile: (path: string) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    realpath: (path: string) => {
      const mapped = realpathOf(path)
      if (mapped !== undefined) return mapped
      try {
        return realpathSync.native(path)
      } catch {
        return null
      }
    },
    identity: (path: string) => {
      try {
        const stat = statSync(path, { bigint: true })
        return `${stat.dev}:${stat.ino}`
      } catch {
        return null
      }
    },
    kind: (path: string) => {
      const given = kindOf(path)
      if (given !== undefined) return given
      try {
        const stat = lstatSync(path)
        return stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other'
      } catch {
        return null
      }
    },
  }
}

// -- the hook scripts come from the install that runs, never from the folder --------------------------------------

test('a launch writes the hook scripts of its own checkout, never those of a checkout the folder names', () => {
  const planted = lookalikeCheckout()
  const dir = agentFolder(planted)
  const plan = buildRunPlan({ cwd: dir, env: {}, home: realpathSync.native(scratchDir('hook-trust-home-')), scriptDir: BIN })
  assert.ok(plan.ok, JSON.stringify(plan))
  assert.equal(plan.hooks?.forwarderPath, FORWARDER, 'the folder\'s .mcp.json chose which scripts the hooks run')
})

test('a boot never runs the scripts beside a forwarder that the settings file names, even when that forwarder is this checkout\'s own file', () => {
  // The settings name a folder whose hoai-hook.mjs leads to this checkout's forwarder, and whose other scripts do not.
  const planted = lookalikeCheckout()
  const plantedForwarder = join(planted, 'bin', 'hoai-hook.mjs')
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: plantedForwarder })
  assert.ok(hookPaths(settingsText(dir)).some((path) => path.startsWith(planted)))
  const fs = diskAsked((path) => (path === plantedForwarder ? FORWARDER : undefined))
  const result = registerCloneHooks({ workdir: dir, pluginDir: repoRoot, fs } as never)
  const paths = hookPaths(settingsText(dir))
  assert.deepEqual(paths.filter((path) => !path.startsWith(BIN)), [], `${result.outcome}: the hooks still run scripts of a folder the settings named`)
  assert.equal(result.outcome, 'registered')
})

test('a hook script of the checkout that is missing, or a link, is refused: nothing is written', async () => {
  // A checkout with no mission turn hook script.
  const partial = lookalikeCheckout(SCRIPTS.filter((name) => name !== 'hoai-mission-turn-hook.mjs'))
  const dir = agentFolder(partial)
  const boot = registerCloneHooks({ workdir: dir, pluginDir: partial })
  assert.equal(boot.outcome, 'failed', 'hooks were written that run a script the checkout does not have')
  assert.match(String(boot.detail), /hoai-mission-turn-hook\.mjs/)
  assert.equal(existsSync(settingsPath(dir)), false)
  const command = await hoai(['hooks'], dir, { scriptDir: join(partial, 'bin') })
  assert.equal(command.code, 1, `hoai hooks ended ${command.code}: ${command.said}`)
  assert.equal(existsSync(settingsPath(dir)), false)
  // A checkout whose floor hook script is a link to somewhere else.
  const whole = lookalikeCheckout()
  const linked = agentFolder(whole)
  const floor = join(whole, 'bin', 'hoai-floor-hook.mjs')
  const fs = diskAsked(undefined, (path) => (path === floor ? 'link' : undefined))
  const viaLink = registerCloneHooks({ workdir: linked, pluginDir: whole, fs } as never)
  assert.equal(viaLink.outcome, 'failed')
  assert.match(String(viaLink.detail), /hoai-floor-hook\.mjs/)
  assert.equal(existsSync(settingsPath(linked)), false)
})

// -- the write stays in the folder ---------------------------------------------------------------------------------

test('a .claude folder that is a link is refused, and nothing lands where it points', () => {
  const dir = agentFolder()
  const elsewhere = realpathSync.native(scratchDir('hook-trust-elsewhere-'))
  linkFolder(elsewhere, join(dir, '.claude'))
  assert.throws(() => ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: FORWARDER }), /link/)
  assert.equal(existsSync(join(elsewhere, 'settings.local.json')), false, 'the settings write left the agent folder')
  const boot = registerCloneHooks({ workdir: dir, pluginDir: repoRoot })
  assert.equal(boot.outcome, 'failed')
  assert.equal(existsSync(join(elsewhere, 'settings.local.json')), false)
})

test('a settings file that is a hard link to another file is refused and left as it is', () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  const other = join(realpathSync.native(scratchDir('hook-trust-other-')), 'owner.json')
  writeFileSync(other, '{ "permissions": { "allow": ["Bash(ls)"] } }')
  linkSync(other, settingsPath(dir))
  assert.throws(() => ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: FORWARDER }), /link/)
  assert.equal(statSync(settingsPath(dir)).nlink, 2, 'the link was replaced')
  assert.equal(readFileSync(other, 'utf8'), '{ "permissions": { "allow": ["Bash(ls)"] } }')
})

test('a settings file that is a symbolic link is refused, and the file it points at is not read or written', { skip: fileSymlinkRefused }, () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  const other = join(realpathSync.native(scratchDir('hook-trust-other-')), 'owner.json')
  writeFileSync(other, '{}')
  symlinkSync(other, settingsPath(dir), 'file')
  assert.throws(() => ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: FORWARDER }), /link/)
  assert.equal(lstatSync(settingsPath(dir)).isSymbolicLink(), true)
  assert.equal(readFileSync(other, 'utf8'), '{}')
})

test('the temp file is always a new file: a link planted at a temp name is never written through', { skip: fileSymlinkRefused }, () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  const other = join(realpathSync.native(scratchDir('hook-trust-other-')), 'target.json')
  writeFileSync(other, 'untouched')
  symlinkSync(other, `${settingsPath(dir)}.${process.pid}.tmp`, 'file')
  try {
    ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: FORWARDER })
  } catch {
    // Refusing is fine too. Writing through the link is not.
  }
  assert.equal(readFileSync(other, 'utf8'), 'untouched')
})

test('the rename lands in the folder it verified: a .claude swapped for a link before the rename is refused', () => {
  const bound: any = (preseed as Record<string, unknown>).folderBoundSettingsFs
  assert.equal(typeof bound, 'function', 'lib/claude-preseed.mjs has no folder bound file layer for the settings write')
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  const fs = bound(settingsPath(dir))
  assert.equal(fs.readFile(settingsPath(dir)), null)
  const temp = fs.tempPathFor(settingsPath(dir))
  assert.equal(dirname(temp), join(dir, '.claude'))
  fs.writeFile(temp, '{}', { mode: 0o600 })
  const elsewhere = realpathSync.native(scratchDir('hook-trust-swap-'))
  renameSync(join(dir, '.claude'), join(dir, '.claude-moved'))
  linkFolder(elsewhere, join(dir, '.claude'))
  assert.throws(() => fs.rename(temp, settingsPath(dir)))
  assert.equal(existsSync(join(elsewhere, 'settings.local.json')), false)
})

// -- the floor is decided from the file's entries, and never taken away --------------------------------------------

test('a registration that finds the floor hook and no rail keeps the floor hook', () => {
  const floorOnly = {
    hooks: { PreToolUse: [{ matcher: FLOOR_HOOK_MATCHER, hooks: [{ type: 'command', command: 'node', args: [join(BIN, 'hoai-floor-hook.mjs')], timeout: 3, async: false }] }] },
  }
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  writeFileSync(settingsPath(dir), JSON.stringify(floorOnly, null, 2))
  const boot = registerCloneHooks({ workdir: dir, pluginDir: repoRoot })
  assert.equal(boot.outcome, 'registered')
  assert.ok(hookPaths(settingsText(dir)).includes(join(BIN, 'hoai-floor-hook.mjs')), 'the registration removed the floor hook the folder had')
  assert.equal(boot.floor, true)
})

test('the rail is read from the entries, not from the text: a file that only mentions the forwarder gets no floor from the first registration', () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  writeFileSync(settingsPath(dir), JSON.stringify({ permissions: { allow: ['Bash(node bin/hoai-hook.mjs)'] } }, null, 2))
  const boot = registerCloneHooks({ workdir: dir, pluginDir: repoRoot })
  assert.equal(boot.outcome, 'registered')
  assert.equal(hookPaths(settingsText(dir)).some((path) => path.endsWith('hoai-floor-hook.mjs')), false)
  assert.equal(boot.floor, false)
})

// -- a launch that needs the floor does not start without it -------------------------------------------------------

test('the line for a PowerShell launcher of your own stops it when hoai hooks fails', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  assert.match(readme, /hoai hooks; if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/, 'a PowerShell script goes on after a native command that failed')
})

// -- one snapshot, one server, one install --------------------------------------------------------------------------

test('hoai hooks reads the folder\'s .mcp.json once and admits the folder only by an entry that starts this checkout', async () => {
  const dir = agentFolder()
  let reads = 0
  const readFile = (path: string) => {
    if (path === join(dir, '.mcp.json')) reads += 1
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  const { code, errors } = await hoai(['hooks'], dir, { readFile })
  assert.equal(code, 0, errors)
  assert.equal(reads, 1, `the .mcp.json was read ${reads} times: each read can answer differently`)
  // A renamed entry that starts this checkout is this checkout's folder.
  const renamed = agentFolder(repoRoot, { atlas: { command: 'bun', args: [join(repoRoot, 'server.ts')] } })
  const atlas = await hoai(['hooks'], renamed)
  assert.equal(atlas.code, 0, atlas.errors)
})

test('a name like the clone\'s, or a BGOS_ key in an entry\'s env, does not make a folder this checkout\'s agent folder', async () => {
  const folders: Array<[string, Record<string, unknown>]> = [
    ['an entry named bgos that starts no checkout', { bgos: { command: 'cmd', args: ['/c', `bun "${join(repoRoot, 'server.ts')}"`] } }],
    ['another tool with a BGOS_ key', { files: { command: 'node', args: ['/opt/tool/index.mjs'], env: { BGOS_ASSISTANT_ID: '7' } } }],
    ['another checkout', { bgos: { command: 'bun', args: [join(lookalikeCheckout(), 'server.ts')], env: { BGOS_ASSISTANT_ID: '7' } } }],
    ['this checkout from two entries', { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] }, bgos2: { command: 'bun', args: [join(repoRoot, 'server.ts')] } }],
  ]
  for (const [name, servers] of folders) {
    const dir = agentFolder(repoRoot, servers)
    const { code, said, errors } = await hoai(['hooks'], dir)
    assert.equal(code, 1, `${name}: it ended ${code} and said: ${said}`)
    assert.equal(existsSync(settingsPath(dir)), false, name)
    assert.match(errors, /\.mcp\.json/, name)
  }
})

// -- one structural definition per hook of the plugin ---------------------------------------------------------------

test('an owner\'s hook that only resembles one of the plugin\'s is kept, whatever its path', () => {
  const owners = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['/home/me/bin/hoai-hook.mjs', '--mine'], timeout: 5, async: true }] }],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['/home/me/bin/hoai-floor-hook.mjs'], async: false }] },
      { hooks: [{ type: 'command', command: 'python3', args: ['/home/me/bin/hoai-floor-hook.mjs'] }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/old/bin/hoai-hook.mjs"' }] }],
  }
  const files = new Map([['/agent/.claude/settings.local.json', JSON.stringify({ hooks: owners })]])
  const fs = { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, text: string) => void files.set(p, text) }
  ensureHookEntries({ settingsPath: '/agent/.claude/settings.local.json', forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never)
  const hooks = JSON.parse(files.get('/agent/.claude/settings.local.json')!).hooks
  for (const [event, groups] of Object.entries(owners)) {
    for (const group of groups) {
      assert.ok(
        hooks[event].some((kept: unknown) => JSON.stringify(kept) === JSON.stringify(group)),
        `${event}: the owner's ${JSON.stringify(group)} was dropped`,
      )
    }
  }
})

test('a copy of one of the plugin\'s hooks is not left beside it: duplicates are reconciled to exactly one', () => {
  const files = new Map<string, string>()
  const fs = { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, text: string) => void files.set(p, text) }
  const path = '/agent/.claude/settings.local.json'
  ensureHookEntries({ settingsPath: path, forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never)
  const settings = JSON.parse(files.get(path)!)
  settings.hooks.SessionStart.push(structuredClone(settings.hooks.SessionStart[0]))
  settings.hooks.PreToolUse.push(structuredClone(settings.hooks.PreToolUse.find((group: { matcher?: string }) => group.matcher === FLOOR_HOOK_MATCHER)))
  files.set(path, JSON.stringify(settings, null, 2))
  assert.equal(ensureHookEntries({ settingsPath: path, forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never).reason, 'set', 'two copies of one hook were taken as current')
  const after = JSON.parse(files.get(path)!).hooks
  assert.equal(after.SessionStart.length, 1)
  assert.equal(after.PreToolUse.filter((group: { matcher?: string }) => group.matcher === FLOOR_HOOK_MATCHER).length, 1)
  assert.equal(ensureHookEntries({ settingsPath: path, forwarderPath: '/p/bin/hoai-hook.mjs', fs } as never).reason, 'already')
})

test('the daemon counts only the plugin\'s own floor and private turn entries, not a hook that mentions their names', () => {
  const opts = { exists: () => true, pluginRootVariable: false }
  const mention = (event: string, name: string, matcher?: string) => ({
    hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'bash', args: ['-c', `echo /p/bin/${name}`] }] }] },
  })
  assert.equal(registersFloorHook(mention('PreToolUse', 'hoai-floor-hook.mjs', FLOOR_HOOK_MATCHER), opts), false)
  assert.equal(registersPrivateHook(mention('UserPromptSubmit', 'hoai-private-turn-hook.mjs'), opts), false)
  // The floor script under a matcher that does not reach the listed tools stops none of them.
  const narrow = { hooks: { PreToolUse: [{ matcher: '^Read$', hooks: [{ type: 'command', command: 'node', args: ['/p/bin/hoai-floor-hook.mjs'], timeout: 3, async: false }] }] } }
  assert.equal(registersFloorHook(narrow, opts), false)
  // What the writer writes still counts.
  const files = new Map<string, string>()
  ensureHookEntries({ settingsPath: '/a/s.json', forwarderPath: '/p/bin/hoai-hook.mjs', fs: { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, t: string) => void files.set(p, t) } } as never)
  const written = JSON.parse(files.get('/a/s.json')!)
  assert.equal(registersFloorHook(written, opts), true)
  assert.equal(registersPrivateHook(written, opts), true)
})

// -- bounded reads, and an edit that lands between the read and the write ------------------------------------------

test('a settings file far larger than any agent folder needs is refused and left as it is', () => {
  const dir = agentFolder()
  mkdirSync(join(dir, '.claude'))
  const big = JSON.stringify({ permissions: { allow: Array.from({ length: 40_000 }, (_, i) => `Bash(echo ${'x'.repeat(40)} ${i})`) } })
  assert.ok(big.length > 1_100_000)
  writeFileSync(settingsPath(dir), big)
  assert.throws(() => ensureHookEntries({ settingsPath: settingsPath(dir), forwarderPath: FORWARDER }), /settings\.local\.json/)
  assert.equal(settingsText(dir), big)
})

test('a settings file with thousands of hook entries is refused and left as it is', () => {
  const files = new Map([['/agent/.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: Array.from({ length: 5000 }, () => ({ hooks: [{ type: 'command', command: 'true' }] })) } })]])
  const before = files.get('/agent/.claude/settings.local.json')
  const fs = { readFile: (p: string) => files.get(p) ?? null, writeFile: (p: string, text: string) => void files.set(p, text) }
  assert.throws(() => ensureHookEntries({ settingsPath: '/agent/.claude/settings.local.json', forwarderPath: FORWARDER, fs } as never), /settings\.local\.json/)
  assert.equal(files.get('/agent/.claude/settings.local.json'), before)
})

test('an edit another program makes between the read and the rename is merged, not lost', () => {
  const path = '/agent/.claude/settings.local.json'
  const files = new Map([[path, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } })]])
  let edited = false
  const fs = {
    readFile: (p: string) => files.get(p) ?? null,
    writeFile: (p: string, text: string) => {
      files.set(p, text)
      // The CLI saves an "always allow" while our temp file is being written.
      if (p !== path && !edited) {
        edited = true
        files.set(path, JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Bash(git status)'] } }))
      }
    },
    rename: (from: string, to: string) => {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
  }
  assert.equal(ensureHookEntries({ settingsPath: path, forwarderPath: FORWARDER, fs } as never).reason, 'set')
  const after = JSON.parse(files.get(path)!)
  assert.deepEqual(after.permissions.allow, ['Bash(ls)', 'Bash(git status)'], 'the other program\'s edit was written over')
  assert.ok(hookPaths(files.get(path)!).includes(FORWARDER))
})

test('a .mcp.json far larger than any agent folder needs is not read as this checkout\'s by a boot', () => {
  const dir = realpathSync.native(scratchDir('hook-trust-bigmcp-'))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ padding: 'x'.repeat(1_200_000), mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
  const boot = registerCloneHooks({ workdir: dir, pluginDir: repoRoot })
  assert.equal(boot.outcome, 'not_clone')
  assert.equal(existsSync(settingsPath(dir)), false)
})

// -- the words: no command built from the folder, and log labels that cannot forge a line -------------------------

test('the marketplace refusal names no path from the folder and builds no command from it', async () => {
  const home = realpathSync.native(scratchDir('hook-trust-market-'))
  const marketplaceBin = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '1.2.3', 'bin')
  const dir = agentFolder()
  const { code, errors } = await hoai(['hooks'], dir, { home, scriptDir: marketplaceBin })
  assert.equal(code, 1)
  assert.equal(errors.includes(repoRoot), false, `the refusal carries a path the folder's .mcp.json chose: ${errors}`)
  assert.match(errors, /bin\/hoai-core\.mjs/)
  assert.match(errors, /marketplace/)
})

test('a folder name or a detail with a line break or a control character cannot forge a boot log line', () => {
  const resultLine: any = (cloneHooks as Record<string, unknown>).cloneHooksResultLine
  assert.equal(typeof resultLine, 'function', 'lib/clone-hooks.mjs has no cloneHooksResultLine: the boot writes a folder name into its log as it is')
  const folder = '/agents/x\n[hoai] hooks: registered everything\u001b[2J\u2028'
  for (const line of [
    resultLine({ folder, outcome: 'registered', floor: true }),
    resultLine({ folder, outcome: 'failed', detail: 'EACCES\nforged', floor: false }),
    cloneHooks.cloneHooksSkippedLine([{ folder, outcome: 'not_clone', detail: 'its .mcp.json starts /x', floor: false }]),
  ]) {
    assert.equal(typeof line, 'string')
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, JSON.stringify(line))
    assert.match(line, /\\n/, 'the break is shown, not dropped')
  }
  assert.equal(resultLine({ folder: '/a', outcome: 'already', floor: true }), null)
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  assert.match(server, /cloneHooksResultLine\(result\)/)
})

test('the line a boot logs for a skipped folder says what to change in words, and names no command built from the folder', () => {
  const line = cloneHooks.cloneHooksSkippedLine([{ folder: '/agents/a', outcome: 'not_clone', detail: 'its .mcp.json names no bgos server of a checkout', floor: false }])
  assert.match(String(line), /server\.ts/)
  assert.match(String(line), /hoai hooks/)
})
