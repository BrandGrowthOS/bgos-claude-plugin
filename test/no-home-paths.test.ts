/**
 * No tracked file names one of our own machines' home folders (board row a633fb9c).
 *
 * The plugin repository is public. At 0.87.4, 173 tracked files outside test/
 * (845 lines; a plain slash-only search found 160 of them) named the home
 * folders of the machines it is built on: lane reports at the root, evidence
 * logs, code comments, two pinned fixture copies, and one proof script that
 * used one as a real default. scripts/check-home-paths.mjs is the check; this file runs
 * it in the suite, so tests.yml fails the PR that brings one back.
 *
 *  - the real check, on this checkout's tracked files.
 *  - a positive control: a throwaway repository with one planted path in each
 *    form the check covers, which it must find, next to near misses and exempt
 *    files, which it must not. A check that finds nothing is only worth
 *    something if it can find something.
 *
 * If git cannot see a repository (an unpacked archive), the first case skips
 * with a reason, except under CI, where a missing .git would make it prove
 * nothing.
 *
 * Run: npm test, or npx tsx --test test/no-home-paths.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHomePaths, trackedFiles, EXEMPT } from '../scripts/check-home-paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Spelled in parts, so this file is no hit for a search with no exemptions either.
const mac = (name: string) => ['', 'Users', name].join('/')
const win = (name: string) => ['C:', 'Users', name].join('\\')

type Hit = { file: string; line: number; text: string }

test('no tracked file outside the test fixtures names one of our home folders', (t) => {
  let files: string[]
  try {
    files = trackedFiles(ROOT)
  } catch (error) {
    if (process.env.CI) throw error
    return t.skip(String((error as Error).message))
  }
  assert.ok(files.length > 300, `the listing must cover the repo, got ${files.length} files`)
  const hits: Hit[] = findHomePaths(ROOT)
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`),
    [],
    'a public repository must not name our machines\' home folders: use /Users/you, /home/you or C:\\Users\\you',
  )
})

test('the check finds a planted home folder in every form it covers, and nothing else', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hoai-home-paths-'))
  try {
    const plant = (path: string, text: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    // Each form, one per file, on line 2 so the line number is checked too.
    const planted: Record<string, string> = {
      'docs/mac.md': `${mac('kc')}/hoai-work/lane`,
      'docs/mac-other.md': `cd ${mac('fitecho')}`,
      'docs/mac-third.md': `${mac('bgos')}/.bgos-agent`,
      'docs/mac-fourth.md': `${mac('leonidus')}`,
      'docs/mac-fifth.md': `HOME=${mac('karim')}.`,
      'docs/case.md': `${['', 'USERS', 'Kc'].join('/')}/x`,
      'bin/windows.mjs': `// ${win('karim')}\\AppData`,
      'bin/windows-json.json': `{"cwd":"${win('kc').replace(/\\/g, '\\\\')}"}`,
      'scripts/linux.py': `seccomp='${['', 'home', 'karim'].join('/')}/profile.json'`,
      'scripts/linux-root.sh': `cd ${['', 'mnt', 'data', 'home'].join('/')}/agent`,
      'REPORT.md': `ran in ${mac('kc')}`,
      // Encoded forms. Claude Code names a project folder by its cwd with every slash a dash.
      'docs/projects-dir.md': `~/.claude/projects/${['', 'Users', 'fitecho', 'BGOS'].join('-')}/`,
      'docs/projects-dir-linux.md': `~/.claude/projects/${['', 'home', 'karim', 'lane'].join('-')}/x.jsonl`,
      'docs/projects-dir-home.md': `cd ~/.claude/projects/${['', 'Users', 'kc'].join('-')}`,
      // A URL query or a file:// link percent encodes the slashes, in either case.
      'docs/url.md': `?cwd=${['', 'Users', 'kc', 'x'].join('%2F')}&y=1`,
      'docs/url-lower.md': `?path=${['', 'home', 'karim'].join('%2f')}`,
      // Not exempt: a fixture outside test/, such as the hard floor fixture copies in lib/.
      'lib/hard-floor-fixture.ts': `input: { kind: "path", path: "${mac('kc')}/.zshrc" },`,
    }
    for (const [path, text] of Object.entries(planted)) plant(path, `first line\n${text}\nlast line\n`)
    // Near misses and placeholders: none of these is one of our folders.
    plant('docs/near.md', [
      mac('you'), mac('kcx'), mac('karima'), win('you'), ['', 'home', 'you'].join('/'), ['', 'mnt', 'data', 'homes'].join('/'), 'Users kc',
      ['', 'Users', 'you', 'BGOS'].join('-'), ['', 'Users', 'kcx', 'BGOS'].join('-'), 'a self-home-kcal word', ['', 'Users', 'you'].join('%2F'), ['', 'home', 'karima'].join('%2F'),
    ].join('\n'))
    // Exempt: the tests and their fixtures, and nothing else.
    plant('test/fixture.test.ts', mac('kc'))
    plant('test/fixtures/cases.json', mac('kc'))
    // A binary file is read too.
    plant('docs/evidence/run.log', `\u0000\u001b[31m${mac('kc')}\u001b[0m`)
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const add = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' })
    assert.equal(add.status, 0, add.stderr)
    // Not tracked, so not this check's to judge: a lane's own BRIEF in its folder.
    plant('BRIEF.md', mac('kc'))

    const hits: Hit[] = findHomePaths(repo)
    const found = hits.map((hit) => `${hit.file}:${hit.line}`).sort()
    const want = [...Object.keys(planted).map((path) => `${path}:2`), 'docs/evidence/run.log:1'].sort()
    assert.deepEqual(found, want)
    for (const hit of hits) assert.ok(hit.text.length > 0, `${hit.file} reports the text it found`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('every exemption says why', () => {
  for (const rule of EXEMPT as { prefix?: string; path?: string; why: string }[]) {
    assert.ok((rule.prefix ?? rule.path) && rule.why.length > 40, `${rule.prefix ?? rule.path} needs a reason`)
  }
})
