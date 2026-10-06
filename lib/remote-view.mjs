import { randomUUID } from 'node:crypto'
import { RemoteOwnerInput } from './remote-input.mjs'
import { RemoteCredentials } from './remote-credentials.mjs'

export const REMOTE_VIEW_FRAME_MAX_BYTES = 1024 * 1024
export const REMOTE_VIEW_COMMAND_MAX_BYTES = 16 * 1024
const READ_METHODS = new Set(['Page.startScreencast', 'Page.stopScreencast'])
const INPUT_METHODS = new Set(['hoai.input.acquire', 'hoai.input.release', 'hoai.input.focus', 'hoai.input.pointer', 'hoai.input.key'])
const CREDENTIAL_METHODS = new Set(['hoai.credentials.prepare', 'hoai.credentials.commit', 'hoai.credentials.save', 'hoai.credentials.cancel'])
const BROWSER_METHODS = new Set(['hoai.browser.navigate', 'hoai.browser.navigation', 'hoai.browser.tab'])
export const REMOTE_BROWSER_TAB_MAX = 16
const captureParams = { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }
const viewError = code => Object.assign(new Error('The browser action was refused.'), { code })
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const principal = value => typeof value === 'string' && /^user-[^\s\x00-\x1f\x7f]{1,251}$/.test(value)
const requestId = value => (Number.isSafeInteger(value) && value >= 0) || identifier(value)
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const displayUrl = (value, redact) => {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank'
    // The origin is public routing/offer authority. A short OTP can coincide
    // with hostname characters; replacing those makes metadata invalid.
    const shown = new URL(url.origin)
    shown.pathname = redact(url.pathname); shown.search = redact(url.search); shown.hash = redact(url.hash)
    return shown.href.slice(0, 4096)
  } catch { return 'about:blank' }
}

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
    const page = slot?.engine?.selectedPage?.() || slot?.engine?.pages().at(-1)
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
      identity, closed: false, pendingFrame: null, latestFrame: null, queued: 0, tail: Promise.resolve(), capturing: false }
    // Reserve before attaching: a second open or disconnect can revoke startup.
    this.views.set(view.viewId, view)
    this.bySlot.set(slotKey, view)
    view.onGone = () => {
      if (view.switching) return
      const next = view.engine.pages().filter(candidate => candidate !== view.page && !candidate.isClosed()).at(-1)
      if (next) void this._switch(view, next).catch(() => this.close(view.viewId, connectionId, 'remote_target_gone'))
      else void this.close(view.viewId, connectionId, 'remote_target_gone')
    }
    view.onNavigation = frame => { if (frame === view.page.mainFrame()) { this.input.release(view); void this.credentials.close(view); this._scheduleState(view) } }
    view.onLoaded = () => this._scheduleState(view)
    page.on('close', view.onGone)
    page.on('crash', view.onGone)
    page.on('framenavigated', view.onNavigation)
    page.on('domcontentloaded', view.onLoaded)
    page.on('load', view.onLoaded)
    view.browserContext = page.context()
    view.onPage = added => {
      if (view.engine.pages().length > REMOTE_BROWSER_TAB_MAX) { void added.close().catch(() => {}); return }
      // A popup caused by this owner's click is part of the same browser.
      // An agent opening a tab while the owner only watches does not steal control.
      if (!view.switching && view.ownerLease) {
        const run = () => this._switch(view, added)
        view.tail = view.tail.then(run, run).catch(() => {})
      } else this._scheduleState(view)
    }
    view.browserContext.on?.('page', view.onPage)
    view.onSelectedPage = selected => {
      if (!selected || selected === view.page || view.ownerLease || view.switching || view.closed) return
      const run = () => this._switch(view, selected)
      view.tail = view.tail.then(run, run).catch(() => {})
    }
    view.engine.onSelectedPage = view.onSelectedPage
    try {
      view.cdp = await page.context().newCDPSession(page)
      if (!this._current(view)) { await this._detach(view); return false }
      const initialCdp = view.cdp
      view.onFrame = frame => { if (view.cdp === initialCdp) this._frame(view, frame) }
      view.cdp.on('Page.screencastFrame', view.onFrame)
      const metrics = await view.cdp.send('Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport || metrics.visualViewport || page.viewportSize() || {}
      const width = viewport.clientWidth || viewport.width || 1280
      const height = viewport.clientHeight || viewport.height || 720
      view.width = width
      view.height = height
      const title = await page.title().catch(() => '')
      const redact = view.engine.resultRedactor?.() || (value => value)
      if (!this._current(view)) { await this.close(view.viewId, connectionId, 'remote_target_gone'); return false }
      const sent = this._send(view, { method: 'hoai.ready', params: { sessionId: view.sessionId, tabId,
        title: redact(title).slice(0, 300), url: displayUrl(page.url(), redact), width, height, remoteInput: true,
        remoteBrowser: true,
        ...(slot.engine.vault ? { remoteCredentials: true } : {}) } })
      await this._state(view)
      return sent
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

  _tabId(view, page) {
    let id = view.identity.tabs.get(page)
    if (!id) { id = `tab_${randomUUID()}`; view.identity.tabs.set(page, id) }
    return id
  }

  _scheduleState(view) {
    if (view.stateTimer || view.closed || view.switching) return
    view.stateTimer = setTimeout(() => { view.stateTimer = null; void this._state(view).catch(() => {}) }, 50)
    view.stateTimer.unref?.()
  }

  async _state(view) {
    if (!this._current(view) || view.switching) return
    const page = view.page, cdp = view.cdp, tabId = view.tabId
    let history = {}
    try { history = await cdp.send('Page.getNavigationHistory') } catch {}
    const pages = view.engine.pages().filter(candidate => !candidate.isClosed()).slice(0, REMOTE_BROWSER_TAB_MAX)
    const tabs = await Promise.all(pages.map(async candidate => ({ tabId: this._tabId(view, candidate),
      title: (await candidate.title().catch(() => '')).slice(0, 300), url: candidate.url().slice(0, 4096),
      loading: candidate === page ? !!view.loading : false,
      ...(candidate === page ? { canGoBack: (history.currentIndex || 0) > 0,
        canGoForward: Number.isInteger(history.currentIndex) && history.currentIndex < (history.entries?.length || 0) - 1 } : {}) })))
    if (!this._current(view) || view.page !== page || view.cdp !== cdp || view.tabId !== tabId || view.switching) return
    const redact = view.engine.resultRedactor?.() || (value => value)
    const params = { sessionId: view.sessionId, tabId, width: view.width, height: view.height,
      tabs: tabs.map(tab => ({ ...tab, title: redact(tab.title).slice(0, 300), url: displayUrl(tab.url, redact) })), activeIndex: pages.indexOf(page) }
    this._send(view, { method: 'hoai.browser.state', params, sessionId: view.sessionId, tabId })
  }

  async _switch(view, page) {
    if (view.closed || page.isClosed() || !view.engine.pages().includes(page)) throw viewError('stale_target')
    try { await this._bind(view, page) }
    catch (error) {
      view.switching = false
      void this.close(view.viewId, view.connectionId, 'remote_target_gone')
      throw error
    }
  }

  async _bind(view, page) {
    view.switching = true
    this.input.release(view)
    await this.credentials.close(view)
    const previous = view.page
    previous.off('close', view.onGone); previous.off('crash', view.onGone)
    previous.off('framenavigated', view.onNavigation); previous.off('load', view.onLoaded); previous.off('domcontentloaded', view.onLoaded)
    await view.ownerDrain?.cleanupPromise
    await this._detach(view, false)
    if (view.closed) { view.switching = false; throw viewError('stale_target') }
    await view.engine.selectPage?.(page)
    view.page = page; view.tabId = this._tabId(view, page)
    view.pendingFrame = null; view.latestFrame = null
    page.on('close', view.onGone); page.on('crash', view.onGone)
    page.on('framenavigated', view.onNavigation); page.on('load', view.onLoaded); page.on('domcontentloaded', view.onLoaded)
    view.cdp = await page.context().newCDPSession(page)
    if (!this._current(view)) { await this._detach(view, false); throw viewError('stale_target') }
    const cdp = view.cdp
    view.onFrame = frame => { if (view.cdp === cdp) this._frame(view, frame) }
    cdp.on('Page.screencastFrame', view.onFrame)
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport || metrics.visualViewport || page.viewportSize() || {}
    view.width = viewport.clientWidth || viewport.width || 1280; view.height = viewport.clientHeight || viewport.height || 720
    view.switching = false
    await this._state(view)
    if (view.capturing) await cdp.send('Page.startScreencast', captureParams)
  }

  async _browser(view, method, params) {
    return this.input.controlled(view, params.leaseId, async () => {
      if (method === 'hoai.browser.tab') {
        const pages = view.engine.pages().filter(candidate => !candidate.isClosed())
        if (!['new', 'select', 'close'].includes(params.action) ||
            (params.action !== 'new' && (!Number.isInteger(params.index) || params.index < 0 || params.index >= pages.length))) throw viewError('invalid_browser_action')
        if (params.action === 'new') {
          if (pages.length >= REMOTE_BROWSER_TAB_MAX) throw viewError('browser_tabs_full')
          view.switching = true
          let page
          try { page = await view.engine.newPage() } finally { view.switching = false }
          await this._switch(view, page)
        } else if (params.action === 'select') await this._switch(view, pages[params.index])
        else {
          const target = pages[params.index]
          if (target === view.page) {
            // Keep one usable page when the last tab is closed.
            let next = pages.find(candidate => candidate !== target)
            if (!next) { view.switching = true; try { next = await view.engine.newPage() } finally { view.switching = false } }
            await this._switch(view, next)
          }
          await target.close()
          await this._state(view)
        }
        return {}
      }
      if (method === 'hoai.browser.navigate') {
        let url
        try { url = new URL(params.url) } catch { throw viewError('invalid_browser_url') }
        if (typeof params.url !== 'string' || params.url.length > 4096 || url.username || url.password ||
            (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank')) throw viewError('invalid_browser_url')
        await this.credentials.close(view)
        view.loading = true; await this._state(view)
        try { await view.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 }) }
        finally { view.loading = false; this.input.release(view); await this._state(view) }
      } else {
        if (!['back', 'forward', 'reload', 'stop'].includes(params.action)) throw viewError('invalid_browser_action')
        await this.credentials.close(view)
        view.loading = params.action !== 'stop'; await this._state(view)
        try {
          if (params.action === 'stop') await view.cdp.send('Page.stopLoading')
          else await view.page[{ back: 'goBack', forward: 'goForward', reload: 'reload' }[params.action]]({ waitUntil: params.action === 'reload' ? 'domcontentloaded' : 'commit', timeout: 15000 })
        } finally { view.loading = false; this.input.release(view); await this._state(view) }
      }
      return {}
    })
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
    const reply = body => this._send(view, { id: frame.id, ...body, sessionId: frame.sessionId, tabId: frame.tabId })
    if (!READ_METHODS.has(frame.method) && !INPUT_METHODS.has(frame.method) && !CREDENTIAL_METHODS.has(frame.method) && !BROWSER_METHODS.has(frame.method)) {
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
        if (frame.tabId !== view.tabId) { reply({ error: { code: 'stale_target', message: 'The selected browser tab changed.' } }); return false }
        if (BROWSER_METHODS.has(frame.method)) {
          reply({ result: await this._browser(view, frame.method, frame.params || {}) })
          return true
        }
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
        const params = frame.method === 'Page.startScreencast' ? captureParams : {}
        const result = await view.cdp.send(frame.method, params)
        view.capturing = frame.method === 'Page.startScreencast'
        if (!view.capturing) { view.pendingFrame = null; view.latestFrame = null }
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
    clearTimeout(view.stateTimer)
    this.views.delete(viewId)
    if (this.bySlot.get(view.slotKey) === view) this.bySlot.delete(view.slotKey)
    view.page.off('close', view.onGone)
    view.page.off('crash', view.onGone)
    view.page.off('framenavigated', view.onNavigation)
    view.page.off('load', view.onLoaded); view.page.off('domcontentloaded', view.onLoaded)
    view.browserContext.off?.('page', view.onPage)
    if (view.engine.onSelectedPage === view.onSelectedPage) view.engine.onSelectedPage = null
    view.sendClose({ viewId, reason })
    await this._detach(view)
    return true
  }

  async _detach(view, drainInput = true) {
    if (drainInput) await this.input.drain(view)
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
