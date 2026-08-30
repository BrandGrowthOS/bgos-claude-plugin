/**
 * lib/claude-preseed.mjs: the one-time-prompt pre-seed a NEW agent folder
 * needs before its first launch, ported byte-for-byte in behaviour from
 * bin/hoai-bootstrap.sh (~544-581) and bin/hoai-bootstrap.ps1 (~400-445):
 *   .claude.json   hasCompletedOnboarding + theme defaults, and
 *                  projects[<cwd byte-exact>] = the FULL trust entry shape
 *                  (a minimal {hasTrustDialogAccepted:true} is NOT honoured)
 *   settings.json  skipDangerousModePermissionPrompt = true (the bypass
 *                  warning's DEFAULT answer is exit, never blind-Enter it)
 * The ps1 seeds both slash spellings of a win32 cwd; so does this port.
 *
 * Run: npx tsx --test test/claude-preseed.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  TRUST_ENTRY_DEFAULTS,
  alternateSlashSpelling,
  ensureMarketplaceAutoUpdate,
  readMarketplaceAutoUpdate,
  preseedClaudeTrust,
  seedProjectEntry,
} from '../lib/claude-preseed.mjs'

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFile: (p: string) => files.get(p) ?? null,
    writeFile: (p: string, c: string) => {
      files.set(p, c)
    },
  }
}

const FULL_ENTRY = {
  allowedTools: [],
  disabledMcpjsonServers: [],
  enabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
  mcpContextUris: [],
  projectOnboardingSeenCount: 1,
  hasCompletedProjectOnboarding: true,
  hasTrustDialogAccepted: true,
}

test('TRUST_ENTRY_DEFAULTS is exactly the bootstrap entry shape, in the bootstrap key order', () => {
  // The bootstrap snippet is the source of truth; read its keys straight out
  // of the shell script so a drift there fails here.
  const sh = readFileSync(fileURLToPath(new URL('../bin/hoai-bootstrap.sh', import.meta.url)), 'utf8')
  const block = /Object\.assign\(\{([\s\S]*?)\}, existing, \{ hasTrustDialogAccepted: true \}\)/.exec(sh)
  assert.ok(block, 'the bootstrap preseed block was not found')
  const keys = [...block![1]!.matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1])
  assert.deepEqual(Object.keys(TRUST_ENTRY_DEFAULTS), keys)
  assert.deepEqual({ ...TRUST_ENTRY_DEFAULTS, hasTrustDialogAccepted: true }, FULL_ENTRY)
})

test('seedProjectEntry: defaults under existing under the forced trust flag (pure)', () => {
  assert.deepEqual(seedProjectEntry(undefined), FULL_ENTRY)
  assert.deepEqual(seedProjectEntry({ allowedTools: ['Bash'], hasTrustDialogAccepted: false, extra: 1 }), {
    ...FULL_ENTRY,
    allowedTools: ['Bash'],
    extra: 1,
  })
})

test('alternateSlashSpelling mirrors the ps1 (flip every separator)', () => {
  assert.equal(alternateSlashSpelling('C:\\Users\\kc\\hoai-agents\\ava'), 'C:/Users/kc/hoai-agents/ava')
  assert.equal(alternateSlashSpelling('C:/Users/kc/ava'), 'C:\\Users\\kc\\ava')
  assert.equal(alternateSlashSpelling('/home/kc/ava'), '\\home\\kc\\ava')
})

test('preseedClaudeTrust: fresh config dir writes exactly the bootstrap output (posix cwd, one spelling)', () => {
  const fs = memFs()
  const result = preseedClaudeTrust({ configDir: '/home/kc/.claude', cwd: '/home/kc/hoai-agents/ava', fs })
  assert.deepEqual(result, {
    configPath: '/home/kc/.claude/.claude.json',
    settingsPath: '/home/kc/.claude/settings.json',
    seededKeys: ['/home/kc/hoai-agents/ava'],
  })
  const expectedCfg = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { '/home/kc/hoai-agents/ava': FULL_ENTRY },
  }
  assert.equal(fs.files.get('/home/kc/.claude/.claude.json'), JSON.stringify(expectedCfg, null, 2))
  assert.equal(
    fs.files.get('/home/kc/.claude/settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2),
  )
})

test('preseedClaudeTrust: merges over an existing config, never clobbers other projects or settings, keeps user theme', () => {
  const fs = memFs({
    '/home/kc/.claude/.claude.json': JSON.stringify({
      theme: 'light',
      numStartups: 9,
      projects: {
        '/other': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
        '/home/kc/hoai-agents/ava': { allowedTools: ['Bash'], mcpContextUris: ['x'] },
      },
    }),
    '/home/kc/.claude/settings.json': JSON.stringify({ model: 'opus', enabledPlugins: { 'hoai@hoai': true } }),
  })
  preseedClaudeTrust({ configDir: '/home/kc/.claude', cwd: '/home/kc/hoai-agents/ava', fs })
  const cfg = JSON.parse(fs.files.get('/home/kc/.claude/.claude.json')!)
  assert.deepEqual(cfg, {
    theme: 'light',
    numStartups: 9,
    projects: {
      '/other': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
      '/home/kc/hoai-agents/ava': { ...FULL_ENTRY, allowedTools: ['Bash'], mcpContextUris: ['x'] },
    },
    hasCompletedOnboarding: true,
  })
  const settings = JSON.parse(fs.files.get('/home/kc/.claude/settings.json')!)
  assert.deepEqual(settings, {
    model: 'opus',
    enabledPlugins: { 'hoai@hoai': true },
    skipDangerousModePermissionPrompt: true,
  })
})

test('preseedClaudeTrust: a win32 cwd seeds BOTH slash spellings (the ps1 rule), byte-exact keys', () => {
  const fs = memFs()
  const cwd = 'C:\\Users\\kc\\hoai-agents\\ava'
  const result = preseedClaudeTrust({ configDir: 'C:\\Users\\kc\\.claude', cwd, fs })
  assert.deepEqual(result.seededKeys, [cwd, 'C:/Users/kc/hoai-agents/ava'])
  assert.equal(result.configPath, 'C:\\Users\\kc\\.claude\\.claude.json')
  const cfg = JSON.parse(fs.files.get('C:\\Users\\kc\\.claude\\.claude.json')!)
  assert.deepEqual(Object.keys(cfg.projects), [cwd, 'C:/Users/kc/hoai-agents/ava'])
  assert.deepEqual(cfg.projects[cwd], FULL_ENTRY)
})

test('preseedClaudeTrust: idempotent (a second run produces identical bytes)', () => {
  const fs = memFs()
  preseedClaudeTrust({ configDir: '/c', cwd: '/w', fs })
  const first = [fs.files.get('/c/.claude.json'), fs.files.get('/c/settings.json')]
  preseedClaudeTrust({ configDir: '/c', cwd: '/w', fs })
  assert.deepEqual([fs.files.get('/c/.claude.json'), fs.files.get('/c/settings.json')], first)
})

test('preseedClaudeTrust: corrupt existing files are treated as empty (the bootstrap load() rule)', () => {
  const fs = memFs({ '/c/.claude.json': '{not json', '/c/settings.json': '' })
  preseedClaudeTrust({ configDir: '/c', cwd: '/w', fs })
  assert.equal(JSON.parse(fs.files.get('/c/.claude.json')!).projects['/w'].hasTrustDialogAccepted, true)
  assert.equal(JSON.parse(fs.files.get('/c/settings.json')!).skipDangerousModePermissionPrompt, true)
})

test('preseedClaudeTrust: refuses an empty cwd or config dir instead of seeding a junk key', () => {
  const fs = memFs()
  assert.throws(() => preseedClaudeTrust({ configDir: '/c', cwd: '', fs }), /cwd/)
  assert.throws(() => preseedClaudeTrust({ configDir: '', cwd: '/w', fs }), /configDir/)
  assert.equal(fs.files.size, 0)
})

// --- marketplace auto-update enrolment (2026-08-30) --------------------------
// Claude Code updates a marketplace and its plugins on its own, but only when the settings entry
// says so or the marketplace name is on Anthropic's first-party allowlist. Ours is not on that list,
// so without this key every machine stays on whatever version it first installed. The cost is not
// hypothetical: openai-codex, the most-used plugin on the author's own machine, sat four months
// stale for exactly this reason, and nothing said a word.

test('ensureMarketplaceAutoUpdate sets the key on an existing entry, and is idempotent', () => {
  const fs = memFs({
    '/cfg/settings.json': JSON.stringify({
      extraKnownMarketplaces: {
        hoai: { source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' } },
      },
    }),
  })

  const first = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(first.changed, true)
  assert.equal(first.reason, 'set')
  assert.equal(
    JSON.parse(fs.files.get('/cfg/settings.json')!).extraKnownMarketplaces.hoai.autoUpdate,
    true,
  )

  const second = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(second.changed, false)
  assert.equal(second.reason, 'already')
})

test('ensureMarketplaceAutoUpdate never fabricates a marketplace declaration', () => {
  // Writing an entry that the user never added would silently register a marketplace on their
  // machine. If it is not there, we are not the ones to put it there.
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: {} }) })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'no_entry')
  assert.deepEqual(JSON.parse(fs.files.get('/cfg/settings.json')!).extraKnownMarketplaces, {})
})

test('ensureMarketplaceAutoUpdate does nothing when settings has no marketplaces at all', () => {
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ model: 'opus' }) })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'no_entry')
  assert.equal(JSON.parse(fs.files.get('/cfg/settings.json')!).model, 'opus')
})

test('ensureMarketplaceAutoUpdate preserves every other setting and the entry source', () => {
  // This is the user's own settings file. Losing an unrelated key here would be a far worse bug
  // than the one being fixed.
  const fs = memFs({
    '/cfg/settings.json': JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      extraKnownMarketplaces: {
        hoai: { source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' } },
        other: { source: { source: 'github', repo: 'someone/else' } },
      },
    }),
  })

  ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  const after = JSON.parse(fs.files.get('/cfg/settings.json')!)

  assert.equal(after.model, 'opus')
  assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] })
  assert.deepEqual(after.extraKnownMarketplaces.hoai.source, {
    source: 'github',
    repo: 'BrandGrowthOS/hoai-marketplace',
  })
  assert.equal(after.extraKnownMarketplaces.hoai.autoUpdate, true)
  // A sibling marketplace is none of our business.
  assert.equal(after.extraKnownMarketplaces.other.autoUpdate, undefined)
})

test('ensureMarketplaceAutoUpdate can turn enrolment off again', () => {
  const fs = memFs({
    '/cfg/settings.json': JSON.stringify({
      extraKnownMarketplaces: { hoai: { source: {}, autoUpdate: true } },
    }),
  })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', enabled: false, fs })
  assert.equal(r.changed, true)
  assert.equal(JSON.parse(fs.files.get('/cfg/settings.json')!).extraKnownMarketplaces.hoai.autoUpdate, false)
})

test('ensureMarketplaceAutoUpdate treats a corrupt settings file as empty rather than throwing', () => {
  // A daemon boot must never fail because settings.json was half-written by something else.
  const fs = memFs({ '/cfg/settings.json': '{ not json' })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'no_entry')
})

test('ensureMarketplaceAutoUpdate requires a config dir rather than guessing one', () => {
  assert.throws(() => ensureMarketplaceAutoUpdate({ configDir: '', marketplace: 'hoai', fs: memFs() }))
})

// --- the two ways enrolment could do harm rather than nothing ----------------
//
// Both of these came out of an adversarial pass over the enrolment change. Neither is exotic: the
// first is reachable from a directory name, and the second happens to every user who has ever
// switched auto-update off.

test('an explicit autoUpdate:false is a decision, and a daemon boot must not overturn it', () => {
  // ensureMarketplaceAutoUpdate runs on EVERY daemon boot. If a false were treated the same as a
  // missing key, a user who deliberately opted out would be re-enrolled within minutes, silently,
  // and would have no way to make the setting stick.
  const before = JSON.stringify({
    extraKnownMarketplaces: { hoai: { source: {}, autoUpdate: false } },
  })
  const fs = memFs({ '/cfg/settings.json': before })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'declined')
  assert.equal(fs.files.get('/cfg/settings.json'), before, 'the file must not be rewritten at all')
})

test('a marketplace named __proto__ cannot reach Object.prototype', () => {
  // The name is not ours: it comes off the filesystem, from a directory under the plugin cache. So
  // a directory called __proto__ is an input, and an unguarded entries[name] would both READ a
  // truthy object (Object.prototype) and then WRITE autoUpdate onto it, poisoning every plain
  // object in the process for the rest of its life.
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: {} }) })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: '__proto__', fs })
  assert.equal(r.reason, 'no_entry', 'the prototype is not an entry')
  assert.equal(r.changed, false)
  // The real assertion: nothing leaked onto the prototype.
  assert.equal(({} as Record<string, unknown>).autoUpdate, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'autoUpdate'), false)
})

test('a marketplace named constructor is likewise not an entry', () => {
  // Same class, different key. hasOwnProperty is what makes the whole family a non-issue.
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: {} }) })
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'constructor', fs })
  assert.equal(r.reason, 'no_entry')
  assert.equal(r.changed, false)
})

test('an inherited autoUpdate does not count as an existing entry', () => {
  // A settings object whose PROTOTYPE carries the marketplace must still read as absent: the
  // hasOwnProperty guard is on the entries map, and this pins that it is the map being guarded.
  const proto = { hoai: { source: {}, autoUpdate: true } }
  const entries = Object.create(proto) as Record<string, unknown>
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: {} }) })
  // Feed the inherited shape in directly by rewriting the parsed file: JSON cannot express a
  // prototype, so this is the only way to reach the branch.
  const settings = { extraKnownMarketplaces: entries }
  assert.equal(Object.prototype.hasOwnProperty.call(settings.extraKnownMarketplaces, 'hoai'), false)
  assert.equal((settings.extraKnownMarketplaces as Record<string, unknown>).hoai, proto.hoai)
  // And the function, given the same name against an empty own-map, reports no entry.
  assert.equal(ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs }).reason, 'no_entry')
})


// --- durability: the write has to survive, and it has to leave nothing behind ---
//
// Two separate OS processes write ~/.claude/settings.json: this daemon and the `claude` binary.
// Neither takes a lock, and the CLI will not start doing so, so the only honest options are to
// verify the write or to stop claiming it happened. These pin both.

/** A memFs that also models rename, so writeJsonAtomic takes its atomic branch. */
function renamingFs(initial: Record<string, string> = {}) {
  const base = memFs(initial)
  const removed: string[] = []
  return {
    ...base,
    removed,
    rename: (from: string, to: string) => {
      const text = base.files.get(from)
      if (text === undefined) throw new Error(`rename: ${from} does not exist`)
      base.files.delete(from)
      base.files.set(to, text)
    },
    remove: (path: string) => {
      removed.push(path)
      base.files.delete(path)
    },
  }
}

