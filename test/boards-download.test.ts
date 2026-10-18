/**
 * boards_download: an agent granted a board fetches a file on one of its rows
 * (HOAI board rows 01a14840-19e0, 01a14840-27c2).
 *
 * THE BUG. KC, 2026-10-17: "agents who have access to a board should be able
 * to download the attachments; now it is not the case." boards_get_row printed
 * every file's name and full id, the boards_attach description promised "every
 * agent granted that row can fetch it later", and the backend's agent route
 * that mints the download link (GET .../attachments/:id/url) worked for every
 * grant. No tool in this plugin called it, so the twelve tools could put a file
 * on a row and never take one off. Vexa, 2026-10-16: "its tools do not let me
 * download attachments."
 *
 * What this pins:
 *  - the tool exists, takes the board and the attachment id boards_get_row
 *    prints, and nothing else;
 *  - it mints the link through the agent family with the daemon's own
 *    transports (so the server's grant check decides, and its denial body
 *    reaches the model verbatim), then fetches the bytes and saves them under
 *    the file's own name, inside the folder it was given and nowhere else;
 *  - the signed link is a bearer credential: it is fetched over https only,
 *    with no BGOS header, no redirect, never echoed to the model;
 *  - a body that is not exactly the file's size is not saved, and leaves
 *    nothing behind;
 *  - a recipient's file and the owner's land in different folders.
 *
 * Run with:  npx tsx --test test/boards-download.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { DECLARED_CAPABILITIES_BASE } from '../lib/declared-capabilities.ts'

import {
  BOARD_FILE_KEEP_MS,
  BOARDS_TOOL_DECLS,
  boardFileSaveName,
  boardFilesFolder,
  createBoardsDownloader,
  handleBoardsTool,
  sweepBoardFiles,
  sweepBoardFilesOf,
  type BoardsToolDeps,
} from '../lib/boards-tools.ts'

const ATT = '01a1484b-1b5c-729a-99d0-cd5431550be9'
const BYTES = Buffer.from('\x89PNG\r\n\x1a\nthe creative itself')
const SIGNED = 'https://bucket.s3.amazonaws.com/boards/u/b/r/hero.png?X-Amz-Signature=deadbeef'

interface Seen {
  gets: string[]
  fetched: Array<{ url: string; max: number }>
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'boards-dl-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function deps(
  dir: string | undefined,
  opts: {
    minted?: unknown
    mintError?: Error
    body?: Uint8Array
    fetchError?: Error
  } = {},
): { deps: BoardsToolDeps; seen: Seen } {
  const seen: Seen = { gets: [], fetched: [] }
  const d: BoardsToolDeps = {
    assistantId: '42',
    bgosGet: async (path) => {
      seen.gets.push(path)
      if (opts.mintError) throw opts.mintError
      return opts.minted ?? {
        url: SIGNED,
        expiresInSeconds: 300,
        name: 'hero-ar.png',
        mime: 'image/png',
        size: BYTES.length,
      }
    },
    bgosPost: async () => ({}),
    bgosPatch: async () => ({}),
    downloadDir: dir,
    getBytes: async (url, max) => {
      seen.fetched.push({ url, max })
      if (opts.fetchError) throw opts.fetchError
      return { bytes: opts.body ?? BYTES }
    },
  }
  return { deps: d, seen }
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n')

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(p.slice(dir.length + 1))
    }
  }
  try {
    await walk(dir)
  } catch {
    /* no folder, no files */
  }
  return out.sort()
}

// ── The declaration ──────────────────────────────────────────────────────────

test('boards_download is declared right after boards_attach, closed, with board and attachment_id required', () => {
  const names = BOARDS_TOOL_DECLS.map((d) => d.name)
  assert.equal(names.indexOf('boards_download'), names.indexOf('boards_attach') + 1)
  const d = BOARDS_TOOL_DECLS.find((x) => x.name === 'boards_download')!
  const schema = d.inputSchema as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> }
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['board', 'attachment_id'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['attachment_id', 'board', 'response_format'])
  assert.match(d.description, /boards_get_row/)
  assert.match(d.description, /Read/)
})

