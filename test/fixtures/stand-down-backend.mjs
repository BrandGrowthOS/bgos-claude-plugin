// A fake HOAI backend in a process of its own, for the stand-down tests.
//
// The exit sites send their report while the daemon blocks (lib/stand-down-
// report.ts reportSync), which blocks the test's event loop too, so a fake
// backend inside the test process could never answer. This one runs beside it.
//
//   node stand-down-backend.mjs <mode> [location]
//     mode: validate (answers 204), hang (never answers the report), or a
//           status code; a 3xx carries `Location: <location>`
//   It prints its port on stdout, answers GET /captured with every request it
//   received (headers and parsed body), and exits when its stdin closes.
import { createServer } from 'node:http'

const mode = process.argv[2] ?? 'validate'
const location = process.argv[3] ?? '/elsewhere'
const requests = []
const server = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/captured') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(requests))
    }
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {}
    requests.push({ method: req.method, path: req.url, headers: req.headers, body })
    if (mode === 'hang') return
    if (/^\d{3}$/.test(mode)) {
      res.writeHead(Number(mode), mode.startsWith('3') ? { Location: location } : {})
      return res.end()
    }
    res.writeHead(204)
    res.end()
  })
})
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`))
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
