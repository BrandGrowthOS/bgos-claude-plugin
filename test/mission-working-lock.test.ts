import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../lib/mission-working-lock.ts', import.meta.url)
const gateModule: any = existsSync(moduleUrl) ? await import(moduleUrl.href) : {}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'child process must reach its barrier')
    await wait(10)
  }
}
function setup(t: any) {
  assert.equal(typeof gateModule.createMissionWorkingWriteLock, 'function')
  const root = mkdtempSync(join(tmpdir(), 'working-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, lock: join(root, 'queue'), make: gateModule.createMissionWorkingWriteLock }
}

test('the pairing write lock holds through async completion and releases after rejection', async t => {
  const { lock, make } = setup(t)
  const a = make(lock), b = make(lock)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const first = a(async () => { order.push('A'); await barrier; throw Object.assign(new Error('refused'), { status: 503 }) })
  const rejected = assert.rejects(first, /refused/)
  await until(() => order.length === 1)
  const second = b(async () => { order.push('B') })
  await wait(50)
  assert.deepEqual(order, ['A'])
  release()
  await Promise.all([rejected, second])
  assert.deepEqual(order, ['A', 'B'])
  assert.deepEqual(readdirSync(lock), [], 'completed operations leave no queue records')
})

for (const crossTimezone of [false, true]) {
test(`two real processes cannot deliver a successor write before an older delayed clear, different timezones=${crossTimezone}`, async t => {
  const { root, lock } = setup(t)
  const log = join(root, 'order'), ready = join(root, 'ready'), release = join(root, 'release')
  const contenderReady = join(root, 'contender-ready')
  const children: ReturnType<typeof spawn>[] = []
  t.after(() => { for (const child of children) child.kill() })
  const run = (name: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      import { createMissionWorkingWriteLock } from ${JSON.stringify(moduleUrl.href)};
      const pending = createMissionWorkingWriteLock(${JSON.stringify(lock)})(async () => {
        appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}:start\n`)});
        if (${JSON.stringify(name)} === 'A') {
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          while (!existsSync(${JSON.stringify(release)})) await delay(10);
        }
        appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}:finish\n`)});
      }, undefined, ${JSON.stringify(crossTimezone && name === 'A')});
      // The gate runs synchronously until it yields on contention. If waiting
      // is broken, B has already entered the transport before this barrier.
      if (${JSON.stringify(name)} === 'B') writeFileSync(${JSON.stringify(contenderReady)}, 'ready');
      await pending;
    `], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: crossTimezone && name === 'B' ? 'Asia/Dubai' : 'UTC' } })
    children.push(child)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    return new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child failed: ${code}: ${output}`)))
    })
  }
  const settle = (promise: Promise<void>) => promise.then(() => '', error => String(error))
  const first = settle(run('A'))
  await until(() => existsSync(ready))
  const second = settle(run('B'))
  await until(() => existsSync(contenderReady))
  assert.equal(readFileSync(log, 'utf8'), 'A:start\n')
  writeFileSync(release, 'go')
  assert.deepEqual(await Promise.all([first, second]), ['', ''], 'both processes must complete successfully')
  assert.equal(readFileSync(log, 'utf8'), 'A:start\nA:finish\nB:start\nB:finish\n')
})
}

test('a dead process queue record is removed, including an interrupted ticket choice', async t => {
  const { lock, make } = setup(t)
  // Establish the directory using the public gate, then simulate a process
  // whose PID was reaped before it could remove its unique records.
  await make(lock)(async () => {})
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', () => resolve()) })
  for (const ticket of [null, 1]) {
    const path = join(lock, `${pid}-dead-${ticket}.json`)
    writeFileSync(path, JSON.stringify({ pid, ticket }))
    let ran = false
    await assert.doesNotReject(make(lock, { waitMs: 50 })(async () => { ran = true }))
    assert.equal(ran, true)
    assert.equal(existsSync(path), false)
  }
})

test('a live holder is never evicted by timeout and a waiting operation sends nothing', async t => {
  const { lock, make } = setup(t)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let entered = false
  const holding = make(lock)(async () => { entered = true; await barrier })
  await until(() => entered)
  let sent = false
  try {
    await assert.rejects(make(lock, { waitMs: 50 })(async () => { sent = true }), /timed out/i)
    assert.equal(sent, false)
  } finally {
    release()
    await holding
  }
  assert.deepEqual(readdirSync(lock), [])
})

for (const ticket of [null, 1]) {
  for (const working of [true, false]) {
    test(`a reused live PID cannot block working=${working} with an orphan ticket=${ticket}`, async t => {
      const { lock, make } = setup(t)
      const scope = { missionId: 77, goalId: 3 }
      const directory = join(lock, '77-3')
      let previous: { incarnation?: string } = {}
      await make(lock)(async () => {
        const name = readdirSync(directory).find(name => name.endsWith('.json'))!
        previous = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      }, scope)
      const orphan = join(directory, `${process.pid}-old-incarnation.json`)
      // The PID is live again, but belongs to a different process incarnation.
      writeFileSync(orphan, JSON.stringify({ pid: process.pid,
        incarnation: previous.incarnation ? `${previous.incarnation}:previous` : undefined, ticket }))
      const writes: boolean[] = []
      await assert.doesNotReject(make(lock, { waitMs: 50 })(async () => { writes.push(working) }, scope, working))
      assert.deepEqual(writes, [working])
      assert.equal(existsSync(orphan), false)
      assert.deepEqual(readdirSync(directory), [], 'no HTTP uncertainty exists for a choosing or queued orphan')
    })
  }
}

