/**
 * A stand in for the public marketplace manifest, for the tests that run a REAL installer (bin/bgos-agent,
 * bin/hoai-bootstrap.sh) as a child process: they reach it through HOAI_PUBLISHED_MANIFEST_URL.
 *
 * It is its own process, so a test that blocks on spawnSync still gets an answer. Every request reads the
 * body file afresh, so a test changes what is published by rewriting it (`publish`), and `fail` makes the
 * next answers an HTTP 500. `offlineUrl` is a port nothing listens on: the marketplace cannot be reached.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { marketplaceManifest } from './release-origin.ts'

const SERVER = `
const http = require('http')
const fs = require('fs')
const file = process.argv[1]
const server = http.createServer((req, res) => {
  let body = ''
  try { body = fs.readFileSync(file, 'utf8') } catch {}
  if (body.startsWith('STATUS ')) { res.writeHead(Number(body.slice(7)) || 500); res.end('no'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
})
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'))
`

export interface ManifestServer {
  url: string
  /** Publish `ref` (a release tag) as the marketplace does. */
  publish(ref: string): void
  /** Answer with the raw `body`, whatever it is. */
  raw(body: string): void
  /** Answer HTTP `status` with no manifest. */
  fail(status?: number): void
  stop(): void
}

export async function startManifestServer(ref: string): Promise<ManifestServer> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'manifest-server-')))
  const file = join(dir, 'marketplace.json')
  writeFileSync(file, marketplaceManifest(ref))
  const child: ChildProcess = spawn(process.execPath, ['-e', SERVER, file], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (chunk) => {
      out += String(chunk)
      const line = out.split('\n')[0]
      if (out.includes('\n')) resolve(Number(line))
    })
    child.once('exit', (code) => reject(new Error(`the manifest server exited (${code})`)))
  })
  return {
    url: `http://127.0.0.1:${port}/.claude-plugin/marketplace.json`,
    publish: (next) => writeFileSync(file, marketplaceManifest(next)),
    raw: (body) => writeFileSync(file, body),
    fail: (status = 500) => writeFileSync(file, `STATUS ${status}`),
    stop: () => {
      child.kill()
    },
  }
}

/** A URL on a port that was free a moment ago and has nothing listening: the marketplace is unreachable. */
export async function offlineUrl(): Promise<string> {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => resolve(p))
    })
  })
  return `http://127.0.0.1:${port}/.claude-plugin/marketplace.json`
}
