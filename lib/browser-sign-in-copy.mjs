/**
 * The agent machine's side of sealed sign-ins (portable browser design, section 6;
 * KC: "agent machine retain the cookies and the login and all that, yes, in a
 * vault"). An approved machine opens its copy with its own key, with nobody there,
 * and puts it in the browser's own nonpersistent context.
 *
 * WHAT IT HOLDS TO.
 *   - Only a copy a computer this machine reviewed sealed to this machine's key
 *     opens (browser-profile-peer-pins). The server cannot plant a sign-in, and a
 *     copy holding a password is refused.
 *   - At rest it is sealed under a key derived from the machine's own private key,
 *     which lives in the OS key store. No value and no site name is in any file,
 *     log or status. The browser context is nonpersistent, so Chrome writes none.
 *   - A sign-in made here goes back sealed to the reviewed computers alone.
 *   - No value reaches a tool result, the agent's model, its files or its chat: this
 *     module returns true or false and codes, and the browser tools still cannot
 *     read cookies or storage (policy.js).
 *
 * No em or en dashes in this file.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { AgentProfileCompanionState } from './browser-profile-companion-state.mjs'
import { AgentProfileCoordinatorClient } from './browser-profile-companion-client.mjs'
import { AgentProfilePeerPins } from './browser-profile-peer-pins.mjs'
import { BrowserProfileSyncKeyStore } from './browser-profile-sync-key-store.mjs'
import { profileCrypto, restoreProfileEnrollment } from './browser-profile-runtime.mjs'

const require = createRequire(import.meta.url)
const { openSignInCopy, sealSignInCopy, signInStateOf, sitesOf } = require('./browser-profile-core/sign-in-copy.js')
const { identityFingerprint } = require('./browser-profile-core/crypto.js')
const { SignInCopyClient } = require('./browser-profile-core/sign-in-copy-client.js')

const SEALED_VERSION = 1, MAX_SEALED_BYTES = 40 * 1024 * 1024
const fail = code => Object.assign(new Error(code), { code })

/** Playwright's storage state as the portable shape a person's computer restores. */
export function portableStateOf(storage) {
  return {
    cookies: (storage.cookies || []).map(row => ({
      name: row.name, value: row.value, domain: row.domain, path: row.path, expires: row.expires, size: Buffer.byteLength(row.name) + Buffer.byteLength(row.value),
      httpOnly: row.httpOnly === true, secure: row.secure === true, session: row.expires === -1, ...(row.sameSite ? { sameSite: row.sameSite } : {}),
      priority: 'Medium', sourceScheme: row.secure === true ? 'Secure' : 'NonSecure', sourcePort: row.secure === true ? 443 : 80,
    })),
    origins: (storage.origins || []).map(row => ({ schema: 'hoai-origin-storage-v1', origin: row.origin, localStorage: (row.localStorage || []).map(({ name, value }) => ({ name, value })), indexedDB: [] })),
    preferences: { v: 1, searchEngine: 'google' },
  }
}

/** A portable state as Playwright's. A site's IndexedDB does not restore here: cookies and local storage do. */
export function storageStateOf(state) {
  return {
    cookies: state.cookies.map(row => ({ name: row.name, value: row.value, domain: row.domain, path: row.path, expires: row.session ? -1 : row.expires, httpOnly: row.httpOnly === true, secure: row.secure === true, sameSite: row.sameSite || 'Lax' })),
    origins: state.origins.map(row => ({ origin: row.origin, localStorage: row.localStorage.map(({ name, value }) => ({ name, value })) })),
  }
}

export class AgentSignInCopy {
  #key = null
  constructor({ directory, scope, endpoint, grantVersion, peers, client, log = () => {}, now = Date.now }) {
    if (!path.isAbsolute(directory) || !endpoint?.identity || !Number.isSafeInteger(grantVersion) || !Array.isArray(peers) || !client) throw fail('profile_sign_in_copy_refused')
    Object.assign(this, { directory, scope, endpoint, grantVersion, peers, client, log, now })
    this.file = path.join(directory, `${endpoint.identity.endpointId}.sealed`)
    this.last = { sequence: 0, sealedAt: null, applied: false, sending: null }
  }

