// Evidence driver for the edit_message fix. Loopback only.
//
// Runs the REAL plugin daemon (bun server.ts from <pluginDir>) as an MCP stdio server paired to the rig's agent
// Atlas (id 1, owner Maya), and a headless browser signed in as Maya on Atlas's chat (the rig's web export).
// The agent replies, then edits its reply with edit_message; a screenshot after each step, the row read back
// over the API as Maya, then three edits that must be refused (a non numeric id, an id that does not exist, and
// another person's line in a room).
//
//   node drive.mjs --plugin <dir> --label before|after --out <dir> --repo <bgos worktree> --home <scratch home>
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
const pluginDir = path.resolve(flag('plugin'))
const label = flag('label')
const outDir = path.resolve(flag('out'))
const repo = path.resolve(flag('repo'))
const home = path.resolve(flag('home'))
const pairing = JSON.parse(fs.readFileSync(path.resolve(flag('pairing')), 'utf8'))
const API = 'http://127.0.0.1:9617'
const WEB = 'http://127.0.0.1:9618'
const CHAT_ID = '1'
const FOREIGN_ROOM_MESSAGE = flag('foreign')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(home, { recursive: true })

const log = []
const note = (step, data) => {
  const line = { at: new Date().toISOString(), label, step, ...data }
  log.push(line)
  console.log(JSON.stringify(line))
  fs.writeFileSync(path.join(outDir, `${label}-transcript.json`), JSON.stringify(log, null, 2))
}

const mint = () => spawnSync('node', [path.join(repo, 'e2e/fixture-rig/rig.mjs'), 'mint', 'maya', '2'], { encoding: 'utf8' }).stdout.trim()
const bearer = mint()
async function rowText(id) {
  const r = await fetch(`${API}/api/v1/chats/${CHAT_ID}/messages?limit=20`, { headers: { Authorization: `Bearer ${bearer}` } })
  const body = await r.json().catch(() => null)
  const rows = Array.isArray(body) ? body : body?.messages ?? body?.data ?? body?.items ?? []
  const row = rows.map((m) => m?.message ?? m).find((m) => String(m.id) === String(id))
  return { status: r.status, text: row?.text ?? null, editedAt: row?.editedAt ?? row?.edited_at ?? null }
}

// The browser, as Maya, on Atlas's chat.
const frontRequire = createRequire(path.join(repo, 'frontend', 'package.json'))
const { chromium } = frontRequire('playwright-core')
const profile = path.join(home, `chrome-${label}`)
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
const shoot = async (name, opts = {}) => {
  const file = path.join(outDir, `${label}-${name}.png`)
  await page.screenshot({ path: file, ...opts })
  note('screenshot', { file: path.basename(file) })
  return file
}
await page.goto(`${WEB}/__rig/maya.html?theme=dark&to=${encodeURIComponent(`/chat/${CHAT_ID}`)}`, { waitUntil: 'load' })
await page.waitForTimeout(7000)

// The plugin daemon, as Atlas, over MCP stdio.
const pluginRequire = createRequire(path.join(pluginDir, 'package.json'))
const { Client } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const { StdioClientTransport } = await import(pathToFileURL(pluginRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
const daemonLog = fs.openSync(path.join(outDir, `${label}-daemon.log`), 'w')
const transport = new StdioClientTransport({
  command: 'bun',
  args: ['server.ts'],
  cwd: pluginDir,
  stderr: daemonLog,
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
const tools = await client.listTools()
const editTool = tools.tools.find((t) => t.name === 'edit_message')
note('tools', { count: tools.tools.length, editDescription: editTool?.description ?? null })
await new Promise((r) => setTimeout(r, 5000))

const call = async (name, toolArgs) => {
  const result = await client.callTool({ name, arguments: toolArgs })
  const text = (result.content ?? []).map((c) => c.text ?? '').join('\n')
  note('tool', { name, arguments: toolArgs, isError: result.isError === true, text })
  return { text, isError: result.isError === true }
}

const ORIGINAL = 'Draft: the launch review is on Thursday at 10:00.'
const EDITED = 'Correction: the launch review moved to Friday at 14:00, same room.'
const sent = await call('reply', { chat_id: CHAT_ID, text: ORIGINAL })
const messageId = /message_id: (\d+)/.exec(sent.text)?.[1]
if (!messageId) throw new Error(`no message id in the reply result: ${sent.text}`)
await page.waitForTimeout(4000)
note('row', { when: 'after reply', id: messageId, ...(await rowText(messageId)) })
await shoot('1-replied')

const edited = await call('edit_message', { message_id: messageId, text: EDITED })
await page.waitForTimeout(4000)
note('row', { when: 'after edit_message', id: messageId, ...(await rowText(messageId)) })
await shoot('2-after-edit')

await call('edit_message', { message_id: 'abc', text: 'never sent' })
await call('edit_message', { message_id: '999999', text: 'no such message' })
await call('edit_message', { message_id: FOREIGN_ROOM_MESSAGE, text: 'Atlas rewriting Leo' })

// A cold read: the edit survives a reload, and the same state at a phone width and in light.
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(6000)
await shoot('3-after-reload')
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(`${WEB}/__rig/maya.html?theme=light&to=${encodeURIComponent(`/chat/${CHAT_ID}`)}`, { waitUntil: 'load' })
await page.waitForTimeout(6000)
await shoot('4-phone-light')
note('summary', { messageId, editAnswer: edited.text, final: await rowText(messageId) })

await client.close()
await context.close()
fs.rmSync(profile, { recursive: true, force: true })
