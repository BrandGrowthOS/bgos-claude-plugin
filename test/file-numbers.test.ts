/**
 * lib/file-numbers.mjs: whole device and file numbers, the sameFile rule, and the file number of a look on a ReFS or
 * Dev Drive volume (128 bit file ids, 64 shown) counting as unknown. The Windows volume look runs PowerShell, so every
 * test here hands in a fake platform and runner; one test runs the real script, on Windows only.
 */
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FAILED_LOOK_RETRY_MS, FILE_SYSTEM_SCRIPT, NO_FILE_ID, POWERSHELL_TIMEOUT_MS, UNKNOWN_VOLUME, WHOLE_NUMBERS, fileIdsFit, fileSystemName,
  fileSystemOf, fileSystemOfAsync, forgetVolumes, knownNumbers, lookOn, numbersDiffer, numbersOnVolume,
  numbersOnVolumeAsync, powershellPath, renameKept, runFileSystemScript, sameFile, volumeLooksSettled, warmVolumes,
  wholeNumber,
} from '../lib/file-numbers.mjs'
import { originIdentOf } from '../lib/skill-origins.ts'
import { REAL_IDENT_FS, identOf, type IdentFs, type IdentStat } from '../lib/skills-inventory.ts'
import { linkFolder } from './helpers/links.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'

const HERE = fileURLToPath(import.meta.url)
const RULE_SOURCE = fileURLToPath(new URL('../lib/file-numbers.mjs', import.meta.url))

/** A whole look as a bigint stat gives it, with one kind method so a test can see methods survive lookOn. */
function look<T extends Record<string, unknown>>(fields: T) {
  return { isFile: () => true, size: 10n, mtimeNs: 5n, ctimeNs: 6n, birthtimeNs: 7n, ...fields }
}

/** A fake volume look: counts the runs and answers by path. */
function fakeWindows(answer: (path: string) => string | Promise<string>) {
  const runs: string[] = []
  return { runs, deps: { platform: 'win32', run: (path: string) => { runs.push(path); return answer(path) } } }
}

/** An identity file system over fixed looks whose volume look is fileSystemOf with these deps. */
function identFsOn(looks: Map<string, IdentStat>, deps: Parameters<typeof fileSystemOf>[2]): IdentFs {
  return {
    statSync: path => looks.get(path)!,
    lstatSync: path => looks.get(path)!,
    fileSystem: (path, stat) => fileSystemOf(path, stat, deps),
  }
}

test('wholeNumber: a bigint or a safe plain number is whole; left out, zero, all ones and past 2^53 are unknown', () => {
  assert.equal(wholeNumber(12n), 12n)
  assert.equal(wholeNumber(12), 12n)
  assert.equal(wholeNumber(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER))
  // A top bit set comes signed from Node; it is read back unsigned.
  assert.equal(wholeNumber(-2n), NO_FILE_ID - 1n)
  for (const unknown of [undefined, null, 0, 0n, NO_FILE_ID, -1n, 2 ** 53, 2 ** 60, -5, 1.5, Number.NaN, '12', {}]) {
    assert.equal(wholeNumber(unknown), null, String(unknown))
  }
  assert.equal(knownNumbers({ dev: 1n, ino: 2n }), true)
  assert.equal(knownNumbers({ dev: 1n, ino: 0n }), false)
  assert.equal(knownNumbers({ dev: 1n }), false)
  assert.equal(knownNumbers(undefined), false)
})

test('sameFile: a differing known number is another file; equal known numbers are one; an unknown one asks the times', () => {
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 2n, size: 99n })), true)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 3n })), false)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 4n, ino: 2n })), false)
  assert.equal(numbersDiffer(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n })), false)
  // Unknown file number on one side: the size and the times decide.
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n })), true)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n, mtimeNs: 9n })), false)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n, ctimeNs: 9n })), false)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n, size: 11n })), false)
  assert.equal(sameFile(look({ dev: 1n, ino: 2n }), look({ dev: 1n, ino: 0n, birthtimeNs: 8n })), false)
  // A birth time only one side gives (Linux zero) is not compared; a missing modified time never matches.
  assert.equal(sameFile(look({ ino: 0n }), look({ ino: 0n, birthtimeNs: 0n })), true)
  assert.equal(sameFile(look({ ino: 0n, mtimeNs: undefined }), look({ ino: 0n, mtimeNs: undefined })), false)
  assert.equal(sameFile(undefined, undefined), false)
})