test('boards_attach and boards_get_row point at the fetch', () => {
  const attach = BOARDS_TOOL_DECLS.find((x) => x.name === 'boards_attach')!
  const getRow = BOARDS_TOOL_DECLS.find((x) => x.name === 'boards_get_row')!
  assert.match(attach.description, /boards_download/)
  assert.match(getRow.description, /boards_download/)
})

// ── The happy path ───────────────────────────────────────────────────────────

test('mints through the agent route, fetches, and saves the bytes under the file name', async () => {
  await withDir(async (dir) => {
    const { deps: d, seen } = deps(dir)
    const r = await handleBoardsTool('boards_download', { board: 'Creatives & Ads', attachment_id: ATT }, d)
    assert.equal(r.isError, undefined, text(r))
    assert.deepEqual(seen.gets, [
      `integrations/assistants/42/boards/${encodeURIComponent('Creatives & Ads')}/attachments/${ATT}/url`,
    ])
    assert.deepEqual(seen.fetched, [{ url: SIGNED, max: BYTES.length }])
    const saved = join(dir, ATT, 'hero-ar.png')
    assert.deepEqual(await readFile(saved), BYTES)
    const out = text(r)
    assert.ok(out.includes(saved), out)
    assert.match(out, new RegExp(`${BYTES.length} bytes`))
    assert.match(out, /image\/png/)
    // The signed link is a credential and never reaches the model.
    assert.ok(!out.includes('X-Amz-Signature'), out)
    assert.ok(!out.includes('s3.amazonaws.com'), out)
  })
})

test('json answers the path and the file facts, still without the link', async () => {
  await withDir(async (dir) => {
    const { deps: d } = deps(dir)
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT, response_format: 'json' }, d)
    const body = JSON.parse(text(r))
    assert.deepEqual(body, {
      attachmentId: ATT,
      name: 'hero-ar.png',
      mime: 'image/png',
      size: BYTES.length,
      path: join(dir, ATT, 'hero-ar.png'),
      // The warning rides the json too (second review round).
      note: 'This copy is deleted after an hour, and until then any turn on this machine can read it, so never open or show it while answering anyone but the person you fetched it for.',
    })
  })
})

test('a server that sends no type or name still saves a named file with a guessed type', async () => {
  await withDir(async (dir) => {
    for (const [minted, name, mime] of [
      [{ url: SIGNED, name: 'notes.txt', size: BYTES.length }, 'notes.txt', 'text/plain'],
      [{ url: SIGNED, name: 'blob', size: BYTES.length }, 'blob', 'application/octet-stream'],
      [{ url: SIGNED, size: BYTES.length }, `attachment-${ATT}`, 'application/octet-stream'],
    ] as const) {
      const { deps: d } = deps(dir, { minted })
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT, response_format: 'json' }, d)
      assert.equal(r.isError, undefined, text(r))
      const body = JSON.parse(text(r))
      assert.equal(body.name, name)
      assert.equal(body.mime, mime)
      assert.deepEqual(await readFile(body.path), BYTES)
    }
  })
})

test('a second download of the same file replaces it in place', async () => {
  await withDir(async (dir) => {
    await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    assert.deepEqual(await filesUnder(dir), [`${ATT}${sep}hero-ar.png`])
  })
})

test('the saved file and its folder are private to this user', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    assert.equal((await stat(join(dir, ATT, 'hero-ar.png'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(dir, ATT))).mode & 0o777, 0o700)
  })
})

// ── Refusals before anything is fetched ──────────────────────────────────────

test('a server denial reaches the model verbatim and nothing is fetched', async () => {
  await withDir(async (dir) => {
    const body = '{"error":"not_found","message":"No board matches this request."}'
    const { deps: d, seen } = deps(dir, { mintError: new Error(`GET 404: ${body}`) })
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
    assert.equal(r.isError, true)
    assert.equal(text(r), body)
    assert.deepEqual(seen.fetched, [])
    assert.deepEqual(await filesUnder(dir), [])
  })
})

