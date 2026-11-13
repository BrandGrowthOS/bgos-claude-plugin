/**
 * vault-host: this agent machine's half of the HOAI agent vault contract
 * (capability canon, "Agent vault"; request and fill).
 *
 * WHAT IT HOLDS. One owner-only file, <agent state>/vault/vault-host.json:
 *   - hostSeed: an Ed25519 host key generated here on first use. Its standard
 *     Montgomery form (RFC 7748 scalar from SHA-512 of the seed) is the X25519
 *     host encryption key the contract registers, so the owner's devices can
 *     wrap item keys to this machine and nothing else.
 *   - signingSecret / identityPublic: the agent's own Ed25519 BGOS-A2A
 *     identity. The server only trusts an identity the owner minted for this
 *     agent, so it is provisioned once at this machine's terminal
 *     (bin/hoai-vault-host.mjs), never generated or accepted from a tool call.
 *   - registration: what the server accepted at POST .../host-key.
 *   - pin: the owner's confirmation, typed at this machine's terminal, that
 *     they compared the fingerprint and pinned this host in HOAI.
 *
 * RULES FROM THE CONTRACT, ENFORCED HERE.
 *   - The host-key proof is an Ed25519 signature by the agent identity over
 *     UTF-8 JSON ["hoai-vault-host-key-v1",ownerId,assistantId,publicKey].
 *   - Every agent call carries X-BGOS-Pairing and the four BGOS-A2A-V1
 *     headers over the exact body bytes, with the route's agent as source and
 *     target.
 *   - The fill intent is signed by the agent identity over UTF-8 JSON
 *     ["hoai-vault-fill-v1",ownerId,assistantId,vaultAssistantId,vaultId,
 *     itemId,revision,sessionId,tabId,origin,nonce,expiresAt].
 *   - The fingerprint (SHA-256 of JSON [identityPublic,publicKey], ten bytes,
 *     five groups of four hex digits) is written only to a local TTY. It never
 *     goes into a tool result, a pipe, a log or chat: the server can rewrite a
 *     chat message, so only this machine's own display is a comparison channel.
 *   - Errors carry a fixed VAULT_* code and never echo a response body.
 *
 * Plain JavaScript, node builtins only, so the daemon (bun) and the terminal
 * command (node) share it. No em or en dashes in this file.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

export const VAULT_HOST_FILE_NAME = 'vault-host.json'
/** The folder inside the agent state folder that holds only the host file. */
export const VAULT_HOST_DIR_NAME = 'vault'
/** Longest fill intent life: the server allows 60 s plus 5 s of clock skew. */
export const FILL_INTENT_TTL_MS = 55_000
const RESPONSE_MAX_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 15_000

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** A failure with a fixed code. The message never carries a value, key or body. */
export class VaultError extends Error {
  constructor(code, message, status) {
    super(message && message !== code ? `${code}: ${message}` : code)
    this.code = code
    if (status !== undefined) this.status = status
  }
}
const fail = (code, message, status) => new VaultError(code, message, status)

/** The vault folder for an agent state folder (~/.bgos-agent/<id>). */
export function vaultHostDir(agentStateDir) {
  return join(agentStateDir, VAULT_HOST_DIR_NAME)
}

// -- Owner-only storage ---------------------------------------------------------

const WINDOWS_REPAIR = 'In File Explorer, open Properties > Security > Advanced for the vault folder and key file, set yourself as owner, disable inheritance, and remove access for every other account. Then remove the exposed keys and run hoai vault-host again.'
const exposed = () => fail('VAULT_HOST_KEY_EXPOSED', WINDOWS_REPAIR)

// A cold or busy Windows PC takes seconds to start PowerShell (4 to 6 measured on a new Windows 11 install, more at
// sign in), so the limit is generous and a run that was cut off is tried once more.
const ACL_TIMEOUT_MS = 30_000

// Paths pass as data in an environment variable, never interpolated into PowerShell.
// Only ACL metadata can leave this subprocess. Key bytes are never read here.
function windowsAclCommand(path, script, execFileImpl = execFile, timeoutMs = ACL_TIMEOUT_MS) {
  const once = () => new Promise((resolve, reject) => {
    execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $p = $env:HOAI_VAULT_ACL_PATH; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " + script], {
      env: { ...process.env, HOAI_VAULT_ACL_PATH: path }, encoding: 'utf8', windowsHide: true,
      timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false,
    }, (error, stdout) => {
      // Cut off at the time limit, or never started: PowerShell said nothing about the access list.
      if (error) reject(Object.assign(exposed(), { couldNotRun: error.killed === true || typeof error.code === 'string' }))
      else resolve(stdout)
    })
  })
  return once().catch((error) => {
    if (!error.couldNotRun) throw error
    return once()
  })
}

