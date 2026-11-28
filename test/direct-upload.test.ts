/**
 * Files up to 200 MB from an owner's paired agent, sent from disk a part at a
 * time (lib/direct-upload.ts, boards_attach in lib/boards-tools.ts, the reply
 * tool's files in server.ts).
 *
 * The backend lets a paired agent's credential upload up to 200 MB through a
 * direct upload session; an API key keeps the old limits. What this pins:
 *   - a 26 MB file is accepted (it was refused at 25 MB before);
 *   - a 201 MB file is refused from its size on disk, in one plain sentence,
 *     before anything is read or sent;
 *   - the upload streams: no PUT carries more than one part, the parts cover
 *     the file exactly and in order, and the file is never read whole;
 *   - a lapsed part URL is signed afresh, a session that fails is cancelled,
 *     and bytes only go to https.
 *
 * Fixtures are sparse files (truncate), so 200 MB costs no disk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, truncate, chmod, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleBoardsTool, BOARDS_TOOL_DECLS, type BoardsToolDeps } from '../lib/boards-tools.ts'
import {
  PAIRED_AGENT_UPLOAD_MAX_BYTES,
  chatUploadLimit,
  boardUploadLimit,
  readUploadSession,
  sendLocalChatFile,
  sendAndComplete,
  bytesSource,
  fileSource,
  tooLargeMessage,
  type DirectUploadDeps,
  type UploadSession,
} from '../lib/direct-upload.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MB = 1024 * 1024
const PART = 8 * MB
const SESSION = '0b0e6f1e-4c1a-4f7e-9d8a-1f2e3d4c5b6a'
const ATTACHMENT = '01933f7c-0000-7000-8000-000000000001'
const BASE = 'integrations/assistants/42/boards'

async function withSparse(size: number, fn: (path: string) => Promise<void>, name = 'big.bin'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'direct-upload-'))
  const path = join(dir, name)
  try {
    await writeFile(path, '')
    await truncate(path, size)
    await fn(path)
  } finally {
    await chmod(path, 0o600).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/** The session the backend answers for `size` bytes: one PUT to 16 MiB, 8 MiB parts above. */
function sessionFor(size: number): Record<string, unknown> {
  if (size <= 16 * MB) {
    return { sessionId: SESSION, mode: 'single', headers: { 'Content-Type': 'application/pdf' }, url: 'https://store.example/one?sig=1' }
  }
  const parts = []
  for (let n = 1, at = 0; at < size; n += 1, at += PART) {
    parts.push({ partNumber: n, size: Math.min(PART, size - at), url: `https://store.example/part/${n}?sig=1` })
  }
  return { sessionId: SESSION, mode: 'multipart', headers: { 'Content-Type': 'application/pdf' }, partSize: PART, partCount: parts.length, parts }
}

interface Recorded {
  method: string
  path: string
  body?: Record<string, unknown>
  length?: number
  headers?: Record<string, string>
}

function uploadsFake(opts: {
  put?: (url: string, bytes: Uint8Array) => Promise<void>
  post?: (path: string, body: Record<string, unknown>) => Promise<unknown>
  begin?: (body: Record<string, unknown>) => unknown
} = {}) {
  const calls: Recorded[] = []
  let biggestPut = 0
  const deps: DirectUploadDeps = {
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      if (opts.post) {
        const answer = await opts.post(path, body)
        if (answer !== undefined) return answer
      }
      if (path === 'uploads/sessions') return opts.begin ? opts.begin(body) : sessionFor(body.size as number)
      if (path.endsWith('/complete')) {
        return { key: 'uploads/owner/f.pdf', size: 0, file: { id: 'f1', key: 'uploads/owner/f.pdf', url: 'https://api.example/files/f.pdf' } }
      }
      return {}
    },
    del: async (path) => {
      calls.push({ method: 'DELETE', path })
      return {}
    },
    put: async (url, bytes, headers) => {
      calls.push({ method: 'PUT', path: url, length: bytes.length, headers })
      biggestPut = Math.max(biggestPut, bytes.length)
      if (opts.put) await opts.put(url, bytes)
    },
    sleep: async () => {},
  }
  return { calls, deps, biggestPut: () => biggestPut }
}