test('renameKept: with the file number unknown, the device number and the birth time a rename keeps must agree', () => {
  // A rename on one volume keeps both; the change time it moves is not asked.
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 11n }, { dev: 7n, birthtimeNs: 11n, ctimeNs: 99n }), true)
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 11n }, { dev: 7n, birthtimeNs: 12n }), false, 'another entry, born at another time')
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 11n }, { dev: 8n, birthtimeNs: 11n }), false, 'another volume')
  // A number that one look gives and the other does not is a change, never a match.
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 11n }, { dev: 7n }), false)
  assert.equal(renameKept({ dev: 7n }, { dev: 7n, birthtimeNs: 11n }), false)
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 11n }, { birthtimeNs: 11n }), false)
  // A zero birth time (Linux with none) is not given.
  assert.equal(renameKept({ dev: 7n, birthtimeNs: 0n }, { dev: 7n }), true)
  // Where neither look gives anything a rename keeps (a drive with no numbers and no birth times), nothing differs.
  assert.equal(renameKept({ dev: 7n, ino: 0n }, { dev: 7n, ino: 0n }), true)
  assert.equal(renameKept({}, {}), true)
  // No look is no match.
  assert.equal(renameKept(null, { dev: 7n }), false)
  assert.equal(renameKept({ dev: 7n }, undefined), false)
})

test('fileIdsFit: ReFS (and so a Dev Drive) and an unknown volume do not fit in 64 bits; not asked (null) and every other name fit', () => {
  for (const wide of ['ReFS', 'refs', 'REFS', ' ReFS\r', UNKNOWN_VOLUME]) assert.equal(fileIdsFit(wide), false, wide)
  for (const fits of ['NTFS', 'FAT32', 'exFAT', 'apfs', '', null, undefined, 42]) assert.equal(fileIdsFit(fits), true, String(fits))
  assert.equal(fileSystemName(UNKNOWN_VOLUME), null, 'no script output can name the unknown volume')
})

test('lookOn: on ReFS the file number of a look is unknown, its device number and its methods stay', () => {
  const stat = look({ dev: 7n, ino: 0xabn })
  assert.equal(lookOn(stat, 'NTFS'), stat, 'a volume whose ids fit gives the look back unchanged')
  assert.equal(lookOn(stat, null), stat)
  assert.equal(lookOn(stat, UNKNOWN_VOLUME).ino, undefined, 'an unknown volume makes the file number unknown too')
  const wide = lookOn(stat, 'ReFS')
  assert.equal(wide.ino, undefined)
  assert.equal(wide.dev, 7n)
  assert.equal(wide.size, 10n)
  assert.equal(wide.isFile(), true)
  assert.equal(knownNumbers(wide), false)
  assert.equal(stat.ino, 0xabn, 'the look itself is not changed')
  assert.equal(lookOn(null, 'ReFS'), null)
  // A real bigint stat keeps its prototype methods through lookOn.
  const real = lookOn(lstatSync(HERE, WHOLE_NUMBERS), 'ReFS')
  assert.equal(real.isFile(), true)
  assert.equal(real.isDirectory(), false)
  assert.equal(real.ino, undefined)
  assert.equal(typeof real.size, 'bigint')
})

