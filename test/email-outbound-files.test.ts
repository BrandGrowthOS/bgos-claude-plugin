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
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

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
/** The clause a rule 4 refusal ends with (review round 1). */
const NO_WAY_AROUND = 'Do not copy, rename or retype it to send it another way; ask your owner.'

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
    `~/.ssh/id_rsa looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`,
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
    assert.match(String(why), /looks like a key or password file, so it is never attached\. Do not copy, rename or retype it to send it another way; ask your owner\.$/, path)
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
    assert.match(why, /so it is never attached\. Do not copy, rename or retype it to send it another way; ask your owner\.$/, path)
    assert.deepEqual(calls, [], path)
  }
})

test('review fix: a password export, a password manager file and a recovery code file are refused lexically, each pattern on its own', async () => {
  const home = 'C:\\Users\\kc'
  // One group per pattern, so emptying any one of them turns its group red.
  const groups: Record<string, string[]> = {
    'a name or folder with password in it': [
      'C:\\Users\\kc\\Downloads\\Chrome Passwords.csv',
      'C:\\Users\\kc\\Documents\\passwords.txt',
      'C:\\Users\\kc\\Documents\\My Passwords.xlsx',
      '/home/kc/Documents/Passwords/bank.pdf',
    ],
    'a login export': ['C:\\Users\\kc\\Downloads\\logins.csv', '/home/kc/Downloads/login-export.csv'],
    'a password manager export': [
      'C:\\Users\\kc\\Downloads\\bitwarden_export_2026.csv',
      '/home/kc/Downloads/LastPass vault.csv',
      '/home/kc/Downloads/1Password Export.csv',
      '/home/kc/Documents/KeePass/export.txt',
      '/home/kc/Downloads/dashlane-export.csv',
      '/home/kc/Downloads/nordpass_2026.csv',
    ],
    'a recovery code file': [
      'C:\\Users\\kc\\Downloads\\recovery-codes.txt',
      '/home/kc/Documents/github-recovery-codes.txt',
      '/home/kc/Documents/Google Backup Codes.pdf',
      '/home/kc/Documents/backup_code.png',
    ],
  }
  for (const [group, paths] of Object.entries(groups)) {
    for (const path of paths) {
      const { calls, fs } = spyFs()
      const why = String(await refusal(path, { home, fs }))
      assert.match(why, /looks like a key or password file, so it is never attached\. Do not copy, rename or retype it to send it another way; ask your owner\.$/, `${group}: ${path}`)
      assert.deepEqual(calls, [], `${group}: ${path}`)
    }
  }
  // The control: ordinary names that only look close still reach the file system.
  // A project folder that only has the word in its name is not a password store: its plain files still go.
  for (const path of ['/home/kc/docs/passport scan.pdf', '/home/kc/docs/login page mockup.png', '/home/kc/docs/backup plan.docx', '/home/kc/docs/recovery notes.txt', 'C:\\Users\\kc\\code\\password-reset-app\\spec.pdf']) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
  }
})

test('review fix: a CSV or text file whose first line has a password column is refused, whatever it is named', async (t) => {
  const home = scratchHome(t)
  for (const [name, header] of [
    ['export.csv', 'name,url,username,password,note'],
    ['firefox.csv', '"url","username","password","httpRealm","formActionOrigin","guid"'],
    ['vault.csv', 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp'],
    ['accounts.txt', '"Account";"Login Name";"Password";"Web Site";"Comments"'],
    ['crlf.csv', 'Title,Url,Username,Passwd\r'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, `${header}\nExample,https://example.com,kc,not-a-real-secret,\n`)
    assert.equal(await refusal(path, { home }), `${path} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The control: a plain table, and a password column that is not on the first line, still go.
  const contacts = join(home, 'docs', 'contacts.csv')
  writeFileSync(contacts, 'name,email,phone\nSam,sam@harborhall.com,555\n')
  assert.equal(await refusal(contacts, { home }), null)
  const notes = join(home, 'docs', 'notes.txt')
  writeFileSync(notes, 'Meeting notes\nWe talked about the password policy.\n')
  assert.equal(await refusal(notes, { home }), null)
})

test('review round 1: a recovery key, a seed or recovery phrase, a mnemonic, a wallet backup and 2FA codes are refused lexically, each pattern on its own', async () => {
  const home = 'C:\\Users\\kc'
  // One group per pattern, so emptying any one of them turns its group red. Every name is a name only: nothing is written.
  const groups: Record<string, string[]> = {
    'a recovery key': [
      // The name Windows gives a saved BitLocker key.
      'C:\\Users\\kc\\Documents\\BitLocker Recovery Key 1A2B3C4D-0000-0000-0000-000000000000.TXT',
      'C:\\Users\\kc\\Documents\\bitlocker recovery key 1A2B3C4D.TXT',
      '/Users/kc/Desktop/FileVault Recovery Key.pdf',
      '/home/kc/Documents/recovery_keys/disk.png',
    ],
    'a seed or recovery phrase': [
      '/home/kc/Documents/seed phrase.txt',
      'C:\\Users\\kc\\Desktop\\wallet-recovery-phrase.txt',
      '/home/kc/Pictures/Seed Phrases/photo.jpg',
      '/home/kc/Documents/metamask secret recovery phrase.pdf',
    ],
    'a mnemonic': ['/home/kc/Documents/mnemonic.txt', 'C:\\Users\\kc\\Documents\\ledger_mnemonic_backup.docx'],
    'a wallet backup': ['/home/kc/Documents/wallet backup.txt', 'C:\\Users\\kc\\Downloads\\Wallet-Backup\\notes.pdf', '/home/kc/Documents/backup_wallet_2026.png'],
    '2FA, MFA or OTP codes': [
      '/home/kc/Documents/2fa-backup.txt',
      '/home/kc/Documents/MFA recovery.pdf',
      '/home/kc/Documents/otp codes.png',
      'C:\\Users\\kc\\Documents\\totp_secrets.csv',
    ],
  }
  for (const [group, paths] of Object.entries(groups)) {
    for (const path of paths) {
      const { calls, fs } = spyFs()
      const why = String(await refusal(path, { home, fs }))
      assert.ok(why.startsWith(`${path} looks like a key or password file, so it is never attached.`), `${group}: ${path}: ${why}`)
      assert.deepEqual(calls, [], `${group}: ${path}`)
    }
  }
  // The control: ordinary names that only look close still reach the file system.
  for (const path of ['/home/kc/docs/disaster recovery plan.pdf', '/home/kc/docs/key results 2026.xlsx', '/home/kc/docs/seed round deck.pdf', '/home/kc/docs/wallet design.png', '/home/kc/docs/laptop codes of conduct.docx']) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
  }
})

test('review round 1: a folder named for passwords, a password manager or a password vault is refused with every file in it', async () => {
  const home = 'C:\\Users\\kc'
  for (const path of [
    'C:\\Users\\kc\\Documents\\My Passwords\\bank.pdf',
    '/home/kc/old_passwords/notes.txt',
    '/home/kc/Documents/Password Manager/export.png',
    '/home/kc/Documents/password-vault/2026/list.docx',
  ]) {
    const { calls, fs } = spyFs()
    const why = String(await refusal(path, { home, fs }))
    assert.ok(why.startsWith(`${path} looks like a key or password file, so it is never attached.`), `${path}: ${why}`)
    assert.deepEqual(calls, [], path)
  }
  // The control: a project folder that only has the word in its name still lets its plain files go.
  for (const path of ['C:\\Users\\kc\\code\\password-reset-app\\spec.pdf', '/home/kc/code/password_policy_review/summary.docx']) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
  }
})

test('review round 1: a rule 4 refusal tells the agent not to copy, rename or retype the file to get past it; other refusals do not', async (t) => {
  const lib = await m()
  assert.equal(lib.OUTBOUND_NO_WAY_AROUND, NO_WAY_AROUND)
  const { fs } = spyFs()
  assert.equal(await refusal('~/.ssh/id_rsa', { home: 'C:\\Users\\kc', fs }), `~/.ssh/id_rsa looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`)
  assert.equal(lib.outboundFileLexicalRefusal('/home/kc/seed phrase.txt', { home: '/home/kc' }), `/home/kc/seed phrase.txt looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`)
  const home = scratchHome(t)
  const exported = join(home, 'docs', 'export.csv')
  writeFileSync(exported, 'name,url,username,password\nExample,https://example.com,kc,not-a-real-secret\n')
  assert.equal(await refusal(exported, { home }), `${exported} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`)
  // A refusal that is not about a secret (a network path, a missing file, a wrong type) says nothing of the kind.
  for (const path of ['\\\\host\\share\\a.pdf', 'report.pdf', join(home, 'docs', 'missing.pdf')]) {
    assert.equal(String(await refusal(path, { home })).includes('Do not copy'), false, path)
  }
})

test('review round 1: a TXT or CSV that holds a private key armour line is refused, whatever it is named (round 2: anywhere in it)', async (t) => {
  const home = scratchHome(t)
  // Armour lines only, around an obviously fake body: no key material is ever written.
  const body = 'rig dummy, not a key'
  for (const [name, text] of [
    ['notes.txt', `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`],
    ['server.txt', `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`],
    ['ec.csv', `-----BEGIN EC PRIVATE KEY-----\r\n${body}\r\n-----END EC PRIVATE KEY-----\r\n`],
    ['pkcs8.txt', `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`],
    ['sealed.txt', `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----\n`],
    ['pgp.txt', `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${body}\n-----END PGP PRIVATE KEY BLOCK-----\n`],
    ['later.txt', `${'Setup notes for the new server.\n'.repeat(20)}-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n`],
    // Round 2: the 1 KB window is gone, so an armour line after a long page of notes is refused too.
    ['long.txt', `${'x'.repeat(1100)}\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n`],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} holds a private key, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The control: a public key, a certificate, and words about a key, still go.
  for (const [name, text] of [
    ['public.txt', `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`],
    ['cert.txt', `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`],
    ['howto.txt', 'Never email your private key; keep it in your key folder.\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), null, name)
  }
})

test('review round 2: a TXT or CSV that holds a key, a token or a connection password anywhere in it is refused, whatever it is named', async (t) => {
  const home = scratchHome(t)
  // Every value is an obviously fake dummy in the shape the scanner (lib/secret-scan.ts) knows: no real key is written.
  const awsId = 'AKIARIGDUMMYNOTAKEY0'
  const notes = 'Notes from the setup call, nothing secret here.\n'.repeat(30)
  for (const [name, text, rule] of [
    // The AWS IAM console's access key download, under a name the list does not know.
    ['iam user.csv', `Access key ID,Secret access key\n${awsId},rig dummy not a key\n`, 'aws_access_key_id'],
    // Round 3: rootkey.csv is refused by its name now, so the same contents go under a plain name.
    ['aws download.csv', `AWSAccessKeyId=${awsId}\nAWSSecretKey=rig dummy not a key\n`, 'aws_access_key_id'],
    // A copy of ~/.aws/credentials saved as notes.
    ['aws notes.txt', `[default]\naws_access_key_id = ${awsId}\naws_secret_access_key = rig dummy not a key\n`, 'aws_access_key_id'],
    // A .env copy.
    ['env backup.txt', 'STRIPE_SECRET_KEY=sk_live_rigdummynotakey\n', 'stripe_live_key'],
    ['db notes.txt', 'DATABASE_URL=postgres://rig:rigdummynotapassword@localhost/rig\n', 'connection_string_password'],
    ['github.txt', 'The CI token: ghp_rigdummynotakeyrigdummy00\n', 'github_token'],
    // Far past the first KB.
    ['later.csv', `${notes}deploy,ghp_rigdummynotakeyrigdummy00\n`, 'github_token'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} holds a secret (it looks like ${rule}), so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The control: words about keys and tokens, and a short value that only starts like one, still go.
  for (const [name, text] of [
    ['setup.txt', 'Ask Sam for the AWS access key; the API key lives in the vault. The token economy deck is due Friday.\n'],
    ['ids.csv', 'id,name\nAKIA,short\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), null, name)
  }
})

test('review round 2: an age secret key and a browser cookie file are refused by their contents, whatever they are named', async (t) => {
  const home = scratchHome(t)
  for (const [name, text] of [
    ['age.txt', '# created: 2026-10-28\n# public key: age1rigdummynotakey\nAGE-SECRET-KEY-1RIGDUMMYNOTAKEY\n'],
    ['crlf.txt', '# created: 2026-10-28\r\nAGE-SECRET-KEY-1RIGDUMMYNOTAKEY\r\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} holds a private key, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  for (const name of ['export.txt', 'site.txt']) {
    const path = join(home, 'docs', name)
    writeFileSync(path, '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\trig\trig dummy, not a cookie\n')
    assert.equal(await refusal(path, { home }), `${path} is a browser cookie file, which signs in as you, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The control: words about age keys and cookies still go.
  const about = join(home, 'docs', 'about.txt')
  writeFileSync(about, 'An age key starts with AGE-SECRET-KEY-1. The site uses a Netscape HTTP Cookie File for tests.\n')
  assert.equal(await refusal(about, { home }), null)
})

test('review round 2: a TXT or CSV that holds this agent\'s own credential is refused, even spaced out', async (t) => {
  const lib = await m()
  const home = scratchHome(t)
  const own = 'rig-dummy-pairing-token-not-a-key-0000'
  for (const [name, text] of [
    ['pairing.txt', `The pairing code: ${own}\n`],
    ['spaced.csv', `a,b\n${own.slice(0, 10)} ${own.slice(10)}\n`],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home, secrets: [own] }), `${path} holds this agent's own credential, so it is never attached. ${NO_WAY_AROUND}`, name)
    // readOutboundFiles hands the credential on to each file.
    const all = await lib.readOutboundFiles([path], { home, secrets: [own] })
    assert.equal(all.ok, false, name)
    // Without the credential named, the same file goes.
    assert.equal(await refusal(path, { home }), null, name)
  }
})

test('review round 2: names a reasonable owner gives a key, password, token or sign in file are refused lexically, each pattern on its own', async () => {
  const home = 'C:\\Users\\kc'
  // One group per pattern, so emptying any one of them turns its group red. Every name is a name only: nothing is written.
  const groups: Record<string, string[]> = {
    'credentials, anywhere in a file or folder name': [
      '/home/kc/Documents/db-credentials.txt',
      '/home/kc/Documents/my credentials.txt',
      'C:\\Users\\kc\\Downloads\\aws credentials.csv',
      'C:\\Users\\kc\\Downloads\\Admin_credentials.csv',
      '/home/kc/Documents/credential.txt',
      '/home/kc/Documents/Credentials/github.txt',
      // Final fix 4: the plural runs on into a longer word; only the singular keeps the lookahead (credentialing goes).
      '/home/kc/Documents/credentialsbackup.txt',
      'C:\\Users\\kc\\Documents\\credentialsbackup.txt',
    ],
    'secrets, or a name that ends with secret': [
      '/home/kc/Documents/secrets.txt',
      '/home/kc/Documents/secret.txt',
      '/home/kc/Documents/Secrets/prod.txt',
      '/home/kc/Documents/client secret.txt',
    ],
    'an api, access, secret or private key': [
      '/home/kc/Documents/api keys.txt',
      '/home/kc/Documents/api_key.txt',
      'C:\\Users\\kc\\Downloads\\kc_accessKeys.csv',
      '/home/kc/Documents/private key.txt',
      '/home/kc/Documents/wallet private key.txt',
      '/home/kc/Documents/eth_private_key.txt',
      '/home/kc/Documents/Secret Key/notes.pdf',
    ],
    'a file or folder named just key or keys': ['/home/kc/Documents/keys.txt', '/home/kc/Documents/Keys/stripe.txt', '/home/kc/Documents/key.png'],
    'a name that ends with token or tokens': ['/home/kc/Documents/tokens.txt', '/home/kc/Documents/session token.txt', '/home/kc/Documents/github-token.csv', '/home/kc/Documents/Tokens/ci.txt'],
    'a login file': ['/home/kc/Documents/login details.txt', 'C:\\Users\\kc\\Documents\\logins.xlsx', '/home/kc/Documents/login info.docx', '/home/kc/Documents/github login.txt', '/home/kc/Documents/Logins/bank.pdf'],
    'a sign in file': ['/home/kc/Documents/sign in details.txt', '/home/kc/Documents/signin.txt', '/home/kc/Documents/github sign-in.txt', '/home/kc/Documents/sign_in_info.docx'],
    'passwd or pwd': ['/home/kc/Documents/passwd.txt', '/home/kc/Documents/pwd.txt', '/home/kc/Documents/wifi_pwds.csv'],
    'a passphrase': ['/home/kc/Documents/passphrase.txt', '/home/kc/Documents/wifi passphrases.docx'],
    'a seed or seed words': ['/home/kc/Documents/seed.txt', '/home/kc/Documents/seed words.txt', '/home/kc/Documents/wallet seed.txt', '/home/kc/Pictures/seed_word.png'],
    'a backup phrase': ['/home/kc/Documents/backup phrase.txt', '/home/kc/Pictures/ledger_backup_phrases.png'],
    '2FA, MFA, TOTP or an authenticator': [
      '/home/kc/Documents/2fa.txt',
      '/home/kc/Pictures/2FA QR.png',
      '/home/kc/Documents/totp.txt',
      '/home/kc/Documents/mfa.txt',
      '/home/kc/Documents/authenticator backup.txt',
      '/home/kc/Pictures/Google Authenticator export.png',
    ],
    'a cookies text file': ['/home/kc/Downloads/cookies.txt', '/home/kc/Downloads/youtube-cookies.txt', '/home/kc/Downloads/cookie.txt'],
    'a .env inside a longer name': ['/home/kc/Documents/prod.env.txt', '/home/kc/Documents/app.env.csv'],
    'the sops key folders': [
      '/home/kc/.config/sops/age/backup.txt',
      '/Users/kc/Library/Application Support/sops/age/list.txt',
      'C:\\Users\\kc\\AppData\\Roaming\\sops\\age\\copy.txt',
    ],
  }
  for (const [group, paths] of Object.entries(groups)) {
    for (const path of paths) {
      const { calls, fs } = spyFs()
      const why = String(await refusal(path, { home, fs }))
      assert.equal(why, `${path} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`, `${group}: ${path}`)
      assert.deepEqual(calls, [], `${group}: ${path}`)
    }
  }
  // The age key file at its standard path, by name.
  const { fs } = spyFs()
  assert.match(String(await refusal('~/.config/sops/age/keys.txt', { home: '/home/kc', fs })), /looks like a key or password file/)
  // The control: ordinary names that only look close still reach the file system. A sign-in sheet is a paper list of
  // who came to a meeting, not a sign in to an account, so it goes on purpose; a list of sign-ins goes the same way.
  for (const path of [
    '/home/kc/docs/key results 2026.xlsx',
    '/home/kc/docs/keynote.pdf',
    '/home/kc/docs/house keys handover.docx',
    '/home/kc/docs/access keyboard guide.pdf',
    '/home/kc/docs/Sign-in sheet.pdf',
    '/home/kc/docs/event sign-ins.xlsx',
    '/home/kc/docs/signing bonus.pdf',
    '/home/kc/docs/token economy deck.pdf',
    '/home/kc/docs/login page mockup.png',
    '/home/kc/docs/change log insights.pdf',
    '/home/kc/docs/Secret Santa 2026.xlsx',
    '/home/kc/docs/secretary notes.docx',
    '/home/kc/docs/credentialing application.pdf',
    '/home/kc/docs/credentialed staff.pdf',
    '/home/kc/docs/seed round deck.pdf',
    '/home/kc/docs/sunflower seeds.jpg',
    '/home/kc/docs/cookie recipe.docx',
    '/home/kc/docs/envelope.pdf',
    '/home/kc/docs/my.environment notes.txt',
    '/home/kc/docs/3f2fa1c9.png',
    '/home/kc/code/sopsy/readme.txt',
  ]) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
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
  assert.match(why, /leads to a key or password file \(HOAI followed its links\), so it is never attached\. Do not copy, rename or retype it to send it another way; ask your owner\.$/, why)
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

/** Every name is refused in the secret sentence with no file system call, group by group; every control reaches it. */
async function namesRefusedLexically(groups: Record<string, string[]>, controls: string[]): Promise<void> {
  const home = 'C:\\Users\\kc'
  for (const [group, paths] of Object.entries(groups)) {
    for (const path of paths) {
      const { calls, fs } = spyFs()
      const why = String(await refusal(path, { home, fs }))
      assert.equal(why, `${path} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`, `${group}: ${path}`)
      assert.deepEqual(calls, [], `${group}: ${path}`)
    }
  }
  for (const path of controls) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
  }
}

test('review round 3: a name that ends with key or keys, a key backup, creds, a priv or root key and a pgp private file are refused lexically, each pattern on its own', async () => {
  await namesRefusedLexically(
    {
      'a name that ends with key or keys': [
        '/home/kc/Documents/stripe key.txt',
        '/home/kc/Documents/stripe_key.txt',
        '/home/kc/Documents/openai key.txt',
        'C:\\Users\\kc\\Downloads\\aws key.csv',
        '/home/kc/Downloads/gcp key.csv',
        '/home/kc/Documents/service account key.txt',
        '/home/kc/Documents/ssh key.txt',
        '/home/kc/Documents/ssh_key.txt',
        '/home/kc/Documents/ssh keys.docx',
        '/home/kc/Documents/gpg keys.txt',
        '/home/kc/Documents/my keys.txt',
        '/home/kc/Documents/wifi key.txt',
        '/home/kc/Documents/stripe-key.txt',
        '/home/kc/Documents/SSH Keys/laptop.txt',
        // A control word inside a longer word is not that word: bitlocker is not a locker, a backdoor not a door (the rig
        // sent BitLocker key.txt before this).
        '/home/kc/Documents/BitLocker key.txt',
        '/home/kc/Documents/backdoor key.txt',
        '/home/kc/Documents/minecar_key.txt',
      ],
      'a key backup, list, vault or ring': ['/home/kc/Documents/key backup.txt', '/home/kc/Documents/Keys Backup/a.txt', '/home/kc/Documents/key list.xlsx', '/home/kc/Documents/keyring.txt'],
      'creds as a word, in a file or a folder': [
        '/home/kc/Documents/creds.txt',
        '/home/kc/Documents/my creds.txt',
        'C:\\Users\\kc\\Downloads\\aws creds.csv',
        'C:\\Users\\kc\\Downloads\\kc_creds.csv',
        '/home/kc/Documents/creds/aws.txt',
      ],
      'a priv or root key': ['/home/kc/Documents/privkey.txt', '/home/kc/Documents/priv key.txt', 'C:\\Users\\kc\\Downloads\\rootkey.csv'],
      'a pgp, gpg or ssh private or secret file': ['/home/kc/Documents/pgp private.txt', '/home/kc/Documents/gpg-secret.txt', '/home/kc/Documents/ssh private.docx'],
    },
    [
      '/home/kc/docs/answer key.pdf',
      '/home/kc/docs/map key.png',
      '/home/kc/docs/house keys.docx',
      '/home/kc/docs/car keys.jpg',
      '/home/kc/docs/locker key.txt',
      '/home/kc/docs/keynote.pdf',
      '/home/kc/docs/key results 2026.xlsx',
      '/home/kc/docs/house keys handover.docx',
      '/home/kc/docs/keyboard shortcuts.pdf',
      '/home/kc/docs/monkey.png',
      '/home/kc/docs/credit report.pdf',
      '/home/kc/docs/incredible results.docx',
      '/home/kc/docs/privacy policy.pdf',
      '/home/kc/docs/root cause.docx',
      '/home/kc/docs/private dining menu.pdf',
    ],
  )
})

test('review round 3: a wallet, a wallet brand, recovery words, 12 to 24 words and a seeds file are refused lexically, each pattern on its own', async () => {
  await namesRefusedLexically(
    {
      'a name that is or ends with wallet': [
        '/home/kc/Documents/wallet.txt',
        '/home/kc/Documents/wallet.csv',
        '/home/kc/Documents/Crypto/wallet.txt',
        '/home/kc/Documents/crypto wallet.txt',
        '/home/kc/Documents/Wallets/notes.txt',
      ],
      'a wallet brand, or a ledger recovery, backup, seed or words file': [
        '/home/kc/Documents/metamask.txt',
        '/home/kc/Pictures/MetaMask backup.png',
        '/home/kc/Documents/trezor.txt',
        '/home/kc/Documents/ledger recovery.txt',
        '/home/kc/Pictures/ledger_seed.png',
      ],
      'recovery words or a recovery sheet, or a name that is just recovery': [
        '/home/kc/Documents/recovery.txt',
        '/home/kc/Documents/recovery words.txt',
        '/home/kc/Pictures/Ledger/recovery sheet.jpg',
      ],
      '12, 15, 18, 21 or 24 words': ['/home/kc/Documents/12 words.txt', '/home/kc/Documents/24 words.txt', '/home/kc/Pictures/24-words.png', '/home/kc/Documents/18_words.txt'],
      'a file or folder named just seeds': ['/home/kc/Documents/seeds.txt', '/home/kc/Pictures/Seeds/photo.jpg'],
    },
    [
      '/home/kc/docs/General Ledger 2026.xlsx',
      '/home/kc/docs/ledger.xlsx',
      '/home/kc/docs/wallet design.png',
      '/home/kc/docs/disaster recovery plan.pdf',
      '/home/kc/docs/recovery notes.txt',
      '/home/kc/docs/sunflower seeds.jpg',
      '/home/kc/docs/seed round deck.pdf',
      '/home/kc/docs/500 words essay.docx',
      '/home/kc/docs/1200 words.docx',
    ],
  )
})

test('review round 3: a home made password table is refused: short and foreign column names, a title or sep= line above, pipes', async (t) => {
  const home = scratchHome(t)
  for (const [name, header] of [
    ['short.csv', 'site,user,pass'],
    ['site list.csv', 'site,user,pw'],
    ['web.csv', 'Website,Username,Pwd'],
    ['sites.csv', 'Title,Login,Secret'],
    ['title list.csv', 'Title,Login,PIN'],
    ['de.csv', 'Name;Benutzername;Passwort'],
    ['fr.csv', 'site,identifiant,mot de passe'],
    ['es.csv', 'sitio,usuario,contraseña'],
    ['excel.csv', 'sep=,\nsite,user,password'],
    ['title.csv', 'My accounts 2026\n\nsite,user,password'],
    // The password column in the middle, so only a split on the pipe finds it.
    ['pipes.txt', 'Site | Password | Notes'],
  ]) {
    const path = join(home, 'docs', name)
    // A neutral data row: only the header can name the column.
    writeFileSync(path, `${header}\nExample,kc,rig dummy\n`)
    assert.equal(await refusal(path, { home }), `${path} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The control: a pass column with no user, login or site column beside it is a grade, not a password.
  const grades = join(home, 'docs', 'grades.csv')
  writeFileSync(grades, 'student,score,pass\nSam,81,yes\n')
  assert.equal(await refusal(grades, { home }), null)
})

test('review round 3: a password, passcode, api key or token written out in a text file is refused; prose and placeholders go', async (t) => {
  const home = scratchHome(t)
  for (const [name, text] of [
    ['notes.txt', 'Accounts\nGmail password: Rigdummy2026!\n'],
    ['wifi.txt', 'Home wifi\npasscode = rigdummy01\n'],
    ['api.txt', 'The api key: rigdummynotakeyrigdummynota\n'],
    ['router.csv', 'device,note\nrouter,Wifi PWD=rigdum99\n'],
    ['quoted.txt', 'token: "rigdum77"\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  const policy = join(home, 'docs', 'policy.txt')
  writeFileSync(
    policy,
    'The password must be at least twelve characters.\nPassword: ********\npassword: ${DB_PASSWORD}\npassword = changeme\ntoken: your_token_here\napi key: <your key>\nPassword: xxxxxxxx\n',
  )
  assert.equal(await refusal(policy, { home }), null)
})

/** A zip written by hand, with each entry deflated: enough of a Word or Excel file for isType and the text check. */
function zipOf(entries: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [entry, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    const body = deflateRawSync(data)
    const name = Buffer.from(entry, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const OFFICE_MAIN = {
  docx: ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  xlsx: ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
} as const

function officeTypes(kind: 'docx' | 'xlsx'): string {
  const [part, type] = OFFICE_MAIN[kind]
  return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="${part}" ContentType="${type}"/></Types>`
}

/** A Word file: one paragraph per line, split into runs at each `|` (Word splits a line into runs), and any tables. */
function docxOf(lines: string[], ...tables: string[][][]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const para = (line: string) => `<w:p>${line.split('|').map((run) => `<w:r><w:t xml:space="preserve">${esc(run)}</w:t></w:r>`).join('')}</w:p>`
  const tbl = (table: string[][]) => `<w:tbl><w:tblPr/>${table.map((row) => `<w:tr><w:trPr/>${row.map((cell) => `<w:tc><w:tcPr/>${para(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
  const body = `${lines.map(para).join('')}${tables.filter((table) => table.length > 0).map(tbl).join('<w:p/>')}`
  return zipOf({ '[Content_Types].xml': officeTypes('docx'), 'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>` })
}

/** An Excel file whose cells are these shared strings (no shared strings part when there are none). */
function xlsxOf(cells: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const parts: Record<string, string> = { '[Content_Types].xml': officeTypes('xlsx'), 'xl/workbook.xml': '<workbook/>' }
  if (cells.length > 0) parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst count="${cells.length}">${cells.map((c) => `<si><t>${esc(c)}</t></si>`).join('')}</sst>`
  return zipOf(parts)
}

/**
 * Round 5: an Excel file with real sheets (xl/worksheets/sheetN.xml), as Excel writes one: each cell a shared string
 * index (t="s"), or, with `inline`, an inline string (t="inlineStr"), as some generators write.
 */
function xlsxSheetsOf(sheets: string[][][], inline = false): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const shared: string[] = []
  const index = (s: string) => {
    if (!shared.includes(s)) shared.push(s)
    return shared.indexOf(s)
  }
  const parts: Record<string, string> = { '[Content_Types].xml': officeTypes('xlsx'), 'xl/workbook.xml': '<workbook/>' }
  sheets.forEach((rows, s) => {
    const xmlRows = rows
      .map((row, r) => {
        const cells = row.map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`
          return inline ? `<c r="${ref}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>` : `<c r="${ref}" s="1" t="s"><v>${index(cell)}</v></c>`
        })
        return `<row r="${r + 1}" spans="1:${row.length}">${cells.join('')}</row>`
      })
      .join('')
    parts[`xl/worksheets/sheet${s + 1}.xml`] = `<?xml version="1.0"?><worksheet><dimension ref="A1"/><cols><col min="1" max="3"/></cols><sheetData>${xmlRows}</sheetData></worksheet>`
  })
  // Round 6: the workbook's relationships, as Excel writes them: each sheet part is named there.
  parts['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, s) => `<Relationship Id="rId${s + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s + 1}.xml"/>`)
    .join('')}</Relationships>`
  if (shared.length > 0) parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((c) => `<si><t>${esc(c)}</t></si>`).join('')}</sst>`
  return zipOf(parts)
}

