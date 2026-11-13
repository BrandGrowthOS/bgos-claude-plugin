import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitFillTrust, loadOrCreateHostKey, ownerAccountCode, provisionSigningIdentity, testSecurity } from './helpers/vault-host.mjs'
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
 * H2 and V1: the terminal pin anchors the OWNER's account key only when the
 * owner TYPES the account code HOAI shows (under This agent's computer) and it
 * equals the code computed from the server's owner-account answer, spaces and
 * case ignored. The code is never printed here: a code shown on both sides
 * invites typing PINNED without comparing. A mismatch anchors nothing. The
 * host pin itself is unchanged.
 */
async function terminalRun(opts: { ownerAnswer: 'good' | 'down' | 'other'; lines: string[]; args?: string[]; seedTrust?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'vault-terminal-acct-'))
  const dir = join(root, 'vault')
  const OWNER_ID = 'user_fixtureOwner1'
  const ACCOUNT = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const credentialsPath = join(root, 'pairing.json')
  writeFileSync(credentialsPath, JSON.stringify({ assistantId: 42, userId: OWNER_ID, backendUrl: 'https://api.example.test', pairingToken: 'fixture-pairing' }))
  await loadOrCreateHostKey(dir, 42)
  await provisionSigningIdentity(dir, 42, generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))
  if (opts.seedTrust) await commitFillTrust(dir, { userId: OWNER_ID, accountPublic: 'Z'.repeat(43), revision: 9 }, undefined, testSecurity)
  const answer = opts.ownerAnswer === 'good' ? { ownerId: OWNER_ID, accountPublic: ACCOUNT } : opts.ownerAnswer === 'other' ? { ownerId: 'user_someoneElse', accountPublic: ACCOUNT } : null
  const accountCode = ownerAccountCode(OWNER_ID, ACCOUNT)
  const lines = opts.lines.map((l) => l.replace('<SQUEEZED>', accountCode.replace(/ /g, '').toUpperCase()).replace('<CODE>', accountCode))
  const code = `
    import { main } from ${JSON.stringify(commandUrl)};
    import { readHostRecord, hostPinStatus, ownerAccountCode, testSecurity } from ${JSON.stringify(hostUrl)};
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
    let output = '';
    process.stderr.write = (text) => { output += text; return true; };
    const lines = ${JSON.stringify(lines)};
    // One line per prompt: adding a data listener resumes the stream again, so only the first resume after a pause reads.
    let flowing = false;
    process.stdin.resume = () => { if (!flowing) { flowing = true; const line = lines.shift() ?? ''; queueMicrotask(() => process.stdin.emit('data', line + '\\n')); } return process.stdin; };
    process.stdin.pause = () => { flowing = false; return process.stdin; };
    const answer = ${JSON.stringify(answer)};
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/owner-account')) {
        if (String(url) !== 'https://api.example.test/api/v1/vault/agent/42/owner-account' || (init?.method ?? 'GET') !== 'GET' || !init?.headers?.['X-BGOS-Pairing'] || !init?.headers?.['x-bgos-a2a-signature']) return new Response('', { status: 400 });
        return answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('', { status: 503 });
      }
      return new Response(JSON.stringify({ registered: true, publicKey: JSON.parse(init.body).publicKey }), { status: 201 });
    };
    const code = await main([...${JSON.stringify(opts.args ?? [])}, '--assistant', '42', '--state-dir', ${JSON.stringify(dir)}], { security: testSecurity });
    const record = await readHostRecord(${JSON.stringify(dir)});
    const accountCode = ownerAccountCode(${JSON.stringify(OWNER_ID)}, ${JSON.stringify(ACCOUNT)});
    console.log(JSON.stringify({ code, pinned: hostPinStatus(record) === 'pinned', printed: output.includes(accountCode), output, anchored: record.ownerAccount ?? null, fillTrust: record.fillTrust ?? null, keys: !!record.hostSeed && !!record.signingSecret }));
  `
  const env: NodeJS.ProcessEnv = { ...process.env, BGOS_CREDENTIALS_PATH: credentialsPath, BGOS_ASSISTANT_ID: '42' }
  delete env.BGOS_PAIRING_TOKEN
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 15_000 })
    assert.equal(child.stderr, '')
    return { ...JSON.parse(child.stdout), OWNER_ID, ACCOUNT }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('V1: the account key is anchored only when the owner types the code HOAI shows, spaces and case ignored', async () => {
  const exact = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '<CODE>'] })
  assert.equal(exact.code, 0, exact.output)
  assert.equal(exact.pinned, true)
  assert.match(exact.output, /Type the account code shown in HOAI, under This agent's computer/)
  assert.equal(exact.printed, false, 'the code is never printed on this side')
  assert.deepEqual({ ownerId: exact.anchored.ownerId, accountPublic: exact.anchored.accountPublic, via: exact.anchored.via }, { ownerId: exact.OWNER_ID, accountPublic: exact.ACCOUNT, via: 'terminal' })
})

test('V1: the typed code may differ in spaces and case only', async () => {
  const run = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '<CODE>'] })
  const spaced = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '  <CODE>  '] })
  const squeezed = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '<SQUEEZED>'] })
  assert.ok(run.anchored && spaced.anchored && squeezed.anchored)
})

test('V1: a code that does not match anchors nothing and says so; the host pin stays', async () => {
  const wrong = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '0000 0000 0000 0000 0000'] })
  assert.equal(wrong.code, 1)
  assert.equal(wrong.pinned, true)
  assert.equal(wrong.anchored, null)
  assert.match(wrong.output, /The code does not match\. Do not continue: your HOAI account key on this computer could not be confirmed\./)
  const typedPinned = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', 'PINNED'] })
  assert.equal(typedPinned.anchored, null, 'typing PINNED again is no comparison')
})

test('V1: no answer from HOAI, or one for another owner: no code asked, nothing anchored', async () => {
  for (const ownerAnswer of ['down', 'other'] as const) {
    const got = await terminalRun({ ownerAnswer, lines: ['PINNED'] })
    assert.equal(got.code, 0, ownerAnswer)
    assert.equal(got.pinned, true, ownerAnswer)
    assert.equal(got.anchored, null, ownerAnswer)
    assert.doesNotMatch(got.output, /Type the account code/, ownerAnswer)
  }
})

test('V3: a new anchor clears the fill trust of the unanchored era; --reset-fill-trust clears it on confirmation, never the keys', async () => {
  const anchored = await terminalRun({ ownerAnswer: 'good', lines: ['PINNED', '<CODE>'], seedTrust: true })
  assert.ok(anchored.anchored)
  assert.equal(anchored.fillTrust, null, 'what first use trusted before the anchor is gone')
  const reset = await terminalRun({ ownerAnswer: 'down', lines: ['RESET'], args: ['--reset-fill-trust'], seedTrust: true })
  assert.equal(reset.code, 0)
  assert.equal(reset.fillTrust, null)
  assert.equal(reset.keys, true, 'the host keys stay')
  const kept = await terminalRun({ ownerAnswer: 'down', lines: ['no'], args: ['--reset-fill-trust'], seedTrust: true })
  assert.equal(kept.code, 1)
  assert.ok(kept.fillTrust, 'not confirmed: unchanged')
})