test('two files whose cut ReFS ids show one number are not taken for one file', () => {
  // Two 128 bit ids that differ only above bit 64: Node shows both as 0xab.
  const first = look({ dev: 7n, ino: 0xabn, mtimeNs: 100n })
  const second = look({ dev: 7n, ino: 0xabn, mtimeNs: 200n })
  assert.equal(sameFile(first, second), true, 'read as if the ids fit, the cut ids match')
  assert.equal(sameFile(lookOn(first, 'ReFS'), lookOn(second, 'ReFS')), false, 'on ReFS the times decide, and they differ')
  // One file looked at twice on ReFS still matches, by its size and times.
  assert.equal(sameFile(lookOn(first, 'ReFS'), lookOn({ ...first }, 'ReFS')), true)
})

test('fileSystemOf asks only Windows, never inside the call: the volume is unknown until the answer arrives, then known', async () => {
  forgetVolumes()
  const off = fakeWindows(() => 'ReFS')
  assert.equal(fileSystemOf('/x', { dev: 1n }, { ...off.deps, platform: 'linux' }), null)
  assert.equal(fileSystemOf('/x', { dev: 1n }, { ...off.deps, platform: 'darwin' }), null)
  await volumeLooksSettled()
  assert.deepEqual(off.runs, [], 'Linux and macOS are never asked')

  const windows = fakeWindows(path => (path.startsWith('D:') ? 'ReFS\r\n' : 'NTFS\r\n'))
  assert.equal(fileSystemOf('D:\\src\\a.txt', { dev: 0xd1n }, windows.deps), UNKNOWN_VOLUME, 'not answered yet')
  assert.deepEqual(windows.runs, [], 'the look runs after the call has returned')
  assert.equal(fileSystemOf('D:\\src\\b.txt', { dev: 0xd1n }, windows.deps), UNKNOWN_VOLUME)
  assert.equal(fileSystemOf('C:\\Users\\a.txt', { dev: 0xc1n }, windows.deps), UNKNOWN_VOLUME)
  await volumeLooksSettled()
  assert.deepEqual(windows.runs, ['D:\\src\\a.txt', 'C:\\Users\\a.txt'], 'one look per device number, even while one is out')
  assert.equal(fileSystemOf('D:\\src\\b.txt', { dev: 0xd1n }, windows.deps), 'ReFS')
  assert.equal(fileSystemOf('C:\\Users\\b.txt', { dev: 0xc1n }, windows.deps), 'NTFS')
  assert.equal(windows.runs.length, 2, 'an answer is kept')

  // A volume mounted in a folder has its own device number, so it is asked for, not taken from the drive above it.
  const mounted = fakeWindows(() => 'ReFS')
  fileSystemOf('C:\\dev\\x.txt', { dev: 0xe1n }, mounted.deps)
  await volumeLooksSettled()
  assert.equal(fileSystemOf('C:\\dev\\x.txt', { dev: 0xe1n }, mounted.deps), 'ReFS')

  // With no device number the path root is the key.
  forgetVolumes()
  const rooted = fakeWindows(() => 'ReFS')
  fileSystemOf('E:\\one', {}, rooted.deps)
  await volumeLooksSettled()
  assert.equal(fileSystemOf('e:\\two', { dev: 0n }, rooted.deps), 'ReFS')
  assert.deepEqual(rooted.runs, ['E:\\one'])
  forgetVolumes()
})

