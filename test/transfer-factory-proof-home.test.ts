/**
 * The transfer factory proof finds its Docker host's seccomp profile in that host's own home folder
 * (board row a633fb9c, finding b1).
 *
 * scripts/prove-browser-profile-transfer-factory.py runs its native leg on a remote Docker host over
 * ssh and gives `docker create` a seccomp profile. That path was one person's home folder spelled out
 * in the script, which is a real default, not a comment, and a public repository naming our machine.
 * It is now the ssh user's own home (Python's expanduser('~') on the remote side, where os.homedir()
 * would answer in Node), joined with the same folder and file names. For the host the proof ran on,
 * that is the same path as before.
 *
 * This runs the script's native leg for real, end to end, with two stand-ins on PATH: an `ssh` that
 * runs the remote program here, and a `docker` that records its arguments and answers like the proof
 * host (the baseline and restored runs qualify, the omitted callback run fails its assertion). HOME
 * is a temp folder, so the seccomp path docker receives must be inside it.
 *
 * POSIX only (the stand-ins are shell scripts), and it needs python3: it skips without one, except
 * under CI on Linux, where a skip would prove nothing.
 *
 * Run: npm test, or npx tsx --test test/transfer-factory-proof-home.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'prove-browser-profile-transfer-factory.py')
const SECCOMP_IN_HOME = 'hoai-profile-fresh.sdpd8isb/seccomp_profile.json'

const SSH = `#!/bin/sh
# The last argument is the remote command, "python3 -"; the program arrives on stdin.
exec python3 -
`

// One line per call in the log. The second container is the omitted callback run, which must fail.
const DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOAI_FAKE_DOCKER_LOG"
count=$(grep -c '^create ' "$HOAI_FAKE_DOCKER_LOG")
case "$1" in
  cp) cat > /dev/null ;;
  start)
    if [ "$count" = 2 ]; then echo 'AssertionError [ERR_ASSERTION]: the factory callback is missing'
    else echo '{"qualified":true,"normalCleanup":true,"ownedBrowserGone":true}'; fi ;;
  inspect) if [ "$count" = 2 ]; then echo 1; else echo 0; fi ;;
esac
exit 0
`

function python3(): string | null {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 ? probe.stdout.trim() || probe.stderr.trim() : null
}

test('the native leg gives docker the seccomp profile in the ssh user\'s own home folder', (t) => {
  if (process.platform === 'win32') return t.skip('the ssh and docker stand-ins are POSIX shell scripts')
  if (!python3()) {
    if (process.env.CI && process.platform === 'linux') assert.fail('python3 is missing on a Linux CI runner')
    return t.skip('python3 is not installed')
  }
  const dir = mkdtempSync(join(tmpdir(), 'hoai-factory-home-'))
  try {
    // A minimal plugin tree: the script reads these two files relative to its working folder.
    const repo = join(dir, 'repo')
    for (const file of ['lib/browser-profile-companion.mjs', 'scripts/probe-browser-profile-transfer-factory.mjs']) {
      mkdirSync(join(repo, file, '..'), { recursive: true })
      copyFileSync(join(ROOT, file), join(repo, file))
    }
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ssh'), SSH)
    writeFileSync(join(bin, 'docker'), DOCKER)
    chmodSync(join(bin, 'ssh'), 0o755)
    chmodSync(join(bin, 'docker'), 0o755)
    const home = join(dir, 'home')
    mkdirSync(home)
    const log = join(dir, 'docker.log')
    writeFileSync(log, '')

    const run = spawnSync('python3', [SCRIPT, '--native-only'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home, HOAI_FAKE_DOCKER_LOG: log },
    })

    const creates = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('create '))
    const seccomp = creates.map((line) => /--security-opt seccomp=(\S+)/.exec(line)?.[1])
    assert.deepEqual(seccomp, Array(3).fill(join(home, SECCOMP_IN_HOME)), `docker create was given:\n${creates.join('\n')}`)
    assert.equal(run.status, 0, `the native leg must run to the end:\n${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /"nativeRuns": 3/)
    assert.ok(existsSync(join(repo, '.tmp')), 'the proof wrote its results in its own working folder')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
