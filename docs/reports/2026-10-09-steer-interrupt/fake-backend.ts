// Local stand-in for the BGOS backend, for the live steer proof only.
import { appendFileSync, writeFileSync } from 'node:fs'
const DIR = process.env.LIVE_DIR!
const ASSISTANT = 990001, CHAT = 5001, OWNER = '777'
const log = (s: string) => appendFileSync(`${DIR}/fake.log`, `${new Date().toISOString()} ${s}\n`)
let nextId = 101
const rows: any[] = [{ message: { id: 100, chatId: CHAT, sender: 'assistant', text: 'hello', sentDate: new Date(Date.now() - 600_000).toISOString(), messageType: 'text' }, messageFiles: [] }]
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
Bun.serve({ port: 47812, async fetch(req) {
  const u = new URL(req.url); const p = u.pathname; let body = ''
  try { body = await req.text() } catch {}
  if (p === '/__add') {
    const b = JSON.parse(body)
    const row = { message: { id: nextId++, chatId: CHAT, sender: 'user', senderUserId: OWNER, text: b.text, sentDate: new Date().toISOString(), messageType: b.messageType ?? 'text', ...(b.commandName ? { commandName: b.commandName, commandArgs: b.commandArgs } : {}) }, messageFiles: [] }
    rows.push(row); log(`ADD ${JSON.stringify(row.message)}`); return json(row.message)
  }
  if (!p.startsWith('/socket.io')) log(`${req.method} ${p}${u.search} ${body.slice(0, 400)}`)
  if (p.endsWith('/peers/inbox')) return json({ chats: [{ id: CHAT, assistantId: ASSISTANT, kind: 'main' }] })
  if (p.endsWith(`/chats/${CHAT}/messages`)) {
    const after = Number(u.searchParams.get('afterId') ?? 0)
    return json({ messages: rows.filter((r) => r.message.id > after) })
  }
  if (p.endsWith('/commands') && req.method === 'PUT') { writeFileSync(`${DIR}/catalog.json`, body); return json({ ok: true }) }
  if (p.endsWith('/send-message')) {
    const b = JSON.parse(body || '{}'); const id = nextId++
    rows.push({ message: { id, chatId: CHAT, sender: 'assistant', text: b.text, sentDate: new Date().toISOString(), messageType: 'text' }, messageFiles: [] })
    log(`REPLY ${JSON.stringify(b.text)}`); return json({ id, messageId: id })
  }
  return json({})
} })
log('fake up')