test('a failed volume look counts as unknown, not as fitting, and is asked again after a short time', async () => {
  // A Dev Drive whose PowerShell timed out, was blocked or is missing: the script printed nothing.
  forgetVolumes()
  let clock = 1_000
  let answer = ''
  const runs: string[] = []
  const deps = { platform: 'win32', now: () => clock, run: (path: string) => { runs.push(path); return answer } }
  const onDevDrive = look({ dev: 0xd1n, ino: 171n })
  numbersOnVolume(onDevDrive, 'D:\\skills\\a', deps)
  await volumeLooksSettled()
  assert.equal(runs.length, 1)
  assert.equal(fileSystemOf('D:\\skills\\a', onDevDrive, deps), UNKNOWN_VOLUME)
  assert.equal(numbersOnVolume(onDevDrive, 'D:\\skills\\a', deps).ino, undefined, 'the cut id is not taken as the file number')
  // Two Dev Drive folders whose cut ids match are never one folder, before or after the failed look.
  const twins = identFsOn(new Map([['D:\\skills\\a', { dev: 0xd1n, ino: 171n }], ['D:\\skills\\b', { dev: 0xd1n, ino: 171n }]]), deps)
  assert.equal(identOf('D:\\skills\\a', true, twins), null)
  assert.equal(identOf('D:\\skills\\b', true, twins), null)
  await volumeLooksSettled()
  assert.equal(runs.length, 1, 'the failure is kept for a while: the volume is not asked for every file')

  // The next look, a while later, sees the working answer.
  answer = 'ReFS\r\n'
  clock += FAILED_LOOK_RETRY_MS - 1
  assert.equal(fileSystemOf('D:\\skills\\a', onDevDrive, deps), UNKNOWN_VOLUME)
  await volumeLooksSettled()
  assert.equal(runs.length, 1)
  clock += 1
  assert.equal(fileSystemOf('D:\\skills\\a', onDevDrive, deps), UNKNOWN_VOLUME, 'asked again, not answered yet')
  await volumeLooksSettled()
  assert.equal(runs.length, 2)
  assert.equal(fileSystemOf('D:\\skills\\a', onDevDrive, deps), 'ReFS')
  assert.equal(FAILED_LOOK_RETRY_MS, 60_000)

  // A runner that throws or rejects fails the same way, and the async look gives unknown too.
  forgetVolumes()
  assert.equal(await fileSystemOfAsync('F:\\x', { dev: 0xf1n }, { platform: 'win32', run: () => { throw new Error('blocked') } }), UNKNOWN_VOLUME)
  assert.equal(await fileSystemOfAsync('G:\\x', { dev: 0x61n }, { platform: 'win32', run: () => Promise.reject(new Error('gone')) }), UNKNOWN_VOLUME)
  assert.equal(await fileSystemOfAsync('H:\\x', { dev: 0x71n }, { platform: 'win32', run: () => 'Get-Volume : Access denied' }), UNKNOWN_VOLUME)
  forgetVolumes()
})

test('fileSystemOfAsync shares the volumes fileSystemOf saw, waits for a look already out, and takes a promise', async () => {
  forgetVolumes()
  const runs: string[] = []
  let release: (value: string) => void = () => {}
  const deps = { platform: 'win32', run: (path: string) => { runs.push(path); return new Promise<string>(done => { release = done }) } }
  assert.equal(fileSystemOf('G:\\a', { dev: 0x61n }, deps), UNKNOWN_VOLUME)
  const waiting = fileSystemOfAsync('G:\\b', { dev: 0x61n }, deps)
  await new Promise(done => setImmediate(done))
  release('ReFS')
  assert.equal(await waiting, 'ReFS', 'the async look waited for the one already out')
  assert.equal(fileSystemOf('G:\\c', { dev: 0x61n }, { platform: 'win32', run: () => assert.fail('asked again') }), 'ReFS')
  assert.equal(await fileSystemOfAsync('/a', { dev: 1n }, { ...deps, platform: 'linux' }), null)
  assert.deepEqual(runs, ['G:\\a'])
  forgetVolumes()
})

