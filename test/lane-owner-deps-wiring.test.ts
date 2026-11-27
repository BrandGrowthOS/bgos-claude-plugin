/**
 * THE OWNER'S SWEEP IS WIRED WITH THE DAEMON'S OWN CLAUDE_CONFIG_DIR (fix
 * round 377, re-review C, finding G).
 *
 * A lane on the owner's login keeps its transcripts in the owner's
 * CLAUDE_CONFIG_DIR (lib/lane-supervisor.mjs). The sweep that moves an earlier
 * version's lane folder carries those transcripts only if its deps name that
 * folder; without it the move finds nothing, clears its marker, and the
 * conversation is not found again. These tests run the daemon's own deps
 * object, as server.ts writes it, through the sweep.
 *
 * Run with: npx tsx --test test/lane-owner-deps-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as core from '../lib/lane-core.mjs'
import * as owner from '../lib/lane-owner.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const c: any = core
const o: any = owner
const AGENT = '1076'
const ANA = 'user_Ana'
const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')

/** server.ts's LANE_OWNER_DEPS, evaluated with this daemon's environment and home. */
async function daemonDeps(env: Record<string, string | undefined>, home: string, lines: string[]) {
  const ts = (await import('typescript')).default
  const start = server.indexOf('const LANE_OWNER_DEPS = {')
  assert.ok(start > 0, 'the daemon builds its lane deps in one place')
  const body = server.slice(start, server.indexOf('\n}\n', start) + 3)
  const js = ts.transpileModule(`${body}\nreturn LANE_OWNER_DEPS;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const bindings: Record<string, unknown> = {
    ASSISTANT_ID: AGENT, USER_ID: 'user_owner', homedir: () => home, process: { env }, log: (l: string) => lines.push(l),
  }
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

test('the daemon\'s lane deps carry its CLAUDE_CONFIG_DIR, and the sweep carries a transcript kept there', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-deps-')))
  try {
    const config = join(root, 'owner-claude')
    const lines: string[] = []
    const deps = await daemonDeps({ CLAUDE_CONFIG_DIR: config }, root, lines)
    assert.equal(deps.ownerConfigDir, config)
    // An earlier version's lane of Ana, its pinned session kept in the owner's config tree.
    const paths = c.lanePaths({ home: root, assistantId: AGENT, userId: ANA })
    const oldWork = join(paths.legacyLaneDir, 'work')
    const PIN = '0b9e1a52-3333-4c2d-9a3b-3c4d5e6f7a8b'
    mkdirSync(oldWork, { recursive: true })
    writeFileSync(join(paths.legacyLaneDir, 'session-id'), PIN)
    const before = sessionTranscriptPath(root, oldWork, PIN, config)
    mkdirSync(join(before, '..'), { recursive: true })
    writeFileSync(before, '{"session":"ana"}\n')
    // The daemon's drain tick, with its own deps (nobody runs this lane).
    o.sweepUnsafePersonLanes({ ...deps, fs: nodeFs, isSupervised: () => null })
    assert.equal(readFileSync(sessionTranscriptPath(root, paths.workDir, PIN, config), 'utf8'), '{"session":"ana"}\n', 'found under the new working folder')
    assert.equal(existsSync(before), false)
    assert.ok(lines.some((l) => /1 transcript folder\(s\) moved/.test(l)), lines.join('\n'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the drain tick runs the sweep with those deps', () => {
  assert.match(server, /\n\s*sweepUnsafePersonLanes\(LANE_OWNER_DEPS\)\n/)
})
