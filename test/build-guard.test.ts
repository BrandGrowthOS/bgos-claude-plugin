import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonicalHome, watcherHomeId, watcherServiceNames } from '../lib/watcher-service.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(repo, 'test', 'fixtures', 'build-guard')
const positive = fs.readFileSync(join(fixtureDir, 'positive.txt'), 'utf8').trimEnd().split(/\r?\n/)
const negative = fs.readFileSync(join(fixtureDir, 'near-miss.txt'), 'utf8').trimEnd().split(/\r?\n/)
const expected = JSON.parse(fs.readFileSync(join(fixtureDir, 'expected.json'), 'utf8'))
let guard: any
let loadFailure = ''
try {
  guard = await import('../scripts/build-guard.mjs')
} catch (error) {
  loadFailure = String(error)
}

function api() {
  assert.ok(guard, `build guard implementation must exist: ${loadFailure}`)
  assert.equal(typeof guard.scan, 'function', 'scan(root) is exported')
  assert.equal(typeof guard.scanContent, 'function', 'scanContent(file, text) is exported')
  assert.equal(typeof guard.scanPath, 'function', 'scanPath(file) is exported')
  return guard
}

function ownsRule(file: string, text: string, ruleId: string) {
  return api().scanContent(file, text).some((finding: any) => finding.ruleId === ruleId)
}

function fixtureTree() {
  const parent = resolve(tmpdir())
  const root = fs.mkdtempSync(join(parent, 'guard-'))
  const files: string[] = []
  const dirs: string[] = [root]
  const links: string[] = []
  function dir(name: string) {
    const target = join(root, name)
    fs.mkdirSync(target)
    dirs.push(target)
    return target
  }
  for (const name of ['bin', 'lib', 'hooks', 'native']) dir(name)
  return {
    root,
    file(name: string, data: string | Buffer) {
      const target = join(root, name)
      assert.ok(target.startsWith(root + sep))
      fs.writeFileSync(target, data)
      files.push(target)
      return target
    },
    link(name: string, destination: string) {
      const target = join(root, name)
      fs.symlinkSync(destination, target, 'junction')
      links.push(target)
      return target
    },
    cleanup() {
      for (const path of links.reverse()) fs.unlinkSync(path)
      for (const path of files.reverse()) fs.unlinkSync(path)
      for (const path of dirs.reverse()) fs.rmdirSync(path)
    },
  }
}

for (const row of expected.cases) {
  test(`every_rule_finds_positive_and_rejects_near_miss:${row.name}`, () => {
    api()
    const file = row.native ? 'native/case.rs' : 'lib/case.mjs'
    assert.equal(ownsRule(file, positive[row.line - 1], row.ruleId), true, `${row.ruleId} positive`)
    assert.equal(ownsRule(file, row.near ?? negative[row.line - 1], row.ruleId), false, `${row.ruleId} near miss`)
    const hit = api().scanContent(file, `safe\n${positive[row.line - 1]}\n`).find((finding: any) => finding.ruleId === row.ruleId)
    assert.equal(hit.file, file)
    assert.equal(hit.line, 2)
    assert.equal(typeof hit.matchedText, 'string')
    assert.ok(hit.matchedText.length > 0)
  })
}

for (const row of expected.extensions) {
  test(`extension_rules_are_path_only:${row.ruleId}`, () => {
    api()
    assert.ok(api().scanPath(row.path).some((finding: any) => finding.ruleId === row.ruleId))
    assert.equal(api().scanPath(row.near).length, 0)
    assert.equal(api().scanContent(row.near, 'safe').length, 0)
  })
}

test('fixture_inventory_is_complete', () => {
  api()
  assert.equal(positive.length, negative.length)
  assert.equal(expected.cases.length, positive.length)
  const expectedRules = ['SCRIPT_RUNNER', 'POLICY_BYPASS', 'ENCODED_COMMAND', 'SCHEDULED_TASK', 'POWERSHELL', 'WMI', 'COMMAND_PROMPT', 'HIDDEN_POWERSHELL', 'TEMP_LAUNCH', 'NEW_CONSOLE', 'DETACHED', 'SHOW_WINDOW', 'ALLOC_CONSOLE']
  assert.deepEqual([...new Set(expected.cases.map((row: any) => row.ruleId))].sort(), expectedRules.sort())
  for (const line of positive) {
    assert.equal(/https?:|[A-Za-z0-9+/]{80,}={0,2}/.test(line), false, 'no executable payload or URL in text fixture')
  }
})