test('the volume look never blocks: no sync spawn in the rule, and the default runner answers through a callback', async () => {
  const source = readFileSync(RULE_SOURCE, 'utf8')
  assert.doesNotMatch(source, /\b(execFileSync|spawnSync|execSync)\b/, 'no synchronous child process anywhere in lib/file-numbers.mjs')
  // The default runner (no `run`), with a PowerShell that answers 300 ms later.
  forgetVolumes()
  const spawned: string[] = []
  const execFile = (file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    spawned.push(file)
    setTimeout(() => done(null, 'NTFS\r\n'), 300)
  }
  const deps = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, execFile }
  const folder = new Map([['C:\\agent', { dev: 0xc1n, ino: 5n }]])
  const fs = identFsOn(folder, deps)
  const timerSetAt = Date.now()
  const timer = new Promise<number>(done => setTimeout(() => done(Date.now() - timerSetAt), 0))
  assert.equal(identOf('C:\\agent', true, fs), null, 'unknown while the volume is being asked')
  assert.ok(Date.now() - timerSetAt < 100, 'identOf returned at once')
  assert.ok((await timer) < 200, 'a timer set before identOf fired on time')
  await volumeLooksSettled()
  assert.deepEqual(spawned, ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
  assert.equal(identOf('C:\\agent', true, fs), '193:5', 'known once the answer arrived')
  forgetVolumes()
})

test('PowerShell is started from System32 by its whole path, never by a bare name the agent folder could answer', async () => {
  assert.equal(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(powershellPath({ SYSTEMROOT: 'D:\\WINDOWS\\' }), 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  // No SystemRoot, or one that is not a whole path, names nothing: the look fails, and a failure counts as unknown.
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: '   ' }, { SystemRoot: 'Windows' }, { SystemRoot: '.\\Windows' }, { SystemRoot: '\\Windows' }]) {
    assert.equal(powershellPath(env), null, JSON.stringify(env))
  }
  const calls: Array<{ file: string, args: string[], options: { env: Record<string, string>, timeout: number, windowsHide: boolean } }> = []
  const execFile = (file: string, args: string[], options: any, done: (error: Error | null, stdout: string) => void) => {
    calls.push({ file, args, options })
    done(null, 'NTFS\r\n')
  }
  assert.equal(await runFileSystemScript('D:\\repo\\a b', { execFile, env: { SystemRoot: 'C:\\Windows', PATH: 'D:\\repo' } }), 'NTFS\r\n')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(calls[0].options.env.HOAI_FILE_NUMBERS_PATH, 'D:\\repo\\a b', 'the path travels in the environment')
  assert.ok(!calls[0].args.some(arg => arg.includes('D:\\repo')), 'and never in the command line')
  assert.equal(calls[0].options.timeout, POWERSHELL_TIMEOUT_MS)
  assert.equal(POWERSHELL_TIMEOUT_MS, 30_000, 'nothing waits on it, so a cold start has room')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(await runFileSystemScript('D:\\repo', { execFile, env: { PATH: 'D:\\repo' } }), '', 'no SystemRoot: nothing is started')
  assert.equal(calls.length, 1)
})

