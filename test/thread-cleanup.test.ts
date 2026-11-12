/**
 * A closed thread leaves nothing on the agent's computer (0.88.0, the owner's
 * "make sure when thread is closed the space it took is cleaned up as well so
 * we dont bloat the machines").
 *
 * Closing (the owner closes it, or merges it back) removes the thread's
 * worktree (git worktree remove and prune), its branch when the branch holds
 * nothing that is in no other branch, its forked session's files, its temp
 * files and its lane state, and logs the bytes freed. A sweep when the daemon
 * starts removes what a crash left of threads that are already closed. A
 * thread that is still open, and everything of the main session, is never
 * touched. Every dependency is a fake (test/helpers/thread-lane-rig.ts).
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'

import {
  AGENT, CONFIG, COPY_ID, FORK_A, FORK_B, MAIN, PLUGIN_STATE, STATE, WINDOWS, flush, projectDir, rig, tempDir, transcript, turn, wt,
} from './helpers/thread-lane-rig.ts'

const POSIX = { skip: WINDOWS ? 'the lane Bash sandbox is POSIX only' : false }
const owner = (rootId: string, over = {}) => turn(rootId, { opener: 'owner', ...over } as never)

/** A confined thread with a worktree that ran one turn and is idle, its process gone. */
async function confinedThread(r: ReturnType<typeof rig>, rootId = '101', fork = FORK_A) {
  r.manager.turn(turn(rootId))
  await r.manager.idle()
  const child = r.spawned.at(-1)!.child
  child.init(fork)
  r.sessionFiles(wt(rootId), fork)
  child.result('Done.')
  await r.manager.idle()
  child.exit(0)
  await flush()
  return child
}

/** A full access thread that ran one turn and is idle, its process gone. */
async function fullThread(r: ReturnType<typeof rig>, rootId = '101', fork = FORK_A) {
  r.manager.turn(owner(rootId))
  await r.manager.idle()
  const child = r.spawned.at(-1)!.child
  child.init(fork)
  r.sessionFiles(AGENT, fork)
  child.result('Done.')
  await r.manager.idle()
  child.exit(0)
  await flush()
  return child
}

/** Everything a thread could have left, anywhere. */
function leftovers(r: ReturnType<typeof rig>, rootId: string, fork: string): string[] {
  return [
    ...r.left(wt(rootId)),
    ...r.left(projectDir(wt(rootId))),
    ...r.left(join(projectDir(AGENT), fork)),
    ...[transcript(AGENT, fork)].filter((p) => r.files.has(p)),
    ...r.left(join(CONFIG, 'session-env', fork)),
    ...r.left(join(CONFIG, 'file-history', fork)),
    ...r.left(tempDir(wt(rootId), fork)),
    ...r.left(tempDir(AGENT, fork)),
    ...r.left(join(PLUGIN_STATE, 'hooks', fork)),
    ...[join(STATE, `${rootId}.json`), join(STATE, `${rootId}.undelivered.txt`)].filter((p) => r.files.has(p)),
  ]
}

test('closing a thread leaves no worktree, no session file, no temp folder and no lane state', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  assert.ok(leftovers(r, '101', FORK_A).length > 8, 'before the close the thread holds a worktree, a session and temp files')
  assert.deepEqual(await r.manager.close({ rootId: '101', removeWorktree: false }), { stopped: true })
  await r.manager.idle()
  assert.deepEqual(leftovers(r, '101', FORK_A), [])
  assert.ok(r.gitCalls.some((c) => c.slice(2, 4).join(' ') === 'worktree remove' && c.at(-1) === wt('101')), 'git worktree remove')
  assert.ok(r.git.pruned >= 1, 'and git worktree prune')
  assert.equal(r.git.branches.has('hoai/thread-101'), false, 'its branch held nothing of its own, so it went too')
  assert.equal(r.files.get(r.mainPath), '{"main":true}\n', 'the main session\'s transcript is untouched')
})

