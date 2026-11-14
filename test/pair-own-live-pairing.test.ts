/**
 * Retry after a failed Connect (HOAI board row 05893eed, finding C; the
 * Helper production test on KC's MacBook, 2026-11-12).
 *
 * The first Connect paired the computer (pairing 283) and then failed at
 * Verifying. Retry minted a new code and ran pairing again, and the backend
 * refused it: "Helper Test Mac (agent 1175) is already served by live pairing
 * 283 (Mac (Claude Code)) ... retry in ~10 minutes". Pairing 283 was this
 * computer's own, made a minute earlier for the same agent, and its token was
 * on disk in credentials-1175.json. Nothing else was serving the agent.
 *
 * Pairing now recognises its own pairing in that refusal: the pairing the
 * refusal names is the one in this computer's credentials file for the same
 * agent and the same backend, and its token still answers for that agent.
 * Then it revokes that pairing with its own token (the backend lets a pairing
 * revoke itself) and exchanges the same code once more. A refusal that names
 * any other pairing, or a token that no longer answers, is left exactly as
 * before: nothing is revoked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  main,
  PAIR_EXIT_CODES,
  parseLivePairingRefusal,
  readOwnPairing,
  writeCredentialsFile,
} from '../bin/bgos-pair.mjs'

const BACKEND = 'https://pair.test'
const API = 'https://pair.test/api/v1'

function refusal(pairingIds: number[], agentId = 1175, name = 'Helper Test Mac') {
  const labels = pairingIds.map((id) => `${id} (Mac (Claude Code))`).join(', ')
  const ids = pairingIds.join(', ')
  return {
    statusCode: 409,
    error: 'Conflict',
    message:
      `Pairing refused: ${name} (agent ${agentId}) is already served by live pairing${pairingIds.length > 1 ? 's' : ''} ${labels}. ` +
      `Revoke pairing ${ids} in BGOS (or stop that daemon and retry in ~10 minutes) before pairing this machine.`,
  }
}

type Seen = { method: string, url: string, pairing: string | null }

/**
 * A fake backend with the real refusal rule: an exchange for agent 1175 is
 * refused while pairing 283 is active, and DELETE /integrations/pairings/283
 * with 283's own token revokes it.
 */
function backend(opts: { liveIds?: number[], refusalAgent?: number, ownTokenAnswers?: boolean, refuseForever?: boolean, ownTokenAgent?: number, deleteStatus?: number } = {}) {
  const seen: Seen[] = []
  let revoked = false
  const liveIds = opts.liveIds ?? [283]
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET')
    const headers = (init?.headers ?? {}) as Record<string, string>
    const pairing = headers['X-BGOS-Pairing'] ?? null
    seen.push({ method, url, pairing })
    if (url === `${API}/integrations/pair-exchange`) {
      if ((!revoked || opts.refuseForever) && liveIds.length > 0) {
        return Response.json(refusal(liveIds, opts.refusalAgent ?? 1175), { status: 409 })
      }
      return Response.json({ pairing_token: 'second_token', pairing_id: 284, user_id: 'user_kc' }, { status: 201 })
    }
    if (url === `${API}/integrations/me`) {
      if (pairing === 'first_token') {
        if (revoked || opts.ownTokenAnswers === false) return Response.json({ message: 'Invalid pairing token' }, { status: 401 })
        return Response.json({ assistants: [{ assistant_id: opts.ownTokenAgent ?? 1175, agent_route: 'claude', name: 'Helper Test Mac' }] })
      }
      return Response.json({ assistants: [{ assistant_id: 1175, agent_route: 'claude', name: 'Helper Test Mac' }] })
    }
    if (method === 'DELETE' && url === `${API}/integrations/pairings/283`) {
      if (pairing !== 'first_token') return Response.json({ message: 'Forbidden' }, { status: 403 })
      if (opts.deleteStatus) return Response.json({ message: 'refused' }, { status: opts.deleteStatus })
      revoked = true
      return new Response(null, { status: 204 })
    }
    return Response.json({})
  }
  return { fetchImpl, seen, wasRevoked: () => revoked }
}

