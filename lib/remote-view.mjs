import { randomUUID } from 'node:crypto'
import { RemoteOwnerInput } from './remote-input.mjs'
import { RemoteCredentials } from './remote-credentials.mjs'

export const REMOTE_VIEW_FRAME_MAX_BYTES = 1024 * 1024
export const REMOTE_VIEW_COMMAND_MAX_BYTES = 16 * 1024
const READ_METHODS = new Set(['Page.startScreencast', 'Page.stopScreencast'])
const INPUT_METHODS = new Set(['hoai.input.acquire', 'hoai.input.release', 'hoai.input.focus', 'hoai.input.pointer', 'hoai.input.key'])
const CREDENTIAL_METHODS = new Set(['hoai.credentials.prepare', 'hoai.credentials.commit', 'hoai.credentials.save', 'hoai.credentials.cancel'])
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const principal = value => typeof value === 'string' && /^user-[^\s\x00-\x1f\x7f]{1,251}$/.test(value)
const requestId = value => (Number.isSafeInteger(value) && value >= 0) || identifier(value)
const bytes = value => Buffer.byteLength(JSON.stringify(value))

/** A viewer attaches only to an existing pool slot and never owns its browser. */
export class RemoteBrowserViews {
  constructor({ pool }) {
    this.pool = pool
    this.views = new Map()
    this.bySlot = new Map()
    this.identities = new WeakMap()
    this.input = new RemoteOwnerInput({
      current: view => this._current(view) ? this.pool.peek(view.context) : null,
      credentialPointer: (view, input) => this.credentials.pointer(view, input),
      revoked: view => { this.credentials.clearSubmit(view); this._send(view, { method: 'hoai.input.revoked', params: {}, sessionId: view.sessionId, tabId: view.tabId }) },
    })
    this.credentials = new RemoteCredentials({
      current: view => this._current(view) ? this.pool.peek(view.context) : null,
      storageFor: view => view.engine.vault,
      revoked: view => this._send(view, { method: 'hoai.credentials.revoked', params: {}, sessionId: view.sessionId, tabId: view.tabId }),
    })
  }