test('the close log line reports the bytes freed', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  // Everything but the lane's own small state file, which is not counted.
  const bytes = leftovers(r, '101', FORK_A).filter((p) => r.files.has(p) && !p.startsWith(STATE)).reduce((n, p) => n + r.files.get(p)!.length, 0)
  assert.ok(bytes > 9000, 'a worktree, a transcript and temp files')
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  const line = r.logs.find((l) => /thread 101 closed/.test(l))
  assert.ok(line, r.logs.join(' | '))
  assert.match(line!, new RegExp(`freed ${bytes} bytes`))
  assert.match(line!, /\(\d+ KB\)/)
})

test('a branch that holds commits found in no other branch is kept, and the owner is told; the worktree still goes', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  r.git.branches.set('hoai/thread-101', 'c-thread-only')
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  assert.equal(r.git.branches.get('hoai/thread-101'), 'c-thread-only', 'unmerged and unpushed work is never deleted')
  assert.deepEqual(r.left(wt('101')), [], 'the checkout itself is removed')
  assert.equal(r.files.has(join(STATE, '101.json')), false)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]!.branch, 'hoai/thread-101')
  assert.equal(r.kept[0]!.rootId, '101')
  assert.match(r.logs.find((l) => /thread 101 closed/.test(l))!, /kept the branch hoai\/thread-101/)
})

test('a branch whose commits are merged or pushed is removed without a word to the owner', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  r.git.branches.set('hoai/thread-101', 'c-pushed')
  r.git.shared.add('c-pushed')
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  assert.equal(r.git.branches.has('hoai/thread-101'), false)
  assert.deepEqual(r.kept, [])
})

test('uncommitted changes in the worktree are saved as a commit on the thread\'s branch before the worktree goes, and the branch is kept', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  r.git.dirty.add(wt('101'))
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  assert.equal(r.git.commits.length, 1)
  assert.equal(r.git.commits[0]!.folder, wt('101'))
  assert.deepEqual(r.left(wt('101')), [])
  assert.equal(r.git.branches.get('hoai/thread-101'), 'saved-101')
  assert.equal(r.kept.length, 1)
  assert.match(String(r.kept[0]!.reason), /uncommitted/)
})

test('uncommitted changes that cannot be saved keep the worktree and the branch, said plainly, and everything else still goes', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  r.git.dirty.add(wt('101'))
  r.git.commitFails = true
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  assert.ok(r.files.has(join(wt('101'), 'checkout.bin')), 'the only copy of that work is never thrown away')
  assert.equal(r.git.branches.has('hoai/thread-101'), true)
  assert.equal(r.files.has(transcript(wt('101'), FORK_A)), false, 'the session files still go')
  assert.equal(r.kept.length, 1)
  assert.match(String(r.kept[0]!.reason), /could not be saved/)
  assert.equal(r.kept[0]!.folder, wt('101'))
})

test('deleting a thread removes its branch whatever it holds, as before', POSIX, async () => {
  const r = rig()
  await confinedThread(r)
  r.git.branches.set('hoai/thread-101', 'c-thread-only')
  await r.manager.close({ rootId: '101', removeWorktree: true })
  await r.manager.idle()
  assert.equal(r.git.branches.has('hoai/thread-101'), false)
  assert.deepEqual(leftovers(r, '101', FORK_A), [])
  assert.deepEqual(r.kept, [])
})

test('closing a full access thread removes its forked session and temp files, and nothing of the main session beside them', async () => {
  const r = rig({ fullAccess: true })
  r.sessionFiles(AGENT, MAIN)
  r.files.set(r.mainPath, '{"main":true}\n')
  const other = transcript(AGENT, FORK_B)
  r.files.set(other, '{"another session of the owner":true}\n')
  r.files.set(join(projectDir(AGENT), 'memory', 'MEMORY.md'), 'notes')
  await fullThread(r)
  const mainFiles = [...r.left(join(projectDir(AGENT), MAIN)), ...r.left(join(CONFIG, 'session-env', MAIN)), ...r.left(tempDir(AGENT, MAIN)), ...r.left(join(PLUGIN_STATE, 'hooks', MAIN))]
  assert.ok(mainFiles.length >= 4)
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  assert.deepEqual(leftovers(r, '101', FORK_A), [])
  assert.equal(r.files.get(r.mainPath), '{"main":true}\n', 'the main transcript')
  assert.ok(r.files.has(other), 'another session in the same project folder')
  assert.ok(r.files.has(join(projectDir(AGENT), 'memory', 'MEMORY.md')), 'the project memory')
  for (const p of mainFiles) assert.ok(r.exists(p), `the main session's ${p}`)
  assert.equal(r.gitCalls.some((c) => c.includes('worktree') && c.includes('remove')), false, 'it never had a worktree')
  assert.match(r.logs.find((l) => /thread 101 closed/.test(l))!, /freed \d+ bytes/)
})

