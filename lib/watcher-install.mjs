/**
 * watcher_install_rpc frame handler: the daemon-side `install_watcher` job
 * (zero-terminal lifecycle design 2.2 / 7.6).
 *
 * The app's "set up the watcher on this machine" button reaches the backend,
 * which emits `watcher_install_rpc {rpcId, op:'install_watcher'}` to THIS
 * agent's pairing room (the watcher does not exist yet; an already-running
 * agent is the only thing on the machine that can install it). The frame
 * carries nothing else, ever. The daemon then:
 *
 *   enroll       ensureMachineId + POST integrations/watchers/enroll
 *                {machineId, deviceLabel: hostname, watcherVersion} -> the
 *                watcher pairing's {pairingId, token, backendUrl}, returned ONCE
 *   bundle       copy the watcher bundle OUT of the plugin folder
 *                (~/.bgos-agent/watcher, lib/watcher-bundle.mjs) so a plugin
 *                reinstall or uninstall never kills it
 *   credentials  write <watcherHome>/credentials.json (0600 / icacls)
 *   service      launchd plist / systemd --user unit / schtasks, with the
 *                absolute node path recorded at install (never bun)
 *   start        the service's start commands ran inside the install
 *
 * Progress rides `POST integrations/machine-rpc/:rpcId/progress` as
 * `{state:'running'|'done'|'failed', steps:[{id, kind, state, message?}]}`
 * after every transition, so the app's checklist moves step by step. The
 * backend flips the job to 'done' on its own truth, the watcher pairing's
 * FIRST heartbeat; this handler's 'done' only says the install commands
 * ran. Completion is never faked.
 *
 * Failure posture: the failing step is named (never a silent stop), every
 * later step is 'skipped', a scrubbed diagnostics bundle goes to the P3
 * intake, and the credentials file is REMOVED whenever the service did
 * not install: a pairing token must never sit on disk for a watcher that
 * will not run. Dedupe and re-ack mirror UpdateRpcHandler exactly.
 *
 * Every effect is injected (the pieces owned by other tasks: bundle copy,
 * credentials, service spec/install) so this file imports cleanly on its
 * own and tests use fakes for each. Plain JavaScript, node builtins only.
 */

import { buildFailureDiagnostics } from './update-diagnostics.mjs'

export const WATCHER_INSTALL_OP = 'install_watcher'
/** Step ids in execution order (design 7.6). */
export const WATCHER_INSTALL_STEP_IDS = Object.freeze(['enroll', 'bundle', 'credentials', 'service', 'start'])
/** The backend caps progress messages at 300 chars (design 2.2). */
export const WATCHER_PROGRESS_MESSAGE_MAX_CHARS = 300

const HANDLED_RPC_CAP = 200

/**
 * @typedef {{ rpcId: string, op: 'install_watcher' }} WatcherInstallRpcFrame
 * @typedef {{ id: string, kind: string, state: 'running' | 'ok' | 'failed' | 'skipped', message?: string }} WatcherInstallStep
 */

/**
 * Validate a watcher_install_rpc control frame. Only {rpcId,
 * op:'install_watcher'} is accepted; every other field is ignored
 * (SECURITY: the frame never carries a url, a token, or a script).
 * @param {unknown} raw
 * @returns {WatcherInstallRpcFrame | null}
 */