test('runFileSystemScript gives an empty answer, never a rejection, when starting PowerShell throws', async () => {
  const throws = () => { throw new TypeError('spawn refused') }
  assert.equal(await runFileSystemScript('D:\\x', { execFile: throws, env: { SystemRoot: 'C:\\Windows' } }), '')
  // The real execFile throws before the spawn for a path with a NUL in it (it travels in the environment).
  assert.equal(await runFileSystemScript('D:\\x\u0000y', { env: { SystemRoot: 'C:\\Windows' } }), '')
  const fails = (_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => done(new Error('timed out'), 'ReFS')
  assert.equal(await runFileSystemScript('D:\\x', { execFile: fails, env: { SystemRoot: 'C:\\Windows' } }), '')
})

test('warmVolumes asks the volumes of the given folders ahead, so the first sync look finds the answer', async () => {
  forgetVolumes()
  const off = fakeWindows(() => 'NTFS')
  await warmVolumes([dirname(HERE)], { ...off.deps, platform: 'darwin' })
  assert.deepEqual(off.runs, [], 'off Windows nothing is asked')

  const windows = fakeWindows(() => 'NTFS\r\n')
  const missing = join(dirname(HERE), 'no-such-folder-here')
  await warmVolumes([dirname(HERE), dirname(dirname(HERE)), '', null, undefined, missing], windows.deps)
  assert.equal(windows.runs.length, 1, 'one look for the one volume both folders are on; a missing or empty one is skipped')
  assert.ok([realpathSync(dirname(HERE)), realpathSync(dirname(dirname(HERE)))].includes(windows.runs[0]), 'asked by the real path of a folder')
  assert.equal(fileSystemOf(HERE, lstatSync(HERE, WHOLE_NUMBERS), { platform: 'win32', run: () => assert.fail('asked again') }), 'NTFS')
  forgetVolumes()
})

test('numbersOnVolume: a look on a Dev Drive has an unknown file number; on NTFS it is the look itself', async () => {
  forgetVolumes()
  const deps = fakeWindows(path => (path.startsWith('D:') ? 'ReFS' : 'NTFS')).deps
  numbersOnVolume(look({ dev: 0xd1n, ino: 5n }), 'D:\\repo\\file', deps)
  numbersOnVolume(look({ dev: 0xc1n, ino: 5n }), 'C:\\repo\\file', deps)
  await volumeLooksSettled()
  const onDevDrive = numbersOnVolume(look({ dev: 0xd1n, ino: 5n }), 'D:\\repo\\file', deps)
  assert.equal(onDevDrive.ino, undefined)
  assert.equal(knownNumbers(onDevDrive), false)
  const onNtfs = look({ dev: 0xc1n, ino: 5n })
  assert.equal(numbersOnVolume(onNtfs, 'C:\\repo\\file', deps), onNtfs)
  const asyncLook = await numbersOnVolumeAsync(look({ dev: 0xd1n, ino: 5n }), 'D:\\other', deps)
  assert.equal(asyncLook.ino, undefined)
  // Off Windows nothing changes and nothing runs.
  const mac = look({ dev: 1n, ino: 2n })
  assert.equal(numbersOnVolume(mac, '/Users/x', { platform: 'darwin', run: () => assert.fail('ran') }), mac)
  forgetVolumes()
})

test('fileSystemName reads the first line and refuses anything that is not a file system name', () => {
  assert.equal(fileSystemName('ReFS\r\n'), 'ReFS')
  assert.equal(fileSystemName('\r\n  NTFS  \r\n'), 'NTFS')
  for (const junk of ['', '\r\n', 'Get-Volume : Access denied', 'Re FS', 'x'.repeat(33), null, undefined]) {
    assert.equal(fileSystemName(junk), null, String(junk))
  }
})

test('the path reaches PowerShell in the environment, never in the script', () => {
  assert.match(FILE_SYSTEM_SCRIPT, /\$env:HOAI_FILE_NUMBERS_PATH/)
  assert.match(FILE_SYSTEM_SCRIPT, /Get-Volume -FilePath \$p/)
  assert.match(FILE_SYSTEM_SCRIPT, /DriveFormat/)
  assert.doesNotMatch(FILE_SYSTEM_SCRIPT, /\$args/)
})

test('a skill folder on a Dev Drive has no identity, so two folders whose cut ids match are never one', () => {
  // Two folders on one ReFS volume whose 128 bit ids share the 64 bits Node shows.
  const folders = new Map([['D:\\skills\\a', { dev: 0xd1n, ino: 0xabn, birthtimeNs: 1n }], ['D:\\skills\\b', { dev: 0xd1n, ino: 0xabn, birthtimeNs: 1n }]])
  const fsOn = (fileSystem: string | null): IdentFs => ({
    statSync: path => folders.get(path)!,
    lstatSync: path => folders.get(path)!,
    fileSystem: () => fileSystem,
  })
  // Read as if the ids fit, the two folders share an identity: the bug the volume look closes.
  assert.equal(identOf('D:\\skills\\a', true, fsOn('NTFS')), identOf('D:\\skills\\b', true, fsOn('NTFS')))
  assert.equal(identOf('D:\\skills\\a', true, fsOn('NTFS')), '209:171')
  assert.equal(originIdentOf('D:\\skills\\a', fsOn('NTFS')), '209:171:1')
  for (const [follow, path] of [[true, 'D:\\skills\\a'], [false, 'D:\\skills\\b']] as const) {
    assert.equal(identOf(path, follow, fsOn('ReFS')), null)
    assert.equal(identOf(path, follow, fsOn(UNKNOWN_VOLUME)), null)
  }
  assert.equal(originIdentOf('D:\\skills\\a', fsOn('ReFS')), null)
  assert.equal(originIdentOf('D:\\skills\\a', fsOn(UNKNOWN_VOLUME)), null)
  // A test file system with no volume look keeps the numbers as they come.
  const { fileSystem: _left, ...plainFs } = fsOn('ReFS')
  assert.equal(identOf('D:\\skills\\a', true, plainFs), '209:171')
})

test('identOf and originIdentOf read the numbers by the rule: all ones (Windows "no file id") is not an identity', () => {
  const at = 'D:\\never\\read'
  const fsWith = (numbers: IdentStat & { birthtimeNs?: bigint }): IdentFs => ({ statSync: () => numbers, lstatSync: () => numbers })
  // Node hands 0xffff...ffff over signed, as -1n.
  for (const numbers of [{ dev: 1n, ino: -1n }, { dev: -1n, ino: 5n }, { dev: 1n, ino: NO_FILE_ID }, { dev: 1, ino: 2 ** 53 }]) {
    assert.equal(identOf(at, true, fsWith(numbers)), null, String(numbers.ino))
    assert.equal(identOf(at, false, fsWith(numbers)), null, String(numbers.ino))
    assert.equal(originIdentOf(at, fsWith({ ...numbers, birthtimeNs: 3n })), null, String(numbers.ino))
  }
  // A whole number with the top bit set (NTFS keeps how often a record was reused there) still is one.
  assert.equal(identOf(at, true, fsWith({ dev: 1n, ino: -2n })), '1:-2')
  assert.equal(originIdentOf(at, fsWith({ dev: 1n, ino: -2n, birthtimeNs: 3n })), '1:-2:3')
})

test('a followed link is asked about the volume it leads to, by its real path; a look at the link itself, by its real folder', () => {
  const root = scratchDir('file-numbers-link-')
  const target = join(root, 'elsewhere', 'skills')
  mkdirSync(target, { recursive: true })
  mkdirSync(join(root, 'home'))
  const link = join(root, 'home', 'skills')
  linkFolder(target, link)
  const asked: string[] = []
  const fs: IdentFs = { statSync, lstatSync, fileSystem: path => { asked.push(path); return 'NTFS' } }
  assert.ok(identOf(link, true, fs))
  assert.ok(identOf(link, false, fs))
  assert.deepEqual(asked, [realpathSync(target), realpathSync(join(root, 'home'))])
})

test('the real identity file system asks the volume only on Windows, and this checkout still has identities', { timeout: 60_000 }, async () => {
  assert.equal(typeof REAL_IDENT_FS.fileSystem, 'function')
  const id = identOf(HERE)
  if (process.platform !== 'win32') {
    assert.equal(REAL_IDENT_FS.fileSystem!(HERE, lstatSync(HERE, WHOLE_NUMBERS)), null)
    assert.match(id ?? '', /^\d+:\d+$/)
  }
  assert.equal(originIdentOf(HERE) === null, id === null)
  await volumeLooksSettled()
  if (process.platform === 'win32') {
    // The real look has answered by now, through the async runner; on a volume whose ids fit the identity is known.
    const name = REAL_IDENT_FS.fileSystem!(HERE, lstatSync(HERE, WHOLE_NUMBERS))
    assert.ok(name !== UNKNOWN_VOLUME, 'the real script answered')
    if (fileIdsFit(name)) assert.match(identOf(HERE) ?? '', /^\d+:-?\d+$/)
  }
})

test('on Windows the real script names the file system of this file\'s drive', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const name = fileSystemName(await runFileSystemScript(HERE))
  assert.ok(name, 'PowerShell printed a file system name')
  assert.match(name!, /^(NTFS|ReFS|FAT32|exFAT)$/i)
})