test('review round 3: a Word or Excel file is read for a password table, a key, a written password, a known secret and the agent\'s own credential', async (t) => {
  const home = scratchHome(t)
  const own = 'rig-dummy-pairing-token-not-a-key-0000'
  const sentence = (path: string, why: string) => `${path} ${why}, so it is never attached. ${NO_WAY_AROUND}`
  for (const [name, bytes, why] of [
    ['Accounts.xlsx', xlsxOf(['Site', 'Username', 'Password', 'example.com', 'kc', 'rig dummy not a password']), 'has a password column, so it looks like a password export and is never attached'],
    ['bank access.xlsx', xlsxOf(['Bank', 'Login', 'PIN', 'Harbor', 'kc', 'rig dummy']), 'has a password column, so it looks like a password export and is never attached'],
    ['netflix account.docx', docxOf(['My accounts'], [['Site', 'User', 'Password'], ['example.com', 'kc', 'rig dummy not a password']]), 'has a password column, so it looks like a password export and is never attached'],
    ['server.docx', docxOf(['Server notes', '-----BEGIN OPENSSH PRIVATE KEY-----', 'rig dummy, not a key', '-----END OPENSSH PRIVATE KEY-----']), 'holds a private key'],
    ['notes.docx', docxOf(['Accounts', 'Gmail pass|word: Rigdummy|2026!']), 'has a password or key written in it'],
    ['ci.xlsx', xlsxOf(['deploy', 'ghp_rigdummynotakeyrigdummy00']), 'holds a secret (it looks like github_token)'],
    ['pairing.docx', docxOf([`The pairing code: ${own}`]), 'holds this agent\'s own credential'],
  ] as const) {
    const path = join(home, 'docs', name)
    writeFileSync(path, bytes)
    const got = await refusal(path, { home, secrets: [own] })
    assert.equal(got, why.endsWith('never attached') ? `${path} ${why}. ${NO_WAY_AROUND}` : sentence(path, why), name)
  }
  // A part that would inflate past the cap is never inflated in full: it is refused, not passed unread.
  const huge = join(home, 'docs', 'huge.xlsx')
  writeFileSync(huge, zipOf({ '[Content_Types].xml': officeTypes('xlsx'), 'xl/workbook.xml': '<workbook/>', 'xl/sharedStrings.xml': Buffer.alloc(65 * MB, 0x20) }))
  assert.equal(await refusal(huge, { home }), `${huge} could not be read to check it for a password or key, so it is not attached.`)
  // Round 8: Word's main part is capped at 25 MB, the cap on a file's words (round 7), and refused as one past it.
  const hugeWord = join(home, 'docs', 'huge.docx')
  writeFileSync(hugeWord, zipOf({ '[Content_Types].xml': officeTypes('docx'), 'word/document.xml': Buffer.alloc(65 * MB, 0x20) }))
  assert.equal(await refusal(hugeWord, { home }), `${hugeWord} could not be read safely, so it is never attached.`)
  // The control: ordinary documents and sheets, and prose about passwords, still go.
  for (const [name, bytes] of [
    ['letter.docx', docxOf(['Dear Sam,', 'The password must be at least twelve characters.'], [['Item', 'Qty'], ['Chairs', '12']])],
    ['budget.xlsx', xlsxOf(['Item', 'Qty', 'Price', 'Chairs', 'Tables'])],
    ['numbers.xlsx', xlsxOf([])],
  ] as const) {
    const path = join(home, 'docs', name)
    writeFileSync(path, bytes)
    assert.equal(await refusal(path, { home, secrets: [own] }), null, name)
  }
})

test('review round 4: pw, pass, passcode, passkey, pin, a pw list, pin codes, a foreign password word and a disk encryption tool in a name are refused lexically, each pattern on its own', async () => {
  await namesRefusedLexically(
    {
      'pw, pass, passcode, passkey or pin as a whole word that ends the name': [
        '/home/kc/Documents/pw.txt',
        '/home/kc/Documents/pws.txt',
        '/home/kc/Documents/gmail pw.txt',
        '/home/kc/Documents/pass.txt',
        '/home/kc/Documents/wifi pass.txt',
        '/home/kc/Documents/passes.csv',
        '/home/kc/Documents/passcode.txt',
        '/home/kc/Documents/door_passcodes.txt',
        '/home/kc/Documents/passkey.txt',
        '/home/kc/Documents/passkeys.csv',
        '/home/kc/Documents/pin.txt',
        '/home/kc/Documents/bank pin.txt',
        '/home/kc/Documents/card-pins.csv',
        '/home/kc/Documents/Pins/notes.txt',
      ],
      'a pw list or pin codes': ['/home/kc/Documents/pw list.xlsx', '/home/kc/Documents/pw_list 2026.docx', '/home/kc/Documents/pin codes.txt', '/home/kc/Pictures/pin-codes photo.png'],
      'a password word in another language': [
        '/home/kc/Documents/Passwort.txt',
        '/home/kc/Documents/Passwörter.xlsx',
        '/home/kc/Documents/mots de passe.docx',
        '/home/kc/Documents/contraseñas.txt',
        '/home/kc/Documents/senhas.csv',
        '/home/kc/Documents/wachtwoorden.txt',
      ],
      'bitlocker, filevault or veracrypt anywhere in a name': [
        '/home/kc/Documents/BitLocker.txt',
        '/home/kc/Documents/bitlocker backup 2026.pdf',
        '/home/kc/Pictures/FileVault.png',
        '/home/kc/Documents/filevault notes.docx',
        '/home/kc/Documents/VeraCrypt/volume notes.txt',
        'C:\\Users\\kc\\Documents\\veracrypt header.txt',
      ],
    },
    [
      // A pass that boards a plane or opens a park, and a pin on a map, are not passwords.
      '/home/kc/docs/boarding pass.pdf',
      '/home/kc/docs/Boarding Passes 2026.pdf',
      '/home/kc/docs/Day Pass.pdf',
      '/home/kc/docs/season pass.png',
      '/home/kc/docs/final pass.docx',
      '/home/kc/docs/map pin.png',
      '/home/kc/docs/safety pins.jpg',
      '/home/kc/docs/compass.png',
      '/home/kc/docs/bypass notes.docx',
      '/home/kc/docs/passport scan.pdf',
      '/home/kc/docs/pass rates.xlsx',
      '/home/kc/docs/spin class.pdf',
      '/home/kc/docs/pinned notes.txt',
      '/home/kc/docs/pin board.jpg',
      '/home/kc/docs/pwa notes.pdf',
      '/home/kc/docs/senhora.pdf',
    ],
  )
})

