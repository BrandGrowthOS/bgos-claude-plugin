import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Ticket = { pid: number; ticket: number | null; name: string }
type Scope = { missionId: number; goalId: number }
type Receipt = { token: string; pid: number; working: boolean; uncertain: boolean }
const activeReceipts = new Set<string>()

function goalDirectory(root: string, scope?: Scope): string {
  if (scope && (!Number.isSafeInteger(scope.missionId) || scope.missionId <= 0 ||
    !Number.isSafeInteger(scope.goalId) || scope.goalId <= 0)) throw new Error('Invalid working-mark scope.')
  return scope ? join(root, `${scope.missionId}-${scope.goalId}`) : root
}

/** An unknown write remains a cleanup obligation, even after an acknowledged
 * clear, because the original server operation could still commit later. */
export function hasUnconfirmedWorkingWrite(root: string, scope: Scope): boolean {
  try {
    const receipt: Receipt = JSON.parse(readFileSync(join(goalDirectory(root, scope), 'unconfirmed-write'), 'utf8'))
    return receipt.uncertain || !activeReceipts.has(receipt.token)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

/** A pairing-local bakery queue. Each writer only updates its own unique file.
 * Hold the ticket until HTTP settles so a delayed old clear cannot overtake
 * its successor. Live writers are never evicted on a wall-clock deadline.
 */
export function createMissionWorkingWriteLock(root: string, options: { waitMs?: number } = {}) {
  const readTickets = (directory: string): Ticket[] => {
    const tickets: Ticket[] = []
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const path = join(directory, name)
      let record: { pid?: unknown; ticket?: unknown }
      try {
        record = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error('Working-mark write queue is unreadable.')
      }
      if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
        (record.ticket !== null && (!Number.isSafeInteger(record.ticket) || Number(record.ticket) <= 0))) {
        throw new Error('Working-mark write queue is invalid.')
      }
      const pid = Number(record.pid)
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          // Unique names are never reused, so cleanup cannot unlink a new owner.
          try { unlinkSync(path) } catch (removeError) {
            if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
          }
          continue
        }
        // EPERM or an unknown probe failure is not proof of death.
      }
      tickets.push({ pid, ticket: record.ticket as number | null, name })
    }
    return tickets
  }

  return async <T>(work: () => Promise<T>, scope?: Scope, working = true): Promise<T> => {
    // Each invocation owns its path, including when callers share the factory.
    const target = goalDirectory(root, scope)
    return run(target, work, working)
  }

  async function run<T>(directory: string, work: () => Promise<T>, working: boolean): Promise<T> {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const name = `${process.pid}-${randomUUID()}.json`
    const path = join(directory, name)
    const temp = `${path}.tmp`
    const publish = (ticket: number | null) => {
      writeFileSync(temp, JSON.stringify({ pid: process.pid, ticket }), { mode: 0o600 })
      renameSync(temp, path)
    }
    const deadline = Date.now() + (options.waitMs ?? 30_000)
    try {
      publish(null)
      const ticket = Math.max(0, ...readTickets(directory).map(record => record.ticket ?? 0)) + 1
      if (!Number.isSafeInteger(ticket)) throw new Error('Working-mark write queue is full.')
      publish(ticket)
      for (;;) {
        const waiting = readTickets(directory).some(record => record.name !== name && (
          record.ticket === null || record.ticket < ticket || (record.ticket === ticket && record.name < name)
        ))
        if (!waiting) {
          const fence = join(directory, 'unconfirmed-write')
          const fenced = existsSync(fence)
          if (fenced && working) {
            throw Object.assign(new Error('This goal has an unconfirmed write; a later selection cannot safely replace it.'), { workingWriteFenced: true })
          }
          // Persist BEFORE sending a write, so a timeout or process death
          // cannot let a later mark overtake an unknown remote operation.
          const receipt: Receipt = { token: name, pid: process.pid, working, uncertain: false }
          if (!fenced) {
            activeReceipts.add(name)
            writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 })
            renameSync(temp, fence)
          }
          let acknowledged = false
          try {
            const result = await work()
            acknowledged = true
            return result
          } catch (error) {
            const outcome = error as { status?: unknown; workingWriteNotSent?: boolean }
            acknowledged = typeof outcome?.status === 'number' || outcome?.workingWriteNotSent === true
            if (!fenced && !acknowledged) {
              writeFileSync(temp, JSON.stringify({ ...receipt, uncertain: true }), { mode: 0o600 })
              renameSync(temp, fence)
            }
            throw error
          } finally {
            if (!fenced && acknowledged && JSON.parse(readFileSync(fence, 'utf8')).token === name) unlinkSync(fence)
          }
        }
        if (Date.now() >= deadline) throw new Error('Working-mark write queue timed out.')
        await delay(10)
      }
    } finally {
      activeReceipts.delete(name)
      for (const own of [temp, path]) {
        try { unlinkSync(own) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
}
