/**
 * Live processes whose command line contains a string: `pgrep -f` where it exists, and the CIM
 * process table through PowerShell on Windows, which has no pgrep. Used to prove a test left no
 * browser behind.
 *
 * It never reads "could not look" as "none": a lookup that fails throws, because an empty answer
 * from a broken lookup is exactly the green that proves nothing. The needle travels in an
 * environment variable on Windows, so the query can never match itself.
 */

import { spawnSync } from 'node:child_process'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function processesMatching(needle: string, opts: { env?: NodeJS.ProcessEnv } = {}): number[] {
  const env = opts.env ?? process.env
  if (!needle) throw new Error('processesMatching needs a non-empty needle')
  if (process.platform === 'win32') {
    const query =
      '$n = $env:HOAI_PROCESS_NEEDLE; Get-CimInstance Win32_Process | Where-Object { ' +
      '$_.ProcessId -ne $PID -and $_.CommandLine -and ' +
      '$_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ' +
      'ForEach-Object { $_.ProcessId }'
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      encoding: 'utf8',
      env: { ...env, HOAI_PROCESS_NEEDLE: needle },
      windowsHide: true,
    })
    if (ps.error || ps.status !== 0) throw new Error(`could not list processes: ${ps.error?.message ?? ps.stderr}`)
    return pids(ps.stdout)
  }
  const pg = spawnSync('pgrep', ['-f', '--', escapeRegExp(needle)], { encoding: 'utf8', env })
  if (pg.error) throw new Error(`could not list processes: ${pg.error.message}`)
  if (pg.status === 1) return []
  if (pg.status !== 0) throw new Error(`could not list processes: pgrep exited ${pg.status} ${pg.stderr}`)
  return pids(pg.stdout)
}

function pids(text: string): number[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}
