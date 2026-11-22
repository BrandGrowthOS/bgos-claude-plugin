import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ANY_MODEL, WEEK_READING_MAX_AGE_MS, accountRoom, mostWeekRoom, roomBlocked } from './helper-account-limits.mjs'
import { LIMIT_ACCOUNT_FRESH_MS, accountChanged } from './limit-screen.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,47}$/u
const MAX_PROFILES = 32
const MAX_AGENT_ROWS = 64
const MAX_BLOCKS = 8
const CREDENTIAL_LABEL = /(?:\b(?:sk[-_]|pair_|gh[pousr]_|xox[baprs]-|AKIA)[\w-]{4,}|^[A-Za-z0-9_-]{30,}$)/i
const FRESH_MS = 10 * 60_000
const STATUSES = new Set([
  'saved', 'waiting_for_turn', 'restarting', 'back_online', 'restored', 'failed', 'needs_sign_in',
  'waiting_for_limit', 'waiting_for_room',
])
/** The timings this watcher runs. The server offers Switch at limit and Auto only to a watcher that lists them. */
export const ACCOUNT_MODES = Object.freeze(['now', 'limit', 'auto'])
const RULE_MODES = new Set(['limit', 'auto'])
/** The longest a rollback waits for a safety hold before it is reported failed. */
const ROLLBACK_HOLD_MAX_MS = 30 * 60_000
const MAX_REFUSED = 8
const BLOCK_KEY = /^(?:\*|[a-z]{2,24})$/
const denied = () => {
  throw new Error('account_change_refused')
}
export const accountsRoot = (home) => join(home, '.bgos-agent', 'helper-accounts')
export function profileDirectory(home, id) {
  if (!UUID.test(id)) return denied()
  return join(accountsRoot(home), id)
}
const registryPath = (home) => join(accountsRoot(home), 'registry.json')
export function readAccountRegistry(home) {
  try {
    const path = registryPath(home)
    if (
      !lstatSync(join(home, '.bgos-agent')).isDirectory() ||
      !lstatSync(accountsRoot(home)).isDirectory() ||
      !lstatSync(path).isFile()
    )
      throw new Error('accounts_unavailable')
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (
      value?.version !== 1 ||
      !Array.isArray(value.accounts) ||
      value.accounts.length > MAX_PROFILES ||
      !value.targets ||
      typeof value.targets !== 'object' ||
      Array.isArray(value.targets)
    )
      throw new Error('accounts_unavailable')
    // One entry a later, stricter rule refuses hides that account only, never every
    // other saved login and every agent start on this computer (finding F3).
    const ids = new Set()
    value.accounts = value.accounts.filter((a) => {
      const ok = UUID.test(a?.id) && !ids.has(a.id) && typeof a.label === 'string' && LABEL.test(a.label) && !CREDENTIAL_LABEL.test(a.label)
      if (ok) ids.add(a.id)
      return ok
    })
    return value
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw new Error('accounts_unavailable')
  }
}

function save(home, registry) {
  const dir = accountsRoot(home)
  mkdirSync(dir, { mode: 0o700, recursive: true })
  if (!lstatSync(dir).isDirectory()) return denied()
  chmodSync(dir, 0o700)
  const temp = join(dir, randomUUID() + '.tmp')
  writeFileSync(temp, JSON.stringify(registry), { mode: 0o600, flag: 'wx' })
  renameSync(temp, registryPath(home))
}

function safeUsage(value, now) {
  if (!value || ![value.short, value.week, value.model].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) return null
  const at = Date.parse(value.readAt)
  const reset = Date.parse(value.resetAt)
  if (!Number.isFinite(at) || at > now || now - at > FRESH_MS || !(reset > now)) return null
  return {
    short: value.short,
    week: value.week,
    model: value.model,
    resetAt: new Date(reset).toISOString(),
    readAt: new Date(at).toISOString(),
  }
}

function statusWindow(raw, now, keepPassed = false) {
  const used = raw?.used_percentage
  const reset = raw?.resets_at
  if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isSafeInteger(reset) || reset <= 0) return
  const date = new Date(reset * 1000)
  if ((keepPassed || date.getTime() > now) && date.getUTCFullYear() <= 9999) return { used, resetAt: date.toISOString() }
}

