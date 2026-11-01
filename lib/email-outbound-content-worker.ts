// ── Agent email files, outbound: the content Worker (review rounds 7 and 8) ──
//
// lib/email-outbound-files.ts keeps ONE of these worker threads alive and reuses it for every file to attach (round
// 8: under bun a Worker's memory is not given back when it ends): it posts one job at a time, each with its own id and
// the file's bytes (transferred, not copied), and terminates the Worker at the job's hard deadline whatever it is
// doing, so no input can keep the daemon's main thread busy. For each job this runs the whole content stage
// (lib/email-outbound-content.ts) and posts back the job's id, the verdict and the same bytes (transferred again).
// Round 9: the stage keeps its own budget (sized from the larger of the file and its words) and answers 'unsafe' past
// it, so a slow file is refused by this Worker, which then takes the next file; the hard deadline ends after that
// budget. Anything else (it cannot start, it throws at load, it exits, it is late, its reply does not parse or has
// another id) refuses that file on the main thread as "could not be read safely", and the next file gets a new
// Worker, at most OUTBOUND_CONTENT_WORKERS_MAX in the daemon's life (round 9).
//
// It runs under bun (the daemon runs server.ts with bun) and under node with tsx (the tests): both load a .ts worker
// from its file URL (new URL('./email-outbound-content-worker.ts', import.meta.url)). Under node its stdout and stderr
// are its own streams (the main thread asks for them with stdout: true and stderr: true), which the main thread leaves
// unread, and this Worker writes nothing to them (round 9: the comment said they were read; they are not, since a
// stream being read keeps the process alive). Under bun they are NOT its own: bun ignores the Worker's stdout option
// and a Worker's console writes to the daemon's own stdout, the MCP channel. So the first import silences every
// console method and every process.stdout and process.stderr write in this thread
// (lib/email-outbound-content-quiet.ts), before any other module of the Worker runs.
//
// No em or en dashes in this file.

import './email-outbound-content-quiet.ts'

import { parentPort } from 'node:worker_threads'

import { outboundContentVerdict, type ContentType, type ContentVerdict } from './email-outbound-content.ts'

/** What the main thread posts: the job's id, the file's bytes (the first `length` of `buffer`), its type, its name and the secrets. */
interface ContentJob {
  id: number
  buffer: ArrayBuffer
  length: number
  type: ContentType
  name: string
  secrets: string[]
  /** Round 9: the stage's budget in ms, when a test fixes it; left out, it is sized from the file and its words. */
  budgetMs?: number
}

async function runJob(job: ContentJob): Promise<void> {
  let verdict: ContentVerdict
  try {
    const budgetMs = typeof job.budgetMs === 'number' ? job.budgetMs : undefined
    verdict = await outboundContentVerdict(new Uint8Array(job.buffer, 0, job.length), job.type, job.name, job.secrets, budgetMs)
  } catch {
    // A check that throws has not read the file: refused, never passed.
    verdict = { kind: 'unsafe' }
  }
  try {
    parentPort!.postMessage({ id: job.id, verdict, buffer: job.buffer, length: job.length }, [job.buffer])
  } catch {
    // A job whose bytes cannot go back: the reply without them does not parse, so the main thread refuses the file.
    parentPort!.postMessage({ id: job?.id, verdict: { kind: 'unsafe' } })
  }
}

// One job at a time, in the order they came (the main thread sends the next only after this one's reply).
//
// Round 9: the listener stays SYNC, and its chain ends in .catch. Under bun 1.3.9 a rejected promise returned by an
// async 'message' listener is an uncaught error that ends the whole process, the daemon with it, not only this Worker
// (measured: an async listener that throws ends the parent before its next timer). runJob catches every check's throw
// itself; the .catch is for anything that still gets through (a postMessage of the fallback reply that throws). A test
// pins this shape (test/email-outbound-files.test.ts, round 9).
let turn: Promise<void> = Promise.resolve()
parentPort?.on('message', (job: ContentJob) => {
  turn = turn.then(() => runJob(job)).catch(() => {})
})
