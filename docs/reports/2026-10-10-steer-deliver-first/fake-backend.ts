// Local stand-in for the BGOS backend (steer ordering proof). Never production.
import { appendFileSync, writeFileSync } from 'node:fs'
const DIR = process.env.LIVE_DIR!
const PORT = Number(process.env.FAKE_PORT ?? 47813)
const ASSISTANT = 990001, CHAT = 5001, OWNER = '777'
const log = (s: string) => appendFileSync(`${DIR}/fake.log`, `${new Date().toISOString()} ${s}\n`)
let nextId = 101, nextFile = 1
const rows: any[] = [{ message: { id: 100, chatId: CHAT, sender: 'assistant', text: 'hello', sentDate: new Date(Date.now() - 600_000).toISOString(), messageType: 'text' }, messageFiles: [] }]
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
Bun.serve({ port: PORT, async fetch(req) {
  const u = new URL(req.url); const p = u.pathname; let body = ''
  try { body = await req.text() } catch {}
  if (p === '/__add') {
    const b = JSON.parse(body); const id = nextId++
    const files = (b.files ?? []).map((f: any) => ({ id: nextFile++, messageId: id, fileName: f.name, fileData: `http://127.0.0.1:${PORT}/files/${encodeURIComponent(f.name)}`, fileMimeType: f.mime ?? 'text/plain', isVideo: false, isImage: false, isDocument: true, isAudio: false }))
    const row = { message: { id, chatId: CHAT, sender: 'user', senderUserId: OWNER, text: b.text, sentDate: new Date().toISOString(), messageType: b.messageType ?? 'text', hasAttachment: files.length > 0, ...(b.commandName ? { commandName: b.commandName, commandArgs: b.commandArgs } : {}) }, messageFiles: files }
    rows.push(row); log(`ADD ${JSON.stringify(row.message)} files=${files.length}`); return json(row.message)
  }
  if (p.startsWith('/files/')) { log(`FILE ${p}`); return new Response('Quarterly report: revenue 120, costs 80.\n') }
  if (!p.startsWith('/socket.io')) log(`${req.method} ${p}${u.search} ${body.slice(0, 300)}`)
  if (p.endsWith('/peers/inbox')) return json({ chats: [{ id: CHAT, assistantId: ASSISTANT, kind: 'main' }] })
  if (p.endsWith(`/chats/${CHAT}/messages`) && req.method === 'GET') {
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
