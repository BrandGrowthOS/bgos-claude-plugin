/**
 * Large files from an owner's paired agent, end to end against a real local
 * HTTP receiver (board row 01a15e84: a paired agent could not attach a deck
 * over 25 MB).
 *
 * test/direct-upload.test.ts pins the uploader with a fake PUT. This file
 * sends the bytes for real: every part goes through the daemon's own
 * putToStorage (boundedFetch, the shared upload deadline) to a loopback
 * receiver that hashes what arrives, so "sent" means the receiver got every
 * byte of the file, in order, with an exact Content-Length on each part.
 *
 *   - a 26 MB and a 200 MB file reach the receiver whole, from boards_attach
 *     and from a reply's files;
 *   - a file one byte over 200 MB is refused in the stated sentence, before
 *     anything is read or sent;
 *   - the agent facing text says 200 MB everywhere it names the limit.
 *
 * Fixtures are sparse files (truncate) with a few marker bytes written into
 * them, so 200 MB costs no disk and a part sent out of order changes the hash.
 *
 * lib/direct-upload.ts is imported inside each test, so this file loads on a
 * checkout without it and each test fails on its own assertion there.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleBoardsTool, BOARDS_TOOL_DECLS, type BoardsToolDeps } from '../lib/boards-tools.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MB = 1024 * 1024
const PART = 8 * MB
const SESSION = '0b0e6f1e-4c1a-4f7e-9d8a-1f2e3d4c5b6a'
const ATTACHMENT = '01933f7c-0000-7000-8000-000000000001'
const BASE = 'integrations/assistants/42/boards'
const STORE = 'https://store.example'
const REFUSAL = (name: string, mb: number) =>
  `"${name}" is ${mb} MB, over the 200 MB limit on a file you send. Send a smaller file or a link to it.`

type DirectUpload = typeof import('../lib/direct-upload.ts')

async function directUpload(): Promise<DirectUpload> {
  try {
    return await import('../lib/direct-upload.ts')
  } catch (err) {
    assert.fail(`lib/direct-upload.ts is missing: no streamed uploader to send a large file (${(err as Error).message})`)
  }
}

/** A sparse file of `size` bytes with marker bytes near the start of every part and at the very end. */
async function withMarkedSparse(size: number, name: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'large-file-'))
  const path = join(dir, name)
  try {
    await writeFile(path, '')
    await truncate(path, size)
    const handle = await open(path, 'r+')
    try {
      for (let at = 0, n = 1; at < size; at += PART, n += 1) {
        await handle.write(Buffer.from(`part ${n} of ${name}`), 0, undefined, at + 17)
      }
      await handle.write(Buffer.from('END'), 0, 3, size - 3)
    } finally {
      await handle.close()
    }
    await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

interface Arrival {
  path: string
  contentLength: string | undefined
  chunked: boolean
  received: number
}

/** A loopback storage receiver: hashes every PUT body in the order it arrives. */
async function withReceiver(fn: (r: { port: number; arrivals: Arrival[]; digest: () => string }) => Promise<void>): Promise<void> {
  const arrivals: Arrival[] = []
  const hash = createHash('sha256')
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
    })
    req.on('end', () => {
      arrivals.push({
        path: req.url ?? '',
        contentLength: req.headers['content-length'],
        chunked: /chunked/i.test(String(req.headers['transfer-encoding'] ?? '')),
        received,
      })
      res.writeHead(req.method === 'PUT' ? 200 : 405).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await fn({ port, arrivals, digest: () => hash.digest('hex') })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The session the backend answers for `size` bytes: one PUT to 16 MiB, 8 MiB parts above. */
function sessionFor(size: number): Record<string, unknown> {
  if (size <= 16 * MB) {
    return { sessionId: SESSION, mode: 'single', headers: { 'Content-Type': 'application/pdf' }, url: `${STORE}/one?sig=1` }
  }
  const parts = []
  for (let n = 1, at = 0; at < size; n += 1, at += PART) {
    parts.push({ partNumber: n, size: Math.min(PART, size - at), url: `${STORE}/part/${n}?sig=1` })
  }
  return { sessionId: SESSION, mode: 'multipart', headers: { 'Content-Type': 'application/pdf' }, partSize: PART, partCount: parts.length, parts }
}

/**
 * The upload calls: the session answers come from a stand in for the backend,
 * and every PUT goes for real through putToStorage to the loopback receiver.
 * The signed URLs stay https (the uploader refuses anything else); only the
 * host they name is pointed at the receiver here.
 */
function uploadDeps(du: DirectUpload | null, port: number) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const deletes: string[] = []
  let biggestPut = 0
  const deps = {
    post: async (path: string, body: Record<string, unknown>) => {
      posts.push({ path, body })
      if (path === 'uploads/sessions') return sessionFor(body.size as number)
      if (path.endsWith('/complete')) {
        return { key: 'uploads/owner/deck.pptx', size: 0, file: { id: 'f1', key: 'uploads/owner/deck.pptx', url: 'https://api.example/files/deck.pptx' } }
      }
      return {}
    },
    del: async (path: string) => {
      deletes.push(path)
      return {}
    },
    put: async (url: string, bytes: Uint8Array, headers: Record<string, string>) => {
      assert.ok(url.startsWith(`${STORE}/`), `a PUT went somewhere the session did not name: ${url}`)
      biggestPut = Math.max(biggestPut, bytes.length)
      const local = `http://127.0.0.1:${port}${url.slice(STORE.length)}`
      if (du) return du.putToStorage(local, bytes, headers)
      const res = await fetch(local, { method: 'PUT', headers, body: bytes as unknown as BodyInit })
      if (!res.ok) throw new Error(`receiver answered ${res.status}`)
    },
    sleep: async () => {},
  }
  return { deps, posts, deletes, biggestPut: () => biggestPut }
}

function boardDeps(uploads: unknown) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const deps: BoardsToolDeps = {
    assistantId: '42',
    bgosGet: async (path) => {
      calls.push({ method: 'GET', path })
      return {}
    },
    bgosPost: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/attachments')) return { attachmentId: ATTACHMENT, upload: sessionFor(body.size as number) }
      return { markdown: 'attached' }
    },
    bgosPatch: async (path, body) => {
      calls.push({ method: 'PATCH', path, body })
      return {}
    },
    putBytes: async () => {
      throw new Error('the whole-file PUT was used for a file sent in parts')
    },
    ...({ uploads } as Partial<BoardsToolDeps>),
  }
  return { calls, deps }
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