function boardDeps(uploads: DirectUploadDeps, opts: { attachAnswer?: (body: Record<string, unknown>) => unknown; maxAttachBytes?: number } = {}) {
  const calls: Recorded[] = []
  const deps: BoardsToolDeps = {
    assistantId: '42',
    bgosGet: async (path) => {
      calls.push({ method: 'GET', path })
      return {}
    },
    bgosPost: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/attachments')) {
        return opts.attachAnswer ? opts.attachAnswer(body) : { attachmentId: ATTACHMENT, upload: sessionFor(body.size as number) }
      }
      return { markdown: 'attached' }
    },
    bgosPatch: async (path, body) => {
      calls.push({ method: 'PATCH', path, body })
      return {}
    },
    putBytes: async (url, bytes) => {
      calls.push({ method: 'PUT', path: url, length: bytes.length })
    },
    uploads,
    ...(opts.maxAttachBytes ? { maxAttachBytes: opts.maxAttachBytes } : {}),
  }
  return { calls, deps }
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

// ── The caps ─────────────────────────────────────────────────────────────────

test('a paired agent may send 200 MB of every kind; an API key keeps the old caps', () => {
  assert.equal(PAIRED_AGENT_UPLOAD_MAX_BYTES, 200 * MB)
  for (const kind of ['image', 'video', 'audio', 'document']) {
    assert.equal(chatUploadLimit('pairing', kind), 200 * MB, kind)
  }
  assert.equal(chatUploadLimit('apiKey', 'document'), 25 * MB)
  assert.equal(chatUploadLimit('apiKey', 'video'), 100 * MB)
  assert.equal(boardUploadLimit('pairing'), 200 * MB)
  assert.equal(boardUploadLimit('apiKey'), 25 * MB)
})

test('the refusal is one plain sentence naming the size and the 200 MB limit', () => {
  assert.equal(
    tooLargeMessage('cut.mov', 201 * MB, 200 * MB),
    '"cut.mov" is 201 MB, over the 200 MB limit on a file you send. Send a smaller file or a link to it.',
  )
  // A file one byte over is not rounded down to look like the limit.
  assert.match(tooLargeMessage('a.bin', 200 * MB + 1, 200 * MB), /is 201 MB, over the 200 MB limit/)
})

// ── boards_attach ────────────────────────────────────────────────────────────

test('boards_attach accepts a 26 MB file and sends it in parts, then completes the session and the row', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake()
    const b = boardDeps(up.deps)
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.notEqual(r.isError, true, textOf(r))
    const meta = b.calls[0]!
    assert.equal(meta.path, `${BASE}/decisions/rows/3f9a2b7c/attachments`)
    assert.equal(meta.body!.size, 26 * MB)
    assert.equal(meta.body!.content_base64, undefined, 'a big file is never inlined')
    const puts = up.calls.filter((c) => c.method === 'PUT')
    assert.deepEqual(puts.map((c) => c.length), [PART, PART, PART, 2 * MB])
    assert.deepEqual(puts.map((c) => c.path), [1, 2, 3, 4].map((n) => `https://store.example/part/${n}?sig=1`))
    // A part URL signs only its length: no header of this daemon's rides along.
    for (const p of puts) assert.deepEqual(p.headers, {})
    assert.ok(up.calls.some((c) => c.method === 'POST' && c.path === `uploads/sessions/${SESSION}/complete`))
    const last = b.calls[b.calls.length - 1]!
    assert.equal(last.path, `${BASE}/decisions/attachments/${ATTACHMENT}/complete`)
    // The session completes before the row does, and nothing was cancelled.
    assert.ok(!up.calls.some((c) => c.method === 'DELETE'))
    // The legacy single PUT was not used.
    assert.ok(!b.calls.some((c) => c.method === 'PUT'))
  })
})

