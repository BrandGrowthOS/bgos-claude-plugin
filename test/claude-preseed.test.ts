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