test('the attachment id must be a full uuid: a short key, a path or junk never reaches the network', async () => {
  await withDir(async (dir) => {
    for (const bad of ['cd5431550be9', '../../etc/passwd', `${ATT}/../x`, `${ATT}?x=1`, '', 42]) {
      const { deps: d, seen } = deps(dir)
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: bad }, d)
      assert.equal(r.isError, true, `accepted ${String(bad)}`)
      assert.deepEqual(seen.gets, [], `reached the network for ${String(bad)}`)
    }
  })
})

test('a connection with no folder to save into refuses before minting anything', async () => {
  const { deps: d, seen } = deps(undefined)
  const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
  assert.equal(r.isError, true)
  assert.match(text(r), /nothing was fetched/i)
  assert.deepEqual(seen.gets, [])
})

test('a link that is not https is never fetched', async () => {
  await withDir(async (dir) => {
    for (const url of ['http://bucket.s3.amazonaws.com/x?sig=1', 'file:///etc/passwd', 'not a url', '']) {
      const { deps: d, seen } = deps(dir, {
        minted: { url, expiresInSeconds: 300, name: 'x.png', mime: 'image/png', size: 3 },
      })
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
      assert.equal(r.isError, true, `fetched ${url}`)
      assert.deepEqual(seen.fetched, [], `fetched ${url}`)
      assert.ok(!text(r).includes('sig=1'), 'the link is not echoed')
    }
    assert.deepEqual(await filesUnder(dir), [])
  })
})

test('a file bigger than the ceiling is refused before it is fetched', async () => {
  await withDir(async (dir) => {
    const { deps: d, seen } = deps(dir, {
      minted: { url: SIGNED, expiresInSeconds: 300, name: 'huge.mov', mime: 'video/quicktime', size: 101 * 1024 * 1024 },
    })
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
    assert.equal(r.isError, true)
    assert.deepEqual(seen.fetched, [])
  })
})

// ── What arrives is checked before it is kept ────────────────────────────────

test('a body longer or shorter than the file is not saved, and leaves no partial file', async () => {
  await withDir(async (dir) => {
    for (const body of [Buffer.concat([BYTES, Buffer.from('more')]), BYTES.subarray(0, 4), Buffer.alloc(0)]) {
      const { deps: d } = deps(dir, { body })
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
      assert.equal(r.isError, true, `kept ${body.length} bytes`)
      assert.match(text(r), /Nothing was saved/)
    }
    assert.deepEqual(await filesUnder(dir), [])
  })
})

test('a failed fetch is reported without the link and saves nothing', async () => {
  await withDir(async (dir) => {
    const { deps: d } = deps(dir, { fetchError: new Error(`GET 403 for ${SIGNED}`) })
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, d)
    assert.equal(r.isError, true)
    assert.ok(!text(r).includes('X-Amz-Signature'), text(r))
    assert.deepEqual(await filesUnder(dir), [])
  })
})

// ── The name the owner gave the file never picks the folder ─────────────────

test('a hostile file name is saved inside this file\'s own folder, as a plain name', async () => {
  const hostile = ['../../../.bashrc', '..', '.', 'a/b\\c.txt', 'con.txt', '', '‮gnp.exe', 'x'.repeat(400) + '.pdf']
  await withDir(async (dir) => {
    for (const name of hostile) {
      const { deps: d } = deps(dir, {
        minted: { url: SIGNED, expiresInSeconds: 300, name, mime: 'application/octet-stream', size: BYTES.length },
      })
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT, response_format: 'json' }, d)
      assert.equal(r.isError, undefined, `${JSON.stringify(name)}: ${text(r)}`)
      const saved = JSON.parse(text(r)).path as string
      assert.equal(saved.startsWith(join(dir, ATT) + sep), true, `${JSON.stringify(name)} escaped to ${saved}`)
      assert.equal(saved.slice(join(dir, ATT).length + 1).includes(sep), false, `${JSON.stringify(name)} made a folder`)
      assert.deepEqual(await readFile(saved), BYTES)
    }
  })
})

// ── The default fetch ────────────────────────────────────────────────────────