function expectedParts(size: number): number[] {
  const lengths: number[] = []
  for (let at = 0; at < size; at += PART) lengths.push(Math.min(PART, size - at))
  return lengths
}

// ── boards_attach: a deck over 25 MB reaches storage ─────────────────────────

for (const sizeMb of [26, 200]) {
  test(`boards_attach sends a ${sizeMb} MB deck whole to a real local receiver, one part at a time`, { timeout: 120_000 }, async () => {
    const du = await import('../lib/direct-upload.ts').catch(() => null)
    const size = sizeMb * MB
    await withMarkedSparse(size, 'deck.pptx', async (path) => {
      const want = await sha256OfFile(path)
      await withReceiver(async (rx) => {
        const up = uploadDeps(du, rx.port)
        const b = boardDeps(up.deps)
        const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
        assert.notEqual(r.isError, true, textOf(r))
        const lengths = expectedParts(size)
        assert.deepEqual(rx.arrivals.map((a) => a.path), lengths.map((_, i) => `/part/${i + 1}?sig=1`))
        assert.deepEqual(rx.arrivals.map((a) => a.received), lengths)
        assert.deepEqual(rx.arrivals.map((a) => a.contentLength), lengths.map(String))
        assert.ok(rx.arrivals.every((a) => !a.chunked), 'a part went chunked, which a signed storage URL refuses')
        assert.equal(rx.digest(), want, 'the receiver did not get the file byte for byte, in order')
        assert.equal(up.biggestPut(), PART, 'no PUT carries more than one part')
        assert.ok(up.posts.some((p) => p.path === `uploads/sessions/${SESSION}/complete`), 'the session was not completed')
        assert.deepEqual(up.deletes, [], 'a session that worked was cancelled')
        const last = b.calls[b.calls.length - 1]!
        assert.equal(last.path, `${BASE}/decisions/attachments/${ATTACHMENT}/complete`, 'the row was not completed last')
      })
    })
  })
}

test('boards_attach refuses a file one byte over 200 MB in the stated sentence, sending nothing', async () => {
  await withMarkedSparse(200 * MB + 1, 'deck.pptx', async (path) => {
    await withReceiver(async (rx) => {
      const up = uploadDeps(null, rx.port)
      const b = boardDeps(up.deps)
      const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
      assert.equal(r.isError, true)
      assert.equal(textOf(r), REFUSAL('deck.pptx', 201))
      assert.deepEqual(b.calls, [])
      assert.deepEqual(up.posts, [])
      assert.deepEqual(rx.arrivals, [])
    })
  })
})

// ── A reply's files: the same streamed path ──────────────────────────────────