test('boards_attach refuses a 201 MB file from its size on disk, before reading it or calling anything', async () => {
  await withSparse(201 * MB, async (path) => {
    // Unreadable: a read before the size check would fail with EACCES instead.
    await chmod(path, 0o000)
    const up = uploadsFake()
    const b = boardDeps(up.deps)
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.equal(r.isError, true)
    assert.equal(textOf(r), '"big.bin" is 201 MB, over the 200 MB limit on a file you send. Send a smaller file or a link to it.')
    assert.equal(b.calls.length, 0)
    assert.equal(up.calls.length, 0)
  })
})

test('boards_attach sends exactly 200 MB, one 8 MiB part at a time, never the whole file', async () => {
  await withSparse(200 * MB, async (path) => {
    const up = uploadsFake()
    const b = boardDeps(up.deps)
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.notEqual(r.isError, true, textOf(r))
    const puts = up.calls.filter((c) => c.method === 'PUT')
    assert.equal(puts.length, 25)
    assert.equal(up.biggestPut(), PART, 'no PUT carries more than one part')
    assert.equal(puts.reduce((sum, c) => sum + c.length!, 0), 200 * MB)
  })
})

test('an API key credential keeps boards_attach at 25 MB', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake()
    const b = boardDeps(up.deps, { maxAttachBytes: 25 * MB })
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.equal(r.isError, true)
    assert.equal(textOf(r), '"big.bin" is 26 MB, over the 25 MB limit on a file you send. Send a smaller file or a link to it.')
    assert.equal(b.calls.length, 0)
  })
})

test('a board file at or under 25 MB still takes the single signed PUT the server answers', async () => {
  await withSparse(2 * MB, async (path) => {
    const up = uploadsFake()
    const b = boardDeps(up.deps, { attachAnswer: () => ({ attachmentId: ATTACHMENT, uploadUrl: 'https://store.example/one?sig=2' }) })
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.notEqual(r.isError, true, textOf(r))
    const put = b.calls.find((c) => c.method === 'PUT')!
    assert.equal(put.length, 2 * MB)
    assert.equal(up.calls.length, 0, 'no session for a single PUT')
    assert.equal(b.calls[b.calls.length - 1]!.path, `${BASE}/decisions/attachments/${ATTACHMENT}/complete`)
  })
})

test('a board part that cannot be sent cancels the session and completes nothing', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake({ put: async () => { throw Object.assign(new Error('the storage server answered 500'), { status: 500 }) } })
    const b = boardDeps(up.deps)
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.equal(r.isError, true)
    assert.ok(up.calls.some((c) => c.method === 'DELETE' && c.path === `uploads/sessions/${SESSION}`))
    assert.ok(!up.calls.some((c) => c.path.endsWith('/complete')))
    assert.ok(!b.calls.some((c) => c.path.endsWith('/complete')))
    assert.ok(!/https?:\/\//.test(textOf(r)), `a signed link reached the model: ${textOf(r)}`)
  })
})

test('a board part URL that is not https is refused before any bytes leave', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake()
    const b = boardDeps(up.deps, {
      attachAnswer: (body) => {
        const s = sessionFor(body.size as number) as { parts: Array<{ url: string }> }
        s.parts[1]!.url = 'http://store.example/part/2'
        return { attachmentId: ATTACHMENT, upload: s }
      },
    })
    const r = await handleBoardsTool('boards_attach', { board: 'decisions', row_key: '3f9a2b7c', file_path: path }, b.deps)
    assert.equal(r.isError, true)
    assert.match(textOf(r), /https/)
    assert.ok(!up.calls.some((c) => c.method === 'PUT'))
    assert.ok(up.calls.some((c) => c.method === 'DELETE'), 'the refused session is cancelled')
  })
})

