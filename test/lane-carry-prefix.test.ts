/**
 * A LANE'S TRANSCRIPT MOVE TAKES ONLY ITS OWN PROJECT FOLDERS (fix round 377,
 * re-review C, nit 2).
 *
 * Claude names a project folder by its working folder with every character
 * but a letter or a digit turned into `-`, so `user_Ab` and `user-Ab`, or
 * `user_Ab` and `user_Ab-work`, can name the same folder or one that starts
 * with the other's name. The rule: the move takes the lane's own working
 * folder and its threads (`<work>/.hoai/threads/...`) and nothing else, and a
 * name another person's earlier folder beside it could also have made is left
 * where it is.
 *
 * Run with: npx tsx --test test/lane-carry-prefix.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as core from '../lib/lane-core.mjs'
import { mungeSessionCwd } from '../bin/hoai-core.mjs'

const c: any = core
const AGENT = '1076'

function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-carry-')))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

function project(config: string, cwd: string): string {
  const dir = join(config, 'projects', mungeSessionCwd(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 's.jsonl'), cwd)
  return dir
}

test('another person whose id starts with this one keeps their own project folders', async () => {
  const h = home()
  try {
    const carry: any = await import('../lib/lane-carry.mjs')
    const config = join(h.root, 'owner-claude')
    const ab = c.lanePaths({ home: h.root, assistantId: AGENT, userId: 'user_Ab' })
    const abWork = c.lanePaths({ home: h.root, assistantId: AGENT, userId: 'user_Ab-work' })
    const mine = project(config, join(ab.legacyLaneDir, 'work'))
    const myThread = project(config, join(ab.legacyLaneDir, 'work', '.hoai', 'threads', '7'))
    // Their working folder, and a thread of theirs: both names start with this lane's.
    const theirs = project(config, join(abWork.legacyLaneDir, 'work'))
    const theirThread = project(config, join(abWork.legacyLaneDir, 'work', '.hoai', 'threads', '7'))
    mkdirSync(join(ab.legacyLaneDir, 'work'), { recursive: true })
    const opened = carry.openLaneFoldersCarried({ paths: ab, userId: 'user_Ab', fs: nodeFs, home: h.root, ownerConfigDir: config })
    assert.equal(opened.carried, 2, 'this lane\'s folder and its thread')
    assert.equal(existsSync(mine), false)
    assert.equal(existsSync(myThread), false)
    assert.ok(existsSync(join(config, 'projects', mungeSessionCwd(ab.workDir), 's.jsonl')))
    assert.ok(existsSync(theirs), 'their working folder stays')
    assert.ok(existsSync(theirThread), 'their thread stays')
  } finally { h.done() }
})

test('a name another person\'s earlier folder makes too is left where it is', async () => {
  const h = home()
  try {
    const carry: any = await import('../lib/lane-carry.mjs')
    const config = join(h.root, 'owner-claude')
    const underscore = c.lanePaths({ home: h.root, assistantId: AGENT, userId: 'user_Ab' })
    const dash = c.lanePaths({ home: h.root, assistantId: AGENT, userId: 'user-Ab' })
    // Both earlier folders are still there: their working folders make one name.
    mkdirSync(join(underscore.legacyLaneDir, 'work'), { recursive: true })
    mkdirSync(join(dash.legacyLaneDir, 'work'), { recursive: true })
    assert.equal(mungeSessionCwd(join(underscore.legacyLaneDir, 'work')), mungeSessionCwd(join(dash.legacyLaneDir, 'work')))
    const shared = project(config, join(underscore.legacyLaneDir, 'work'))
    const opened = carry.openLaneFoldersCarried({ paths: underscore, userId: 'user_Ab', fs: nodeFs, home: h.root, ownerConfigDir: config })
    assert.equal(opened.carried, 0)
    assert.ok(existsSync(shared), 'nobody\'s move takes a folder that may be the other person\'s')
  } finally { h.done() }
})
