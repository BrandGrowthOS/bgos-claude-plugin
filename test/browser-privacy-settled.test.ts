import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const { AnswerPrivacy } = createRequire(import.meta.url)('../lib/browser-host-core/answer-privacy.js')
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('privacy proof did not finish within 2000 ms')), 2_000)
    })])
  } finally { clearTimeout(timer) }
}

// A protocol double gives the admission and proof races exact barriers. The
// companion Chromium tests exercise real frames, page text and tool replies.
function rig() {
  const client: any = new EventEmitter()
  const privacy = new AnswerPrivacy()
  const worlds = new Map<string, number>()
  let binding: string, nextContext = 0
  const controls = {
    beforeSeed: async (_frameId: string) => {},
    listeners: async () => ({ listeners: [] as { useCapture: boolean; type: string }[] }),
    released: () => {},
  }
  client.send = async (method: string, params: any = {}) => {
    if (method === 'Runtime.addBinding') binding = params.name
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'fixture-navigation' } } }
    if (method === 'Page.createIsolatedWorld') {
      const executionContextId = ++nextContext
      worlds.set(params.frameId, executionContextId)
      client.emit('Runtime.executionContextCreated', { context: { id: executionContextId, name: params.worldName, auxData: { frameId: params.frameId } } })
      client.emit('Runtime.executionContextCreated', { context: { id: ++nextContext, auxData: { frameId: params.frameId, isDefault: true } } })
      await controls.beforeSeed(params.frameId)
      return { executionContextId }
    }
    if (method === 'DOMDebugger.getEventListeners') return controls.listeners()
    if (method === 'Runtime.releaseObjectGroup') controls.released()
    if (method === 'Runtime.evaluate') return { result: { objectId: `object-${params.contextId}`, value: /\.proved\(/.test(params.expression) } }
    return {}
  }
  const main = { _id: 'main' }
  const page = {
    mainFrame: () => main,
    _connection: { toImpl: (value: any): any => value === page ? { delegate: { _mainFrameSession: { _client: client }, _sessions: new Map([['main', { _client: client }]]) } } : value },
  }
  return {
    privacy, page, controls,
    attach: (frameId: string) => client.emit('Page.frameAttached', { frameId }),
    restore: (frameId: string) => client.emit('Runtime.bindingCalled', { name: binding, executionContextId: worlds.get(frameId), payload: JSON.stringify({ kind: 'restore', language: 'en', generation: 1 }) }),
  }
}

test('the read cutoff includes work registered while admission is still becoming ready', async () => {
  const r = rig()
  const admission = Promise.withResolvers<void>(), child = Promise.withResolvers<void>()
  const admissionEntered = Promise.withResolvers<void>(), childEntered = Promise.withResolvers<void>()
  r.controls.beforeSeed = async frameId => {
    if (frameId === 'main') { admissionEntered.resolve(); await admission.promise }
    else { childEntered.resolve(); await child.promise }
  }
  let finished = false
  const watching = r.privacy.watchPersonInput(r.page).then(() => { finished = true })
  try {
    await within(admissionEntered.promise)
    r.attach('child')
    await within(childEntered.promise)
    admission.resolve()
    await turn()
    assert.equal(finished, false, 'the cutoff must be captured after ready, so this child is awaited')
    child.resolve()
    await within(watching)
  } finally { admission.resolve(); child.resolve(); await within(watching) }
})

test('a later failed frame proof is retried after the bounded wait and blocks release until checked', async () => {
  const r = rig()
  await r.privacy.watchPersonInput(r.page)
  const earlier = Promise.withResolvers<void>(), earlierEntered = Promise.withResolvers<void>()
  r.controls.beforeSeed = async frameId => { if (frameId === 'earlier') { earlierEntered.resolve(); await earlier.promise } }
  r.attach('earlier')
  await within(earlierEntered.promise)
  let finished = false
  const watching = r.privacy.watchPersonInput(r.page).then((frames: Set<string>) => { finished = true; return frames })
  const retry = Promise.withResolvers<void>(), retryEntered = Promise.withResolvers<void>()
  try {
    await turn()
    r.attach('later')
    await turn()
    const failedProof = Promise.withResolvers<void>()
    r.controls.listeners = async () => { throw new Error('synthetic transient proof failure') }
    r.controls.released = () => failedProof.resolve()
    r.restore('later')
    await within(failedProof.promise)
    await turn()
    r.controls.listeners = async () => {
      retryEntered.resolve()
      await retry.promise
      return { listeners: [{ useCapture: true, type: 'keydown' }] }
    }
    earlier.resolve()
    await within(retryEntered.promise)
    assert.equal(finished, false, 'later work must still be rechecked before the read can return')
    retry.resolve()
    assert.deepEqual(await within(watching), new Set(['later']))
    assert.equal(r.privacy.reloadRequired(r.page), true, 'the unsafe late frame must retain its privacy hold')
  } finally { earlier.resolve(); retry.resolve(); await within(watching) }
})
