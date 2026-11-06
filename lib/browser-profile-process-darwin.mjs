import { spawnSync } from 'node:child_process'

const unavailable = () => Object.assign(new Error('profile_process_exit_proof_unavailable'), { code: 'profile_process_exit_proof_unavailable', reason: 'profile_process_exit_proof_unavailable' })
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const validPid = pid => Number.isSafeInteger(pid) && pid > 0

function startTime(text) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(text)
  if (!match) throw unavailable()
  const [, weekday, month, day, hour, minute, second, year] = match
  const values = [Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)]
  const date = new Date(Date.UTC(values[0], values[1], values[2], values[3], values[4], values[5]))
  if (values[0] < 1970 || weekdays[date.getUTCDay()] !== weekday ||
      [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].some((value, index) => value !== values[index])) throw unavailable()
  return String(date.getTime())
}

/**
 * Read-only Darwin process proof. lstart is parsed as UTC under the C locale;
 * no localized Date.parse, shell, command names or pid-only liveness fallback.
 * @param {{read?: (file: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => {stdout: string, stderr: string, status: number | null, signal?: string | null, error?: unknown}}} options
 */
export function createDarwinProcessProof({ read = (file, args, options) => spawnSync(file, args, options) } = {}) {
  function rows(pid) {
    if (pid !== undefined && !validPid(pid)) throw unavailable()
    try {
      const args = pid === undefined ? ['-A', '-o', 'pid=,pgid=,lstart='] : ['-o', 'pid=,pgid=,lstart=', '-p', String(pid)]
      const value = read('/bin/ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, shell: false, timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
      if (value.error || value.signal || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || value.stderr.trim()) throw unavailable()
      // ps returns 1 with no rows when a selected pid is gone. An unsuccessful
      // table read, missing executable or diagnostic is never an exit proof.
      if (pid !== undefined && value.status === 1 && !value.stdout.trim()) return []
      if (value.status !== 0 || !value.stdout.trim()) throw unavailable()
      const lines = value.stdout.trim().split(/\r?\n/), seen = new Set()
      if (lines.length > 65536) throw unavailable()
      return lines.map(line => {
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line)
        if (!match) throw unavailable()
        const actualPid = Number(match[1]), group = Number(match[2])
        if (!Number.isSafeInteger(actualPid) || actualPid < 0 || !Number.isSafeInteger(group) || group < 0 || seen.has(actualPid) || pid !== undefined && actualPid !== pid) throw unavailable()
        seen.add(actualPid)
        return { pid: actualPid, group, started: startTime(match[3].trim()) }
      })
    } catch { throw unavailable() }
  }
  const identity = pid => {
    if (!validPid(pid)) throw unavailable()
    const row = rows(pid)[0]
    if (!row) throw unavailable()
    return { pid: row.pid, started: row.started }
  }
  const exited = identity => {
    if (!identity || !validPid(identity.pid) || typeof identity.started !== 'string' || !/^[0-9]{1,32}$/.test(identity.started)) throw unavailable()
    const row = rows(identity.pid)[0]
    return !row || row.started !== identity.started
  }
  const groupMembers = group => {
    if (!validPid(group)) throw unavailable()
    return rows(undefined).filter(row => row.group === group).map(({ pid, started }) => ({ pid, started }))
  }
  return Object.freeze({ identity, exited, groupMembers })
}
