import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,47}$/u
const MAX_PROFILES = 32
const CREDENTIAL_LABEL = /(?:\b(?:sk[-_]|pair_|gh[pousr]_|xox[baprs]-|AKIA)[\w-]{4,}|^[A-Za-z0-9_-]{30,}$)/i
const FRESH_MS = 10 * 60_000
const STATUSES = new Set(['saved', 'waiting_for_turn', 'restarting', 'back_online', 'restored', 'failed', 'needs_sign_in'])
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

function statusWindow(raw, now) {
  const used = raw?.used_percentage
  const reset = raw?.resets_at
  if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isSafeInteger(reset)) return
  const date = new Date(reset * 1000)
  if (date.getTime() > now && date.getUTCFullYear() <= 9999) return { used, resetAt: date.toISOString() }
}

// Capkeeper atomically replaces this per-profile file. Its mtime dates the sample,
// including when a signed-in profile has had no new turns for a while.
function readStatusWindows(profile, now) {
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
    if (!entry.isFile() || entry.nlink !== 1 || entry.size < 1 || entry.size > 16384 || age < 0 || age > FRESH_MS) return
    const data = Buffer.alloc(entry.size)
    if (readSync(fd, data) !== entry.size) return
    const windows = JSON.parse(data.toString('utf8'))?.rate_limits
    const fiveHour = statusWindow(windows?.five_hour, now)
    const week = statusWindow(windows?.seven_day, now)
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
export function createHelperAccounts({ home, credentials, now = Date.now, inventory, measure, restart, uuid = randomUUID }) {
  const pairingId = Number(credentials.pairingId)
  const { machineId } = credentials
  const load = () => {
    const reg = readAccountRegistry(home)
    if (reg && (reg.machineId !== machineId || reg.pairingId !== pairingId)) return null
    return reg
  }
  const commit = (state) => save(home, state)
  const rowsOf = async (state) => (await inventory()).filter((r) => r.userId === state.ownerUserId)
  const readingFor = async ({ id, label }, model, force = false) => {
    const reading = await measure({ id, label }, model, force).catch(() => null)
    return { id, label, signedIn: reading?.signedIn === true, usage: safeUsage(reading?.usage, now()) }
  }
  const status = (state, target, value) => {
    target.status = value
    state.status = value
    state.statusRpcId = target.rpcId
    state.statusAssistantId = target.assistantId ?? null
    commit(state)
  }
  async function returned(state, target, desired, pin) {
    const row = (await rowsOf(state)).find((r) => r.assistantId === target.assistantId && r.pairingId === target.pairingId)
    return row && row.accountId === desired && row.sessionId === pin
  }
  async function finish(state, target, row, verified) {
    const { desired, previous, pin } = target.transition
    if (verified && (await returned(state, target, desired, pin))) {
      delete target.transition
      delete target.rule
      return status(state, target, 'back_online')
    }
    target.choice = previous
    const first = !target.transition.rollback
    target.transition.rollback = true
    commit(state)
    const ok = first && row && (await restart(row, previous).catch(() => false))
    delete target.transition
    delete target.rule
    return status(state, target, ok === true && (await returned(state, target, previous, pin)) ? 'restored' : 'failed')
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
      return status(state, target, 'needs_sign_in')
    }
    if (row && selected.id !== current) {
      if (!row.ready || !row.sessionId) {
        if (target.status !== 'waiting_for_turn') status(state, target, 'waiting_for_turn')
        return
      }
      target.transition = { desired: selected.id, previous: current, pin: row.sessionId }
      // Preserve the original unmanaged config for a rollback that must
      // override a newer computer default. Never send directory names to HOAI.
      if (current === null) target.originalDir = row.configDir ?? null
      target.choice = selected.id
      status(state, target, 'restarting')
      const verified = await restart(row, selected.id).catch(() => false)
      if (verified?.started === false) {
        target.choice = current
        delete target.transition
        if (!verified.wait) delete target.rule
        return status(state, target, verified.wait ? 'waiting_for_turn' : 'failed')
      }
      await finish(state, target, row, verified === true)
      return true
    }
    target.choice = selected.id
    delete target.rule
    status(state, target, 'saved')
  }
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
        // Nothing was visible to the new pairing before this authenticated
        // press. Keep the owner's saved logins and discard old queued work.
        const state =
          existing?.pairingId === pairingId
            ? existing
            : {
                version: 1,
                machineId,
                pairingId,
                ownerUserId: job.ownerUserId,
                accounts: existing?.accounts ?? [],
                targets: {},
              }
        if (state.receipts?.includes(rpcId)) return
        const accept = () => {
          state.receipts = [...(state.receipts ?? []), rpcId].slice(-64)
        }
        const command = job.accountCommand
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
          return status(state, { rpcId }, 'needs_sign_in')
        }
        if (
          command?.action !== 'assign' ||
          command.mode !== 'now' ||
          !state.accounts.some((a) => a.id === command.accountId)
        )
          return denied()
        const id = command.assistantId
        let pairing
        if (id !== undefined) {
          if (!Number.isSafeInteger(id) || id <= 0 || job.targets.length !== 1 || job.targets[0].assistantId !== id)
            return denied()
          pairing = job.targets[0].pairingId
          if (!(await rowsOf(state)).some((r) => r.assistantId === id && r.pairingId === pairing)) return denied()
        } else if (job.targets.length) return denied()
        const key = id === undefined ? 'computer' : String(id)
        const target = (state.targets[key] ??= {})
        if (Object.values(state.targets).some((t) => t.transition)) throw new Error('job_in_flight')
        Object.assign(target, {
          rpcId,
          status: undefined,
          ...(pairing ? { assistantId: id, pairingId: pairing } : {}),
          rule: { mode: command.mode, ...(command.accountId ? { accountId: command.accountId } : {}) },
        })
        accept()
        commit(state)
        await advance(state, target, key)
      })
    },
    async tick() {
      if (busy) return
      return single(async () => {
        const state = load()
        if (!state) return
        for (const [key, target] of Object.entries(state.targets)) {
          if ((target.transition || target.rule) && (await advance(state, target, key))) break
        }
      })
    },
    async snapshot() {
      const state = load()
      if (!state) return { accounts: [], defaultAccountId: null, agents: [] }
      const computer = state.targets.computer
      const rows = (await rowsOf(state)).filter((r) => Number.isSafeInteger(r.assistantId) && r.assistantId > 0)
      const ids = new Set(state.accounts.map((a) => a.id))
      const accounts = []
      for (let start = 0; start < state.accounts.length; start += 2) {
        const batch = await Promise.all(state.accounts.slice(start, start + 2).map((a) => readingFor(a)))
        for (const account of batch) {
          const windows = account.signedIn && readStatusWindows(profileDirectory(home, account.id), now())
          accounts.push(windows ? { ...account, usageWindows: windows } : account)
        }
      }
      return {
        accounts,
        defaultAccountId: ids.has(computer?.choice) ? computer.choice : null,
        agents: rows.map((row) => {
          const t = state.targets[row.assistantId]
          return {
            assistantId: row.assistantId,
            accountId: ids.has(row.accountId) ? row.accountId : null,
            ...(STATUSES.has(t?.status) ? { status: t.status } : {}),
          }
        }),
        ...(STATUSES.has(state.status) ? { status: state.status } : {}),
        ...(UUID.test(state.statusRpcId) ? { statusRpcId: state.statusRpcId } : {}),
        ...(rows.some((r) => r.assistantId === state.statusAssistantId) ? { statusAssistantId: state.statusAssistantId } : {}),
      }
    },
  }
}