test('short_switches_require_shell_and_obey_token_boundaries', () => {
  api()
  for (const [full, minimum, value, rule] of [['executionpolicy', 2, 'Bypass', 'POLICY_BYPASS'], ['encodedcommand', 1, 'PLACEHOLDER', 'ENCODED_COMMAND'], ['windowstyle', 1, 'Hidden', 'HIDDEN_POWERSHELL']]) {
    for (let length = Number(minimum); length <= String(full).length; length++) {
      const prefix = String(full).slice(0, length)
      const context = length <= 2 ? 'powershell ' : ''
      assert.equal(ownsRule('lib/x.mjs', `${context}-${prefix} ${value}`, String(rule)), true, `${prefix} prefix`)
      assert.equal(ownsRule('lib/x.mjs', `${context}/${prefix.toUpperCase()} ${value}`, String(rule)), true, `${prefix} slash and case`)
      assert.equal(ownsRule('lib/x.mjs', `${context}-${prefix}x ${value}`, String(rule)), false, `${prefix} trailing character`)
      if (length <= 2) assert.equal(ownsRule('lib/x.mjs', `-${prefix} ${value}`, String(rule)), false, `${prefix} needs shell context`)
    }
  }
  for (let length = 1; length <= 'hidden'.length; length++) {
    assert.equal(ownsRule('lib/x.mjs', `-WindowStyle ${'hidden'.slice(0, length)}`, 'HIDDEN_POWERSHELL'), true)
  }
  for (const [switchText, value, rule] of [['ep', 'Bypass', 'POLICY_BYPASS'], ['ex', 'Bypass', 'POLICY_BYPASS'], ['e', 'PLACEHOLDER', 'ENCODED_COMMAND'], ['en', 'PLACEHOLDER', 'ENCODED_COMMAND'], ['w', 'Hidden', 'HIDDEN_POWERSHELL'], ['wi', '1', 'HIDDEN_POWERSHELL']]) {
    assert.equal(ownsRule('lib/x.mjs', `pwsh /${switchText} ${value}`, rule), true)
    assert.equal(ownsRule('lib/x.mjs', `/${switchText} ${value}`, rule), false)
    assert.equal(ownsRule('lib/x.mjs', `pwsh x-${switchText} ${value}`, rule), false)
    assert.equal(ownsRule('lib/x.mjs', `pwsh /${switchText}x ${value}`, rule), false)
  }
  for (const before of ['', ' ', '"', "'", ',', '(', '[']) {
    assert.equal(ownsRule('lib/x.mjs', `${before}-EncodedCommand PLACEHOLDER`, 'ENCODED_COMMAND'), true)
  }
  assert.equal(ownsRule('lib/x.mjs', 'x-EncodedCommand PLACEHOLDER', 'ENCODED_COMMAND'), false)
  assert.equal(ownsRule('lib/x.mjs', '-EncodedCommandX PLACEHOLDER', 'ENCODED_COMMAND'), false)
  assert.equal(ownsRule('lib/x.mjs', '(-EXECUTIONPOLICY:Bypass,', 'POLICY_BYPASS'), true)
})

test('temporary_launch_requires_same_or_next_line', () => {
  api()
  const temps = ['%TEMP%', '%TMP%', '$env:TEMP', '$env:TMP', 'process.env.TEMP', 'process.env.TMP', 'os.tmpdir()', 'temp_dir()', 'GetTempPathW', 'GetTempPath2W', 'C:\\Windows\\Temp\\tool.exe']
  for (const temp of temps) {
    assert.equal(ownsRule('lib/x.mjs', `spawn(${temp})`, 'TEMP_LAUNCH'), true, temp)
    assert.equal(ownsRule('lib/x.mjs', `spawn(\n${temp})`, 'TEMP_LAUNCH'), true, temp)
    assert.equal(ownsRule('lib/x.mjs', `spawn(\nother\n${temp})`, 'TEMP_LAUNCH'), false, temp)
    assert.equal(ownsRule('lib/x.mjs', `writeFile(${temp}, data)`, 'TEMP_LAUNCH'), false, temp)
  }
})

