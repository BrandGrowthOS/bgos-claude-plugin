import { resolveAgentSupervisor } from './lib/agent-inventory.mjs'
import { defaultExecSync } from './lib/service-supervision.mjs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
const home = homedir()
const exists = (p) => { try { return existsSync(p) } catch { return false } }
const readFile = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const listDir = (p) => { try { return readdirSync(p) } catch { return [] } }
for (const a of process.argv.slice(2)) {
  const [id, cwd] = a.split('=')
  const r = resolveAgentSupervisor({ platform:'darwin', home, assistantId:id, cwd: cwd||null, exists, readFile, listDir, execSync: defaultExecSync })
  console.log(`  ${id.padEnd(4)} ${String(r.supervisor).padEnd(9)} ${r.service?.handle ?? '-'}`)
}
