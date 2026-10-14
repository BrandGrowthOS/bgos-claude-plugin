// Disposable mounted-backend fixture child. Generated keys and pairing token
// arrive only through bounded stdin. Socket exchanges use IPC, never argv.
import { createPrivateKey } from 'node:crypto'
import { PairedProfileCoordinatorClient, createPairedProfileRuntimeEndpoint } from '../lib/browser-profile-pairing-client.mjs'

const LIMIT = 128 * 1024, exchanges = new Map(), requests = [], inputChunks = []
let sequence = 0, runtime, wake, current = true, timer, size = 0
const hint = new Promise(resolve => { wake = resolve })
const diagnostic = error => typeof error?.code === 'string' && /^profile_[a-z0-9_]{1,79}$/.test(error.code) ? error.code : 'profile_pairing_probe_failed'
const exchange = (event, body) => new Promise((resolve, reject) => {
  if (exchanges.size >= 16 || !process.connected) return reject(new Error('fixture_exchange_unavailable'))
  const id = ++sequence; exchanges.set(id, resolve); process.send({ type: 'exchange', id, event, body })
})
process.on('message', message => {
  if (!message || typeof message !== 'object' || Buffer.byteLength(JSON.stringify(message)) > LIMIT) return
  if (message.type === 'reply' && Number.isSafeInteger(message.id)) { const done = exchanges.get(message.id); exchanges.delete(message.id); done?.(message.reply) }
  else if (message.type === 'run') wake(message.hint)
  else if (message.type === 'withdraw') { current = false; runtime?.disconnect() }
})
try {
  if (!process.send) throw new Error('fixture_ipc_required')
  timer = setTimeout(() => { process.stderr.write('profile_pairing_probe_timeout'); process.exit(1) }, 25000)
  for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT) throw new Error('fixture_input_oversized'); inputChunks.push(chunk) }
  const bytes = Buffer.concat(inputChunks), input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); bytes.fill(0); for (const chunk of inputChunks) chunk.fill(0)
  const endpoint = { identity: input.endpoint.identity,
    signingPrivateKey: createPrivateKey({ key: Buffer.from(input.endpoint.signingPrivateKey, 'base64url'), format: 'der', type: 'pkcs8' }),
    encryptionPrivateKey: createPrivateKey({ key: Buffer.from(input.endpoint.encryptionPrivateKey, 'base64url'), format: 'der', type: 'pkcs8' }) }
  const assertCurrent = () => { if (!current) throw new Error('fixture_pairing_changed') }
  const client = new PairedProfileCoordinatorClient({ endpoint: input.origin, authorizePairing: async scope => {
    assertCurrent(); if (scope.assistantId !== input.authority.assistantId || scope.actingUserId !== input.authority.actingUserId) throw new Error('fixture_scope_changed')
    return { pairingId: input.pairing.id, ownerUserId: input.pairing.ownerUserId, assistantId: input.authority.assistantId, token: input.pairing.token, assertCurrent }
  }, fetchImpl: async (url, options) => {
    if (requests.length >= 16) throw new Error('fixture_request_limit')
    requests.push({ path: new URL(url).pathname, actorHeader: options.headers['X-BGOS-Acting-User'] || null, pairingHeader: options.headers['X-BGOS-Pairing'] === input.pairing.token, mixedPrincipal: !!(options.headers.Authorization || options.headers['X-API-Key']) })
    return fetch(url, options)
  } })
  if (input.mode === 'caller-refusal') {
    let refusal
    try { await client.call(input.authority, { clientId: 'fixture-refusal', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } }, waitMs: 0 }) }
    catch (error) { if (error.statusCode !== 403) throw error; refusal = { refused: true, statusCode: error.statusCode, code: diagnostic(error), requests } }
    if (!refusal) throw new Error('fixture_foreign_actor_was_admitted')
    process.stdout.write(JSON.stringify(refusal)); process.disconnect()
  } else {
  let executions = 0, frame
  runtime = createPairedProfileRuntimeEndpoint({ authority: input.authority, endpoint, client, assertCurrent, execute: async value => {
    executions++; frame = value.frame
    return { ok: true, message: { jsonrpc: '2.0', id: frame.message.id, result: { text: 'Synthetic paired agent fixture', tool: frame.message.params?.name || null } } }
  } })
  const binding = await runtime.prove({ socketId: input.socketId, exchange }); process.send({ type: 'ready', binding })
  const received = await hint, cancellation = await client.cancellation(input.authority, endpoint, received)
  const outcome = await runtime.receive({ ...received, message: { jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'renderer_forgery' } } })
  if (executions !== 1 || !frame || outcome.completionAccepted !== true) throw new Error('fixture_execution_not_confirmed')
  const scope = { rpcId: received.rpcId, clientId: frame.clientId, waitMs: 0 }
  const polled = await client.poll(input.authority, scope)
  // Explicit known-completed fixture replay checks server deduplication. This
  // is not the client's retry policy and must not dispatch a second command.
  const duplicateCall = await client.call(input.authority, { clientId: frame.clientId, message: frame.message, waitMs: 0 })
  const cancelAfter = await client.cancel(input.authority, scope)
  await runtime.close(); runtime = null
  const summary = { bindingId: binding.bindingId, outcome, cancellation, executions, tool: frame.message.params?.name || null, polled: polled.status, duplicateCall: duplicateCall.status, cancelAfter: cancelAfter.requested, requests }
  const output = JSON.stringify(summary); if (Buffer.byteLength(output) > 16 * 1024) throw new Error('fixture_output_oversized')
  process.stdout.write(output); process.disconnect()
  }
} catch (error) { process.stderr.write(diagnostic(error)); process.exitCode = 1; if (process.connected) process.disconnect() }
finally { clearTimeout(timer); for (const chunk of inputChunks) chunk.fill(0); if (runtime) await runtime.close().catch(() => {}) }
