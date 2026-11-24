/**
 * vault-host-auto: the agent vault with no setup, this machine's half
 * (HOAI design 2026-11-12, CORE-CONTRACTS 18.8).
 *
 * WHAT IT DOES. With no terminal, no pasted key and no question:
 *   1. Asks the server whether it takes host offers (GET .../host-offer). A
 *      404 means the feature is off there and nothing more happens: no key is
 *      made, and the older `hoai vault-host` flow stands as it was.
 *   2. Makes this machine's keys if it has none: the existing host key
 *      (lib/vault-host.mjs loadOrCreateHostKey, owner-only file, Windows ACL
 *      checked before any key is written) and its OWN Ed25519 agent identity,
 *      generated here. Nobody mints a private key on the server and pastes it.
 *   3. Offers the PUBLIC halves with the unchanged host key proof
 *      (POST .../host-offer {identityPublic, publicKey, keySignature}) under
 *      the pairing credential. No BGOS-A2A headers: the identity is not
 *      installed until the owner's app accepts it.
 *   4. Records its registration and pin only when the server names THESE keys
 *      as the installed host. A server that says "installed" for other keys
 *      changes nothing here.
 *
 * WHAT IT NEVER DOES. It never shows, logs or returns a fingerprint, a key or
 * the pairing credential; the log gets fixed words and codes only. It never
 * keeps a key file another account could read: that file is removed and a
 * fresh key made, which the owner then sees as "this computer changed". It
 * never runs from a tool input: the daemon calls it when it arms, on the
 * server's `vault_host_setup` frame and on a vault tool's first use.
 *
 * Plain JavaScript, node builtins only, so the daemon (bun) and the terminal
 * command (node) share it. No em or en dashes in this file.
 */

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import {
  VAULT_HOST_FILE_NAME,
  VaultError,
  hostKeyExposure,
  hostPinStatus,
  loadOrCreateHostKey,
  provisionSigningIdentity,
  readHostRecord,
  tightenHostDir,
  writeHostRecord,
} from './vault-host.mjs'

/** The frame the server sends to this daemon's pairing room: ids and a status. */
export const VAULT_HOST_SETUP_FRAME = 'vault_host_setup'

const REQUEST_TIMEOUT_MS = 15_000
const RESPONSE_MAX_CHARS = 16_384
const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])
/** The fixed codes the owner's app can read. Never a path or a value. */
const PROBLEM_CODES = { VAULT_HOST_KEY_EXPOSED: 'key_exposed', VAULT_HOST_KEY_INVALID: 'key_invalid' }

/** HOAI_VAULT_AUTO_HOST=0 (or false, off, no) keeps this machine out of it. */
export function vaultAutoHostDisabled(env = process.env) {
  return OFF_VALUES.has(String(env?.HOAI_VAULT_AUTO_HOST ?? '').trim().toLowerCase())
}