test('a failed rename leaves no temp file behind in the user home', () => {
  // This path runs on every daemon boot, in ~/.claude, beside the file Claude Code itself reads.
  // A cross-device rename and a locked target are the two ways it fails in practice on Windows, and
  // before this the residue simply accumulated.
  const fs = renamingFs({
    '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: { hoai: { source: {} } } }),
  })
  const boom = {
    ...fs,
    rename: () => {
      throw new Error('EXDEV: cross-device link not permitted')
    },
  }
  assert.throws(() => ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: boom }))
  const leftovers = [...fs.files.keys()].filter((k) => k.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `a temp file survived: ${leftovers.join(', ')}`)
  assert.equal(fs.removed.length, 1, 'the cleanup must have been attempted exactly once')
})

test('a write that does not stick is reported as not_persisted, never as success', () => {
  // The real sequence: we read, claude reads, we write, claude writes its older snapshot back. The
  // key is gone and the old code had already logged "this machine now self-updates".
  const seed = JSON.stringify({ extraKnownMarketplaces: { hoai: { source: {} } } })
  const fs = renamingFs({ '/cfg/settings.json': seed })
  const clobbering = {
    ...fs,
    rename: (from: string, to: string) => {
      fs.files.delete(from)
      // Whatever we wrote, the competing writer puts its own copy back.
      fs.files.set(to, seed)
    },
  }
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: clobbering })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'not_persisted')
  assert.equal(
    JSON.parse(fs.files.get('/cfg/settings.json')!).extraKnownMarketplaces.hoai.autoUpdate,
    undefined,
    'and the file really is unchanged, so the report matches the disk',
  )
})

