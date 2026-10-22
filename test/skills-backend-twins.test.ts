/**
 * The plugin's twins of two backend rules a skill row round trips through
 * (skills view review, findings 10, 11 and 13):
 *
 *   backendFoldedPath  is backend/src/skills/skills-installed-items.ts
 *                      redactHomePath: the backend folds ANY user's home
 *                      prefix to `~` before the app sees a path, and the app
 *                      sends that form back to read, write and Remove.
 *   frontmatterNameOf  is backend/src/skills/skill-content.ts
 *                      frontmatterNameOf: the `name:` a save is held to
 *                      (name_changed), so Edit is never offered for a file
 *                      the backend would refuse to save.
 *   SKILL_DISPLAY_PATH_PATTERN  is the regex of the same name in
 *                      backend/src/dto/skills-store.dto.ts, copied byte for
 *                      byte: the path the app sends back to read, write or
 *                      Remove a row. The list skips an entry whose path fails
 *                      it (entryPathRefused), so no row is shown that the
 *                      backend would refuse to act on.
 *
 * Each runs over a case table the backend spec carries too
 * (skills-installed-items.spec.ts and skill-content.spec.ts), so a rule
 * changed on one side only turns that side red. displayPath, the plugin's
 * own fold, is pinned here on Windows strings: a drive letter or user folder
 * in another case is still the home.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { join } from 'node:path'

import { SKILL_DISPLAY_PATH_PATTERN, backendFoldedPath, displayPath, entryPathRefused } from '../lib/skills-inventory.ts'
import { frontmatterNameOf } from '../lib/skills-edit.ts'

/** Shared with backend/src/skills/skills-installed-items.spec.ts (redactHomePath). */
export const HOME_FOLD_CASES: ReadonlyArray<readonly [string, string]> = [
  ['/Users/kc/x/y', '~/x/y'],
  ['/Users/kc', '~'],
  ['/home/ubuntu/agents/a', '~/agents/a'],
  ['/root/.claude/skills', '~/.claude/skills'],
  ['C:\\Users\\Kc\\agents\\a', '~\\agents\\a'],
  ['c:/Users/kc/agents', '~/agents'],
  ['c:\\users\\kc\\agents', '~\\agents'],
  ['\\\\?\\C:\\Users\\kc\\agents', '~\\agents'],
  ['/var/home/kc/agents', '~/agents'],
  ['//Users/kc/agents', '~/agents'],
  ['~/already', '~/already'],
  ['/Library/Application Support/ClaudeCode/.claude/skills', '/Library/Application Support/ClaudeCode/.claude/skills'],
  ['/etc/codex/skills', '/etc/codex/skills'],
  // an agent folder outside the daemon's own home: another user's, or a shared one
  ['/Users/Shared/proj/.claude/skills/x', '~/proj/.claude/skills/x'],
  // a daemon run as root, its project in another user's home
  ['/home/ubuntu/proj/.claude/skills/x', '~/proj/.claude/skills/x'],
  ['/root', '~'],
  ['/rootfs/x', '/rootfs/x'],
  ['/homes/x', '/homes/x'],
  ['/Users', '/Users'],
  ['C:\\Users', 'C:\\Users'],
  ['D:\\Work\\proj', 'D:\\Work\\proj'],
  ['c:\\Users\\karim\\proj\\.claude\\skills\\x', '~\\proj\\.claude\\skills\\x'],
]

/** Shared with backend/src/skills/skill-content.spec.ts (frontmatterNameOf). undefined: no name. */
export const FRONTMATTER_NAME_CASES: ReadonlyArray<readonly [string, string | undefined]> = [
  ['---\nname: foo\n---\n', 'foo'],
  ['---\nName: Other\n---\n', 'Other'],
  ['---\nNAME: x\n---\n', 'x'],
  ['---\nna_me: x\n---\n', 'x'],
  ['---\nna-me: x\n---\n', 'x'],
  ['---\nname : spaced\n---\n', 'spaced'],
  ['---\nname: "quoted"\n---\n', 'quoted'],
  ["---\nname: 'single'  # a comment\n---\n", 'single'],
  ['---\nname: foo # a comment\n---\n', 'foo'],
  ['---\nname: foo#not-a-comment\n---\n', 'foo#not-a-comment'],
  ['---\nname: "open\n---\n', ''],
  ['---\nname:\n  folded\n---\n', ''],
  ['---\nname: >\n  folded\n---\n', ''],
  ['---\nname:\n---\n', ''],
  // a closing --- on the last line, no newline after it
  ['---\nname: other\ndescription: d\n---', 'other'],
  ['\uFEFF---\nname: bom\n---\n', 'bom'],
  ['---\r\nname: crlf\r\n---\r\n', 'crlf'],
  ['---\nname: first\nname: second\n---\n', 'first'],
  ['---\ndescription: d\n---\n', undefined],
  ['---\ndescription: d\n---\nname: in-the-body\n', undefined],
  ['no frontmatter\nname: x\n', undefined],
  ['', undefined],
]

/**
 * For backend/src/dto/skills-store.dto.ts SKILL_DISPLAY_PATH_PATTERN: true when
 * the backend takes the path back. The backend regex passes this table too
 * (run against the literal read from that file when the twin was copied).
 */