test('the default fetch sends no BGOS credential, follows no redirect, and stops at the size it was given', async () => {
  const seen: Array<{ url: string; init: Record<string, unknown> }> = []
  const respond = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(body)
        c.close()
      },
    }),
    text: async () => '',
  })
  const get = createBoardsDownloader({
    fetchImpl: async (url: string, init: Record<string, unknown>) => {
      seen.push({ url, init })
      return respond(BYTES, { 'content-length': String(BYTES.length) }) as never
    },
  })
  const got = await get(SIGNED, BYTES.length)
  assert.deepEqual(Buffer.from(got.bytes), BYTES)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.init.method, 'GET')
  assert.equal(seen[0]!.init.redirect, 'error')
  const headers = (seen[0]!.init.headers ?? {}) as Record<string, string>
  for (const key of Object.keys(headers)) {
    assert.doesNotMatch(key, /^(x-bgos|x-api-key|authorization|cookie)/i, `sent ${key}`)
  }

  // A declared length over the limit is refused before the body is read.
  const tooLong = createBoardsDownloader({
    fetchImpl: async () => respond(BYTES, { 'content-length': '999999' }) as never,
  })
  await assert.rejects(tooLong(SIGNED, BYTES.length), /larger than/)

  // A body that runs past the limit with no declared length is cut off.
  const streamed = createBoardsDownloader({ fetchImpl: async () => respond(BYTES) as never })
  await assert.rejects(streamed(SIGNED, 4), /larger than/)

  // A refusal names the status and never the link.
  const refused = createBoardsDownloader({
    fetchImpl: async () => respond(Buffer.alloc(0), {}, 403) as never,
  })
  await assert.rejects(refused(SIGNED, 10), (err: Error) => /403/.test(err.message) && !err.message.includes('X-Amz'))
})

// ── One folder per person ────────────────────────────────────────────────────

test('the owner and each person the agent is shared with get their own folder', () => {
  const root = join(tmpdir(), 'agent', '.hoai', 'board-files')
  const owner = 'user_owner'
  assert.equal(boardFilesFolder(root, owner, owner), join(root, 'owner'))
  const a = boardFilesFolder(root, 'user_ALICE', owner)
  const b = boardFilesFolder(root, 'user_BOB', owner)
  const digest = createHash('sha256').update('user_ALICE').digest('hex').slice(0, 16)
  assert.equal(a, join(root, `person-${digest}`))
  assert.notEqual(a, b)
  assert.notEqual(a, join(root, 'owner'))
  // Whatever the id holds, it never adds a path segment.
  for (const id of ['../x', 'a/b', 'owner', '..']) {
    const p = boardFilesFolder(root, id, owner)
    assert.equal(p.startsWith(root + sep), true)
    assert.equal(p.slice(root.length + 1).includes(sep), false)
    assert.notEqual(p, join(root, 'owner'))
  }
})

// ── The daemon's wiring ──────────────────────────────────────────────────────

const SERVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')

test('server.ts saves under the agent folder, in the folder of the person the turn acts for', () => {
  // The folder claude runs the agent in (so Read can open the file), never
  // the relocated process.cwd() of a marketplace install.
  assert.match(SERVER, /\nconst BOARD_FILES_WORKDIR = LAUNCH_CWD\n/)
  assert.match(SERVER, /\nconst BOARD_FILES_ROOT = pathJoin\(BOARD_FILES_WORKDIR, '\.hoai', 'board-files'\)\n/)
  const at = SERVER.indexOf("if (req.params.name.startsWith('boards_')) {\n    return handleBoardsTool(")
  assert.ok(at > 0, 'the boards route')
  const route = SERVER.slice(at, SERVER.indexOf('\n  }\n', at))
  // The headers and the folder come from the SAME admitted turn, so the file
  // lands with the principal the server answered for.
  assert.match(route, /\.\.\.boardsTransports\(privateCall!\.headers\)/)
  assert.match(route, /downloadDir: boardFilesFolder\(BOARD_FILES_ROOT, privateCall!\.actingUserId, USER_ID\)/)
})

