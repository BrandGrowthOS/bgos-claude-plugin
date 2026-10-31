#!/usr/bin/env node
/**
 * The rig's stub backend: just enough of the BGOS API for the real daemon to
 * boot, arm delivery, beat its heartbeat and read its wake schedule, on
 * 127.0.0.1 only, never anything real. Every request is appended to
 * <dir>/stub-requests.jsonl, so the rig reads its outcomes off what the
 * daemons actually sent (the version a heartbeat carries, its lastError).
 *
 * It serves a realtime socket (socket.io, the plugin's own dev dependency)
 * so each daemon runs WS-healthy as it does against the real backend: that is
 * what keeps its channel beacon fresh on every lock heartbeat. A message the
 * rig queues is pushed on that socket as inbound_message and is also in the
 * chat for the poll. It never sends a watcher_install_rpc or an update_rpc,
 * and it answers always-on false unless told otherwise.
 *
 * Control (rig only, same port): POST /__rig/inbound {assistantId, text}
 * queues a message from the owner; POST /__rig/schedule {assistantId, tasks}
 * sets that agent's active scheduled tasks; POST /__rig/voice {assistantId}
 * pushes one voice control frame (a stop_turn with no chat, which the daemon
 * answers unsupported and acts on nowhere) so the agent reads a call as live;
 * POST /__rig/fire {assistantId, taskId} posts the system card of a scheduled
 * task it still holds (or {assistantId, text}, a card with no task, 409 for a
 * task it does not hold), the way a real one lands: an empty row and no frame,
 * filled 2 s later, so only the poll delivers it; GET /__rig/ping.
 *
 * usage: node stub-backend.mjs --port <43000..48999> --dir <run dir> [--always-on]
 * (--always-on answers alwaysOn true: a launchd or systemd job the daemon would
 * otherwise uninstall after its 15 min grace stays installed for the proof.)
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Server as SocketServer } from 'socket.io'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const port = Number(flag('--port'))
const dir = flag('--dir')
const alwaysOn = args.includes('--always-on')
if (!Number.isInteger(port) || port < 43000 || port > 48999) {
  console.error('[stub] --port must be in 43000..48999')
  process.exit(2)
}
if (!dir) {
  console.error('[stub] --dir is required')
  process.exit(2)
}
const logPath = join(dir, 'stub-requests.jsonl')

/** assistantId -> chatId, assigned on first sight. */
const chats = new Map()
/** chatId -> messages */
const messages = new Map()
/** assistantId -> active scheduled tasks */
const schedules = new Map()
let nextMessageId = 1000

function chatFor(assistantId) {
  const key = String(assistantId)
  if (!chats.has(key)) chats.set(key, 9000 + chats.size + 1)
  return chats.get(key)
}

function callerOf(req) {
  const header = req.headers['x-caller-assistant-id']
  if (typeof header === 'string' && /^\d+$/.test(header)) return header
  const token = req.headers['x-bgos-pairing']
  const m = typeof token === 'string' ? /^rig-token-(\d+)$/.exec(token) : null
  return m ? m[1] : null
}