test('a lane state that names the main session as its fork never gets the main session\'s files removed', async () => {
  const r = rig({ fullAccess: true })
  r.sessionFiles(AGENT, MAIN)
  r.files.set(r.mainPath, '{"main":true}\n')
  r.files.set(join(STATE, '101.json'), JSON.stringify({ rootId: '101', chatId: '55', title: 'T', forkSessionId: MAIN, folder: '', cwd: AGENT, worktree: false, readOnly: false, access: 'full', closedAt: null, lastReplyId: '', lastDelivered: false, pid: null, pidStamp: null }))
  await r.manager.close({ rootId: '101', removeWorktree: true })
  await r.manager.idle()
  assert.equal(r.files.get(r.mainPath), '{"main":true}\n')
  assert.ok(r.left(join(projectDir(AGENT), MAIN)).length > 0)
  assert.ok(r.left(join(CONFIG, 'session-env', MAIN)).length > 0)
  assert.ok(r.left(tempDir(AGENT, MAIN)).length > 0)
  assert.equal(r.files.has(join(STATE, '101.json')), false, 'the state itself goes')
})

test('a reply to a thread that was closed and cleaned up starts a new fork and says its earlier turns are not in its memory', async () => {
  const r = rig({ fullAccess: true })
  await fullThread(r)
  await r.manager.close({ rootId: '101', removeWorktree: false })
  await r.manager.idle()
  r.manager.turn(owner('101', { mode: 'reply', replyId: '1012', text: 'One more thing.' }))
  await r.manager.idle()
  const s = r.spawned.at(-1)!
  assert.deepEqual(s.args.slice(6, 9), ['--resume', MAIN, '--fork-session'])
  const said = s.child.said()
  assert.match(said, /This thread has no working session on this computer any more \(the files of a closed thread are cleaned up\)/)
  assert.match(said, /what was said in it earlier is not in your memory/)
  assert.match(said, /titled "T101"/)
  assert.ok(said.endsWith('\n\nOne more thing.'))
})

// -- the sweep when the daemon starts ---------------------------------------

const closedState = (rootId: string, fork: string, over: Record<string, unknown> = {}) => JSON.stringify({
  rootId, chatId: '55', title: `T${rootId}`, forkSessionId: fork, folder: wt(rootId), cwd: wt(rootId), worktree: true, readOnly: false,
  closedAt: 500, lastReplyId: '', lastDelivered: true, pid: null, pidStamp: null, ...over,
})

test('the start sweep removes what is left of a thread that is already closed (a close cut short by a crash, or kept by an older version)', async () => {
  const r = rig()
  r.dirs.add(wt('101'))
  r.files.set(join(wt('101'), '.git'), 'gitdir: x\n')
  r.files.set(join(wt('101'), 'big.bin'), 'x'.repeat(9000))
  r.git.branches.set('hoai/thread-101', 'c0')
  r.sessionFiles(wt('101'), FORK_A)
  r.files.set(join(STATE, '101.json'), closedState('101', FORK_A))
  assert.deepEqual(await r.manager.sweepLeftovers(), ['101'])
  assert.deepEqual(leftovers(r, '101', FORK_A), [])
  assert.match(r.logs.find((l) => /thread 101/.test(l) && /freed/.test(l))!, /freed \d+ bytes/)
})

test('the start sweep removes an orphan: a thread folder with no lane state at all', async () => {
  const r = rig()
  r.dirs.add(wt('777'))
  r.files.set(join(wt('777'), '.git'), 'gitdir: x\n')
  r.files.set(join(wt('777'), 'big.bin'), 'x'.repeat(9000))
  r.files.set(transcript(wt('777'), FORK_A), 'left by a crash')
  r.git.branches.set('hoai/thread-777', 'c0')
  assert.deepEqual(await r.manager.sweepLeftovers(), ['777'])
  assert.deepEqual(r.left(wt('777')), [])
  assert.deepEqual(r.left(projectDir(wt('777'))), [])
  assert.equal(r.git.branches.has('hoai/thread-777'), false)
  assert.ok(r.git.pruned >= 1)
})

