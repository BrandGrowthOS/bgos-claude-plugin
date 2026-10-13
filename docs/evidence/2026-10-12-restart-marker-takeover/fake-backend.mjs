// fake-backend.mjs: a catch-all stand-in for the BGOS API on 127.0.0.1.
// Every request is appended to <log> as one JSON line. Never forwards anything.
// Usage: node fake-backend.mjs <log-file> <assistant-id>
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [logFile, assistantId = '909'] = process.argv.slice(2)
const note = (o) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`)

function answer(method, path) {
  const p = path.replace(/^\/api\/v1/, '').split('?')[0]
  if (method === 'GET' && p === `/assistants/${assistantId}`) {
    return [200, { id: Number(assistantId), name: 'Vera', code: 'claude-code', alwaysOn: true, userId: 'user_fake' }]
  }
  if (method === 'GET' && /\/chats?$|\/messages$|\/list$|s$/.test(p)) return [200, []]
  if (method === 'GET') return [200, {}]
  return [200, { ok: true }]
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    if (body.length < 2000) body += c
  })
  req.on('end', () => {
    const [status, json] = answer(req.method, req.url)
    note({ method: req.method, url: req.url, status, body: body.slice(0, 300) })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(json))
  })
})
server.on('upgrade', (req, socket) => {
  note({ method: 'UPGRADE', url: req.url })
  socket.destroy()
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
  note({ event: 'listening', port: server.address().port, pid: process.pid })
})
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
