// scoped.mjs: run one command with HOME and USERPROFILE pinned to a scratch
// folder under the scratch root (this folder, or RESTARTMK_SCRATCH), BGOS_*/HOAI_*/CLAUDE_* cleared.
// Usage: node scoped.mjs <scratch-home> -- <command> [args...]
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep !== 1 || argv.length < 3) {
  console.error('usage: node scoped.mjs <scratch-home> -- <command> [args...]')
  process.exit(96)
}
const home = resolve(argv[0])
// Scratch homes must live under this folder (or RESTARTMK_SCRATCH).
const ROOT = `${resolve(process.env.RESTARTMK_SCRATCH || dirname(fileURLToPath(import.meta.url)))}\\`
console.log(`HOME=${home}`)
if (!home.toLowerCase().startsWith(ROOT.toLowerCase()) || /^[a-z]:\\users\\[^\\]+\\?$/i.test(home) || home.startsWith('/home/')) {
  console.error(`REFUSED: ${home} is not a scratch folder under ${ROOT}`)
  process.exit(97)
}
mkdirSync(home, { recursive: true })
const tmp = resolve(home, '..', 'wintmp')
mkdirSync(tmp, { recursive: true })
const env = {}
for (const [k, v] of Object.entries(process.env)) {
  if (/^(BGOS_|HOAI_|CLAUDE)/i.test(k)) continue
  env[k] = v
}
env.HOME = home
env.USERPROFILE = home
env.TEMP = tmp
env.TMP = tmp
env.DISABLE_AUTOUPDATER = '1'
const [cmd, ...rest] = argv.slice(2)
const child = spawn(cmd, rest, { stdio: 'inherit', env, shell: /\.(cmd|bat)$/i.test(cmd) })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
child.on('error', (err) => {
  console.error(`scoped: ${err.message}`)
  process.exit(95)
})