test('strict_is_containment_scoped_without_exemptions', () => {
  api()
  const tree = fixtureTree()
  try {
    tree.file('native/unsafe.rs', 'powershell\n')
    tree.file('lib/legacy.mjs', 'pwsh\n')
    tree.file('native-clean.rs', 'safe\n')
    const result = api().scan(tree.root, { strict: 'native' })
    assert.equal(result.exitCode, 1)
    assert.equal(result.findings.filter((item: any) => item.ruleId === 'POWERSHELL').length, 2)
    assert.equal(api().scan(tree.root, { strict: 'hooks' }).exitCode, 0)
    for (const marker of ['guard-ignore', 'guard-disable', 'allow: POWERSHELL']) {
      assert.equal(ownsRule('native/x.rs', `// ${marker}\npowershell`, 'POWERSHELL'), true)
    }
  } finally {
    tree.cleanup()
  }
})

test('native_flags_are_rejected_only_under_native', () => {
  api()
  for (const [text, rule] of [['CREATE_NEW_CONSOLE', 'NEW_CONSOLE'], ['DETACHED_PROCESS', 'DETACHED'], ['ShowWindow', 'SHOW_WINDOW'], ['ShowWindowAsync', 'SHOW_WINDOW'], ['AllocConsole', 'ALLOC_CONSOLE']]) {
    assert.equal(ownsRule('native/unit.rs', text, rule), true)
    assert.equal(ownsRule('lib/unit.mjs', text, rule), false)
    assert.equal(ownsRule('native-ish/unit.rs', text, rule), false)
    assert.equal(ownsRule('native/unit.rs', `prefix${text}`, rule), false)
    assert.equal(ownsRule('native/unit.rs', `${text}Suffix`, rule), false)
  }
})

test('missing_roots_are_reported_and_missing_strict_root_fails', () => {
  api()
  const tree = fixtureTree()
  try {
    fs.rmdirSync(join(tree.root, 'native'))
    const result = api().scan(tree.root)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.findings.filter((item: any) => item.ruleId === 'GUARD_ROOT_MISSING').map((item: any) => item.file), ['native'])
    assert.equal(api().scan(tree.root, { strict: 'native' }).exitCode, 1)
    fs.mkdirSync(join(tree.root, 'native'))
  } finally {
    if (!fs.existsSync(join(tree.root, 'native'))) fs.mkdirSync(join(tree.root, 'native'))
    tree.cleanup()
  }
})

test('directory_links_are_reported_without_traversal', () => {
  api()
  const tree = fixtureTree()
  try {
    tree.file('native/unsafe.rs', 'powershell')
    tree.link('lib/linked', join(tree.root, 'native'))
    const result = api().scan(tree.root)
    assert.equal(result.findings.filter((item: any) => item.ruleId === 'GUARD_LINK_SKIPPED').length, 1)
    assert.equal(result.findings.filter((item: any) => item.ruleId === 'POWERSHELL').length, 1)
    assert.equal(result.findings.some((item: any) => item.file.startsWith('lib/linked/')), false)
  } finally {
    tree.cleanup()
  }
})

test('unreadable_native_file_reports_io_and_fails_strict', () => {
  api()
  const tree = fixtureTree()
  const path = tree.file('native/blocked.rs', 'safe')
  const original = fs.readFileSync
  try {
    fs.readFileSync = function (name: any, ...args: any[]) {
      if (resolve(String(name)) === path) {
        const error = new Error('fixture read refused')
        Object.assign(error, { code: 'EACCES' })
        throw error
      }
      return (original as any)(name, ...args)
    } as any
    const result = api().scan(tree.root, { strict: 'native' })
    assert.equal(result.exitCode, 1)
    assert.equal(result.findings.filter((item: any) => item.ruleId === 'GUARD_IO').length, 1)
  } finally {
    fs.readFileSync = original
    tree.cleanup()
  }
})

