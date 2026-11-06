#!/usr/bin/env node
/**
 * hoai vault-host: set up this agent machine as a HOAI vault host.
 *
 *   hoai vault-host            create the host key on first use, store the
 *                              agent signing key (typed here, never echoed),
 *                              register the host with HOAI, show the host
 *                              fingerprint on THIS terminal and record the
 *                              owner's pin confirmation.
 *   hoai vault-host status     show the state and the fingerprint again.
 *   hoai vault-host --new-signing-key
 *                              replace the stored agent signing key (after the
 *                              owner rotated it); the host must be pinned again.
 *   Options: --assistant <id>  pick the agent when this folder has no pin.
 *            --state-dir <dir> use another vault host folder (tests).
 *
 * WHY A TERMINAL. The owner compares the fingerprint shown here with the one
 * HOAI shows, then pins the host in HOAI. A chat message cannot be that
 * comparison channel, because the server can rewrite it. So this command
 * refuses to run without a terminal on stdin and stderr, and it writes the
 * fingerprint only to the terminal: never to a pipe, a file, a log or chat.
 *
 * No em or en dashes in this file.
 */

import { readFileSync } from 'node:fs'
import { resolveAuth, resolveCredentialsSelection } from '../lib/agent-credentials-core.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  VaultError,
  confirmHostPin,
  hostPinStatus,
  loadOrCreateHostKey,
  provisionSigningIdentity,
  readHostRecord,
  registerHostKey,
  showFingerprintOnTerminal,
  vaultHostDir,
} from '../lib/vault-host.mjs'

const NEED_TERMINAL =
  'hoai vault-host must run in a terminal on this agent machine. The host fingerprint is shown only there, never in a pipe, a log or chat.\n'

export function parseArgs(argv) {
  const out = { command: 'setup', assistant: '', stateDir: '', newSigningKey: false, error: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--assistant') out.assistant = argv[++i] ?? ''
    else if (a === '--state-dir') out.stateDir = argv[++i] ?? ''
    else if (a === '--new-signing-key') out.newSigningKey = true
    else if (a === 'status' || a === 'setup') out.command = a
    else out.error = `unknown argument: ${a}`
  }
  return out
}

/** The paired agent's credentials: assistant id, owner, backend and pairing. */
export function resolveAgent({ assistant = '', env = process.env, cwd = process.cwd(), home = homedir() }) {
  const dir = join(home, '.bgos-agent')
  const requestedId = String(assistant || '').trim()
  const configuredId = String(env.BGOS_ASSISTANT_ID || '').trim()
  if (requestedId && (!/^\d+$/.test(requestedId) || (configuredId && configuredId !== '${user_config.assistant_id}' && configuredId !== requestedId))) {
    return { error: 'The requested assistant does not match this pairing identity.' }
  }
  const effectiveEnv = requestedId ? { ...env, BGOS_ASSISTANT_ID: requestedId } : env
  const selection = resolveCredentialsSelection({ env: effectiveEnv, cwd, defaultPath: join(dir, 'credentials.json') })
  if (selection.kind !== 'ok') return { error: 'Run this from the agent folder, or pass --assistant <id>.' }
  let creds = null
  try { creds = JSON.parse(readFileSync(selection.path, 'utf8')) } catch {}
  const auth = resolveAuth({ env: effectiveEnv, creds })
  if (auth.pairingFileRejection || (requestedId && auth.assistantId !== requestedId)) {
    return { error: 'The requested assistant does not match this pairing identity.' }
  }
  if (!auth.complete || auth.mode !== 'pairing' || !/^\d+$/.test(auth.assistantId)) {
    return { error: 'This agent is not paired on this machine. Pair it first with hoai pair.' }
  }
  const id = Number(auth.assistantId)
  if (!Number.isSafeInteger(id) || id <= 0) return { error: 'This pairing has an invalid assistant id.' }
  const base = auth.backendUrl.replace(/\/+$/, '')
  return { assistantId: id, ownerId: auth.userId, pairingToken: auth.pairingToken, apiBase: base.endsWith('/api/v1') ? base : `${base}/api/v1`, stateDir: vaultHostDir(join(dir, auth.assistantId)) }
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin
    let value = ''
    process.stderr.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const done = (answer) => {
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      process.stderr.write('\n')
      resolve(answer)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value)
        if (ch === '\u0003') return done(null)
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    input.on('data', onData)
  })
}