/** One call under the pairing credential. Returns the HTTP status and parsed JSON. */
async function offerCall({ method, apiBase, assistantId, sub = '', body, pairingToken, fetch }) {
  const base = String(apiBase).replace(/\/+$/, '')
  const text = body === undefined ? undefined : JSON.stringify(body)
  const response = await fetch(`${base}/vault/agent/${assistantId}/host-offer${sub}`, {
    method,
    headers: {
      'X-BGOS-Pairing': pairingToken,
      accept: 'application/json',
      ...(text === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(text === undefined ? {} : { body: text }),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let json = null
  if (response.ok) {
    try {
      const raw = await response.text()
      if (raw.length <= RESPONSE_MAX_CHARS) json = JSON.parse(raw)
    } catch {}
  } else {
    try { await response.body?.cancel?.() } catch {}
  }
  return { http: response.status, json }
}

/** Raised when this run cannot tell what state the key file is in. Nothing is touched. */
class CannotTell extends Error {}

/**
 * This machine's host record. A record that cannot be used is removed and a
 * fresh key made, but only when that is KNOWN and the file is this agent's:
 *   - damaged (not JSON, or keys that do not belong together): replaced;
 *   - readable by another account, read as such from the mode bits or the
 *     access list: replaced, because an exposed key is treated as taken.
 * Left alone, never deleted: a file whose protection could not be read (a slow
 * or blocked PowerShell, a file owned by another account, a link), and a file
 * that belongs to another agent.
 */
async function machineRecord(stateDir, assistantId, fs, security) {
  try {
    return await loadOrCreateHostKey(stateDir, assistantId, fs, security)
  } catch (error) {
    if (!(error instanceof VaultError) || !PROBLEM_CODES[error.code]) throw error
    if (error.code === 'VAULT_HOST_KEY_EXPOSED') {
      if ((await hostKeyExposure(stateDir, fs, security)) !== 'exposed') throw new CannotTell()
    } else if (/another agent/.test(error.message)) throw error
    try { fs.unlinkSync(join(stateDir, VAULT_HOST_FILE_NAME)) } catch {}
    await tightenHostDir(stateDir, fs, security)
    return loadOrCreateHostKey(stateDir, assistantId, fs, security)
  }
}

const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 10_000
const LOCK_BEAT_MS = 10_000
/** How often one run tries the key steps again when this computer could not check its own key file. */
const KEY_TRIES = 3
const KEY_RETRY_PAUSE_MS = 1_500

/**
 * One setup at a time for this agent on this machine, across processes (the
 * daemon, a tool call, `hoai vault-host auto`). Without it two runs can each
 * make an identity, and the one that offers last may not be the one whose
 * identity the file kept. The lock is an empty file beside the vault folder;
 * one left behind by a run that died is taken over after a minute. A run that
 * is alive touches its lock every few seconds, because on a slow Windows PC
 * one setup takes longer than that minute (57 seconds measured on a new
 * install) and a lock that only aged would be taken from under it. Returns
 * null when another run still holds it.
 */
async function withSetupLock(stateDir, fs, work, timing = {}) {
  const staleMs = timing.staleMs ?? LOCK_STALE_MS
  const waitMs = timing.waitMs ?? LOCK_WAIT_MS
  const beatMs = timing.beatMs ?? LOCK_BEAT_MS
  const lock = `${stateDir}.setup.lock`
  try { fs.mkdirSync(dirname(stateDir), { recursive: true, mode: 0o700 }) } catch {}
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      let age = 0
      try { age = Date.now() - fs.statSync(lock).mtimeMs } catch { continue }
      if (age > staleMs) { try { fs.unlinkSync(lock) } catch {} ; continue }
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, waitMs))))
    }
  }
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(lock, now, now) } catch {}
  }, beatMs)
  beat.unref?.()
  try {
    return await work()
  } finally {
    clearInterval(beat)
    try { fs.unlinkSync(lock) } catch {}
  }
}

/**
 * @param {{ stateDir: string, assistantId: number | string, ownerId: string, apiBase: string,
 *   pairingToken: string, fetch?: typeof globalThis.fetch, fs?: typeof nodeFs,
 *   security?: import('./vault-host.mjs').VaultSecurity, log?: (line: string) => void,
 *   env?: Record<string, string | undefined>, sleep?: (ms: number) => Promise<unknown>,
 *   lock?: { staleMs?: number, waitMs?: number, beatMs?: number } }} input
 * @returns {Promise<{ status: 'disabled' | 'unavailable' | 'off' | 'offered' | 'change_offered' | 'installed', retry?: true } | { status: 'problem', code: string }>}
 *   `retry: true` on 'unavailable' means this computer could not check its own key file (a PowerShell that
 *   did not answer in time): nothing is wrong and nothing was reported, and the caller should try again soon.
 */