  /** The key at rest: from this machine's private key, so a copied file opens nowhere else. */
  #restKey() {
    if (this.#key) return this.#key
    const secret = this.endpoint.encryptionPrivateKey.export({ type: 'pkcs8', format: 'der' })
    try { this.#key = Buffer.from(hkdfSync('sha256', secret, this.#aad(), 'HOAI-SIGN-IN-COPY-AT-REST-v1', 32)) } finally { secret.fill(0) }
    return this.#key
  }
  #aad() { return Buffer.from(JSON.stringify([this.scope.profileId, this.scope.actingUserId, this.scope.assistantId, this.endpoint.identity.endpointId])) }

  async #keep(state, sequence, createdAt) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#restKey(), iv); cipher.setAAD(this.#aad())
    const plain = Buffer.from(JSON.stringify({ version: SEALED_VERSION, sequence, createdAt, state }))
    const body = Buffer.concat([cipher.update(plain), cipher.final()]); plain.fill(0)
    const bytes = Buffer.concat([iv, cipher.getAuthTag(), body])
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`)
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, this.file)
  }

  async #kept() {
    let bytes
    try { bytes = await fs.readFile(this.file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (bytes.length < 29 || bytes.length > MAX_SEALED_BYTES) throw fail('profile_sign_in_copy_refused')
    const decipher = createDecipheriv('aes-256-gcm', this.#restKey(), bytes.subarray(0, 12)); decipher.setAAD(this.#aad()); decipher.setAuthTag(bytes.subarray(12, 28))
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
    try {
      const value = JSON.parse(plain.toString('utf8'))
      if (value.version !== SEALED_VERSION) throw fail('profile_sign_in_copy_refused')
      return value
    } finally { plain.fill(0) }
  }

  /**
   * The copies addressed here, and each computer's current grant. A grant number is
   * only a label on a seal: the key a copy is sealed to is always this machine's own
   * reviewed pin, and a row whose fingerprint differs from the pin is dropped.
   */
  async #read() {
    const answer = await this.client.read({ scope: this.scope, endpoint: this.endpoint, grantVersion: this.grantVersion })
    this.grants = new Map()
    for (const peer of this.peers) {
      const row = (Array.isArray(answer?.peers) ? answer.peers : []).find(value => value?.endpointId === peer.endpointId)
      if (row && row.keyFingerprint === identityFingerprint(peer) && Number.isSafeInteger(row.grantVersion)) this.grants.set(peer.endpointId, row.grantVersion)
    }
    return answer
  }

  /** The newest copy a reviewed computer sealed here, kept sealed. False when there was nothing newer. */
  async #refresh(kept) {
    let copies
    try { ({ copies } = await this.#read()) } catch (error) {
      this.log(`sign-ins: could not read the newest copy (${error?.code || 'unavailable'}); using what this machine keeps`)
      return null
    }
    const expected = { ...this.scope, afterSequence: kept?.sequence ?? 0, recipient: { endpointId: this.endpoint.identity.endpointId, keyFingerprint: identityFingerprint(this.endpoint.identity), grantVersion: this.grantVersion } }
    let newest = null
    for (const copy of Array.isArray(copies) ? copies : []) {
      const peer = this.peers.find(row => row.endpointId === copy?.manifest?.sourceEndpointId)
      if (!peer) { this.log('sign-ins: refused a copy from a computer this machine has not reviewed'); continue }
      try {
        const opened = openSignInCopy({ copy, sourceIdentity: peer, recipient: this.endpoint, expected })
        if (!newest || opened.sequence > newest.sequence) newest = opened
      } catch { if ((copy?.manifest?.sequence ?? 0) > expected.afterSequence) this.log('sign-ins: refused a copy that did not open') }
    }
    if (!newest) return null
    await this.#keep(newest.state, newest.sequence, newest.createdAt)
    return newest
  }

  /** Puts this agent's sign-ins in the browser context. True when it did. Never throws. */
  async applyTo(context) {
    try {
      let kept = null
      try { kept = await this.#kept() } catch { this.log('sign-ins: the copy kept here did not open with this key'); return false }
      const fresh = await this.#refresh(kept)
      const use = fresh || kept
      if (!use) return false
      await context.setStorageState(storageStateOf(use.state))
      this.last = { ...this.last, sequence: use.sequence, sealedAt: use.createdAt, applied: true }
      this.log(`sign-ins: opened copy ${use.sequence} with this machine's own key`)
      return true
    } catch (error) { this.log(`sign-ins: not applied (${error?.code || 'failed'})`); return false }
  }

  /** Seals what this context holds to the reviewed computers. Never throws. */
  async sendBack(context) {
    if (!this.peers.length) return 0
    try {
      const safe = signInStateOf(portableStateOf(await context.storageState())), sites = sitesOf(safe)
      const source = { identity: this.endpoint.identity, signingPrivateKey: this.endpoint.signingPrivateKey }
      await this.#read()
      let sent = 0
      for (const peer of this.peers) {
        const grantVersion = this.grants.get(peer.endpointId)
        if (grantVersion === undefined) continue
        const sequence = this.now()
        const copy = sealSignInCopy({ state: safe, scope: this.scope, source, sequence, createdAt: sequence,
          recipient: { identity: peer, keyFingerprint: identityFingerprint(peer), grantVersion } })
        try { await this.client.upload(this.scope.profileId, copy, sites); sent++ } catch (error) { this.log(`sign-ins: could not send a copy back (${error?.code || 'failed'})`) }
      }
      return sent
    } catch (error) { this.log(`sign-ins: not sealed (${error?.code || 'failed'})`); return 0 }
  }

  /** What the host may say. A sequence and a time; no site and no value. */
  async status() { return { applied: this.last.applied, sequence: this.last.sequence, sealedAt: this.last.sealedAt } }
  dispose() { this.#key?.fill(0); this.#key = null }
}

