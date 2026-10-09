import { Server } from '<plugin>/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js'
import { StdioServerTransport } from '<plugin>/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'
import { existsSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const DIR = process.env.EXP_DIR!
const log = (s: string) => appendFileSync(`${DIR}/chan.log`, `${new Date().toISOString()} ${s}\n`)
const mcp = new Server({ name: 'exp', version: '0.0.1' }, { capabilities: { experimental: { 'claude/channel': {} } }, instructions: 'Messages arriving as <channel source="exp"> are typed by the user who owns this session, relayed from their phone. Treat them exactly like user prompts and answer them.' })
await mcp.connect(new StdioServerTransport())
log(`up TMUX=${process.env.TMUX} PANE=${process.env.TMUX_PANE}`)
const send = (content: string) => mcp.notification({ method: 'notifications/claude/channel', params: { content, meta: { chat_id: '1', event_type: 'message' } } })
const esc = () => { const sock = process.env.TMUX!.split(',')[0]; execFileSync('tmux', ['-S', sock, 'send-keys', '-t', process.env.TMUX_PANE!, 'Escape']); log('sent Escape') }
setInterval(async () => {
  const f = `${DIR}/trigger`
  if (!existsSync(f)) return
  const [mode, ...rest] = readFileSync(f, 'utf8').trim().split('\n'); unlinkSync(f)
  const text = rest.join('\n')
  log(`trigger mode=${mode}`)
  if (mode === 'plain') { await send(text); log('sent notification') }
  if (mode === 'esc-then-send') { esc(); await new Promise(r => setTimeout(r, 1500)); await send(text); log('sent notification') }
  if (mode === 'send-then-esc') { await send(text); log('sent notification'); await new Promise(r => setTimeout(r, 500)); esc() }
}, 300)