test('content_base64 stays at 25 MB, since it is already whole in memory, and points at file_path', async () => {
  const up = uploadsFake()
  const b = boardDeps(up.deps)
  const r = await handleBoardsTool(
    'boards_attach',
    { board: 'decisions', row_key: '3f9a2b7c', name: 'huge.bin', content_base64: 'A'.repeat(36 * MB) },
    b.deps,
  )
  assert.equal(r.isError, true)
  assert.match(textOf(r), /25 MB/)
  assert.match(textOf(r), /file_path/)
  assert.match(textOf(r), /200 MB/)
  assert.equal(b.calls.length, 0)
})

test('the boards_attach description tells the agent a file can be up to 200 MB', () => {
  const attach = BOARDS_TOOL_DECLS.find((d) => d.name === 'boards_attach')!
  const words = JSON.stringify(attach)
  assert.match(words, /200 MB/)
})

// ── The streamed sender ──────────────────────────────────────────────────────

test('each part carries exactly its own bytes of the file, in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'direct-upload-order-'))
  try {
    const path = join(dir, 'pattern.bin')
    const size = 2 * PART + 12345
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 13)) & 0xff
    await writeFile(path, bytes)
    const received: Uint8Array[] = []
    const up = uploadsFake({ put: async (_url, b) => { received.push(Uint8Array.from(b)) } })
    const session = readUploadSession(sessionFor(size), size) as UploadSession
    await sendAndComplete(session, fileSource(path, size), up.deps)
    assert.deepEqual(received.map((r) => r.length), [PART, PART, 12345])
    const joined = Buffer.concat(received)
    assert.ok(joined.equals(Buffer.from(await readFile(path))), 'the parts do not rebuild the file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a lapsed part URL (403) is signed afresh and the part sent again', async () => {
  let first = true
  const up = uploadsFake({
    put: async (url) => {
      if (first && url.includes('/part/2')) {
        first = false
        throw Object.assign(new Error('the storage server answered 403'), { status: 403 })
      }
    },
    post: async (path) =>
      path.endsWith('/parts') ? { parts: [{ partNumber: 2, size: PART, url: 'https://store.example/part/2?sig=fresh' }] } : undefined,
  })
  const size = 3 * PART
  const session = readUploadSession(sessionFor(size), size) as UploadSession
  await sendAndComplete(session, bytesSource(new Uint8Array(size)), up.deps)
  const refresh = up.calls.find((c) => c.path === `uploads/sessions/${SESSION}/parts`)
  assert.deepEqual(refresh?.body, { partNumbers: [2] })
  const puts = up.calls.filter((c) => c.method === 'PUT').map((c) => c.path)
  assert.deepEqual(puts, [
    'https://store.example/part/1?sig=1',
    'https://store.example/part/2?sig=1',
    'https://store.example/part/2?sig=fresh',
    'https://store.example/part/3?sig=1',
  ])
})

test('complete is asked again while storage does not show every part yet', async () => {
  let asked = 0
  const up = uploadsFake({
    post: async (path) => {
      if (!path.endsWith('/complete')) return undefined
      asked += 1
      if (asked < 3) throw Object.assign(new Error('POST 409: {"code":"upload_incomplete"}'), { status: 409 })
      return { key: 'k', file: { key: 'k', url: 'https://api.example/f' } }
    },
  })
  const session = readUploadSession(sessionFor(PART + 1), PART + 1) as UploadSession
  await sendAndComplete(session, bytesSource(new Uint8Array(PART + 1)), up.deps)
  assert.equal(asked, 3)
})

test('a session whose parts do not cover the file is refused', () => {
  const s = sessionFor(26 * MB) as { parts: Array<{ size: number }> }
  s.parts[0]!.size -= 1
  assert.equal(typeof readUploadSession(s, 26 * MB), 'string')
  assert.equal(typeof readUploadSession({ ...sessionFor(1), url: 'http://x' }, 1), 'string')
})

// ── The reply tool's files ──────────────────────────────────────────────────

