import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import ts from 'typescript'

import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { buildInboundChannel } from '../lib/inbound-channel.ts'
import {
  getFileCategory,
  guessMimeType,
  guessOutboundMime,
  unsupportedFileMessage,
} from '../lib/message-text.ts'

const MB = 1024 * 1024
const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const DOWNLOAD_URL = 'https://files.example.test/attachment.txt'

// Exercise the shipping resolver without starting the daemon or using a network.
const parsed = ts.createSourceFile('server.ts', SERVER, ts.ScriptTarget.ES2022, true)
const lifted = ['SIZE_LIMITS', 'S3_THRESHOLD', 'resolveFile'].map((name) => {
  const statement = parsed.statements.find((s) =>
    (ts.isFunctionDeclaration(s) && s.name?.text === name) ||
    (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) =>
      ts.isIdentifier(d.name) && d.name.text === name)),
  )
  assert.ok(statement, `server.ts must define ${name}`)
  return statement.getText(parsed)
}).join('\n')
const js = ts.transpileModule(lifted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function resolver(size: number) {
  const reads: string[] = []
  const uploads: Array<{ name: string; mime: string; bytes: number }> = []
  const factory = new Function(
    'basename', 'guessMimeType', 'guessOutboundMime', 'getFileCategory',
    'unsupportedFileMessage', 'stat', 'readFile', 'uploadViaS3', 'log',
    `${js}\nreturn { resolveFile, limits: SIZE_LIMITS }`,
  )
  const runtime = factory(
    basename, guessMimeType, guessOutboundMime, getFileCategory, unsupportedFileMessage,
    async () => ({ size }),
    async (path: string) => {
      reads.push(path)
      // Buffer.from shares this full-size allocation, keeping the boundary test cheap.
      return new ArrayBuffer(size)
    },
    async (name: string, mime: string, buffer: Buffer) => {
      uploads.push({ name, mime, bytes: buffer.length })
      return { s3Key: 'synthetic-attachment', downloadUrl: DOWNLOAD_URL }
    },
    () => {},
  ) as {
    limits: Record<string, number>
    resolveFile(spec: { path: string }): Promise<{
      fileName: string; fileData: string; fileMimeType: string; s3Key: string;
      isDocument: boolean;
    }>
  }
  return { ...runtime, reads, uploads }
}

test('a 200 MB chat document is accepted and sent through the S3 upload path', async () => {
  const r = resolver(200 * MB)
  assert.equal(r.limits.document, 200 * MB)
  const file = await r.resolveFile({ path: 'attachment.txt' })
  assert.equal(file.fileName, 'attachment.txt')
  assert.equal(file.fileData, DOWNLOAD_URL)
  assert.equal(file.s3Key, 'synthetic-attachment')
  assert.equal(file.isDocument, true)
  assert.deepEqual(r.reads, ['attachment.txt'])
  assert.deepEqual(r.uploads, [{ name: 'attachment.txt', mime: 'text/plain', bytes: 200 * MB }])
})

for (const size of [200 * MB + 1, 201 * MB]) {
  for (const path of ['attachment.txt', 'attachment.pdf', 'attachment.zip']) {
    test(`${path} at ${size} bytes is refused before reading or uploading`, async () => {
      const r = resolver(size)
      await assert.rejects(r.resolveFile({ path }), /^Error: File exceeds 200MB limit$/)
      assert.deepEqual(r.reads, [])
      assert.deepEqual(r.uploads, [])
    })
  }
}

test('chat document guidance and the README attachment table say 200 MB', () => {
  assert.match(SERVER.split('\n').find((line) => line.includes('Supported documents:')) ?? '', /\(max 200 MB\)/)
  assert.match(BGOS_CAPABILITIES_FALLBACK.split('\n').find((line) => line.startsWith('- Files:')) ?? '', /document 200 MB\./)
  assert.match(README.split('\n').find((line) => line.startsWith('| Document |')) ?? '', /\| 200 MB \|/)
})

test('the separate image, video and audio caps stay unchanged', () => {
  const r = resolver(0)
  assert.equal(r.limits.image, 10 * MB)
  assert.equal(r.limits.video, 100 * MB)
  assert.equal(r.limits.audio, 20 * MB)
})

for (const transport of ['ws', 'poll', 'stream']) {
  for (const shape of ['push', 'row']) {
    test(`${transport} preserves the link and size of a 200 MB inbound ${shape} attachment`, () => {
      const bytes = 200 * MB
      const file = shape === 'push'
        ? { filename: 'attachment.txt', mime: 'text/plain', url: DOWNLOAD_URL, size: bytes }
        : { fileName: 'attachment.txt', fileMimeType: 'text/plain', fileData: DOWNLOAD_URL, isDocument: true, fileSize: bytes }
      const delivery = buildInboundChannel({
        transport, chatId: 1, messageId: 2, userId: 'synthetic-owner', assistantId: 3,
        timestamp: '2026-11-07T00:00:00.000Z', text: 'Read this file.', files: [file],
      })
      const [attachment] = JSON.parse(delivery.meta.files)
      assert.equal(attachment.url, DOWNLOAD_URL)
      assert.equal(attachment.size, String(bytes))
      assert.match(delivery.content, /attachment\.txt/)
      assert.ok(delivery.content.includes(DOWNLOAD_URL))
    })
  }
}
