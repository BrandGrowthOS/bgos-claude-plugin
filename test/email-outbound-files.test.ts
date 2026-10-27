/**
 * Agent email files, outbound (HOAI row 5b141728, step 2, rule 4): the
 * plugin's check of every file an agent asks to attach to an email
 * (lib/email-outbound-files.ts outboundFileRefusal), in the order the design
 * pins (DESIGN-OUT.md D7):
 *   1. a lexical refusal BEFORE any file system call: not a full path, a
 *      network (UNC) or device path, /proc, /dev, /sys;
 *   2. backslashes read as slashes, then the secret list
 *      (OUTBOUND_SECRET_PATTERNS) and lanePathIsSecret;
 *   3. realpath, then steps 1 and 2 again on the real path;
 *   4. a regular file, 25 MB each and in all, at most 10, type by its bytes.
 * Rule 1 now follows the agent's usual send setting, so in Send for me these
 * checks (with rule 2's turn check) are all that stand between a local file
 * and a stranger's inbox. Every file here is written under a scratch HOME in
 * the test temp folder; no real home, key or malware sample is ever touched
 * (a program renamed .pdf is two harmless header bytes).
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: Record<string, any> | null = null
async function m(): Promise<Record<string, any>> {
  if (mod === null) {
    const path = '../lib/email-outbound-files.ts'
    mod = await import(path).catch(() => ({}))
  }
  return mod!
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
/** A Windows program's first bytes: harmless on their own, and never a PDF. */
const PROGRAM = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])
const MB = 1024 * 1024

function scratchHome(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'hoai-outbound-files-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())))
    rmSync(root, { recursive: true, force: true })
  })
  const home = join(root, 'home')
  mkdirSync(join(home, 'docs'), { recursive: true })
  return home
}

/** File system functions that count every call and answer none: proof that nothing was opened. */
function spyFs() {
  const calls: string[] = []
  const no = (name: string) => async (path: string) => {
    calls.push(`${name} ${path}`)
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  return { calls, fs: { realpath: no('realpath'), lstat: no('lstat'), open: no('open') } }
}

async function refusal(path: string, ctx: Record<string, unknown>): Promise<string | null> {
  const lib = await m()
  assert.equal(typeof lib.outboundFileRefusal, 'function', 'lib/email-outbound-files.ts exports outboundFileRefusal')
  return lib.outboundFileRefusal(path, ctx)
}

test('~/.ssh/id_rsa is refused in one plain sentence that names it and says why', async () => {
  const { calls, fs } = spyFs()
  assert.equal(
    await refusal('~/.ssh/id_rsa', { home: 'C:\\Users\\kc', fs }),
    '~/.ssh/id_rsa looks like a key or password file, so it is never attached.',
  )
  assert.deepEqual(calls, [], 'refused before any file system call')
})

test('Windows spellings of a key are refused: backslashes and mixed slashes (G1)', async () => {
  const { calls, fs } = spyFs()
  for (const path of [
    'C:\\Users\\x\\.ssh\\id_rsa',
    'C:/Users\\x/.ssh\\id_rsa',
    'c:\\USERS\\X\\.SSH\\ID_RSA',
    'C:\\Users\\x\\Documents\\id_ed25519',
    'D:\\backup\\server.pem',
  ]) {
    const why = await refusal(path, { home: 'C:\\Users\\x', fs })
    assert.match(String(why), /looks like a key or password file, so it is never attached\.$/, path)
    assert.ok(String(why).startsWith(path), `names the file as given: ${why}`)
  }
  assert.deepEqual(calls, [])
})

test('a network (UNC) or device path is refused with ZERO file system calls (G2: no SMB, no NTLM)', async () => {
  for (const path of [
    '\\\\files.example\\share\\q3.pdf',
    '//files.example/share/q3.pdf',
    '\\/files.example/share/q3.pdf',
    '\\\\?\\C:\\Users\\x\\q3.pdf',
    '\\\\?\\UNC\\files.example\\share\\q3.pdf',
    '\\\\.\\pipe\\q3.pdf',
    '\\\\.\\PhysicalDrive0',
    'C:\\Users\\x\\CON',
    'C:\\Users\\x\\nul.pdf',
  ]) {
    const { calls, fs } = spyFs()
    const why = await refusal(path, { home: 'C:\\Users\\x', fs })
    assert.match(String(why), /network or device path, so it is never attached/, path)
    assert.deepEqual(calls, [], `no file system call for ${path}`)
  }
})

test('a path that is not a full path, or a Unix system folder, is refused before any file system call', async () => {
  for (const [path, words] of [
    ['docs/q3.pdf', /is not a full path/],
    ['q3.pdf', /is not a full path/],
    ['C:q3.pdf', /is not a full path/],
    ['', /names no file/],
    ['/proc/self/environ', /system file/],
    ['/dev/sda', /system file/],
    ['/sys/kernel/x', /system file/],
    ['/home/kc/a\u0000.pdf', /control character/],
  ] as Array<[string, RegExp]>) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home: '/home/kc', fs })), words, JSON.stringify(path))
    assert.deepEqual(calls, [], JSON.stringify(path))
  }
})