test('reclaiming a reused PID queue ticket retains its independent uncertain HTTP receipt', async t => {
  const { lock, make } = setup(t)
  const scope = { missionId: 77, goalId: 3 }
  await make(lock)(async () => {}, scope)
  const directory = join(lock, '77-3')
  writeFileSync(join(directory, `${process.pid}-old-incarnation.json`), JSON.stringify({
    pid: process.pid, incarnation: 'previous-process-start', ticket: null,
  }))
  const receipt = JSON.stringify({ token: 'old-http-write', pid: process.pid, working: true, uncertain: true })
  writeFileSync(join(directory, 'unconfirmed-write'), receipt)
  const writes: boolean[] = []
  const gate = make(lock, { waitMs: 50 })
  await assert.rejects(gate(async () => { writes.push(true) }, scope, true), /unconfirmed write/i)
  await gate(async () => { writes.push(false) }, scope, false)
  assert.deepEqual(writes, [false], 'safe cleanup proceeds but replacement stays fenced')
  assert.equal(readFileSync(join(directory, 'unconfirmed-write'), 'utf8'), receipt)
})

test('ticket selection waits for a live choosing record before comparing order', async t => {
  const { lock, make } = setup(t)
  await make(lock)(async () => {})
  const choosing = join(lock, `${process.pid}-choosing.json`)
  writeFileSync(choosing, JSON.stringify({ pid: process.pid, ticket: null }))
  let entered = false
  const pending = make(lock)(async () => { entered = true })
  await wait(30)
  assert.equal(entered, false)
  writeFileSync(choosing, JSON.stringify({ pid: process.pid, ticket: 2 }))
  await pending
  assert.equal(entered, true)
})

test('one goal can proceed while another goal holds its write gate', async t => {
  const { lock, make } = setup(t)
  const gate = make(lock)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let holding = false, otherFinished = false
  const first = gate(async () => { holding = true; await barrier }, { missionId: 77, goalId: 3 })
  await until(() => holding)
  const second = gate(async () => { otherFinished = true }, { missionId: 77, goalId: 4 })
  try {
    await Promise.race([second, wait(100)])
    assert.equal(otherFinished, true)
  } finally {
    release()
    await Promise.all([first, second])
  }
})

for (const status of [400, 403, 404, 409, 503]) {
  test(`an acknowledged ${status} clear refusal releases its receipt`, async t => {
    const { lock, make } = setup(t)
    const gate = make(lock), scope = { missionId: 77, goalId: 3 }
    await assert.rejects(gate(async () => { throw Object.assign(new Error('refused'), { status }) }, scope, false))
    let sent = false
    await gate(async () => { sent = true }, scope, true)
    assert.equal(sent, true)
  })
}

test('an unsent clear does not leave a false uncertainty fence', async t => {
  const { lock, make } = setup(t)
  const gate = make(lock), scope = { missionId: 77, goalId: 3 }
  await assert.rejects(gate(async () => { throw Object.assign(new Error('no authority'), { workingWriteNotSent: true }) }, scope, false))
  await gate(async () => {}, scope, true)
})

for (const working of [false, true]) {
test(`death during a ${working ? 'true write' : 'clear'} preserves its fence after dead queue records are removed`, async t => {
  const { root, lock, make } = setup(t)
  const ready = join(root, 'ready')
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { createMissionWorkingWriteLock } from ${JSON.stringify(moduleUrl.href)};
    await createMissionWorkingWriteLock(${JSON.stringify(lock)})(async () => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      await new Promise(() => { setInterval(() => {}, 1000) });
    }, { missionId: 77, goalId: 3 }, ${working});
  `], { stdio: 'ignore', env: process.env })
  t.after(() => child.kill())
  const exited = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', () => resolve()) })
  await until(() => existsSync(ready))
  child.kill()
  await exited
  let sent = false
  await assert.rejects(make(lock)(async () => { sent = true }, { missionId: 77, goalId: 3 }, true), /unconfirmed write/i)
  assert.equal(sent, false)
  await make(lock)(async () => { sent = true }, { missionId: 77, goalId: 4 }, true)
  assert.equal(sent, true, 'the fence applies only to its own goal')
})
}

test('an inherited receipt stays unconfirmed even when its PID has been reused', async t => {
  const { lock, make } = setup(t)
  const scope = { missionId: 77, goalId: 3 }
  await make(lock)(async () => {
    assert.equal(gateModule.hasUnconfirmedWorkingWrite(lock, scope), false, 'the current request is still in progress')
  }, scope, true)
  writeFileSync(join(lock, '77-3', 'unconfirmed-write'), JSON.stringify({
    token: 'dead-writer-token', pid: process.pid, working: true, uncertain: false,
  }))
  assert.equal(gateModule.hasUnconfirmedWorkingWrite(lock, scope), true, 'PID liveness cannot confirm an inherited request')
  await make(lock)(async () => {
    assert.equal(gateModule.hasUnconfirmedWorkingWrite(lock, scope), true)
  }, scope, false)
  assert.equal(gateModule.hasUnconfirmedWorkingWrite(lock, scope), true)
})
