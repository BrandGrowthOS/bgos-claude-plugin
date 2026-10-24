#!/usr/bin/env node
/**
 * fake-claude-tui: a stand in for Claude Code's interactive screen, run inside
 * a PRIVATE tmux server by test/model-effort-tmux-rig.test.ts. It is never a
 * real agent and calls no model.
 *
 * It draws the composer the way the CLI does (a prompt line between two rule
 * lines), takes keys in raw mode, and on Enter applies exactly two commands,
 * `/model <family>` and `/effort <level>`, the way the CLI's own would. Like
 * the CLI's status line it runs the REAL bridge (bin/hoai-statusline-bridge.mjs)
 * with its session JSON on stdin, at start, after each command and on a timer,
 * so the observations the daemon confirms from are written by the production
 * bridge.
 *
 * It also starts one idle child, a stand in for the daemon (an MCP child of
 * the CLI), and writes its pid to daemon.pid in the state folder.
 *
 * Environment: FAKE_TUI_SESSION_ID, FAKE_TUI_BRIDGE (the bridge's path), and
 * BGOS_PLUGIN_STATE_DIR (where the bridge writes), FAKE_TUI_APPLY=0 to make it
 * echo commands without applying them.
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sessionId = process.env.FAKE_TUI_SESSION_ID
const bridge = process.env.FAKE_TUI_BRIDGE
const applies = process.env.FAKE_TUI_APPLY !== '0'
const RULE = '─'.repeat(60)
let model = 'claude-opus-5-5'
let effort = 'high'
let draft = ''
let last = 'ready'

function statusLine() {
  const input = JSON.stringify({
    session_id: sessionId,
    model: { id: model, display_name: model.split('-')[1] },
    version: '2.1.309',
    effort: { level: effort },
  })
  spawnSync(process.execPath, [bridge], { input, env: process.env, timeout: 5000 })
}

function render() {
  process.stdout.write('\u001b[2J\u001b[H')
  process.stdout.write(`● ${last}\r\n\r\n${RULE}\r\n❯ ${draft}\r\n${RULE}\r\n  ? for shortcuts\r\n`)
}

function submit(line) {
  const m = /^\/model (opus|sonnet|fable|haiku)$/.exec(line)
  const e = /^\/effort (low|medium|high|xhigh|max)$/.exec(line)
  if (m && applies) model = `claude-${m[1]}-5-5`
  if (e && applies) effort = e[1]
  last = m || e ? `Set ${line.slice(1)}` : `Unknown: ${line}`
  // Drawn BEFORE it is reported, so a daemon that reads the screen right after
  // the confirming observation sees the submitted composer, never the old one.
  render()
  statusLine()
}

process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r') {
      const line = draft
      draft = ''
      if (applies) submit(line)
      else draft = line
    } else if (ch === '\u007f') {
      draft = draft.slice(0, -1)
    } else if (ch >= ' ') {
      draft += ch
    }
  }
  render()
})
// A stand in for the daemon: the agent's own child, in the agent's process
// group, as an MCP server is. It exits on its own once its parent is gone, so
// killing this test's tmux server leaves nothing behind.
const daemon = spawn(process.execPath, ['-e', 'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0) }, 200)'], { stdio: 'ignore' })
writeFileSync(join(process.env.BGOS_PLUGIN_STATE_DIR, 'daemon.pid'), String(daemon.pid))
setInterval(statusLine, 500)
render()
statusLine()