test('review round 4: a pw, pass, pin, passcode, passkey or foreign password word written out is refused, with : = - is or a full width colon, or on the next line; boarding passes and test counts go', async (t) => {
  const home = scratchHome(t)
  for (const [name, text] of [
    ['gmail.txt', 'Accounts\nGmail pw: Rigdummy2026!\n'],
    ['wifi.txt', 'Home\nwifi pass = rigdummy01\n'],
    ['bank.txt', 'Bank PIN: 1234\n'],
    ['card.txt', 'card pin code - 9876\n'],
    ['door.txt', 'The door passcode is 13579\n'],
    ['webauthn.txt', 'passkey: rigdummy-not-real-01\n'],
    ['de.txt', 'Passwort: Rigdummy2026\n'],
    ['fr.txt', 'mot de passe : rigdummy2026\n'],
    ['es.txt', 'contraseña: rigdummy2026\n'],
    ['pt.txt', 'senha=rigdummy2026\n'],
    ['nl.txt', 'wachtwoord: rigdummy2026\n'],
    ['is.txt', 'My password is Rigdummy2026!\n'],
    ['dash.txt', 'Netflix password - Rigdummy2026\n'],
    ['wide.txt', 'password\uFF1ARigdummy2026\n'],
    ['nextline.txt', 'Gmail\npassword:\n\n  Rigdummy2026!\n'],
    ['nextline-crlf.txt', 'Bank\r\nPasswort:\r\n\r\nrigdummy2026\r\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The same vocabulary names a password column: passkey on its own, pin code beside an account column.
  for (const [name, header] of [
    ['webauthn list.csv', 'Site,Passkey,Notes'],
    ['bank list.csv', 'bank,user,pin code'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, `${header}\nExample,kc,rig dummy\n`)
    assert.equal(await refusal(path, { home }), `${path} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The same rule in a Word file.
  const word = join(home, 'docs', 'wifi note.docx')
  writeFileSync(word, docxOf(['Home', 'wifi pass: Rigdummy2026']))
  assert.equal(await refusal(word, { home }), `${word} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`)
  // The controls: a boarding pass, a day pass, a test count, prose about a password, a heading then a sentence, a PIN
  // that is not digits, and placeholders.
  const travel = join(home, 'docs', 'travel.txt')
  writeFileSync(
    travel,
    [
      'boarding pass: Gate 12',
      'Day pass: included',
      'Day pass: 2026-11-01',
      'pass: 6 of 8 tests',
      'Season pass: renewed',
      'The password is required.',
      'Your password is incorrect',
      'Passwords - Overview',
      'Password:',
      'Use at least twelve characters and a symbol.',
      'PIN: see the card',
      'pw: ********',
      'The password must be at least twelve characters.',
      '',
    ].join('\n'),
  )
  assert.equal(await refusal(travel, { home }), null)
})

test('review round 4: a BitLocker recovery key, or a recovery key written out in groups, is refused by its contents', async (t) => {
  const home = scratchHome(t)
  // Fake digits only: 123456 is not a multiple of 11, so no group here could be part of a real BitLocker key.
  const fake = '123456-123456-123456-123456-123456-123456-123456-123456'
  for (const [name, bytes] of [
    ['laptop.txt', `Laptop\nIdentifier: rig dummy\n${fake}\n`],
    ['disks.csv', `disk,note\nC,${fake}\n`],
    ['mac.txt', 'FileVault Recovery key: RIGD-UMMY-NOTA-KEYX-RIGD-UMMY\n'],
    ['grouped.txt', 'recovery key = RIGDUM NOTAKE YRIGDU MMYNOT\n'],
    ['laptop.docx', docxOf(['Laptop', fake])],
  ] as const) {
    const path = join(home, 'docs', name)
    writeFileSync(path, bytes)
    assert.equal(await refusal(path, { home }), `${path} holds a recovery key, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The controls: a recovery key named but not written, a shorter run of digits, prose.
  const notes = join(home, 'docs', 'it notes.txt')
  writeFileSync(notes, 'Recovery key: stored in the IT vault\nTicket 123456-123456\nRecovery key rotation is due in May.\n')
  assert.equal(await refusal(notes, { home }), null)
})

test('review round 4: the word rules read only the path below the home folder, so a home named after a person does not refuse every file; the fixed secret folders still match anywhere', async (t) => {
  const groups: [string, string[], string[], string[]][] = [
    [
      'C:\\Users\\John Key',
      ['C:\\Users\\John Key\\Documents\\report.pdf', 'c:/users/john key/Documents/report.pdf', '~\\Documents\\report.pdf', 'C:\\Users\\John Key\\Desktop\\Day Pass.pdf'],
      [
        'C:\\Users\\John Key\\.ssh\\id_rsa',
        'C:\\Users\\John Key\\.aws\\config',
        'C:\\Users\\John Key\\.claude\\notes.txt',
        'C:\\Users\\John Key\\.bgos-agent\\file.pdf',
        'C:\\Users\\John Key\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\notes.txt',
        'C:\\Users\\John Key\\code\\app\\.git\\config.txt',
      ],
      // A word below the home still refuses, and outside the home the whole path is read as before.
      ['C:\\Users\\John Key\\Documents\\stripe key.txt', 'C:\\Users\\Bob Key\\Documents\\report.pdf', 'D:\\John Key\\report.pdf'],
    ],
    [
      '/Users/amy.seed',
      ['/Users/amy.seed/Documents/report.pdf', '~/Documents/report.pdf'],
      ['/Users/amy.seed/.aws/config', '/Users/amy.seed/Library/Keychains/login.keychain-db', '/Users/amy.seed/.gnupg/pubring.kbx'],
      ['/Users/amy.seed/Documents/seed.txt', '/Users/bob.seed/Documents/report.pdf'],
    ],
    // A home inside a secret place (a home set to a folder in ~/.kube or a browser's User Data): the place, above the
    // home, still refuses every file in it. (lanePathIsSecret knows .claude on its own, so these are places only the
    // secret list knows.)
    ['C:\\Users\\kc\\.kube\\agent', [], ['C:\\Users\\kc\\.kube\\agent\\notes.pdf', 'C:\\Users\\kc\\.kube\\agent\\Documents\\report.pdf'], []],
    ['C:\\Users\\kc\\AppData\\Local\\Google\\Chrome\\User Data\\Default', [], ['C:\\Users\\kc\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\notes.txt'], []],
  ]
  for (const [home, pass, fixed, words] of groups) {
    for (const path of pass) {
      const { calls, fs } = spyFs()
      assert.match(String(await refusal(path, { home, fs })), /could not be found or read/, path)
      assert.ok(calls.length > 0, path)
    }
    for (const path of [...fixed, ...words]) {
      const { calls, fs } = spyFs()
      assert.equal(String(await refusal(path, { home, fs })), `${path} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`, path)
      assert.deepEqual(calls, [], path)
    }
  }
  // The daemon's own home (os.homedir(), which on Windows reads USERPROFILE) when no home is passed in.
  if (process.platform === 'win32') {
    const lib = await m()
    const before = process.env.USERPROFILE
    process.env.USERPROFILE = 'C:\\Users\\John Key'
    try {
      assert.equal(lib.outboundFileLexicalRefusal('C:\\Users\\John Key\\Documents\\report.pdf'), null)
      assert.match(String(lib.outboundFileLexicalRefusal('C:\\Users\\John Key\\.ssh\\id_rsa')), /looks like a key or password file/)
    } finally {
      process.env.USERPROFILE = before
    }
  }
  // All four steps on a real file: a scratch home named John Key, its report goes (realpath and the second check too).
  const root = mkdtempSync(join(tmpdir(), 'hoai-outbound-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'John Key')
  mkdirSync(join(home, 'Documents'), { recursive: true })
  const report = join(home, 'Documents', 'report.pdf')
  writeFileSync(report, PDF)
  assert.equal(await refusal(report, { home }), null)
  assert.equal(await refusal(join(home, 'Documents', 'stripe key.txt'), { home }), `${join(home, 'Documents', 'stripe key.txt')} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`)
})

test('review round 4: a Word or Excel part is found whatever the case of its name, as the type check finds it; a part that cannot be read is refused', async (t) => {
  const home = scratchHome(t)
  const docxBody = (text: string) => `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  const word = join(home, 'docs', 'notes.docx')
  writeFileSync(word, zipOf({ '[Content_Types].xml': officeTypes('docx'), 'Word/Document.xml': docxBody('Gmail password: Rigdummy2026!') }))
  assert.equal(await refusal(word, { home }), `${word} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`)
  const sheet = join(home, 'docs', 'Accounts.xlsx')
  writeFileSync(
    sheet,
    zipOf({
      '[Content_Types].xml': officeTypes('xlsx'),
      'xl/workbook.xml': '<workbook/>',
      'XL/SharedStrings.xml': '<sst><si><t>Site</t></si><si><t>Username</t></si><si><t>Password</t></si></sst>',
    }),
  )
  assert.equal(await refusal(sheet, { home }), `${sheet} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`)
  // A Word file's main part stored with a method HOAI cannot read is refused, never passed unread.
  const odd = zipOf({ '[Content_Types].xml': officeTypes('docx'), 'word/document.xml': docxBody('Gmail password: Rigdummy2026!') })
  const centralAt = odd.lastIndexOf(Buffer.from('word/document.xml')) - 46
  assert.equal(odd.readUInt32LE(centralAt), 0x02014b50)
  odd.writeUInt16LE(12, centralAt + 10)
  const oddPath = join(home, 'docs', 'odd.docx')
  writeFileSync(oddPath, odd)
  assert.equal(await refusal(oddPath, { home }), `${oddPath} could not be read to check it for a password or key, so it is not attached.`)
  // The control: a Word file with the same odd case part name and plain words goes.
  const plain = join(home, 'docs', 'letter.docx')
  writeFileSync(plain, zipOf({ '[Content_Types].xml': officeTypes('docx'), 'Word/Document.xml': docxBody('Dear Sam, the report is attached.') }))
  assert.equal(await refusal(plain, { home }), null)
})

test('review round 4: the vendored BIP39 English list is the published one (2048 words, its sha256)', async () => {
  const { createHash } = await import('node:crypto')
  const list = await import('../lib/bip39-english.ts')
  assert.equal(list.BIP39_ENGLISH_WORDS.length, 2048)
  assert.equal(new Set(list.BIP39_ENGLISH_WORDS).size, 2048)
  const hash = createHash('sha256').update(`${list.BIP39_ENGLISH_WORDS.join('\n')}\n`).digest('hex')
  assert.equal(hash, '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda')
  assert.equal(list.BIP39_ENGLISH_SHA256, hash)
})

test('review round 4: a text, Word or Excel file that holds a run of 12 or more BIP39 words is refused as a wallet recovery phrase', async (t) => {
  const home = scratchHome(t)
  // Only runs that repeat one or two list words (none is a valid phrase: their checksums fail), never a phrase that
  // could be real.
  const twelve = Array(12).fill('zoo').join(' ')
  const eighteen = Array(9).fill('wolf zoo').join(' ')
  const numbered = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${i % 2 === 0 ? 'wolf' : 'zoo'}`).join('\n')
  for (const [name, bytes] of [
    ['notes.txt', `Notes\n${twelve}\n`],
    ['backup.csv', `n,word\n${Array.from({ length: 24 }, (_, i) => `${i + 1},zoo`).join('\n')}\n`],
    ['numbered.txt', `${numbered}\n`],
    ['spaced.txt', `My Words\n\n${eighteen.toUpperCase()}\n`],
    ['notes.docx', docxOf(['Notes', twelve])],
    ['cells.xlsx', xlsxOf(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'wolf' : 'zoo')))],
  ] as const) {
    const path = join(home, 'docs', name)
    writeFileSync(path, bytes)
    assert.equal(await refusal(path, { home }), `${path} holds a wallet recovery phrase, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
  // The controls: eleven list words then a word not on the list, and ordinary prose (most of its words are on the
  // list, but the, of, and, is and to are not).
  const short = join(home, 'docs', 'short.txt')
  writeFileSync(short, `${Array(11).fill('zoo').join(' ')} rigdummy ${Array(11).fill('wolf').join(' ')}\n`)
  assert.equal(await refusal(short, { home }), null)
  const prose = join(home, 'docs', 'letter.txt')
  writeFileSync(prose, 'Dear Sam, the quarterly report is attached. Our team will review the budget and the travel plan for the spring event, and we can talk about it on Monday.\n')
  assert.equal(await refusal(prose, { home }), null)
})

test('review round 5: a Word or Excel table is judged row by row, as a CSV is: a gradebook, a QA tracker, an inspection log, an inventory and a CRM go; a password table is still refused', async (t) => {
  const home = scratchHome(t)
  const tableSentence = (path: string) => `${path} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`
  // The controls: in each, a pass, pin or secret word and an account word are cells of the same file, never of one row.
  const controls: Record<string, string[][]> = {
    gradebook: [['Student', 'Email', 'Result'], ['Sam Lee', 'sam@example.com', 'Pass'], ['Ana Ruiz', 'ana@example.com', 'Fail']],
    'qa tracker': [['Test case', 'URL', 'Result'], ['Home page loads', 'https://example.com/', 'Pass'], ['Cart totals', 'https://example.com/cart', 'Pass']],
    'inspection log': [['Site', 'Outcome'], ['Harbor St', 'Pass'], ['Mill Rd', 'Fail']],
    inventory: [['Item', 'Account', 'Qty'], ['Pins', 'Office', '40'], ['Staples', 'Office', '12']],
    crm: [['Name', 'Email', 'Status'], ['Project Falcon', 'falcon@example.com', 'Secret'], ['Sam Lee', 'sam@example.com', 'Open']],
  }
  for (const [name, rows] of Object.entries(controls)) {
    for (const [file, bytes] of [
      [`${name}.xlsx`, xlsxSheetsOf([rows])],
      [`${name} inline.xlsx`, xlsxSheetsOf([rows], true)],
      [`${name}.docx`, docxOf([name], rows)],
    ] as const) {
      const path = join(home, 'docs', file)
      writeFileSync(path, bytes)
      assert.equal(await refusal(path, { home }), null, file)
    }
  }
  // The control: a Word file with a test table (Login page | Pass) and a contacts table (Contact | Email).
  const twoTables = join(home, 'docs', 'release notes.docx')
  writeFileSync(twoTables, docxOf(['Release notes'], [['Check', 'Result'], ['Login page', 'Pass']], [['Contact', 'Email'], ['Sam Lee', 'sam@example.com']]))
  assert.equal(await refusal(twoTables, { home }), null)
  // A password table is still refused, in its header row, in a title row's sheet, on a second sheet, inline, or in a
  // Word file's second table.
  const accounts = [['Site', 'Username', 'Password'], ['example.com', 'kc', 'rig dummy']]
  const filler = Array.from({ length: 40000 }, () => [randomBytes(24).toString('hex')])
  const big = xlsxSheetsOf([[...accounts, ['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ...filler]], true)
  assert.ok(big.length > 1.1 * MB, `big.xlsx is ${big.length} bytes`)
  for (const [file, bytes] of [
    ['Accounts.xlsx', xlsxSheetsOf([accounts])],
    ['bank access.xlsx', xlsxSheetsOf([[['Bank', 'Login', 'PIN'], ['Harbor', 'kc', 'rig dummy']]])],
    ['titled.xlsx', xlsxSheetsOf([[['My accounts 2026'], [], ['Site', 'User', 'Password'], ['example.com', 'kc', 'rig dummy']]])],
    ['second sheet.xlsx', xlsxSheetsOf([[['Item', 'Qty'], ['Chairs', '12']], accounts])],
    ['inline accounts.xlsx', xlsxSheetsOf([accounts], true)],
    // A sheet whose packed part is past the 1 MB head read: its first rows are still read, from the head alone.
    ['big.xlsx', big],
    ['sites.docx', docxOf(['Accounts'], [['Website', 'Login', 'Password'], ['example.com', 'kc', 'rig dummy']])],
    ['second table.docx', docxOf(['Notes'], [['Item', 'Qty'], ['Chairs', '12']], [['Site', 'User', 'Pass'], ['example.com', 'kc', 'rig dummy']])],
  ] as const) {
    const path = join(home, 'docs', file)
    writeFileSync(path, bytes)
    assert.equal(await refusal(path, { home }), tableSentence(path), file)
  }
})

test('review round 5: a count after tokens or api key, and Pins: 1500, are not a written secret; a password of digits still is', async (t) => {
  const home = scratchHome(t)
  const counts = join(home, 'docs', 'usage.txt')
  writeFileSync(counts, 'Model usage\nInput tokens: 1,234,567\nOutput tokens = 98765\nAPI key: 12345678\nPins: 1500\n')
  assert.equal(await refusal(counts, { home }), null)
  const counts2 = join(home, 'docs', 'usage.docx')
  writeFileSync(counts2, docxOf(['Model usage', 'Input tokens: 1,234,567', 'Pins: 1500']))
  assert.equal(await refusal(counts2, { home }), null)
  for (const [name, text] of [
    ['digits.txt', 'Gmail password: 20261028\n'],
    ['deploy.txt', 'token: rigdum0000001\n'],
    ['card.txt', 'Card PIN: 4321\n'],
  ]) {
    const path = join(home, 'docs', name)
    writeFileSync(path, text)
    assert.equal(await refusal(path, { home }), `${path} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`, name)
  }
})

test('review round 5: a link whose name is a safe type but whose real file is not (notes.txt to x.conf) is refused', async (t) => {
  const home = scratchHome(t)
  const real = join(home, 'docs', 'x.conf')
  writeFileSync(real, 'rig dummy config\n')
  const link = join(home, 'docs', 'notes.txt')
  // realpath answers as it would for a link (a file link needs a right on Windows); lstat and open read the real file.
  const via = (target: string) => ({ realpath: async () => target })
  assert.equal(await refusal(link, { home, fs: via(real) }), `${link} is a link to a file that cannot be attached; only PDF, pictures (PNG, JPG, GIF, WebP), text (TXT, CSV), Word (DOCX) and Excel (XLSX) files are.`)
  // A link to a file of another safe type is refused too: the type is the real file's.
  const pdf = join(home, 'docs', 'q3.pdf')
  writeFileSync(pdf, PDF)
  assert.match(String(await refusal(link, { home, fs: via(pdf) })), /is a link to a file that cannot be attached/)
  // The controls: a link to a file of the same type (notes.txt to notes.csv, photo.jpeg to photo.jpg) goes.
  const csv = join(home, 'docs', 'notes.csv')
  writeFileSync(csv, 'item,qty\nchairs,12\n')
  assert.equal(await refusal(link, { home, fs: via(csv) }), null)
  // A real link, where this computer allows one.
  const realLink = join(home, 'docs', 'readme.txt')
  let linked = true
  try {
    symlinkSync(real, realLink, 'file')
  } catch {
    linked = false
  }
  if (linked) assert.match(String(await refusal(realLink, { home })), /is a link to a file that cannot be attached/)
})

test('review round 5: browser, credential store and shell history places are refused lexically, each pattern on its own', async () => {
  await namesRefusedLexically(
    {
      'opera software': ['C:\\Users\\kc\\AppData\\Roaming\\Opera Software\\Opera Stable\\notes.txt'],
      'snap chromium or firefox': ['/home/kc/snap/chromium/common/chromium/Default/notes.txt', '/home/kc/snap/firefox/common/notes.txt'],
      'flatpak .var/app': ['/home/kc/.var/app/org.mozilla.firefox/data/notes.txt', '/home/kc/.var/app/com.google.Chrome/notes.txt'],
      'library/safari': ['/Users/kc/Library/Safari/notes.txt'],
      'library/cookies': ['/Users/kc/Library/Cookies/notes.txt'],
      'appdata microsoft protect, vault, credentials': [
        'C:\\Users\\kc\\AppData\\Roaming\\Microsoft\\Protect\\notes.txt',
        'C:\\Users\\kc\\AppData\\Local\\Microsoft\\Vault\\notes.txt',
        'C:\\Users\\kc\\AppData\\Roaming\\Microsoft\\Credentials\\notes.txt',
      ],
      'psreadline history': ['C:\\Users\\kc\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt'],
      'shell history': ['/home/kc/.bash_history', '/home/kc/.zsh_history', 'C:\\Users\\kc\\.python_history'],
    },
    [
      'C:\\Users\\kc\\Documents\\Opera tickets.pdf',
      '/home/kc/snap/code/notes.txt',
      '/home/kc/var/app/notes.txt',
      '/Users/kc/Library/Safari Notes/plan.pdf',
      'C:\\Users\\kc\\AppData\\Local\\Microsoft\\Teams\\notes.txt',
      '/home/kc/Documents/chat_history.pdf',
      '/home/kc/Documents/history.txt',
    ],
  )
})

// ── review round 6: a Word or Excel file is read in bounded time and memory ──

/** Round 6: one file held in memory (a hostile zip is never written to disk): realpath, lstat and open answer it. */
function memFs(bytes: Buffer) {
  const stat = { isFile: () => true, size: bytes.length, dev: 1, ino: 7 }
  return {
    realpath: async (path: string) => path,
    lstat: async () => stat,
    open: async () => ({
      stat: async () => stat,
      read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const n = Math.max(0, Math.min(length, bytes.length - position))
        buffer.set(bytes.subarray(position, position + n), offset)
        return { bytesRead: n }
      },
      close: async () => {},
    }),
  }
}

const MEM_HOME = 'C:\\Users\\kc'

/** Round 6: the refusal of one file held in memory, and how long it took. */
async function memRefusal(name: string, bytes: Buffer, extra: Record<string, unknown> = {}): Promise<{ path: string; why: string | null; ms: number }> {
  const path = `${MEM_HOME}\\Documents\\${name}`
  const started = performance.now()
  const why = await refusal(path, { home: MEM_HOME, fs: memFs(bytes), ...extra })
  return { path, why, ms: performance.now() - started }
}

const unsafeSentence = (path: string) => `${path} could not be read safely, so it is never attached.`
const tableSentence6 = (path: string) => `${path} has a password column, so it looks like a password export and is never attached. ${NO_WAY_AROUND}`
const unreadSentence = (path: string) => `${path} could not be read to check it for a password or key, so it is not attached.`

interface ZipPart {
  name: string
  data: Buffer
  stored?: boolean
}
/** One more central entry that points at part `of`'s local entry, `skip` bytes into it, with these sizes. */
interface ZipAlias {
  name: string
  of: number
  skip?: number
  method?: number
  packed?: number
  size?: number
}

/** Round 6: one local entry (header, name, body), deflated unless stored. */
function localEntry(part: ZipPart): { bytes: Buffer; method: number; packed: number; size: number; crc: number } {
  const method = part.stored ? 0 : 8
  const body = part.stored ? part.data : deflateRawSync(part.data)
  const name = Buffer.from(part.name, 'utf8')
  const crc = crc32(part.data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(part.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  return { bytes: Buffer.concat([local, name, body]), method, packed: body.length, size: part.data.length, crc }
}

/**
 * Round 6: a zip from parts (each a local and a central entry) and aliases (more central entries that point into a
 * part's local entry), as the reviewer's shared blob workbook is built. In memory only.
 */
function zipRaw(parts: ZipPart[], aliases: ZipAlias[] = []): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const placed: { at: number; method: number; packed: number; size: number; crc: number }[] = []
  let offset = 0
  const central = (name: string, method: number, crc: number, packed: number, size: number, at: number) => {
    const bytes = Buffer.from(name, 'utf8')
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(packed, 20)
    c.writeUInt32LE(size, 24)
    c.writeUInt16LE(bytes.length, 28)
    c.writeUInt32LE(at, 42)
    centrals.push(c, bytes)
  }
  for (const part of parts) {
    const entry = localEntry(part)
    locals.push(entry.bytes)
    placed.push({ at: offset, ...entry })
    central(part.name, entry.method, entry.crc, entry.packed, entry.size, offset)
    offset += entry.bytes.length
  }
  for (const alias of aliases) {
    const of = placed[alias.of]!
    central(alias.name, alias.method ?? of.method, of.crc, alias.packed ?? of.packed, alias.size ?? of.size, of.at + (alias.skip ?? 0))
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const XLSX_BASE: ZipPart[] = [
  { name: '[Content_Types].xml', data: Buffer.from(officeTypes('xlsx')) },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
]
const sheetXml = (rows: string) => Buffer.from(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`)
const inlineRow = (r: number, cells: string[]) =>
  `<row r="${r}">${cells.map((cell, c) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`
const docxRaw = (body: string) =>
  zipRaw([
    { name: '[Content_Types].xml', data: Buffer.from(officeTypes('docx')) },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`) },
  ])

test('review round 6: a workbook whose sheet entries share one local entry, or overlap another, is refused at once (the reviewer\'s 1997 sheet probe, shrunk)', async () => {
  // 300 sheet entries that all point at ONE local entry: 4 MB of spaces, about 4 KB packed. Read one by one, that is
  // 1.2 GB inflated.
  const blob = Buffer.alloc(4 * MB, 0x20)
  const shared = zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet0.xml', data: blob }], Array.from({ length: 300 }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, of: 2 })))
  const a = await memRefusal('book.xlsx', shared)
  assert.ok(a.ms < 1000, `book.xlsx took ${Math.round(a.ms)} ms`)
  assert.equal(a.why, unsafeSentence(a.path))
  // Two sheet entries at the same local offset.
  const twice = zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Item', 'Qty'])) }], [{ name: 'xl/worksheets/sheet2.xml', of: 2 }])
  const b = await memRefusal('twice.xlsx', twice)
  assert.equal(b.why, unsafeSentence(b.path))
  // A sheet whose local entry sits inside another entry's stored bytes.
  const inner = localEntry({ name: 'xl/worksheets/sheet2.xml', data: sheetXml(inlineRow(1, ['Item', 'Qty'])) })
  const host = 'xl/media/image1.bin'
  const nested = zipRaw(
    [...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Item', 'Qty'])) }, { name: host, data: inner.bytes, stored: true }],
    [{ name: 'xl/worksheets/sheet2.xml', of: 3, skip: 30 + host.length, method: 8, packed: inner.packed, size: inner.size }],
  )
  const c = await memRefusal('nested.xlsx', nested)
  assert.equal(c.why, unsafeSentence(c.path))
  // The control: the same workbook with its sheets apart goes.
  const apart = zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Item', 'Qty'])) }, { name: 'xl/worksheets/sheet2.xml', data: sheetXml(inlineRow(1, ['Item', 'Qty'])) }])
  assert.equal((await memRefusal('apart.xlsx', apart)).why, null)
})

test('review round 6: at most 64 sheets are judged; a workbook with more is refused', async () => {
  const many = (n: number) => zipRaw([...XLSX_BASE, ...Array.from({ length: n }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(inlineRow(1, ['Item', 'Qty'])) }))])
  assert.equal((await memRefusal('64 sheets.xlsx', many(64))).why, null)
  const over = await memRefusal('65 sheets.xlsx', many(65))
  assert.equal(over.why, unsafeSentence(over.path))
})

test('review round 6: one inflate budget for the whole file (64 MB over every part) is refused when spent; only the head of each sheet is inflated, so tall sheets still go', async () => {
  // 60 MB of shared strings and five 2 MB sheets: 65 MB inflated in all, past the budget.
  const sst = Buffer.concat([Buffer.from('<sst><si><t>Item</t></si><si><t>'), Buffer.alloc(60 * MB, 0x20), Buffer.from('</t></si></sst>')])
  const spaces = sheetXml(' '.repeat(2 * MB))
  const spent = zipRaw([...XLSX_BASE, { name: 'xl/sharedStrings.xml', data: sst }, ...Array.from({ length: 5 }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: spaces }))])
  const a = await memRefusal('spent.xlsx', spent)
  assert.equal(a.why, unsafeSentence(a.path))
  // Two sheets, each a header row on top of 40 MB (about 40 KB packed): only each head is inflated, so they go,
  // quickly, and a password header on top of such a sheet is still found.
  const tall = (header: string[]) => sheetXml(inlineRow(1, header) + ' '.repeat(40 * MB))
  const two = zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: tall(['Student', 'Email', 'Result']) }, { name: 'xl/worksheets/sheet2.xml', data: tall(['Item', 'Qty']) }])
  const b = await memRefusal('tall.xlsx', two)
  assert.equal(b.why, null)
  assert.ok(b.ms < 1500, `tall.xlsx took ${Math.round(b.ms)} ms`)
  const c = await memRefusal('tall accounts.xlsx', zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: tall(['Site', 'Username', 'Password']) }]))
  assert.equal(c.why, tableSentence6(c.path))
})

test('review round 6: unclosed rows, cells, values, shared strings, Word rows, cells and tables, and an unclosed tag are scanned in linear time; a real table before them is still read', async () => {
  const xlsxRaw = (sheet: string, sst?: string) =>
    zipRaw([...XLSX_BASE, ...(sst === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]), { name: 'xl/worksheets/sheet1.xml', data: sheetXml(sheet) }])
  // About 200 KB of one opening tag, never closed.
  const junk = (tag: string) => tag.repeat(Math.floor((200 * 1024) / tag.length))
  const wordCell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
  const sharedRow = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
  for (const [name, bytes, sentence] of [
    ['rows.xlsx', xlsxRaw(junk('<row>')), null],
    ['prefixed rows.xlsx', xlsxRaw(junk('<x:row>')), null],
    ['cells.xlsx', xlsxRaw(`<row r="1">${junk('<c>')}</row>`), null],
    ['values.xlsx', xlsxRaw(`<row r="1"><c r="A1">${junk('<v>')}</c></row>`), null],
    ['strings.xlsx', xlsxRaw(inlineRow(1, ['Item']), `<sst>${junk('<si>')}</sst>`), null],
    ['word rows.docx', docxRaw(`<w:tbl>${junk('<w:tr>')}</w:tbl>`), null],
    ['word cells.docx', docxRaw(`<w:tbl><w:tr>${junk('<w:tc>')}</w:tr></w:tbl>`), null],
    ['word tables.docx', docxRaw(junk('<w:tbl>')), null],
    // A run of '<' with no '>' after it in its paragraph or its shared string.
    ['tags.docx', docxRaw(`<w:p><w:r><w:t>${junk('<')}</w:p>`), null],
    ['tags.xlsx', xlsxRaw(inlineRow(1, ['Item']), `<sst><si><t>${junk('<')}</si></sst>`), null],
    // A real table, then the junk: the table is still read.
    ['accounts then rows.xlsx', xlsxRaw(inlineRow(1, ['Site', 'Username', 'Password']) + inlineRow(2, ['example.com', 'kc', 'rig dummy']) + junk('<row>')), tableSentence6],
    ['accounts then strings.xlsx', xlsxRaw(sharedRow, `<sst><si><t>Site</t></si><si><t>User</t></si><si><t>Password</t></si>${junk('<si>')}</sst>`), tableSentence6],
    ['sites then rows.docx', docxRaw(`<w:tbl><w:tr>${wordCell('Site')}${wordCell('User')}${wordCell('Pass')}</w:tr>${junk('<w:tr>')}</w:tbl>`), tableSentence6],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.ok(got.ms < 300, `${name} took ${Math.round(got.ms)} ms`)
    assert.equal(got.why, sentence === null ? null : sentence(got.path), name)
  }
})

test('review round 6: reading one Word or Excel file\'s words has a wall clock budget (round 7: an injected budget, as the clock now runs in the Worker); past it the file is refused', async () => {
  const gradebook = [['Student', 'Email', 'Result'], ['Sam Lee', 'sam@example.com', 'Pass'], ['Ana Ruiz', 'ana@example.com', 'Fail']]
  for (const [name, bytes] of [
    ['gradebook.docx', docxOf(['Grades'], gradebook)],
    ['gradebook.xlsx', xlsxSheetsOf([gradebook])],
  ] as const) {
    // A budget already spent when the read starts: the clock is checked inside the read, so the file is refused.
    const slow = await memRefusal(name, bytes, { officeReadMs: -1 })
    assert.equal(slow.why, unsafeSentence(slow.path), name)
    // The control: the same file under the default budget goes.
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

test('review round 6: Pins, the plural, is not a password column (Item | Pins | Site goes); Bank | Login | PIN is still refused', async () => {
  const pins = [['Item', 'Pins', 'Site'], ['Board A', '40', 'Harbor St']]
  for (const [name, bytes] of [
    ['stock.csv', Buffer.from('Item,Pins,Site\nBoard A,40,Harbor St\n')],
    ['stock.xlsx', xlsxSheetsOf([pins])],
    ['stock.docx', docxOf(['Stock'], pins)],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
  const bank = [['Bank', 'Login', 'PIN'], ['Harbor', 'kc', 'rig dummy']]
  for (const [name, bytes] of [
    ['bank.csv', Buffer.from('Bank,Login,PIN\nHarbor,kc,rig dummy\n')],
    ['bank.xlsx', xlsxSheetsOf([bank])],
    ['bank.docx', docxOf(['Bank'], bank)],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
})

test('review round 6: the sheets the workbook\'s relationships name are read wherever they are; with no relationships part the shared strings no judged row read are judged too', async () => {
  const sst = Buffer.from('<sst><si><t>Site</t></si><si><t>User</t></si><si><t>Password</t></si><si><t>example.com</t></si><si><t>kc</t></si><si><t>rig dummy</t></si></sst>')
  const cell = (ref: string, index: number) => `<c r="${ref}" t="s"><v>${index}</v></c>`
  const real = sheetXml(`<row r="1">${cell('A1', 0)}${cell('B1', 1)}${cell('C1', 2)}</row><row r="2">${cell('A2', 3)}${cell('B2', 4)}${cell('C2', 5)}</row>`)
  const rels = (target: string) =>
    Buffer.from(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`,
    )
  // A decoy empty sheet where sheets usually are, and the real one at xl/s.xml.
  const book = (extra: ZipPart[]) =>
    zipRaw([...XLSX_BASE, { name: 'xl/sharedStrings.xml', data: sst }, { name: 'xl/worksheets/a.xml', data: sheetXml('') }, { name: 'xl/s.xml', data: real }, ...extra])
  for (const [name, bytes] of [
    ['decoy.xlsx', book([{ name: 'xl/_rels/workbook.xml.rels', data: rels('s.xml') }])],
    ['decoy absolute.xlsx', book([{ name: 'xl/_rels/workbook.xml.rels', data: rels('/xl/s.xml') }])],
    ['decoy no rels.xlsx', book([])],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // A sheet the relationships name that is not in the file is refused, never passed unread.
  const gone = await memRefusal('gone.xlsx', book([{ name: 'xl/_rels/workbook.xml.rels', data: rels('worksheets/gone.xml') }]))
  assert.equal(gone.why, unreadSentence(gone.path))
  // The control: a QA tracker with its relationships, whose Login and Pass cells are only below the first rows, goes.
  const tracker = [['Test case', 'URL', 'Result'], ...Array.from({ length: 6 }, (_, i) => [`Search ${i}`, 'https://example.com/', 'Fail']), ['Login', 'https://example.com/login', 'Pass']]
  assert.equal((await memRefusal('tracker.xlsx', xlsxSheetsOf([tracker]))).why, null)
})

test('review round 6: a Word table\'s first column and column A of a sheet\'s first rows are judged as one row: Bank, Login, PIN down a column is refused', async () => {
  const down = [['Bank', 'Chase'], ['Login', 'bob'], ['PIN', '4321']]
  for (const [name, bytes] of [
    ['bank.docx', docxOf(['My bank'], down)],
    ['bank second table.docx', docxOf(['Notes'], [['Item', 'Qty'], ['Chairs', '12']], down)],
    ['bank.xlsx', xlsxSheetsOf([down])],
    ['bank inline.xlsx', xlsxSheetsOf([down], true)],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // The controls: a gradebook, a QA tracker and an inventory (Pins in its first column) go.
  const controls: Record<string, string[][]> = {
    gradebook: [['Student', 'Email', 'Result'], ['Sam Lee', 'sam@example.com', 'Pass'], ['Ana Ruiz', 'ana@example.com', 'Fail']],
    'qa tracker': [['Test case', 'URL', 'Result'], ['Home page loads', 'https://example.com/', 'Pass'], ['Cart totals', 'https://example.com/cart', 'Pass']],
    inventory: [['Item', 'Account', 'Qty'], ['Pins', 'Office', '40'], ['Staples', 'Office', '12']],
  }
  for (const [name, rows] of Object.entries(controls)) {
    for (const [file, bytes] of [
      [`${name}.xlsx`, xlsxSheetsOf([rows])],
      [`${name}.docx`, docxOf([name], rows)],
    ] as const) {
      assert.equal((await memRefusal(file, bytes)).why, null, file)
    }
  }
})

// ── review round 7: the content stage runs in a Worker with a hard deadline ──

/** Round 7: the Worker deadline the content stage runs under (OUTBOUND_CONTENT_DEADLINE_MS). */
const R7_DEADLINE_MS = 5000

/**
 * Round 7: the refusal of one file held in memory, timed in real time, with a heartbeat on the main thread: the
 * longest gap between two ticks of a 10 ms interval while the check ran.
 */
async function heartbeatRefusal(name: string, bytes: Buffer, extra: Record<string, unknown> = {}): Promise<{ path: string; why: string | null; ms: number; maxGap: number }> {
  let maxGap = 0
  let last = performance.now()
  const beat = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 10)
  try {
    const got = await memRefusal(name, bytes, extra)
    maxGap = Math.max(maxGap, performance.now() - last)
    return { ...got, maxGap }
  } finally {
    clearInterval(beat)
  }
}

/**
 * Final fix 4: how long a check stopped the main thread, read over rounds, so a loaded runner does not turn a test red
 * with no code cause (seen on healthy code, once each: 116, 124, 127 and 257 ms against a limit of 100). A first round
 * within the limit settles it, so a green run costs one round. Past it, the check runs twice more and the answer is the
 * median of the three: noise comes once, and a main thread the code really stops is stopped every round, so the limit
 * stays where it was and the test stays red on the slow code it guards.
 */
async function stopOf(round: () => Promise<number>, limit = 100): Promise<number> {
  const first = await round()
  if (first <= limit) return first
  return [first, await round(), await round()].sort((a, b) => a - b)[1]!
}

/** Round 7: a CSV of one digit per line, `size` bytes, built in memory. */
function digitLines(size: number): Buffer {
  const out = Buffer.alloc(size)
  for (let at = 0; at + 1 < size; at += 2) {
    out[at] = 0x30 + ((at / 2) % 10)
    out[at + 1] = 0x0a
  }
  return out
}

const R7_GRADEBOOK = [['Student', 'Email', 'Result'], ['Sam Lee', 'sam@example.com', 'Pass'], ['Ana Ruiz', 'ana@example.com', 'Fail']]

test('review round 7: the four hostile inputs each settle within the Worker deadline plus 1 s, and the main thread never stops for more than 100 ms', { timeout: 120_000 }, async () => {
  for (const [name, build] of [
    ['jwt run.txt', () => Buffer.from('-eyJ'.repeat(20000))],
    ['dots.txt', () => Buffer.from(`pwd: ${'.'.repeat(80000)}a`)],
    ['digits.csv', () => digitLines(23 * MB)],
    ['aws run.docx', () => docxRaw(`<w:p><w:r><w:t>${'=aws'.repeat(15_000_000)}</w:t></w:r></w:p>`)],
  ] as const) {
    const bytes = build()
    const stop = await stopOf(async () => {
      const got = await heartbeatRefusal(name, bytes)
      assert.ok(got.ms <= R7_DEADLINE_MS + 1000, `${name} took ${Math.round(got.ms)} ms`)
      return got.maxGap
    })
    assert.ok(stop <= 100, `${name} stopped the main thread for ${Math.round(stop)} ms`)
  }
})

test('review round 7 (round 8: the deadline grows with the file): text the checks take long on is given 5 s plus 1 s per MB, and the main thread keeps running', { timeout: 90_000 }, async (t) => {
  const lib = await m()
  const { pathToFileURL } = await import('node:url')
  // A Worker that takes 7 s on every file: an 8 MB file (deadline 13 s) goes, a small one (5 s) is refused at 5 s.
  const dir = join(scratchHome(t), 'workers')
  mkdirSync(dir, { recursive: true })
  const slow = join(dir, 'slow.mjs')
  writeFileSync(slow, `import { parentPort } from 'node:worker_threads'
parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage({ id: m.id, verdict: { kind: 'ok' }, buffer: m.buffer, length: m.length }, [m.buffer]), 7000))
`)
  const big = await heartbeatRefusal('big.txt', Buffer.alloc(8 * MB, 0x61), { contentWorker: pathToFileURL(slow) })
  assert.equal(big.why, null, `big.txt after ${Math.round(big.ms)} ms`)
  assert.ok(big.ms >= 6900 && big.ms < 9000, `big.txt took ${Math.round(big.ms)} ms`)
  const small = await heartbeatRefusal('small.txt', Buffer.from('Plan for Monday.\n'), { contentWorker: pathToFileURL(slow) })
  assert.equal(small.why, unsafeSentence(small.path))
  assert.ok(small.ms >= R7_DEADLINE_MS - 100 && small.ms < R7_DEADLINE_MS + 1000, `small.txt was refused after ${Math.round(small.ms)} ms`)
  // Round 8: 5 s plus 1 s per MB, at most 40 s.
  assert.equal(typeof lib.outboundContentDeadlineMs, 'function', 'outboundContentDeadlineMs is exported')
  assert.deepEqual(
    [0, 1, MB, 8 * MB, 25 * MB, 100 * MB].map((size) => lib.outboundContentDeadlineMs(size)),
    [5000, 5001, 6000, 13000, 30000, 40000],
  )
  // Round 8: the budget for reading a Word or Excel file's words grows with it too, 3 s inside the deadline.
  const C = await import('../lib/email-outbound-content.ts')
  assert.deepEqual([0, MB, 6 * MB, 25 * MB, 100 * MB].map((size) => C.officeReadBudgetMs(size)), [2000, 3000, 8000, 27000, 37000])
  // 8 MB of '=aws' and a closing dot: each position costs the aws_secret_access_key rule a bounded but long try that
  // finds nothing (about 7 s under node with tsx; round 7 refused it at its 5 s deadline). Its deadline is now 13 s.
  const stop = await stopOf(async () => {
    const got = await heartbeatRefusal('slow.txt', Buffer.from(`${'=aws'.repeat(2 * 1024 * 1024)}.`))
    assert.equal(got.why, null)
    assert.ok(got.ms <= 13_000 + 1000, `slow.txt took ${Math.round(got.ms)} ms`)
    return got.maxGap
  })
  assert.ok(stop <= 100, `slow.txt stopped the main thread for ${Math.round(stop)} ms`)
  // The next file: a gradebook goes.
  assert.equal((await memRefusal('gradebook.xlsx', xlsxSheetsOf([R7_GRADEBOOK]))).why, null)
})

test('review round 7: the content Worker fails closed: one that cannot start, throws, exits, replies with garbage or the wrong bytes, or never replies', { timeout: 60_000 }, async (t) => {
  const { pathToFileURL } = await import('node:url')
  const dir = join(scratchHome(t), 'workers')
  mkdirSync(dir, { recursive: true })
  const worker = (name: string, body: string) => {
    const file = join(dir, `${name}.mjs`)
    writeFileSync(file, `import { parentPort } from 'node:worker_threads'\n${body}\n`)
    return pathToFileURL(file)
  }
  const cases: [string, URL][] = [
    ['missing', pathToFileURL(join(dir, 'missing.mjs'))],
    ['throws', worker('throws', "throw new Error('rig dummy failure')")],
    ['exits', worker('exits', 'parentPort.once("message", () => process.exit(0))')],
    ['garbage', worker('garbage', 'parentPort.once("message", () => parentPort.postMessage("ok"))')],
    // Round 8: each reply carries the job's id, so each case is refused for its own fault.
    ['unknown kind', worker('unknown', 'parentPort.once("message", (m) => parentPort.postMessage({ id: m.id, verdict: { kind: "fine" }, buffer: m.buffer, length: m.length }, [m.buffer]))')],
    ['secret without a rule', worker('norule', 'parentPort.once("message", (m) => parentPort.postMessage({ id: m.id, verdict: { kind: "secret" }, buffer: m.buffer, length: m.length }, [m.buffer]))')],
    ['wrong length', worker('short', 'parentPort.once("message", (m) => parentPort.postMessage({ id: m.id, verdict: { kind: "ok" }, buffer: m.buffer, length: m.length - 1 }, [m.buffer]))')],
    ['no bytes', worker('nobytes', 'parentPort.once("message", (m) => parentPort.postMessage({ id: m.id, verdict: { kind: "ok" }, length: m.length }))')],
    // Round 8: a reply with another job's id, or none.
    ['wrong id', worker('wrongid', 'parentPort.once("message", (m) => parentPort.postMessage({ id: m.id + 1, verdict: { kind: "ok" }, buffer: m.buffer, length: m.length }, [m.buffer]))')],
    ['no id', worker('noid', 'parentPort.once("message", (m) => parentPort.postMessage({ verdict: { kind: "ok" }, buffer: m.buffer, length: m.length }, [m.buffer]))')],
  ]
  for (const [label, url] of cases) {
    for (const [name, bytes] of [
      ['plan.txt', Buffer.from('Plan for Monday: call the printer.\n')],
      ['gradebook.xlsx', xlsxSheetsOf([R7_GRADEBOOK])],
    ] as const) {
      const got = await memRefusal(name, bytes, { contentWorker: url })
      assert.equal(got.why, unsafeSentence(got.path), `${label}: ${name}`)
      // Refused when it happens, not at the deadline.
      assert.ok(got.ms < R7_DEADLINE_MS / 2, `${label}: ${name} took ${Math.round(got.ms)} ms`)
    }
  }
  // One that never replies (a busy loop): terminated at the deadline, and the main thread keeps running.
  const looping = worker('busy', 'parentPort.once("message", () => { for (;;) {} })')
  const stop = await stopOf(async () => {
    const busy = await heartbeatRefusal('plan.txt', Buffer.from('Plan for Monday.\n'), { contentWorker: looping })
    assert.equal(busy.why, unsafeSentence(busy.path))
    assert.ok(busy.ms <= R7_DEADLINE_MS + 1000, `busy took ${Math.round(busy.ms)} ms`)
    return busy.maxGap
  })
  assert.ok(stop <= 100, `busy stopped the main thread for ${Math.round(stop)} ms`)
})

test('review round 7: a file that goes comes back from the Worker whole, byte for byte', async () => {
  const lib = await m()
  assert.equal(lib.OUTBOUND_CONTENT_DEADLINE_MS, R7_DEADLINE_MS)
  for (const [name, bytes] of [
    ['gradebook.xlsx', xlsxSheetsOf([R7_GRADEBOOK])],
    ['gradebook.docx', docxOf(['Grades'], R7_GRADEBOOK)],
    ['stock.csv', Buffer.from('Item,Qty\nChairs,12\n')],
  ] as const) {
    // The buffer the file is read into, as the check hands it to the file system.
    const fs = memFs(bytes)
    const seen: { into: Uint8Array | null } = { into: null }
    const open = fs.open
    fs.open = async () => {
      const handle = await open()
      const read = handle.read
      handle.read = async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        seen.into = buffer
        return read(buffer, offset, length, position)
      }
      return handle
    }
    const read = await lib.readOutboundFile(`${MEM_HOME}\\Documents\\${name}`, { home: MEM_HOME, fs })
    assert.equal(read.ok, true, name)
    assert.equal(read.file.size, bytes.length, name)
    assert.deepEqual(Buffer.from(read.file.bytes), bytes, name)
    // The bytes went to the Worker by a transfer, not a copy: the buffer they were read into is detached.
    assert.ok(seen.into !== null, name)
    assert.equal(seen.into.byteLength, 0, `${name}: the read buffer was copied, not transferred`)
  }
})

test('review round 7: a Word or Excel file whose words pass 25 MB is refused; one just under goes', { timeout: 60_000 }, async () => {
  // Lines of seven digits (no rule reads them), one Word paragraph broken by line breaks, or one shared string.
  const wordLines = (textBytes: number) => docxRaw(`<w:p><w:r><w:t>${'1234567<w:br/>'.repeat(Math.ceil(textBytes / 8))}</w:t></w:r></w:p>`)
  // Round 8: Word's main part is inflated up to 25 MB and no further, so a Word file just under the cap on words has
  // its lines in one text run (a line break in the text itself), its XML under 25 MB too.
  const wordText = (textBytes: number) => docxRaw(`<w:p><w:r><w:t xml:space="preserve">${'1234567\n'.repeat(Math.ceil(textBytes / 8))}</w:t></w:r></w:p>`)
  const sharedLines = (textBytes: number) =>
    zipRaw([...XLSX_BASE, { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst><si><t>${'1234567\n'.repeat(Math.ceil(textBytes / 8))}</t></si></sst>`) }])
  for (const [name, bytes] of [
    ['long.docx', wordLines(26 * MB)],
    ['long.xlsx', sharedLines(26 * MB)],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, unsafeSentence(got.path), name)
  }
  for (const [name, bytes] of [
    ['just under.docx', wordText(24 * MB)],
    ['just under.xlsx', sharedLines(24 * MB)],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

test('review round 7: a written value ending in a long run of dots is read in linear time', async () => {
  const written = (path: string) => `${path} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`
  for (const [name, text, sentence] of [
    ['dots.txt', `pwd: ${'.'.repeat(80000)}a`, written],
    ['wifi.txt', `wifi pass = ${'.'.repeat(80000)}a`, written],
    ['punct.txt', `pwd: a${'.,;:!?)'.repeat(12000)}b`, written],
    // Controls: dots alone hold the place of a password; a word of prose after ' is ' is not one.
    ['blank.txt', `pwd: ${'.'.repeat(80000)}`, null],
    ['prose.txt', `The password is ready${'.'.repeat(80000)}`, null],
  ] as const) {
    const got = await memRefusal(name, Buffer.from(text))
    assert.ok(got.ms < 1000, `${name} took ${Math.round(got.ms)} ms`)
    assert.equal(got.why, sentence === null ? null : sentence(got.path), name)
  }
})

test('review round 7: a 23 MB CSV of one digit per line is checked in under 3 s and goes', { timeout: 60_000 }, async () => {
  const got = await memRefusal('digits.csv', digitLines(23 * MB))
  assert.equal(got.why, null)
  assert.ok(got.ms < 3000, `digits.csv took ${Math.round(got.ms)} ms`)
})

test('review round 7: a tag ends at its first > outside a quoted attribute value; Word rows, cells and tables are read with any prefix', async () => {
  const wordCell = (prefix: string, text: string) => `<${prefix}tc><${prefix}p><${prefix}r><${prefix}t>${text}</${prefix}t></${prefix}r></${prefix}p></${prefix}tc>`
  const wordTable = (prefix: string, trAttrs = '') =>
    `<${prefix}tbl><${prefix}tr${trAttrs}>${['Site', 'User', 'Password'].map((c) => wordCell(prefix, c)).join('')}</${prefix}tr><${prefix}tr>${['example.com', 'kc', 'rig dummy'].map((c) => wordCell(prefix, c)).join('')}</${prefix}tr></${prefix}tbl>`
  const docxBody = (body: string, root = 'w:document', ns = '') =>
    zipRaw([
      { name: '[Content_Types].xml', data: Buffer.from(officeTypes('docx')) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><${root}${ns}><body>${body}</body></${root}>`) },
    ])
  const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  for (const [name, bytes] of [
    // A '/>' or '>' inside a quoted attribute value is not the tag's end.
    ['quoted row.docx', docxRaw(wordTable('w:', ' w:rsidR="/>"'))],
    ['quoted single.docx', docxRaw(wordTable('w:', " w:rsidR='/>'"))],
    ['quoted row.xlsx', zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Site', 'User', 'Password']).replace('<row r="1">', '<row r="1" x14ac:note="/>">')) }])],
    ['quoted cell.xlsx', zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>Site</t></is></c><c r="B1" t="inlineStr"><is><t>User</t></is></c><c r="C1" x="/>" t="inlineStr"><is><t>Password</t></is></c></row>`) }])],
    // Word's namespace under another prefix, or as the default namespace.
    ['other prefix.docx', docxBody(wordTable('x:'), 'x:document', ` xmlns:x="${WORD_NS}"`)],
    ['default namespace.docx', docxBody(wordTable(''), 'document', ` xmlns="${WORD_NS}"`)],
    ['dotted prefix.docx', docxBody(wordTable('ns0.w:'), 'ns0.w:document', ` xmlns:ns0.w="${WORD_NS}"`)],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // Paragraphs and line breaks under another prefix end a line too: a key alone in its paragraph is found.
  const key = 'AKIAIOSFODNN7EXAMPLE'
  const secretSentence = (path: string) => `${path} holds a secret (it looks like aws_access_key_id), so it is never attached. ${NO_WAY_AROUND}`
  for (const [name, bytes] of [
    ['other prefix paragraphs.docx', docxBody(`<x:p><x:r><x:t>${key}</x:t></x:r></x:p><x:p><x:r><x:t>Next steps</x:t></x:r></x:p>`, 'x:document', ` xmlns:x="${WORD_NS}"`)],
    ['other prefix break.docx', docxBody(`<x:p><x:r><x:t>${key}</x:t><x:br/><x:t>Next steps</x:t></x:r></x:p>`, 'x:document', ` xmlns:x="${WORD_NS}"`)],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, secretSentence(got.path), name)
  }
  // Controls: the same quoted attributes and prefixes on a gradebook go.
  const grades = (prefix: string, trAttrs = '') =>
    `<${prefix}tbl><${prefix}tr${trAttrs}>${['Student', 'Email', 'Result'].map((c) => wordCell(prefix, c)).join('')}</${prefix}tr><${prefix}tr>${['Sam Lee', 'sam@example.com', 'Pass'].map((c) => wordCell(prefix, c)).join('')}</${prefix}tr></${prefix}tbl>`
  for (const [name, bytes] of [
    ['quoted grades.docx', docxRaw(grades('w:', ' w:rsidR="/>"'))],
    ['other prefix grades.docx', docxBody(grades('x:'), 'x:document', ` xmlns:x="${WORD_NS}"`)],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

// ── review round 8: the type check, the path, one long lived Worker, the deadline, bun's regex engine ──

const R8_DOCX_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const R8_OVERRIDE = `<Override PartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"/>`
/** Round 8: a Word file whose [Content_Types].xml is `types` (the reviewer's ct.mjs shape when it ends in unclosed tags). */
const r8Docx = (types: string) =>
  zipOf({ '[Content_Types].xml': types, 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>' })

test('review round 8: a [Content_Types].xml of 26000 unclosed <Override tags is read in linear time on the main thread (the type check, shared with inbound downloads)', { timeout: 60_000 }, async () => {
  const { isType } = await import('../lib/email-files.ts')
  const hostile = r8Docx(`<?xml version="1.0"?><Types xmlns="x">${R8_OVERRIDE}${'<Override '.repeat(26000)}`)
  // isType runs on the main thread: its whole time is a gap of the main thread.
  const ms = await stopOf(async () => {
    const started = performance.now()
    assert.equal(isType(hostile, 'docx'), true)
    return performance.now() - started
  })
  assert.ok(ms <= 100, `the type check took ${Math.round(ms)} ms on the main thread`)
  // Through readOutboundFile, with a heartbeat: the main thread never stops for 100 ms.
  const stop = await stopOf(async () => {
    const got = await heartbeatRefusal('memo.docx', hostile)
    assert.equal(got.why, null)
    return got.maxGap
  })
  assert.ok(stop <= 100, `memo.docx stopped the main thread for ${Math.round(stop)} ms`)
  // Ten of them in one email (the reviewer's ct10.mjs: 41 s and a 4.4 s stop before).
  const lib = await m()
  const files: Record<string, Buffer> = {}
  for (let i = 0; i < 10; i++) files[`${MEM_HOME}\\Documents\\memo${i}.docx`] = r8Docx(`<?xml version="1.0"?><Types xmlns="x${i}">${R8_OVERRIDE}${'<Override '.repeat(26000)}`)
  const fs = {
    realpath: async (path: string) => path,
    lstat: async (path: string) => ({ isFile: () => true, size: files[path]!.length, dev: 1, ino: 7 }),
    open: async (path: string) => ({
      stat: async () => ({ isFile: () => true, size: files[path]!.length, dev: 1, ino: 7 }),
      read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const bytes = files[path]!
        const n = Math.max(0, Math.min(length, bytes.length - position))
        buffer.set(bytes.subarray(position, position + n), offset)
        return { bytesRead: n }
      },
      close: async () => {},
    }),
  }
  const tenFiles = await stopOf(async () => {
    let maxGap = 0
    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 10)
    const t0 = performance.now()
    const all = await lib.readOutboundFiles(Object.keys(files), { home: MEM_HOME, fs })
    const allMs = performance.now() - t0
    maxGap = Math.max(maxGap, performance.now() - last)
    clearInterval(beat)
    assert.equal(all.ok, true, all.error)
    assert.ok(allMs < 5000, `ten files took ${Math.round(allMs)} ms`)
    return maxGap
  })
  assert.ok(tenFiles <= 100, `ten files stopped the main thread for ${Math.round(tenFiles)} ms`)
})

test('review round 8: an <Override tag ends at its first > outside quotes; a longer element name and an unclosed last tag are not read as one', async () => {
  const { isType } = await import('../lib/email-files.ts')
  const types = (body: string) => r8Docx(`<?xml version="1.0"?><Types xmlns="x">${body}</Types>`)
  // A '>' inside a quoted attribute value is not the tag's end.
  assert.equal(isType(types(`<Override Note="a>b" PartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"/>`), 'docx'), true)
  assert.equal(isType(types(`<Override Note='a>b' PartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"/>`), 'docx'), true)
  assert.equal(isType(types(`<Override\nPartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"/>`), 'docx'), true)
  // <OverrideX is another element; a tag with no '>' ends the walk.
  assert.equal(isType(types(`<OverrideX PartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"/>`), 'docx'), false)
  assert.equal(isType(r8Docx(`<?xml version="1.0"?><Types xmlns="x"><Override PartName="/word/document.xml" ContentType="${R8_DOCX_MAIN}"`), 'docx'), false)
  // The usual file, and a Word part named twice the same way, still read as before.
  assert.equal(isType(types(R8_OVERRIDE), 'docx'), true)
  assert.equal(isType(types(R8_OVERRIDE + R8_OVERRIDE), 'docx'), true)
  assert.equal(isType(types(R8_OVERRIDE), 'xlsx'), false)
})

test('review round 8: a path over 4096 characters is refused before any pattern reads it; trailing dots and spaces are dropped in linear time', async () => {
  const lib = await m()
  const tooLong = (path: string) => `${path.slice(0, 120)}...${path.slice(-60)} is too long to be a file path, so it is not attached.`
  for (const path of [
    `/home/u/docs/${'.'.repeat(100_000)}x.pdf`,
    `C:\\Users\\u\\${' '.repeat(100_000)}x.pdf`,
    `/home/u/${'a'.repeat(5000)}/x.pdf`,
  ]) {
    const spy = spyFs()
    const started = performance.now()
    const why = await refusal(path, { home: '/home/u', fs: spy.fs })
    const ms = performance.now() - started
    assert.equal(why, tooLong(path))
    assert.deepEqual(spy.calls, [], 'no file system call')
    assert.ok(ms < 50, `${path.length} characters took ${Math.round(ms)} ms`)
    assert.equal(lib.outboundFileLexicalRefusal(path, { home: '/home/u' }), tooLong(path))
  }
  // 4096 is the longest read; a ~ path is measured once its home is put in.
  const at = (n: number) => `/home/u/docs/${'a'.repeat(n - '/home/u/docs/'.length - 4)}.pdf`
  assert.equal(at(4096).length, 4096)
  assert.equal(lib.outboundFileLexicalRefusal(at(4096), { home: '/home/u' }), null)
  assert.equal(lib.outboundFileLexicalRefusal(at(4097), { home: '/home/u' }), tooLong(at(4097)))
  const tilde = `~/${'a'.repeat(4090)}.pdf`
  assert.equal(lib.outboundFileLexicalRefusal(tilde, { home: '/home/u' }), tooLong(tilde))
  // The length is the first thing read: a long path of spaces, or with a control character, is too long first.
  for (const path of [' '.repeat(5000), `/home/u/docs/\u0001${'a'.repeat(5000)}.pdf`]) {
    assert.equal(lib.outboundFileLexicalRefusal(path, { home: '/home/u' }), tooLong(path))
  }
  // Just under the cap, a long run of dots or spaces before a name is read in linear time (the regex /[. ]+$/ took
  // 0.5 s on 30000), and a trailing dot or space still opens the folder it names.
  for (const path of [`/home/u/docs/${'.'.repeat(4000)}x.pdf`, `C:\\Users\\u\\${' '.repeat(4000)}x.pdf`, `/home/u/docs/${'. '.repeat(2000)}x.pdf`]) {
    const started = performance.now()
    assert.equal(lib.outboundFileLexicalRefusal(path, { home: '/home/u' }), null)
    assert.ok(performance.now() - started < 50, `${path.length} characters took too long`)
  }
  for (const path of ['C:\\Users\\kc\\.ssh.\\notes.txt', 'C:\\Users\\kc\\.ssh \\notes.txt', 'C:\\Users\\kc\\.ssh. . \\notes.txt', `C:\\Users\\kc\\.ssh${'.'.repeat(3000)}\\notes.txt`]) {
    assert.match(String(lib.outboundFileLexicalRefusal(path, { home: 'C:\\Users\\kc' })), /looks like a key or password file/, path)
  }
  // A home with trailing dots or spaces is the same folder: the word rules still read only below it.
  assert.equal(lib.outboundFileLexicalRefusal('C:\\Users\\John Key\\Documents\\notes.txt', { home: 'C:\\Users\\John Key. ' }), null)
})

/** Round 8: a Worker module that answers by the file's name: ok, or one fault (it exits, hangs, or replies wrongly). */
const R8_SCRIPTED_WORKER = `import { parentPort } from 'node:worker_threads'
parentPort.on('message', (m) => {
  const ok = { id: m.id, verdict: { kind: 'ok' }, buffer: m.buffer, length: m.length }
  if (m.name.startsWith('exit')) process.exit(0)
  else if (m.name.startsWith('hang')) return
  else if (m.name.startsWith('throw')) setTimeout(() => { throw new Error('rig dummy failure') })
  else if (m.name.startsWith('wrong id')) parentPort.postMessage({ ...ok, id: m.id + 1 }, [m.buffer])
  else if (m.name.startsWith('garbage')) parentPort.postMessage('ok')
  else if (m.name.startsWith('twice')) { parentPort.postMessage(ok, [m.buffer]); parentPort.postMessage({ id: m.id }) }
  else parentPort.postMessage(ok, [m.buffer])
})
`

test('review round 8: ONE long lived content Worker reads every file; only a deadline, an error, an exit or a bad reply replaces it', { timeout: 120_000 }, async (t) => {
  const lib = await m()
  const { pathToFileURL } = await import('node:url')
  assert.equal(typeof lib.outboundContentWorkersStarted, 'function', 'outboundContentWorkersStarted is exported')
  // The real Worker: 300 small CSV files start at most one (the earlier tests may have started it already).
  const before = lib.outboundContentWorkersStarted()
  const csv = Buffer.from('date,item,qty\n2026-10-01,widget,4\n')
  for (let i = 0; i < 300; i++) assert.equal((await memRefusal(`sales${i}.csv`, csv)).why, null)
  assert.ok(lib.outboundContentWorkersStarted() - before <= 1, `300 files started ${lib.outboundContentWorkersStarted() - before} Workers`)
  // A scripted Worker: each fault refuses its own file and replaces the Worker; the next file goes on a new one.
  const dir = join(scratchHome(t), 'workers')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'scripted.mjs')
  writeFileSync(file, R8_SCRIPTED_WORKER)
  const url = pathToFileURL(file)
  const plan = Buffer.from('Plan for Monday.\n')
  const steps: [string, boolean, number][] = [
    ['good a.txt', true, 1],
    ['good b.txt', true, 1],
    ['exit.txt', false, 1],
    ['good c.txt', true, 2],
    ['wrong id.txt', false, 2],
    ['good d.txt', true, 3],
    ['garbage.txt', false, 3],
    ['good e.txt', true, 4],
    ['throw.txt', false, 4],
    ['good f.txt', true, 5],
    // A reply and then a message no job asked for: the file goes, and the Worker is not trusted with the next one.
    ['twice.txt', true, 5],
    ['good g.txt', true, 6],
    ['hang.txt', false, 6],
    ['good h.txt', true, 7],
  ]
  for (const [name, goes, workers] of steps) {
    const got = await memRefusal(name, plan, { contentWorker: url })
    assert.equal(got.why, goes ? null : unsafeSentence(got.path), name)
    if (name !== 'hang.txt') assert.ok(got.ms < R7_DEADLINE_MS / 2, `${name} took ${Math.round(got.ms)} ms`)
    assert.equal(lib.outboundContentWorkersStarted(url), workers, `${name}: Workers started`)
    // A turn for any message the Worker sends after its reply, before the next file.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

test('review round 8: files checked at the same time each get their own verdict from the one Worker, in a queue', { timeout: 120_000 }, async () => {
  // Round 10: a Result column of Pass and Fail (a Pass column beside an email column is refused again).
  const grades = xlsxSheetsOf([[['Student', 'Email', 'Grade', 'Result'], ['Amy', 'amy@school.org', '91', 'Pass'], ['Bo', 'bo@school.org', '55', 'Fail']]])
  const tracker = docxOf(['Weekly notes'], [['Task', 'Owner', 'Status'], ['Ship', 'Kc', 'Done']])
  const sales = Buffer.from('date,item,qty\n2026-10-01,widget,4\n')
  const export_ = Buffer.from('name,url,username,password\nHarbor,https://example.com,kc,rig dummy\n')
  const accounts = docxOf([], [['Site', 'User', 'Password'], ['example.com', 'kc', 'rig dummy']])
  const stop = await stopOf(async () => {
    let maxGap = 0
    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 10)
    try {
      for (let round = 0; round < 40; round++) {
        const got = await Promise.all([
          memRefusal('grades.xlsx', grades),
          memRefusal('export.csv', export_),
          memRefusal('tracker.docx', tracker),
          memRefusal('accounts.docx', accounts),
          memRefusal('sales.csv', sales),
        ])
        assert.deepEqual(
          got.map((g) => g.why),
          [null, tableSentence6(got[1]!.path), null, tableSentence6(got[3]!.path), null],
          `round ${round}`,
        )
      }
    } finally {
      clearInterval(beat)
    }
    return maxGap
  })
  assert.ok(stop <= 100, `the main thread stopped for ${Math.round(stop)} ms`)
})

/** Round 8: run a module in a child node with the same loader (tsx), and its stdout, stderr, exit code and time. */
async function r8Child(dir: string, name: string, source: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const { spawn } = await import('node:child_process')
  const file = join(dir, name)
  writeFileSync(file, source)
  const started = performance.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv.filter((arg) => !arg.startsWith('--test')), file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: performance.now() - started })
    })
  })
}

test('review round 8: the content Worker never keeps the daemon alive (it is unref\'d)', { timeout: 60_000 }, async (t) => {
  const dir = join(scratchHome(t), 'child')
  mkdirSync(dir, { recursive: true })
  const lib = new URL('../lib/email-outbound-files.ts', import.meta.url).href
  // A process that checks one file and then has nothing left to do must end by itself (no process.exit).
  const got = await r8Child(dir, 'one-file.mjs', `const lib = await import(${JSON.stringify(lib)})
const bytes = Buffer.from('date,item,qty\\n2026-10-01,widget,4\\n')
const stat = { isFile: () => true, size: bytes.length, dev: 1, ino: 7 }
const fs = { realpath: async (p) => p, lstat: async () => stat, open: async () => ({ stat: async () => stat, read: async (b, o, l, p) => { const n = Math.max(0, Math.min(l, bytes.length - p)); b.set(bytes.subarray(p, p + n), o); return { bytesRead: n } }, close: async () => {} }) }
const why = await lib.outboundFileRefusal('/home/u/docs/sales.csv', { home: '/home/u', fs })
console.log('checked', why)
`, 30_000)
  assert.match(got.stdout, /checked null/, got.stderr)
  assert.equal(got.code, 0, `the child did not end by itself (${Math.round(got.ms)} ms): ${got.stderr}`)
  assert.ok(got.ms < 20_000, `the child took ${Math.round(got.ms)} ms to end`)
})

test('review round 8: the content Worker writes nothing to stdout or stderr (bun hands a Worker the daemon\'s stdout, the MCP channel)', { timeout: 60_000 }, async (t) => {
  const { readFileSync } = await import('node:fs')
  // The Worker's first import is the silencer, so it runs before every other module of the Worker.
  const worker = readFileSync(new URL('../lib/email-outbound-content-worker.ts', import.meta.url), 'utf8')
  const imports = [...worker.matchAll(/^import .*$/gm)].map((line) => line[0])
  assert.equal(imports[0], "import './email-outbound-content-quiet.ts'")
  // A Worker that loads the silencer and then writes every way it can, started with no stdout option, as bun starts
  // every Worker: the child process prints only its own line.
  const dir = join(scratchHome(t), 'quiet')
  mkdirSync(dir, { recursive: true })
  const quiet = new URL('../lib/email-outbound-content-quiet.ts', import.meta.url).href
  writeFileSync(join(dir, 'noisy.mjs'), `import ${JSON.stringify(quiet)}
import { parentPort } from 'node:worker_threads'
console.log('LEAK log'); console.info('LEAK info'); console.warn('LEAK warn'); console.error('LEAK error'); console.debug('LEAK debug')
console.trace('LEAK trace'); console.dir({ leak: 1 }); console.table([{ leak: 1 }])
process.stdout.write('LEAK stdout\\n'); process.stderr.write('LEAK stderr\\n', () => parentPort.postMessage('written'))
`)
  const got = await r8Child(dir, 'parent.mjs', `import { Worker } from 'node:worker_threads'
const w = new Worker(new URL('./noisy.mjs', import.meta.url))
w.once('message', (m) => { console.log('parent got', m); setTimeout(() => process.exit(0), 200) })
`, 30_000)
  assert.equal(got.stdout, 'parent got written\n', got.stderr)
  assert.doesNotMatch(got.stderr, /LEAK/)
})

/** Round 8: the reviewer's ordinary large files (prose.mjs and leakbig.mjs lines), built in memory. */
const R8_WORDS = 'the quarterly report shows revenue growth across all regions while costs remained stable and the team expects further improvement next year as new products launch in several markets including europe and asia'.split(' ')
function r8Lines(bytes: number, line: (i: number, words: string) => string): Buffer {
  const parts: string[] = []
  let length = 0
  let seed = 7
  for (let i = 0; ; i++) {
    let words = ''
    for (let k = 0; k < 14; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      words += `${R8_WORDS[seed % R8_WORDS.length]} `
    }
    const next = line(i, words)
    if (length + next.length > bytes) break
    parts.push(next)
    length += next.length
  }
  return Buffer.from(parts.join(''))
}
/** Round 8: a workbook with `n` distinct shared strings (an order list), one sheet with its header. */
function r8BigWorkbook(n: number): Buffer {
  const si: string[] = []
  let seed = 11
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    si.push(`<si><t>${R8_WORDS[seed % R8_WORDS.length]} ${(seed % 1000003).toString(36)} ${((seed >> 3) % 99991).toString(36)}</t></si>`)
  }
  const rows = [inlineRow(1, ['Customer', 'Order', 'Status'])]
  for (let r = 2; r < 2000; r++) rows.push(`<row r="${r}"><c r="A${r}" t="s"><v>${r}</v></c><c r="B${r}" t="s"><v>${r + 1}</v></c><c r="C${r}"><v>${r}</v></c></row>`)
  // The workbook's relationships, as Excel writes them (without them every unused shared string is judged as a row).
  const rels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  return zipRaw([
    ...XLSX_BASE,
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows.join('')) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${si.join('')}</sst>`) },
  ])
}

test('review round 8: ordinary large files go: 24.9 MB of prose, a 24 MB log, a 22.5 MB CSV and a workbook of 900000 shared strings', { timeout: 180_000 }, async () => {
  for (const [name, build] of [
    ['notes.txt', () => r8Lines(24.9 * MB, (_, words) => `${words}\n`)],
    ['server.log.txt', () => r8Lines(24 * MB, (i, words) => `2026-10-28T03:${String(i % 60).padStart(2, '0')}:00Z INFO worker=${i % 17} ${words}\n`)],
    ['sales.csv', () => r8Lines(22.5 * MB, (i) => `2026-10-28,Widget blue large,SKU-${1234567 + i},12.50,warehouse ${i % 9}\n`)],
    ['orders.xlsx', () => r8BigWorkbook(900_000)],
  ] as const) {
    const bytes = build()
    const stop = await stopOf(async () => {
      const got = await heartbeatRefusal(name, bytes)
      assert.equal(got.why, null, `${name} (${(bytes.length / MB).toFixed(1)} MB)`)
      return got.maxGap
    })
    assert.ok(stop <= 100, `${name} stopped the main thread for ${Math.round(stop)} ms`)
  }
})

test('review round 8: a bare password label with a million blank lines before its value, and an armour line of a million groups, are refused (bun\'s regex engine said no match)', { timeout: 60_000 }, async () => {
  const written = (path: string) => `${path} has a password or key written in it, so it is never attached. ${NO_WAY_AROUND}`
  const key = (path: string) => `${path} holds a private key, so it is never attached. ${NO_WAY_AROUND}`
  for (const blank of ['\n', ' \n', '\t\r\n']) {
    const got = await memRefusal('notes.txt', Buffer.from(`password:\n${blank.repeat(1_000_000)}Hunter2Zebra!\n`))
    assert.equal(got.why, written(got.path), JSON.stringify(blank))
    assert.ok(got.ms < 3000, `blank lines took ${Math.round(got.ms)} ms`)
  }
  assert.equal((await memRefusal('notes.txt', Buffer.from(`password:\n${'\n'.repeat(4_000_000)}Hunter2Zebra!\n`))).why, written(`${MEM_HOME}\\Documents\\notes.txt`))
  for (const groups of [1_000_000, 6_000_000]) {
    const got = await memRefusal('notes.txt', Buffer.from(`-----BEGIN ${'A '.repeat(groups)}PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n`))
    assert.equal(got.why, key(got.path), `${groups} groups`)
  }
  // A recovery key of a million groups.
  const recovery = (path: string) => `${path} holds a recovery key, so it is never attached. ${NO_WAY_AROUND}`
  const grouped = await memRefusal('notes.txt', Buffer.from(`recovery key: ${'RIGD-'.repeat(1_000_000)}UMMY\n`))
  assert.equal(grouped.why, recovery(grouped.path))
})

test('review round 8: the walks find what the regexes they replace found, on many generated texts', async () => {
  const C = await import('../lib/email-outbound-content.ts')
  const W = C.CONTENT_WALKS_FOR_TESTS
  // The round 4 regex the next line walk replaces (V8 reads it right on these small texts).
  const FW = String.raw`passw[oö]rt(?:er)?|mots?[ _-]de[ _-]passe|contrase[ñn]as?|senhas?|wachtwoord(?:en)?`
  const OLD_NEXT_LINE = new RegExp(
    String.raw`(?<![a-z0-9])(?:password|passwd|pwd|pw|passcode|passkey|${FW})s?[ \t]*[:=\uFF1A][ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*["']?([^\s"']{6,}?)["']?[ \t]*\r?$`,
    'gim',
  )
  const OLD_ARMOUR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
  const pieces = ['password', 'Password', 'pwd', 'pw', 'pws', 'passcode', 'pass', 'passes', 'boarding pass', 'pin', 'PIN code', 'api key', 'token', 'Passwort', 'mot de passe',
    ':', '=', '\uFF1A', ' - ', ' is ', ' ', '\t', '\n', '\r\n', '\r', '"', "'", 'Hunter2Zebra!', '123456', '4321', 'secret', 'value9', 'x', 'a1', '.', ',', '\u00a0', '\u2028',
    '-----BEGIN ', 'PRIVATE KEY', ' BLOCK', '-----', 'RSA ', 'A ', 'a ', 'my', 'is']
  let seed = 12345
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const indexes = (matches: RegExpMatchArray[]) => matches.map((match) => `${match.index}:${match[0]}`)
  for (let n = 0; n < 40000; n++) {
    let text = ''
    for (let k = rand(14) + 1; k > 0; k--) text += pieces[rand(pieces.length)]
    assert.deepEqual(W.nextLineValues(text), [...text.matchAll(OLD_NEXT_LINE)].map((match) => match[1]), JSON.stringify(text))
    assert.deepEqual(indexes(W.writtenPasswordMatches(text)), indexes([...text.matchAll(W.WRITTEN_PASSWORD)]), JSON.stringify(text))
    assert.deepEqual(indexes(W.writtenPassMatches(text)), indexes([...text.matchAll(W.WRITTEN_PASS)]), JSON.stringify(text))
    assert.deepEqual(indexes(W.writtenPinMatches(text)), indexes([...text.matchAll(W.WRITTEN_PIN)]), JSON.stringify(text))
    assert.equal(W.hasPrivateKeyArmour(text), OLD_ARMOUR.test(text), JSON.stringify(text))
  }
  // The armour: real lines, and a label still running at 200 characters is refused (fail closed); a short one is not.
  for (const line of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----']) {
    assert.equal(W.hasPrivateKeyArmour(`notes\n${line}\nMIIE\n`), true, line)
  }
  assert.equal(W.hasPrivateKeyArmour(`-----BEGIN ${'A '.repeat(95)}`), true)
  assert.equal(W.hasPrivateKeyArmour('-----BEGIN CERTIFICATE-----\nMIIE\n-----END CERTIFICATE-----\n'), false)
  assert.equal(W.hasPrivateKeyArmour(`-----BEGIN ${'A '.repeat(20)}NOTE-----`), false)
  // The recovery phrase walk reads words as /[a-z]+/gi did: twelve list words, numbers and marks between.
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  assert.equal(W.hasRecoveryPhrase(phrase), true)
  assert.equal(W.hasRecoveryPhrase(phrase.split(' ').map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('\n')), true)
  assert.equal(W.hasRecoveryPhrase(phrase.replace('absurd', 'absurdly')), false)
  assert.equal(W.hasRecoveryPhrase(phrase.replace('absurd', 'ab\u00e9surd')), false)
  assert.equal(W.hasRecoveryPhrase(phrase.replace(' absurd', '3absurd')), true)
  // The recovery key reads four groups, as {2,} did.
  for (const [value, found] of [['RIGD-UMMY-NOTA-KEYX', true], ['RIGD-UMMY-NOTA', false], ['RIGD-UMMY-NOTA-KEYXa', false], ['RIGD-UMMY-NOTA-KEYX-ABCD', true], ['RIGD UMMY NOTA KEYX', true], ['RIGD-UMMY NOTA-KEYX', false], ['RIGD-UMMY-NOTA-KEYXABCDE', false]] as const) {
    assert.equal(W.hasRecoveryKey(`recovery key: ${value}`), found, value)
  }
})

test('review round 8 (round 10: the gradebook exemption is gone): a header Student, Email, Grade, Pass is refused again, as Site, User, Pass is', async () => {
  for (const [header, goes] of [
    // Round 10: a loose pass column beside an email column is a password column, a grade beside it or not.
    [['Student', 'Email', 'Grade', 'Pass'], false],
    [['Student', 'Email', 'Score', 'Pass'], false],
    [['Name', 'E-mail', 'Final result', 'Exam pass'], false],
    [['Student', 'Login', 'Marks', 'Pass'], false],
    [['Site', 'User', 'Pass'], false],
    [['Bank', 'Login', 'PIN'], false],
    // Only a pass column is let off beside a grade: a pin or a password is not.
    [['Student', 'Email', 'Grade', 'PIN'], false],
    [['Student', 'Email', 'Grade', 'Password'], false],
  ] as const) {
    // Round 9: the pass column holds pass or fail words (a gradebook's). Round 10: refused all the same.
    const rows = [[...header], header.map((cell, i) => (i === 1 ? 'amy@school.org' : /pass$/i.test(cell) ? 'Pass' : 'x'))]
    for (const [name, bytes] of [
      ['table.csv', Buffer.from(rows.map((row) => row.join(',')).join('\n'))],
      ['table.xlsx', xlsxSheetsOf([rows])],
      ['table.docx', docxOf(['Term 1'], rows)],
    ] as const) {
      const got = await memRefusal(name, bytes)
      assert.equal(got.why, goes ? null : tableSentence6(got.path), `${header.join(' | ')} as ${name}`)
    }
  }
})

test('review round 8: Word\'s main part is inflated up to 25 MB and no further, and its paragraphs are walked, not split', { timeout: 60_000 }, async () => {
  // 26 MB of empty paragraphs: refused at the cap, in bounded memory (the reviewer's membomb.mjs: 60 MB of <w:p/>).
  let peak = 0
  const start = process.memoryUsage().rss
  const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10)
  try {
    const got = await memRefusal('empty paragraphs.docx', docxRaw('<w:p/>'.repeat(Math.ceil((26 * MB) / 6))))
    assert.equal(got.why, unsafeSentence(got.path))
    assert.ok(got.ms < 3000, `empty paragraphs.docx took ${Math.round(got.ms)} ms`)
  } finally {
    clearInterval(sample)
  }
  assert.ok(peak - start < 400 * MB, `the check grew the process by ${Math.round((peak - start) / MB)} MB`)
  // Markup past 25 MB with few words is refused too; 24 MB of empty paragraphs goes.
  assert.equal((await memRefusal('runs.docx', docxRaw(`<w:p>${'<w:r/>'.repeat(Math.ceil((26 * MB) / 6))}</w:p>`))).why, unsafeSentence(`${MEM_HOME}\\Documents\\runs.docx`))
  assert.equal((await memRefusal('fine.docx', docxRaw('<w:p/>'.repeat(Math.floor((24 * MB) / 6))))).why, null)
  // A key in a later paragraph is still found.
  const secretSentence = (path: string) => `${path} holds a secret (it looks like aws_access_key_id), so it is never attached. ${NO_WAY_AROUND}`
  const got = await memRefusal('minutes.docx', docxRaw(`${'<w:p><w:r><w:t>Notes</w:t></w:r></w:p>'.repeat(1000)}<w:p><w:r><w:t>AKIAIOSFODNN7EXAMPLE</w:t></w:r></w:p>`))
  assert.equal(got.why, secretSentence(got.path))
})

// ── review round 9: the Worker's own budget, the cap on Workers, the gradebook ──

/** Round 9: the sentence past the cap on content Workers (OUTBOUND_CONTENT_WORKERS_MAX). */
const safetySentence = (path: string) =>
  `${path} is not attached for now: too many files could not be checked since this agent started, so no text, Word or Excel file is attached until the agent is restarted (a safety stop; nothing was found in this file).`

/** Round 9: the reviewer's docxslow.mjs, one Word paragraph of `unit` over `mb` MB (24 KB packed for 24 MB of 'pw '). */
const docxSlow = (mb: number, unit = 'pw ') => docxRaw(`<w:p><w:r><w:t>${unit.repeat(Math.floor((mb * MB) / unit.length))}</w:t></w:r></w:p>`)

/** Round 9: the real content Worker module under a URL of its own, so a test's Workers are counted on their own host. */
const realWorkerAt = (tag: string) => new URL(`../lib/email-outbound-content-worker.ts?${tag}`, import.meta.url)

test('review round 9: a file over its budget is refused by the Worker itself, inside the walks, and the Worker is not replaced', { timeout: 120_000 }, async () => {
  const lib = await m()
  const url = realWorkerAt('r9-budget')
  // 8 MB of 'pw ' in a text file, under a 100 ms budget (ctx.officeReadMs): before round 9 the budget covered only a
  // Word or Excel file's read, and this text went after about a second of checks.
  const text = Buffer.from('pw '.repeat(Math.floor((8 * MB) / 3)))
  const stop = await stopOf(async () => {
    const slow = await heartbeatRefusal('notes.txt', text, { contentWorker: url, officeReadMs: 100 })
    assert.equal(slow.why, unsafeSentence(slow.path))
    // Its hard deadline is 13 s: the Worker's own budget answered long before it.
    assert.ok(slow.ms < 2500, `notes.txt took ${Math.round(slow.ms)} ms`)
    return slow.maxGap
  })
  assert.ok(stop <= 100, `notes.txt stopped the main thread for ${Math.round(stop)} ms`)
  // The reviewer's docxslow (24 KB, 24 MB of 'pw '), 10 times under a 300 ms budget: each refused by the budget, and
  // the one Worker reads them all (under bun each Worker replaced cost about 27 MB that is never given back).
  const bytes = docxSlow(24)
  for (let i = 1; i <= 10; i++) {
    const got = await memRefusal(`memo${i}.docx`, bytes, { contentWorker: url, officeReadMs: 300 })
    assert.equal(got.why, unsafeSentence(got.path), `memo${i}.docx`)
    assert.ok(got.ms < 3000, `memo${i}.docx took ${Math.round(got.ms)} ms`)
  }
  // Under the default budget (sized from its 24 MB of words, not its 24 KB) it goes, still on the same Worker.
  assert.equal((await memRefusal('memo.docx', bytes, { contentWorker: url })).why, null)
  // The budget grows with the words: 16 MB of '=aws' in a 16 KB docx takes about 4 s of checks under node, past the
  // 2 s its size gives, and goes (its words give 18 s).
  const aws = await memRefusal('aws.docx', docxSlow(16, '=aws'), { contentWorker: url })
  assert.equal(aws.why, null, `aws.docx after ${Math.round(aws.ms)} ms`)
  assert.equal((await memRefusal('plan.txt', Buffer.from('Plan for Monday.\n'), { contentWorker: url })).why, null)
  assert.equal(lib.outboundContentWorkersStarted(url), 1, 'the Worker was never replaced')
})

test('review round 9: each walk checks the budget as it goes; with none it reads to the end', { timeout: 60_000 }, async () => {
  const C = await import('../lib/email-outbound-content.ts')
  const W = (C as Record<string, any>).CONTENT_WALKS_FOR_TESTS
  assert.equal(typeof W.OverBudget, 'function', 'the walks export the budget error')
  const twelve = 'abandon ability able about above absent absorb abstract absurd abuse access '
  for (const [label, walk, unit] of [
    ['written password words', W.writtenPasswordMatches, 'pw '],
    ['written pass', W.writtenPassMatches, 'pass '],
    ['written pin', W.writtenPinMatches, 'pin '],
    ['next line label', W.nextLineValues, 'pw '],
    ['recovery phrase', W.hasRecoveryPhrase, `${twelve}the `],
    ['recovery key labels', W.hasRecoveryKey, 'recovery key: no\n'],
  ] as const) {
    const text = unit.repeat(Math.floor((24 * MB) / unit.length))
    // A budget already spent: the walk stops at its first check.
    const t0 = performance.now()
    assert.throws(() => walk(text, { deadline: Date.now() - 1 }), W.OverBudget, `${label}: spent`)
    assert.ok(performance.now() - t0 < 100, `${label}: a spent budget took ${Math.round(performance.now() - t0)} ms`)
    // A budget of 20 ms: the walk stops soon after it, not at the end of 24 MB.
    const t1 = performance.now()
    assert.throws(() => walk(text, { deadline: Date.now() + 20 }), W.OverBudget, `${label}: 20 ms`)
    assert.ok(performance.now() - t1 < 250, `${label}: a 20 ms budget took ${Math.round(performance.now() - t1)} ms`)
    // No budget: the walk reads to the end.
    assert.doesNotThrow(() => walk(text), label)
  }
  // The scanner's pieces: a spent budget stops it between pieces.
  await assert.rejects(W.firstSecretRule('notes.txt', 'plain line of notes\n'.repeat(200_000), { deadline: Date.now() - 1 }), W.OverBudget)
  assert.equal(await W.firstSecretRule('notes.txt', 'plain line of notes\n'.repeat(200_000)), null)
})

test('review round 9: the hard deadline always ends after the Worker\'s own budget', async () => {
  const lib = await m()
  const C = await import('../lib/email-outbound-content.ts')
  assert.equal(typeof lib.outboundContentHardDeadlineMs, 'function', 'outboundContentHardDeadlineMs is exported')
  for (const size of [0, 1, MB, 8 * MB, 24 * 1024, 25 * MB]) {
    // A text file's words are its bytes, at most: its budget is sized from its size, 3 s inside its deadline.
    assert.equal(lib.outboundContentHardDeadlineMs('text', size), lib.outboundContentDeadlineMs(size))
    assert.ok(lib.outboundContentHardDeadlineMs('text', size) - C.officeReadBudgetMs(size) >= 3000, `text ${size}`)
    // A Word or Excel file's budget grows with its words, up to the 25 MB cap: its deadline is that of 25 MB.
    for (const type of ['docx', 'xlsx']) {
      assert.equal(lib.outboundContentHardDeadlineMs(type, size), 30_000, `${type} ${size}`)
      assert.ok(lib.outboundContentHardDeadlineMs(type, size) - C.officeReadBudgetMs(25 * MB) >= 3000, `${type} ${size}`)
    }
  }
  assert.equal(C.OFFICE_TEXT_MAX, 25 * MB)
})

test('review round 9: at most 8 content Workers start in a process; past them every text, Word and Excel file is a safety refusal and no Worker starts', { timeout: 60_000 }, async (t) => {
  const lib = await m()
  const { pathToFileURL } = await import('node:url')
  assert.equal(lib.OUTBOUND_CONTENT_WORKERS_MAX, 8)
  const dir = join(scratchHome(t), 'workers')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'garbage.mjs')
  // A Worker that answers every file with garbage: each file replaces it.
  writeFileSync(file, "import { parentPort } from 'node:worker_threads'\nparentPort.on('message', () => parentPort.postMessage('garbage'))\n")
  const url = pathToFileURL(file)
  for (let i = 1; i <= 8; i++) {
    const got = await memRefusal('plan.txt', Buffer.from('Plan for Monday.\n'), { contentWorker: url })
    assert.equal(got.why, unsafeSentence(got.path), `file ${i}`)
    assert.equal(lib.outboundContentWorkersStarted(url), i, `file ${i}: Workers started`)
  }
  for (const [name, bytes] of [
    ['plan.txt', Buffer.from('Plan for Monday.\n')],
    ['sales.csv', Buffer.from('date,item,qty\n2026-10-01,widget,4\n')],
    ['gradebook.xlsx', xlsxSheetsOf([R7_GRADEBOOK])],
    ['gradebook.docx', docxOf(['Grades'], R7_GRADEBOOK)],
    ['plan2.txt', Buffer.from('Plan for Tuesday.\n')],
  ] as const) {
    const got = await memRefusal(name, bytes, { contentWorker: url })
    assert.equal(got.why, safetySentence(got.path), name)
    // Round 10: one sentence, with no 'never' (a later restart lets the file go).
    assert.equal(got.why!.split(/[.:;] /).length, 3, `${name}: one sentence, its clauses after a colon and a semicolon`)
    assert.equal(/\bnever\b|\. [A-Z]/.test(got.why!), false, name)
    assert.ok(got.ms < 500, `${name} took ${Math.round(got.ms)} ms`)
    assert.equal(lib.outboundContentWorkersStarted(url), 8, `${name}: no Worker started past the cap`)
  }
  // A picture or a PDF has no words read, so it still goes; the real Worker's host is its own.
  assert.equal((await memRefusal('scan.pdf', PDF, { contentWorker: url })).why, null)
  assert.equal((await memRefusal('plan.txt', Buffer.from('Plan for Monday.\n'))).why, null)
})

test('review round 9: the Worker\'s message listener stays sync, with a .catch on its chain (under bun a rejected async listener ends the daemon)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/email-outbound-content-worker.ts', import.meta.url), 'utf8')
  assert.match(src, /\nparentPort\?\.on\('message', \(job: ContentJob\) => \{\n {2}turn = turn\.then\(\(\) => runJob\(job\)\)\.catch\(\(\) => \{\}\)\n\}\)\n/)
  assert.equal(/\.on\(\s*'message'\s*,\s*async\b/.test(src), false, 'no async message listener')
  assert.equal(/\.once\(\s*'message'/.test(src), false)
  // The comments say what the streams are: left unread, nothing written to them.
  assert.equal(/reads and drops|read and dropped/.test(src), false, 'the Worker\'s header comment')
  const quiet = readFileSync(new URL('../lib/email-outbound-content-quiet.ts', import.meta.url), 'utf8')
  assert.equal(/reads and drops|read and dropped/.test(quiet), false, 'the silencer\'s comment')
})

test('review round 9 (round 10: refused, the exemption is gone): a pass column beside an email column is refused whatever its values, a grade beside it or not', async () => {
  const realLooking = 'Hunter2Zebra!'
  const cases: [string[], string[][]][] = [
    // The reviewer's three: a site or login cell beside the pass column, a real looking password in it.
    [['URL', 'Username', 'Pass', 'Score'], [['https://bank.example', 'kc', realLooking, '3']]],
    [['Website', 'Login', 'Pass', 'Result'], [['bank.example', 'kc', realLooking, 'ok']]],
    [['Site', 'User', 'Pass', 'Strength Score'], [['bank.example', 'kc', realLooking, '4']]],
    [['URL', 'Username', 'Pass', 'Score'], [['https://bank.example', 'kc', 'Pass', '3']]],
    [['Account', 'Email', 'Pass', 'Grade'], [['main', 'amy@school.org', 'Pass', 'A']]],
    [['Student', 'Email', 'Grade', 'Pass'], [['Amy', 'amy@school.org', '91', realLooking]]],
    [['Student', 'Email', 'Grade', 'Pass'], [['Amy', 'amy@school.org', '91', 'Pass'], ['Bo', 'bo@school.org', '55', 'hunter22']]],
    // Round 9 let these go (pass or fail words, or nothing); round 10 refuses them: a known false refusal.
    [['Student', 'Email', 'Grade', 'Pass'], [['Amy', 'amy@school.org', '91', 'Pass'], ['Bo', 'bo@school.org', '55', 'Fail']]],
    [['Student', 'Email', 'Score', 'Pass'], [['Amy', 'amy@school.org', '91', 'yes'], ['Bo', 'bo@school.org', '55', 'NO'], ['Cy', 'cy@school.org', '70', 'Y'], ['Di', 'di@school.org', '20', 'n']]],
    [['Name', 'E-mail', 'Final result', 'Exam pass'], [['Amy', 'amy@school.org', '91', 'TRUE'], ['Bo', 'bo@school.org', '55', 'false'], ['Cy', 'cy@school.org', '', '']]],
    [['Student', 'Email', 'Grade', 'Pass'], []],
  ]
  for (const [header, body] of cases) {
    const rows = [header, ...body]
    const label = `${header.join(' | ')} / ${body.map((row) => row.join(' ')).join(' / ')}`
    for (const [name, bytes] of [
      ['table.csv', Buffer.from(`${rows.map((row) => row.join(',')).join('\n')}\n`)],
      ['table.xlsx', xlsxSheetsOf([rows])],
      ['inline.xlsx', xlsxSheetsOf([rows], true)],
      ['table.docx', docxOf(['Term 1'], rows)],
    ] as const) {
      const got = await memRefusal(name, bytes)
      assert.equal(got.why, tableSentence6(got.path), `${label} as ${name}`)
    }
  }
  // A CSV whose names hold a comma in quotes, a CSV longer than the 4096 bytes read, and a Word gradebook followed by
  // another table: all refused (round 9 read their values; round 10 reads none).
  assert.equal((await memRefusal('grades.csv', Buffer.from('Student,Email,Grade,Pass\n"Lee, Amy",amy@school.org,91,Pass\n'))).why, tableSentence6(`${MEM_HOME}\\Documents\\grades.csv`))
  const long = ['Term grades.', 'Student,Email,Grade,Pass', ...Array.from({ length: 400 }, (_, i) => `Student ${i},s${i}@school.org,${50 + (i % 50)},${i % 2 ? 'Pass' : 'Fail'}`)].join('\n')
  assert.ok(long.length > 4096)
  assert.equal((await memRefusal('grades.csv', Buffer.from(long))).why, tableSentence6(`${MEM_HOME}\\Documents\\grades.csv`))
  assert.equal((await memRefusal('report.docx', docxOf(['Term 1'], [['Student', 'Email', 'Grade', 'Pass'], ['Amy', 'amy@school.org', '91', 'Pass']], [['Room', 'Day', 'Time', 'Teacher'], ['B2', 'Monday', '9:00', 'Ms Kay']]))).why, tableSentence6(`${MEM_HOME}\\Documents\\report.docx`))
})

// ── review round 10: no gradebook exemption, elements counted against the cap on words, the sentence past the cap ──

test('review round 10: the reviewer\'s gradebook shapes are refused as password exports, sparse, merged or quoted, and the strict rules are unchanged', async () => {
  const pw = 'Tr0ub4dor&3x'
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const inl = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t>${esc(s)}</t></is></c>`
  const hdr = `<row r="1">${inl('A1', 'Student')}${inl('B1', 'Email')}${inl('C1', 'Grade')}${inl('D1', 'Pass')}</row>`
  const sheet = (rows: string) => zipRaw([...XLSX_BASE, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) }])
  const tc = (s: string, pr = '') => `<w:tc>${pr}<w:p><w:r><w:t>${esc(s)}</w:t></w:r></w:p></w:tc>`
  const gradebook = [['Student', 'Email', 'Grade', 'Pass'], ['Amy', 'amy@school.org', 'A', pw], ['Ben', 'ben@school.org', 'B', 'Pa55word!']]
  const passFail = [['Student', 'Email', 'Grade', 'Pass'], ['Amy', 'amy@school.org', 'A', 'pass'], ['Ben', 'ben@school.org', 'B', 'fail']]
  const csv = (rows: string[][]) => Buffer.from(`${rows.map((row) => row.join(',')).join('\n')}\n`)
  const refused: [string, Buffer][] = [
    // grade.mjs's four shapes that round 9 let through.
    ['xlsxSparse.xlsx', sheet(`${hdr}<row r="2">${inl('A2', 'Amy')}${inl('C2', 'A')}${inl('D2', pw)}</row><row r="3">${inl('A3', 'Ben')}${inl('C3', 'B')}${inl('D3', 'Pa55word!')}</row>`)],
    ['xlsxSparseGradeEmpty.xlsx', sheet(`${hdr}<row r="2">${inl('A2', 'Amy')}${inl('B2', 'amy@school.org')}${inl('D2', pw)}</row>`)],
    ['docxSpan.docx', docxRaw(`<w:tbl><w:tr>${tc('Student')}${tc('Email')}${tc('Grade')}${tc('Pass')}</w:tr><w:tr>${tc('Amy amy@school.org', '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>')}${tc('A')}${tc(pw)}</w:tr></w:tbl>`)],
    ['csvQuotedHeader.csv', Buffer.from(`"Student, full name",Email,Grade,Pass\nAmy Lee,amy@school.org,A,${pw}\n`)],
    // The dense ones, in every format.
    ['dense.csv', csv(gradebook)],
    ['dense.xlsx', xlsxSheetsOf([gradebook])],
    ['dense inline.xlsx', xlsxSheetsOf([gradebook], true)],
    ['dense.docx', docxOf(['Grades'], gradebook)],
    // Student, Email, Grade, Pass over pass and fail words: refused too (a known false refusal, in Known limits).
    ['pass fail.csv', csv(passFail)],
    ['pass fail.xlsx', xlsxSheetsOf([passFail])],
    ['pass fail inline.xlsx', xlsxSheetsOf([passFail], true)],
    ['pass fail.docx', docxOf(['Grades'], passFail)],
    // The strict rules: a real password column alone, and a loose one beside a site or user.
    ['export.csv', csv([['name', 'url', 'username', 'password'], ['g', 'https://g.example', 'me', pw]])],
    ['term sheet.xlsx', xlsxSheetsOf([[['Student', 'Grade', 'Password'], ['Amy', 'A', pw]]])],
    ['sites.docx', docxOf(['Logins'], [['Site', 'User', 'Pass'], ['bank.example', 'kc', pw]])],
    ['cards.xlsx', xlsxSheetsOf([[['Bank', 'Login', 'PIN'], ['visa', 'kc', '1234']]])],
  ]
  for (const [name, bytes] of refused) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // Controls that go: no pass column beside an account column (a Result column of Pass and Fail, or no email column).
  for (const [name, bytes] of [
    ['results.csv', csv(R7_GRADEBOOK)],
    ['results.xlsx', xlsxSheetsOf([R7_GRADEBOOK])],
    ['results.docx', docxOf(['Grades'], R7_GRADEBOOK)],
    ['no email.csv', csv([['Student', 'Grade', 'Pass'], ['Amy', 'A', 'pass']])],
    ['scores.xlsx', xlsxSheetsOf([[['Student', 'Email', 'Grade', 'Score'], ['Amy', 'amy@school.org', 'A', '91']]])],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

test('review round 10 (round 11: elements have their own cap): each shared string, row, cell and paragraph counts against OFFICE_ELEMENTS_MAX', { timeout: 180_000 }, async () => {
  const C = await import('../lib/email-outbound-content.ts')
  // Round 11: the elements read have their own cap (round 10 charged 8 characters each against the 25 MB cap on words,
  // which refused ordinary workbooks of 900000 strings of 21 characters). Its export is checked last, so the behaviour
  // goes red first.
  const MAX = 3_000_000
  const rels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  // n shared strings of 'ab', as peak.mjs's siTiny; the sheet's row, cell and value are 3 elements more.
  const tiny = (n: number) =>
    zipRaw([
      ...XLSX_BASE,
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${'<si>ab</si>'.repeat(n)}</sst>`) },
    ])
  const over = MAX + 5000
  const under = MAX - 5000
  // Words alone are far under the cap in both: only the count of elements tells them apart.
  assert.ok(over * 3 < C.OFFICE_TEXT_MAX / 2)
  let got = await memRefusal('tiny strings.xlsx', tiny(over))
  assert.equal(got.why, unsafeSentence(got.path), `${over} shared strings`)
  got = await memRefusal('tiny strings.xlsx', tiny(under))
  assert.equal(got.why, null, `${under} shared strings`)
  // peak.mjs's siTiny itself: 5.7 million <si>ab</si> (about 63 MB of XML), refused.
  got = await memRefusal('siTiny.xlsx', tiny(5_700_000))
  assert.equal(got.why, unsafeSentence(got.path), 'siTiny')
  // Word paragraph ends (one empty line each): 4 million in 24 MB are past the cap; 2.5 million go.
  const paragraphs = (n: number) => docxRaw('</w:p>'.repeat(n))
  got = await memRefusal('empty lines.docx', paragraphs(4_000_000))
  assert.equal(got.why, unsafeSentence(got.path), '4 million paragraphs')
  assert.equal((await memRefusal('empty lines.docx', paragraphs(2_500_000))).why, null, '2.5 million paragraphs')
  // A Word table of rows of one empty cell: each row and cell is read twice (the rows, then the first column), so
  // four elements a row. 1.2 million rows (24 MB) are past the cap; 400000 go.
  const table = (n: number) => docxRaw(`<w:tbl>${'<w:tr><w:tc/></w:tr>'.repeat(n)}</w:tbl>`)
  assert.ok(1_200_000 * 4 > MAX && 400_000 * 4 < MAX)
  got = await memRefusal('rows.docx', table(1_200_000))
  assert.equal(got.why, unsafeSentence(got.path), '1.2 million rows')
  assert.equal((await memRefusal('rows.docx', table(400_000))).why, null, '400000 rows')
  assert.equal((C as Record<string, unknown>).OFFICE_ELEMENTS_MAX, MAX)
  assert.equal((C as Record<string, unknown>).OFFICE_ELEMENT_CHARS, undefined, 'no element is charged against the cap on words')
})

test('review round 10: the shared strings and the joined lines hold one string per 4096 pieces, not a string each', async () => {
  // Added after the round 10 mutant batch: e10-strings-held-bun (every shared string also kept in an array) passed the
  // bun memory check in 2 of 3 runs (peak 692 to 701 MB against a 700 MB bound), so the shape is pinned here.
  const C = await import('../lib/email-outbound-content.ts')
  type Pieces = { push(piece: string): void; text(): string; length: number }
  type Shared = { push(words: string): void; done(): void; at(index: number): string | undefined; lines(): string; count: number }
  const T = (C as Record<string, unknown>).TEXT_PIECES_FOR_TESTS as
    | { TextPieces: new () => Pieces; SharedStrings: new () => Shared; PIECES_PER_CHUNK: number }
    | undefined
  assert.ok(T, 'TEXT_PIECES_FOR_TESTS is exported')
  const chunk = T.PIECES_PER_CHUNK
  assert.equal(chunk, 4096)
  // Every string reachable from an object through its own properties (arrays and nested objects too).
  const held = (root: unknown): number => {
    let count = 0
    const seen = new Set<object>()
    const walk = (value: unknown): void => {
      if (typeof value === 'string') { count++; return }
      if (value === null || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return
      seen.add(value)
      for (const key of Reflect.ownKeys(value)) walk((value as Record<string | symbol, unknown>)[key])
    }
    walk(root)
    return count
  }
  const n = 200_000
  const pieces = new T.TextPieces()
  for (let i = 0; i < n; i++) pieces.push('x')
  assert.ok(held(pieces) <= chunk + Math.ceil(n / chunk) + 2, `TextPieces holds ${held(pieces)} strings for ${n} pieces`)
  assert.equal(pieces.text(), 'x'.repeat(n))
  assert.ok(held(pieces) <= 2, `TextPieces holds ${held(pieces)} strings once joined`)
  const shared = new T.SharedStrings()
  for (let i = 0; i < n; i++) shared.push(`s${i}`)
  // Each string and its line break are two pieces.
  assert.ok(held(shared) <= chunk + Math.ceil((2 * n) / chunk) + 4, `SharedStrings holds ${held(shared)} strings for ${n}`)
  shared.done()
  assert.ok(held(shared) <= 4, `SharedStrings holds ${held(shared)} strings once done`)
  assert.equal(shared.count, n)
  assert.equal(shared.at(0), 's0')
  assert.equal(shared.at(12345), 's12345')
  assert.equal(shared.at(n - 1), `s${n - 1}`)
  assert.equal(shared.at(n), undefined)
  assert.equal(shared.at(-1), undefined)
  assert.equal(shared.lines().split('\n').length, n)
})

// ── Review round 11 ──────────────────────────────────────────────────────────

/** Round 11: a workbook whose sheets' first rows point `refs` times at shared string 0 (`body`), in sheets of 25000 cells. */
function r11Amp(body: string, refs: number): Buffer {
  const sheets: ZipPart[] = []
  for (let n = 0; n * 25_000 < refs; n++) {
    const cells = '<c t="s"><v>0</v></c>'.repeat(Math.min(25_000, refs - n * 25_000))
    sheets.push({ name: `xl/worksheets/sheet${n + 1}.xml`, data: sheetXml(`<row r="1">${cells}</row>`) })
  }
  return zipRaw([...XLSX_BASE, ...sheets, { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst><si><t xml:space="preserve">${body}</t></si></sst>`) }])
}

test('review round 11: each cell that points at a shared string is charged its words, so 50000 references to a 1 MB string are refused in bounded work', { timeout: 120_000 }, async () => {
  const C = await import('../lib/email-outbound-content.ts')
  type Shared = { prototype: { at(index: number): string | undefined } }
  const T = (C as Record<string, unknown>).TEXT_PIECES_FOR_TESTS as { SharedStrings: Shared }
  // The characters handed out by the shared strings (every reference a row reads goes through at): past this many, the
  // read is stopped here, so the test fails at once rather than reading 50 GB.
  const bound = C.OFFICE_TEXT_MAX + 2 * MB
  const at = T.SharedStrings.prototype.at
  let handed = 0
  T.SharedStrings.prototype.at = function (this: unknown, index: number) {
    const words = at.call(this, index)
    handed += words?.length ?? 0
    if (handed > bound) throw new Error(`the shared strings handed out more than ${bound} characters`)
    return words
  }
  try {
    for (const [name, body] of [
      ['amp words', 'Ab '.repeat(Math.floor(MB / 3))],
      ['amp spaces', ' '.repeat(MB)],
    ] as const) {
      handed = 0
      const started = performance.now()
      const verdict = await C.outboundContentVerdict(new Uint8Array(r11Amp(body, 50_000)), 'xlsx', `${name}.xlsx`, [])
      const ms = performance.now() - started
      assert.deepEqual(verdict, { kind: 'unsafe' }, name)
      assert.ok(handed <= bound, `${name}: ${handed} characters handed out`)
      assert.ok(ms < 20_000, `${name} took ${Math.round(ms)} ms`)
    }
    // Ordinary references still read: a header of shared strings, each referenced once, is judged.
    const header = xlsxSheetsOf([[['Site', 'Username', 'Password'], ['bank.example', 'kc', 'Tr0ub4dor&3x']]])
    handed = 0
    assert.deepEqual(await C.outboundContentVerdict(new Uint8Array(header), 'xlsx', 'logins.xlsx', []), { kind: 'table' })
  } finally {
    T.SharedStrings.prototype.at = at
  }
})

test('review round 11: a cell longer than a header is judged on its last characters only, and a row reads the budget as it goes', async () => {
  const C = await import('../lib/email-outbound-content.ts')
  const H = (C as Record<string, unknown>).HEADER_FOR_TESTS as
    | { PasswordRow: new (clock?: { deadline: number }) => { add(cell: string): void; names: boolean }; headerName(cell: string): string; HEADER_CELL_MAX: number }
    | undefined
  assert.ok(H, 'HEADER_FOR_TESTS is exported')
  const names = (...cells: string[]) => {
    const row = new H.PasswordRow()
    for (const cell of cells) row.add(cell)
    return row.names
  }
  const long = 'note '.repeat(200_000)
  // A long cell that ends in a password word is still a password column; one whose last word only ends in one is not.
  assert.equal(names(`${long}Password`), true)
  assert.equal(names(`${long}Password   \n `), true)
  assert.equal(names(`${long.slice(0, -1)}xPassword`), false)
  assert.equal(names(`${long}Pass`, 'Email'), true)
  assert.equal(names(`${long}Notes`, 'Email'), false)
  // The name of a long cell is read from a bounded window, whatever its length.
  assert.ok(H.headerName(`${long}Password`).length <= H.HEADER_CELL_MAX, 'bounded name')
  assert.equal(H.headerName('x'.repeat(1_000_000)), '', 'a long cell with no separator names nothing')
  // Over the budget, a row stops (the Worker answers itself).
  const OverBudget = (C.CONTENT_WALKS_FOR_TESTS as Record<string, unknown>).OverBudget as new () => Error
  const row = new H.PasswordRow({ deadline: 0 })
  assert.throws(() => {
    for (let i = 0; i < 1000; i++) row.add('cell')
  }, OverBudget)
})

test('review round 11: 900000 shared strings of 21 and of 25 characters go; siTiny is still refused', { timeout: 300_000 }, async () => {
  const rels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  const orders = (n: number, length: number) => {
    const si: string[] = []
    for (let i = 0; i < n; i++) si.push(`<si><t>${`Ref-${String(i).padStart(7, '0')}-TqZzyWwvvXxkkPpqRr`.slice(0, length)}</t></si>`)
    return zipRaw([
      ...XLSX_BASE,
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Order', 'Customer', 'Status'])) },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${si.join('')}</sst>`) },
    ])
  }
  for (const length of [21, 25]) {
    const got = await memRefusal(`orders ${length}.xlsx`, orders(900_000, length))
    assert.equal(got.why, null, `900000 strings of ${length} characters`)
  }
  const tiny = zipRaw([
    ...XLSX_BASE,
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${'<si>ab</si>'.repeat(5_700_000)}</sst>`) },
  ])
  const got = await memRefusal('siTiny.xlsx', tiny)
  assert.equal(got.why, unsafeSentence(got.path), 'siTiny')
})

/** Round 11: a Word file of paragraphs, each split into runs at its tabs (<w:tab/>), as Word writes a tabbed line. */
function r11Paragraphs(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const para = (line: string) => `<w:p>${line.split('\t').map((run) => `<w:r><w:t xml:space="preserve">${esc(run)}</w:t></w:r>`).join('<w:r><w:tab/></w:r>')}</w:p>`
  return docxRaw(lines.map(para).join(''))
}

test('review round 11: a password list typed as Word paragraphs (tabs, commas, bars) is refused as a text file\'s is; prose that mentions a password goes', async () => {
  const pw = 'Hunter2Zebra!'
  for (const [name, lines] of [
    // walls2.mjs's notes7.docx shapes.
    ['notes7 tabs.docx', ['My accounts', 'Site\tUsername\tPassword', `gmail.com\tbob@x.com\t${pw}`, 'chase.com\tbob77\tQ9v!r3Lm2x']],
    ['notes7 commas.docx', ['Site, Username, Password', `gmail.com, bob@x.com, ${pw}`]],
    ['notes7 loose.docx', ['Site\tUser\tPass', `gmail.com\tbob\t${pw}`]],
    ['notes7 bars.docx', ['Logins', 'Site | Login | PIN', 'bank.example | bob | 4321']],
    // Below the first five lines, a paragraph with a strict word as one of its cells.
    ['notes7 deep.docx', ['My accounts', 'Kept up to date', 'Do not share', 'Owner: Bob', 'Version 3', 'Updated weekly', 'Site\tUsername\tPassword', `gmail.com\tbob@x.com\t${pw}`]],
  ] as const) {
    const got = await memRefusal(name, r11Paragraphs([...lines]))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // The same lines as a text file are refused the same way (the rule Word now shares).
  const txt = await memRefusal('notes7.txt', Buffer.from('Site\tUsername\tPassword\ngmail.com\tbob@x.com\tHunter2Zebra!\n'))
  assert.equal(txt.why, tableSentence6(txt.path))
  // Prose that mentions a password, with commas, goes.
  const prose = [
    'Onboarding notes',
    'Welcome to the team; we are glad you are here.',
    'Your laptop is ready on day one, and IT will help you choose a password on your first morning.',
    // A line of prose that ends in a password word and a full stop is not a header (a paragraph keeps its marks).
    'Keep it to yourself and once a year change your password.',
    'Lunch is at noon in the kitchen.',
    'If you forget your password, ask IT at the front desk, and they will reset it.',
    'The password manager, the wiki and the calendar are linked from the intranet.',
  ]
  assert.equal((await memRefusal('onboarding.docx', r11Paragraphs(prose))).why, null, 'onboarding.docx')
  // An ordinary tabbed list goes.
  assert.equal((await memRefusal('stock.docx', r11Paragraphs(['Stock', 'Item\tQty\tPrice', 'Widget\t4\t12.50']))).why, null, 'stock.docx')
})

test('review round 11: a header cell is read with its whitespace collapsed, its trailing marks and a parenthesised note taken off', async () => {
  const pw = 'Hunter2Zebra!'
  for (const header of ['Password (current)', 'Login\nPassword', 'Password  (old, 2024):', '  "PASSWORD." ', 'Site\tpassword']) {
    const got = await memRefusal('list7.xlsx', xlsxSheetsOf([[['Name', header], ['bob', pw]]]))
    assert.equal(got.why, tableSentence6(got.path), JSON.stringify(header))
  }
  const csv = await memRefusal('list7.csv', Buffer.from(`Name,Password (current)\nbob,${pw}\n`))
  assert.equal(csv.why, tableSentence6(csv.path), 'csv')
  // A text file's line keeps its trailing marks: 'Password: ********' is a placeholder, and 'Password:' a label the
  // written password rules read (round 3 and 4).
  assert.equal((await memRefusal('policy.txt', Buffer.from('Rules\nPassword: ********\n'))).why, null, 'policy.txt')
  // Ordinary headers are unchanged: they go. A cell of five words or more is prose and keeps its marks.
  for (const header of ['Notes (internal)', 'Pass rate (%)', 'Passport (number)', 'Status:', 'Password policy', 'Bypass (yes/no)', 'Remember to reset your password.']) {
    const got = await memRefusal('sheet.xlsx', xlsxSheetsOf([[['Name', 'Email', header], ['bob', 'bob@x.com', 'ok']]]))
    assert.equal(got.why, null, JSON.stringify(header))
  }
})

test('review round 11: XML text is read in pieces: the same words as before, and the budget read as it goes', async () => {
  const C = await import('../lib/email-outbound-content.ts')
  const H = (C as Record<string, unknown>).HEADER_FOR_TESTS as { xmlText(xml: string, clock?: { deadline: number }): string } | undefined
  assert.ok(H, 'HEADER_FOR_TESTS is exported')
  // The reading of round 10 (tags out, then the entities over the whole text with one regex), to compare with.
  const before = (xml: string): string => {
    const out: string[] = []
    let at = 0
    for (;;) {
      const lt = xml.indexOf('<', at)
      if (lt < 0) { out.push(xml.slice(at)); break }
      out.push(xml.slice(at, lt))
      const gt = xml.indexOf('>', lt + 1)
      if (gt < 0) { out.push(xml.slice(lt)); break }
      const brk = gt - lt <= 64 ? /^<(?:[a-z_][\w.-]*:)?(tab|br)\/>$/i.exec(xml.slice(lt, gt + 1))?.[1] : undefined
      if (brk === 'tab') out.push('\t')
      else if (brk === 'br') out.push('\n')
      at = gt + 1
    }
    return out.join('').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, named) => {
      if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named.toLowerCase()]!
      const code = dec ? Number(dec) : Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
  }
  const bits = ['&', '&amp;', '&AMP;', '&Lt;', '&gt;', '&quot;', '&apos;', '&#65;', '&#x41;', '&#X1F600;', '&#0000065;', '&#0;', '&#1114112;', '&#99999999999999999999;', '&#x;', '&#;', '&#12a;', '&lt', '&&lt;', ';', '#', 'x', 'a', 'B', ' ', '<w:tab/>', '<x:br/>', '<w:t>', '</w:t>', '<', '>', '&l<a/>t;', '<b', 'é', '😀']
  let seed = 7
  for (let n = 0; n < 3000; n++) {
    let xml = ''
    const length = 1 + (n % 40)
    for (let k = 0; k < length; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      xml += bits[seed % bits.length]
    }
    assert.equal(H.xmlText(xml), before(xml), JSON.stringify(xml))
  }
  const big = '&lt;b<w:t>x</w:t>'.repeat(200_000)
  assert.equal(H.xmlText(big), before(big))
  const OverBudget = (C.CONTENT_WALKS_FOR_TESTS as Record<string, unknown>).OverBudget as new () => Error
  assert.throws(() => H.xmlText('<a>b'.repeat(10_000), { deadline: 0 }), OverBudget, 'tags')
  assert.throws(() => H.xmlText('&lt;'.repeat(10_000), { deadline: 0 }), OverBudget, 'entities')
})

// ── Review round 12 ──────────────────────────────────────────────────────────

/** Round 12: lines of ordinary office prose, to put a line below the first five non empty paragraphs. */
const R12_FILLER = ['Thank you for joining the team.', 'Your manager will meet you on your first day.', 'Lunch is served at noon in the canteen.', 'Parking is free for staff.', 'Please bring a photo ID.', 'The office opens at 8am.']

test('review round 12: ordinary Word and Excel files that mention a password go (titles, headings, how to sentences, FAQ cells)', async () => {
  for (const [name, bytes] of [
    ['reset guide.docx', r11Paragraphs(['How to reset your password', ...R12_FILLER])],
    ['policy.docx', r11Paragraphs(['Information Security Policy', '1. Scope', 'This policy applies to all staff.', '2. Passwords', 'Use a long passphrase and never share it.', ...R12_FILLER])],
    ['it onboarding.docx', r11Paragraphs(['IT Onboarding', 'Welcome!', 'To sign in, enter your username and password, then click OK.', ...R12_FILLER])],
    ['app code.docx', r11Paragraphs([...R12_FILLER, 'Enter your email, password, and the code from the app.'])],
    ['never share.docx', r11Paragraphs([...R12_FILLER, 'Never share any of these: PINs, passwords, or keys.'])],
    // Below the fifth paragraph, a strict word beside only one other short cell is a heading, not a header.
    ['keys heading.docx', r11Paragraphs([...R12_FILLER, 'Passwords, PINs', 'Keep them in the company vault.'])],
    ['faq.docx', docxOf(['Help desk FAQ', ...R12_FILLER], [['Question', 'Answer'], ['Forgot your password?', 'Use the reset link on the sign in page.']])],
    ['faq.xlsx', xlsxSheetsOf([[['Question', 'Answer'], ['Forgot your password?', 'Use the reset link.']]])],
    ['faq inline.xlsx', xlsxSheetsOf([[['Question', 'Answer'], ['Forgot your password?', 'Use the reset link.']]], true)],
    // A title split by one dash or slash is not a list (R12.4 reads ' - ' and ' / ' only when there are two of them).
    ['overview.docx', r11Paragraphs(['Passwords - Overview', 'Password / PIN policy', ...R12_FILLER])],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
  // The header length rule as headerName reads a cell: '?' is never taken off, and trailing marks only off a cell of
  // at most 2 words.
  const C = await import('../lib/email-outbound-content.ts')
  const H = (C as Record<string, unknown>).HEADER_FOR_TESTS as { headerName(cell: string, tableCell?: boolean): string }
  assert.equal(H.headerName('Forgot your password?'), 'forgot your password?')
  assert.equal(H.headerName('Password?'), 'password?')
  assert.equal(H.headerName('Your password.'), 'your password')
  assert.equal(H.headerName('Remember your password.'), 'remember your password.')
  assert.equal(H.headerName('Password  (old, 2024):'), 'password')
  assert.equal(H.headerName('  "PASSWORD." '), 'password')
})

test('review round 12: a password list typed with dashes or slashes, and a strict word with a star, hash or number, are refused', async () => {
  const pw = 'Hunter2Zebra!'
  for (const [name, bytes] of [
    ['dashes deep.docx', r11Paragraphs([...R12_FILLER, 'Site - Username - Password', `gmail.com - bob@gmail.com - ${pw}`])],
    ['slashes.docx', r11Paragraphs(['Website / Username / Password', `gmail.com / bob / ${pw}`])],
    ['star deep.docx', r11Paragraphs([...R12_FILLER, 'Site\tUser\tPassword*', `gmail\tbob\t${pw}`])],
    ['star.xlsx', xlsxSheetsOf([[['Site', 'User', 'Password*'], ['gmail', 'bob', pw]]])],
    ['one.xlsx', xlsxSheetsOf([[['Site', 'User', 'Password 1'], ['gmail', 'bob', pw]]])],
    ['hash.xlsx', xlsxSheetsOf([[['Site', 'User', 'Password #'], ['gmail', 'bob', pw]]])],
    ['glued.xlsx', xlsxSheetsOf([[['Site', 'User', 'Passwort2'], ['gmail', 'bob', pw]]])],
    ['star.csv', Buffer.from(`Site,User,Password*\ngmail,bob,${pw}\n`)],
    // Found by the round 12 differential (round 10 refused these, round 11 did not): a quoted header after a long run
    // of whitespace is read whole, as round 10 read it.
    ['spaced.xlsx', xlsxSheetsOf([[['Site', 'User', `${' '.repeat(300)}"Password"`], ['gmail', 'bob', pw]]])],
    ['spaced.csv', Buffer.from(`Site,User,${' '.repeat(300)}"Password"\ngmail,bob,${pw}\n`)],
    ['spaced end.xlsx', xlsxSheetsOf([[['Site', 'User', `Password${' '.repeat(300)}"`], ['gmail', 'bob', pw]]])],
    ['spaced loose.xlsx', xlsxSheetsOf([[['User', `secret${' '.repeat(301)}"`], ['bob', pw]]])],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // Controls: three words, a long run of stars (a placeholder), and a pass or passport with a number.
  for (const header of ['Password policy 2', 'Topic: Passwords 2', 'Pass 1', 'Passport 1', 'Bypass #']) {
    const got = await memRefusal('sheet.xlsx', xlsxSheetsOf([[['Name', header], ['bob', 'ok']]]))
    assert.equal(got.why, null, JSON.stringify(header))
  }
  assert.equal((await memRefusal('policy.txt', Buffer.from('Rules\nPassword ********\n'))).why, null, 'policy.txt')
})

/**
 * Round 15: the least time of `runs` runs of each call, the calls taken in turn (a loaded machine only slows a run, so
 * the least is the closest to the work itself, and the calls share whatever load there is).
 */
async function r15LeastMs(runs: number, ...calls: (() => unknown)[]): Promise<number[]> {
  const best = calls.map(() => Number.POSITIVE_INFINITY)
  for (let run = 0; run < runs; run++) {
    for (const [k, call] of calls.entries()) {
      const started = performance.now()
      await call()
      best[k] = Math.min(best[k]!, performance.now() - started)
    }
  }
  return best
}

/**
 * Round 15: linear work on an input 4x longer takes about 4x as long, quadratic work 16x. A run is linear when the
 * longer input took less than R15_RATIO_MAX times the shorter one (the shorter read as at least R15_FLOOR_MS, so a
 * run of a few ms is not judged on its noise), and under a generous ceiling.
 */
const R15_RATIO_MAX = 8
const R15_FLOOR_MS = 10
function r15Linear(label: string, short: number, long: number, ceiling: number): void {
  const ratio = long / Math.max(short, R15_FLOOR_MS)
  assert.ok(ratio < R15_RATIO_MAX && long < ceiling, `${label}: ${Math.round(short)} ms, 4x longer ${Math.round(long)} ms (ratio ${ratio.toFixed(1)}, ceiling ${ceiling} ms)`)
}

test('review round 12 (round 15: timed against an input 4x shorter): trailing marks are taken off in linear time (255 marks then a letter, and 40000 such cells in a Word file)', async () => {
  const C = await import('../lib/email-outbound-content.ts')
  const H = (C as Record<string, unknown>).HEADER_FOR_TESTS as { headerName(cell: string, tableCell?: boolean): string }
  const marks = '.,;:!'
  const marked = (length: number) => {
    let cell = ''
    for (let i = 0; i < length - 1; i++) cell += marks[i % marks.length]
    return `${cell}x`
  }
  const cell = marked(256)
  assert.equal(cell.length, 256)
  // Round 15: round 12's fixed 500 ms bound failed on a loaded machine (577 to 625 ms under bun, 551 to 860 ms under
  // node) while the lib was no slower. Each input is timed against one 4x shorter (63 marks or dots then a letter).
  const short = marked(64)
  const [hShort, hLong] = await r15LeastMs(3, () => {
    for (let i = 0; i < 20_000; i++) H.headerName(short)
  }, () => {
    for (let i = 0; i < 20_000; i++) H.headerName(cell)
  })
  r15Linear('20000 cells of 63 marks then a letter, and of 255', hShort!, hLong!, 5000)
  assert.equal(H.headerName('Password.;:! ,'), 'password')
  const dotsDoc = (length: number) => {
    const cells = `<w:tc><w:p><w:r><w:t>${'.'.repeat(length - 1)}x</w:t></w:r></w:p></w:tc>`.repeat(40)
    return new Uint8Array(docxRaw(`<w:tbl>${`<w:tr>${cells}</w:tr>`.repeat(1000)}</w:tbl>`))
  }
  const docShort = dotsDoc(64)
  const docLong = dotsDoc(256)
  const verdicts: unknown[] = []
  const [dShort, dLong] = await r15LeastMs(3, async () => {
    verdicts.push(await C.outboundContentVerdict(docShort, 'docx', 'dots.docx', []))
  }, async () => {
    verdicts.push(await C.outboundContentVerdict(docLong, 'docx', 'dots.docx', []))
  })
  for (const got of verdicts) assert.deepEqual(got, { kind: 'ok' })
  r15Linear('40000 Word table cells of 63 dots then a letter, and of 255', dShort!, dLong!, 10_000)
})

test('review round 12 (round 13: the cap is 260): a relationship target longer than the cap is refused as unsafe before it is split', async () => {
  const rels = (target: string) =>
    `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`
  const book = (target: string) =>
    zipRaw([
      ...XLSX_BASE,
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels(target)) },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(inlineRow(1, ['Site', 'Username', 'Password'])) },
    ])
  // Ordinary targets, up to 260 characters (round 12: 1024), are read as before.
  const longest = `worksheets/${'/'.repeat(239)}sheet1.xml`
  assert.equal(longest.length, 260)
  for (const target of ['worksheets/sheet1.xml', '/xl/worksheets/sheet1.xml', '../xl/worksheets/sheet1.xml', 'worksheets\\sheet1.xml', './worksheets/./sheet1.xml', longest]) {
    const got = await memRefusal('sites.xlsx', book(target))
    assert.equal(got.why, tableSentence6(got.path), JSON.stringify(target.slice(0, 40)))
  }
  const over = await memRefusal('sites.xlsx', book(`worksheets/${'/'.repeat(240)}sheet1.xml`))
  assert.equal(over.why, unsafeSentence(over.path), '261 characters')
  // The reviewer's shape, at a million segments (2 MB): refused as unsafe, fast.
  const big = await memRefusal('split.xlsx', book('a/'.repeat(1_000_000)))
  assert.equal(big.why, unsafeSentence(big.path), "'a/' a million times")
  assert.ok(big.ms < 3000, `'a/' a million times took ${Math.round(big.ms)} ms`)
  // The walk by indexOf folds a target as the split did.
  const C = await import('../lib/email-outbound-content.ts')
  const R = (C as Record<string, unknown>).RELS_FOR_TESTS as { workbookTarget(target: string): string; REL_TARGET_MAX: number } | undefined
  assert.ok(R, 'RELS_FOR_TESTS is exported')
  assert.equal(R.REL_TARGET_MAX, 260)
  const before = (target: string) => {
    const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\\/g, '/').split('/')
    const out: string[] = []
    for (const part of parts) {
      if (part === '..') out.pop()
      else if (part !== '.' && part !== '') out.push(part)
    }
    return out.join('/').toLowerCase()
  }
  const bits = ['/', '\\', '.', '..', 'a', 'Sheet1.xml', 'xl', 'worksheets', '...', ' ', '%2F']
  let seed = 11
  for (let n = 0; n < 3000; n++) {
    let target = ''
    for (let k = 0; k <= n % 12; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      target += bits[seed % bits.length]
    }
    assert.equal(R.workbookTarget(target), before(target), JSON.stringify(target))
  }
})

// ── Review round 13 ──────────────────────────────────────────────────────────

const R13_WORKSHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
/** Round 13: a workbook of these relationships (each [type, target, id padding]) and sheets, built in memory. */
function r13Book(rels: string, sheets: [string, string[]][] = [['xl/worksheets/sheet1.xml', ['Item', 'Qty']]]): Buffer {
  return zipRaw([
    ...XLSX_BASE,
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0"?><Relationships>${rels}</Relationships>`) },
    ...sheets.map(([name, cells]) => ({ name, data: sheetXml(inlineRow(1, cells)) })),
  ])
}
const r13Rel = (id: string, target: string, type = R13_WORKSHEET) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
/** Round 13: `n` distinct worksheet targets of `length` characters each (the round 12 reviewer's relsMany shape). */
function r13ManyTargets(n: number, length: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const head = `${i.toString(36)}/`
    out.push(r13Rel(`r${i}`, (head + 'a/'.repeat(length)).slice(0, length)))
  }
  return out.join('')
}

test('review round 13: a workbook\'s relationships are capped (65 sheet targets, 4096 relationships, a 2 MB part, targets of 260 characters); ordinary workbooks with many sheets go', { timeout: 120_000 }, async () => {
  // The reviewer's shape: 55000 distinct worksheet targets of 1024 characters, and of 260.
  for (const length of [1024, 260]) {
    const got = await memRefusal('rels.xlsx', r13Book(r13ManyTargets(55_000, length)))
    assert.equal(got.why, unsafeSentence(got.path), `55000 targets of ${length}`)
    assert.ok(got.ms < 500, `55000 targets of ${length} took ${Math.round(got.ms)} ms`)
  }
  // More than 4096 relationships of any type, in a part under 2 MB, are refused; 4000 go.
  const styles = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'
  const others = (n: number) => Array.from({ length: n }, (_, i) => r13Rel(`s${i}`, `styles${i}.xml`, styles)).join('')
  const sheet = r13Rel('rId1', 'worksheets/sheet1.xml')
  const many = await memRefusal('many.xlsx', r13Book(sheet + others(4096)))
  assert.equal(many.why, unsafeSentence(many.path), '4097 relationships')
  assert.equal((await memRefusal('styles.xlsx', r13Book(sheet + others(3999)))).why, null, '4000 relationships')
  // A relationships part past 2 MB is refused, whatever it holds (here 2000 relationships with long ids).
  const padded = Array.from({ length: 2000 }, (_, i) => r13Rel(`p${i}${'x'.repeat(1100)}`, `styles${i}.xml`, styles)).join('')
  assert.ok(padded.length > 2 * MB)
  const big = await memRefusal('big rels.xlsx', r13Book(sheet + padded))
  assert.equal(big.why, unsafeSentence(big.path), 'a part past 2 MB')
  // A target of 260 characters is read; 261 is refused as unsafe.
  const header: [string, string[]][] = [['xl/worksheets/sheet1.xml', ['Site', 'Username', 'Password']]]
  const longest = `worksheets/${'/'.repeat(239)}sheet1.xml`
  assert.equal(longest.length, 260)
  const read = await memRefusal('sites.xlsx', r13Book(r13Rel('rId1', longest), header))
  assert.equal(read.why, tableSentence6(read.path), '260 characters')
  const over = await memRefusal('sites.xlsx', r13Book(r13Rel('rId1', `worksheets/${'/'.repeat(240)}sheet1.xml`), header))
  assert.equal(over.why, unsafeSentence(over.path), '261 characters')
  // An ordinary workbook of 64 sheets, each named by the relationships, goes; with its header on the last, refused.
  const sheets = (last: string[]) => Array.from({ length: 64 }, (_, i): [string, string[]] => [`xl/worksheets/sheet${i + 1}.xml`, i === 63 ? last : ['Item', 'Qty']])
  const rels64 = Array.from({ length: 64 }, (_, i) => r13Rel(`rId${i + 1}`, `worksheets/sheet${i + 1}.xml`)).join('') + others(20)
  assert.equal((await memRefusal('64 sheets.xlsx', r13Book(rels64, sheets(['Item', 'Qty'])))).why, null, '64 sheets')
  const last = await memRefusal('64 sheets.xlsx', r13Book(rels64, sheets(['Site', 'User', 'Password'])))
  assert.equal(last.why, tableSentence6(last.path), 'header on sheet 64')
  const C = await import('../lib/email-outbound-content.ts')
  const R = (C as Record<string, unknown>).RELS_FOR_TESTS as { REL_TARGET_MAX: number; RELS_MAX: number; RELS_PART_MAX: number }
  assert.deepEqual([R.REL_TARGET_MAX, R.RELS_MAX, R.RELS_PART_MAX], [260, 4096, 2 * MB])
})

/** Round 13: a Word file of paragraphs, a tab (\t) written as <w:tab/> and a line break (\n) as <w:br/>, as Word writes them. */
function r13Paragraphs(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const run = (piece: string) => (piece === '\t' ? '<w:r><w:tab/></w:r>' : piece === '\n' ? '<w:r><w:br/></w:r>' : piece === '' ? '' : `<w:r><w:t xml:space="preserve">${esc(piece)}</w:t></w:r>`)
  return docxRaw(lines.map((line) => `<w:p>${line.split(/(\t|\n)/).map(run).join('')}</w:p>`).join(''))
}
const R13_EN = '\u2013'
const R13_EM = '\u2014'
const R13_ROWS3 = [['gmail.com', 'alice.smith', 'Tr0ub4dor&3x'], ['netflix.com', 'alice@example.com', 'Blue!Horse77']]
const R13_ROWS2 = [['Gmail', 'Tr0ub4dor&3x'], ['Netflix', 'Blue!Horse77']]

test('review round 13: two column lists with tabs or bars deep, Word\'s spaced en and em dashes, space aligned headers and Shift+Enter lines are refused; prose goes', async () => {
  const rows = (sep: string, list: string[][]) => list.map((row) => row.join(sep))
  for (const [name, lines] of [
    ['account tab deep.docx', [...R12_FILLER, 'Account\tPassword', ...rows('\t', R13_ROWS2)]],
    ['username tab deep.docx', [...R12_FILLER, 'Username\tPassword', ...rows('\t', R13_ROWS2)]],
    ['site bar deep.docx', [...R12_FILLER, 'Site | Password', ...rows(' | ', R13_ROWS2)]],
    // Decided for refusal: a comma or semicolon list of two cells whose other cell is one account word.
    ['site comma deep.docx', [...R12_FILLER, 'Site, Password', ...rows(', ', R13_ROWS2)]],
    ['email semicolon deep.docx', [...R12_FILLER, 'Email; Password', ...rows('; ', R13_ROWS2)]],
    ['en dash top.docx', [`Site ${R13_EN} Username ${R13_EN} Password`, ...rows(` ${R13_EN} `, R13_ROWS3)]],
    ['en dash deep.docx', [...R12_FILLER, `Site ${R13_EN} Username ${R13_EN} Password`, ...rows(` ${R13_EN} `, R13_ROWS3)]],
    ['em dash top.docx', [`Site ${R13_EM} User ${R13_EM} Password`, ...rows(` ${R13_EM} `, R13_ROWS3)]],
    ['spaces top.docx', ['Site        Username        Password', ...rows('        ', R13_ROWS3)]],
    ['spaces deep.docx', [...R12_FILLER, 'Site    Username    Password', ...rows('    ', R13_ROWS3)]],
    ['breaks top.docx', [['Site\tUser\tPassword', ...rows('\t', R13_ROWS3)].join('\n')]],
    ['breaks deep.docx', [...R12_FILLER, ['Site\tUser\tPassword', ...rows('\t', R13_ROWS3)].join('\n')]],
    ['breaks second line.docx', [['My accounts', 'Site, Username, Password', ...rows(', ', R13_ROWS3)].join('\n')]],
  ] as const) {
    const got = await memRefusal(name, r13Paragraphs([...lines]))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  for (const [name, lines] of [
    ['overview.docx', [`Passwords ${R13_EN} Overview`, `Password ${R13_EM} PIN policy`, ...R12_FILLER]],
    ['double spaces top.docx', ['Welcome to the team.  Your manager will meet you.  Ask IT to set your password.', 'Reset your  password', 'Thanks.  See you soon.  Bring your password.', ...R12_FILLER]],
    ['double spaces deep.docx', [...R12_FILLER, 'Thanks.  See you soon.  Bring your password.', 'Choose a password.  Keep it safe.  Never share it.']],
    ['fields deep.docx', [...R12_FILLER, 'Fields: Email, Password', 'Passwords, PINs']],
    ['guide.docx', ['How to reset your password', 'To sign in, enter your username and password, then click OK.', ...R12_FILLER, 'Enter your email, password, and the code from the app.', 'Never share any of these: PINs, passwords, or keys.']],
    ['numbered deep.docx', [...R12_FILLER, '2.\tPasswords', 'Password\t________']],
    ['address top.docx', [['Acme Ltd', '1 High Street', 'London'].join('\n'), 'Dear Sam,', 'Your password was reset today.', ...R12_FILLER]],
    // Round 14: each non blank paragraph counts once toward the first five, as in round 12, so a heading below a
    // letterhead of five lines is still at the top (see the round 14 test); below five paragraphs it is deep.
    ['letterhead.docx', [['Acme Ltd', '1 High Street', 'London', 'UK', 'Phone 0123 456'].join('\n'), ...R12_FILLER, 'Passwords, PINs']],
  ] as const) {
    assert.equal((await memRefusal(name, r13Paragraphs([...lines]))).why, null, name)
  }
})

test('review round 13: a sheet or Word table header cell of 3 words that ends with a colon is a label; with a full stop or ! it is prose', async () => {
  const pw = 'Hunter2Zebra!'
  const tableDocx = (header: string) => docxOf(['Accounts'], [['Account', header], ['gmail', pw]])
  for (const header of ['Email account password:', 'Bank login password :']) {
    for (const [name, bytes] of [['list.xlsx', xlsxSheetsOf([[['Account', header], ['gmail', pw]]])], ['list.docx', tableDocx(header)]] as const) {
      const got = await memRefusal(name, bytes)
      assert.equal(got.why, tableSentence6(got.path), `${name} ${JSON.stringify(header)}`)
    }
  }
  for (const header of ['Email account password.', 'Remember your password!', 'Forgot your password?', 'My email account password:']) {
    assert.equal((await memRefusal('notes.xlsx', xlsxSheetsOf([[['Account', header], ['gmail', 'ok']]]))).why, null, JSON.stringify(header))
  }
  const C = await import('../lib/email-outbound-content.ts')
  const H = (C as Record<string, unknown>).HEADER_FOR_TESTS as { headerName(cell: string, tableCell?: boolean, label?: boolean): string }
  // Round 14: the 3 word label is read only when asked (a row's label, read beside an account cell).
  assert.equal(H.headerName('Email account password:', true, true), 'email account password')
  assert.equal(H.headerName('Email account password:'), 'email account password:')
  assert.equal(H.headerName('Email account password.', true, true), 'email account password.')
  assert.equal(H.headerName('Email account password:', false, true), 'email account password:')
})

/** Round 13: a Word file whose central directory has `count` more entries of these names (no local data of their own). */
function r13LongNames(count: number, nameOf: (n: number) => string): Buffer {
  const real = zipOf({ '[Content_Types].xml': officeTypes('docx'), 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>' })
  const end = real.length - 22
  const dirAt = real.readUInt32LE(end + 16)
  const dirLength = real.readUInt32LE(end + 12)
  const parts: Buffer[] = [real.subarray(0, dirAt + dirLength)]
  let extra = 0
  for (let n = 0; n < count; n++) {
    const name = Buffer.from(nameOf(n), 'utf8')
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(name.length, 28)
    parts.push(central, name)
    extra += 46 + name.length
  }
  const tail = Buffer.alloc(22)
  tail.writeUInt32LE(0x06054b50, 0)
  tail.writeUInt16LE(count + 2, 8)
  tail.writeUInt16LE(count + 2, 10)
  tail.writeUInt32LE(dirLength + extra, 12)
  tail.writeUInt32LE(dirAt, 16)
  parts.push(tail)
  return Buffer.concat(parts)
}

test('review round 13: a zip entry name over 1024 bytes is refused before it is decoded, so a 25 MB directory of long names is typed in under 50 ms on the main thread (shared with inbound)', { timeout: 60_000 }, async () => {
  const { isType } = await import('../lib/email-files.ts')
  // The reviewer's shape, a little longer: 1990 names of 13000 slashes, 24.8 MB (a file may be 25 MB).
  const hostile = r13LongNames(1990, (n) => `${n}${'/'.repeat(13_000)}`)
  assert.ok(hostile.length > 24.5 * MB && hostile.length <= 25 * MB)
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    assert.equal(isType(hostile, 'docx'), false)
    const ms = performance.now() - started
    assert.ok(ms < 50, `the type check took ${Math.round(ms)} ms on the main thread`)
  }
  const stop = await stopOf(async () => {
    const got = await heartbeatRefusal('memo.docx', hostile)
    assert.match(String(got.why), /is not really a .* file/)
    return got.maxGap
  }, 50)
  assert.ok(stop <= 50, `memo.docx stopped the main thread for ${Math.round(stop)} ms`)
  // A name of 1024 bytes is read; 1025 is refused. Real Word and Excel files are typed.
  assert.equal(isType(r13LongNames(1, () => `word/${'a'.repeat(1019)}`), 'docx'), true, '1024 bytes')
  assert.equal(isType(r13LongNames(1, () => `word/${'a'.repeat(1020)}`), 'docx'), false, '1025 bytes')
  assert.equal(isType(r13LongNames(1, () => `word/${'\u00e9'.repeat(510)}`), 'docx'), false, '1025 bytes of two byte characters')
  assert.equal(isType(docxOf(['Hello']), 'docx'), true, 'docx')
  assert.equal(isType(xlsxSheetsOf([[['Item', 'Qty']]]), 'xlsx'), true, 'xlsx')
  // The '.' and '..' segments, found by a walk, as the split found them.
  for (const name of ['a/../b', '../x', 'a/.', './a', 'a/./b', 'a/..', '..', '.', 'a//../b']) {
    assert.equal(isType(r13LongNames(1, () => name), 'docx'), false, JSON.stringify(name))
  }
  for (const name of ['a/..b', 'a/...', '.a/b', 'a/.b', 'a..', 'a/b.', 'a//b', 'a/']) {
    assert.equal(isType(r13LongNames(1, () => name), 'docx'), true, JSON.stringify(name))
  }
})

// ── review round 14: converge (paragraph counting, the round 13 narrowing, br and tab tags, zip name bytes) ──

/** Round 14: a Word file of these paragraphs, '\t' and '\n' written as the tags given (Word's, or another generator's). */
function r14Paragraphs(lines: string[], tab = '<w:tab/>', br = '<w:br/>'): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const run = (piece: string) => (piece === '\t' ? `<w:r>${tab}</w:r>` : piece === '\n' ? `<w:r>${br}</w:r>` : piece === '' ? '' : `<w:r><w:t xml:space="preserve">${esc(piece)}</w:t></w:r>`)
  return docxRaw(lines.map((line) => `<w:p>${line.split(/(\t|\n)/).map(run).join('')}</w:p>`).join(''))
}
const R14_LETTERHEAD = ['Alice Smith', '12 Main Street', 'Springfield', 'IL 62701', 'alice@example.com'].join('\n')
const R14_TITLE = ['Family accounts', 'Updated March 2026', 'Private', ''].join('\n')

test('review round 14: a paragraph counts once toward the first five, whatever its line breaks; each of its lines among them gets the top table check', async () => {
  const rows = (sep: string, list: string[][]) => list.map((row) => row.join(sep))
  for (const [name, lines] of [
    ['letterhead 1.docx', [R14_LETTERHEAD, 'Site, Login, Pass', ...rows(', ', R13_ROWS3)]],
    ['letterhead 2.docx', [R14_LETTERHEAD, 'Bank, Password', ...rows(', ', R13_ROWS2)]],
    ['letterhead 3.docx', [R14_LETTERHEAD, 'Account\tPIN', 'Visa\t4921', 'Bank\t7731']],
    ['title block.docx', [R14_TITLE, 'For the family.', 'Keep it safe.', 'Site\tUser\tPW', ...rows('\t', R13_ROWS3)]],
    // A line of a top paragraph is judged on its own: the list on the third line of a letterhead.
    ['header in letterhead.docx', [['Alice Smith', 'Accounts', 'Site\tUser\tPW', ...rows('\t', R13_ROWS3)].join('\n')]],
  ] as const) {
    const got = await memRefusal(name, r14Paragraphs([...lines]))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  for (const [name, lines] of [
    ['letterhead letter.docx', [R14_LETTERHEAD, 'Dear Sam,', 'Your new password is in the post, as you asked.', ...R12_FILLER]],
    // Below five paragraphs, a loose header is deep (Known limits), as in round 12.
    ['deep loose.docx', [R14_LETTERHEAD, ...R12_FILLER, 'Site\tUser\tPW', ...rows('\t', R13_ROWS3)]],
  ] as const) {
    assert.equal((await memRefusal(name, r14Paragraphs([...lines]))).why, null, name)
  }
})

test('review round 14: below the first five, one other cell needs an account word; a spaced en dash or space run line needs an account or loose cell; ordinary lines go', async () => {
  const rows = (sep: string, list: string[][]) => list.map((row) => row.join(sep))
  for (const [name, lines] of [
    ['account tab.docx', [...R12_FILLER, 'Account\tPassword', ...rows('\t', R13_ROWS2)]],
    ['website tab.docx', [...R12_FILLER, 'Website\tPassword', ...rows('\t', R13_ROWS2)]],
    ['bank bar.docx', [...R12_FILLER, 'Bank | Password', ...rows(' | ', R13_ROWS2)]],
    ['service tab.docx', [...R12_FILLER, 'Service\tPassword', ...rows('\t', R13_ROWS2)]],
    ['en dash top.docx', [`Site ${R13_EN} Username ${R13_EN} Password`, ...rows(` ${R13_EN} `, R13_ROWS3)]],
    ['en dash deep.docx', [...R12_FILLER, `Site ${R13_EN} Username ${R13_EN} Password`, ...rows(` ${R13_EN} `, R13_ROWS3)]],
    ['en dash loose top.docx', [`Site ${R13_EN} Notes ${R13_EN} PIN`, `Visa ${R13_EN} card ${R13_EN} 4921`]],
    ['spaces deep.docx', [...R12_FILLER, 'Site    Username    Password', ...rows('    ', R13_ROWS3)]],
  ] as const) {
    const got = await memRefusal(name, r14Paragraphs([...lines]))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  for (const [name, lines] of [
    ['checklist.docx', [...R12_FILLER, 'Wi-Fi\tConnected', 'Password\tChanged', 'Printer\tInstalled']],
    ['breadcrumb.docx', [...R12_FILLER, 'Home | Passwords', 'Choose a strong one and keep it to yourself.']],
    ['contents.docx', [...R12_FILLER, 'Introduction\tPage 2', 'Passwords\tPage 4', 'Backups\tPage 6']],
    ['glossary.docx', [...R12_FILLER, 'Password\tSecret word', 'Phishing\tA fake email']],
    ['policy title deep.docx', [...R12_FILLER, `IT Policy ${R13_EN} Passwords ${R13_EN} 2026`, 'Use a long one.']],
    ['policy title top.docx', [`Acme ${R13_EN} IT Policy ${R13_EN} Passwords`, 'Use a long one.', ...R12_FILLER]],
    ['policy title spaces.docx', [...R12_FILLER, 'IT Policy    Passwords    2026', 'Use a long one.']],
    ['em dash title top.docx', [`Passwords ${R13_EM} Guide ${R13_EM} Staff`, ...R12_FILLER]],
  ] as const) {
    assert.equal((await memRefusal(name, r14Paragraphs([...lines]))).why, null, name)
  }
})

test('review round 14: a sheet or Word table label of 3 words that ends with a colon names a password column only beside an account cell', async () => {
  const pw = 'Hunter2Zebra!'
  for (const [name, bytes] of [
    ['list.xlsx', xlsxSheetsOf([[['Account', 'Email account password:'], ['gmail', pw]]])],
    ['list.docx', docxOf(['Accounts'], [['Account', 'Email account password:'], ['gmail', pw]])],
    ['user label.xlsx', xlsxSheetsOf([[['User name', 'Your bank PIN:'], ['alice', '4921']]])],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  for (const [name, bytes] of [
    ['how to.xlsx', xlsxSheetsOf([[['Step', 'What to do'], ['Reset your password:', 'Open the portal'], ['Then:', 'Choose a new one']]])],
    ['how to.docx', docxOf(['How to'], [['Change your password:', 'Open Settings, then Security.'], ['Lock your screen:', 'Press Windows and L.']])],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

test('review round 14: tab and line break tags with attributes or whitespace are read (<w:br w:type="textWrapping"/>, <w:br />, <w:tab />)', async () => {
  const rows = (sep: string, list: string[][]) => list.map((row) => row.join(sep))
  const list = ['Site\tUser\tPassword', ...rows('\t', R13_ROWS3)].join('\n')
  for (const [label, tab, br] of [
    ['textWrapping', '<w:tab/>', '<w:br w:type="textWrapping"/>'],
    ['page break', '<w:tab/>', '<w:br w:type="page"/>'],
    ['space', '<w:tab />', '<w:br />'],
    ['clear', '<w:tab  />', '<w:br w:type="textWrapping" w:clear="all" />'],
  ] as const) {
    for (const [where, lines] of [['top', [list]], ['deep', [...R12_FILLER, list]]] as const) {
      const got = await memRefusal(`breaks ${label} ${where}.docx`, r14Paragraphs([...lines], tab, br))
      assert.equal(got.why, tableSentence6(got.path), `${label} ${where}`)
    }
  }
  // Only a short tag is one: a br longer than 64 characters is not read as a line break, and other tags are not tabs
  // or breaks. A tab with attributes is a tab stop (<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs> in a
  // paragraph's properties), not a tab: it is not read as one.
  const C = await import('../lib/email-outbound-content.ts')
  const X = (C as Record<string, unknown>).HEADER_FOR_TESTS as { xmlText(xml: string): string }
  assert.equal(X.xmlText('a<w:br w:type="textWrapping"/>b<w:tab />c<w:br />d<x:br/>e<BR/>f'), 'a\nb\tc\nd\nef')
  assert.equal(X.xmlText(`a<w:br w:x="${'y'.repeat(60)}"/>b`), 'ab')
  assert.equal(X.xmlText('a<w:brk/>b<w:tabs/>c<w:tab>d<w:br>e'), 'abcde')
  assert.equal(X.xmlText('<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>x'), 'x')
  const stops = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>'
  const heading = docxRaw(`<w:p>${stops}<w:r><w:t>Passwords</w:t></w:r></w:p><w:p>${stops}<w:r><w:t>Keep them safe.</w:t></w:r></w:p>`)
  assert.equal((await memRefusal('tab stops.docx', heading)).why, null, 'tab stops')
})

test('review round 14: a zip directory whose entry names pass 256 KB in all is not typed as Office, before its walk; real files are; 20 at once stall the main thread under 50 ms (shared with inbound)', { timeout: 60_000 }, async () => {
  const { isType } = await import('../lib/email-files.ts')
  // 255 names of 1000 bytes (and the two real ones) are under 256 KB; 263 are over.
  const nameOf = (n: number) => `word/media/${String(n).padStart(4, '0')}${'a'.repeat(985)}`
  assert.equal(isType(r13LongNames(255, nameOf), 'docx'), true, '255 KB of names')
  assert.equal(isType(r13LongNames(263, nameOf), 'docx'), false, '263 KB of names')
  assert.equal(isType(docxOf(['Hello']), 'docx'), true, 'docx')
  assert.equal(isType(xlsxSheetsOf([[['Item', 'Qty']]]), 'xlsx'), true, 'xlsx')
  // The round 13 reviewer's shape at the caps: 1990 names of 1024 bytes (2 MB), 20 calls at once.
  const hostile = r13LongNames(1990, (n) => `word/${String(n).padStart(4, '0')}${'b'.repeat(1015)}`)
  const started = performance.now()
  assert.equal(isType(hostile, 'docx'), false)
  assert.ok(performance.now() - started < 20, `the type check took ${Math.round(performance.now() - started)} ms`)
  const stop = await stopOf(async () => {
    let maxGap = 0
    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 10)
    try {
      const got = await Promise.all(Array.from({ length: 20 }, (_, n) => memRefusal(`memo${n}.docx`, hostile)))
      maxGap = Math.max(maxGap, performance.now() - last)
      for (const one of got) assert.match(String(one.why), /is not really a .* file/)
    } finally {
      clearInterval(beat)
    }
    return maxGap
  }, 50)
  assert.ok(stop <= 50, `20 at once stopped the main thread for ${Math.round(stop)} ms`)
})

// ── review round 15: converge (the top check on a paragraph's first five lines, labels beside a lone account cell, account words beside dash lines, round 12's joined paragraph kept) ──

const R15_ROWS = (sep: string, list: string[][]) => list.map((row) => row.join(sep))

test('review round 15: only the first five non blank lines of a top paragraph get the top table check; the letterhead and title block lists stay refused', async () => {
  // The round 14 reviewer's file: one paragraph of 40 Shift+Enter lines, line 34 a UI line.
  const notes = Array.from({ length: 40 }, (_, i) => (i === 33 ? 'New password, confirm password' : `Line ${i} of the notes from the meeting.`)).join('\n')
  const ui = Array.from({ length: 30 }, (_, i) =>
    i === 8 ? 'Sign in | Forgot password' : i === 15 ? 'Settings | Security | Change password' : i === 22 ? 'Account | Change password' : `Note ${i} from the IT session.`,
  ).join('\n')
  for (const [name, lines] of [
    ['softbreak-notes.docx', [notes]],
    ['softbreak-ui.docx', ['Weekly IT notes', ui, 'More text follows in the next paragraphs.']],
    // A blank line (empty, or of spaces only) counts toward nothing: the UI line is still the sixth non blank one.
    ['softbreak-blank.docx', [['Hi all,', '', 'One', 'Two', '  ', 'Three', 'Four', 'Account | Change password'].join('\n')]],
  ] as const) {
    assert.equal((await memRefusal(name, r14Paragraphs([...lines]))).why, null, name)
  }
  for (const [name, lines] of [
    ['letterhead 1.docx', [R14_LETTERHEAD, 'Site, Login, Pass', ...R15_ROWS(', ', R13_ROWS3)]],
    ['title block.docx', [R14_TITLE, 'For the family.', 'Keep it safe.', 'Site\tUser\tPW', ...R15_ROWS('\t', R13_ROWS3)]],
    // The fifth non blank line of a top paragraph still gets the top check, a line of spaces only before it.
    ['header on line 5.docx', [['Alice Smith', 'Accounts', ' ', 'Private', 'Updated 2026', 'Site\tUser\tPW', ...R15_ROWS('\t', R13_ROWS3)].join('\n')]],
  ] as const) {
    const got = await memRefusal(name, r14Paragraphs([...lines]))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
})

test('review round 15: a label\'s password word names a column only beside a lone account cell, never beside another label or a phrase that ends in an account word', async () => {
  const pw = 'Hunter2Zebra!'
  for (const [name, bytes] of [
    ['list.xlsx', xlsxSheetsOf([[['Account', 'Email account password:'], ['gmail', pw]]])],
    ['list.docx', docxOf(['Accounts'], [['Account', 'Email account password:'], ['gmail', pw]])],
    ['user label.xlsx', xlsxSheetsOf([[['User name', 'Your bank PIN:'], ['alice', '4921']]])],
    ['site label.xlsx', xlsxSheetsOf([[['Site', 'Your login password:'], ['gmail', pw]]])],
    ['bank label.docx', docxOf(['Banks'], [['Bank', 'Online banking PIN:'], ['Chase', '4921']])],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  for (const [name, bytes] of [
    ['howto.xlsx', xlsxSheetsOf([[['Task', 'How'], ['Reset your password:', 'Open the portal'], ['Unlock account:', 'Call IT']]])],
    ['howto column.xlsx', xlsxSheetsOf([[['Reset your password:'], ['Update your email:'], ['Book a room:']]])],
    ['pin column.xlsx', xlsxSheetsOf([[['Change your PIN:'], ['Update your email:']]])],
    ['faq.docx', docxOf(['FAQ'], [['Question', 'Answer'], ['Forgot your password?', 'Choose Reset on the sign in page.'], ['Change your password:', 'Open Settings.'], ['Update your login:', 'Ask the IT desk.']])],
    ['faq.xlsx', xlsxSheetsOf([[['Question'], ['Forgot your password?'], ['Change your password:'], ['Update your login:']]])],
  ] as const) {
    assert.equal((await memRefusal(name, bytes)).why, null, name)
  }
})

test('review round 15: on a line split only by en or em dashes or space runs, an account word on its own beside the strict one is enough (Service, Bank, App)', async () => {
  for (const dash of [R13_EN, R13_EM]) {
    const header = `Service ${dash} Password ${dash} Notes`
    const rows = [`Netflix ${dash} Tr0ub4dor&3x ${dash} family`, `Spotify ${dash} Blue!Horse77 ${dash} mine`]
    for (const [name, lines] of [
      ['service top.docx', [header, ...rows]],
      ['service deep.docx', [...R12_FILLER, header, ...rows]],
      ['bank deep.docx', [...R12_FILLER, `Bank ${dash} Password ${dash} Notes`, ...rows]],
    ] as const) {
      const got = await memRefusal(name, r14Paragraphs([...lines]))
      assert.equal(got.why, tableSentence6(got.path), `${name} ${dash === R13_EN ? 'en' : 'em'}`)
    }
  }
  const spaced = await memRefusal('service spaces.docx', r14Paragraphs([...R12_FILLER, 'Service    Password    Notes', 'Netflix    Tr0ub4dor&3x    family']))
  assert.equal(spaced.why, tableSentence6(spaced.path), 'service spaces')
  for (const [name, lines] of [
    ['policy title top.docx', [`Acme ${R13_EN} IT Policy ${R13_EN} Passwords`, 'Use a long one.', ...R12_FILLER]],
    ['policy title deep.docx', [...R12_FILLER, `IT Policy ${R13_EN} Passwords ${R13_EN} 2026`, 'Use a long one.']],
    ['em dash title top.docx', [`Passwords ${R13_EM} Guide ${R13_EM} Staff`, ...R12_FILLER]],
  ] as const) {
    assert.equal((await memRefusal(name, r14Paragraphs([...lines]))).why, null, name)
  }
})

test('review round 15: a paragraph is also judged as one joined line, as round 12 read it, so a header cell split across a line break is refused', async () => {
  for (const [name, lines, br] of [
    // A header wrapped after its comma, at the top and below the first five.
    ['wrapped top.docx', ['Site, Username,\nPassword', ...R15_ROWS(', ', R13_ROWS3)], '<w:br/>'],
    ['wrapped deep.docx', [...R12_FILLER, 'Site, Username,\nPassword', ...R15_ROWS(', ', R13_ROWS3)], '<w:br/>'],
    // A cell that spans a break: round 12 read "Master\nPassword" as master password.
    ['split cell top.docx', ['Website, Login, Master\nPassword', ...R15_ROWS(', ', R13_ROWS3)], '<w:br/>'],
    ['split cell tab top.docx', ['Site\tUser\tOld\nPassword', ...R15_ROWS('\t', R13_ROWS3)], '<w:br/>'],
    // Round 12's own text: a break with attributes was not read, so "Pass" and "word" were one word.
    ['attribute break deep.docx', [...R12_FILLER, 'Site, Login, Pass\nword', ...R15_ROWS(', ', R13_ROWS3)], '<w:br w:type="textWrapping"/>'],
  ] as const) {
    const got = await memRefusal(name, r14Paragraphs([...lines], '<w:tab/>', br))
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // Round 12 sent these, and so does the joined reading.
  for (const [name, lines] of [
    ['address.docx', [R14_LETTERHEAD, 'Dear Sam,', 'Your new password is in the post, as you asked.', ...R12_FILLER]],
    ['notes.docx', [Array.from({ length: 12 }, (_, i) => (i === 8 ? 'Email, then PIN' : `Line ${i}, of the notes`)).join('\n')]],
  ] as const) {
    assert.equal((await memRefusal(name, r14Paragraphs([...lines]))).why, null, name)
  }
  const C = await import('../lib/email-outbound-content.ts')
  const X = (C as Record<string, unknown>).HEADER_FOR_TESTS as { xmlText(xml: string, clock?: unknown, round12?: boolean): string }
  // Round 12's text: only a bare tab or br tag is read.
  assert.equal(X.xmlText('a<w:br w:type="textWrapping"/>b<w:tab />c<w:br/>d<w:tab/>e', undefined, true), 'abc\nd\te')
  assert.equal(X.xmlText('a<w:br w:type="textWrapping"/>b<w:tab />c<w:br/>d<w:tab/>e'), 'a\nb\tc\nd\te')
})

// ── review round 16: a loose word beside a lone account word (Bank | Card | PIN) ──

/**
 * Round 16: an Excel file whose text cells are shared strings and whose number cells are values (`<c><v>4417</v></c>`),
 * as Excel stores a typed PIN: the number is never in the file's text.
 */
function r16NumberSheet(rows: (string | number)[][]): Buffer {
  const strings: string[] = []
  const xml = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
      strings.push(cell)
      return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`
    }).join('')}</row>`)
    .join('')
  return zipOf({
    '[Content_Types].xml': officeTypes('xlsx'),
    'xl/workbook.xml': '<workbook/>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${xml}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
  })
}

test('review round 16: a loose word (PIN, Pass) beside a lone account word (Bank, Service, App) names a password column, in a sheet, a Word table, a text file and Word paragraphs', async () => {
  // The round 15 reviewer's card PIN lists, each under a neutral name (pins.xlsx is refused by its name alone).
  const cards = [['Bank', 'Card', 'PIN'], ['Chase', 'Visa', '4417'], ['HSBC', 'Mastercard', '9921']]
  for (const [name, bytes] of [
    ['cards.xlsx', xlsxSheetsOf([cards])],
    ['cards inline.xlsx', xlsxSheetsOf([cards], true)],
    ['cards.csv', Buffer.from('Bank,Card,PIN\nChase,Visa,4417\nHSBC,Mastercard,9921\n')],
    ['cards.txt', Buffer.from('Bank\tCard\tPIN\nChase\tVisa\t4417\n')],
    ['cards.docx', docxOf(['Cards'], cards)],
    ['cards2.docx', r14Paragraphs(['Cards', 'Bank\tPIN', 'Chase\t4417', 'HSBC\t9921'])],
    ['apps.csv', Buffer.from('App,PIN\nBanking app,4417\n')],
    // The reviewer's pins-num.xlsx (renamed): the PINs are numbers, so no value rule can see them.
    ['cards-num.xlsx', r16NumberSheet([['Bank', 'Card', 'PIN'], ['Chase', 'Visa', 4417], ['HSBC', 'Mastercard', 9921]])],
    ['bank two.xlsx', xlsxSheetsOf([[['Bank', 'PIN'], ['Chase', '4417']]])],
    ['bank label.xlsx', xlsxSheetsOf([[['Bank', 'Card PIN:'], ['Chase', '4417']]])],
    ['services.csv', Buffer.from('Service,Pass\nNetflix,Tr0ub4dor&3x\n')],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
  // The round 5 controls (a pass, pin or secret word and an account word in the same file, never in one row) and
  // lists with a lone account word and no loose word beside it go.
  const controls: [string, string[][]][] = [
    ['gradebook', [['Student', 'Email', 'Result'], ['Sam Lee', 'sam@example.com', 'Pass'], ['Ana Ruiz', 'ana@example.com', 'Fail']]],
    ['qa tracker', [['Test case', 'URL', 'Result'], ['Home page loads', 'https://example.com/', 'Pass'], ['Cart totals', 'https://example.com/cart', 'Pass']]],
    ['inventory', [['Item', 'Account', 'Qty'], ['Pins', 'Office', '40'], ['Staples', 'Office', '12']]],
    ['branches', [['Bank', 'Branch', 'Opening hours'], ['Chase', 'Main St', '9 to 5']]],
    ['apps', [['App', 'Version', 'Notes'], ['Mail', '3.2', 'PIN reset in Settings']]],
    ['stock', [['Service', 'Status', 'Pins'], ['Repairs', 'Open', '40']]],
  ]
  for (const [name, rows] of controls) {
    const csv = rows.map((row) => row.join(',')).join('\n') + '\n'
    for (const [file, bytes] of [
      [`${name}.xlsx`, xlsxSheetsOf([rows])],
      [`${name}.docx`, docxOf([name], rows)],
      [`${name}.csv`, Buffer.from(csv)],
    ] as const) {
      assert.equal((await memRefusal(file, bytes)).why, null, file)
    }
  }
})

// ── review round 17: a cell of two or more words ending in pass (Day pass) no longer pairs with a lone cell ──

test('review round 17: price and subscription lists headed Service, App or Bank go (Day pass, Season pass, Xbox Game Pass), while a bare Pass, PIN, Card PIN, PW or Secret beside a lone account word is still refused', async () => {
  // The round 16 reviewer's lists: a lone header word in column A or a Word table's first column, and a priced item
  // below it that ends in pass. Round 16 refused each as xlsx and as a Word table.
  const lists: [string, string[][]][] = [
    ['gym-prices', [['Service', 'Price', 'Notes'], ['Personal training', '45', 'per hour'], ['Day pass', '12', ''], ['Monthly pass', '60', ''], ['Annual pass', '550', 'save 20%']]],
    ['ski-prices', [['Service', 'Adult', 'Child'], ['Lift ticket', '89', '59'], ['Season pass', '899', '499'], ['Ski rental', '45', '30']]],
    ['transit-fares', [['Service', 'Fare'], ['Single ride', '2.75'], ['Day pass', '8.00'], ['7-day pass', '34.00']]],
    ['subscriptions', [['Service', 'Monthly', 'Renews'], ['Netflix', '15.49', '3rd'], ['Spotify', '10.99', '12th'], ['Xbox Game Pass', '16.99', '20th'], ['iCloud+', '2.99', '1st']]],
    ['apps-installed', [['App', 'Developer', 'Price'], ['Xbox Game Pass', 'Microsoft', 'Free'], ['Google Maps', 'Google', 'Free'], ['Slack', 'Salesforce', 'Free']]],
    ['ski-budget', [['Service', 'Cost'], ['Flights', '420'], ['Hotel', '780'], ['Epic Pass', '949']]],
    ['parking', [['Service', 'Rate'], ['Hourly', '3'], ['Daily', '20'], ['Visitor pass', '5']]],
  ]
  for (const [name, rows] of lists) {
    for (const [file, bytes] of [
      [`${name}.xlsx`, xlsxSheetsOf([rows])],
      [`${name}.docx`, docxOf([name], rows)],
    ] as const) {
      assert.equal((await memRefusal(file, bytes)).why, null, file)
    }
  }
  // A 60 row Word table whose first column holds Guest pass at row 40 (the whole first column is read).
  const longCol: string[][] = [['Service', 'Price']]
  for (let i = 1; i < 60; i++) longCol.push([i === 40 ? 'Guest pass' : `Class ${i}`, String(10 + i)])
  assert.equal((await memRefusal('timetable-long.docx', docxOf(['Leisure centre prices'], longCol))).why, null, 'timetable-long.docx')
  assert.equal((await memRefusal('timetable-long.xlsx', xlsxSheetsOf([longCol]))).why, null, 'timetable-long.xlsx')
  // Still refused (the round 16 reviewer's must-refuse cases beyond round 16's test, under neutral names: app pw.csv is
  // refused by its name alone): a bare loose word, or a cell that ends in PIN, PW or Secret, beside a lone Bank,
  // Service or App cell, across, and down column A.
  for (const [name, bytes] of [
    ['bank cardpin.xlsx', xlsxSheetsOf([[['Bank', 'Card PIN'], ['Chase', '4417']]])],
    ['apps two.csv', Buffer.from('App,PW\nNetflix,Tr0ub4dor&3x\n')],
    ['services notes.docx', docxOf(['Notes'], [['Service', 'Secret'], ['AWS', 'Tr0ub4dor&3x']])],
    ['banks online.csv', Buffer.from('Bank,Online PIN\nChase,4417\n')],
    ['vertical bank.xlsx', r16NumberSheet([['Bank:', 'Chase'], ['Card PIN:', 4417], ['Online PIN:', 9921]])],
    ['vertical plain.xlsx', xlsxSheetsOf([[['Bank', 'Chase'], ['PIN', '4417']]])],
  ] as const) {
    const got = await memRefusal(name, bytes)
    assert.equal(got.why, tableSentence6(got.path), name)
  }
})

test('no em or en dash in the new module', async () => {
  const { readFileSync } = await import('node:fs')
  // Round 7: and the content stage and its Worker.
  for (const file of ['email-outbound-files.ts', 'email-outbound-content.ts', 'email-outbound-content-worker.ts', 'email-outbound-content-quiet.ts']) {
    const src = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
    assert.equal(/[\u2013\u2014]/.test(src), false, file)
  }
})

// ── final pre push fix (plugin side): the swap check, the shown name, the moved runtime folders ───────────────

/** The reader of one file, exported: its file (name, realPath) or its sentence. */
async function readOne(path: string, ctx: Record<string, unknown>): Promise<any> {
  const lib = await m()
  assert.equal(typeof lib.readOutboundFile, 'function')
  return lib.readOutboundFile(path, ctx)
}

const changedSentence = (path: string) => `${path} changed while HOAI read it, so it is not attached.`

test('final fix: a path that leads somewhere else when HOAI looks again after opening it is refused (a parent folder swapped for a junction)', async (t) => {
  const home = scratchHome(t)
  mkdirSync(join(home, 'docs', 'sw'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  const clean = join(home, 'docs', 'sw', 'report.pdf')
  writeFileSync(clean, PDF)
  // The file the swapped parent would lead to: a PDF of its own (another file number) inside a key folder.
  const secret = join(home, '.ssh', 'report.pdf')
  writeFileSync(secret, Buffer.concat([PDF, Buffer.from('% rig dummy\n')]))
  const other = join(home, 'docs', 'other.pdf')
  writeFileSync(other, Buffer.concat([PDF, Buffer.from('% another\n')]))
  // realpath answers the clean path first (the checks pass), then where the path leads once the parent was swapped:
  // the probe's race (docs/sw renamed and a junction docs/sw -> home/.ssh made), with lstat and open real.
  const swapTo = (second: string) => {
    let n = 0
    return { realpath: async () => (n++ === 0 ? clean : second) }
  }
  assert.equal((await readOne(clean, { home, fs: swapTo(secret) })).error, changedSentence(clean), 'into a key folder')
  assert.equal((await readOne(clean, { home, fs: swapTo(other) })).error, changedSentence(clean), 'onto another plain file')
  // The very same file (a second name of it in the key folder): the second look still runs steps 1 and 2.
  const sameInKeys = join(home, '.ssh', 'same.pdf')
  linkSync(clean, sameInKeys)
  assert.equal((await readOne(clean, { home, fs: swapTo(sameInKeys) })).error, changedSentence(clean), 'the same file, now reached through a key folder')
  // A second look that cannot resolve at all is refused the same way.
  let n = 0
  const gone = { realpath: async () => { if (n++ === 0) return clean; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }
  assert.equal((await readOne(clean, { home, fs: gone })).error, changedSentence(clean), 'gone')
  // The control: the same answer twice goes, and the second look was really taken.
  let looks = 0
  const steady = { realpath: async () => { looks++; return clean } }
  const read = await readOne(clean, { home, fs: steady })
  assert.equal(read.ok, true, JSON.stringify(read.error))
  assert.equal(looks, 2, 'realpath again after the open')
  // The real file system, no injection: it goes.
  assert.equal((await readOne(clean, { home })).ok, true)
})

test('final fix: a file swapped in place between the check and the open is refused by the handle check (the inode)', async () => {
  // lstat sees file 7, the open lands on file 8 and the second look sees file 8 too: only the handle check sees it.
  const stats = [7, 8]
  let lstats = 0
  const stat = (ino: number) => ({ isFile: () => true, size: PDF.length, dev: 1, ino })
  const fs = {
    realpath: async (p: string) => p,
    lstat: async () => stat(stats[Math.min(lstats++, 1)]!),
    open: async () => ({
      stat: async () => stat(8),
      read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const n = Math.max(0, Math.min(length, PDF.length - position))
        buffer.set(PDF.subarray(position, position + n), offset)
        return { bytesRead: n }
      },
      close: async () => {},
    }),
  }
  const path = `${MEM_HOME}\\Documents\\q3.pdf`
  assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, changedSentence(path))
  // The control: the same file number all through goes.
  lstats = 0
  stats[0] = 8
  assert.equal((await readOne(path, { home: MEM_HOME, fs })).ok, true)
})

test('final fix: the name the owner and the recipient see is the name of the file really read, not of the link', async (t) => {
  const home = scratchHome(t)
  const real = join(home, 'docs', 'passport.pdf')
  writeFileSync(real, PDF)
  const link = join(home, 'docs', 'invoice.pdf')
  const via = { realpath: async () => real }
  const read = await readOne(link, { home, fs: via })
  assert.equal(read.ok, true, JSON.stringify(read.error))
  assert.equal(read.file.name, 'passport.pdf', 'the real file\'s own name')
  assert.equal(read.file.path, link, 'the path as the agent named it stays')
  assert.equal(read.file.realPath, real)
  // A short (8.3) or other cased spelling shows the long, real name.
  const long = join(home, 'docs', 'Quarterly report 2026.pdf')
  writeFileSync(long, PDF)
  const short = await readOne(join(home, 'docs', 'QUARTE~1.PDF'), { home, fs: { realpath: async () => long } })
  assert.equal(short.file.name, 'Quarterly report 2026.pdf')
  // No link: the same name.
  assert.equal((await readOne(real, { home })).file.name, 'passport.pdf')
})

test('final fix: a moved Claude config folder and a moved HOAI state folder are refused as HOAI or Claude folders, before any file system call', async () => {
  const lib = await m()
  const runtimeDirs = ['D:\\Agents\\Claude-Work', '/srv/hoai/state/', 'E:\\hoai\\..\\hoai-state.']
  for (const path of [
    'D:\\Agents\\Claude-Work\\paste-cache\\notes.txt',
    'd:/agents/claude-work/notes.txt',
    'D:\\AGENTS\\Claude-Work.\\projects\\x\\summary.pdf',
    'D:\\Agents\\Claude-Work',
    '/srv/hoai/state/12/notes.txt',
    '/srv/hoai//state/./12/../12/report.pdf',
    'E:\\hoai-state\\12\\notes.txt',
  ]) {
    const { calls, fs } = spyFs()
    assert.equal(
      await refusal(path, { home: 'C:\\Users\\kc', fs, runtimeDirs }),
      `${path} is in this agent's own Claude or HOAI folder, so it is never attached. ${NO_WAY_AROUND}`,
      path,
    )
    assert.deepEqual(calls, [], `${path}: refused before any file system call`)
    assert.match(String(lib.outboundFileLexicalRefusal(path, { home: 'C:\\Users\\kc', runtimeDirs })), /is in this agent's own Claude or HOAI folder/, `${path}: the preflight`)
    assert.equal(lib.outboundFileLexicalRefusal(path, { home: 'C:\\Users\\kc' }), null, `${path}: the gap without the folders`)
  }
  // Neighbours go: a longer name beside the folder, the folder above it.
  for (const path of ['D:\\Agents\\Claude-Work2\\notes.txt', 'D:\\Agents\\notes.txt', '/srv/hoai/stateful/notes.txt', 'E:\\hoai\\notes.txt']) {
    assert.equal(lib.outboundFileLexicalRefusal(path, { home: 'C:\\Users\\kc', runtimeDirs }), null, path)
  }
  // A folder that holds the home (or is it), the top of a drive and a relative or network value are not taken as one:
  // refusing them would refuse every file of the owner, and the name patterns still hold ~/.claude and ~/.bgos-*.
  for (const dir of ['C:\\Users\\kc', 'C:\\Users', 'C:\\', '/', 'relative\\dir', '\\\\host\\share', '']) {
    assert.equal(lib.outboundFileLexicalRefusal('C:\\Users\\kc\\Documents\\q3.pdf', { home: 'C:\\Users\\kc', runtimeDirs: [dir] }), null, JSON.stringify(dir))
  }
  assert.match(String(lib.outboundFileLexicalRefusal('C:\\Users\\kc\\.claude\\notes.txt', { home: 'C:\\Users\\kc', runtimeDirs: ['C:\\Users\\kc'] })), /looks like a key/)
})

test('final fix: a real file in a moved config folder is refused, and so is a link that leads into it', async (t) => {
  const home = scratchHome(t)
  const cfg = join(home, '..', 'claude-work')
  mkdirSync(join(cfg, 'paste-cache'), { recursive: true })
  const pasted = join(cfg, 'paste-cache', 'notes.txt')
  writeFileSync(pasted, 'Agenda: chairs and lunch.\n')
  assert.equal(await refusal(pasted, { home }), null, 'the gap: a moved folder matches no name pattern')
  assert.equal(await refusal(pasted, { home, runtimeDirs: [cfg] }), `${pasted} is in this agent's own Claude or HOAI folder, so it is never attached. ${NO_WAY_AROUND}`)
  const link = join(home, 'docs', 'agenda.txt')
  assert.equal(
    await refusal(link, { home, runtimeDirs: [cfg], fs: { realpath: async () => pasted } }),
    `${link} leads to this agent's own Claude or HOAI folder (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`,
  )
})

/**
 * Final fix 2: file system functions for a Windows path answered from a table (realpath answers each path it knows,
 * as a mapped drive's realpath.native does; lstat and open answer one PDF). Every call is kept in order.
 */
function answeredFs(answers: Record<string, string | string[]>) {
  const calls: string[] = []
  const asked: Record<string, number> = {}
  const stat = { isFile: () => true, size: PDF.length, dev: 1, ino: 7 }
  const fs = {
    realpath: async (path: string) => {
      calls.push(`realpath ${path}`)
      const answer = answers[path]
      const n = (asked[path] = (asked[path] ?? 0) + 1)
      const one = Array.isArray(answer) ? answer[Math.min(n, answer.length) - 1] : answer
      if (typeof one !== 'string' || one === 'ENOENT') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return one
    },
    lstat: async (path: string) => {
      calls.push(`lstat ${path}`)
      return stat
    },
    open: async (path: string) => {
      calls.push(`open ${path}`)
      return {
        stat: async () => stat,
        read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          const n = Math.max(0, Math.min(length, PDF.length - position))
          buffer.set(PDF.subarray(position, position + n), offset)
          return { bytesRead: n }
        },
        close: async () => {},
      }
    },
  }
  return { calls, fs }
}

const followedDevice = (path: string) => `${path} leads to a network or device path (HOAI followed its links), so it is never attached.`

test('Windows aliases: the real home bounds the word rules after an 8.3 prefix or home junction expands', async () => {
  for (const [home, realHome] of [
    ['C:\\Users\\RUNNER~1\\John Key', 'C:\\Users\\Runner Account\\John Key'],
    ['c:/users/RUNNER~1/John Key', 'C:\\Users\\Runner Account\\John Key'],
    ['E:\\Homes\\John Key', 'D:\\People\\John Key'],
  ]) {
    const path = `${home}\\Documents\\report.pdf`
    const real = `${realHome}\\Documents\\report.pdf`
    const { fs, calls } = answeredFs({ [path]: real, [home]: `\\\\?\\${realHome}` })
    const read = await readOne(path, { home, fs })
    assert.equal(read.ok, true, JSON.stringify(read.error))
    assert.equal(read.file.realPath, real)
    assert.equal(calls.filter((c) => c === `realpath ${home}`).length, 1, 'the home is resolved after the lexical checks')
    assert.equal(calls.filter((c) => c === `realpath ${path}`).length, 2, 'the second look still resolves the original path')
  }
})

test('Windows aliases: resolving the home never exempts a sibling, an outside link, a secret below the home or a fixed secret folder', async () => {
  const home = 'C:\\Users\\RUNNER~1\\John Key'
  const realHome = 'C:\\Users\\Runner Account\\John Key'
  const path = `${home}\\Documents\\report.pdf`
  for (const real of [
    `${realHome}.seed\\report.pdf`,
    'D:\\Other Key\\report.pdf',
    `${realHome}\\Documents\\stripe key.pdf`,
    `${realHome}\\.ssh\\report.pdf`,
  ]) {
    const { fs, calls } = answeredFs({ [path]: real, [home]: realHome })
    assert.equal(await refusal(path, { home, fs }), `${path} leads to a key or password file (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`, real)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], 'nothing was opened')
  }
  const { fs, calls } = spyFs()
  const key = `${home}\\.ssh\\report.pdf`
  assert.equal(await refusal(key, { home, fs }), `${key} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`)
  assert.deepEqual(calls, [], 'a lexical refusal still resolves nothing, including the home')
})

test('final fix 2: a file on a mapped network drive goes, read by its drive letter, when the share path is the given path below the drive', async () => {
  const share = '\\\\192.168.50.182\\Other'
  for (const [path, answer, root, realPath] of [
    // The reviewer's probe: realpath.native answers Z:\ as \\192.168.50.182\Other\.
    ['Z:\\Contracts\\offer.pdf', `${share}\\Contracts\\offer.pdf`, `${share}\\`, 'Z:\\Contracts\\offer.pdf'],
    // Another case and forward slashes in the given path: the real spelling is kept, on the given drive.
    ['z:/contracts/OFFER.pdf', `${share}\\Contracts\\offer.pdf`, `${share}\\`, 'z:\\Contracts\\offer.pdf'],
    // The long \\?\UNC\ answer, and a drive mapped to a folder inside the share.
    ['Z:\\Contracts\\offer.pdf', '\\\\?\\UNC\\192.168.50.182\\Other\\Contracts\\offer.pdf', '\\\\?\\UNC\\192.168.50.182\\Other\\', 'Z:\\Contracts\\offer.pdf'],
    ['Y:\\Contracts\\offer.pdf', '\\\\nas\\team\\projects\\Contracts\\offer.pdf', '\\\\nas\\team\\projects', 'Y:\\Contracts\\offer.pdf'],
  ] as const) {
    const drive = `${path.slice(0, 2)}\\`
    const { calls, fs } = answeredFs({ [path]: answer, [drive]: root })
    const read = await readOne(path, { home: MEM_HOME, fs })
    assert.equal(read.ok, true, `${path}: ${JSON.stringify(read.error)}`)
    assert.equal(read.file.realPath, realPath, path)
    assert.equal(read.file.name, 'offer.pdf', `${path}: the real name`)
    assert.equal(read.file.path, path)
    // lstat and open go through the drive letter the owner mapped, never a UNC path; the second look maps it again.
    assert.deepEqual(
      calls.filter((c) => !c.startsWith('realpath')),
      [`lstat ${realPath}`, `open ${realPath}`, `lstat ${realPath}`],
      path,
    )
    assert.equal(calls.filter((c) => c === `realpath ${drive}`).length, 2, `${path}: the drive's own share asked at the first and the second look`)
  }
})

test('final fix 2: a mapped drive path that leads elsewhere in the share, a link to a share from a local drive, and a given UNC path stay refused', async () => {
  const share = '\\\\server\\share'
  // A link inside the share: the share path is not the given path below the drive.
  for (const [path, answer] of [
    ['Z:\\x\\link.pdf', `${share}\\.ssh\\id_rsa`],
    ['Z:\\x\\link.pdf', `${share}\\x\\other.pdf`],
    ['Z:\\x\\link.pdf', `${share}\\y\\x\\link.pdf`],
    ['Z:\\x\\link.pdf', `${share}2\\x\\link.pdf`],
  ] as const) {
    const { calls, fs } = answeredFs({ [path]: answer, 'Z:\\': `${share}\\` })
    assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, followedDevice(path), `${path} to ${answer}`)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], `${path} to ${answer}: nothing opened`)
  }
  // A folder on a local drive linked to a share whose path mirrors the given one: the drive itself is not that share.
  const local = 'C:\\Users\\kc\\Documents\\dir\\a.pdf'
  for (const root of ['C:\\', 'ENOENT', '\\\\evil\\s\\other\\']) {
    const { calls, fs } = answeredFs({ [local]: '\\\\evil\\s\\Users\\kc\\Documents\\dir\\a.pdf', 'C:\\': root })
    assert.equal((await readOne(local, { home: MEM_HOME, fs })).error, followedDevice(local), `root ${root}`)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], `root ${root}: nothing opened`)
  }
  // A device answer is never a share.
  const pipe = answeredFs({ 'Z:\\offer.pdf': '\\\\.\\pipe\\offer.pdf', 'Z:\\': '\\\\.\\pipe\\' })
  assert.equal((await readOne('Z:\\offer.pdf', { home: MEM_HOME, fs: pipe.fs })).error, followedDevice('Z:\\offer.pdf'))
  // A link to a key folder on the share stays refused, and the given UNC path with no call at all.
  const key = answeredFs({ 'Z:\\docs\\offer.pdf': `${share}\\.ssh\\offer.pdf`, 'Z:\\': `${share}\\` })
  assert.equal((await readOne('Z:\\docs\\offer.pdf', { home: MEM_HOME, fs: key.fs })).error, followedDevice('Z:\\docs\\offer.pdf'))
  const given = answeredFs({})
  assert.equal((await readOne(`${share}\\offer.pdf`, { home: MEM_HOME, fs: given.fs })).error, `${share}\\offer.pdf is a network or device path, so it is never attached.`)
  assert.deepEqual(given.calls, [])
})

test('final fix 2: the second look reads a mapped drive the same way: a drive that no longer leads to its share is refused', async () => {
  const path = 'Z:\\Contracts\\offer.pdf'
  const answer = '\\\\192.168.50.182\\Other\\Contracts\\offer.pdf'
  for (const second of ['ENOENT', 'C:\\', '\\\\192.168.50.182\\Elsewhere\\']) {
    const { fs } = answeredFs({ [path]: answer, 'Z:\\': ['\\\\192.168.50.182\\Other\\', second] })
    assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, changedSentence(path), `second root answer ${second}`)
  }
})

/**
 * Final fix 3: the drive letter form drops the part of the real path the drive stands for, so the secret list and the
 * runtime folders also read the share side: the given drive plus the real answer below its server. Both looks do.
 */
const followedSecret = (path: string) => `${path} leads to a key or password file (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`
const followedRuntime = (path: string) => `${path} leads to this agent's own Claude or HOAI folder (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`

test('final fix 3: a drive mapped to a key, password or runtime place is refused as a link, whatever the drive letter form says, and nothing opens', async () => {
  for (const [path, root] of [
    ['Z:\\notes.pdf', '\\\\nas\\kc\\.ssh'],
    ['Z:\\prod.pdf', '\\\\localhost\\C$\\Users\\kc\\.aws'],
    ['P:\\bank.pdf', '\\\\nas\\kc\\Passwords'],
    ['K:\\stripe.pdf', '\\\\nas\\Keys'],
    ['K:\\prod\\stripe.pdf', '\\\\nas\\Keys'],
    ['S:\\prod.pdf', '\\\\nas\\secrets'],
    ['S:\\prod.pdf', '\\\\nas\\Credentials'],
    ['Y:\\paste.pdf', '\\\\localhost\\C$\\Users\\kc\\.claude'],
    ['Y:\\inbound.pdf', '\\\\localhost\\C$\\Users\\kc\\.bgos-agent\\email-files\\1'],
    ['Y:\\inbound.pdf', '\\\\nas\\kc\\.bgos-agent\\email-files\\1'],
  ] as const) {
    const rest = path.slice(2)
    for (const [answer, top] of [
      [`${root}${rest}`, `${root}\\`],
      [`\\\\?\\UNC\\${root.slice(2)}${rest}`, `\\\\?\\UNC\\${root.slice(2)}\\`],
    ] as const) {
      const { calls, fs } = answeredFs({ [path]: answer, [`${path.slice(0, 2)}\\`]: top })
      assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, followedSecret(path), `${path} to ${answer}`)
      assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], `${path} to ${answer}: nothing opened`)
    }
  }
})

test('final fix 3: a share path steps 1 and 2 read as a device stays refused, so a device name cannot hide a key folder behind it', async () => {
  const path = 'Z:\\notes.pdf'
  const { calls, fs } = answeredFs({ [path]: '\\\\nas\\aux\\.ssh\\notes.pdf', 'Z:\\': '\\\\nas\\aux\\.ssh\\' })
  assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, followedDevice(path))
  assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [])
})

test('final fix 3: a drive mapped through an admin share is read as that disk, so a moved runtime folder is refused and a home named after a person is not', async () => {
  // D$ is the D: disk: the runtime folder on it is found by its own path, in the plain words of a runtime folder.
  for (const root of ['\\\\localhost\\D$\\AgentData\\hoai', '\\\\LOCALHOST\\d$\\agentdata\\HOAI', '\\\\?\\UNC\\localhost\\D$\\AgentData\\hoai']) {
    const { calls, fs } = answeredFs({ 'Y:\\state.pdf': `${root}\\state.pdf`, 'Y:\\': `${root}\\` })
    assert.equal((await readOne('Y:\\state.pdf', { home: MEM_HOME, runtimeDirs: ['D:\\AgentData\\hoai'], fs })).error, followedRuntime('Y:\\state.pdf'), root)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], `${root}: nothing opened`)
  }
  // C$ under the owner's own home: the word rules read below the home, as they do on C: itself.
  const root = '\\\\localhost\\C$\\Users\\John Key'
  const { fs } = answeredFs({ 'Y:\\Documents\\offer.pdf': `${root}\\Documents\\offer.pdf`, 'Y:\\': root })
  const read = await readOne('Y:\\Documents\\offer.pdf', { home: 'C:\\Users\\John Key', fs })
  assert.equal(read.ok, true, JSON.stringify(read.error))
  assert.equal(read.file.realPath, 'Y:\\Documents\\offer.pdf')
})

test('final fix 3: ordinary shares still go, and a server name alone refuses nothing', async () => {
  for (const [path, root] of [
    ['Z:\\Contracts\\offer.pdf', '\\\\192.168.50.182\\Other'],
    ['Z:\\offer.pdf', '\\\\nas\\Team\\Contracts'],
    ['Z:\\offer.pdf', '\\\\?\\UNC\\nas\\Team\\Contracts'],
    ['Z:\\offer.pdf', '\\\\nas\\Public$'],
    // The server's name is not read: these are a NAS that happens to be called so.
    ['Z:\\offer.pdf', '\\\\keys\\Team'],
    ['Z:\\offer.pdf', '\\\\secrets\\Team'],
    ['Z:\\offer.pdf', '\\\\?\\UNC\\passwords\\Team'],
    ['Z:\\offer.pdf', '\\\\.ssh\\Team'],
  ] as const) {
    const drive = `${path.slice(0, 2)}\\`
    const { calls, fs } = answeredFs({ [path]: `${root}${path.slice(2)}`, [drive]: `${root}\\` })
    const read = await readOne(path, { home: MEM_HOME, fs })
    assert.equal(read.ok, true, `${path} on ${root}: ${JSON.stringify(read.error)}`)
    assert.equal(read.file.realPath, path, root)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [`lstat ${path}`, `open ${path}`, `lstat ${path}`], root)
  }
})

test('final fix 3: the second look reads the share side too: a drive remapped to a key folder while the file is read is refused', async () => {
  for (const [second, secondRoot] of [
    ['\\\\nas\\kc\\.ssh\\notes.pdf', '\\\\nas\\kc\\.ssh\\'],
    ['\\\\nas\\Keys\\notes.pdf', '\\\\nas\\Keys\\'],
    ['\\\\localhost\\C$\\Users\\kc\\.claude\\notes.pdf', '\\\\localhost\\C$\\Users\\kc\\.claude\\'],
  ] as const) {
    const path = 'Z:\\notes.pdf'
    const { calls, fs } = answeredFs({ [path]: ['\\\\nas\\Team\\notes.pdf', second], 'Z:\\': ['\\\\nas\\Team\\', secondRoot] })
    assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, changedSentence(path), second)
    // The second look stops at the check: its lstat, the one after the open, never runs.
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [`lstat ${path}`, `open ${path}`], second)
  }
})

const runtimeSentence = (path: string) => `${path} is in this agent's own Claude or HOAI folder, so it is never attached. ${NO_WAY_AROUND}`

test('final fix 2: a file in a moved Claude or HOAI folder has its own sentence; a link into one says HOAI followed it', async () => {
  const lib = await m()
  const runtimeDirs = ['D:\\Agents\\Claude-Work']
  const path = 'D:\\Agents\\Claude-Work\\projects\\agenda.pdf'
  assert.equal(lib.outboundFileLexicalRefusal(path, { home: MEM_HOME, runtimeDirs }), runtimeSentence(path))
  const { calls, fs } = spyFs()
  assert.equal(await refusal(path, { home: MEM_HOME, fs, runtimeDirs }), runtimeSentence(path))
  assert.deepEqual(calls, [])
  const link = `${MEM_HOME}\\Documents\\agenda.pdf`
  assert.equal(
    await refusal(link, { home: MEM_HOME, runtimeDirs, fs: { realpath: async () => path } }),
    `${link} leads to this agent's own Claude or HOAI folder (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`,
  )
  // A key name in it keeps the key sentence; ~/.claude by name keeps its own.
  assert.match(String(lib.outboundFileLexicalRefusal('D:\\Agents\\Claude-Work\\id_rsa', { home: MEM_HOME, runtimeDirs })), /looks like a key or password file/)
})

test('final fix 2: the runtime folders are also taken by their real path, so a junctioned or 8.3 spelled config folder holds', async (t) => {
  const lib = await m()
  assert.equal(typeof lib.outboundRuntimeDirs, 'function', 'lib/email-outbound-files.ts exports outboundRuntimeDirs')
  // An 8.3 short spelling, injected: the long form is added beside the configured one.
  const short = lib.outboundRuntimeDirs(['D:\\CLAUDE~1', 'E:\\gone'], (dir: string) => {
    if (dir === 'D:\\CLAUDE~1') return '\\\\?\\D:\\Claude Config Moved'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  assert.deepEqual([...short], ['D:\\CLAUDE~1', 'D:\\Claude Config Moved', 'E:\\gone'])
  assert.ok(Object.isFrozen(short))
  const long = 'D:\\Claude Config Moved\\paste-cache\\notes.txt'
  assert.equal(lib.outboundFileLexicalRefusal(long, { home: MEM_HOME, runtimeDirs: ['D:\\CLAUDE~1'] }), null, 'the gap: the configured spelling alone')
  assert.equal(lib.outboundFileLexicalRefusal(long, { home: MEM_HOME, runtimeDirs: short }), runtimeSentence(long))
  // The same folder twice is listed once; a folder that is its own real path is not repeated.
  assert.deepEqual([...lib.outboundRuntimeDirs(['D:\\a', 'D:\\a'], (d: string) => d)], ['D:\\a'])
  // A real junction (a symlink on Linux): the configured cfg leads to cfg-real, and a file reached by cfg-real is refused.
  // This assertion names the file by its real path; TEMP itself can have an unrelated 8.3 or junction prefix.
  const home = realpathSync.native(scratchHome(t))
  const realDir = join(home, '..', 'cfg-real')
  mkdirSync(join(realDir, 'paste-cache'), { recursive: true })
  const linked = join(home, '..', 'cfg')
  symlinkSync(realDir, linked, 'junction')
  const pasted = join(realDir, 'paste-cache', 'paste.pdf')
  writeFileSync(pasted, PDF)
  assert.equal(await refusal(pasted, { home, runtimeDirs: [linked] }), null, 'the gap: the junction alone')
  const dirs = lib.outboundRuntimeDirs([linked])
  assert.equal(dirs.length, 2, JSON.stringify(dirs))
  assert.equal(await refusal(pasted, { home, runtimeDirs: dirs }), runtimeSentence(pasted))
})

/**
 * Final fix 4: a list of drives mapped straight to a place the checks refuse, each in the \\server and \\?\UNC\ forms, in
 * the form of final fix 3's refusal test: the plain link sentence, and nothing opens.
 */
async function refusedDrives(drives: readonly (readonly [string, string])[], sentence: (path: string) => string): Promise<void> {
  for (const [path, root] of drives) {
    const rest = path.slice(2)
    for (const [answer, top] of [
      [`${root}${rest}`, `${root}\\`],
      [`\\\\?\\UNC\\${root.slice(2)}${rest}`, `\\\\?\\UNC\\${root.slice(2)}\\`],
    ] as const) {
      const { calls, fs } = answeredFs({ [path]: answer, [`${path.slice(0, 2)}\\`]: top })
      assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, sentence(path), `${path} to ${answer}`)
      assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [], `${path} to ${answer}: nothing opened`)
    }
  }
}

const lookedSecret = (path: string) => `${path} looks like a key or password file, so it is never attached. ${NO_WAY_AROUND}`

test('final fix 4: anything in a .hoai folder is refused, as the tool text and the session instructions promise: the Agent Browser, its downloads and the board files, the owner\'s too', async () => {
  const lib = await m()
  for (const [path, home] of [
    ['~/.hoai/agent-browser/sessions/x/shot.png', '/home/kc'],
    ['/home/kc/.hoai/agent-browser/sessions/x/downloads/statement.pdf', '/home/kc'],
    ['C:\\Users\\kc\\.hoai\\agent-browser\\sessions\\x\\shot.png', 'C:\\Users\\kc'],
    ['~\\.hoai\\agent-browser\\sessions\\x\\shot.png', 'C:\\Users\\kc'],
    ['/home/kc/agents/sales/.hoai/board-files/person-abc/f.pdf', '/home/kc'],
    ['/home/kc/agents/sales/.hoai/board-files/owner/f.pdf', '/home/kc'],
    ['D:\\Agents\\Sales\\.hoai\\board-files\\person-abc\\f.pdf', 'C:\\Users\\kc'],
    ['D:\\Agents\\Sales\\.hoai\\board-files\\owner\\f.pdf', 'C:\\Users\\kc'],
    // Its case, and the trailing dots and spaces Windows drops.
    ['C:\\Users\\kc\\.HOAI\\board-files\\owner\\f.pdf', 'C:\\Users\\kc'],
    ['C:\\Users\\kc\\.hoai. \\board-files\\owner\\f.pdf', 'C:\\Users\\kc'],
    // The folder itself.
    ['/home/kc/.hoai', '/home/kc'],
  ] as const) {
    assert.equal(lib.outboundFileLexicalRefusal(path, { home }), lookedSecret(path), path)
    const { calls, fs } = spyFs()
    assert.equal(await refusal(path, { home, fs }), lookedSecret(path), path)
    assert.deepEqual(calls, [], `${path}: no file system call`)
  }
  // The control: a name that only starts or ends the same way is no HOAI folder, and reaches the file system.
  for (const path of ['/home/kc/.hoai-notes/f.pdf', '/home/kc/docs/hoai/f.pdf', '/home/kc/docs/my.hoai/f.pdf', '/home/kc/docs/.hoaiplan.pdf']) {
    const { calls, fs } = spyFs()
    assert.match(String(await refusal(path, { home: '/home/kc', fs })), /could not be found or read/, path)
    assert.ok(calls.length > 0, path)
  }
})

test('final fix 4: a junction into a .hoai folder is refused by where it leads', async (t) => {
  const home = scratchHome(t)
  const board = join(home, 'agent', '.hoai', 'board-files', 'person-abc')
  mkdirSync(board, { recursive: true })
  writeFileSync(join(board, 'f.pdf'), PDF)
  const link = join(home, 'docs', 'board')
  symlinkSync(board, link, 'junction')
  const path = join(link, 'f.pdf')
  assert.equal(await refusal(path, { home }), `${path} leads to a key or password file (HOAI followed its links), so it is never attached. ${NO_WAY_AROUND}`)
  // The control: the same bytes through a junction into a plain folder go.
  const plain = join(home, 'agent', 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'f.pdf'), PDF)
  const other = join(home, 'docs', 'plain')
  symlinkSync(plain, other, 'junction')
  assert.equal(await refusal(join(other, 'f.pdf'), { home }), null)
})

test('final fix 4: a drive mapped into a .hoai folder is refused on its share side', async () => {
  await refusedDrives([
    ['Y:\\shot.png', '\\\\localhost\\C$\\Users\\kc\\.hoai\\agent-browser\\sessions\\x'],
    ['Y:\\f.pdf', '\\\\localhost\\D$\\Agents\\Sales\\.hoai\\board-files\\owner'],
    ['Y:\\f.pdf', '\\\\nas\\kc\\.hoai\\board-files\\person-abc'],
    ['Y:\\f.pdf', '\\\\nas\\kc\\.hoai'],
    ['Y:\\f.pdf', '\\\\nas\\.hoai'],
    ['Y:\\f.pdf', '\\\\nas\\.hoai$'],
  ], followedSecret)
})

test('final fix 4: a hidden share is read without its trailing $, so a drive mapped to a key share is refused and an ordinary hidden share goes', async () => {
  await refusedDrives([
    ['K:\\stripe.pdf', '\\\\nas\\Keys$'],
    ['K:\\prod\\stripe.pdf', '\\\\nas\\Keys$'],
    ['K:\\stripe.pdf', '\\\\nas\\.ssh$'],
    ['K:\\sub\\a.pdf', '\\\\nas\\.ssh$'],
    ['K:\\config.pdf', '\\\\nas\\.aws$'],
    ['K:\\a.pdf', '\\\\nas\\.gnupg$'],
    ['K:\\a.pdf', '\\\\nas\\.git$'],
    ['K:\\a.pdf', '\\\\nas\\wallet$'],
    ['K:\\a.pdf', '\\\\nas\\wallets$'],
    ['K:\\a.pdf', '\\\\nas\\recovery$'],
    ['K:\\a.pdf', '\\\\nas\\tokens$'],
    ['K:\\a.pdf', '\\\\nas\\pins$'],
    ['K:\\a.pdf', '\\\\nas\\seeds$'],
    // A folder of the share below it, as before.
    ['K:\\a.pdf', '\\\\nas\\Keys$\\prod'],
    ['K:\\a.pdf', '\\\\nas\\kc$\\.ssh'],
  ], followedSecret)
  // Ordinary hidden shares go, read by their drive letter.
  for (const root of ['\\\\nas\\Team$', '\\\\nas\\Public$', '\\\\?\\UNC\\nas\\Team$', '\\\\nas\\Team$\\Contracts', '\\\\nas\\$']) {
    const path = 'Z:\\offer.pdf'
    const { calls, fs } = answeredFs({ [path]: `${root}\\offer.pdf`, 'Z:\\': `${root}\\` })
    const read = await readOne(path, { home: MEM_HOME, fs })
    assert.equal(read.ok, true, `${root}: ${JSON.stringify(read.error)}`)
    assert.equal(read.file.realPath, path, root)
    assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [`lstat ${path}`, `open ${path}`, `lstat ${path}`], root)
  }
  // The second look reads it the same way.
  const path = 'Z:\\notes.pdf'
  const { calls, fs } = answeredFs({ [path]: ['\\\\nas\\Team$\\notes.pdf', '\\\\nas\\Keys$\\notes.pdf'], 'Z:\\': ['\\\\nas\\Team$\\', '\\\\nas\\Keys$\\'] })
  assert.equal((await readOne(path, { home: MEM_HOME, fs })).error, changedSentence(path))
  assert.deepEqual(calls.filter((c) => !c.startsWith('realpath')), [`lstat ${path}`, `open ${path}`])
})

test('final fix 4: an admin share is still read as its disk before any $ is dropped', async () => {
  await refusedDrives([['Y:\\a.pdf', '\\\\localhost\\C$\\Users\\kc\\.aws']], followedSecret)
  // C$ below the owner's own home: the word rules read below the home, so John Key's files go. Read as a share named C,
  // the home would not be found and the word key would refuse them.
  const root = '\\\\localhost\\C$\\Users\\John Key'
  const { fs } = answeredFs({ 'Y:\\Documents\\offer.pdf': `${root}\\Documents\\offer.pdf`, 'Y:\\': root })
  const read = await readOne('Y:\\Documents\\offer.pdf', { home: 'C:\\Users\\John Key', fs })
  assert.equal(read.ok, true, JSON.stringify(read.error))
})

/** Final fix 4: run a check as if on another operating system; lexical reads process.platform at each call. */
async function asPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', was)
  }
}