function record(entry) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = []
    req.on('data', (chunk) => parts.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8')
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({ unparsed: raw.slice(0, 2000) })
      }
    })
    req.on('error', () => resolve(null))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const body = method === 'GET' ? null : await readBody(req)
  const caller = callerOf(req)

  if (url.pathname.startsWith('/__rig/')) {
    const op = url.pathname.slice('/__rig/'.length)
    if (op === 'ping') return send(res, 200, { ok: true })
    // A person's message, or a scheduled wake's fire: the backend's system card, which owes no reply.
    if ((op === 'inbound' || op === 'fire') && body?.assistantId) {
      const task = body.taskId == null ? null : (schedules.get(String(body.assistantId)) ?? []).find((t) => t.id === body.taskId)
      if (body.taskId != null && !task) return send(res, 409, { error: 'no such task' })
      const sender = op === 'fire' ? 'system' : 'user'
      const text = task ? `rig: scheduled wake: ${task.name}` : String(body.text ?? 'hello')
      const chatId = chatFor(body.assistantId)
      const id = nextMessageId++
      const list = messages.get(chatId) ?? []
      const row = { message: { id, chatId, sender, text: op === 'fire' ? '' : text, sentDate: new Date().toISOString() }, messageFiles: [], messageOptions: [] }
      list.push(row)
      messages.set(chatId, list)
      record({ rig: op, assistantId: String(body.assistantId), chatId, id })
      // A real wake's card is an empty row with no frame, filled by a later update only the poll reads (server.ts isPendingEmptySystem).
      if (op === 'fire') {
        setTimeout(() => {
          row.message.text = text
        }, 2000)
        return send(res, 200, { ok: true, chatId, id })
      }
      realtime.to(`agent-${body.assistantId}`).emit('inbound_message', {
        messageId: id,
        chatId,
        text,
        senderType: sender,
        sentDate: new Date().toISOString(),
      })
      return send(res, 200, { ok: true, chatId, id })
    }
    if (op === 'voice' && body?.assistantId) {
      const rpcId = `rig-voice-${nextMessageId++}`
      realtime.to(`agent-${body.assistantId}`).emit('voice_rpc', { rpcId, op: 'stop_turn', assistantId: String(body.assistantId) })
      record({ rig: 'voice', assistantId: String(body.assistantId), rpcId })
      return send(res, 200, { ok: true, rpcId })
    }
    if (op === 'schedule' && body?.assistantId) {
      schedules.set(String(body.assistantId), Array.isArray(body.tasks) ? body.tasks : [])
      record({ rig: 'schedule', assistantId: String(body.assistantId), tasks: body.tasks })
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'unknown rig op' })
  }

  // Anything outside the API (socket.io is answered by its own listener).
  if (!url.pathname.startsWith('/api/v1/')) {
    record({ method, path: url.pathname, assistantId: caller, status: 404 })
    return send(res, 404, { error: 'not found' })
  }
  const path = url.pathname.slice('/api/v1/'.length)
  const entry = { method, path, query: url.search || undefined, assistantId: caller }
  if (path === 'integrations/heartbeat' || path === 'integrations/stand-downs' || path === 'messages') entry.body = body
  record(entry)

  if (method === 'GET' && path === 'integrations/capabilities') return send(res, 200, {})
  if (method === 'PUT' && /^integrations\/assistants\/\d+\/commands$/.test(path)) return send(res, 200, {})
  if (method === 'GET' && path === 'peers/inbox') {
    if (!caller) return send(res, 200, { chats: [] })
    return send(res, 200, { chats: [{ id: chatFor(caller), assistantId: Number(caller), kind: 'main' }] })
  }
  {
    const m = /^chats\/(\d+)\/messages$/.exec(path)
    if (method === 'GET' && m) return send(res, 200, { messages: messages.get(Number(m[1])) ?? [] })
  }
  if (method === 'GET' && path === 'integrations/me') {
    return send(res, 200, { assistants: caller ? [{ assistant_id: Number(caller), name: `Rig ${caller}` }] : [], owner_first_name: 'Rig' })
  }
  {
    const m = /^assistants\/(\d+)$/.exec(path)
    if (method === 'GET' && m) return send(res, 200, { id: Number(m[1]), code: 'claude-code', alwaysOn })
  }
  if (method === 'POST' && path === 'integrations/heartbeat') return send(res, 200, {})
  if (method === 'GET' && path === 'scheduled-tasks/agent') return send(res, 200, schedules.get(String(caller)) ?? [])
  if (method === 'POST' && path === 'integrations/stand-downs') return send(res, 200, {})
  if (method === 'POST' && path === 'messages') {
    const id = nextMessageId++
    const chatId = Number(body?.chatId ?? body?.chat_id ?? 0)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (chatId) {
      const list = messages.get(chatId) ?? []
      list.push({ message: { id, chatId, sender: 'assistant', text, sentDate: new Date().toISOString(), messageType: body?.messageType ?? null }, messageFiles: [], messageOptions: [] })
      messages.set(chatId, list)
    }
    return send(res, 200, { id, chatId, sender: 'assistant', text, sentDate: new Date().toISOString() })
  }
  // Everything else the daemon may touch (read receipts, typing, cards): accepted, recorded.
  return send(res, 200, {})
})

// One room per paired agent, named from the pairing token in the handshake.
const realtime = new SocketServer(server, { path: '/socket.io', transports: ['websocket'] })
realtime.on('connection', (socket) => {
  const token = socket.handshake.query?.pairingToken
  const m = typeof token === 'string' ? /^rig-token-(\d+)$/.exec(token) : null
  if (!m) {
    record({ ws: 'refused' })
    socket.disconnect(true)
    return
  }
  socket.join(`agent-${m[1]}`)
  record({ ws: 'connect', assistantId: m[1] })
  socket.on('disconnect', (reason) => record({ ws: 'disconnect', assistantId: m[1], reason }))
})

server.on('error', (err) => {
  console.error(`[stub] ${err.code ?? err.message}`)
  process.exit(err.code === 'EADDRINUSE' ? 98 : 1)
})
server.listen(port, '127.0.0.1', () => {
  writeFileSync(join(dir, 'stub-ready.json'), JSON.stringify({ port, pid: process.pid, at: new Date().toISOString() }))
  console.log(`[stub] listening on 127.0.0.1:${port} pid ${process.pid}`)
})