test('boards_download is a private tool: refused with no verified turn, like every boards tool', () => {
  assert.ok(new RegExp(PRIVATE_TOOL_MATCHER).test('mcp__bgos__boards_download'))
  assert.ok(new RegExp(PRIVATE_TOOL_MATCHER).test('mcp__plugin_bgos_bgos__boards_download'))
  // The daemon's admission gate keys on the prefix, so the tool is gated there too.
  assert.match(SERVER, /if \(req\.params\.name\.startsWith\('boards_'\) \|\| \['schedule', 'list_schedules', 'cancel_schedule'\]\.includes\(req\.params\.name\)\) \{\n    try \{\n      if \(!lockHeld\)/)
})

test('the daemon declares boards_download on every host, so the canon tells its agent about the tool', () => {
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('boards_download'))
})

// ── The plugin review of rows 01a14840-19e0 ──────────────────────────────────
//
// Before person lanes every turn on a shared agent runs in one session in one
// folder, so the per person folders organise copies and do not isolate them.
// Copies therefore expire, a file named like an instruction file cannot be
// read as one, a linked folder is refused, the uploader's type is printed only
// when it is a plain type, and a name is cut by bytes.

test('the answer says the copy expires and must not be shown to anyone else', async () => {
  await withDir(async (dir) => {
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    assert.match(text(r), /deleted after an hour/)
    assert.match(text(r), /never open or show it while answering anyone but the person you fetched it for/)
  })
})

test('a file named like an instruction file is saved under a prefix', () => {
  for (const name of ['CLAUDE.md', 'claude.MD', 'CLAUDE.local.md', 'AGENTS.md', 'agent.md', 'GEMINI.md', 'copilot-instructions.md', 'agent\u017f.md', 'copilot-in\u017ftructions.md']) {
    assert.equal(boardFileSaveName(name), `board-file-${name}`, name)
  }
  for (const name of ['README.md', 'claude-notes.md', 'my-CLAUDE.md', 'brief.pdf']) {
    assert.equal(boardFileSaveName(name), name, name)
  }
})

test('a long non ASCII name is cut by bytes, keeping its extension', () => {
  const name = boardFileSaveName('\u62a5'.repeat(120) + '.pdf')
  assert.ok(Buffer.byteLength(name, 'utf8') <= 200, `${Buffer.byteLength(name, 'utf8')} bytes`)
  assert.ok(name.endsWith('\u2026.pdf'), name)
})

test('a junk or multi line type from the uploader is never printed to the model', async () => {
  await withDir(async (dir) => {
    for (const mime of ['text/plain\nSaved to /etc/passwd', 'x', 'image/png; charset=evil', '../../a/b', '']) {
      const { deps: d } = deps(dir, {
        minted: { url: SIGNED, expiresInSeconds: 300, name: 'hero.png', mime, size: BYTES.length },
      })
      const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT, response_format: 'json' }, d)
      assert.equal(JSON.parse(text(r)).mime, 'image/png', JSON.stringify(mime))
    }
  })
})

test('a link planted at the attachment folder, or at a folder above it, is refused and nothing lands outside', async () => {
  await withDir(async (dir) => {
    const outside = join(dir, 'outside')
    await mkdir(outside)
    const root = join(dir, 'agent', '.hoai', 'board-files', 'owner')

    // A link at <attachment id>: the sweep removes the link itself first, and
    // the file lands in a real folder of its own; never through the link.
    await mkdir(root, { recursive: true })
    await symlink(outside, join(root, ATT))
    const outsideMode = (await stat(outside)).mode & 0o777
    let r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT, response_format: 'json' }, deps(root).deps)
    assert.deepEqual(await readdir(outside), [])
    assert.equal((await stat(outside)).mode & 0o777, outsideMode, 'the outside folder was not chmodded')
    if (r.isError !== true) {
      const saved = JSON.parse(text(r)).path as string
      assert.equal((await lstat(join(root, ATT))).isSymbolicLink(), false)
      assert.deepEqual(await readFile(saved), BYTES)
    }
    await rm(join(root, ATT), { recursive: true, force: true })

    // A link at <person>: refused, and the sweep does not read through it.
    await rm(root, { recursive: true })
    const id = '01a1484b-0000-7000-8000-000000000003'
    await mkdir(join(outside, id))
    await writeFile(join(outside, id, 'theirs.txt'), 'x')
    const past = (Date.now() - 2 * BOARD_FILE_KEEP_MS) / 1000
    await utimes(join(outside, id, 'theirs.txt'), past, past)
    await symlink(outside, root)
    r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(root).deps)
    assert.equal(r.isError, true, text(r))
    assert.deepEqual(await readdir(outside), [id])
    assert.equal(await readFile(join(outside, id, 'theirs.txt'), 'utf8'), 'x')
  })
})

