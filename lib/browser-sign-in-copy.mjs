/**
 * The agent machine's side of sealed sign-ins (portable browser design, section 6).
 * An approved machine opens its copy with its own key, with nobody there,
 * and puts it in the browser's own nonpersistent context.
 *
 * WHAT IT HOLDS TO.
 *   - Only a copy a computer this machine reviewed sealed to this machine's key
 *     opens (browser-profile-peer-pins). The server cannot plant a sign-in, and a
 *     copy holding a password is refused.
 *   - At rest it is sealed under a key derived from the machine's own private key,
 *     which lives in the OS key store. No value and no site name is in any file,
 *     log or status. The browser context is nonpersistent, so Chrome writes none.
 *   - A sign-in made here goes back sealed to the reviewed computers alone, and only
 *     the sites that changed after a copy opened: nothing when none opened.
 *   - This module returns true or false and codes, and the browser tools cannot read
 *     cookies or storage (policy.js). What a signed in page DISPLAYS does reach the
 *     agent's snapshots: that is what browsing it means.
 *   - THE LIMIT OF ALL THE ABOVE: a program running as the same OS user as this host
 *     can do what this host does. So a copy opens only where
 *     the agent runs as another OS user (agentSharesHostUser). Everywhere else it stays
 *     on the person's computer, and nothing here reads a key. The person's computer holds
 *     the same line from its side and seals nothing to such a machine
 *     (machineProvedSeparateUser): no proof exists yet, so today no copy arrives anywhere.
 *
 * No em or en dashes in this file.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { AgentProfileCompanionState } from './browser-profile-companion-state.mjs'
import { AgentProfileCoordinatorClient } from './browser-profile-companion-client.mjs'
import { AgentProfilePeerPins } from './browser-profile-peer-pins.mjs'
import { BrowserProfileSyncKeyStore } from './browser-profile-sync-key-store.mjs'
import { profileCrypto, restoreProfileEnrollment } from './browser-profile-runtime.mjs'

const require = createRequire(import.meta.url)
const { changedSites, onlySites, openSignInCopy, sealSignInCopy, signInStateOf, siteDigests, sitesOf } = require('./browser-profile-core/sign-in-copy.js')
const { identityFingerprint } = require('./browser-profile-core/crypto.js')
const { SignInCopyClient } = require('./browser-profile-core/sign-in-copy-client.js')

const SEALED_VERSION = 1, MAX_SEALED_BYTES = 40 * 1024 * 1024
const fail = code => Object.assign(new Error(code), { code })

/**
 * Does the agent this host serves run as this host's own OS user? Yes, unless the agent's folder
 * proves otherwise: it belongs to another ordinary user. Root owning it proves nothing, and neither
 * does a system with no user ids or a folder that cannot be read, so all of those read as shared.
 * A program cannot give a folder away to another user without being root, so an agent sharing this
 * host's user cannot talk its way past this.
 */
export function agentSharesHostUser({ agentRoot, getuid = process.getuid, stat = lstatSync }) {
  if (typeof getuid !== 'function') return true
  try {
    const owner = stat(agentRoot).uid
    return !Number.isInteger(owner) || owner === 0 || owner === getuid()
  } catch { return true }
}

/** What a machine that refuses holds: no key, no copy, and nothing to send. */
const REFUSED_SIGN_INS = Object.freeze({ refused: true, applyTo: async () => false, sendBack: async () => 0, status: async () => ({ applied: false, sequence: 0, sealedAt: null }), dispose() {} })

/** Sealed copies kept here by an earlier version. A copy that will not open here stays with the person. */
async function dropKeptCopies(directory) {
  let names = []
  try { names = await fs.readdir(directory) } catch { return }
  await Promise.all(names.filter(name => name.endsWith('.sealed') || name.endsWith('.tmp')).map(name => fs.rm(path.join(directory, name), { force: true }).catch(() => {})))
}

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
      // What the browser holds as this copy opens, as digests in memory: only what changes after this goes back.
      this.baseline = siteDigests(signInStateOf(portableStateOf(await context.storageState())))
      this.last = { ...this.last, sequence: use.sequence, sealedAt: use.createdAt, applied: true }
      this.log(`sign-ins: opened copy ${use.sequence} with this machine's own key`)
      return true
    } catch (error) { this.log(`sign-ins: not applied (${error?.code || 'failed'})`); return false }
  }

  /**
   * Seals the sites that changed since a copy opened to the reviewed computers. Never throws. No copy
   * opened means nothing goes: an anonymous visit here must not reach a person's own login.
   */
  async sendBack(context) {
    if (!this.peers.length || !this.last.applied || !this.baseline) return 0
    try {
      const current = signInStateOf(portableStateOf(await context.storageState())), changed = changedSites(this.baseline, current)
      if (!changed.length) return 0
      const safe = onlySites(current, changed), sites = sitesOf(safe)
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
  dispose() { this.#key?.fill(0); this.#key = null; this.baseline = null }
}

/**
 * This machine's holder for one person and agent, or null when the machine has no
 * enrolled endpoint for them. A locked key store throws here, and the pool opens
 * the browser with no sign-ins: a needs you, never a passphrase box or a file key.
 * On a machine where the agent shares this host's OS user the holder refuses, before
 * any key or copy is read, and any copy kept here goes.
 */
export async function loadMachineSignIns({ agentRoot, pairing, assistantId, principal, environment = process.env, keyStore, log = () => {}, sharesUser = agentSharesHostUser }) {
  if (!pairing?.token || !principal?.startsWith('user-')) return null
  const origin = new URL(pairing.backendUrl).origin, directory = path.join(agentRoot, '.browser-profile-sync', createHash('sha256').update(origin).digest('hex'))
  const check = () => true
  const shared = sharesUser({ agentRoot }) !== false
  if (shared) await dropKeptCopies(path.join(directory, 'sign-ins'))
  const rows = await new AgentProfileCompanionState({ directory: path.join(directory, 'endpoints') }).loadAll(check)
  const row = rows.find(value => value.scope.assistantId === assistantId && `user-${value.scope.actingUserId}` === principal && value.scope.pairingId === pairing.pairingId)
  if (!row) return null
  if (shared) {
    log('sign-ins: not opened: the agent runs as the same OS user as this host, so the sign-in stays on the person\'s computer')
    return REFUSED_SIGN_INS
  }
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
