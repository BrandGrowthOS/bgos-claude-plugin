/**
 * Preloaded into every node:test file by scripts/run-test-files.mjs.
 *
 * The TAP reporter only writes on an event loop turn, and a synchronous test
 * body (spawnSync, the bash installer suites) never gives it one. Without this
 * hook a whole file's results arrive together at its end, and the runner's
 * watchdog, which reads completed tests as progress, kills a healthy slow file.
 *
 * The real setImmediate is kept here because a test may mock the global one.
 */
import { afterEach } from 'node:test'

const realSetImmediate = globalThis.setImmediate
afterEach(() => new Promise((resolve) => realSetImmediate(resolve)))
