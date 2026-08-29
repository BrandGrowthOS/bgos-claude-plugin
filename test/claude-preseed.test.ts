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