test('a 26 MB document is accepted for a chat reply and sent through an upload session', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake()
    const sent = await sendLocalChatFile(
      { path, fileName: 'report.pdf', mime: 'application/pdf', category: 'document' },
      { mode: 'pairing', inlineMaxBytes: 5 * MB },
      up.deps,
    )
    assert.equal(sent.s3Key, 'uploads/owner/f.pdf')
    assert.equal(sent.fileData, 'https://api.example/files/f.pdf')
    assert.deepEqual(up.calls[0], {
      method: 'POST',
      path: 'uploads/sessions',
      body: { fileName: 'report.pdf', contentType: 'application/pdf', size: 26 * MB },
    })
    assert.equal(up.biggestPut(), PART)
  }, 'report.pdf')
})

test('a 201 MB chat file is refused with the plain sentence before anything is read or sent', async () => {
  await withSparse(201 * MB, async (path) => {
    await chmod(path, 0o000)
    const up = uploadsFake()
    await assert.rejects(
      sendLocalChatFile(
        { path, fileName: 'cut.mov', mime: 'video/quicktime', category: 'video' },
        { mode: 'pairing', inlineMaxBytes: 5 * MB },
        up.deps,
      ),
      { message: '"cut.mov" is 201 MB, over the 200 MB limit on a file you send. Send a smaller file or a link to it.' },
    )
    assert.equal(up.calls.length, 0)
  }, 'cut.mov')
})

test('an API key reply keeps the old per kind caps', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake()
    await assert.rejects(
      sendLocalChatFile(
        { path, fileName: 'report.pdf', mime: 'application/pdf', category: 'document' },
        { mode: 'apiKey', inlineMaxBytes: 5 * MB },
        up.deps,
      ),
      /over the 25 MB limit/,
    )
    assert.equal(up.calls.length, 0)
  })
})

test('a small chat file still rides inline, with no session', async () => {
  await withSparse(1024, async (path) => {
    const up = uploadsFake()
    const sent = await sendLocalChatFile(
      { path, fileName: 'a.txt', mime: 'text/plain', category: 'document' },
      { mode: 'pairing', inlineMaxBytes: 5 * MB },
      up.deps,
    )
    assert.equal(sent.s3Key, null)
    assert.match(sent.fileData, /^data:text\/plain;base64,/)
    assert.equal(up.calls.length, 0)
  })
})