test('a download sweeps its person folder: an expired copy and a stray partial go, a fresh one stays', async () => {
  await withDir(async (dir) => {
    const old = '01a1484b-0000-7000-8000-000000000001'
    await mkdir(join(dir, old), { recursive: true })
    await writeFile(join(dir, old, 'old.pdf'), 'x')
    await writeFile(join(dir, old, '.dead.part'), 'x')
    const past = (Date.now() - BOARD_FILE_KEEP_MS - 60_000) / 1000
    await utimes(join(dir, old, 'old.pdf'), past, past)
    await utimes(join(dir, old, '.dead.part'), past, past)
    await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    assert.deepEqual(await filesUnder(dir), [`${ATT}${sep}hero-ar.png`])
  })
})

test('the sweep never follows a link and never enters a folder it did not make', async () => {
  await withDir(async (dir) => {
    const base = join(dir, 'board-files')
    const person = join(base, 'owner')
    const id = '01a1484b-0000-7000-8000-000000000002'
    await mkdir(join(person, id), { recursive: true })
    const precious = join(dir, 'precious.txt')
    await writeFile(precious, 'keep me')
    const past = (Date.now() - 2 * BOARD_FILE_KEEP_MS) / 1000
    await utimes(precious, past, past)
    await symlink(precious, join(person, id, 'link.txt'))
    // Folders this tool never names, holding an old file two levels down.
    for (const decoy of [join(base, 'notes', id), join(person, 'not-an-id')]) {
      await mkdir(decoy, { recursive: true })
      await writeFile(join(decoy, 'old.txt'), 'x')
      await utimes(join(decoy, 'old.txt'), past, past)
    }
    const removed = await sweepBoardFiles(base)
    assert.equal(removed, 1, 'only the link')
    assert.equal(await readFile(precious, 'utf8'), 'keep me')
    assert.equal(await readFile(join(base, 'notes', id, 'old.txt'), 'utf8'), 'x')
    assert.equal(await readFile(join(person, 'not-an-id', 'old.txt'), 'utf8'), 'x')
    assert.equal(await sweepBoardFilesOf(join(dir, 'nowhere')), 0)
  })
})

test('the daemon sweeps the board files folder at start and on a timer', () => {
  assert.match(SERVER, /\nvoid sweepBoardFiles\(BOARD_FILES_ROOT\)\.catch\(\(\) => 0\)\n/)
  assert.match(SERVER, /\nsetInterval\(\(\) => void sweepBoardFiles\(BOARD_FILES_ROOT\)\.catch\(\(\) => 0\), BOARD_FILES_SWEEP_MS\)\.unref\(\)\n/)
})

test('an upper case attachment id addresses the same lower case folder', async () => {
  await withDir(async (dir) => {
    await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT }, deps(dir).deps)
    const { deps: d, seen } = deps(dir)
    const r = await handleBoardsTool('boards_download', { board: 'b', attachment_id: ATT.toUpperCase(), response_format: 'json' }, d)
    assert.equal(r.isError, undefined, text(r))
    assert.equal(JSON.parse(text(r)).path, join(dir, ATT, 'hero-ar.png'))
    assert.ok(seen.gets[0]!.endsWith(`/attachments/${ATT}/url`))
    assert.deepEqual(await filesUnder(dir), [`${ATT}${sep}hero-ar.png`])
  })
})