for (const sizeMb of [26, 200]) {
  test(`a reply sends a ${sizeMb} MB file whole to a real local receiver through an upload session`, { timeout: 120_000 }, async () => {
    const du = await directUpload()
    const size = sizeMb * MB
    await withMarkedSparse(size, 'cut.mov', async (path) => {
      const want = await sha256OfFile(path)
      await withReceiver(async (rx) => {
        const up = uploadDeps(du, rx.port)
        const sent = await du.sendLocalChatFile(
          { path, fileName: 'cut.mov', mime: 'video/quicktime', category: 'video' },
          { mode: 'pairing', inlineMaxBytes: 5 * MB },
          up.deps,
        )
        assert.equal(sent.fileData, 'https://api.example/files/deck.pptx')
        assert.equal(sent.s3Key, 'uploads/owner/deck.pptx')
        const begin = up.posts.find((p) => p.path === 'uploads/sessions')
        assert.equal(begin?.body.size, size)
        const lengths = expectedParts(size)
        assert.deepEqual(rx.arrivals.map((a) => a.received), lengths)
        assert.deepEqual(rx.arrivals.map((a) => a.contentLength), lengths.map(String))
        assert.equal(rx.digest(), want, 'the receiver did not get the file byte for byte, in order')
        assert.equal(up.biggestPut(), PART, 'no PUT carries more than one part')
      })
    })
  })
}

test('a reply refuses a file one byte over 200 MB in the stated sentence, before reading or sending it', async () => {
  const du = await directUpload()
  await withMarkedSparse(200 * MB + 1, 'cut.mov', async (path) => {
    await withReceiver(async (rx) => {
      const up = uploadDeps(du, rx.port)
      await assert.rejects(
        du.sendLocalChatFile(
          { path, fileName: 'cut.mov', mime: 'video/quicktime', category: 'video' },
          { mode: 'pairing', inlineMaxBytes: 5 * MB },
          up.deps,
        ),
        (err: Error) => err.message === REFUSAL('cut.mov', 201),
      )
      assert.deepEqual(up.posts, [])
      assert.deepEqual(rx.arrivals, [])
    })
  })
})

// ── The agent facing text says 200 MB ────────────────────────────────────────

test('the agent facing text says 200 MB everywhere it names the limit', () => {
  const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8')

  // The bundled capabilities fallback.
  const caps = read('lib', 'capabilities.ts')
  const filesLine = caps.split('\n').find((l) => l.startsWith('- Files:'))
  assert.ok(filesLine, 'the capabilities fallback lost its Files line')
  assert.match(filesLine!, /up to 200 MB/)
  assert.doesNotMatch(filesLine!, /\b(10|20|25|100) MB\b/, 'the capabilities fallback still names an old cap')

  // The reply instructions: every kind the reply tool sends, audio included.
  const server = read('server.ts')
  for (const kind of ['images', 'videos', 'audio', 'documents']) {
    const line = server.split('\n').find((l) => l.includes(`'- Supported ${kind}:`))
    assert.ok(line, `the reply instructions do not name supported ${kind}`)
    assert.match(line!, /\(max 200 MB\)/, `the reply instructions' ${kind} line`)
  }

  // The README table, one row per kind.
  const readme = read('README.md')
  for (const kind of ['Image', 'Video', 'Audio', 'Document']) {
    assert.match(readme, new RegExp(`^\\| ${kind} \\| .* \\| 200 MB \\|$`, 'm'), `README ${kind} row`)
  }

  // The tools: boards_attach's description and file_path, boards_download's fetch cap.
  const attach = BOARDS_TOOL_DECLS.find((d) => d.name === 'boards_attach') as unknown as {
    description: string
    inputSchema: { properties: { file_path: { description: string } } }
  }
  assert.match(attach.description, /up to 200 MB/)
  assert.match(attach.inputSchema.properties.file_path.description, /up to 200 MB/)
  assert.match(read('lib', 'boards-tools.ts'), /const MAX_DOWNLOAD_BYTES = PAIRED_AGENT_UPLOAD_MAX_BYTES\b/)

  // The bounded fetch's upload deadline is documented for 200 MB in parts.
  const deadline = read('lib', 'bounded-fetch.ts')
  const doc = deadline.slice(deadline.lastIndexOf('/**', deadline.indexOf('export const UPLOAD_DEADLINE_MS')), deadline.indexOf('export const UPLOAD_DEADLINE_MS'))
  assert.match(doc, /up to 200 MB in 8 MiB parts/)
  assert.doesNotMatch(doc, /up to 100 MB for video/, 'the upload deadline still documents the old 100 MB video cap')
})
