#!/usr/bin/env node
/**
 * hoai-statusline-bridge: the status line command the Helper's launcher (or
 * `hoai-model-control on`) installs in one agent's own folder settings
 * (lib/model-control-store.mjs explains why). `--agent <id>` names the agent
 * whose wrapped line it runs; without it, the machine wide one an older
 * install wrote.
 *
 * Claude Code runs it with its own session JSON on stdin. It stores the
 * session's model and effort as one numbered observation in the owner only
 * model control folder, then runs the owner's own status line command, if
 * there was one, with the same stdin, and prints what that prints. It never
 * fails the status line: any error is swallowed and it exits 0.
 */
import { spawnSync } from 'node:child_process'

import {
  STATUS_INPUT_MAX_BYTES,
  modelControlDir,
  parseStatusLineInput,
  readWrappedStatusLine,
  recordObservation,
} from '../lib/model-control-store.mjs'

function readStdin() {
  const chunks = []
  let size = 0
  return new Promise((resolve) => {
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size <= STATUS_INPUT_MAX_BYTES + 1) chunks.push(chunk)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

const at = process.argv.indexOf('--agent')
const agent = at >= 0 ? process.argv[at + 1] : undefined
const raw = await readStdin()
const dir = modelControlDir()
try {
  const facts = parseStatusLineInput(raw)
  if (facts) recordObservation(dir, facts, Date.now())
} catch {
  /* an observation is best effort; the owner's status line still prints */
}
try {
  const wrapped = agent === undefined ? readWrappedStatusLine(dir) : readWrappedStatusLine(dir, agent)
  if (wrapped) {
    const run = spawnSync(wrapped.command, {
      input: raw,
      shell: true,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    })
    if (typeof run.stdout === 'string') process.stdout.write(run.stdout)
  }
} catch {
  /* never fail the status line */
}
process.exit(0)