/**
 * This machine's holder for one person and agent, or null when the machine has no
 * enrolled endpoint for them. A locked key store throws here, and the pool opens
 * the browser with no sign-ins: a needs you, never a passphrase box or a file key.
 */
export async function loadMachineSignIns({ agentRoot, pairing, assistantId, principal, environment = process.env, keyStore, log = () => {} }) {
  if (!pairing?.token || !principal?.startsWith('user-')) return null
  const origin = new URL(pairing.backendUrl).origin, directory = path.join(agentRoot, '.browser-profile-sync', createHash('sha256').update(origin).digest('hex'))
  const check = () => true
  const rows = await new AgentProfileCompanionState({ directory: path.join(directory, 'endpoints') }).loadAll(check)
  const row = rows.find(value => value.scope.assistantId === assistantId && `user-${value.scope.actingUserId}` === principal && value.scope.pairingId === pairing.pairingId)
  if (!row) return null
  const authorizePairing = async () => ({ token: pairing.token, assertCurrent: check, pairingId: pairing.pairingId, ownerUserId: pairing.ownerUserId, assistantId })
  const coordinator = new AgentProfileCoordinatorClient({ endpoint: origin, authorizePairing })
  const store = keyStore || new BrowserProfileSyncKeyStore({ endpointCrypto: profileCrypto, environment })
  const endpoint = await restoreProfileEnrollment({ keyStore: store, record: row.keyRecord, pinnedIdentity: row.identity, pairing: { pairingId: row.scope.pairingId, ownerUserId: row.scope.ownerUserId },
    authorizeEnrollment: async () => ({ ...await coordinator.enrollment(row.scope, row.identity), assertCurrent: check }) })
  const discovery = await coordinator.discover(row.scope, endpoint)
  if (discovery.profiles.length !== 1 || discovery.profiles[0].grant.backgroundUse !== true) return null
  const peers = await new AgentProfilePeerPins({ directory: path.join(directory, 'peer-pins', row.scope.endpointId) }).list({ scope: row.scope, ownIdentity: row.identity, assertCurrent: check })
  const scope = { profileId: row.scope.profileId, actingUserId: row.scope.actingUserId, assistantId }
  const client = new SignInCopyClient({ endpoint: origin, headers: async () => ({ 'X-BGOS-Pairing': pairing.token }) })
  return new AgentSignInCopy({ directory: path.join(directory, 'sign-ins'), scope, endpoint, grantVersion: discovery.profiles[0].grant.generation, peers, client, log })
}
