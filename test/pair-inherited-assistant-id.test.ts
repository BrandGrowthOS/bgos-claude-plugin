/**
 * An agent id inherited from the shell (HOAI board row 05893eed, finding E;
 * the Helper production test on KC's MacBook, 2026-11-12).
 *
 * KC's ~/.env exports BGOS_ASSISTANT_ID=888, and the Connect script runs in a
 * login shell, so hoai-pair inherited it although Connect named the agent
 * explicitly with --assistant-id 1175. Every check after the exchange read
 * the environment: the folder pin for 1175 did not count as live safe because
 * the environment named 888, and pairing printed "NOT DONE: this host serves
 * 2 other agent(s) and this pairing is not pinned". Without the flag the same
 * value would be sent as the agent to pair, so a session could start as the
 * wrong agent.
 *
 * Pairing now takes the agent only from --assistant-id. An inherited
 * BGOS_ASSISTANT_ID is not used for anything pairing decides, and pairing says
 * that it ignored it and how to pass it explicitly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, PAIR_EXIT_CODES, writeCredentialsFile, FOLDER_PIN_FILE_NAME } from '../bin/bgos-pair.mjs'

const BACKEND = 'https://pair.test'

/** The backend's pinned identity rule: a daemon pinned to another agent than the code's is refused (409). */
function backend(codeTarget = 1175) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/integrations/pair-exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (body.intended_assistant_id != null && body.intended_assistant_id !== codeTarget) {
        return Response.json(
          {
            statusCode: 409,
            message:
              `This code was created for agent ${codeTarget} (Helper Test Mac) but the daemon is pinned to agent ${body.intended_assistant_id} (Mark). ` +
              'Nothing was paired. Get a code for the right agent, or fix --assistant-id / BGOS_ASSISTANT_ID.',
          },
          { status: 409 },
        )
      }
      return Response.json({ pairing_token: 'tok_1175', pairing_id: 283, user_id: 'user_kc' }, { status: 201 })
    }
    if (url.endsWith('/integrations/me')) {
      return Response.json({ assistants: [{ assistant_id: codeTarget, agent_route: 'claude', name: 'Helper Test Mac' }] })
    }
    return Response.json({})
  }
  return { fetchImpl, bodies }
}

/** KC's MacBook: two other agents already paired here. */
async function macHome() {
  const home = await mkdtemp(join(tmpdir(), 'oldconnect-e-'))
  const folder = join(home, '.bgos-agent', '1175-workspace')
  await mkdir(folder, { recursive: true })
  for (const id of [900, 1081]) {
    await writeCredentialsFile(join(home, '.bgos-agent', `credentials-${id}.json`), {
      backendUrl: `${BACKEND}/api/v1`,
      pairingToken: `tok_${id}`,
      pairingId: id,
      userId: 'user_kc',
      assistantId: id,
      pairedAt: new Date().toISOString(),
    })
  }
  return { home, folder }
}

async function pair(argv: string[], env: Record<string, string>, home: string, folder: string, fetchImpl: typeof fetch) {
  const output: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...values: unknown[]) => output.push(values.join(' '))
  console.error = (...values: unknown[]) => output.push(values.join(' '))
  try {
    const code = await main(argv, { env, home, cwd: folder, fetchImpl, isInteractive: () => false, bindTimeoutMs: 2_000 })
    return { code, output: output.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('E: Connect\'s --assistant-id wins over an inherited BGOS_ASSISTANT_ID, and the pairing is live safe (not "NOT DONE")', async () => {
  const { home, folder } = await macHome()
  try {
    const server = backend()
    const { code, output } = await pair(
      ['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', BACKEND],
      { BGOS_ASSISTANT_ID: '888' },
      home,
      folder,
      server.fetchImpl as typeof fetch,
    )
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.doesNotMatch(output, /NOT DONE/)
    assert.doesNotMatch(output, /REQUIRED: set BGOS_ASSISTANT_ID/)
    assert.equal(server.bodies[0].intended_assistant_id, 1175)
    assert.match(output, /ignored BGOS_ASSISTANT_ID=888/)
    assert.equal((await readFile(join(folder, FOLDER_PIN_FILE_NAME), 'utf8')).trim(), '1175')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('E: with no --assistant-id an inherited BGOS_ASSISTANT_ID is not sent as the agent to pair', async () => {
  const { home, folder } = await macHome()
  try {
    const server = backend()
    const { code, output } = await pair(
      ['BGOS-7F3A-2K', '--backend', BACKEND],
      { BGOS_ASSISTANT_ID: '888' },
      home,
      folder,
      server.fetchImpl as typeof fetch,
    )
    assert.equal(server.bodies[0].intended_assistant_id, undefined, 'the inherited 888 must not travel as the pin')
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.match(output, /ignored BGOS_ASSISTANT_ID=888/)
    assert.match(output, /--assistant-id 888/, 'it says how to pass the id explicitly')
    const written = JSON.parse(await readFile(join(home, '.bgos-agent', 'credentials-1175.json'), 'utf8'))
    assert.equal(written.assistantId, 1175)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('E: an inherited BGOS_ASSISTANT_ID that matches the flag changes nothing and needs no warning', async () => {
  const { home, folder } = await macHome()
  try {
    const server = backend()
    const { code, output } = await pair(
      ['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', BACKEND],
      { BGOS_ASSISTANT_ID: '1175' },
      home,
      folder,
      server.fetchImpl as typeof fetch,
    )
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.equal(server.bodies[0].intended_assistant_id, 1175)
    assert.doesNotMatch(output, /ignored BGOS_ASSISTANT_ID/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('E: the unsubstituted plugin placeholder is not an agent id and is not reported', async () => {
  const { home, folder } = await macHome()
  try {
    const server = backend()
    const { code, output } = await pair(
      ['BGOS-7F3A-2K', '--assistant-id', '1175', '--backend', BACKEND],
      { BGOS_ASSISTANT_ID: '${user_config.assistant_id}' },
      home,
      folder,
      server.fetchImpl as typeof fetch,
    )
    assert.equal(code, PAIR_EXIT_CODES.DONE, output)
    assert.doesNotMatch(output, /ignored BGOS_ASSISTANT_ID/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