export const DISPLAY_PATH_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ['~/.claude-work/skills/tidy', true],
  ['~/.claude-work/skills/v1.2', true],
  ['~/.claude-work/skills/tidy.', false],
  ['~/.claude-work/skills/notes ', false],
  ['~/.claude-work/skills/tidy./SKILL.md', false],
  ['~/.claude-work/skills/notes \\x', false],
  ['~/a/../b', false],
  ['~/a/.../b', false],
  ['~\\a\\..', false],
  ['~/.claude', true],
  ['~', true],
  ['.', false],
  ['C:x', false],
  ['c:skills', false],
  ['C:\\Users\\k\\x', true],
  ['C:/x', true],
  ['D:\\Work\\proj', true],
  ['/etc/claude-code/.claude/skills/x', true],
  ['~/a\u0000b', false],
  ['~/a\tb', false],
  ['~/a\u001fb', false],
  ['~/a\u007fb', false],
  // C1 and bidi marks are the app's to sanitize in a path, not the backend's to refuse
  ['~/a\u0085b', true],
  ['~/a\u200fb', true],
  ['', false],
  ['x'.repeat(1024), true],
  ['x'.repeat(1025), false],
]

for (const [input, taken] of DISPLAY_PATH_CASES) {
  test(`SKILL_DISPLAY_PATH_PATTERN ${taken ? 'takes' : 'refuses'} ${JSON.stringify(input.length > 40 ? `${input.slice(0, 8)}... (${input.length})` : input)}`, () => {
    assert.equal(SKILL_DISPLAY_PATH_PATTERN.test(input), taken)
  })
}

test('entryPathRefused decides on the path the app sends back: the fold the backend shows, the length it keeps', () => {
  const win = process.platform === 'win32'
  const home = win ? 'C:\\Users\\k' : '/home/k'
  const skills = join(home, '.claude-work', 'skills')
  for (const [entry, refused] of [
    ['tidy', false],
    ['v1.2', false],
    ['tidy.', true],
    ['notes ', true],
    ['a\u007f', true],
    ['a\tb', true],
    ['a\u200fb', false],
  ] as const) {
    assert.equal(entryPathRefused(skills, entry, home), refused, JSON.stringify(entry))
  }
  // another user's home folds to ~ before the app sees it, so its own segments never count
  assert.equal(entryPathRefused(join(win ? 'C:\\Users\\odd.' : '/home/odd.', 'skills'), 'x', home), false)
  assert.equal(entryPathRefused(join(win ? 'C:\\srv\\odd.' : '/srv/odd.', 'skills'), 'x', home), true)
  // the backend drops a path past 1024 characters as the daemon sent it, before any fold
  const deep = join(win ? 'C:\\srv' : '/srv', 'd'.repeat(1000))
  const fits = 'x'.repeat(1024 - deep.length - 1)
  assert.equal(join(deep, fits).length, 1024)
  assert.equal(entryPathRefused(deep, fits, home), false)
  assert.equal(entryPathRefused(deep, fits + 'x', home), true)
  const deepHome = join(home, 'd'.repeat(1000))
  const homeFits = 'x'.repeat(1024 - deepHome.length - 1)
  assert.equal(entryPathRefused(deepHome, homeFits, home), false, 'shown under ~, shorter than 1024')
  assert.equal(entryPathRefused(deepHome, homeFits + 'x'.repeat(home.length - 1), home), false, 'the ~ form still fits')
})

for (const [input, output] of HOME_FOLD_CASES) {
  test(`backendFoldedPath ${JSON.stringify(input)} shows as ${JSON.stringify(output)}`, () => {
    assert.equal(backendFoldedPath(input), output)
  })
}

for (const [input, output] of FRONTMATTER_NAME_CASES) {
  test(`frontmatterNameOf ${JSON.stringify(input)} reads ${JSON.stringify(output)}`, () => {
    assert.equal(frontmatterNameOf(input), output)
  })
}

test('displayPath folds a Windows home in any case, keeping the rest as written', () => {
  const home = 'C:\\Users\\karim'
  const cases: Array<[string, string]> = [
    ['C:\\Users\\karim', '~'],
    ['c:\\Users\\karim', '~'],
    ['C:\\Users\\karim\\proj\\.claude\\skills\\x', '~/proj/.claude/skills/x'],
    ['c:\\Users\\karim\\proj\\.claude\\skills\\x', '~/proj/.claude/skills/x'],
    ['c:\\users\\KARIM\\Proj\\.claude\\skills\\X', '~/Proj/.claude/skills/X'],
    ['C:\\Users\\karimx\\proj', 'C:\\Users\\karimx\\proj'],
    ['D:\\proj', 'D:\\proj'],
  ]
  for (const [path, shown] of cases) assert.equal(displayPath(path, home, '\\'), shown, path)
})

test('displayPath on a POSIX home stays case sensitive', () => {
  assert.equal(displayPath('/Users/karim/x', '/Users/karim', '/'), '~/x')
  assert.equal(displayPath('/Users/karim', '/Users/karim', '/'), '~')
  assert.equal(displayPath('/users/karim/x', '/Users/karim', '/'), '/users/karim/x')
  assert.equal(displayPath('/Users/karimx/x', '/Users/karim', '/'), '/Users/karimx/x')
})