test('every kind on the secret list is refused lexically: env, ssh, aws, gnupg, git, keys, credentials, browsers, keychains, Claude and HOAI folders', async () => {
  const lib = await m()
  assert.ok(Array.isArray(lib.OUTBOUND_SECRET_PATTERNS) && lib.OUTBOUND_SECRET_PATTERNS.length > 0, 'OUTBOUND_SECRET_PATTERNS is one named list')
  const home = 'C:\\Users\\kc'
  for (const path of [
    'C:\\Users\\kc\\project\\.env.local',
    '/home/kc/app/.env',
    '/home/kc/.aws/config',
    '/home/kc/.gnupg/pubring.kbx',
    '/home/kc/app/.git/config',
    '/home/kc/id_ed25519',
    '/home/kc/certs/server.pem',
    '/home/kc/certs/tls.key',
    '/home/kc/certs/bundle.p12',
    '/home/kc/Downloads/credentials.csv',
    'C:\\Users\\kc\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data',
    'C:\\Users\\kc\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies',
    'C:\\Users\\kc\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\ab12.default\\logins.json',
    '/home/kc/.mozilla/firefox/ab12.default/key4.db',
    '/Users/kc/Library/Keychains/login.keychain-db',
    '/Users/kc/Library/Application Support/Google/Chrome/Default/Login Data',
    '~/.claude/settings.json',
    '~/.claude.json',
    '~/.bgos-agent/email-files/12/3b9f0d6e/attachment-1.pdf',
    'C:\\Users\\kc\\.bgos-agent\\email-files\\12\\3b9f0d6e\\attachment-1.pdf',
    '~/.bgos-plugin-state/pairing.json',
  ]) {
    const { calls, fs } = spyFs()
    const why = String(await refusal(path, { home, fs }))
    assert.match(why, /so it is never attached\.$/, path)
    assert.deepEqual(calls, [], path)
  }
})

test('a plain document in a scratch HOME passes, with its name, type and bytes', async (t) => {
  const lib = await m()
  const home = scratchHome(t)
  const path = join(home, 'docs', 'Q3 report.pdf')
  writeFileSync(path, PDF)
  assert.equal(await refusal(path, { home }), null)
  const read = await lib.readOutboundFiles([path], { home })
  assert.equal(read.ok, true, read.error)
  assert.equal(read.files.length, 1)
  assert.equal(read.files[0].name, 'Q3 report.pdf')
  assert.equal(read.files[0].type, 'pdf')
  assert.equal(read.files[0].size, PDF.length)
  assert.deepEqual(Buffer.from(read.files[0].bytes), PDF)
  // The same file named from the home with a tilde.
  assert.equal(await refusal('~/docs/Q3 report.pdf', { home }), null)
})