// What the access list of $p says, as JSON. Shared by the read and by the protect, which reads back in the same run.
const ACL_AS_JSON = `
    $acl = Get-Acl -LiteralPath $p;
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights }
    });
    @{ ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
       userSid = $sid.Value; protected = $acl.AreAccessRulesProtected; entries = $rules } | ConvertTo-Json -Depth 4 -Compress;
  `

async function readWindowsAcl(path, command = windowsAclCommand) {
  return JSON.parse(await command(path, ACL_AS_JSON))
}

/** Protects the path and returns the access list read back by the same PowerShell, or undefined when it printed none. */
async function restrictWindowsAcl(path, command = windowsAclCommand) {
  const out = await command(path, `
    $item = Get-Item -LiteralPath $p -Force;
    if ($item.PSIsContainer) {
      $acl = New-Object System.Security.AccessControl.DirectorySecurity;
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
    } else {
      $acl = New-Object System.Security.AccessControl.FileSecurity;
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow');
    }
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule($rule);
    Set-Acl -LiteralPath $p -AclObject $acl;
  ` + ACL_AS_JSON)
  try { return JSON.parse(out) } catch { return undefined }
}

/** Injectable ACL IO lets every OS exercise the same fail-closed Windows guard. */
export function createWindowsVaultSecurity({ execFileImpl = execFile, timeoutMs = ACL_TIMEOUT_MS } = {}) {
  const command = (path, script) => windowsAclCommand(path, script, execFileImpl, timeoutMs)
  return {
    platform: 'win32',
    readWindowsAcl: path => readWindowsAcl(path, command),
    restrictWindowsAcl: path => restrictWindowsAcl(path, command),
  }
}

/**
 * @typedef {{ platform: string, readWindowsAcl: (path: string) => any,
 *   restrictWindowsAcl: (path: string) => unknown }} VaultSecurity
 */
// Constructing readers is inert. Only an explicit storage operation starts a process.
/** @type {VaultSecurity} */
const defaultSecurity = { ...createWindowsVaultSecurity(), platform: process.platform }

/** An access list that names only the current account, owned by it and protected. */
const aclOwnerOnly = (acl) => Boolean(acl && typeof acl.userSid === 'string' && /^S-1-/.test(acl.userSid) &&
  acl.ownerSid === acl.userSid && acl.protected === true && Array.isArray(acl.entries) &&
  acl.entries.length > 0 && acl.entries.some(rule => rule.type === 'Allow' && rule.sid === acl.userSid && rule.rights > 0) &&
  acl.entries.every(rule => rule && typeof rule.sid === 'string' && Number.isInteger(rule.rights) && rule.rights > 0 &&
    (rule.type === 'Deny' || (rule.type === 'Allow' && rule.sid === acl.userSid))))