test('binary_probe_is_limited_to_first_eight_kibibytes', () => {
  api()
  const tree = fixtureTree()
  try {
    tree.file('native/binary.rs', Buffer.from('powershell\u0000safe'))
    tree.file('lib/late.mjs', Buffer.concat([Buffer.alloc(8192, 32), Buffer.from('powershell\u0000')]))
    const result = api().scan(tree.root, { strict: 'native' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.findings.some((item: any) => item.file === 'native/binary.rs'), false)
    assert.equal(result.findings.some((item: any) => item.file === 'lib/late.mjs' && item.ruleId === 'POWERSHELL'), true)
  } finally {
    tree.cleanup()
  }
})

test('report_default_and_json_agree', () => {
  api()
  const tree = fixtureTree()
  try {
    tree.file('lib/legacy.mjs', 'safe\npowershell\npwsh\n')
    const output = tree.file('report.json', '')
    const child = spawnSync(process.execPath, [join(repo, 'scripts', 'build-guard.mjs'), '--json', output], { cwd: tree.root, encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(child.status, 0, child.stderr)
    const json = JSON.parse(fs.readFileSync(output, 'utf8'))
    const direct = api().scan(tree.root)
    assert.deepEqual(json.findings, direct.findings)
    assert.deepEqual(json.counts, direct.counts)
    assert.match(child.stdout, /lib\/legacy\.mjs:2 POWERSHELL powershell/)
    assert.match(child.stdout, /lib\/legacy\.mjs:3 POWERSHELL pwsh/)
    assert.match(child.stdout, /POWERSHELL: 2/)
    const strict = spawnSync(process.execPath, [join(repo, 'scripts', 'build-guard.mjs'), '--strict', 'lib'], { cwd: tree.root, encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(strict.status, 1, strict.stderr)
  } finally {
    tree.cleanup()
  }
})

test('split_switch_value_reads_the_next_line', () => {
  const rulesFor = (source: string) => api().scanContent('lib/source.mjs', source).map((item: any) => `${item.line}:${item.ruleId}`)
  // The real form: bin/hoai-core.mjs builds its argument list with one token on each line.
  assert.deepEqual(rulesFor("'-ExecutionPolicy',\n    'Bypass',"), ['1:POLICY_BYPASS'])
  assert.deepEqual(rulesFor('"-ExecutionPolicy",\r\n    "Bypass",'), ['1:POLICY_BYPASS'])
  assert.deepEqual(rulesFor("'-WindowStyle',\n    'Hidden',"), ['1:HIDDEN_POWERSHELL'])
  // The value is the first token of the very next line, and only when the switch's own line has none.
  assert.deepEqual(rulesFor("'-ExecutionPolicy',\n    'RemoteSigned',"), [])
  assert.deepEqual(rulesFor("'-ExecutionPolicy',\n\n    'Bypass',"), [])
  assert.deepEqual(rulesFor("'-ExecutionPolicy',\n    '-NoProfile',\n    'Bypass',"), [])
  assert.deepEqual(rulesFor("'-ExecutionPolicy', 'RemoteSigned',\n    'Bypass',"), [])
  // Q11: forms of 1 or 2 letters count only on a line that also names the shell.
  assert.deepEqual(rulesFor("'-ep',\n    'Bypass',"), [])
})

test('guard_runs_when_started_through_a_linked_folder', () => {
  api()
  const tree = fixtureTree()
  try {
    tree.file('lib/legacy.mjs', 'powershell\n')
    tree.file('hooks/build-guard.mjs', fs.readFileSync(join(repo, 'scripts', 'build-guard.mjs')))
    tree.link('linked', join(tree.root, 'hooks'))
    const output = tree.file('report.json', '')
    const child = spawnSync(process.execPath, [join(tree.root, 'linked', 'build-guard.mjs'), '--json', output], { cwd: tree.root, encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /lib\/legacy\.mjs:1 POWERSHELL powershell/)
  } finally {
    tree.cleanup()
  }
})

test('home_names_match_node_on_three_homes', () => {
  api()
  const source = JSON.parse(fs.readFileSync(join(repo, 'native', 'crates', 'hoai-common', 'tests', 'fixtures', 'home-vectors.json'), 'utf8'))
  const vectors = Array.isArray(source) ? source : source.vectors
  assert.ok(vectors.length >= 3)
  for (const vector of vectors) {
    assert.equal(canonicalHome(vector.home, 'win32'), vector.canonical)
    assert.equal(watcherHomeId(vector.home, 'win32'), vector.id)
    assert.equal(watcherServiceNames(vector.namespace, vector.id).taskName.replace(/^HOAI Watcher/, 'HOAI Helper'), vector.runValueName)
  }
})

test('source_shape_regressions_follow_the_specification', () => {
  const actual: Record<string, unknown> = {}
  for (const [source, ruleId] of [
    ["-ExecutionPolicy:'ByPass'", 'POLICY_BYPASS'],
    ['-WindowStyle\tHidden', 'HIDDEN_POWERSHELL'],
  ]) {
    const findings = api().scanContent('lib/source.mjs', source)
    actual[ruleId] = findings.find((item: any) => item.ruleId === ruleId)?.matchedText
  }
  actual.previousLineIsNotAdjacent = ownsRule('lib/source.mjs', "os.tmpdir()\nspawn('safe')", 'TEMP_LAUNCH')
  actual.quotedCmdArguments = ownsRule('lib/source.mjs', 'shell.Run "tool.cmd --arg"', 'COMMAND_PROMPT')
  actual.quotedBatArguments = ownsRule('lib/source.mjs', 'exec("tool.bat --arg", { shell: true })', 'COMMAND_PROMPT')
  actual.quotedBatWithoutShell = ownsRule('lib/source.mjs', 'exec("tool.bat --arg", { shell: false })', 'COMMAND_PROMPT')
  actual.escapedTempSource = ownsRule('lib/source.mjs', String.raw`spawn("C:\\Windows\\Temp\\tool.exe")`, 'TEMP_LAUNCH')
  actual.escapedTempData = ownsRule('lib/source.mjs', String.raw`writeFile("C:\\Windows\\Temp\\data.json", data)`, 'TEMP_LAUNCH')
  const tree = fixtureTree()
  const originalStat = fs.lstatSync
  try {
    tree.link('native/link', tree.root)
    actual.strictTraversalAttempted = false
    ;(fs as any).lstatSync = function (target: any, ...args: any[]) {
      if (resolve(String(target)).startsWith(join(tree.root, 'native', 'link') + sep)) actual.strictTraversalAttempted = true
      return (originalStat as any)(target, ...args)
    } as any
    const report = api().scan(tree.root, { strict: 'native/link/hooks' })
    actual.strictLinkedDescendant = report.exitCode
  } finally {
    ;(fs as any).lstatSync = originalStat
    tree.cleanup()
  }
  assert.deepEqual(actual, {
    POLICY_BYPASS: "-ExecutionPolicy:'ByPass'",
    HIDDEN_POWERSHELL: '-WindowStyle\tHidden',
    previousLineIsNotAdjacent: false,
    quotedCmdArguments: true,
    quotedBatArguments: true,
    quotedBatWithoutShell: false,
    escapedTempSource: true,
    escapedTempData: false,
    strictTraversalAttempted: false,
    strictLinkedDescendant: 1,
  })
})

test('final_native_tree_is_strict_clean', () => {
  const report = api().scan(repo, { strict: 'native' })
  const nativeFindings = report.findings.filter((item: any) => /^native(?:\/|$)/i.test(item.file))
  assert.deepEqual(nativeFindings, [], 'the real native tree has no findings')
  assert.equal(report.exitCode, 0, 'the real native tree passes strict mode')
})