test('a write clobbered once is retried and then succeeds', () => {
  // The windows are lopsided: ours is about 2.5 ms and claude's is 80 to 300 ms, so the second
  // attempt usually lands after the writer that beat us. The retry is why this is worth doing at
  // all rather than only reporting failure.
  const seed = JSON.stringify({ extraKnownMarketplaces: { hoai: { source: {} } } })
  const fs = renamingFs({ '/cfg/settings.json': seed })
  let clobbers = 1
  const flaky = {
    ...fs,
    rename: (from: string, to: string) => {
      const text = fs.files.get(from)!
      fs.files.delete(from)
      if (clobbers > 0) {
        clobbers--
        fs.files.set(to, seed)
        return
      }
      fs.files.set(to, text)
    },
  }
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: flaky })
  assert.equal(r.reason, 'set')
  assert.equal(
    JSON.parse(fs.files.get('/cfg/settings.json')!).extraKnownMarketplaces.hoai.autoUpdate,
    true,
  )
})

test('a retry never recreates an entry a competing writer deleted', () => {
  // Between attempts the marketplace can be removed entirely, by `claude plugin marketplace remove`
  // or by the add rewriting the block. Writing our key back then would invent a marketplace the CLI
  // never registered, which is worse than doing nothing.
  const fs = renamingFs({
    '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: { hoai: { source: {} } } }),
  })
  const vanishing = {
    ...fs,
    rename: (from: string, to: string) => {
      fs.files.delete(from)
      fs.files.set(to, JSON.stringify({ extraKnownMarketplaces: {} }))
    },
  }
  const r = ensureMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: vanishing })
  assert.equal(r.changed, false)
  const after = JSON.parse(fs.files.get('/cfg/settings.json')!)
  assert.deepEqual(after.extraKnownMarketplaces, {}, 'the entry must stay gone')
})