async function ownerOnly(path, fs, security = defaultSecurity) {
  const st = fs.lstatSync(path)
  if (st.isSymbolicLink()) return false
  if (security.platform === 'win32') {
    try {
      return aclOwnerOnly(await security.readWindowsAcl(path))
    } catch { return false }
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
  return (st.mode & 0o077) === 0
}

/**
 * What is KNOWN about one path, for the zero setup self repair. `ownerOnly`
 * fails closed (anything it cannot prove private is refused), which is right
 * for reading a key and wrong for deleting one: a slow PowerShell or a file
 * that belongs to another account is not proof that a key was exposed.
 * 'exposed' only when the protection was read and it does name someone else.
 */
async function exposureOf(path, fs, security) {
  let st
  try { st = fs.lstatSync(path) } catch { return 'missing' }
  if (st.isSymbolicLink()) return 'unknown'
  if (security.platform === 'win32') {
    let acl
    try { acl = await security.readWindowsAcl(path) } catch { return 'unknown' }
    if (!acl || typeof acl.userSid !== 'string' || !/^S-1-/.test(acl.userSid) || typeof acl.ownerSid !== 'string' || !Array.isArray(acl.entries)) return 'unknown'
    return aclOwnerOnly(acl) ? 'private' : 'exposed'
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'unknown'
  return (st.mode & 0o077) === 0 ? 'private' : 'exposed'
}

/** 'private' | 'exposed' | 'unknown' for the vault folder and its key file together. */
export async function hostKeyExposure(dir, fs = nodeFs, security = defaultSecurity) {
  const folder = await exposureOf(dir, fs, security)
  const file = await exposureOf(join(dir, VAULT_HOST_FILE_NAME), fs, security)
  if (folder === 'unknown' || file === 'unknown') return 'unknown'
  return folder === 'exposed' || file === 'exposed' ? 'exposed' : 'private'
}

async function restrict(path, fs, mode, security) {
  if (security.platform === 'win32') {
    let acl
    try { acl = await security.restrictWindowsAcl(path) } catch { throw exposed() }
    // The PowerShell that set the access list read it back too: one start, not two. A reader that returns
    // nothing (an injected one, or a garbled answer) gets the separate read as before.
    const ok = acl && typeof acl === 'object'
      ? !fs.lstatSync(path).isSymbolicLink() && aclOwnerOnly(acl)
      : await ownerOnly(path, fs, security)
    if (!ok) throw exposed()
  } else fs.chmodSync(path, mode)
}

async function ensureDir(dir, fs, security) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    await restrict(dir, fs, 0o700, security)
    // On Windows the protect just read the access list back and refused anything not owner only.
    if (security.platform === 'win32') return
  }
  if (!(await ownerOnly(dir, fs, security))) throw security.platform === 'win32' ? exposed() : fail('VAULT_HOST_KEY_EXPOSED', 'The vault host folder is readable by other users. Remove it and run hoai vault-host again.')
}