async function homeWithFirstAttempt(opts: { assistantId?: number, backendUrl?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-c-'))
  const folder = join(home, '.bgos-agent', '1175-workspace')
  await mkdir(folder, { recursive: true })
  const assistantId = opts.assistantId ?? 1175
  await writeCredentialsFile(join(home, '.bgos-agent', `credentials-${assistantId}.json`), {
    backendUrl: opts.backendUrl ?? API,
    pairingToken: 'first_token',
    pairingId: 283,
    userId: 'user_kc',
    assistantId,
    pairedAt: new Date(Date.now() - 60_000).toISOString(),
  })
  return { home, folder }
}

async function pair(home: string, folder: string, fetchImpl: typeof fetch, argv = ['BGOS-RETRY-01', '--assistant-id', '1175', '--backend', BACKEND]) {
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...values: unknown[]) => output.push(values.join(' '))
  console.error = (...values: unknown[]) => output.push(values.join(' '))
  try {
    const code = await main(argv, { env: {}, home, cwd: folder, fetchImpl, isInteractive: () => false, bindTimeoutMs: 2_000 })
    return { code, output: output.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

const exchanges = (seen: Seen[]) => seen.filter((s) => s.url.endsWith('/integrations/pair-exchange')).length
const deletes = (seen: Seen[]) => seen.filter((s) => s.method === 'DELETE')

test('parseLivePairingRefusal reads the agent and the pairing ids out of the backend refusal, and nothing else', () => {
  assert.deepEqual(parseLivePairingRefusal(409, refusal([283])), { agentId: '1175', pairingIds: [283] })
  assert.deepEqual(parseLivePairingRefusal(409, refusal([283, 290])), { agentId: '1175', pairingIds: [283, 290] })
  // A device label with digits and brackets in it does not leak into the ids.
  const tricky = refusal([283])
  tricky.message = tricky.message.replace('Mac (Claude Code)', 'Mac 2 (agent 9) (Claude Code)')
  assert.deepEqual(parseLivePairingRefusal(409, tricky), { agentId: '1175', pairingIds: [283] })
  // Not a 409, not this refusal, or the unpinned catalog refusal: null.
  assert.equal(parseLivePairingRefusal(400, refusal([283])), null)
  assert.equal(parseLivePairingRefusal(409, { message: 'Pair code already consumed' }), null)
  assert.equal(
    parseLivePairingRefusal(409, {
      message: 'Pairing refused: agents on this catalog are already served by live pairing 283 (Mac). Revoke pairing 283 in BGOS (or stop that daemon and retry in ~10 minutes) before pairing this machine.',
    }),
    null,
  )
  assert.equal(parseLivePairingRefusal(409, null), null)
})

test('C: a Retry by the same computer for the same agent replaces its own fresh pairing instead of waiting 10 minutes', async () => {
  const { home, folder } = await homeWithFirstAttempt()
  try {
    const server = backend()
    const { code, output } = await pair(home, folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.equal(server.wasRevoked(), true)
    const removed = deletes(server.seen)
    assert.equal(removed.length, 1)
    assert.equal(removed[0].pairing, 'first_token', 'the pairing is revoked with its own token, never an account credential')
    assert.equal(exchanges(server.seen), 2, 'the same code is exchanged once more, once')
    assert.match(output, /pairing 283 is this computer's own pairing for agent 1175/)
    assert.match(output, /stays cut off until it restarts \(hoai-agent restart --assistant 1175\)/)
    const written = JSON.parse(await readFile(join(home, '.bgos-agent', 'credentials-1175.json'), 'utf8'))
    assert.equal(written.pairingId, 284)
    assert.equal(written.pairingToken, 'second_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('C: a refusal that names a pairing this computer does not hold revokes nothing', async () => {
  const { home, folder } = await homeWithFirstAttempt()
  try {
    const server = backend({ liveIds: [999] })
    const { code, output } = await pair(home, folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED, output)
    assert.deepEqual(deletes(server.seen), [])
    assert.equal(exchanges(server.seen), 1)
    assert.match(output, /already served by live pairing 999/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('C: a refusal for another agent, or own credentials for another agent, revokes nothing', async () => {
  const other = await homeWithFirstAttempt({ assistantId: 900 })
  try {
    const server = backend()
    const { code } = await pair(other.home, other.folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.deepEqual(deletes(server.seen), [])
  } finally {
    await rm(other.home, { recursive: true, force: true })
  }
  const mismatch = await homeWithFirstAttempt()
  try {
    const server = backend({ refusalAgent: 900 })
    const { code } = await pair(mismatch.home, mismatch.folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.deepEqual(deletes(server.seen), [])
  } finally {
    await rm(mismatch.home, { recursive: true, force: true })
  }
})

test('C: own credentials for a different backend, or a token that no longer answers, revoke nothing', async () => {
  const elsewhere = await homeWithFirstAttempt({ backendUrl: 'https://other.test/api/v1' })
  try {
    const server = backend()
    const { code } = await pair(elsewhere.home, elsewhere.folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.deepEqual(deletes(server.seen), [])
  } finally {
    await rm(elsewhere.home, { recursive: true, force: true })
  }
  const dead = await homeWithFirstAttempt()
  try {
    const server = backend({ ownTokenAnswers: false })
    const { code } = await pair(dead.home, dead.folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.deepEqual(deletes(server.seen), [])
  } finally {
    await rm(dead.home, { recursive: true, force: true })
  }
})

test('C: the replacement is tried once: a second refusal is reported, not looped on', async () => {
  const { home, folder } = await homeWithFirstAttempt()
  try {
    const server = backend({ refuseForever: true })
    const { code, output } = await pair(home, folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED, output)
    assert.equal(deletes(server.seen).length, 1)
    assert.equal(exchanges(server.seen), 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('C: with no --assistant-id the code\'s own agent, named in the refusal, is the one compared', async () => {
  const { home, folder } = await homeWithFirstAttempt()
  try {
    const server = backend()
    const { code, output } = await pair(home, folder, server.fetchImpl as typeof fetch, ['BGOS-RETRY-01', '--backend', BACKEND])
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.equal(deletes(server.seen).length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── Round 2 (Data's review of bcfd4699) ─────────────────────────────────────

test('C, finding 3: a refused DELETE is not a replacement: no second exchange and no "is revoked" line', async () => {
  const { home, folder } = await homeWithFirstAttempt()
  try {
    const server = backend({ deleteStatus: 403 })
    const { code, output } = await pair(home, folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED, output)
    assert.equal(deletes(server.seen).length, 1)
    assert.equal(exchanges(server.seen), 1, 'the code is not exchanged again after a refused revoke')
    assert.doesNotMatch(output, /is revoked|revoked it with its own token/)
    assert.match(output, /already served by live pairing 283/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('C, finding 5: the pairing ids come from the closing clause only, so a device label cannot put one in', () => {
  const body = refusal([300])
  // A label written to look like the closing clause, before the real one.
  body.message = body.message.replace(
    '300 (Mac (Claude Code))',
    '300 (x Revoke pairing 283 in BGOS (or stop that daemon and retry in ~10 minutes) before pairing this machine.)',
  )
  assert.deepEqual(parseLivePairingRefusal(409, body)?.pairingIds, [300])
})

test('C, finding 7: a refusal for another agent than --assistant-id revokes nothing, even when this computer holds that agent\'s pairing', async () => {
  // credentials-900.json holds pairing 283, its token answers for 900, and
  // the refusal names agent 900: a pairing run for 1175 must leave it alone.
  const { home, folder } = await homeWithFirstAttempt({ assistantId: 900 })
  try {
    const server = backend({ refusalAgent: 900, ownTokenAgent: 900 })
    const { code } = await pair(home, folder, server.fetchImpl as typeof fetch)
    assert.equal(code, PAIR_EXIT_CODES.SERVER_REFUSED)
    assert.deepEqual(deletes(server.seen), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('C, finding 7: readOwnPairing never returns a file that names another agent (the shared credentials.json included)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-c7-'))
  try {
    const creds = (assistantId: number, pairingId: number) => ({
      backendUrl: API, pairingToken: `tok_${pairingId}`, pairingId, userId: 'user_kc', assistantId, pairedAt: new Date().toISOString(),
    })
    await writeCredentialsFile(join(home, '.bgos-agent', 'credentials.json'), creds(900, 38))
    assert.equal(readOwnPairing({ home, assistantId: '1175', apiBase: API }), null)
    // A per-agent file whose content names another agent is not that agent's.
    await writeCredentialsFile(join(home, '.bgos-agent', 'credentials-1175.json'), creds(900, 283))
    assert.equal(readOwnPairing({ home, assistantId: '1175', apiBase: API }), null)
    await writeCredentialsFile(join(home, '.bgos-agent', 'credentials-1175.json'), creds(1175, 283))
    assert.equal(readOwnPairing({ home, assistantId: '1175', apiBase: API })?.pairingId, 283)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