export function normalizeWatcherInstallRpc(raw) {
  if (!raw || typeof raw !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (raw)
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  if (!rpcId || r.op !== WATCHER_INSTALL_OP) return null
  return { rpcId, op: WATCHER_INSTALL_OP }
}

/** The signature step kind for a step id (keeps watcher-install failures
 *  apart from update-step failures in the P3 signature table). */
export function watcherStepKind(id) {
  return `watcher_${id}`
}

export function clipWatcherMessage(text) {
  const value = String(text ?? '')
  return value.length > WATCHER_PROGRESS_MESSAGE_MAX_CHARS
    ? value.slice(0, WATCHER_PROGRESS_MESSAGE_MAX_CHARS)
    : value
}

/**
 * The node binary the watcher service will run: `node` on PATH first
 * (PATHEXT-aware on win32), then the current executable ONLY when it is
 * node itself. Never bun: the watcher bundle is bare node, and a service
 * pinned to a bun path would die the day bun moves. Pure, injected exists.
 * @param {{ env?: Record<string, string | undefined>, platform: string, execPath?: string, exists: (path: string) => boolean }} input
 * @returns {string | null}
 */
export function resolveNodePath(input) {
  const env = input.env ?? {}
  const win32 = input.platform === 'win32'
  const pathVar = String(env.PATH ?? env.Path ?? env.path ?? '')
  const names = win32 ? ['node.exe', 'node.cmd', 'node'] : ['node']
  const sep = win32 ? '\\' : '/'
  for (const dir of pathVar.split(win32 ? ';' : ':')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (!trimmed) continue
    for (const name of names) {
      const candidate = /[\\/]$/.test(trimmed) ? `${trimmed}${name}` : `${trimmed}${sep}${name}`
      let hit = false
      try {
        hit = input.exists(candidate) === true
      } catch {
        hit = false
      }
      if (hit) return candidate
    }
  }
  const execPath = String(input.execPath ?? '')
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (base === 'node' || base === 'node.exe') return execPath
  return null
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Ordered step ledger: steps appear as they start, so the wire never
 *  carries a state the backend does not know. */
class StepLedger {
  constructor() {
    /** @type {WatcherInstallStep[]} */
    this.steps = []
  }

  start(id) {
    this.steps.push({ id, kind: watcherStepKind(id), state: 'running' })
  }

  ok(id) {
    const step = this.steps.find((s) => s.id === id)
    if (step) step.state = 'ok'
  }

  failed(id, message) {
    let step = this.steps.find((s) => s.id === id)
    if (!step) {
      step = { id, kind: watcherStepKind(id), state: 'failed' }
      this.steps.push(step)
    }
    step.state = 'failed'
    step.message = clipWatcherMessage(message)
    for (const rest of WATCHER_INSTALL_STEP_IDS) {
      if (this.steps.some((s) => s.id === rest)) continue
      this.steps.push({ id: rest, kind: watcherStepKind(rest), state: 'skipped' })
    }
  }

  list() {
    return this.steps.map((s) => ({ ...s }))
  }
}

/**
 * @typedef {{
 *   postAck: (rpcId: string) => Promise<unknown>,
 *   postProgress: (rpcId: string, body: Record<string, unknown>) => Promise<unknown>,
 *   enroll: (body: { machineId: string, deviceLabel: string, watcherVersion: string | null }) => Promise<unknown>,
 *   ensureMachineId: () => string,
 *   installWatcherBundle: (args: { pluginRoot: string, home: string, pluginVersion: string | null }) => Promise<unknown> | unknown,
 *   writeWatcherCredentials: (creds: { pairingId: string | number, token: string, backendUrl: string, machineId: string }) => Promise<unknown> | unknown,
 *   removeWatcherCredentials: () => boolean,
 *   serviceSpec: (args: { nodePath: string, bundleDir: string }) => unknown,
 *   installWatcherService: (spec: unknown) => Promise<{ ok?: boolean, message?: string } | unknown> | unknown,
 *   nodePath: () => string | null,
 *   hostname: () => string,
 *   pluginRoot: string,
 *   ownVersion: string | null,
 *   home: string,
 *   platform: string,
 *   installMethod?: string,
 *   nodeVersion?: string | null,
 *   username?: string,
 *   postFailureDiagnostics?: (diagnostics: Record<string, unknown>) => Promise<unknown>,
 *   log: (msg: string) => void,
 * }} WatcherInstallDeps
 */

export class WatcherInstallRpcHandler {
  /** @param {WatcherInstallDeps} deps */
  constructor(deps) {
    this.deps = deps
    /** rpcId dedupe; entries survive completion (a re-emit after 'done'
     *  must never install twice). */
    this.handled = new Set()
  }

  /** @param {WatcherInstallRpcFrame} frame */
  async handle(frame) {
    if (!frame?.rpcId) return
    if (this.handled.has(frame.rpcId)) {
      this.deps.log(`watcher_install_rpc duplicate frame re-acked (rpc=${frame.rpcId})`)
      await this.ack(frame.rpcId)
      return
    }
    this.handled.add(frame.rpcId)
    if (this.handled.size > HANDLED_RPC_CAP) {
      const oldest = this.handled.values().next().value
      if (oldest !== undefined) this.handled.delete(oldest)
    }
    await this.ack(frame.rpcId)
    const steps = new StepLedger()
    try {
      await this.install(frame.rpcId, steps)
    } catch (err) {
      // Fail closed but never silent: name whatever step was running.
      const running = steps.steps.find((s) => s.state === 'running')
      await this.fail(frame.rpcId, steps, running?.id ?? 'enroll', `unexpected_error: ${errText(err)}`, {
        removeCredentials: true,
      })
    }
  }

  async ack(rpcId) {
    try {
      await this.deps.postAck(rpcId)
    } catch (err) {
      this.deps.log(`watcher_install_rpc ack failed (non-fatal, rpc=${rpcId}): ${errText(err)}`)
    }
  }

  /** Reporting, never control flow. */
  async progress(rpcId, body) {
    try {
      await this.deps.postProgress(rpcId, body)
    } catch (err) {
      this.deps.log(`watcher_install_rpc progress '${body.state}' failed (rpc=${rpcId}): ${errText(err)}`)
    }
  }

  async running(rpcId, steps) {
    await this.progress(rpcId, { state: 'running', steps: steps.list() })
  }

  /**
   * @param {string} rpcId
   * @param {StepLedger} steps
   * @param {string} id
   * @param {string} message
   * @param {{ removeCredentials?: boolean }} [opts]
   */
  async fail(rpcId, steps, id, message, opts = {}) {
    steps.failed(id, message)
    if (opts.removeCredentials) {
      let removed = false
      try {
        removed = this.deps.removeWatcherCredentials() === true
      } catch (err) {
        this.deps.log(`watcher_install_rpc: credentials cleanup threw: ${errText(err)}`)
      }
      this.deps.log(
        removed
          ? 'watcher_install_rpc: removed the watcher credentials file (the service did not install)'
          : 'watcher_install_rpc: no watcher credentials file to remove',
      )
    }
    const failedStep = { id, kind: watcherStepKind(id), message: clipWatcherMessage(message) }
    this.deps.log(`watcher_install_rpc failed at ${id}: ${failedStep.message}`)
    await this.progress(rpcId, {
      state: 'failed',
      steps: steps.list(),
      failedStep,
      message: failedStep.message,
    })
    this.postDiagnostics(steps, failedStep)
  }

  postDiagnostics(steps, failedStep) {
    const post = this.deps.postFailureDiagnostics
    if (!post) return
    try {
      const diagnostics = buildFailureDiagnostics({
        plan: { steps: WATCHER_INSTALL_STEP_IDS.map((id) => ({ id, kind: watcherStepKind(id) })) },
        result: { ok: false, failedStep, rolledBack: false, steps: steps.list() },
        platform: this.deps.platform,
        installMethod: this.deps.installMethod ?? 'unknown',
        pluginVersion: this.deps.ownVersion,
        targetVersion: this.deps.ownVersion,
        nodeVersion: this.deps.nodeVersion ?? null,
        home: this.deps.home,
        username: this.deps.username,
      })
      void Promise.resolve(post(diagnostics)).catch((err) => {
        this.deps.log(`watcher_install_rpc: failure diagnostics post failed (non-fatal): ${errText(err)}`)
      })
    } catch (err) {
      this.deps.log(`watcher_install_rpc: failure diagnostics post failed (non-fatal): ${errText(err)}`)
    }
  }

  /**
   * @param {string} rpcId
   * @param {StepLedger} steps
   */
  async install(rpcId, steps) {
    // 1. enroll
    steps.start('enroll')
    await this.running(rpcId, steps)
    const machineId = this.deps.ensureMachineId()
    if (!machineId) {
      return this.fail(rpcId, steps, 'enroll', 'machine_id_unwritable')
    }
    let enrolled
    try {
      enrolled = await this.deps.enroll({
        machineId,
        deviceLabel: this.deps.hostname(),
        watcherVersion: this.deps.ownVersion,
      })
    } catch (err) {
      return this.fail(rpcId, steps, 'enroll', `enroll_failed: ${errText(err)}`)
    }
    const response = enrolled && typeof enrolled === 'object' ? /** @type {Record<string, unknown>} */ (enrolled) : {}
    const token = str(response.token)
    const backendUrl = str(response.backendUrl)
    const pairingId =
      typeof response.pairingId === 'number' || typeof response.pairingId === 'string'
        ? response.pairingId
        : null
    if (!token || !backendUrl || pairingId === null || pairingId === '') {
      return this.fail(rpcId, steps, 'enroll', 'enroll_response_invalid')
    }
    steps.ok('enroll')

    // 2. bundle
    steps.start('bundle')
    await this.running(rpcId, steps)
    let bundle
    try {
      bundle = await this.deps.installWatcherBundle({
        pluginRoot: this.deps.pluginRoot,
        home: this.deps.home,
        pluginVersion: this.deps.ownVersion,
      })
    } catch (err) {
      return this.fail(rpcId, steps, 'bundle', `bundle_failed: ${errText(err)}`)
    }
    const bundleDir = str(bundle && typeof bundle === 'object' ? /** @type {Record<string, unknown>} */ (bundle).bundleDir : null)
    if (!bundleDir) {
      return this.fail(rpcId, steps, 'bundle', 'bundle_dir_missing')
    }
    steps.ok('bundle')

    // 3. credentials
    steps.start('credentials')
    await this.running(rpcId, steps)
    try {
      await this.deps.writeWatcherCredentials({ pairingId, token, backendUrl, machineId })
    } catch (err) {
      return this.fail(rpcId, steps, 'credentials', `credentials_failed: ${errText(err)}`, {
        removeCredentials: true,
      })
    }
    steps.ok('credentials')

    // 4. service
    steps.start('service')
    await this.running(rpcId, steps)
    let nodePath = null
    try {
      nodePath = this.deps.nodePath()
    } catch (err) {
      return this.fail(rpcId, steps, 'service', `node_lookup_failed: ${errText(err)}`, { removeCredentials: true })
    }
    if (!nodePath) {
      return this.fail(rpcId, steps, 'service', 'node_not_found', { removeCredentials: true })
    }
    let spec
    try {
      spec = this.deps.serviceSpec({ nodePath, bundleDir })
    } catch (err) {
      return this.fail(rpcId, steps, 'service', `service_spec_failed: ${errText(err)}`, { removeCredentials: true })
    }
    let installed
    try {
      installed = await this.deps.installWatcherService(spec)
    } catch (err) {
      return this.fail(rpcId, steps, 'service', `service_install_failed: ${errText(err)}`, { removeCredentials: true })
    }
    const result = installed && typeof installed === 'object' ? /** @type {Record<string, unknown>} */ (installed) : {}
    if (result.ok !== true) {
      const detail = str(result.message) ?? 'service install did not report ok'
      return this.fail(rpcId, steps, 'service', `service_install_failed: ${detail}`, { removeCredentials: true })
    }
    steps.ok('service')

    // 5. start: the spec's start commands ran inside installWatcherService;
    // the backend's own truth (the watcher's first heartbeat) decides 'done'.
    steps.start('start')
    steps.ok('start')
    await this.progress(rpcId, { state: 'done', steps: steps.list() })
    this.deps.log(
      `watcher_install_rpc: watcher installed (bundle ${bundleDir}, node ${nodePath}, machine ${machineId}); waiting on its first heartbeat`,
    )
  }
}
