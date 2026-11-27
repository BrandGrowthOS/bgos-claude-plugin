/**
 * THE HOST SAYS SO WHEN AN OWED PROFILE DELETION COULD NOT BE WRITTEN TO DISK
 * (fix round 377, re-review C, nit 1).
 *
 * The browser host's people access effects answer a failed close or deletion
 * as not deleted and mark the deletion owed. When the mark cannot reach the
 * disk, the deletion is still owed in this host (person-access.mjs keeps it
 * in memory), and the host's log says that it could not be recorded. These
 * tests run the host's own effects with a disk that refuses the write, so a
 * swallowed failure, however it is spelled, leaves the log without its line.
 *
 * Run with: npx tsx --test test/host-owed-deletion-log.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHost } from '../bin/hoai-browser-host.mjs'
import * as personAccess from '../lib/person-access.mjs'

const pa: any = personAccess
const AGENT = '1076'
const OWNER = 'user_owner'
const LEO = 'user_leo'

function hostWith(agentRoot: string, deleted: boolean) {
  const lines: string[] = []
  const fake = {
    agentRoot,
    pool: { peek: () => null },
    connectionFor: () => ({ pairing: { ownerUserId: OWNER } }),
    _deleteProfileNow: async () => deleted,
    _log: (line: string) => lines.push(line),
  }
  const effects = (BrowserHost.prototype as any)._accessEffects.call(fake, AGENT)
  return { effects, lines }
}

test('a failed deletion whose mark cannot be written is logged as not recorded, answered false, and still owed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-owed-')))
  try {
    // The agent root is a plain file: no folder can be made under it.
    const agentRoot = join(root, 'not-a-folder')
    writeFileSync(agentRoot, 'x')
    const { effects, lines } = hostWith(agentRoot, false)
    assert.equal(await effects.deleteProfile(LEO), false)
    assert.ok(lines.some((l) => /could not be recorded on disk \([a-z_A-Z]+\)/.test(l)), lines.join('\n'))
    assert.ok(!lines.some((l) => /this is tried again, and that browser does not open until it is done/.test(l)), 'it never says it was recorded')
    assert.equal(pa.profileDeletePending({ agentRoot, assistantId: AGENT, userId: LEO }), true, 'owed in this host')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed deletion whose mark is written says it is tried again', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-owed-')))
  try {
    const { effects, lines } = hostWith(root, false)
    assert.equal(await effects.deleteProfile(LEO), false)
    assert.ok(lines.some((l) => /this is tried again, and that browser does not open until it is done/.test(l)), lines.join('\n'))
    assert.equal(pa.profileDeletePending({ agentRoot: root, assistantId: AGENT, userId: LEO }), true)
    // The owner is never a person who lost access.
    assert.equal(await effects.deleteProfile(OWNER), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