test('the start sweep removes a main transcript copy a crash left behind, and leaves that open thread alone', async () => {
  const r = rig({ fullAccess: true })
  const copy = transcript(AGENT, COPY_ID)
  r.files.set(copy, 'a copy of the main transcript')
  r.files.set(join(STATE, '101.json'), JSON.stringify({ rootId: '101', chatId: '55', title: 'T', forkSessionId: null, folder: '', cwd: AGENT, worktree: false, readOnly: false, access: 'full', tempCopy: copy, closedAt: null, lastReplyId: '', lastDelivered: false, pid: null, pidStamp: null }))
  assert.deepEqual(await r.manager.sweepLeftovers(), [])
  assert.equal(r.files.has(copy), false)
  assert.equal(r.state('101')!.tempCopy, null)
  assert.ok(r.files.has(r.mainPath))
})

test('a temp copy path that is the main transcript itself is never removed', async () => {
  const r = rig({ fullAccess: true })
  r.files.set(join(STATE, '101.json'), JSON.stringify({ rootId: '101', chatId: '55', title: 'T', forkSessionId: null, folder: '', cwd: AGENT, worktree: false, readOnly: false, access: 'full', tempCopy: r.mainPath, closedAt: null, lastReplyId: '', lastDelivered: false, pid: null, pidStamp: null }))
  await r.manager.sweepLeftovers()
  assert.equal(r.files.get(r.mainPath), '{"main":true}\n')
})

test('a live thread survives the sweep: open and idle, open and running, and the main session\'s own files', POSIX, async () => {
  const r = rig({ fullAccess: true })
  r.sessionFiles(AGENT, MAIN)
  r.files.set(r.mainPath, '{"main":true}\n')
  // 101: a confined thread, open, its process gone (idle between turns).
  await confinedThread(r, '101', FORK_A)
  // 102: a full access thread with a turn running right now.
  r.manager.turn(owner('102'))
  await r.manager.idle()
  r.spawned.at(-1)!.child.init(FORK_B)
  r.sessionFiles(AGENT, FORK_B)
  // 103: an open thread known only from its state file (the daemon restarted).
  r.dirs.add(wt('103'))
  r.files.set(join(wt('103'), 'work.txt'), 'in progress')
  r.files.set(join(STATE, '103.json'), closedState('103', COPY_ID, { closedAt: null }))
  const before = [...r.files.keys()].sort()
  assert.deepEqual(await r.manager.sweepLeftovers(), [])
  assert.deepEqual([...r.files.keys()].sort(), before, 'not one file of an open thread or of the main session is removed')
  assert.equal(r.gitCalls.some((c) => c.slice(2, 4).join(' ') === 'worktree remove'), false)
  assert.equal(r.spawned.at(-1)!.child.killed.length, 0, 'the running thread is not stopped')
})

test('the sweep never removes a folder outside .hoai/threads, whatever a state file names', async () => {
  const r = rig()
  r.files.set(join(AGENT, 'src', 'keep.ts'), 'code')
  r.files.set(join(STATE, '101.json'), closedState('101', FORK_A, { folder: join(AGENT, 'src'), cwd: join(AGENT, 'src') }))
  await r.manager.sweepLeftovers()
  assert.ok(r.files.has(join(AGENT, 'src', 'keep.ts')))
  assert.equal(r.files.has(join(STATE, '101.json')), false)
})

test('stopping the daemon keeps an open thread\'s session (it resumes after the restart) and removes its temp copy', async () => {
  const r = rig({ fullAccess: true, activeGoal: true })
  r.manager.turn(owner('101'))
  await r.manager.idle()
  const copy = transcript(AGENT, COPY_ID)
  assert.ok(r.files.has(copy))
  const child = r.spawned[0]!.child
  const stopped = r.manager.stopAll()
  child.exit(null)
  await stopped
  assert.equal(r.files.has(copy), false, 'the copy made for the start is gone')
  assert.ok(r.files.has(join(STATE, '101.json')), 'the open thread\'s state stays: it is not closed')
})
