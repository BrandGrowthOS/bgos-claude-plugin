/**
 * The Claude Code auto memory store behind memory_rpc (HOAI P7 stage 2, C-39).
 *
 * An owner changes this agent's memory from the app, and the daemon edits the
 * SAME folder the CLI reads at the agent's next start. Two things make that
 * dangerous, and most of this file is about them:
 *
 * 1. The wrong folder looks exactly like the right one. The CLI keys the folder
 *    by the git root of the agent folder (a worktree shares the main
 *    repository's), lets a setting move it, and creates it at every session
 *    start. So the store finds it by the CLI's own rule, never creates it, and
 *    refuses rather than guesses.
 * 2. The model and the CLI write the same folder while we do. Every write goes
 *    through a temp file and a rename, the index is compared right before it is
 *    replaced, and whatever we take away is kept in a trash OUTSIDE the memory
 *    folder so an Undo brings the whole note back.
 *
 * Everything runs over the in memory fs in test/helpers/memory-fs.ts; one test
 * at the end drives the node adapter over a real temporary folder.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoryFs, type MemoryFs as TestFs } from './helpers/memory-fs.ts'
import {
  createClaudeMemoryStore,
  mungeMemoryKey,
  nodeMemoryFs,
  parseMemoryIndexLine,
  resolveMemoryFolder,
  type MemoryFolderAnswer,
} from '../lib/memory.ts'

const CFG = '/cfg'
const HOME = '/home/k'
const AGENT = '/home/k/agent'
const MEM = '/cfg/projects/-home-k-agent/memory'
const INDEX = `${MEM}/MEMORY.md`
const TRASH = '/state/701/memory-trash'
const NOW = Date.parse('2026-09-25T10:00:00.000Z')
const EM = '\u2014'
const EN = '\u2013'

/** A topic file in the CLI's own shape: nested metadata with the type. */
function note(name: string, type: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${body}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`
}

/** The fs the store sees, with every write, rename, removal and mkdir logged in order. */
function harness(initial: Record<string, string> = {}, dirs: string[] = [MEM]) {
  const raw = memoryFs(initial, dirs)
  const log: string[] = []
  const fs: TestFs = {
    ...raw,
    writeFile: (p, t, o) => {
      log.push(`write ${p}`)
      raw.writeFile(p, t, o)
    },
    rename: (a, b) => {
      log.push(`rename ${a} -> ${b}`)
      raw.rename(a, b)
    },
    rm: (p) => {
      log.push(`rm ${p}`)
      raw.rm(p)
    },
    mkdir: (p) => {
      log.push(`mkdir ${p}`)
      raw.mkdir(p)
    },
  }
  return { fs, raw, log }
}

function storeOver(fs: TestFs, resolve?: () => MemoryFolderAnswer) {
  return createClaudeMemoryStore({
    fs,
    resolve: resolve ?? (() => ({ ok: true, memDir: MEM })),
    trashDir: TRASH,
    now: () => NOW,
  })
}

function texts(answer: any, store: 'memory' | 'user'): string[] {
  assert.equal(answer.ok, true, `expected ok, got ${JSON.stringify(answer)}`)
  return answer.stores[store].entries.map((e: { text: string }) => e.text)
}

function trashNames(raw: TestFs): string[] {
  return raw.listDir(TRASH).filter((n) => n.endsWith('.json'))
}

function filesUnder(raw: TestFs, dir: string): string[] {
  return [...raw.files.keys()].filter((k) => k.startsWith(dir + '/')).sort()
}

// ── Which folder ─────────────────────────────────────────────────────────────

test('a plain folder: every character that is not a letter or digit becomes a hyphen', () => {
  const fs = memoryFs({}, ['/cfg/projects/-home-k-agent-f-1-v-2/memory'])
  assert.deepEqual(
    resolveMemoryFolder({ fs, agentDir: '/home/k/agent f_1.v 2', configDir: CFG, home: HOME, env: {} }),
    { ok: true, memDir: '/cfg/projects/-home-k-agent-f-1-v-2/memory' },
  )
  assert.equal(mungeMemoryKey('/home/k/agent f_1.v 2'), '-home-k-agent-f-1-v-2')
  assert.equal(mungeMemoryKey('C:\\Users\\k\\agent'), 'C--Users-k-agent')
  // A Windows host joins with its own separator, so the folder the CLI made is the one found.
  const win = memoryFs({}, ['C:\\Users\\k\\.claude\\projects\\C--Users-k-agent\\memory'])
  assert.deepEqual(
    resolveMemoryFolder({
      fs: win,
      agentDir: 'C:\\Users\\k\\agent',
      configDir: 'C:\\Users\\k\\.claude',
      home: 'C:\\Users\\k',
      env: {},
    }),
    { ok: true, memDir: 'C:\\Users\\k\\.claude\\projects\\C--Users-k-agent\\memory' },
  )
})

test("a subfolder of a git repository uses the repository's root", () => {
  const fs = memoryFs({}, ['/r/.git', '/r/sub', '/cfg/projects/-r/memory', '/cfg/projects/-r-sub/memory'])
  assert.deepEqual(
    resolveMemoryFolder({ fs, agentDir: '/r/sub', configDir: CFG, home: HOME, env: {} }),
    { ok: true, memDir: '/cfg/projects/-r/memory' },
  )
})

test('a git worktree uses the main repository', () => {
  const fs = memoryFs(
    {
      '/w/.git': 'gitdir: /r/.git/worktrees/w\n',
      '/r/.git/worktrees/w/commondir': '../..\n',
      // A relative gitdir, the way some tools write it.
      '/w2/.git': 'gitdir: ../r/.git/worktrees/w2\n',
      '/r/.git/worktrees/w2/commondir': '../..\n',
      // A submodule: a .git FILE with no commondir is its own repository.
      '/s/.git': 'gitdir: /r/.git/modules/s\n',
      '/r/.git/HEAD': 'ref: refs/heads/main\n',
    },
    ['/cfg/projects/-r/memory', '/cfg/projects/-w/memory', '/cfg/projects/-w2/memory', '/cfg/projects/-s/memory'],
  )
  const at = (agentDir: string) => resolveMemoryFolder({ fs, agentDir, configDir: CFG, home: HOME, env: {} })
  assert.deepEqual(at('/w'), { ok: true, memDir: '/cfg/projects/-r/memory' })
  assert.deepEqual(at('/w2'), { ok: true, memDir: '/cfg/projects/-r/memory' })
  assert.deepEqual(at('/s'), { ok: true, memDir: '/cfg/projects/-s/memory' })
})

test('the memory folder setting wins, local before project before user', () => {
  const files: Record<string, string> = {
    [`${AGENT}/.claude/settings.local.json`]: JSON.stringify({ autoMemoryDirectory: '/m/local' }),
    [`${AGENT}/.claude/settings.json`]: JSON.stringify({ autoMemoryDirectory: '/m/project' }),
    [`${CFG}/settings.json`]: JSON.stringify({ autoMemoryDirectory: '/m/user' }),
  }
  const dirs = ['/m/local', '/m/project', '/m/user', MEM, '/home/k/m']
  const at = (fs: TestFs) => resolveMemoryFolder({ fs, agentDir: AGENT, configDir: CFG, home: HOME, env: {} })
  assert.deepEqual(at(memoryFs(files, dirs)), { ok: true, memDir: '/m/local' })
  const noLocal = { ...files }
  delete noLocal[`${AGENT}/.claude/settings.local.json`]
  assert.deepEqual(at(memoryFs(noLocal, dirs)), { ok: true, memDir: '/m/project' })
  const userOnly = { [`${CFG}/settings.json`]: files[`${CFG}/settings.json`] }
  assert.deepEqual(at(memoryFs(userOnly, dirs)), { ok: true, memDir: '/m/user' })
  // A file that does not set it passes the question on to the next one.
  const passOn = { ...files, [`${AGENT}/.claude/settings.local.json`]: JSON.stringify({ model: 'x' }) }
  assert.deepEqual(at(memoryFs(passOn, dirs)), { ok: true, memDir: '/m/project' })
  const tilde = { [`${AGENT}/.claude/settings.json`]: JSON.stringify({ autoMemoryDirectory: '~/m' }) }
  assert.deepEqual(at(memoryFs(tilde, dirs)), { ok: true, memDir: '/home/k/m' })
})

test('a relative memory folder setting is refused, not guessed', () => {
  const fs = memoryFs(
    { [`${AGENT}/.claude/settings.json`]: JSON.stringify({ autoMemoryDirectory: 'mem/here' }) },
    [`${AGENT}/mem/here`, MEM],
  )
  const answer = resolveMemoryFolder({ fs, agentDir: AGENT, configDir: CFG, home: HOME, env: {} })
  assert.equal(answer.ok, false)
  assert.equal((answer as any).code, 'unavailable')
  assert.equal((answer as any).message, 'the memory folder setting is not a full path')
})

test('the config dir is the one given, never ~/.claude', () => {
  const fs = memoryFs(
    // The owner's own ~/.claude settings must not steer a daemon that runs on another config dir.
    { '/home/k/.claude/settings.json': JSON.stringify({ autoMemoryDirectory: '/m/wrong' }) },
    [MEM, '/home/k/.claude/projects/-home-k-agent/memory', '/m/wrong'],
  )
  assert.deepEqual(resolveMemoryFolder({ fs, agentDir: AGENT, configDir: CFG, home: HOME, env: {} }), {
    ok: true,
    memDir: MEM,
  })
})

test('memory turned off is said so', () => {
  const at = (fs: TestFs, env: Record<string, string>) =>
    resolveMemoryFolder({ fs, agentDir: AGENT, configDir: CFG, home: HOME, env })
  const plain = memoryFs({}, [MEM])
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.deepEqual(at(plain, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: value }), {
      ok: false,
      code: 'memory_off',
      message: 'auto memory is turned off for this agent',
    })
  }
  const projectOff = memoryFs(
    { [`${AGENT}/.claude/settings.json`]: JSON.stringify({ autoMemoryEnabled: false }) },
    [MEM],
  )
  assert.equal((at(projectOff, {}) as any).code, 'memory_off')
  // The first file that sets it decides: local turns it back on over the project.
  const localOn = memoryFs(
    {
      [`${AGENT}/.claude/settings.local.json`]: JSON.stringify({ autoMemoryEnabled: true }),
      [`${AGENT}/.claude/settings.json`]: JSON.stringify({ autoMemoryEnabled: false }),
    },
    [MEM],
  )
  assert.deepEqual(at(localOn, {}), { ok: true, memDir: MEM })
  // The CLI's own switch set to a false value forces memory on whatever the settings say.
  assert.deepEqual(at(projectOff, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }), { ok: true, memDir: MEM })
})

test('a key over 200 characters is refused', () => {
  const long = '/' + 'a'.repeat(209)
  const longMem = `/cfg/projects/${mungeMemoryKey(long)}/memory`
  const fs = memoryFs({}, [long, longMem])
  assert.deepEqual(resolveMemoryFolder({ fs, agentDir: long, configDir: CFG, home: HOME, env: {} }), {
    ok: false,
    code: 'unavailable',
    message: 'the agent folder path is too long to find its memory',
  })
  // Exactly 200 is still found.
  const edge = '/' + 'b'.repeat(199)
  const edgeMem = `/cfg/projects/${mungeMemoryKey(edge)}/memory`
  assert.equal(mungeMemoryKey(edge).length, 200)
  assert.deepEqual(
    resolveMemoryFolder({ fs: memoryFs({}, [edge, edgeMem]), agentDir: edge, configDir: CFG, home: HOME, env: {} }),
    { ok: true, memDir: edgeMem },
  )
})

test('a missing memory folder is refused and nothing is created', () => {
  const { fs, raw, log } = harness({}, [AGENT])
  const store = storeOver(fs, () =>
    resolveMemoryFolder({ fs, agentDir: AGENT, configDir: CFG, home: HOME, env: {} }),
  )
  const expected = { ok: false, code: 'unavailable', message: 'no memory folder found for this agent' }
  assert.deepEqual(store.list(), expected)
  assert.deepEqual(store.add('memory', 'Prefers tea'), expected)
  assert.deepEqual(store.remove('memory', 'Prefers tea'), expected)
  const underProjects = [...raw.files.keys(), ...raw.dirs].filter((p) => p.startsWith('/cfg'))
  assert.deepEqual(underProjects, [])
  assert.deepEqual(log, [])
})

// ── What an entry is ─────────────────────────────────────────────────────────

test('parses the index lines the CLI writes and the ones this store writes', () => {
  assert.deepEqual(parseMemoryIndexLine('- [Home](home.md) - lives in Dubai'), {
    title: 'Home',
    fileName: 'home.md',
    hook: 'lives in Dubai',
    text: 'lives in Dubai',
  })
  assert.equal(parseMemoryIndexLine(`- [Nick](nick.md) ${EM} call me Kc`)?.text, 'call me Kc')
  assert.equal(parseMemoryIndexLine(`- [Nick](nick.md) ${EN} call me Kc`)?.text, 'call me Kc')
  assert.equal(parseMemoryIndexLine('- [Proj](proj.md): ships on Fridays')?.text, 'ships on Fridays')
  assert.equal(parseMemoryIndexLine('  - [Titled](titled.md)')?.text, 'Titled')
  assert.equal(parseMemoryIndexLine('- [Neg](neg.md) - -5 degrees is cold')?.text, '-5 degrees is cold')
  assert.equal(parseMemoryIndexLine('# Memory index'), null)
  assert.equal(parseMemoryIndexLine('- a plain bullet'), null)
  assert.equal(parseMemoryIndexLine('- [x](../x.md) - escape'), null)
  assert.equal(parseMemoryIndexLine('- [x](sub/x.md) - nested'), null)
  assert.equal(parseMemoryIndexLine('- [x](sub\\x.md) - nested'), null)
  assert.equal(parseMemoryIndexLine('- [x](x.txt) - not a note'), null)
  assert.equal(parseMemoryIndexLine('- [x](MEMORY.md) - the index itself'), null)
})

test("lists index lines as entries, split by the linked file's type", () => {
  const index = [
    '# Memory index',
    '- [Home](home.md) - lives in Dubai',
    `- [Nick](nick.md) ${EM} call me Kc`,
    '- [Short](short.md) - wants short answers',
    '- [Proj](proj.md): ships on Fridays',
    '- [Gone](gone.md) - the file is missing',
    '- [Titled](titled.md)',
    `- [Top](top.md) ${EN} top level type`,
    '',
  ].join('\n')
  const { fs } = harness({
    [INDEX]: index,
    [`${MEM}/home.md`]: note('home', 'user', 'lives in Dubai'),
    [`${MEM}/nick.md`]:
      '---\nname: nick\ndescription: call me Kc\nmetadata: {node_type: memory, type: user, originSessionId: 62a4}\n---\n\ncall me Kc\n',
    [`${MEM}/short.md`]: note('short', 'feedback', 'wants short answers'),
    [`${MEM}/proj.md`]: note('proj', 'project', 'ships on Fridays'),
    [`${MEM}/titled.md`]: note('titled', 'user', 'a titled note'),
    [`${MEM}/top.md`]: '---\nname: top\ntype: user\n---\n\ntop level type\n',
  })
  const answer = storeOver(fs).list() as any
  assert.deepEqual(texts(answer, 'user'), ['lives in Dubai', 'call me Kc', 'Titled', 'top level type'])
  assert.deepEqual(texts(answer, 'memory'), ['wants short answers', 'ships on Fridays', 'the file is missing'])
  assert.deepEqual(answer.stores.user.entries[0], { text: 'lives in Dubai', flagged: false, patterns: [] })
  const userLines = [
    '- [Home](home.md) - lives in Dubai',
    `- [Nick](nick.md) ${EM} call me Kc`,
    '- [Titled](titled.md)',
    `- [Top](top.md) ${EN} top level type`,
  ]
  assert.equal(answer.stores.user.chars, userLines.join('\n').length)
  assert.equal(answer.stores.user.limit, 25000)
  assert.equal(answer.stores.memory.limit, 25000)
})

test('shows only what the model reads', () => {
  const { fs } = harness({
    [INDEX]: [
      '- [a](../escape.md) - up and out',
      '- [b](sub/b.md) - nested',
      '- [c](c.txt) - not a note',
      'some prose the model wrote',
      '## A heading',
      '- [d](d.md) - the real one',
      '',
    ].join('\n'),
    [`${MEM}/d.md`]: note('d', 'user', 'the real one'),
    [`${MEM}/orphan.md`]: note('orphan', 'user', 'a topic file with no index line'),
    [`${MEM}/sub/b.md`]: note('b', 'user', 'nested'),
  })
  const answer = storeOver(fs).list() as any
  assert.deepEqual(texts(answer, 'user'), ['the real one'])
  assert.deepEqual(texts(answer, 'memory'), [])
})

// ── add ──────────────────────────────────────────────────────────────────────

test('adds a file and one index line, file first', () => {
  // An empty folder, the way the CLI leaves it at a first start: no index yet.
  const { fs, raw, log } = harness()
  const answer = storeOver(fs).add('memory', 'Prefers tea over coffee') as any
  assert.deepEqual(texts(answer, 'memory'), ['Prefers tea over coffee'])
  assert.equal(
    raw.readFile(`${MEM}/prefers-tea-over-coffee.md`),
    [
      '---',
      'name: prefers-tea-over-coffee',
      'description: "Prefers tea over coffee"',
      'metadata:',
      '  node_type: memory',
      '  type: feedback',
      '  modified: 2026-09-25T10:00:00.000Z',
      '---',
      '',
      'Prefers tea over coffee',
      '',
    ].join('\n'),
  )
  assert.equal(
    raw.readFile(INDEX),
    '- [Prefers tea over coffee](prefers-tea-over-coffee.md) - Prefers tea over coffee\n',
  )
  const fileRename = log.findIndex((l) => l.endsWith(`-> ${MEM}/prefers-tea-over-coffee.md`))
  const indexRename = log.findIndex((l) => l.endsWith(`-> ${INDEX}`))
  assert.ok(fileRename >= 0 && indexRename >= 0, log.join('\n'))
  assert.ok(fileRename < indexRename, `the file must land before the line that points at it:\n${log.join('\n')}`)
  // No temp file is left behind.
  assert.deepEqual(filesUnder(raw, MEM), [INDEX, `${MEM}/prefers-tea-over-coffee.md`])

  // The owner's own facts land in the user store, typed so the CLI files them the same way.
  const user = storeOver(fs).add('user', 'My name is Kc') as any
  assert.deepEqual(texts(user, 'user'), ['My name is Kc'])
  assert.match(raw.readFile(`${MEM}/my-name-is-kc.md`)!, /\n {2}type: user\n/)
  // An index without a final line break still gets the new line on a line of its own.
  raw.writeFile(INDEX, '- [a](a.md) - first')
  raw.writeFile(`${MEM}/a.md`, note('a', 'feedback', 'first'))
  storeOver(fs).add('memory', 'second')
  assert.equal(raw.readFile(INDEX), '- [a](a.md) - first\n- [second](second.md) - second\n')
})

test('a fact with no plain letters gets a hashed file name, and a taken name gets a number', () => {
  const { fs, raw } = harness({ [`${MEM}/tea.md`]: 'someone else wrote this\n' })
  storeOver(fs).add('user', '\u0623\u062d\u0628 \u0627\u0644\u0634\u0627\u064a')
  const names = filesUnder(raw, MEM).map((p) => p.slice(MEM.length + 1))
  assert.ok(names.some((n) => /^memory-[0-9a-f]{8}\.md$/.test(n)), names.join(', '))
  storeOver(fs).add('memory', 'Tea')
  assert.equal(raw.readFile(`${MEM}/tea.md`), 'someone else wrote this\n')
  assert.match(raw.readFile(`${MEM}/tea-2.md`)!, /\nTea\n$/)
  // A fact that slugs to "memory" never becomes memory.md, which IS the index on a case blind disk.
  storeOver(fs).add('memory', 'Memory')
  assert.equal(raw.readFile(`${MEM}/memory.md`), null)
  assert.match(raw.readFile(INDEX)!, /\(memory-2\.md\) - Memory\n/)
})

test('never leaves half a file', () => {
  const index = '- [a](a.md) - first\n'
  const { fs, raw } = harness({ [INDEX]: index, [`${MEM}/a.md`]: note('a', 'feedback', 'first') })
  const failOn = (target: string) => ({
    ...fs,
    rename: (a: string, b: string) => {
      if (b === target) throw new Error('EPERM: the disk said no')
      fs.rename(a, b)
    },
  })
  // The topic file's rename fails: nothing changes and nothing is left behind.
  const first = storeOver(failOn(`${MEM}/second.md`)).add('memory', 'second') as any
  assert.equal(first.ok, false)
  assert.equal(first.code, 'write_failed')
  assert.equal(raw.readFile(INDEX), index)
  assert.deepEqual(filesUnder(raw, MEM), [INDEX, `${MEM}/a.md`])
  // The index's rename fails: the note written for it is taken back, so no orphan is left either.
  const second = storeOver(failOn(INDEX)).add('memory', 'second') as any
  assert.equal(second.code, 'write_failed')
  assert.equal(raw.readFile(INDEX), index)
  assert.deepEqual(filesUnder(raw, MEM), [INDEX, `${MEM}/a.md`])
})

test('adding the same words twice adds nothing', () => {
  const { fs, raw } = harness()
  const store = storeOver(fs)
  store.add('memory', 'Prefers tea')
  const once = raw.readFile(INDEX)
  const again = store.add('memory', '  Prefers\n tea ') as any
  assert.deepEqual(texts(again, 'memory'), ['Prefers tea'])
  assert.equal(raw.readFile(INDEX), once)
  assert.equal(once!.split('\n').filter(Boolean).length, 1)
})

test('a long fact keeps its full text in the file and a short line in the index', () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const long = (words + ' tail').slice(0, 400)
  assert.equal(long.length, 400)
  const { fs, raw } = harness()
  const answer = storeOver(fs).add('memory', long) as any
  const [hook] = texts(answer, 'memory')
  assert.ok(hook.length <= 300, `hook is ${hook.length} characters`)
  assert.ok(hook.endsWith('...'))
  const kept = hook.slice(0, -3)
  assert.ok(long.startsWith(kept), 'the hook is the start of the fact')
  assert.equal(long[kept.length], ' ', 'the hook is cut at a word, not inside one')
  const [line] = raw.readFile(INDEX)!.split('\n')
  assert.ok(line.endsWith(` - ${hook}`))
  const file = [...raw.files.entries()].find(([k]) => k !== INDEX)![1]
  assert.ok(file.endsWith(`\n${long}\n`), 'the note holds every character')
})

test('a full index refuses the add', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `- [n${i}](n${i}.md) - fact ${i}`)
  const full = lines.join('\n') + '\n'
  const { fs, raw } = harness({ [INDEX]: full })
  const answer = storeOver(fs).add('memory', 'one too many') as any
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'over_budget')
  assert.equal(raw.readFile(INDEX), full)
  assert.deepEqual(filesUnder(raw, MEM), [INDEX])

  const heavy = `- [big](big.md) - ${'x'.repeat(24_980)}\n`
  const byBytes = harness({ [INDEX]: heavy, [`${MEM}/big.md`]: note('big', 'feedback', 'big') })
  assert.equal((storeOver(byBytes.fs).add('memory', 'small') as any).code, 'over_budget')
  assert.equal(byBytes.raw.readFile(INDEX), heavy)
})

// ── replace and remove ───────────────────────────────────────────────────────

function twoOfAKind() {
  return harness({
    [INDEX]: [
      '- [Addr](addr.md) - my old address is 5 Main St',
      '- [Tea](tea.md) - likes tea',
      '- [Tea2](tea2.md) - likes tea',
      '- [Name](name.md) - called Kc',
      '',
    ].join('\n'),
    [`${MEM}/addr.md`]: note('addr', 'feedback', 'my old address is 5 Main St'),
    [`${MEM}/tea.md`]: note('tea', 'feedback', 'likes tea'),
    [`${MEM}/tea2.md`]: note('tea2', 'feedback', 'likes tea'),
    [`${MEM}/name.md`]: note('name', 'user', 'called Kc'),
  })
}

test('replace and remove match one entry exactly, never a part of one', () => {
  const { fs, raw } = twoOfAKind()
  const before = raw.readFile(INDEX)
  const store = storeOver(fs)
  const code = (a: any) => (a.ok ? 'ok' : a.code)
  assert.equal(code(store.replace('memory', 'old address', 'x')), 'no_match')
  assert.equal(code(store.remove('memory', 'old address')), 'no_match')
  assert.equal(code(store.remove('memory', 'likes tea')), 'ambiguous')
  assert.equal(code(store.replace('memory', 'likes tea', 'likes green tea')), 'ambiguous')
  // The right words in the wrong store are not a match either.
  assert.equal(code(store.remove('memory', 'called Kc')), 'no_match')
  assert.equal(raw.readFile(INDEX), before)
  assert.deepEqual(trashNames(raw), [])
  // The whole entry, exactly, is.
  assert.equal(code(store.remove('memory', 'my old address is 5 Main St')), 'ok')
  assert.equal(raw.readFile(`${MEM}/addr.md`), null)
})

test('remove takes the line first, then the file, and keeps both in the trash outside the memory folder', () => {
  const { fs, raw, log } = twoOfAKind()
  const original = raw.readFile(`${MEM}/name.md`)
  const answer = storeOver(fs).remove('user', 'called Kc') as any
  assert.deepEqual(texts(answer, 'user'), [])
  const indexRename = log.findIndex((l) => l.endsWith(`-> ${INDEX}`))
  const fileRemoval = log.indexOf(`rm ${MEM}/name.md`)
  assert.ok(indexRename >= 0 && fileRemoval > indexRename, log.join('\n'))
  const [record] = trashNames(raw)
  const saved = JSON.parse(raw.readFile(`${TRASH}/${record}`)!)
  assert.equal(saved.op, 'remove')
  assert.equal(saved.target, 'user')
  assert.equal(saved.text, 'called Kc')
  assert.equal(saved.fileName, 'name.md')
  assert.equal(saved.fileContent, original)
  assert.deepEqual(saved.lines, [{ text: '- [Name](name.md) - called Kc', position: 3 }])
  assert.equal(typeof saved.at, 'string')
  // Nothing new inside the memory folder: the trash would otherwise be read as memory.
  assert.deepEqual(filesUnder(raw, MEM), [INDEX, `${MEM}/addr.md`, `${MEM}/tea.md`, `${MEM}/tea2.md`])
})

test('an undo add brings the whole note back where it was', () => {
  const cliNote =
    '---\nname: home\ndescription: lives in Dubai\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 62a4\n  modified: 2026-09-20T08:00:00.000Z\n---\n\nLives in Dubai, near the marina.\n'
  const index = ['- [Tea](tea.md) - likes tea', `- [Home](home.md) ${EM} lives in Dubai`, '- [Name](name.md) - called Kc', ''].join('\n')
  const { fs, raw } = harness({
    [INDEX]: index,
    [`${MEM}/tea.md`]: note('tea', 'feedback', 'likes tea'),
    [`${MEM}/home.md`]: cliNote,
    [`${MEM}/name.md`]: note('name', 'user', 'called Kc'),
  })
  const store = storeOver(fs)
  assert.equal((store.remove('user', 'lives in Dubai') as any).ok, true)
  assert.equal(raw.readFile(`${MEM}/home.md`), null)
  const back = store.add('user', 'lives in Dubai') as any
  assert.deepEqual(texts(back, 'user'), ['lives in Dubai', 'called Kc'])
  assert.equal(raw.readFile(`${MEM}/home.md`), cliNote)
  assert.equal(raw.readFile(INDEX), index)
  assert.deepEqual(trashNames(raw), [], 'the record used by the restore is gone')
})

test('a note the agent removed itself comes back whole while it is remembered', () => {
  const cliNote = note('home', 'user', 'Lives in Dubai, near the marina.')
  const index = ['- [Tea](tea.md) - likes tea', `- [Home](home.md) ${EM} lives in Dubai`, '- [Name](name.md) - called Kc', ''].join('\n')
  const { fs, raw } = harness({
    [INDEX]: index,
    [`${MEM}/tea.md`]: note('tea', 'feedback', 'likes tea'),
    [`${MEM}/home.md`]: cliNote,
    [`${MEM}/name.md`]: note('name', 'user', 'called Kc'),
  })
  const store = storeOver(fs)
  store.list()
  // The model forgets it on its own, outside the store.
  raw.rm(`${MEM}/home.md`)
  raw.writeFile(INDEX, ['- [Tea](tea.md) - likes tea', '- [Name](name.md) - called Kc', ''].join('\n'))
  const back = store.add('user', 'lives in Dubai') as any
  assert.deepEqual(texts(back, 'user'), ['lives in Dubai', 'called Kc'])
  assert.equal(raw.readFile(`${MEM}/home.md`), cliNote)
  assert.equal(raw.readFile(INDEX), index)
})

test('replace changes the note and keeps its title and link', () => {
  const cliNote =
    '---\nname: home\ndescription: lives in Dubai\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 62a4\n  modified: 2026-09-20T08:00:00.000Z\n---\n\nLives in Dubai.\n'
  const { fs, raw } = harness({
    [INDEX]: `- [Tea](tea.md) - likes tea\n- [Home](home.md) ${EM} lives in Dubai\n`,
    [`${MEM}/tea.md`]: note('tea', 'feedback', 'likes tea'),
    [`${MEM}/home.md`]: cliNote,
  })
  const answer = storeOver(fs).replace('user', 'lives in Dubai', 'lives in Abu Dhabi') as any
  assert.deepEqual(texts(answer, 'user'), ['lives in Abu Dhabi'])
  assert.equal(raw.readFile(INDEX), '- [Tea](tea.md) - likes tea\n- [Home](home.md) - lives in Abu Dhabi\n')
  assert.equal(
    raw.readFile(`${MEM}/home.md`),
    '---\nname: home\ndescription: "lives in Abu Dhabi"\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 62a4\n  modified: 2026-09-25T10:00:00.000Z\n---\n\nlives in Abu Dhabi\n',
  )
  const [record] = trashNames(raw)
  const saved = JSON.parse(raw.readFile(`${TRASH}/${record}`)!)
  assert.equal(saved.op, 'replace')
  assert.equal(saved.text, 'lives in Dubai')
  assert.equal(saved.fileContent, cliNote)
  assert.deepEqual(saved.lines, [{ text: `- [Home](home.md) ${EM} lives in Dubai`, position: 1 }])
})

test('an undo correction brings the old note back', () => {
  const original = note('home', 'user', 'Lives in Dubai, near the marina, since 2019.')
  const { fs, raw } = harness({
    [INDEX]: '- [Home](home.md) - lives in Dubai\n',
    [`${MEM}/home.md`]: original,
  })
  const store = storeOver(fs)
  assert.equal((store.replace('user', 'lives in Dubai', 'lives in Abu Dhabi') as any).ok, true)
  assert.notEqual(raw.readFile(`${MEM}/home.md`), original)
  const back = store.replace('user', 'lives in Abu Dhabi', 'lives in Dubai') as any
  assert.deepEqual(texts(back, 'user'), ['lives in Dubai'])
  assert.equal(raw.readFile(`${MEM}/home.md`), original)
})

test('a correction to words another note still holds rewrites this note, never copies the other', () => {
  // Restoring a note whole is for words that are GONE (an Undo). Words another
  // note still holds are not an undo, so this note gets the new words, not a
  // copy of that other note's body.
  const coffee = note('coffee', 'feedback', 'Likes coffee, black, no sugar, before nine.')
  const { fs, raw } = harness({
    [INDEX]: '- [Tea](tea.md) - likes tea\n- [Coffee](coffee.md) - likes coffee\n',
    [`${MEM}/tea.md`]: note('tea', 'feedback', 'likes tea'),
    [`${MEM}/coffee.md`]: coffee,
  })
  const store = storeOver(fs)
  store.list()
  const answer = store.replace('memory', 'likes tea', 'likes coffee') as any
  assert.deepEqual(texts(answer, 'memory'), ['likes coffee', 'likes coffee'])
  assert.match(raw.readFile(`${MEM}/tea.md`)!, /\n\nlikes coffee\n$/)
  assert.equal(raw.readFile(`${MEM}/coffee.md`), coffee)
})

test('a correction that would overflow the index is refused', () => {
  const filler = `- [big](big.md) - ${'x'.repeat(24_900)}`
  const index = `${filler}\n- [s](s.md) - short\n`
  const { fs, raw } = harness({
    [INDEX]: index,
    [`${MEM}/big.md`]: note('big', 'feedback', 'big'),
    [`${MEM}/s.md`]: note('s', 'feedback', 'short'),
  })
  const answer = storeOver(fs).replace('memory', 'short', 'y '.repeat(140).trim()) as any
  assert.equal(answer.code, 'over_budget')
  assert.equal(raw.readFile(INDEX), index)
})

// ── Other writers ────────────────────────────────────────────────────────────

test('a change on disk during a write is not overwritten', () => {
  const other = (n: number) => `- [other${n}](other${n}.md) - another writer ${n}`
  const setup = (races: number) => {
    const { fs, raw } = harness({ [INDEX]: '- [a](a.md) - first\n', [`${MEM}/a.md`]: note('a', 'feedback', 'first') })
    let raced = 0
    // Another writer lands between our read and our rename, each time our new index is staged.
    const racing: TestFs = {
      ...fs,
      writeFile: (p, t, o) => {
        fs.writeFile(p, t, o)
        if (p.startsWith(`${MEM}/.`) && p.includes('MEMORY.md') && raced < races) {
          raced += 1
          raw.writeFile(`${MEM}/other${raced}.md`, note(`other${raced}`, 'feedback', `another writer ${raced}`))
          raw.writeFile(INDEX, raw.readFile(INDEX)! + other(raced) + '\n')
        }
      },
    }
    return { raw, store: storeOver(racing) }
  }
  // Twice in a row: the store gives up and says so, and keeps what the other writer wrote.
  const busy = setup(2)
  const answer = busy.store.add('memory', 'mine') as any
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'store_busy')
  assert.equal(busy.raw.readFile(INDEX), `- [a](a.md) - first\n${other(1)}\n${other(2)}\n`)
  assert.equal(busy.raw.readFile(`${MEM}/mine.md`), null, 'the note staged for the lost race is taken back')
  // Once: it starts over from a fresh read and both lines survive.
  const once = setup(1)
  const ok = once.store.add('memory', 'mine') as any
  assert.deepEqual(texts(ok, 'memory'), ['first', 'another writer 1', 'mine'])
})

test('the trash keeps the newest 50', () => {
  const initial: Record<string, string> = {}
  const lines: string[] = []
  for (let i = 0; i < 55; i += 1) {
    lines.push(`- [n${i}](n${i}.md) - fact ${i}`)
    initial[`${MEM}/n${i}.md`] = note(`n${i}`, 'feedback', `fact ${i}`)
  }
  initial[INDEX] = lines.join('\n') + '\n'
  const { fs, raw } = harness(initial)
  const store = storeOver(fs)
  for (let i = 0; i < 55; i += 1) assert.equal((store.remove('memory', `fact ${i}`) as any).ok, true)
  const kept = trashNames(raw)
  assert.equal(kept.length, 50)
  const facts = kept.map((n) => JSON.parse(raw.readFile(`${TRASH}/${n}`)!).text)
  for (let i = 0; i < 5; i += 1) assert.ok(!facts.includes(`fact ${i}`), `fact ${i} is one of the oldest`)
  for (let i = 5; i < 55; i += 1) assert.ok(facts.includes(`fact ${i}`), `fact ${i} is one of the newest`)
})

// ── The real disk ────────────────────────────────────────────────────────────

test('the node adapter reads a missing file as null and renames over an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bgos-memory-'))
  try {
    const target = join(dir, 'MEMORY.md')
    assert.equal(nodeMemoryFs.readFile(target), null)
    assert.equal(nodeMemoryFs.stat(target), null)
    writeFileSync(target, 'old\n')
    const tmp = join(dir, '.MEMORY.md.bgos-tmp')
    nodeMemoryFs.writeFile(tmp, 'new\n')
    nodeMemoryFs.rename(tmp, target)
    assert.equal(readFileSync(target, 'utf8'), 'new\n')
    assert.equal(existsSync(tmp), false)
    assert.equal(nodeMemoryFs.stat(dir)?.isDirectory, true)
    assert.deepEqual(nodeMemoryFs.listDir(dir), ['MEMORY.md'])
    assert.deepEqual(nodeMemoryFs.listDir(join(dir, 'absent')), [])
    nodeMemoryFs.mkdir(join(dir, 'trash', 'deep'))
    assert.equal(nodeMemoryFs.stat(join(dir, 'trash', 'deep'))?.isDirectory, true)
    nodeMemoryFs.rm(target)
    assert.equal(nodeMemoryFs.exists(target), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
