/**
 * lib/file-numbers.mjs: whole device and file numbers, the sameFile rule, and the file number of a look on a ReFS or
 * Dev Drive volume (128 bit file ids, 64 shown) counting as unknown. The Windows volume look runs PowerShell, so every
 * test here hands in a fake platform and runner; one test runs the real script, on Windows only.
 */
import assert from 'node:assert/strict'
import { lstatSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FILE_SYSTEM_SCRIPT, NO_FILE_ID, WHOLE_NUMBERS, fileIdsFit, fileSystemName, fileSystemOf, fileSystemOfAsync,
  forgetVolumes, knownNumbers, lookOn, numbersDiffer, numbersOnVolume, numbersOnVolumeAsync, runFileSystemScriptSync,
  sameFile, wholeNumber,
} from '../lib/file-numbers.mjs'
import { originIdentOf } from '../lib/skill-origins.ts'
import { REAL_IDENT_FS, identOf, type IdentFs } from '../lib/skills-inventory.ts'

const HERE = fileURLToPath(import.meta.url)

/** A whole look as a bigint stat gives it, with one kind method so a test can see methods survive lookOn. */
function look<T extends Record<string, unknown>>(fields: T) {
  return { isFile: () => true, size: 10n, mtimeNs: 5n, ctimeNs: 6n, birthtimeNs: 7n, ...fields }
}

/** A fake volume look: counts the runs and answers by path. */
function fakeWindows(answer: (path: string) => string) {
  const runs: string[] = []
  return { runs, deps: { platform: 'win32', run: (path: string) => { runs.push(path); return answer(path) } } }
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

test('fileIdsFit: ReFS (and so a Dev Drive) does not fit in 64 bits; every other name, and an unknown one, fits', () => {
  for (const wide of ['ReFS', 'refs', 'REFS', ' ReFS\r']) assert.equal(fileIdsFit(wide), false, wide)
  for (const fits of ['NTFS', 'FAT32', 'exFAT', 'apfs', '', null, undefined, 42]) assert.equal(fileIdsFit(fits), true, String(fits))
})

test('lookOn: on ReFS the file number of a look is unknown, its device number and its methods stay', () => {
  const stat = look({ dev: 7n, ino: 0xabn })
  assert.equal(lookOn(stat, 'NTFS'), stat, 'a volume whose ids fit gives the look back unchanged')
  assert.equal(lookOn(stat, null), stat)
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

test('fileSystemOf asks only Windows, once per volume, and keeps a failed look as unknown', () => {
  forgetVolumes()
  const off = fakeWindows(() => 'ReFS')
  assert.equal(fileSystemOf('/x', { dev: 1n }, { ...off.deps, platform: 'linux' }), null)
  assert.equal(fileSystemOf('/x', { dev: 1n }, { ...off.deps, platform: 'darwin' }), null)
  assert.deepEqual(off.runs, [], 'Linux and macOS are never asked')

  const windows = fakeWindows(path => (path.startsWith('D:') ? 'ReFS\r\n' : 'NTFS\r\n'))
  assert.equal(fileSystemOf('D:\\src\\a.txt', { dev: 0xd1n }, windows.deps), 'ReFS')
  assert.equal(fileSystemOf('D:\\src\\b.txt', { dev: 0xd1n }, windows.deps), 'ReFS')
  assert.equal(fileSystemOf('C:\\Users\\a.txt', { dev: 0xc1n }, windows.deps), 'NTFS')
  assert.deepEqual(windows.runs, ['D:\\src\\a.txt', 'C:\\Users\\a.txt'], 'one look per device number')

  // A volume mounted in a folder has its own device number, so it is asked for, not taken from the drive above it.
  assert.equal(fileSystemOf('C:\\dev\\x.txt', { dev: 0xe1n }, fakeWindows(() => 'ReFS').deps), 'ReFS')

  // With no device number the path root is the key.
  forgetVolumes()
  const rooted = fakeWindows(() => 'ReFS')
  fileSystemOf('E:\\one', {}, rooted.deps)
  fileSystemOf('e:\\two', { dev: 0n }, rooted.deps)
  assert.deepEqual(rooted.runs, ['E:\\one'])

  // A PowerShell that fails or prints junk: unknown, kept, not asked again.
  forgetVolumes()
  const broken = fakeWindows(() => '')
  assert.equal(fileSystemOf('F:\\x', { dev: 0xf1n }, broken.deps), null)
  assert.equal(fileSystemOf('F:\\y', { dev: 0xf1n }, broken.deps), null)
  assert.equal(broken.runs.length, 1)
  forgetVolumes()
})

test('fileSystemOfAsync shares the volumes fileSystemOf saw and takes a runner that gives a promise', async () => {
  forgetVolumes()
  const runs: string[] = []
  const deps = { platform: 'win32', run: async (path: string) => { runs.push(path); return 'ReFS' } }
  assert.equal(await fileSystemOfAsync('G:\\a', { dev: 0x61n }, deps), 'ReFS')
  assert.equal(fileSystemOf('G:\\b', { dev: 0x61n }, { platform: 'win32', run: () => assert.fail('asked again') }), 'ReFS')
  assert.equal(await fileSystemOfAsync('/a', { dev: 1n }, { ...deps, platform: 'linux' }), null)
  assert.deepEqual(runs, ['G:\\a'])
  forgetVolumes()
})

test('numbersOnVolume: a look on a Dev Drive has an unknown file number; on NTFS it is the look itself', async () => {
  forgetVolumes()
  const deps = fakeWindows(path => (path.startsWith('D:') ? 'ReFS' : 'NTFS')).deps
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
  }
  assert.equal(originIdentOf('D:\\skills\\a', fsOn('ReFS')), null)
  // A test file system with no volume look keeps the numbers as they come.
  const { fileSystem: _left, ...plainFs } = fsOn('ReFS')
  assert.equal(identOf('D:\\skills\\a', true, plainFs), '209:171')
})

test('the real identity file system asks the volume only on Windows, and this checkout still has identities', () => {
  assert.equal(typeof REAL_IDENT_FS.fileSystem, 'function')
  const id = identOf(HERE)
  if (process.platform !== 'win32') {
    assert.equal(REAL_IDENT_FS.fileSystem!(HERE, lstatSync(HERE, WHOLE_NUMBERS)), null)
    assert.match(id ?? '', /^\d+:\d+$/)
  }
  assert.equal(originIdentOf(HERE) === null, id === null)
})

test('on Windows the real script names the file system of this file\'s drive', { skip: process.platform !== 'win32', timeout: 60_000 }, () => {
  const name = fileSystemName(runFileSystemScriptSync(HERE))
  assert.ok(name, 'PowerShell printed a file system name')
  assert.match(name!, /^(NTFS|ReFS|FAT32|exFAT)$/i)
})