export async function ensureAutoHost({ stateDir, assistantId, ownerId, apiBase, pairingToken, fetch = globalThis.fetch, fs = nodeFs, security, log = () => {}, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), lock }) {
  if (vaultAutoHostDisabled(env)) return { status: 'disabled' }
  const id = Number(assistantId)
  if (typeof pairingToken !== 'string' || !pairingToken.trim() || /[\r\n]/.test(pairingToken) ||
    typeof ownerId !== 'string' || !ownerId || !Number.isSafeInteger(id) || id <= 0 || !stateDir) return { status: 'unavailable' }
  const say = (line) => { try { log(`vault: ${line}`) } catch {} }
  const ask = (method, sub, body) => offerCall({ method, apiBase, assistantId: id, sub, body, pairingToken, fetch })

  // 1. Does this server take offers at all? Nothing is created until it says so.
  let probe
  try { probe = await ask('GET', '') } catch { return { status: 'unavailable' } }
  if (probe.http === 404) return { status: 'off' }
  if (probe.http !== 200) return { status: 'unavailable' }

  // Steps 2 to 4 under one lock: the keys are read, made, offered and recorded by one run at a time.
  const result = await withSetupLock(stateDir, fs, async () => {
  // 2. This machine's keys, made here.
  let record
  for (let attempt = 1; ; attempt++) {
    try {
      record = await machineRecord(stateDir, id, fs, security)
      if (!record.signingSecret || !record.identityPublic) {
        const secret = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
        await provisionSigningIdentity(stateDir, id, secret, fs, security)
        record = await readHostRecord(stateDir, fs, security)
      }
      break
    } catch (error) {
      // "Exposed" is also what a check that could not RUN says (found on a real Windows PC: a PowerShell that
      // took longer than its limit while the identity was being stored). Only a protection that was read and
      // does name someone else is an exposed key; anything else is "cannot tell".
      let cannotTell = error instanceof CannotTell
      if (!cannotTell && error instanceof VaultError && error.code === 'VAULT_HOST_KEY_EXPOSED') {
        cannotTell = (await hostKeyExposure(stateDir, fs, security)) !== 'exposed'
      }
      if (cannotTell) {
        // The key file is left as it is, nothing is reported, and the steps are tried again: here, then by the caller.
        if (attempt < KEY_TRIES) { await sleep(attempt * KEY_RETRY_PAUSE_MS); continue }
        return { status: 'unavailable', retry: true }
      }
      const code = error instanceof VaultError ? (PROBLEM_CODES[error.code] ?? 'storage_failed') : 'storage_failed'
      try { await ask('POST', '/problem', { code }) } catch {}
      say(`this computer could not set up its vault key (${code})`)
      return { status: 'problem', code }
    }
  }

  // 3. Offer the public halves with the independent host key proof.
  const mine = { identityPublic: record.identityPublic, publicKey: record.publicKey }
  let keySignature
  try {
    keySignature = sign(
      null,
      Buffer.from(JSON.stringify(['hoai-vault-host-key-v1', ownerId, id, record.publicKey])),
      createPrivateKey({ key: Buffer.from(record.signingSecret, 'base64url'), format: 'der', type: 'pkcs8' }),
    ).toString('base64url')
  } catch {
    return { status: 'problem', code: 'key_invalid' }
  }
  let answer
  try { answer = await ask('POST', '', { ...mine, keySignature }) } catch { return { status: 'unavailable' } }
  if (answer.http === 404) return { status: 'off' }
  if (answer.http < 200 || answer.http >= 300 || !answer.json) return { status: 'unavailable' }

  // 4. Pinned only when the server names THESE keys as the installed host.
  const installed = answer.json.installed
  const isMine = answer.json.status === 'installed' && installed &&
    installed.identityPublic === mine.identityPublic && installed.publicKey === mine.publicKey
  if (isMine) {
    if (hostPinStatus(record) !== 'pinned') {
      const at = new Date().toISOString()
      await writeHostRecord(stateDir, {
        ...record,
        registration: { ...mine, ownerId, at },
        pin: { ...mine, at, auto: true },
      }, fs, security)
      say('this computer is set up for the vault')
    }
    return { status: 'installed' }
  }
  // Not the installed host: never keep a pin the server no longer backs.
  if (record.registration || record.pin) {
    const next = { ...record }
    delete next.registration
    delete next.pin
    await writeHostRecord(stateDir, next, fs, security)
  }
  const status = answer.json.status === 'change_offered' ? 'change_offered' : 'offered'
  say(status === 'offered' ? 'this computer offered its vault key' : 'this computer offered a new vault key; the owner decides in HOAI')
  return { status }
  }, lock)
  return result ?? { status: 'unavailable' }
}