/** Write atomically. Protect an empty temporary file before writing any key. */
async function writeRecord(dir, record, fs, create = false, security = defaultSecurity) {
  await ensureDir(dir, fs, security)
  const path = join(dir, VAULT_HOST_FILE_NAME)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    await restrict(tmp, fs, 0o600, security)
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`)
    fs.closeSync(fd)
    fd = undefined
    if (!create) fs.renameSync(tmp, path)
    else {
      try { fs.linkSync(tmp, path) } catch (error) {
        if (error?.code === 'EEXIST') return false
        throw error
      }
    }
    if (!(await ownerOnly(dir, fs, security)) || !(await ownerOnly(path, fs, security))) throw exposed()
    return true
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/** The same atomic owner-only write, for the zero setup module (lib/vault-host-auto.mjs). */
export async function writeHostRecord(dir, record, fs = nodeFs, security = defaultSecurity) {
  await writeRecord(dir, record, fs, false, security)
}

/** Best effort: make an existing vault folder private to this account again. */
export async function tightenHostDir(dir, fs = nodeFs, security = defaultSecurity) {
  try { await restrict(dir, fs, 0o700, security) } catch {}
}

/** Refuse exposed directories and files before reading either private key. */
export async function readHostRecord(dir, fs = nodeFs, security = defaultSecurity) {
  const path = join(dir, VAULT_HOST_FILE_NAME)
  if (!fs.existsSync(path)) return null
  if (!(await ownerOnly(dir, fs, security)) || !(await ownerOnly(path, fs, security))) {
    throw security.platform === 'win32' ? exposed() : fail('VAULT_HOST_KEY_EXPOSED', 'The vault host key file is readable by other users. Remove it and run hoai vault-host again.')
  }
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(path, 'utf8')) } catch { throw fail('VAULT_HOST_KEY_INVALID', 'The vault host key file is damaged. Remove it and run hoai vault-host again.') }
  if (!parsed || parsed.version !== 1 || typeof parsed.hostSeed !== 'string' || typeof parsed.publicKey !== 'string') {
    throw fail('VAULT_HOST_KEY_INVALID', 'The vault host key file is damaged. Remove it and run hoai vault-host again.')
  }
  if (x25519FromSeed(parsed.hostSeed) !== parsed.publicKey) throw fail('VAULT_HOST_KEY_INVALID', 'The vault host key file is damaged. Remove it and run hoai vault-host again.')
  return parsed
}

// -- Keys -------------------------------------------------------------------------

function seedBytes(hostSeed) {
  const key = createPrivateKey({ key: Buffer.from(hostSeed, 'base64url'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw fail('VAULT_HOST_KEY_INVALID')
  return key.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
}

/** The X25519 private key for an Ed25519 host seed (RFC 8032 / RFC 7748). */
export function hostEncryptionPrivateKey(hostSeed) {
  const scalar = createHash('sha512').update(seedBytes(hostSeed)).digest().subarray(0, 32)
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]), format: 'der', type: 'pkcs8' })
}

function x25519FromSeed(hostSeed) {
  try {
    return createPublicKey(hostEncryptionPrivateKey(hostSeed)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  } catch {
    return null
  }
}

/**
 * The host record, creating an Ed25519 host key on first use. The record on
 * disk is reused as it is; a new key is only made when there is none.
 */
export async function loadOrCreateHostKey(dir, assistantId, fs = nodeFs, security = defaultSecurity) {
  const existing = await readHostRecord(dir, fs, security)
  if (existing) {
    if (String(existing.assistantId) !== String(assistantId)) throw fail('VAULT_HOST_KEY_INVALID', 'This vault host key belongs to another agent.')
    return existing
  }
  const pair = generateKeyPairSync('ed25519')
  const hostSeed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const record = { version: 1, assistantId: Number(assistantId), hostSeed, publicKey: x25519FromSeed(hostSeed), createdAt: new Date().toISOString() }
  if (await writeRecord(dir, record, fs, true, security)) return record
  // Another process created the key first: use that one.
  return loadOrCreateHostKey(dir, assistantId, fs, security)
}

function identityFromSecret(signingSecret) {
  let key
  try {
    key = createPrivateKey({ key: Buffer.from(String(signingSecret ?? '').trim(), 'base64url'), format: 'der', type: 'pkcs8' })
  } catch {
    throw fail('VAULT_SIGNING_KEY_INVALID', 'That is not an Ed25519 agent signing key.')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw fail('VAULT_SIGNING_KEY_INVALID', 'That is not an Ed25519 agent signing key.')
  return {
    key,
    secret: key.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    identityPublic: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

/**
 * Store the agent's owner-minted Ed25519 signing identity (base64url PKCS8 DER,
 * as the signing-key rotation returns it). Returns only the public half.
 * A changed identity drops the registration and pin: they no longer describe it.
 */
export async function provisionSigningIdentity(dir, assistantId, signingSecret, fs = nodeFs, security = defaultSecurity) {
  const record = await loadOrCreateHostKey(dir, assistantId, fs, security)
  const identity = identityFromSecret(signingSecret)
  const next = { ...record, signingSecret: identity.secret, identityPublic: identity.identityPublic }
  if (record.identityPublic !== identity.identityPublic) {
    delete next.registration
    delete next.pin
  }
  await writeRecord(dir, next, fs, false, security)
  return { identityPublic: identity.identityPublic }
}

/** a<assistantId>.<base64url SHA-256 of the SPKI DER>, the BGOS-A2A key id. */
export function a2aKeyId(assistantId, identityPublic) {
  return `a${assistantId}.${createHash('sha256').update(Buffer.from(identityPublic, 'base64url')).digest('base64url')}`
}

// -- Fingerprint: local terminal only ------------------------------------------------

export function hostFingerprint(identityPublic, publicKey) {
  return createHash('sha256').update(JSON.stringify([identityPublic, publicKey])).digest('hex').slice(0, 20).match(/.{4}/g).join(' ')
}

/**
 * Write the fingerprint to `display` only when it is a TTY. A pipe or a
 * redirected file is not an independent comparison channel, so it gets
 * nothing. Returns whether it was shown.
 */
/**
 * @param {{ identityPublic?: string, publicKey?: string } | null | undefined} record
 * @param {{ isTTY?: boolean, write: (text: string) => unknown }} [display]
 */
export function showFingerprintOnTerminal(record, display = process.stderr) {
  if (!display?.isTTY || !record?.identityPublic || !record?.publicKey) return false
  display.write(
    `\nHost fingerprint (compare outside HOAI): ${hostFingerprint(record.identityPublic, record.publicKey)}\n` +
      'Compare it with the fingerprint HOAI shows for this agent, then pin this host in HOAI.\n' +
      'Never send this fingerprint in a chat message or tool result: the server can rewrite a chat message.\n\n',
  )
  return true
}

// -- Pin status ------------------------------------------------------------------

/** 'no_identity' | 'unregistered' | 'unconfirmed' | 'pinned' */
export function hostPinStatus(record) {
  if (!record?.signingSecret || !record?.identityPublic) return 'no_identity'
  const r = record.registration
  if (!r || r.publicKey !== record.publicKey || r.identityPublic !== record.identityPublic) return 'unregistered'
  const p = record.pin
  if (!p || p.publicKey !== record.publicKey || p.identityPublic !== record.identityPublic) return 'unconfirmed'
  return 'pinned'
}

/**
 * Record the owner's confirmation that they compared the fingerprint on this
 * machine and pinned this host in HOAI. Only for the registered keys.
 */
export async function confirmHostPin(dir, fs = nodeFs, security = defaultSecurity) {
  const record = await readHostRecord(dir, fs, security)
  const status = hostPinStatus(record)
  if (status === 'no_identity' || status === 'unregistered') throw fail('VAULT_HOST_NOT_REGISTERED', 'Register this host before confirming the pin.')
  await writeRecord(dir, { ...record, pin: { publicKey: record.publicKey, identityPublic: record.identityPublic, at: new Date().toISOString() } }, fs, false, security)
}

// -- Signed agent requests ------------------------------------------------------------

function normalizedPath(url) {
  const collapsed = new URL(url).pathname.replace(/\/{2,}/g, '/')
  return collapsed === '/' ? collapsed : collapsed.replace(/\/+$/, '') || '/'
}

/** The headers for one signed agent call: pairing plus BGOS-A2A-V1 over the exact body. */
export function signedHeaders({ method, url, body = '', assistantId, signingSecret, pairingToken, now = Date.now(), nonce = randomUUID() }) {
  if (typeof pairingToken !== 'string' || !pairingToken.trim() || /[\r\n]/.test(pairingToken)) throw fail('VAULT_NOT_PAIRED', 'This agent has no pairing credential.')
  const identity = identityFromSecret(signingSecret)
  const timestamp = String(Math.floor(now / 1000))
  const canonical = [
    'BGOS-A2A-V1',
    method.toUpperCase(),
    normalizedPath(url),
    String(assistantId),
    String(assistantId),
    '',
    createHash('sha256').update(body).digest('hex'),
    '',
    timestamp,
    nonce,
  ].join('\n')
  return {
    'X-BGOS-Pairing': pairingToken,
    'x-bgos-a2a-key-id': a2aKeyId(assistantId, identity.identityPublic),
    'x-bgos-a2a-timestamp': timestamp,
    'x-bgos-a2a-nonce': nonce,
    'x-bgos-a2a-signature': `v1=${sign(null, Buffer.from(canonical), identity.key).toString('base64url')}`,
  }
}

async function readCapped(response) {
  const reader = response.body?.getReader?.()
  if (!reader) return ''
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        throw fail('VAULT_UNAVAILABLE', 'The vault answer was too large.')
      }
      chunks.push(Buffer.from(next.value))
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One signed call to /vault/agent/<assistantId>/<sub>. Returns parsed JSON.
 * A failed call throws VAULT_UNAVAILABLE or VAULT_REQUEST_REFUSED with the HTTP
 * status only: the response body is never read into an error.
 */
/**
 * @param {{ method: 'GET' | 'POST', apiBase: string, assistantId: number | string, sub: string,
 *   query?: Record<string, unknown>, body?: Record<string, unknown>, signingSecret: string,
 *   pairingToken: string, fetch?: typeof globalThis.fetch }} input
 * @returns {Promise<any>}
 */
export async function vaultCall({ method, apiBase, assistantId, sub, query, body, signingSecret, pairingToken, fetch = globalThis.fetch }) {
  const base = String(apiBase).replace(/\/+$/, '')
  const url = new URL(`${base}/vault/agent/${Number(assistantId)}/${sub}`)
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers = {
    ...signedHeaders({ method, url: url.href, body: text, assistantId, signingSecret, pairingToken }),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    accept: 'application/json',
  }
  let response
  try {
    response = await fetch(url.href, {
      method,
      headers,
      ...(body === undefined ? {} : { body: text }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw fail('VAULT_UNAVAILABLE', 'The vault could not be reached.')
  }
  if (!response.ok) {
    try { await response.body?.cancel?.() } catch {}
    const code = response.status === 400 || response.status === 409 || response.status === 422 ? 'VAULT_REQUEST_REFUSED' : 'VAULT_UNAVAILABLE'
    throw fail(code, `The vault answered HTTP ${response.status}.`, response.status)
  }
  const raw = await readCapped(response)
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw fail('VAULT_UNAVAILABLE', 'The vault answer was not JSON.')
  }
}

/**
 * Register the host key: POST .../host-key {publicKey,signature} with the
 * independent proof. Records the registration; never returns the fingerprint.
 */
export async function registerHostKey({ stateDir, assistantId, ownerId, apiBase, pairingToken, fetch, fs = nodeFs, security = defaultSecurity }) {
  const record = await loadOrCreateHostKey(stateDir, assistantId, fs, security)
  if (!record.signingSecret) throw fail('VAULT_HOST_SETUP_REQUIRED', 'Provision the agent signing key first.')
  if (typeof ownerId !== 'string' || !ownerId) throw fail('VAULT_NOT_PAIRED', 'This agent has no owner id.')
  const identity = identityFromSecret(record.signingSecret)
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(['hoai-vault-host-key-v1', ownerId, Number(assistantId), record.publicKey])),
    identity.key,
  ).toString('base64url')
  const answer = await vaultCall({ method: 'POST', apiBase, assistantId, sub: 'host-key', body: { publicKey: record.publicKey, signature }, signingSecret: record.signingSecret, pairingToken, fetch })
  if (answer?.registered !== true || answer.publicKey !== record.publicKey) throw fail('VAULT_UNAVAILABLE', 'The server did not confirm this host key.')
  const fresh = await readHostRecord(stateDir, fs, security)
  const next = { ...fresh, registration: { publicKey: record.publicKey, identityPublic: identity.identityPublic, ownerId, at: new Date().toISOString() } }
  // A new registration of the same keys keeps the pin; other keys never inherit it.
  if (fresh.pin && (fresh.pin.publicKey !== record.publicKey || fresh.pin.identityPublic !== identity.identityPublic)) delete next.pin
  await writeRecord(stateDir, next, fs, false, security)
  return { registered: true }
}

// -- Fill intent -----------------------------------------------------------------

const INTENT_FIELDS = ['version', 'ownerId', 'assistantId', 'vaultAssistantId', 'vaultId', 'itemId', 'revision', 'sessionId', 'tabId', 'origin', 'nonce', 'expiresAt']
const UUID = /^[0-9a-f-]{36}$/i

export function fillIntentText(i) {
  return JSON.stringify(['hoai-vault-fill-v1', i.ownerId, i.assistantId, i.vaultAssistantId, i.vaultId, i.itemId, i.revision, i.sessionId, i.tabId, i.origin, i.nonce, i.expiresAt])
}

/** The same shape and lifetime checks the server applies before it verifies. */
export function fillIntentShapeOk(i, now = Date.now()) {
  try {
    if (!i || typeof i !== 'object' || Object.keys(i).length !== INTENT_FIELDS.length || INTENT_FIELDS.some((k) => !(k in i))) return false
    if (i.version !== 1) return false
    if (![i.assistantId, i.vaultAssistantId, i.revision].every((n) => Number.isSafeInteger(n) && n > 0)) return false
    if (!Number.isSafeInteger(i.expiresAt) || i.expiresAt <= now || i.expiresAt > now + 65_000) return false
    if (![i.vaultId, i.itemId, i.nonce].every((s) => typeof s === 'string' && UUID.test(s))) return false
    if (![i.ownerId, i.sessionId, i.tabId].every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128)) return false
    const origin = new URL(i.origin)
    return origin.protocol === 'https:' && origin.origin === i.origin
  } catch {
    return false
  }
}

export function signFillIntent(intent, signingSecret) {
  return sign(null, Buffer.from(fillIntentText(intent)), identityFromSecret(signingSecret).key).toString('base64url')
}

export function verifyFillIntent(intent, signature, identityPublic, now = Date.now()) {
  try {
    if (!fillIntentShapeOk(intent, now) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
    const key = createPublicKey({ key: Buffer.from(identityPublic, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verify(null, Buffer.from(fillIntentText(intent)), key, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/** Build a fresh intent for one item, session, tab and origin. */
export function buildFillIntent({ ownerId, assistantId, vaultAssistantId, vaultId, itemId, revision, sessionId, tabId, origin, now = Date.now() }) {
  return {
    version: 1,
    ownerId,
    assistantId: Number(assistantId),
    vaultAssistantId: Number(vaultAssistantId),
    vaultId,
    itemId,
    revision: Number(revision),
    sessionId,
    tabId,
    origin,
    nonce: randomUUID(),
    expiresAt: now + FILL_INTENT_TTL_MS,
  }
}