test('server.ts sends reply files through sendLocalChatFile, never reading a large file whole', () => {
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  const start = server.indexOf('async function resolveFile(')
  assert.ok(start > 0, 'resolveFile moved: re-point this guard')
  const body = server.slice(start, server.indexOf('\n}\n', start))
  assert.match(body, /sendLocalChatFile\(/)
  assert.doesNotMatch(body, /readFile\(/, 'resolveFile reads the file itself again')
  assert.doesNotMatch(server, /const SIZE_LIMITS\b/, 'the old per kind caps came back in server.ts')
  assert.doesNotMatch(body, /files\/upload-url/, 'reply files went back to the whole-file upload route')
})

test('the agent facing text says 200 MB', () => {
  const caps = readFileSync(join(repoRoot, 'lib', 'capabilities.ts'), 'utf8')
  assert.match(caps, /- Files: .*200 MB/)
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8')
  assert.match(server, /Supported documents: .*\(max 200 MB\)/)
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  assert.match(readme, /\| Document \| .* \| 200 MB \|/)
})

test('the part PUT is bounded by the shared upload deadline and never labels the signed URL', () => {
  const lib = readFileSync(join(repoRoot, 'lib', 'direct-upload.ts'), 'utf8')
  const body = lib.slice(lib.indexOf('export async function putToStorage('), lib.indexOf('const defaultSleep'))
  assert.ok(body.length > 0, 'putToStorage moved: re-point this guard')
  assert.match(body, /boundedFetch</)
  assert.match(body, /timeoutMs: UPLOAD_DEADLINE_MS/)
  assert.match(body, /label: `PUT upload part \(\$\{bytes\.length\} bytes\)`/)
  // No header of this daemon's: only the ones the caller passes (the signed Content-Type, or none for a part).
  assert.match(body, /headers: \{ \.\.\.headers \}/)
})

test('over real local HTTP, each part arrives with its exact Content-Length, never chunked', async () => {
  const { createServer } = await import('node:http')
  const { sendSessionBytes } = await import('../lib/direct-upload.ts')
  const seen: Array<{ url: string; length: string | undefined; chunked: boolean; received: number; contentType: string | undefined }> = []
  const server = createServer((req, res) => {
    let received = 0
    req.on('data', (chunk: Buffer) => { received += chunk.length })
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        length: req.headers['content-length'],
        chunked: /chunked/i.test(String(req.headers['transfer-encoding'] ?? '')),
        received,
        contentType: req.headers['content-type'],
      })
      res.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await withSparse(2 * PART + 4096, async (path) => {
      const size = 2 * PART + 4096
      // Built by hand: readUploadSession allows https only, and this receiver is plain local HTTP.
      const session: UploadSession = {
        sessionId: SESSION,
        mode: 'multipart',
        headers: { 'Content-Type': 'application/pdf' },
        parts: [
          { partNumber: 1, size: PART, url: `http://127.0.0.1:${port}/p1` },
          { partNumber: 2, size: PART, url: `http://127.0.0.1:${port}/p2` },
          { partNumber: 3, size: 4096, url: `http://127.0.0.1:${port}/p3` },
        ],
      }
      await sendSessionBytes(session, fileSource(path, size), { post: async () => ({}) })
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.deepEqual(seen.map((s) => s.url), ['/p1', '/p2', '/p3'])
  assert.deepEqual(seen.map((s) => s.length), [String(PART), String(PART), '4096'])
  assert.deepEqual(seen.map((s) => s.received), [PART, PART, 4096])
  assert.ok(seen.every((s) => !s.chunked), 'a part went chunked, which a signed storage URL refuses')
})

test('boards_download reads back a board file up to 200 MB (it stopped at 100 MB) and refuses 201 MB before fetching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'direct-upload-dl-'))
  try {
    const fetched: number[] = []
    const make = (size: number): BoardsToolDeps => ({
      assistantId: '42',
      bgosGet: async () => ({ url: 'https://store.example/get?sig=1', expiresInSeconds: 300, name: 'cut.mov', mime: 'video/quicktime', size }),
      bgosPost: async () => ({}),
      bgosPatch: async () => ({}),
      downloadDir: dir,
      getBytes: async (_url, max) => {
        fetched.push(max)
        // A short body: what matters here is the cap handed to the fetch, not the save.
        return { bytes: new Uint8Array(1) }
      },
    })
    await handleBoardsTool('boards_download', { board: 'decisions', attachment_id: ATTACHMENT }, make(150 * MB))
    assert.deepEqual(fetched, [150 * MB], 'a 150 MB board file is fetched, capped at its own size')
    const refused = await handleBoardsTool('boards_download', { board: 'decisions', attachment_id: ATTACHMENT }, make(201 * MB))
    assert.equal(refused.isError, true)
    assert.match(textOf(refused), new RegExp(`over the ${200 * MB} bytes this tool fetches`))
    assert.deepEqual(fetched, [150 * MB], 'nothing was fetched for 201 MB')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a chat upload failure never passes a signed URL on', async () => {
  await withSparse(26 * MB, async (path) => {
    const up = uploadsFake({
      put: async () => { throw new Error('connect ECONNRESET https://store.example/part/1?X-Amz-Signature=secret') },
    })
    await assert.rejects(
      sendLocalChatFile(
        { path, fileName: 'report.pdf', mime: 'application/pdf', category: 'document' },
        { mode: 'pairing', inlineMaxBytes: 5 * MB },
        up.deps,
      ),
      (err: Error) => !/https?:\/\/|Signature/.test(err.message) && /ECONNRESET the link/.test(err.message),
    )
    assert.ok(up.calls.some((c) => c.method === 'DELETE' && c.path === `uploads/sessions/${SESSION}`), 'the failed session is cancelled')
  })
})