function askLine(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (chunk) => {
      process.stdin.pause()
      resolve(String(chunk).split(/\r?\n/)[0].trim())
    })
  })
}

const STATUS_TEXT = {
  no_identity: 'No agent signing key is stored yet.',
  unregistered: 'The host key is not registered with HOAI yet.',
  unconfirmed: 'Registered. The owner has not confirmed the pin on this machine yet.',
  pinned: 'Registered and pinned. The agent can prepare vault fills.',
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.error) {
    process.stderr.write(`[hoai vault-host] ${args.error}\n`)
    return 2
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(NEED_TERMINAL)
    return 2
  }
  const agent = resolveAgent({ assistant: args.assistant })
  if (agent.error && !args.stateDir) {
    process.stderr.write(`[hoai vault-host] ${agent.error}\n`)
    return 1
  }
  const stateDir = args.stateDir || agent.stateDir
  try {
    if (args.command === 'status') {
      const record = readHostRecord(stateDir)
      const status = hostPinStatus(record)
      process.stderr.write(`${STATUS_TEXT[status]}\n`)
      showFingerprintOnTerminal(record, process.stderr)
      return status === 'pinned' ? 0 : 1
    }
    if (agent.error) {
      process.stderr.write(`[hoai vault-host] ${agent.error}\n`)
      return 1
    }
    let record = loadOrCreateHostKey(stateDir, agent.assistantId)
    if (!record.signingSecret || args.newSigningKey) {
      process.stderr.write(
        'This agent needs its own Ed25519 signing key, minted by the owner for this agent in HOAI.\n' +
          'Paste it here (base64url PKCS8). It is not shown and is stored only in an owner-only file on this machine.\n',
      )
      const secret = await askHidden('Agent signing key: ')
      if (!secret) {
        process.stderr.write('Cancelled. Nothing was changed.\n')
        return 1
      }
      provisionSigningIdentity(stateDir, agent.assistantId, secret)
      record = readHostRecord(stateDir)
    }
    if (hostPinStatus(record) === 'unregistered') {
      await registerHostKey({ stateDir, assistantId: agent.assistantId, ownerId: agent.ownerId, apiBase: agent.apiBase, pairingToken: agent.pairingToken })
      record = readHostRecord(stateDir)
      process.stderr.write('Host key registered with HOAI.\n')
    }
    showFingerprintOnTerminal(record, process.stderr)
    if (hostPinStatus(record) === 'pinned') {
      process.stderr.write(`${STATUS_TEXT.pinned}\n`)
      return 0
    }
    process.stderr.write('In HOAI, open this agent\'s vault, compare the host fingerprint with the one above, and pin this host only if they match.\n')
    const answer = await askLine('Type PINNED once you have done that (anything else stops here): ')
    if (answer !== 'PINNED') {
      process.stderr.write('Not confirmed. Run hoai vault-host again after you pinned the host.\n')
      return 1
    }
    confirmHostPin(stateDir)
    process.stderr.write(`${STATUS_TEXT.pinned}\n`)
    return 0
  } catch (error) {
    const code = error instanceof VaultError ? error.code : 'VAULT_UNAVAILABLE'
    process.stderr.write(`[hoai vault-host] ${error instanceof VaultError ? error.message : `${code}: unexpected failure`}\n`)
    return 1
  }
}

const invokedDirectly = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith('hoai-vault-host.mjs') } catch { return false }
})()
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code })
}