// --- reading the enrolment back, for /status --------------------------------
//
// Three-valued on purpose. A machine wrongly told it self-updates is the exact silent failure this
// release exists to end, so "we could not tell" must survive all the way to the reply.

test('an enrolled marketplace reads back as enrolled', () => {
  const fs = memFs({
    '/cfg/settings.json': JSON.stringify({
      extraKnownMarketplaces: { hoai: { source: {}, autoUpdate: true } },
    }),
  })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs }), true)
})

test('a present entry with no autoUpdate key reads as NOT enrolled, because that is what it means', () => {
  // Claude Code defaults the flag off for every marketplace that is not one of its own, so an absent
  // key here is a real answer and not an unknown: the machine does not self-update.
  const fs = memFs({
    '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: { hoai: { source: {} } } }),
  })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs }), false)
  const off = memFs({
    '/cfg/settings.json': JSON.stringify({
      extraKnownMarketplaces: { hoai: { source: {}, autoUpdate: false } },
    }),
  })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: off }), false)
})

test('an unreadable or corrupt settings file reads as UNKNOWN, never as an answer', () => {
  // The distinction that matters: we never saw the file, so we know nothing. Reporting that as
  // "not enrolled" would send someone to fix a machine that is fine; reporting it as "enrolled"
  // would leave a machine stranded. Both are worse than saying so.
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: memFs() }), null)
  const corrupt = memFs({ '/cfg/settings.json': '{ not json' })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: corrupt }), null)
  const noBlock = memFs({ '/cfg/settings.json': JSON.stringify({}) })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: noBlock }), null)
  const notOurs = memFs({
    '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: { other: { autoUpdate: true } } }),
  })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs: notOurs }), null)
})

test('the reader uses the same own-property rule as the writer', () => {
  // A reader and a writer that disagree about what counts as an entry would report a state nobody
  // wrote. __proto__ is the case that separates them, and the name comes off the filesystem.
  const fs = memFs({ '/cfg/settings.json': JSON.stringify({ extraKnownMarketplaces: {} }) })
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: '__proto__', fs }), null)
  assert.equal(readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'constructor', fs }), null)
})

test('a truthy non-boolean autoUpdate is not read as enrolment', () => {
  // The value comes from a user-editable file, so "yes" or 1 are shapes that can appear. Claude Code
  // reads the key as a boolean, so anything else is not enrolment, and guessing generously here
  // would tell a machine it self-updates when it does not.
  for (const value of ['true', 1, {}, []] as unknown[]) {
    const fs = memFs({
      '/cfg/settings.json': JSON.stringify({
        extraKnownMarketplaces: { hoai: { source: {}, autoUpdate: value } },
      }),
    })
    assert.equal(
      readMarketplaceAutoUpdate({ configDir: '/cfg', marketplace: 'hoai', fs }),
      false,
      `${JSON.stringify(value)} must not read as enrolled`,
    )
  }
})