test('final fix 4: on Linux and macOS a ?, * or : and a Windows device word are ordinary name parts; with a drive letter or on Windows they stay refused', async () => {
  const lib = await m()
  const posix = [
    '/home/kc/Meeting 10:30.pdf',
    '/home/kc/con.pdf',
    '/home/kc/aux/report.pdf',
    '/home/kc/Is this ok?.pdf',
    '/home/kc/draft*.pdf',
    '/Users/kc/Documents/Q3:Q4.pdf',
    '~/nul.pdf',
  ]
  for (const platform of ['linux', 'darwin']) {
    await asPlatform(platform, async () => {
      for (const path of posix) {
        assert.equal(lib.outboundFileLexicalRefusal(path, { home: '/home/kc' }), null, `${platform}: ${path}`)
        const { calls, fs } = spyFs()
        assert.match(String(await refusal(path, { home: '/home/kc', fs })), /could not be found or read/, `${platform}: ${path}`)
        assert.ok(calls.length > 0, `${platform}: ${path}`)
      }
      // A drive letter is a Windows path wherever it is read.
      for (const path of ['C:\\Users\\kc\\CON', 'C:\\Users\\kc\\nul.pdf', 'C:\\Users\\kc\\a.pdf:hidden', 'C:\\Users\\kc\\*.pdf', 'C:/Users/kc/what?.pdf']) {
        assert.match(String(lib.outboundFileLexicalRefusal(path, { home: 'C:\\Users\\kc' })), /is a network or device path/, `${platform}: ${path}`)
      }
      // The system folders and the key rules do not change.
      assert.match(String(lib.outboundFileLexicalRefusal('/etc/aux/a.pdf', { home: '/home/kc' })), /is a system file/)
      assert.equal(lib.outboundFileLexicalRefusal('/home/kc/.ssh/con.pdf', { home: '/home/kc' }), lookedSecret('/home/kc/.ssh/con.pdf'))
    })
  }
  await asPlatform('win32', async () => {
    for (const path of posix) assert.match(String(lib.outboundFileLexicalRefusal(path, { home: '/home/kc' })), /is a network or device path/, `win32: ${path}`)
  })
})

test('final fix 4: a main thread stop is read over rounds: one spike passes, a steady stop stays red, and a green first round is the only one', async () => {
  const rounds = (...gaps: number[]) => {
    const given = [...gaps]
    return { round: async () => given.shift()!, left: () => given.length }
  }
  // A green first round settles it.
  const green = rounds(40, 900, 900)
  assert.equal(await stopOf(green.round), 40)
  assert.equal(green.left(), 2)
  // One spike, at the first round: the median of three is healthy (the 257 ms of the review's run).
  assert.equal(await stopOf(rounds(257, 40, 30).round), 40)
  // Two rounds over the limit, a stop every round, and one just over it stay over it: the limit did not move.
  assert.equal(await stopOf(rounds(150, 40, 160).round), 150)
  assert.equal(await stopOf(rounds(4400, 4300, 4500).round), 4400)
  assert.equal(await stopOf(rounds(101, 102, 103).round), 102)
  // A limit of its own.
  assert.equal(await stopOf(rounds(60, 70, 80).round, 50), 70)
  const within = rounds(50, 900, 900)
  assert.equal(await stopOf(within.round, 50), 50)
  assert.equal(within.left(), 2)
})
