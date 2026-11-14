// Round 2 evidence driver for edit_message: the tool edits only a message this agent sent. Loopback only.
//
// The REAL plugin daemon (bun server.ts) as an MCP stdio server paired to the rig's Atlas (id 1, owner Maya), and a
// headless browser signed in as Maya. Targets made beforehand through the API as Maya: her own line in Atlas's chat
// (--owner-line) and a line of her other agent Kite in Kite's chat (--sibling-line, chat --sibling-chat).
//
//   --mode round2: session A replies, edits that reply, tries the owner's line and Kite's line; the daemon stops;
//                  session B (same HOME, so the same record) edits session A's reply again.
//   --mode round1: the round 1 plugin edits the owner's line and Kite's line (the gap this round closes).
//
//   node drive2.mjs --mode round2|round1 --plugin <dir> --out <dir> --repo <bgos worktree> --home <scratch home>
//     --pairing <pairing.json> --owner-line <id> --sibling-line <id> --sibling-chat <id>
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= args.length) throw new Error(`--${name} is required`)
  return args[i + 1]
}
const mode = flag('mode')
const pluginDir = path.resolve(flag('plugin'))
const outDir = path.resolve(flag('out'))
const repo = path.resolve(flag('repo'))
const home = path.resolve(flag('home'))
const pairing = JSON.parse(fs.readFileSync(path.resolve(flag('pairing')), 'utf8'))
const OWNER_LINE = flag('owner-line')
const SIBLING_LINE = flag('sibling-line')
const SIBLING_CHAT = flag('sibling-chat')
const API = 'http://127.0.0.1:9617'
const WEB = 'http://127.0.0.1:9618'
const CHAT_ID = '1'
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(home, { recursive: true })

const log = []
const note = (step, data) => {
  const line = { at: new Date().toISOString(), mode, step, ...data }
  log.push(line)
  console.log(JSON.stringify(line))
  fs.writeFileSync(path.join(outDir, `${mode}-transcript.json`), JSON.stringify(log, null, 2))
}

const bearer = spawnSync('node', [path.join(repo, 'e2e/fixture-rig/rig.mjs'), 'mint', 'maya', '2'], { encoding: 'utf8' }).stdout.trim()
async function row(chatId, id) {
  const r = await fetch(`${API}/api/v1/chats/${chatId}/messages?limit=30`, { headers: { Authorization: `Bearer ${bearer}` } })
  const body = await r.json().catch(() => null)
  const found = (body?.messages ?? []).map((m) => m?.message ?? m).find((m) => String(m.id) === String(id))
  return { id: String(id), chatId, sender: found?.sender ?? null, text: found?.text ?? null, editedAt: found?.editedAt ?? null }
}

const frontRequire = createRequire(path.join(repo, 'frontend', 'package.json'))
const { chromium } = frontRequire('playwright-core')
const profile = path.join(home, `chrome-${mode}`)
const context = await chromium.launchPersistentContext(profile, {
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-background-networking', '--no-first-run'],
})
await context.addInitScript(() => {
  try { localStorage.setItem('@bgos_minimal_prefs', JSON.stringify({ minimal: false, firstRunChosen: true })) } catch {}
})
await context.route('**/*', (route) => {
  const url = route.request().url()
  if (/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) || /^(data|blob):/.test(url)) return route.continue()
  return route.abort()
})
const page = context.pages()[0] || (await context.newPage())
const open = async (chatId) => {
  await page.goto(`${WEB}/__rig/maya.html?theme=dark&to=${encodeURIComponent(`/chat/${chatId}`)}`, { waitUntil: 'load' })
  await page.waitForTimeout(6000)
}
const shoot = async (name) => {
  const file = path.join(outDir, `${mode}-${name}.png`)
  await page.screenshot({ path: file })
  note('screenshot', { file: path.basename(file) })
}

const pluginRequire = createRequire(path.join(pluginDir, 'package.json'))
const { Client } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const { StdioClientTransport } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
async function daemon(session) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['server.ts'],
    cwd: pluginDir,
    stderr: fs.openSync(path.join(outDir, `${mode}-${session}-daemon.log`), 'w'),
    env: {
      HOME: home,
      PATH: process.env.PATH,
      EDITFIX_RIG_MARK: 'editfix-evidence',
      BGOS_BACKEND_URL: `${API}/api/v1`,
      BGOS_PAIRING_TOKEN: pairing.pairing_token,
      BGOS_ASSISTANT_ID: '1',
      BGOS_USER_ID: pairing.user_id,
      BGOS_PLUGIN_STATE_DIR: path.join(home, 'plugin-state'),
      BGOS_LAUNCH_CWD: home,
    },
  })
  const client = new Client({ name: 'editfix-evidence', version: '1.0.0' })
  await client.connect(transport)
  await new Promise((r) => setTimeout(r, 4000))
  const call = async (name, toolArgs) => {
    const result = await client.callTool({ name, arguments: toolArgs })
    const text = (result.content ?? []).map((c) => c.text ?? '').join('\n')
    note('tool', { session, name, arguments: toolArgs, isError: result.isError === true, text })
    return text
  }
  return { call, close: () => client.close() }
}

note('before', { owner: await row(CHAT_ID, OWNER_LINE), sibling: await row(SIBLING_CHAT, SIBLING_LINE) })
await open(CHAT_ID)

if (mode === 'round2') {
  const a = await daemon('A')
  const sent = await a.call('reply', { chat_id: CHAT_ID, text: 'Noted: I will book a room for the launch review.' })
  const own = /message_id: (\d+)/.exec(sent)?.[1]
  if (!own) throw new Error(`no message id in: ${sent}`)
  await a.call('edit_message', { message_id: own, text: 'Booked: the large room, Friday at 14:00.' })
  await a.call('edit_message', { message_id: OWNER_LINE, text: 'Never mind, any small room is fine.' })
  await a.call('edit_message', { message_id: SIBLING_LINE, text: 'Kite here: the budget sheet is cancelled.' })
  await a.close()
  note('rows', { own: await row(CHAT_ID, own), owner: await row(CHAT_ID, OWNER_LINE), sibling: await row(SIBLING_CHAT, SIBLING_LINE) })
  await open(CHAT_ID)
  await shoot('1-atlas-chat')
  await open(SIBLING_CHAT)
  await shoot('2-kite-chat')
  // The daemon restarts: the same HOME, so the same record of this agent's own messages.
  const b = await daemon('B')
  await b.call('edit_message', { message_id: own, text: 'Booked: the large room, Friday at 14:00 (confirmed after a restart).' })
  await b.close()
  note('rows', { after: 'restart', own: await row(CHAT_ID, own) })
  await open(CHAT_ID)
  await shoot('3-after-restart')
} else {
  const a = await daemon('A')
  await a.call('edit_message', { message_id: OWNER_LINE, text: 'Never mind, any small room is fine.' })
  await a.call('edit_message', { message_id: SIBLING_LINE, text: 'Kite here: the budget sheet is cancelled.' })
  await a.close()
  note('rows', { owner: await row(CHAT_ID, OWNER_LINE), sibling: await row(SIBLING_CHAT, SIBLING_LINE) })
  await open(CHAT_ID)
  await shoot('1-atlas-chat')
  await open(SIBLING_CHAT)
  await shoot('2-kite-chat')
}

await context.close()
fs.rmSync(profile, { recursive: true, force: true })
