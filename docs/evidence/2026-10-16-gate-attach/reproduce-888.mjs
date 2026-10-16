// reproduce-888.mjs: agent 888's win32-gate-helper.log shape (start, then accepted, no attached),
// from the REAL helper on a FAKE console: a hidden console holding a small node program that shows
// the dev-channels gate's marker text and waits for one Enter. Never a real claude, never hoai.
//
//   node reproduce-888.mjs <path to win32-accept-dev-channels.ps1> <empty scratch dir>
//
// The helper is spawned the way bin/hoai-core.mjs defaultSpawnGateHelper spawns it: not detached,
// hidden, stdout and stderr on the log file opened for append. Then one other reader holds the log
// open, from the moment `start` is on record until the helper has tried to record `attached`: the
// old helper's refused write shows up in the log as Add-Content's error text (its stderr is that
// same log); the fixed helper retries for about a second, so the reader stays at most 4 s. Then the
// gate appears on the fake console and the helper presses Enter.
//
// Prints the helper's exit code, whether the fake gate got its Enter, and the log.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [helper, dir] = process.argv.slice(2)
if (!helper || !dir) {
  console.error('usage: node reproduce-888.mjs <win32-accept-dev-channels.ps1> <empty scratch dir>')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
const log = join(dir, 'win32-gate-helper.log')
const show = join(dir, 'show-gate')
const enter = join(dir, 'gate-got-enter')
const fake = join(dir, 'fake-gate.mjs')
writeFileSync(log, '')
writeFileSync(
  fake,
  `import { existsSync, writeFileSync } from 'node:fs'
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (chunk) => {
  if (chunk.includes(13)) {
    writeFileSync(${JSON.stringify(enter)}, new Date().toISOString())
    process.exit(0)
  }
})
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(show)})) return
  clearInterval(timer)
  process.stdout.write('WARNING: Loading development channels\\n\\n  1. I am using this for local development\\n  2. Exit\\n')
}, 100)
setTimeout(() => process.exit(3), 120_000)
`,
)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const psQuote = (value) => `'${value.replace(/'/g, "''")}'`
const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(`"${fake}"`)} -WindowStyle Hidden -PassThru; $p.Id`],
  { encoding: 'utf8', windowsHide: true },
)
const consolePid = Number(String(ps.stdout).trim())
if (!Number.isInteger(consolePid) || consolePid <= 0) throw new Error(`fake gate did not start: ${ps.stderr}`)
console.log(`fake gate pid ${consolePid} in its own hidden console`)

const logFd = openSync(log, 'a')
const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ConsolePid', String(consolePid), '-TimeoutSeconds', '60', '-LogFile', log],
  { stdio: ['ignore', logFd, logFd], detached: false, windowsHide: true, shell: false },
)
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
const read = () => {
  try {
    return readFileSync(log, 'utf8')
  } catch {
    return ''
  }
}
const t0 = Date.now()
while (!/ start console=|Add-Content/.test(read())) {
  if (Date.now() - t0 > 30_000) throw new Error('the helper never logged start')
  await sleep(100)
}
const reader = openSync(log, 'r')
const heldAt = Date.now()
console.log(`a reader holds the log from +${heldAt - t0} ms`)
while (Date.now() - heldAt < 4000 && !/Add-Content/.test(read())) await sleep(200)
closeSync(reader)
console.log(`reader closed at +${Date.now() - t0} ms; showing the gate`)
writeFileSync(show, '1')
const code = await exited
closeSync(logFd)
await sleep(1000)
try {
  process.kill(consolePid)
} catch {
  // it exits by itself on the Enter
}
console.log(`helper exit code: ${code}`)
console.log(`fake gate got its Enter: ${existsSync(enter) ? 'yes' : 'NO'}`)
console.log('--- win32-gate-helper.log')
process.stdout.write(read())
