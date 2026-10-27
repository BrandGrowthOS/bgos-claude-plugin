#!/usr/bin/env node
/**
 * fake-claude-tui: a stand in for Claude Code's interactive screen, run inside
 * a PRIVATE tmux server by test/model-effort-tmux-rig.test.ts. It is never a
 * real agent and calls no model.
 *
 * It draws the composer the way Claude Code 2.1.310 does (a prompt line
 * between two rule lines, the glyph then a no-break space, the cursor an
 * inverse cell, an empty composer's placeholder in SGR 2 with the cursor on
 * its first letter: test/fixtures/claude-2.1.310-composer), takes keys in raw
 * mode (Left and Right move the cursor), and on Enter applies exactly two commands,
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
 * echo commands without applying them, FAKE_TUI_TEXT_SGR to draw typed text in
 * that colour (38;2;0;0;0 is the light themes' text colour), and
 * FAKE_TUI_DIM_TAGS=1 to draw a `[Pasted text #N ...]` tag dim.
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
const textSgr = process.env.FAKE_TUI_TEXT_SGR ?? ''
const dimTags = process.env.FAKE_TUI_DIM_TAGS === '1'
const TAG_RE = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/g
let draft = ''
let cursor = 0
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

/** One character of the draft, in the colour it is drawn in. */
function styled(i) {
  let dim = false
  if (dimTags) for (const m of draft.matchAll(TAG_RE)) if (i >= m.index && i < m.index + m[0].length) dim = true
  const ch = draft[i] ?? ' '
  const inv = i === cursor
  const sgr = [inv ? '7' : '', dim ? '2' : textSgr].filter(Boolean).join(';')
  return sgr ? `\u001b[${sgr}m${ch}\u001b[0m` : ch
}

function composer() {
  if (draft === '') return '\u001b[7mT\u001b[0;2mry "fix lint errors"\u001b[0m'
  let out = ''
  for (let i = 0; i <= draft.length; i++) if (i < draft.length || i === cursor) out += styled(i)
  return out
}

function render() {
  process.stdout.write('\u001b[2J\u001b[H')
  process.stdout.write(`● ${last}\r\n\r\n${RULE}\r\n❯\u00a0${composer()}\r\n${RULE}\r\n  ? for shortcuts\r\n`)
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
  for (const [ch] of chunk.matchAll(/\u001b\[[0-9;]*[A-Za-z~]|\u001bO[A-Za-z]|[\s\S]/gu)) {
    if (ch === '\r') {
      const line = draft
      draft = ''
      cursor = 0
      if (applies) submit(line)
      else {
        draft = line
        cursor = line.length
      }
    } else if (ch === '\u007f') {
      if (cursor > 0) {
        draft = draft.slice(0, cursor - 1) + draft.slice(cursor)
        cursor--
      }
    } else if (ch === '\u001b[D' || ch === '\u001bOD') {
      cursor = Math.max(0, cursor - 1)
    } else if (ch === '\u001b[C' || ch === '\u001bOC') {
      cursor = Math.min(draft.length, cursor + 1)
    } else if (ch >= ' ' && !ch.startsWith('\u001b')) {
      draft = draft.slice(0, cursor) + ch + draft.slice(cursor)
      cursor++
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
