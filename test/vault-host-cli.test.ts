import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreateHostKey, provisionSigningIdentity } from './helpers/vault-host.mjs'
import { main } from '../bin/hoai-core.mjs'

const commandUrl = new URL('../bin/hoai-vault-host.mjs', import.meta.url).href
const hostUrl = new URL('./helpers/vault-host.mjs', import.meta.url).href

for (const stream of ['stdin', 'stderr']) {
  test(`terminal gate: ${stream} without a TTY refuses independently`, async () => {
    const code = `
      import { main } from ${JSON.stringify(commandUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: ${stream !== 'stdin'} });
      Object.defineProperty(process.stderr, 'isTTY', { value: ${stream !== 'stderr'} });
      process.exitCode = await main(['status']);
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(child.status, 2)
    assert.match(child.stderr, /must run in a terminal/)
    assert.doesNotMatch(child.stdout + child.stderr, /Host fingerprint/)
  })
}

test('hoai main launches the vault command with the terminal inherited and forwards its exit code', async () => {
  let spawned = false
  const exit = await main(['vault-host', 'status', '--assistant', '42'], {
    scriptDir: fileURLToPath(new URL('../bin', import.meta.url)),
    spawnImpl: ((command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
      spawned = true
      assert.equal(command, process.execPath)
      assert.deepEqual(args, [fileURLToPath(new URL('../bin/hoai-vault-host.mjs', import.meta.url)), 'status', '--assistant', '42'])
      assert.equal(options?.stdio, 'inherit')
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 7, null))
      return child as ReturnType<typeof import('node:child_process').spawn>
    }) as typeof import('node:child_process').spawn,
  })
  assert.equal(spawned, true)
  assert.equal(exit, 7)
})

test('terminal setup: simulated TTY registers a provisioned identity and records PINNED without leaking keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-terminal-'))
  const dir = join(root, 'vault')
  try {
    const credentialsPath = join(root, 'pairing.json')
    writeFileSync(credentialsPath, JSON.stringify({ assistantId: 42, userId: 'fixture-owner', backendUrl: 'https://api.example.test', pairingToken: 'fixture-pairing' }))
    await loadOrCreateHostKey(dir, 42)
    await provisionSigningIdentity(dir, 42, generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))
    const code = `
      import { main } from ${JSON.stringify(commandUrl)};
      import { readHostRecord, hostPinStatus, hostFingerprint, testSecurity } from ${JSON.stringify(hostUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: true });
      let output = '';
      process.stderr.write = (text) => { output += text; return true; };
      process.stdin.resume = () => { queueMicrotask(() => process.stdin.emit('data', 'PINNED\\n')); return process.stdin; };
      process.stdin.pause = () => process.stdin;
      globalThis.fetch = async (_url, init) => new Response(JSON.stringify({ registered: true, publicKey: JSON.parse(init.body).publicKey }), { status: 201 });
      const code = await main(['--assistant', '42', '--state-dir', ${JSON.stringify(dir)}], { security: testSecurity });
      const record = await readHostRecord(${JSON.stringify(dir)});
      console.log(JSON.stringify({ code, pinned: hostPinStatus(record) === 'pinned', shown: output.includes(hostFingerprint(record.identityPublic, record.publicKey)), leaked: [record.hostSeed, record.signingSecret, 'fixture-pairing'].some(s => output.includes(s)) }));
    `
    const env: NodeJS.ProcessEnv = { ...process.env, BGOS_CREDENTIALS_PATH: credentialsPath, BGOS_ASSISTANT_ID: '42' }
    delete env.BGOS_PAIRING_TOKEN
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 15_000 })
    assert.equal(child.status, 0)
    assert.equal(child.stderr, '')
    assert.deepEqual(JSON.parse(child.stdout), { code: 0, pinned: true, shown: true, leaked: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/**
 * H2: the terminal pin also anchors the OWNER's account key. Under the host
 * fingerprint it prints "Your HOAI account code: XXXX XXXX XXXX XXXX XXXX",
 * the first 20 hex characters of sha256(JSON ['hoai-owner-account-v1',
 * ownerId, accountPublic]); HOAI's pin screen shows the same code from the
 * owner's own key. The key is anchored only when the owner types PINNED after
 * comparing both. No code from HOAI, no anchor (a person's fill then stays
 * refused), and an already pinned host can anchor by running it again.
 */
for (const [name, ownerAnswer, anchors] of [
  ['the account code is shown and its key anchored on PINNED', 'good', true],
  ['no account code from HOAI: the host is pinned, the account is not anchored', 'down', false],
  ['an account answer for another owner is never shown or anchored', 'other', false],
] as const) {
  test(`terminal setup H2: ${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'vault-terminal-acct-'))
    const dir = join(root, 'vault')
    const OWNER_ID = 'user_fixtureOwner1'
    const ACCOUNT = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
    try {
      const credentialsPath = join(root, 'pairing.json')
      writeFileSync(credentialsPath, JSON.stringify({ assistantId: 42, userId: OWNER_ID, backendUrl: 'https://api.example.test', pairingToken: 'fixture-pairing' }))
      await loadOrCreateHostKey(dir, 42)
      await provisionSigningIdentity(dir, 42, generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))
      const answer = ownerAnswer === 'good' ? { ownerId: OWNER_ID, accountPublic: ACCOUNT } : ownerAnswer === 'other' ? { ownerId: 'user_someoneElse', accountPublic: ACCOUNT } : null
      const code = `
        import { main } from ${JSON.stringify(commandUrl)};
        import { readHostRecord, hostPinStatus, ownerAccountCode, testSecurity } from ${JSON.stringify(hostUrl)};
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        Object.defineProperty(process.stderr, 'isTTY', { value: true });
        let output = '';
        process.stderr.write = (text) => { output += text; return true; };
        process.stdin.resume = () => { queueMicrotask(() => process.stdin.emit('data', 'PINNED\\n')); return process.stdin; };
        process.stdin.pause = () => process.stdin;
        const answer = ${JSON.stringify(answer)};
        globalThis.fetch = async (url, init) => {
          if (String(url).endsWith('/owner-account')) {
            if (String(url) !== 'https://api.example.test/api/v1/vault/agent/42/owner-account' || (init?.method ?? 'GET') !== 'GET' || !init?.headers?.['X-BGOS-Pairing'] || !init?.headers?.['x-bgos-a2a-signature']) return new Response('', { status: 400 });
            return answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('', { status: 503 });
          }
          return new Response(JSON.stringify({ registered: true, publicKey: JSON.parse(init.body).publicKey }), { status: 201 });
        };
        const code = await main(['--assistant', '42', '--state-dir', ${JSON.stringify(dir)}], { security: testSecurity });
        const record = await readHostRecord(${JSON.stringify(dir)});
        const expected = 'Your HOAI account code: ' + ownerAccountCode(${JSON.stringify(OWNER_ID)}, ${JSON.stringify(ACCOUNT)});
        console.log(JSON.stringify({ code, pinned: hostPinStatus(record) === 'pinned', shownCode: output.includes(expected), anchored: record.ownerAccount ?? null }));
      `
      const env: NodeJS.ProcessEnv = { ...process.env, BGOS_CREDENTIALS_PATH: credentialsPath, BGOS_ASSISTANT_ID: '42' }
      delete env.BGOS_PAIRING_TOKEN
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 15_000 })
      assert.equal(child.stderr, '')
      const got = JSON.parse(child.stdout)
      assert.equal(got.code, 0)
      assert.equal(got.pinned, true)
      assert.equal(got.shownCode, anchors)
      if (anchors) assert.deepEqual({ ownerId: got.anchored.ownerId, accountPublic: got.anchored.accountPublic, via: got.anchored.via }, { ownerId: OWNER_ID, accountPublic: ACCOUNT, via: 'terminal' })
      else assert.equal(got.anchored, null)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