// Capkeeper atomically replaces this per-profile file. Its mtime dates the sample,
// including when a signed-in profile has had no new turns for a while. The owner's
// view shows only a fresh sample; Auto may compare week room from a sample up to a
// day old, and a week whose reset passed since counts as a full week.
function readStatusWindows(profile, now, { maxAge = FRESH_MS, keepPassed = false } = {}) {
  let fd
  try {
    const state = join(profile, 'state')
    const dir = join(state, 'usage')
    if (![profile, state, dir].every((p) => lstatSync(p).isDirectory())) return
    const path = join(dir, 'last-status.json')
    if (!lstatSync(path).isFile()) return
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    const entry = fstatSync(fd)
    const age = now - Math.floor(entry.mtimeMs)
    if (!entry.isFile() || entry.nlink !== 1 || entry.size < 1 || entry.size > 16384 || age < 0 || age > maxAge) return
    const data = Buffer.alloc(entry.size)
    if (readSync(fd, data) !== entry.size) return
    const windows = JSON.parse(data.toString('utf8'))?.rate_limits
    const fiveHour = statusWindow(windows?.five_hour, now, keepPassed)
    const week = statusWindow(windows?.seven_day, now, keepPassed)
    if (fiveHour || week) return {
      readAt: entry.mtime.toISOString(),
      ...(fiveHour && { fiveHour }),
      ...(week && { week }),
    }
  } catch {
    // Missing, unreadable or malformed samples are common before the first turn.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The watcher is the registry's only writer. All starts read the atomically
 * replaced file. Every restart is journalled before it reaches the watcher. */
export function createHelperAccounts({ home, credentials, now = Date.now, inventory, measure, restart, ownAccount = async () => ({ read: false }), uuid = randomUUID }) {
  const pairingId = Number(credentials.pairingId)
  const { machineId } = credentials
  // Review #4: a pairing number is local to one backend's database. The registry is bound to the
  // backend that issued it, and another deployment that hands out the same number sees nothing.
  const backendUrl = typeof credentials.backendUrl === 'string' ? credentials.backendUrl : null
  const sameBackend = (reg) => (reg.backendUrl ?? null) === backendUrl
  const load = () => {
    const reg = readAccountRegistry(home)
    if (reg && (reg.machineId !== machineId || reg.pairingId !== pairingId || !sameBackend(reg))) return null
    return reg
  }
  const commit = (state) => save(home, state)
  const rowsOf = async (state) => (await inventory()).filter((r) => r.userId === state.ownerUserId)
  // `readFailed`: the status read failed or timed out (or threw); that says nothing about the login.
  // `account`: the Claude account the read named, as a lib/claude-account-id.mjs token, or null.
  // `readAt`: when its status read started (a read stands for a minute, lib/claude-account-id.mjs).
  const readingFor = async ({ id, label }, model) => {
    const reading = await measure({ id, label }, model).catch(() => null)
    return {
      id,
      label,
      signedIn: reading?.signedIn === true,
      usage: safeUsage(reading?.usage, now()),
      account: typeof reading?.account === 'string' ? reading.account : null,
      readFailed: reading === null || reading?.readFailed === true,
      readAt: Number.isFinite(reading?.readAt) ? reading.readAt : null,
    }
  }
  // At a limit, a login counts only on a read taken since the limit began: one from before it may
  // name a seat it has been signed out of since (a read stands for a minute).
  const readSince = (reading, atMs) => typeof reading?.readAt === 'number' && reading.readAt >= atMs
  /** The Claude account the agent hit this limit on: the first status read of its saved login (or its
   *  own login, ownAccount) within LIMIT_ACCOUNT_FRESH_MS of the limit, kept on the target as a one
   *  way token for that limit. A later first read may already see another account (signed in since),
   *  so it never counts. Null when unknown or the read failed: then nothing switches (rule C). */
  async function accountAtLimit(state, target, row, model, limit) {
    const kept = target.limitAccount
    if (kept && kept.atMs === limit.atMs && typeof kept.token === 'string') return kept.token
    if (now() - limit.atMs > LIMIT_ACCOUNT_FRESH_MS) return null
    let token = null
    if (row.accountId) {
      const saved = state.accounts.find((a) => a.id === row.accountId)
      const reading = saved && (await readingFor(saved, model))
      token = reading && !reading.readFailed && reading.signedIn ? reading.account : null
    } else {
      const own = await Promise.resolve()
        .then(() => ownAccount(row))
        .catch(() => null)
      token = own?.read === true && typeof own.account === 'string' ? own.account : null
    }
    if (token) {
      target.limitAccount = { atMs: limit.atMs, token }
      commit(state)
    }
    return token
  }
  // Review #10: the account a status is about rides with it, so a page opened later can name it.
  const status = (state, target, value, accountId = target.rule?.accountId ?? target.choice ?? null) => {
    target.status = value
    state.status = value
    state.statusRpcId = target.rpcId
    state.statusAssistantId = target.assistantId ?? null
    state.statusAccountId = UUID.test(accountId) ? accountId : null
    commit(state)
  }
  async function returned(state, target, desired, pin) {
    const row = (await rowsOf(state)).find((r) => r.assistantId === target.assistantId && r.pairingId === target.pairingId)
    return row && row.accountId === desired && row.sessionId === pin
  }
  // Switch now and Switch at limit are spent by their switch; Auto stays on until the owner turns it off.
  const endRule = (target) => {
    if (target.rule?.mode !== 'auto') delete target.rule
  }
  async function finish(state, target, row, verified) {
    const { desired, previous, pin } = target.transition
    if (verified && (await returned(state, target, desired, pin))) {
      delete target.transition
      endRule(target)
      return status(state, target, 'back_online')
    }
    target.choice = previous
    const done = (outcome) => {
      delete target.transition
      endRule(target)
      return status(state, target, outcome, outcome === 'restored' ? previous : desired)
    }
    // The rollback restart runs at most once: 'started' is journalled before it, so a watcher
    // that dies inside it never restarts the agent again on its next look.
    if (target.transition.rollback === true || target.transition.rollback === 'started') return done('failed')
    // Review #1: recovery restarts only the conversation the switch was made for. A conversation
    // the owner opened since is never stopped by it; the previous login stays its next start's.
    if (!row || row.sessionId !== pin) return done('failed')
    // A held rollback has a bound: past it the owner is told it failed, the previous login stays
    // the next start's, and the computer takes account changes again (independent verify, D).
    const heldSince = target.transition.heldSince
    if (typeof heldSince === 'number' && now() - heldSince > ROLLBACK_HOLD_MAX_MS) return done('failed')
    target.transition.rollback = 'started'
    commit(state)
    const ok = await restart(row, previous).catch(() => false)
    // Review #3: a safety hold (a turn, a permission question) defers the rollback, never drops it.
    if (ok?.started === false && ok.wait) {
      target.transition.rollback = 'pending'
      target.transition.heldSince = heldSince ?? now()
      return status(state, target, 'waiting_for_turn', previous)
    }
    return done(ok === true && (await returned(state, target, previous, pin)) ? 'restored' : 'failed')
  }

  /** One switch of one agent. At a limit the agent cannot answer anyway, so the switch does not wait
   *  for its turn to end: the restart port applies the at-limit safety rule instead. */
  async function switchTo(state, target, row, accountId, { atLimit = false } = {}) {
    const current = row.accountId
    // Review #9: a provably stopped agent has no turn to finish. Its next start, whoever starts
    // it, takes the new login in the same conversation (the launcher links the transcript then).
    if (row.stopped === true) {
      if (current === null) target.originalDir = row.configDir ?? null
      target.choice = accountId
      endRule(target)
      return status(state, target, 'saved', accountId)
    }
    if (!row.sessionId || (!atLimit && !row.ready)) {
      if (target.status !== 'waiting_for_turn') status(state, target, 'waiting_for_turn')
      return
    }
    const seenBefore = target.limitSeenAt
    const switchedBefore = target.switchedAt
    if (atLimit) target.limitSeenAt = row.limit.atMs
    target.transition = { desired: accountId, previous: current, pin: row.sessionId }
    // Preserve the original unmanaged config for a rollback that must
    // override a newer computer default. Never send directory names to HOAI.
    if (current === null) target.originalDir = row.configDir ?? null
    target.choice = accountId
    target.switchedAt = now()
    status(state, target, 'restarting')
    const verified = await restart(row, accountId, { atLimit }).catch(() => false)
    if (verified?.started === false) {
      target.choice = current
      delete target.transition
      if (switchedBefore === undefined) delete target.switchedAt
      else target.switchedAt = switchedBefore
      // A switch that must wait is tried again at the next look, for the same limit.
      if (verified.wait) {
        if (seenBefore === undefined) delete target.limitSeenAt
        else target.limitSeenAt = seenBefore
      } else endRule(target)
      return status(state, target, verified.wait ? 'waiting_for_turn' : 'failed')
    }
    await finish(state, target, row, verified === true)
    return true
  }

  /** Auto's candidates: every saved login, signed in or not, with its week room and its limits. */
  async function pickMostRoom(state, model, current, { excludeCurrent = false, awayFrom, since } = {}) {
    const accounts = []
    for (const account of state.accounts) {
      if (excludeCurrent && account.id === current) continue
      const reading = await readingFor(account, model)
      // At a limit each candidate counts only on a read taken since the limit began.
      if (awayFrom !== undefined && !readSince(reading, since)) continue
      // At a limit (rule A): only a login the status read names as ANOTHER Claude account counts.
      if (awayFrom !== undefined && !accountChanged(awayFrom, reading.account)) continue
      const windows = reading.signedIn
        ? readStatusWindows(profileDirectory(home, account.id), now(), { maxAge: WEEK_READING_MAX_AGE_MS, keepPassed: true })
        : undefined
      accounts.push({ id: account.id, signedIn: reading.signedIn, room: accountRoom(windows, now()), blocks: account.blocks })
    }
    return mostWeekRoom({ accounts, model, current, now: now() })
  }

  /** Switch at limit and Auto: armed until the agent's own limit line appears, then one switch. */
  async function watchRule(state, target, row) {
    const rule = target.rule
    // An agent that is not running here now keeps its rule until it is back.
    if (!row) return
    const current = row.accountId
    const model = row.limit?.agentModel ?? row.model ?? null
    const limit = row.limit && row.limit.atMs > (target.limitSeenAt ?? 0) && row.limit.atMs > (target.switchedAt ?? 0) ? row.limit : null
    // Rule A: at a limit, a switch is only to ANOTHER Claude account than the one the agent hit it on.
    // Rule C: when that account cannot be read (a failed or timed out status read), nothing switches.
    const awayFrom = limit ? await accountAtLimit(state, target, row, model, limit) : undefined
    if (rule.mode === 'auto' && !target.armed) {
      target.armed = true
      const pick = limit && awayFrom === null ? null : await pickMostRoom(state, model, current, { excludeCurrent: Boolean(limit), awayFrom, since: limit?.atMs })
      if (pick && pick !== current) return switchTo(state, target, row, pick, { atLimit: Boolean(limit) })
      return status(state, target, limit ? 'waiting_for_room' : 'waiting_for_limit')
    }
    if (!limit) {
      if (target.status === 'waiting_for_room') status(state, target, 'waiting_for_limit')
      else if (!target.status) status(state, target, 'waiting_for_limit')
      return
    }
    let candidate = null
    if (awayFrom === null) {
      // The limited account could not be read: wait (the next look reads again; the reset ends it).
    } else if (rule.mode === 'limit') {
      const account = state.accounts.find((a) => a.id === rule.accountId)
      const reading = account && (await readingFor(account, model))
      // A read that failed or timed out says nothing: the rule waits for the next look (rule C).
      if (account && reading.readFailed) {
        if (target.status !== 'waiting_for_room') status(state, target, 'waiting_for_room')
        return
      }
      // A read from before the limit may be out of date (a seat signed in or out since): wait for the next.
      if (account && !readSince(reading, limit.atMs)) {
        if (target.status !== 'waiting_for_room') status(state, target, 'waiting_for_room')
        return
      }
      if (!reading?.signedIn) {
        delete target.rule
        return status(state, target, 'needs_sign_in', rule.accountId)
      }
      if (account.id !== current && !roomBlocked(account.blocks, model, now()) && accountChanged(awayFrom, reading.account)) candidate = account.id
    } else {
      candidate = await pickMostRoom(state, model, current, { excludeCurrent: true, awayFrom, since: limit.atMs })
    }
    if (!candidate) {
      if (target.status !== 'waiting_for_room') status(state, target, 'waiting_for_room')
      return
    }
    return switchTo(state, target, row, candidate, { atLimit: true })
  }

  /** An account whose agent just hit its limit has no room for that model (or, for a session or
   *  weekly limit, for any model) until the reset Claude gave. Only a refusal after the agent's last
   *  switch counts: the conversation it carried over still ends in the previous account's refusal. */
  function noteLimits(state, rows) {
    let changed = false
    const at = now()
    for (const account of state.accounts) {
      if (!account.blocks) continue
      for (const [key, until] of Object.entries(account.blocks)) {
        if (!BLOCK_KEY.test(key) || !(Date.parse(until) > at)) {
          delete account.blocks[key]
          changed = true
        }
      }
    }
    for (const row of rows) {
      const limit = row.limit
      if (!limit || !row.accountId) continue
      const target = state.targets[String(row.assistantId)]
      if (limit.atMs <= (target?.switchedAt ?? 0) || limit.atMs <= (row.startedAtMs ?? 0)) continue
      const account = state.accounts.find((a) => a.id === row.accountId)
      if (!account || !(limit.resetsAtMs > at)) continue
      const key = limit.model ?? ANY_MODEL
      if (!BLOCK_KEY.test(key)) continue
      const blocks = (account.blocks ??= {})
      const until = new Date(limit.resetsAtMs).toISOString()
      if (blocks[key] && Date.parse(blocks[key]) >= limit.resetsAtMs) continue
      if (!blocks[key] && Object.keys(blocks).length >= MAX_BLOCKS) continue
      blocks[key] = until
      changed = true
    }
    if (changed) commit(state)
  }

  async function advance(state, target, key) {
    const rows = key === 'computer' ? [] : await rowsOf(state)
    const row = rows.find((r) => r.assistantId === target.assistantId && r.pairingId === target.pairingId)
    // The process died before finishing its verification. Recover once on
    // the previous profile. A stale recipe is never proof of a fresh boot.
    if (target.transition) {
      await finish(state, target, row, false)
      return true
    }
    if (!target.rule) return
    if (RULE_MODES.has(target.rule.mode)) {
      if (key === 'computer') {
        delete target.rule
        return status(state, target, 'failed')
      }
      return watchRule(state, target, row)
    }
    if (key !== 'computer' && !row) {
      delete target.rule
      return status(state, target, 'failed')
    }
    const current = row ? row.accountId : (target.choice ?? null)
    const rule = target.rule
    if (rule.mode !== 'now') return denied()
    const account = state.accounts.find((a) => a.id === rule.accountId)
    const selected = account && (await readingFor(account, row?.model, true))
    if (!selected?.signedIn) {
      delete target.rule
      return status(state, target, 'needs_sign_in', rule.accountId)
    }
    if (row && selected.id !== current) return switchTo(state, target, row, selected.id)
    target.choice = selected.id
    delete target.rule
    status(state, target, 'saved')
  }
  /** The ids of jobs this watcher refused or that threw, newest last (memory only). */
  const refused = []
  let busy = false
  async function single(action) {
    if (busy) throw new Error('job_in_flight')
    busy = true
    try {
      return await action()
    } finally {
      busy = false
    }
  }
  return {
    lastStatus() {
      const value = load()?.status
      return STATUSES.has(value) ? value : 'failed'
    },
    /** Review #10: a job that threw before it changed anything still reaches its owner, as failed,
     *  under its own id, on the next heartbeat. Only this pairing's registry and its own owner. */
    recordFailure(rpcId, job, error) {
      if (!UUID.test(rpcId)) return
      // Every refused job reaches the page by its own id, even with no registry to write to (a
      // Restore on a fresh computer) and never over a change that is still waiting (verify A, B).
      refused.splice(0, refused.length, ...[...refused.filter((id) => id !== rpcId), rpcId].slice(-MAX_REFUSED))
      if (error?.message === 'job_in_flight') return
      try {
        const state = load()
        if (!state || state.ownerUserId !== job?.ownerUserId) return
        const command = job?.accountCommand
        const id = command?.assistantId
        state.status = 'failed'
        state.statusRpcId = rpcId
        state.statusAssistantId = Number.isSafeInteger(id) && id > 0 ? id : null
        state.statusAccountId = UUID.test(command?.accountId) ? command.accountId : null
        commit(state)
      } catch {
        // Recording an outcome never turns one failure into another.
      }
    },
    async run(rpcId, job) {
      return single(async () => {
        if (
          job?.op !== 'helper_accounts' ||
          job.requestedBy !== 'owner' ||
          job.machineId !== machineId ||
          job.watcherPairingId !== pairingId ||
          typeof job.ownerUserId !== 'string' ||
          !job.ownerUserId ||
          !Array.isArray(job.targets) ||
          !UUID.test(rpcId)
        )
          return denied()
        const existing = readAccountRegistry(home)
        if (existing && (existing.machineId !== machineId || existing.ownerUserId !== job.ownerUserId)) return denied()
        // Review #4: another backend's registry is never adopted, not even by an owner id that
        // happens to match (ids are only unique inside one deployment).
        if (existing && !sameBackend(existing)) return denied()
        // Nothing was visible to the new pairing before this authenticated
        // press. Keep the owner's saved logins and discard old queued work.
        const state =
          existing?.pairingId === pairingId
            ? existing
            : {
                version: 1,
                machineId,
                pairingId,
                backendUrl,
                ownerUserId: job.ownerUserId,
                accounts: existing?.accounts ?? [],
                targets: {},
              }
        if (state.receipts?.includes(rpcId)) return
        const accept = () => {
          state.receipts = [...(state.receipts ?? []), rpcId].slice(-64)
        }
        const command = job.accountCommand
        // Review #11: the same owner brings a re-enrolled watcher's saved logins back without
        // spending a slot (Add is refused at 32). Another owner was refused above.
        if (command?.action === 'rebind') {
          if (job.targets.length || !existing) return denied()
          accept()
          return status(state, { rpcId }, 'saved', null)
        }
        if (command?.action === 'add') {
          if (
            job.targets.length ||
            typeof command.label !== 'string' ||
            !LABEL.test(command.label) ||
            CREDENTIAL_LABEL.test(command.label) ||
            command.label.trim() !== command.label ||
            state.accounts.length >= MAX_PROFILES ||
            state.accounts.some((a) => a.label === command.label)
          )
            return denied()
          const id = uuid()
          const dir = accountsRoot(home)
          mkdirSync(dir, { mode: 0o700, recursive: true })
          if (!lstatSync(dir).isDirectory()) return denied()
          mkdirSync(profileDirectory(home, id), { mode: 0o700 })
          state.accounts.push({ id, label: command.label })
          accept()
          return status(state, { rpcId }, 'needs_sign_in', id)
        }
        const action = command?.action
        const mode = command?.mode
        // Switch now names a saved login for the computer or one agent. Switch at limit names
        // one for one agent; Auto names none. Clear turns an agent's rule off.
        const shapeOk =
          action === 'clear'
            ? mode === undefined && command.accountId === undefined && command.assistantId !== undefined
            : action === 'assign' &&
              ACCOUNT_MODES.includes(mode) &&
              (mode === 'auto'
                ? command.accountId === undefined
                : state.accounts.some((a) => a.id === command.accountId)) &&
              (mode === 'now' || command.assistantId !== undefined)
        if (!shapeOk) return denied()
        const id = command.assistantId
        let pairing
        if (id !== undefined) {
          if (!Number.isSafeInteger(id) || id <= 0 || job.targets.length !== 1 || job.targets[0].assistantId !== id)
            return denied()
          pairing = job.targets[0].pairingId
          if (!(await rowsOf(state)).some((r) => r.assistantId === id && r.pairingId === pairing)) return denied()
        } else if (job.targets.length) return denied()
        const key = id === undefined ? 'computer' : String(id)
        if (Object.values(state.targets).some((t) => t.transition)) throw new Error('job_in_flight')
        if (action === 'clear') {
          // Turns off a Switch at limit or Auto rule, or cancels a Switch now still waiting for its turn.
          const target = state.targets[key]
          if (!target || target.pairingId !== pairing || !target.rule) return denied()
          delete target.rule
          delete target.armed
          target.rpcId = rpcId
          accept()
          return status(state, target, 'saved', null)
        }
        // Review #7: an accepted Switch now still waiting for the agent's turn is never replaced by
        // a later press (its owner would never hear what became of it). Cancel it first (clear).
        if (state.targets[key]?.rule?.mode === 'now') throw new Error('job_in_flight')
        const target = (state.targets[key] ??= {})
        delete target.armed
        delete target.limitSeenAt
        Object.assign(target, {
          rpcId,
          status: undefined,
          ...(pairing ? { assistantId: id, pairingId: pairing } : {}),
          rule: { mode, ...(command.accountId ? { accountId: command.accountId } : {}) },
        })
        accept()
        commit(state)
        if (pairing) noteLimits(state, await rowsOf(state))
        await advance(state, target, key)
      })
    },
    async tick() {
      if (busy) return
      return single(async () => {
        const state = load()
        if (!state) return
        noteLimits(state, await rowsOf(state))
        for (const [key, target] of Object.entries(state.targets)) {
          if ((target.transition || target.rule) && (await advance(state, target, key))) break
        }
      })
    },
    async snapshot() {
      const state = load()
      const refusedRpcIds = refused.length ? { refusedRpcIds: [...refused] } : {}
      if (!state) return { accounts: [], defaultAccountId: null, agents: [], modes: [...ACCOUNT_MODES], ...refusedRpcIds }
      const computer = state.targets.computer
      const rows = (await rowsOf(state))
        .filter((r) => Number.isSafeInteger(r.assistantId) && r.assistantId > 0)
        .slice(0, MAX_AGENT_ROWS)
      const ids = new Set(state.accounts.map((a) => a.id))
      const at = now()
      // Only fixed tokens and times: the model word is one the limit line named, checked again here.
      const limitsOf = (account) =>
        Object.entries(account.blocks ?? {})
          .filter(([key, until]) => BLOCK_KEY.test(key) && Date.parse(until) > at)
          .slice(0, MAX_BLOCKS)
          .map(([key, until]) => ({ model: key === ANY_MODEL ? null : key, until: new Date(Date.parse(until)).toISOString() }))
      const accounts = []
      for (let start = 0; start < state.accounts.length; start += 2) {
        const slice = state.accounts.slice(start, start + 2)
        const batch = await Promise.all(slice.map((a) => readingFor(a)))
        batch.forEach((account, i) => {
          const windows = account.signedIn && readStatusWindows(profileDirectory(home, account.id), at)
          const limits = limitsOf(slice[i])
          // The account token and the read flag stay on this computer: the heartbeat carries neither.
          const { account: _token, readFailed: _readFailed, readAt: _readAt, ...shown } = account
          accounts.push({ ...shown, ...(windows ? { usageWindows: windows } : {}), ...(limits.length ? { limits } : {}) })
        })
      }
      const ruleOf = (t) =>
        t?.rule?.mode === 'auto'
          ? { mode: 'auto' }
          : t?.rule?.mode === 'limit' && ids.has(t.rule.accountId)
            ? { mode: 'limit', accountId: t.rule.accountId }
            : null
      return {
        accounts,
        defaultAccountId: ids.has(computer?.choice) ? computer.choice : null,
        modes: [...ACCOUNT_MODES],
        agents: rows.map((row) => {
          const t = state.targets[row.assistantId]
          const rule = t?.pairingId === row.pairingId ? ruleOf(t) : null
          return {
            assistantId: row.assistantId,
            accountId: ids.has(row.accountId) ? row.accountId : null,
            ...(STATUSES.has(t?.status) ? { status: t.status } : {}),
            ...(rule ? { rule } : {}),
          }
        }),
        ...(STATUSES.has(state.status) ? { status: state.status } : {}),
        ...(UUID.test(state.statusRpcId) ? { statusRpcId: state.statusRpcId } : {}),
        ...(ids.has(state.statusAccountId) ? { statusAccountId: state.statusAccountId } : {}),
        ...refusedRpcIds,
        ...(rows.some((r) => r.assistantId === state.statusAssistantId) ? { statusAssistantId: state.statusAssistantId } : {}),
      }
    },
  }
}