test('a link in a plain folder that leads into .aws is refused after realpath (rule 4: links resolved first)', async (t) => {
  const home = scratchHome(t)
  mkdirSync(join(home, '.aws'))
  writeFileSync(join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = not-a-real-key\n')
  writeFileSync(join(home, '.aws', 'statement.pdf'), PDF)
  // A folder link (a junction on Windows, which needs no special right): every name under it looks plain.
  symlinkSync(join(home, '.aws'), join(home, 'docs', 'shared'), 'junction')
  const viaFolder = join(home, 'docs', 'shared', 'statement.pdf')
  const why = String(await refusal(viaFolder, { home }))
  assert.match(why, /leads to a key or password file \(HOAI followed its links\), so it is never attached\.$/, why)
  assert.ok(why.startsWith(viaFolder))
  // A file link straight at .aws/credentials, where this computer allows one (Windows needs a right for it).
  const fileLink = join(home, 'docs', 'invoice.pdf')
  let linked = true
  try {
    symlinkSync(join(home, '.aws', 'credentials'), fileLink, 'file')
  } catch {
    linked = false
  }
  if (linked) assert.match(String(await refusal(fileLink, { home })), /leads to a key or password file/)
})

test('a program renamed .pdf is refused by its bytes; an unknown type is refused by its name', async (t) => {
  const home = scratchHome(t)
  const fake = join(home, 'docs', 'invoice.pdf')
  writeFileSync(fake, PROGRAM)
  assert.equal(await refusal(fake, { home }), `${fake} is not really a PDF file (its contents say otherwise), so it is not attached.`)
  const zip = join(home, 'docs', 'photos.zip')
  writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
  assert.match(String(await refusal(zip, { home })), /is not a type that can be attached; only PDF, pictures \(PNG, JPG, GIF, WebP\), text \(TXT, CSV\), Word \(DOCX\) and Excel \(XLSX\) files are\.$/)
  const png = join(home, 'docs', 'chart.png')
  writeFileSync(png, PNG)
  assert.equal(await refusal(png, { home }), null)
  const folder = join(home, 'docs', 'folder.pdf')
  mkdirSync(folder)
  assert.match(String(await refusal(folder, { home })), /is not a regular file/)
  assert.match(String(await refusal(join(home, 'docs', 'missing.pdf'), { home })), /could not be found or read/)
  const empty = join(home, 'docs', 'empty.txt')
  writeFileSync(empty, '')
  assert.match(String(await refusal(empty, { home })), /is empty/)
})

test('26 MB is refused; files over 25 MB together are refused; 11 files are refused before any read', async (t) => {
  const lib = await m()
  const home = scratchHome(t)
  const big = join(home, 'docs', 'big.txt')
  writeFileSync(big, Buffer.alloc(26 * MB, 0x61))
  assert.match(String(await refusal(big, { home })), /^.*big\.txt is 26 MB; one email can carry at most 25 MB of files, so it is not attached\.$/)
  const a = join(home, 'docs', 'a.txt')
  const b = join(home, 'docs', 'b.txt')
  writeFileSync(a, Buffer.alloc(13 * MB, 0x61))
  writeFileSync(b, Buffer.alloc(13 * MB, 0x62))
  const both = await lib.readOutboundFiles([a, b], { home })
  assert.equal(both.ok, false)
  assert.equal(both.error, 'These files come to 26 MB together; one email can carry at most 25 MB of files.')
  const { calls, fs } = spyFs()
  const eleven = await lib.readOutboundFiles(Array.from({ length: 11 }, (_, i) => join(home, 'docs', `f${i}.txt`)), { home, fs })
  assert.equal(eleven.ok, false)
  assert.equal(eleven.error, 'At most 10 files can go with one email; this one names 11.')
  assert.deepEqual(calls, [])
  assert.equal(lib.AGENT_EMAIL_OUTBOUND_MAX_FILES, 10)
  assert.equal(lib.AGENT_EMAIL_OUTBOUND_MAX_BYTES, 25 * MB)
})

test('the same file twice is refused, by its real path', async (t) => {
  const lib = await m()
  const home = scratchHome(t)
  const path = join(home, 'docs', 'a.pdf')
  writeFileSync(path, PDF)
  const twice = await lib.readOutboundFiles([path, join(home, 'docs', '.', 'a.pdf')], { home })
  assert.equal(twice.ok, false)
  assert.match(twice.error, /is named twice/)
})

test('a file path never leaves in a floor check or a card: only a count does (G9)', async () => {
  const lib = await m()
  assert.equal(typeof lib.hideEmailFilePaths, 'function')
  const preview = JSON.stringify({ to: 'sam@harborhall.com', subject: 'Q3', text: 'Hi', files: [{ path: 'C:\\Users\\kc\\Documents\\Kc-salary-2026.xlsx' }, { path: '/home/kc/q3.pdf' }] })
  const hidden = lib.hideEmailFilePaths('mcp__bgos__email_send', preview)
  assert.equal(hidden.includes('salary'), false, hidden)
  assert.equal(hidden.includes('q3.pdf'), false, hidden)
  assert.deepEqual(JSON.parse(hidden), { to: 'sam@harborhall.com', subject: 'Q3', text: 'Hi', files: '2 files' })
  // A preview the CLI cut in the middle is not JSON: every path value is hidden all the same.
  const cut = `${preview.slice(0, 90)}…`
  const hiddenCut = lib.hideEmailFilePaths('email_send', cut)
  assert.equal(/salary|Documents/.test(hiddenCut), false, hiddenCut)
  // Another tool, or an email with no files, is left exactly as it was.
  assert.equal(lib.hideEmailFilePaths('Bash', preview), preview)
  const plain = JSON.stringify({ email_id: 'x', text: 'Hi' })
  assert.equal(lib.hideEmailFilePaths('email_send', plain), plain)
})

test('verifier: a folder name with a trailing dot or space is the same folder on Windows, so .aws. is refused with no file system call', async () => {
  for (const path of ['C:\\Users\\kc\\.aws.\\notes.txt', 'C:\\Users\\kc\\.aws \\notes.txt', 'C:/Users/kc/.gnupg../a.pdf', 'C:\\Users\\kc\\.ssh. .\\report.pdf']) {
    const spy = spyFs()
    const why = await refusal(path, { home: 'C:\\Users\\kc', fs: spy.fs })
    assert.match(String(why), /looks like a key or password file, so it is never attached/, path)
    assert.deepEqual(spy.calls, [], `${path}: no file system call`)
  }
})

test('verifier: the second secret list (lanePathIsSecret) holds on its own: a gcloud folder file is refused with no file system call', async () => {
  for (const path of ['~/.config/gcloud/notes.txt', 'C:\\Users\\kc\\.config\\gcloud\\legacy\\report.pdf']) {
    const spy = spyFs()
    const why = await refusal(path, { home: 'C:\\Users\\kc', fs: spy.fs })
    assert.match(String(why), /looks like a key or password file, so it is never attached/, path)
    assert.deepEqual(spy.calls, [], `${path}: no file system call`)
  }
})

test('G9 (verifier): a preview the CLI cut keeps no file path, whatever shape its files take, on the card of either tool', async () => {
  const lib = await m()
  const { buildPermissionRequestBody } = await import('../lib/permission-relay.ts')
  // The CLI cuts a value over 3500 code points to its first 2000 and last 1500 with a line break inside the string,
  // so the preview is no longer JSON. email_draft has no preflight, so its card is posted before the tool refuses a
  // malformed list: the path must already be gone by then.
  const cutText = `${'a'.repeat(2000)}\n\u22EF 600 code points elided \u22EF\n${'b'.repeat(1500)}`
  const salary = 'C:\\\\Users\\\\kc\\\\Documents\\\\Kc-salary-2026.xlsx'
  const shapes = [
    `["${salary}"]`,
    `[{"file": "${salary}"}]`,
    `[{"path": "${salary}", "name": "${salary}"}]`,
    `{"path": "${salary}"}`,
  ]
  for (const files of shapes) {
    for (const order of ['files first', 'text first']) {
      const preview = order === 'files first'
        ? `{"to": "sam@harborhall.com", "subject": "Q3", "files": ${files}, "text": "${cutText}"}`
        : `{"to": "sam@harborhall.com", "subject": "Q3", "text": "${cutText}", "files": ${files}}`
      for (const toolName of ['mcp__plugin_bgos_bgos__email_draft', 'mcp__bgos__email_send']) {
        const hidden = lib.hideEmailFilePaths(toolName, preview)
        assert.equal(/salary|Documents/.test(hidden), false, `${toolName}, ${order}, files ${files}: ${hidden.slice(0, 300)}`)
        const card = JSON.stringify(buildPermissionRequestBody({ chatId: 40, requestId: 'r1', toolName, description: 'd', inputPreview: preview }))
        assert.equal(/salary|Documents/.test(card), false, `${toolName}, ${order}, files ${files}: the card`)
      }
    }
  }
  // The CLI's own cut still reads as the email, so the card says how many files, not that it could not tell.
  const cutOne = `{"to": "sam@harborhall.com", "files": ["${salary}"], "text": "${cutText}"}`
  assert.equal(JSON.parse(lib.hideEmailFilePaths('mcp__bgos__email_draft', cutOne)).files, '1 file')
  // A preview cut inside the list itself reads as nothing: all from the files key on is gone.
  const broken = `{"to": "sam@harborhall.com", "subject": "Q3", "files": ["${salary}", "C:\\\\Users\\\\kc\\\\Docume`
  const hiddenBroken = lib.hideEmailFilePaths('mcp__bgos__email_draft', broken)
  assert.equal(/salary|Documents|Docume/.test(hiddenBroken), false, hiddenBroken)
  assert.match(hiddenBroken, /^\{"to": "sam@harborhall\.com", "subject": "Q3", "files": "\(file paths hidden\)"\}$/)
})

test('no em or en dash in the new module', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/email-outbound-files.ts', import.meta.url), 'utf8')
  assert.equal(/[\u2013\u2014]/.test(src), false)
})
