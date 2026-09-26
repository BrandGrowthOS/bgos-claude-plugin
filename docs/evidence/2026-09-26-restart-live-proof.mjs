/**
 * LIVE PROOF of the watcher half, with real processes and real files.
 *
 * Real: the actual superviseClaude from bin/hoai-core.mjs, a real temp HOME,
 * a real restart-requested.json written to disk, real child processes with
 * real pids, a real SIGTERM, a real relaunch.
 * Substituted: the command is `sleep` instead of the claude binary, because
 * what is under test is the restart mechanism, not claude.
 */
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const PLUGIN = '/Users/fitecho/BGOS-worktrees/plugin-restart'
const { superviseClaude, RESTART_MARKER_FILE_NAME } = await import(
  `${PLUGIN}/bin/hoai-core.mjs`
)

const home = mkdtempSync(join(tmpdir(), 'hoai-liveproof-'))
const agentId = '999999'
const stateDir = join(home, '.bgos-agent', agentId)
mkdirSync(stateDir, { recursive: true })
const cwd = mkdtempSync(join(tmpdir(), 'hoai-cwd-'))
writeFileSync(join(cwd, '.bgos-agent-id'), agentId)
// The folder publishes its own HOAI server, exactly as a real bgos-agent
// workspace does. This is route 1 of the channel resolution, and it is what
// the first run correctly refused to guess at.
writeFileSync(
  join(cwd, '.mcp.json'),
  JSON.stringify(
    {
      mcpServers: {
        bgos: {
          command: 'bun',
          args: [`${PLUGIN}/server.ts`],
          // Recognised as OURS by a BGOS_ key in env (parseMcpChannelServerName).
          env: { BGOS_ASSISTANT_ID: agentId },
        },
      },
    },
    null,
    2,
  ),
)
const markerPath = join(stateDir, RESTART_MARKER_FILE_NAME)

const launches = []
const spawnImpl = (file, args, options) => {
  // A REAL process, with a real pid, that outlives a poll or two.
  const child = spawn('sleep', ['30'], { ...options, stdio: 'ignore' })
  launches.push({ n: launches.length + 1, pid: child.pid, at: Date.now() })
  console.log(`  [spawn] launch #${launches.length} pid=${child.pid}`)
  return child
}

console.log(`HOME      ${home}`)
console.log(`marker    ${markerPath}`)
console.log('')

// Write the marker shortly after the first child is up, exactly as the
// update ladder's launcher rung does.
setTimeout(() => {
  writeFileSync(markerPath, '{}')
  console.log(`  [marker] WROTE ${RESTART_MARKER_FILE_NAME} (this is what the ladder does)`)
}, 1200)

// Stop the loop once we have seen a relaunch.
const watchdog = setTimeout(() => {
  console.log('\nTIMED OUT waiting for a relaunch')
  process.exit(1)
}, 20000)

const poll = setInterval(() => {
  if (launches.length >= 2) {
    clearInterval(poll)
    clearTimeout(watchdog)
    const [first, second] = launches
    console.log('')
    console.log('RESULT')
    console.log(`  first child pid   ${first.pid}`)
    console.log(`  marker consumed   ${!existsSync(markerPath)}`)
    console.log(`  relaunched pid    ${second.pid}`)
    console.log(`  different process ${first.pid !== second.pid}`)
    console.log(`  elapsed           ${second.at - first.at} ms`)
    console.log('')
    console.log(
      first.pid !== second.pid && !existsSync(markerPath)
        ? 'PROVEN: the watcher saw the marker, killed the child and started a new one.'
        : 'NOT PROVEN',
    )
    process.exit(first.pid !== second.pid && !existsSync(markerPath) ? 0 : 1)
  }
}, 200)

await superviseClaude([], {
  home,
  cwd,
  spawnImpl,
  pollMs: 300,
  print: (line) => console.log(`  [hoai] ${line}`),
  force: true,
})
