import { readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const root = process.cwd()
const files = readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`)
const bun = files.filter(f => /from\s+['"]bun:test['"]/.test(readFileSync(f, 'utf8')))
const node = files.filter(f => !bun.includes(f))
const chromium = node.filter(f => f.endsWith('.chromium.test.ts'))
const parallel = node.filter(f => !chromium.includes(f))
process.env.TMPDIR = realpathSync(mkdtempSync(`${root}/.editdrop-test-`))
// Keep fixture .js scripts outside the repository's ESM package scope.
writeFileSync(`${process.env.TMPDIR}/package.json`, '{}\n')
process.env.npm_config_cache = `${root}/node_modules/.cache/npm`
console.log(JSON.stringify({ date: new Date().toISOString(), node: process.version, root, parallel: parallel.length, chromium: chromium.length, bun: bun.length, maxWorkers: 4, TMPDIR: process.env.TMPDIR }))
let failed = false
for (const [name, command, args] of [
  ['node', 'node', ['--import', 'tsx', '--test', '--test-concurrency=4', ...parallel]],
  ['chromium', 'node', ['--import', 'tsx', '--test', '--test-concurrency=1', ...chromium]],
  ['bun', 'bun', ['test', '--max-concurrency=4', ...bun]],
]) {
  console.log(`FAMILY ${name} START ${command} ${args.slice(0, 5).join(' ')}; files=${name === 'node' ? parallel.length : name === 'chromium' ? chromium.length : bun.length}`)
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
  console.log(`FAMILY ${name} EXIT ${result.status}; signal=${result.signal}`)
  if (result.status !== 0) failed = true
}
rmSync(process.env.TMPDIR, { recursive: true, force: true })
console.log(`FULL SUITE EXIT ${failed ? 1 : 0}`)
process.exit(failed ? 1 : 0)