  async open(input, { connectionId, sendFrame, sendClose }) {
    if (!identifier(input?.viewId) || !Number.isSafeInteger(input?.assistantId) || input.assistantId <= 0 ||
        !principal(input?.principal) || typeof connectionId !== 'string' || !connectionId) return false
    const context = { assistantId: input.assistantId, principal: input.principal }
    const slot = this.pool.peek(context)
    const page = slot?.engine?.pages().at(-1)
    if (!slot || !page || page.isClosed()) {
      sendClose({ viewId: input.viewId, reason: 'no_session' })
      return false
    }
    // Duplicate opens cannot replace another connection's binding.
    if (this.views.has(input.viewId)) return false
    const slotKey = this.pool.slotKey(context)
    const previous = this.bySlot.get(slotKey)
    if (previous) void this.close(previous.viewId, previous.connectionId, 'viewer_replaced')
    let identity = this.identities.get(slot.engine)
    if (!identity) {
      identity = { sessionId: `remote_${randomUUID()}`, tabs: new WeakMap() }
      this.identities.set(slot.engine, identity)
    }
    let tabId = identity.tabs.get(page)
    if (!tabId) { tabId = `tab_${randomUUID()}`; identity.tabs.set(page, tabId) }
    const view = { viewId: input.viewId, connectionId, context, slotKey, engine: slot.engine, page,
      sessionId: identity.sessionId, tabId, sendFrame, sendClose, cdp: null,
      closed: false, pendingFrame: null, latestFrame: null, queued: 0, tail: Promise.resolve() }
    // Reserve before attaching: a second open or disconnect can revoke startup.
    this.views.set(view.viewId, view)
    this.bySlot.set(slotKey, view)
    view.onGone = () => { void this.close(view.viewId, connectionId, 'remote_target_gone') }
    view.onNavigation = frame => { if (frame === page.mainFrame()) { this.input.release(view); void this.credentials.close(view) } }
    page.on('close', view.onGone)
    page.on('crash', view.onGone)
    page.on('framenavigated', view.onNavigation)
    try {
      view.cdp = await page.context().newCDPSession(page)
      if (!this._current(view)) { await this._detach(view); return false }
      view.onFrame = frame => this._frame(view, frame)
      view.cdp.on('Page.screencastFrame', view.onFrame)
      const metrics = await view.cdp.send('Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport || metrics.visualViewport || page.viewportSize() || {}
      const width = viewport.clientWidth || viewport.width || 1280
      const height = viewport.clientHeight || viewport.height || 720
      view.width = width
      view.height = height
      const title = await page.title().catch(() => '')
      if (!this._current(view)) { await this.close(view.viewId, connectionId, 'remote_target_gone'); return false }
      return this._send(view, { method: 'hoai.ready', params: { sessionId: view.sessionId, tabId,
        title: title.slice(0, 512), url: page.url().slice(0, 8192), width, height, remoteInput: true,
        ...(slot.engine.vault ? { remoteCredentials: true } : {}) } })
    } catch {
      await this.close(view.viewId, connectionId, 'view_start_failed')
      return false
    }
  }

  _current(view) {
    return !view.closed && this.views.get(view.viewId) === view &&
      this.pool.peek(view.context)?.engine === view.engine && !view.page.isClosed() &&
      view.engine.pages().includes(view.page)
  }

  _send(view, frame) {
    if (!this._current(view)) return false
    const message = { viewId: view.viewId, frame }
    if (bytes(message) > REMOTE_VIEW_FRAME_MAX_BYTES) return false
    return view.sendFrame(message) !== false
  }

  _frame(view, frame) {
    if (!this._current(view) || !Number.isSafeInteger(frame?.sessionId) || typeof frame?.data !== 'string') return
    if (bytes({ viewId: view.viewId, frame: { method: 'Page.screencastFrame', params: frame,
      sessionId: view.sessionId, tabId: view.tabId } }) > REMOTE_VIEW_FRAME_MAX_BYTES) {
      void view.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      return
    }
    // Keep one bounded latest frame while the owner paints. Dropping every
    // newer frame would leave a final static page change invisible forever.
    if (view.pendingFrame !== null) {
      if (view.latestFrame) void view.cdp.send('Page.screencastFrameAck', { sessionId: view.latestFrame.sessionId }).catch(() => {})
      view.latestFrame = frame
      return
    }
    view.pendingFrame = frame.sessionId
    const sent = this._send(view, { method: 'Page.screencastFrame', params: frame,
      sessionId: view.sessionId, tabId: view.tabId })
    if (!sent) {
      view.pendingFrame = null
      void view.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    }
  }

  async command(input, connectionId) {
    const view = this.views.get(input?.viewId)
    const frame = input?.frame
    if (!view || view.connectionId !== connectionId || !this._current(view) || !frame ||
        bytes(input) > REMOTE_VIEW_COMMAND_MAX_BYTES || frame.sessionId !== view.sessionId || frame.tabId !== view.tabId) return false
    // Paint acknowledgement is an event and bypasses the command chain.
    if (frame.method === 'Page.screencastFrameAck') {
      if (frame.id !== undefined || !Number.isSafeInteger(frame.params?.sessionId) ||
          frame.params.sessionId !== view.pendingFrame) return false
      try {
        await view.cdp.send('Page.screencastFrameAck', { sessionId: frame.params.sessionId })
        const latest = view.latestFrame
        view.latestFrame = null
        view.pendingFrame = null
        if (latest && this._current(view)) this._frame(view, latest)
        return true
      }
      catch { await this.close(view.viewId, connectionId, 'remote_target_gone'); return false }
    }
    if (!requestId(frame.id)) return false
    const reply = body => this._send(view, { id: frame.id, ...body, sessionId: view.sessionId, tabId: view.tabId })
    if (!READ_METHODS.has(frame.method) && !INPUT_METHODS.has(frame.method) && !CREDENTIAL_METHODS.has(frame.method)) {
      reply({ error: { code: 'view_read_only', message: 'This remote view accepts display commands only.' } })
      return false
    }
    if (view.queued >= 8) {
      reply({ error: { code: 'view_busy', message: 'The remote display command queue is full.' } })
      return false
    }
    view.queued++
    const run = async () => {
      try {
        if (!this._current(view)) return false
        if (CREDENTIAL_METHODS.has(frame.method)) {
          const operation = frame.method.slice('hoai.credentials.'.length)
          reply({ result: await this.credentials[operation](view, frame.params || {}) })
          return true
        }
        if (INPUT_METHODS.has(frame.method)) {
          const operation = frame.method.slice('hoai.input.'.length)
          const result = operation === 'release'
            ? this.input.release(view, frame.params?.leaseId)
            : await this.input[operation](view, frame.params || {})
          reply({ result })
          return true
        }
        // The host owns capture bounds. Renderer supplied CDP parameters do
        // not get to allocate unbounded images or request another format.
        const params = frame.method === 'Page.startScreencast'
          ? { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 } : {}
        const result = await view.cdp.send(frame.method, params)
        if (frame.method === 'Page.stopScreencast') { view.pendingFrame = null; view.latestFrame = null }
        reply({ result: result || {} })
        return true
      } catch (error) {
        reply({ error: { code: error?.code || 'view_command_failed', message: 'The remote browser command was refused or failed.' } })
        return false
      } finally { view.queued-- }
    }
    const work = view.tail.then(run, run)
    view.tail = work.then(() => {}, () => {})
    return work
  }

  async close(viewId, connectionId, reason = 'viewer_closed') {
    const view = this.views.get(viewId)
    if (!view || view.connectionId !== connectionId) return false
    this.input.release(view)
    void this.credentials.close(view)
    view.closed = true
    this.views.delete(viewId)
    if (this.bySlot.get(view.slotKey) === view) this.bySlot.delete(view.slotKey)
    view.page.off('close', view.onGone)
    view.page.off('crash', view.onGone)
    view.page.off('framenavigated', view.onNavigation)
    view.sendClose({ viewId, reason })
    await this._detach(view)
    return true
  }

  async _detach(view) {
    await this.input.drain(view)
    await this.credentials.drain(view)
    const cdp = view.cdp
    view.cdp = null
    if (!cdp) return
    if (view.onFrame) cdp.off('Page.screencastFrame', view.onFrame)
    try { await cdp.send('Page.stopScreencast') } catch {}
    try { await cdp.detach() } catch {}
  }

  async closeConnection(connectionId) {
    await Promise.all([...this.views.values()].filter(view => view.connectionId === connectionId)
      .map(view => this.close(view.viewId, connectionId, 'host_disconnected')))
  }

  async stop() {
    await Promise.all([...this.views.values()].map(view => this.close(view.viewId, view.connectionId, 'host_stopped')))
  }
}
