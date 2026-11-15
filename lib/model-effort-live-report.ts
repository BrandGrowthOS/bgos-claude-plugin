/**
 * The pill follows the session (KC, HOAI chat 4875 msg 228420, 2026-11-15).
 *
 * The chip under the owner's message box shows the model and effort the
 * server last stored for the chat (chats.session_settings). This daemon is
 * the only writer of that value, and it used to write it from one place: the
 * picker's apply (lib/model-effort-rpc.ts), as the outcome of a switch made
 * THROUGH the picker. A model changed any other way never reached the app:
 * /model typed in the agent's own terminal (which the app's own refusal text
 * tells the owner to do), or a restart that resumes a conversation on the
 * model it had. Autonomee's chip read a value last written six days before.
 *
 * The daemon already reads the truth all the time: the status line bridge
 * (lib/model-control-store.mjs) stores what the session itself says, every
 * few seconds. This reporter looks at that observation on a tick and sends
 * the session settings report when the model or the effort differs from the
 * last report the server ACCEPTED for that chat.
 *
 * The gates are the picker's own, so nothing new leaves a machine:
 *  - the owner's opt in on this machine (hoai-model-control on). Opting out
 *    stops the reports and forgets what was sent;
 *  - the session this daemon has proven it serves, and that session's own
 *    observation, no older than the picker itself trusts;
 *  - the owner's own main chats (pickerChatAllowed), never a recipient's;
 *  - a value the report route accepts (sessionSettingsBody).
 *
 * It types nothing and reads no screen. A look never throws, never overlaps
 * another, and never waits on an answer for longer than its bound: a report
 * that fails or never answers is tried again on the next look.
 */

import type { ModelObservation } from './model-control-store.mjs'
import { sessionSettingsBody, type SessionSettingsBody } from './model-effort-rpc.ts'

export interface LiveReportDeps {
  /** The owner's opt in to remote model and effort control, read per look. */
  optedIn: () => boolean
  /** The session id this daemon has POSITIVELY proven it serves, or null. */
  sessionId: () => string | null
  readObservation: (sessionId: string) => ModelObservation | null
  /** The owner's own main chats: the chats whose pill this is. */
  chats: () => readonly string[]
  reportSettings: (chatId: string, body: SessionSettingsBody) => Promise<unknown>
  now: () => number
  log: (msg: string) => void
}

export interface LiveReportOptions {
  /** An observation older than this is not reported (the picker's own limit). */
  staleMs: number
  /** How long one report may take before the look gives up on it. */
  timeoutMs: number
}

/** What a chat was last told, as one comparable value. */
const keyOf = (model: string, effort: string | null): string => `${model}\n${effort ?? ''}`

export class SessionSettingsLiveReporter {
  /** chat id -> the value the server last accepted for it. */
  private readonly sent = new Map<string, string>()
  private looking = false

  constructor(
    private readonly deps: LiveReportDeps,
    private readonly opts: LiveReportOptions,
  ) {}

  /**
   * A report another path already sent and the server took (the picker's
   * apply), so the next look does not send the same value again.
   */
  noteReported(chatId: string, value: { model: string; effort: string | null }): void {
    this.sent.set(chatId, keyOf(value.model, value.effort))
  }

  /** One look. Sends only what changed. Never throws. */
  async tick(): Promise<void> {
    if (this.looking) return
    this.looking = true
    try {
      await this.look()
    } catch (err) {
      this.deps.log(`model effort live report: look failed (${err instanceof Error ? err.name : 'error'})`)
    } finally {
      this.looking = false
    }
  }

  private async look(): Promise<void> {
    if (!this.deps.optedIn()) {
      // Off means off: and an owner who opts in again is told afresh.
      this.sent.clear()
      return
    }
    const sessionId = this.deps.sessionId()
    if (!sessionId) return
    const seen = this.deps.readObservation(sessionId)
    if (!seen || seen.sessionId !== sessionId) return
    const now = this.deps.now()
    if (now - seen.observedAtMs > this.opts.staleMs) return
    const body = sessionSettingsBody({ model: seen.modelId, effort: seen.effort }, now)
    if (!body) return
    const key = keyOf(body.model, body.effort)
    for (const chatId of this.deps.chats()) {
      if (this.sent.get(chatId) === key) continue
      if (await this.send(chatId, body)) this.sent.set(chatId, key)
    }
  }

  /** One report, bounded. True only when the server took it. */
  private async send(chatId: string, body: SessionSettingsBody): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const gaveUp = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.opts.timeoutMs)
    })
    try {
      const outcome = await Promise.race([
        this.deps.reportSettings(chatId, body).then(() => 'sent' as const),
        gaveUp,
      ])
      if (outcome === 'sent') return true
      this.deps.log('model effort live report: session settings report failed (timeout)')
      return false
    } catch (err) {
      // The name only: an error's text is the server's or the network's words.
      this.deps.log(`model effort live report: session settings report failed (${err instanceof Error ? err.name : 'error'})`)
      return false
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}
