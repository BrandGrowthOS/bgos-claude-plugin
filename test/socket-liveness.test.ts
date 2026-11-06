import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { io, type Manager } from 'socket.io-client'
import { SOCKET_LIVENESS_GRACE_MS, watchSocketLiveness } from '../lib/socket-liveness.ts'

function fixture(t: TestContext, pingInterval = 10_000) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const manager = new EventEmitter() as EventEmitter & { engine: ReturnType<typeof engine> }
  const logs: string[] = []
  let closes = 0
  function engine(interval: number) {
    return Object.assign(new EventEmitter(), {
      _pingInterval: interval,
      readyState: 'open',
      transport: { close() { closes++; manager.engine.readyState = 'closed'; manager.engine.emit('close') } },
    })
  }
  manager.engine = engine(pingInterval)
  const stop = watchSocketLiveness(manager as unknown as Manager, (line) => logs.push(line))
  t.after(stop)
  return {
    manager, logs, closes: () => closes,
    tick: (ms: number) => t.mock.timers.tick(ms),
    packet: (type: string) => manager.engine.emit('packet', { type }),
    nextEngine(interval = pingInterval) { manager.engine = engine(interval); manager.emit('open') },
    stop,
  }
}

test('silent socket is closed once within 15 seconds, before the native 40 second timeout', (t) => {
  const f = fixture(t)
  f.tick(14_999)
  assert.equal(f.closes(), 0)
  f.tick(1)
  assert.equal(f.closes(), 1)
  assert.deepEqual(f.logs, ['WS dead link: no incoming packet for 15000ms; reconnecting'])
  f.tick(300_000)
  assert.equal(f.closes(), 1)
  assert.equal(f.logs.length, 1)
})

test('healthy idle sockets keep their advertised heartbeat, including longer server intervals', (t) => {
  const f = fixture(t, 25_000)
  for (let ping = 0; ping < 100; ping++) {
    f.tick(25_000)
    f.packet('ping')
  }
  assert.equal(f.closes(), 0)
  assert.equal(f.logs.length, 0)
})

for (const type of ['ping', 'pong', 'message', 'noop']) {
  test(`an incoming ${type} packet resets liveness`, (t) => {
    const f = fixture(t)
    f.tick(14_000)
    f.packet(type)
    f.tick(14_999)
    assert.equal(f.closes(), 0)
    f.tick(1)
    assert.equal(f.closes(), 1)
  })
}

test('old engines and repeated open notifications cannot create parallel watchdogs', (t) => {
  const f = fixture(t)
  const old = f.manager.engine
  f.tick(14_000)
  f.nextEngine(30_000)
  f.manager.emit('open')
  f.tick(20_000)
  old.emit('close')
  old.emit('packet', { type: 'ping' })
  f.tick(14_999)
  assert.equal(f.closes(), 0)
  f.tick(1)
  assert.equal(f.closes(), 1)
  assert.equal(old.listenerCount('packet'), 0)
  assert.equal(old.listenerCount('close'), 0)
  f.tick(300_000)
  assert.equal(f.closes(), 1)
})

test('normal close and disposal cancel timers without initiating reconnects', (t) => {
  const f = fixture(t)
  f.manager.engine.readyState = 'closed'
  f.manager.engine.emit('close')
  f.tick(60_000)
  assert.equal(f.closes(), 0)
  f.nextEngine()
  f.stop()
  f.stop()
  f.tick(60_000)
  f.manager.emit('open')
  f.tick(60_000)
  assert.equal(f.closes(), 0)
  assert.equal(f.manager.listenerCount('open'), 0)
  assert.equal(f.manager.engine.listenerCount('packet'), 0)
})

test('unknown handshake timing is never guessed into a healthy-link reconnect loop', (t) => {
  const f = fixture(t, Number.NaN)
  f.tick(300_000)
  assert.equal(f.closes(), 0)
  assert.equal(f.logs.length, 0)
  assert.equal(SOCKET_LIVENESS_GRACE_MS, 5_000)
})

test('the daemon installs liveness on its existing Socket.IO manager', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.ok(/import \{ watchSocketLiveness \} from '\.\/lib\/socket-liveness\.js'/.test(source))
  const body = source.slice(source.indexOf('function connectWebsocket(): void {'))
  assert.ok(/watchSocketLiveness\(realtimeSocket\.io, log\)/.test(body))
})

test('a real negotiated handshake recovers a stalled write through one jittered Manager reconnect', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const http = createServer()
  let hold = false
  let release: (() => void) | undefined
  let handshakes = 0
  let inFlight = 0
  let maxInFlight = 0
  let onHeld: () => void = () => {}
  const held = new Promise<void>((resolve) => { onHeld = resolve })
  const backend = new Server(http, {
    pingInterval: 10_000, pingTimeout: 30_000,
    allowRequest: (_request, done) => {
      handshakes++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const accept = () => { inFlight--; done(null, true) }
      if (hold) { release = accept; onHeld() } else accept()
    },
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const socket = io(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
    autoConnect: false, transports: ['websocket'], useNativeTimers: true,
    reconnectionDelay: 40, reconnectionDelayMax: 160, randomizationFactor: 0.5,
  })
  const logs: string[] = []
  const stop = watchSocketLiveness(socket.io, (line) => logs.push(line))
  t.after(async () => {
    stop()
    socket.disconnect()
    release?.()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  })
  let connects = 0
  let attempts = 0
  socket.on('connect', () => { connects++ })
  socket.io.on('reconnect_attempt', () => { attempts++ })
  const firstConnect = new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.connect()
  await firstConnect
  assert.equal(handshakes, 1)

  // A real wire event resets the watchdog on the fake clock after the handshake.
  const activity = new Promise<void>((resolve) => socket.once('activity', resolve))
  backend.emit('activity')
  await activity
  const oldEngine = socket.io.engine
  oldEngine.transport.writable = false
  oldEngine.writeBuffer.push({ type: 'message', data: 'stalled write' })
  hold = true
  const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve))
  t.mock.timers.tick(14_999)
  assert.equal(socket.connected, true)
  t.mock.timers.tick(1)
  assert.equal(await disconnected, 'transport close')
  assert.equal(oldEngine.readyState, 'closed', 'does not wait for the write buffer to drain')
  assert.equal(attempts, 0, 'recovery waits for the existing jittered backoff')
  await held
  assert.equal(attempts, 1)
  assert.equal(handshakes, 2)
  t.mock.timers.tick(300_000)
  assert.equal(attempts, 1, 'one reconnect remains in flight throughout the silent period')
  assert.equal(logs.length, 1)
  assert.equal(maxInFlight, 1)
  const recovered = new Promise<void>((resolve) => socket.once('connect', resolve))
  hold = false
  // A new handshake may advertise a different interval.
  backend.engine.opts.pingInterval = 25_000
  release!()
  release = undefined
  await recovered
  assert.equal(connects, 2)
  assert.notEqual(socket.io.engine, oldEngine)
  t.mock.timers.tick(25_000)
  assert.equal(socket.connected, true, 'the new advertised interval is respected')
  assert.equal(logs.length, 1)
})
