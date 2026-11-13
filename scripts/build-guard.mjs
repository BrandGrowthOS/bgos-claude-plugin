#!/usr/bin/env node
/**
 * Report Windows startup risks in the four product source roots. This is a
 * text scanner, not a shell parser or an execution policy. It never executes
 * inspected text and has no exclusions or suppression comments.
 *
 * TEMP_LAUNCH is deliberately a documented heuristic: a launch operation and
 * a known temporary path expression must occur on the same or next line.
 * Computed paths that conceal their origin cannot be recognized statically.
 */
import fs from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOTS = Object.freeze(['bin', 'lib', 'hooks', 'native'])
export const RULE_IDS = Object.freeze([
  'SCRIPT_RUNNER',
  'POLICY_BYPASS',
  'ENCODED_COMMAND',
  'SCHEDULED_TASK',
  'POWERSHELL',
  'WMI',
  'COMMAND_PROMPT',
  'HIDDEN_POWERSHELL',
  'TEMP_LAUNCH',
  'NEW_CONSOLE',
  'DETACHED',
  'SHOW_WINDOW',
  'ALLOC_CONSOLE',
  'GUARD_ROOT_MISSING',
  'GUARD_LINK_SKIPPED',
  'GUARD_IO',
])

const textRules = [
  ['SCRIPT_RUNNER', /\b(?:WScript\.Shell|wscript(?:\.exe)?|cscript(?:\.exe)?)\b/gi],
  ['SCHEDULED_TASK', /\b(?:schtasks(?:\.exe)?|Register-ScheduledTask|New-ScheduledTask|Schedule\.Service)\b/gi],
  ['POWERSHELL', /\b(?:powershell|pwsh)(?:\.exe)?\b/gi],
  ['WMI', /\b(?:Get-CimInstance|Get-WmiObject|Win32_Process|wmic(?:\.exe)?)\b/gi],
  ['COMMAND_PROMPT', /\bcmd\.exe\b|\bcmd\s+\/c\b|\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|Command::new)\s*\(\s*["'`]cmd["'`]|\bcomspec\b[^\r\n]*["'`]\/c["'`]|\bspawn(?:Sync)?\s*\(\s*["'`][^"'`\r\n]*\.(?:cmd|bat)(?=[\s"'`])(?![^\r\n]*\bshell\s*:\s*false\b)/gi],
]
const nativeRules = [
  ['NEW_CONSOLE', /\bCREATE_NEW_CONSOLE\b/g],
  ['DETACHED', /\bDETACHED_PROCESS\b/g],
  ['SHOW_WINDOW', /\bShowWindow(?:Async)?\b/g],
  ['ALLOC_CONSOLE', /\bAllocConsole\b/g],
]
const shellOnLine = /\b(?:powershell|pwsh)(?:\.exe)?\b/i
const shellInvocation = /\bshell\s*\.\s*Run\b|\bshell\s*[:=]\s*true\b|\bexec(?:Sync)?\s*\((?![^\r\n]*\bshell\s*:\s*false\b)/i
const scriptCommand = /["'][^"'\r\n]*?\.(?:cmd|bat)(?=[\s"'])[^"'\r\n]*["']/gi
const launchOperation = /\b(?:spawn(?:Sync)?|exec(?:File(?:Sync)?|Sync)?|run|execute|start(?:Process)?|CreateProcessW|Start-Process|Command::new)\s*\(|\bStart-Process\b|\.Run\b|(?:^|\s)&\s+\S/i
const temporaryPath = /%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP)\b|\bprocess\.env\.(?:TEMP|TMP)\b|\bprocess\.env\[\s*["'`](?:TEMP|TMP)["'`]\s*\]|\bos\.tmpdir\s*\(\s*\)|\btmpdir\s*\(\s*\)|\btemp_dir\s*\(\s*\)|\bGetTempPath(?:2)?W\b|\b[A-Z]:[\\/]+Windows[\\/]+Temp(?:[\\/]+|\b)/i

const slashPath = (value) => String(value).replace(/\\/g, '/')
const isNative = (file) => /^native(?:\/|$)/i.test(slashPath(file))
const finding = (file, line, ruleId, matchedText) => ({ file: slashPath(file), line, ruleId, matchedText })

/** Extension checks are independent of file contents, including binary data. */
export function scanPath(file) {
  const path = slashPath(file)
  if (/\.vbs$/i.test(path)) return [finding(path, 1, 'SCRIPT_RUNNER', basename(path))]
  if (/\.ps1$/i.test(path)) return [finding(path, 1, 'POWERSHELL', basename(path))]
  return []
}

function addMatches(results, file, line, text, ruleId, pattern) {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) results.push(finding(file, line, ruleId, match[0]))
}

function switchFindings(file, lineNumber, text, nextLine = '') {
  const result = []
  const hasShell = shellOnLine.test(text)
  const pattern = /(^|[\s"',(\[])([-/])([a-z]+)(?=$|[\s"':,])/gi
  for (const match of text.matchAll(pattern)) {
    const name = match[3].toLowerCase()
    if (name.length <= 2 && !hasShell) continue
    const tokenStart = match.index + match[1].length
    const tokenEnd = match.index + match[0].length
    const suffix = text.slice(tokenEnd)
    const valueShape = /^([\s"':,]*)([a-z0-9]+)(?=$|[\s"':,;)}|`])/i
    const argument = valueShape.exec(suffix)
    // An argument list can hold one token on each line, so a switch that ends its line takes the next line's first token.
    const nextValue = !argument && /^[\s"':,]*$/.test(suffix) ? valueShape.exec(nextLine) : null
    const value = (argument ?? nextValue)?.[2].toLowerCase() ?? ''
    const token = match[2] + match[3]
    const openingQuote = argument && /(["'])\s*$/.exec(argument[1])?.[1]
    const closingQuoteLength = openingQuote && suffix[argument[0].length] === openingQuote ? 1 : 0
    const sourceMatch = argument ? text.slice(tokenStart, tokenEnd + argument[0].length + closingQuoteLength) : nextValue ? `${token} ${nextValue[2]}` : token
    if ((name === 'ep' || (name.length >= 2 && 'executionpolicy'.startsWith(name))) && value === 'bypass') {
      result.push(finding(file, lineNumber, 'POLICY_BYPASS', sourceMatch))
    }
    if (name === 'ec' || 'encodedcommand'.startsWith(name)) result.push(finding(file, lineNumber, 'ENCODED_COMMAND', token))
    if ('windowstyle'.startsWith(name) && (value === '1' || (value.length > 0 && 'hidden'.startsWith(value)))) {
      result.push(finding(file, lineNumber, 'HIDDEN_POWERSHELL', sourceMatch))
    }
  }
  return result
}

/** Scan text without reading, writing, launching or logging anything. */
export function scanContent(file, content) {
  const text = String(content)
  const lines = text.split(/\r?\n/)
  const result = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const [ruleId, pattern] of textRules) addMatches(result, file, index + 1, line, ruleId, pattern)
    result.push(...switchFindings(file, index + 1, line, lines[index + 1]))
    if (shellInvocation.test(line)) addMatches(result, file, index + 1, line, 'COMMAND_PROMPT', scriptCommand)
    if (isNative(file)) {
      for (const [ruleId, pattern] of nativeRules) addMatches(result, file, index + 1, line, ruleId, pattern)
    }
    if (launchOperation.test(line)) {
      const adjacent = [line, lines[index + 1]].filter((value) => value !== undefined)
      const match = adjacent.map((value) => temporaryPath.exec(value)).find(Boolean)
      if (match) result.push(finding(file, index + 1, 'TEMP_LAUNCH', match[0]))
    }
  }
  return result
}

function containedPath(file, folder) {
  const candidate = slashPath(file).toLowerCase()
  const parent = slashPath(folder).replace(/\/+$/, '').toLowerCase()
  return candidate === parent || candidate.startsWith(parent + '/')
}

function describeError(error) {
  return typeof error?.code === 'string' ? error.code : 'READ_FAILED'
}

/**
 * Read the four roots and return findings without printing or changing files.
 * Directory and file links are reported and never followed. The optional
 * strict folder changes the result code, not the set of findings collected.
 */
export function scan(root, { strict } = {}) {
  const base = resolve(root)
  const results = []
  const inspectedPaths = new Set()
  let strictFolder
  if (strict !== undefined) {
    const target = resolve(base, strict)
    const rel = relative(base, target)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      return { findings: [finding(slashPath(strict), 1, 'GUARD_ROOT_MISSING', 'OUTSIDE_SCAN_ROOT')], counts: countsOf([finding(slashPath(strict), 1, 'GUARD_ROOT_MISSING', 'OUTSIDE_SCAN_ROOT')]), exitCode: 1 }
    }
    strictFolder = slashPath(rel || '.')
  }

  function visit(path, rel, requiredRoot = false) {
    inspectedPaths.add(slashPath(rel).toLowerCase())
    let info
    try {
      info = fs.lstatSync(path)
    } catch (error) {
      results.push(finding(rel, 1, requiredRoot && error?.code === 'ENOENT' ? 'GUARD_ROOT_MISSING' : 'GUARD_IO', describeError(error)))
      return
    }
    if (info.isSymbolicLink()) {
      results.push(finding(rel, 1, 'GUARD_LINK_SKIPPED', 'LINK_NOT_FOLLOWED'))
      return
    }
    if (info.isDirectory()) {
      let entries
      try {
        entries = fs.readdirSync(path).sort()
      } catch (error) {
        results.push(finding(rel, 1, 'GUARD_IO', describeError(error)))
        return
      }
      for (const name of entries) visit(resolve(path, name), rel + '/' + name)
      return
    }
    if (!info.isFile()) {
      results.push(finding(rel, 1, 'GUARD_IO', 'NOT_REGULAR_FILE'))
      return
    }
    results.push(...scanPath(rel))
    try {
      const bytes = fs.readFileSync(path)
      if (!bytes.subarray(0, 8192).includes(0)) results.push(...scanContent(rel, bytes.toString('utf8')))
    } catch (error) {
      results.push(finding(rel, 1, 'GUARD_IO', describeError(error)))
    }
  }

  for (const name of ROOTS) {
    visit(resolve(base, name), name, true)
  }
  // Use only paths already reached through the no-follow traversal. Looking
  // up an otherwise missing strict descendant could follow a skipped link.
  const blockingAncestor = strictFolder && results.some((item) =>
    ['GUARD_LINK_SKIPPED', 'GUARD_ROOT_MISSING', 'GUARD_IO'].includes(item.ruleId) && containedPath(strictFolder, item.file))
  if (strictFolder && strictFolder !== '.' && !blockingAncestor && !inspectedPaths.has(strictFolder.toLowerCase())) {
    results.push(finding(strictFolder, 1, 'GUARD_ROOT_MISSING', 'NOT_IN_SCAN_TREE'))
  }
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId) || a.matchedText.localeCompare(b.matchedText))
  const exitCode = strictFolder === '.'
    ? Number(results.length > 0)
    : Number(strictFolder !== undefined && (blockingAncestor || results.some((item) => containedPath(item.file, strictFolder))))
  return { findings: results, counts: countsOf(results), exitCode }
}

function countsOf(findings) {
  const counts = Object.fromEntries(RULE_IDS.map((id) => [id, 0]))
  for (const item of findings) counts[item.ruleId]++
  return counts
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  let strict
  let jsonPath
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if ((arg === '--strict' || arg === '--json') && args[index + 1] && !args[index + 1].startsWith('--')) {
      if (arg === '--strict') strict = args[++index]
      else jsonPath = args[++index]
    } else {
      process.stderr.write('Usage: node scripts/build-guard.mjs [--strict <folder>] [--json <path>]\n')
      return 2
    }
  }
  const report = scan(cwd, { strict })
  for (const item of report.findings) process.stdout.write(`${item.file}:${item.line} ${item.ruleId} ${item.matchedText}\n`)
  for (const ruleId of RULE_IDS) process.stdout.write(`${ruleId}: ${report.counts[ruleId]}\n`)
  if (jsonPath !== undefined) {
    try {
      fs.writeFileSync(resolve(cwd, jsonPath), JSON.stringify({ findings: report.findings, counts: report.counts }, null, 2) + '\n')
    } catch (error) {
      process.stderr.write(`GUARD_IO ${describeError(error)}\n`)
      return strict === undefined ? 0 : 1
    }
  }
  return report.exitCode
}

// Node keeps a link in argv[1] and gives import.meta.url the real path, so compare real paths.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
