/**
 * lib/update-planner.mjs: table driven eval of planMachine.
 *
 * The fixture file test/fixtures/update-planner-cases.json is the dataset;
 * it is ported verbatim to the BGOS evals repo, so every rule the planner
 * encodes must appear there as a case. This file runs each case against the
 * expected verdict / reason / target / step kinds / targets / onFailure / via
 * / notes, and then checks a set of structural invariants that hold for
 * EVERY case regardless of what the fixture author wrote down:
 *   determinism, input never mutated, unique stable step ids, no step after
 *   a block, a snapshot before every mutating step, agents in ascending id
 *   order, restart immediately followed by its verify, refresh_watcher last,
 *   and an output that survives a JSON round trip (no undefined anywhere).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BLOCKED_REASONS,
  INSTALL_METHODS,
  INTENTS,
  MUTATING_STEP_KINDS,
  ON_FAILURE,
  RESTART_MECHANISMS,
  STEP_KINDS,
  compareSemver,
  normalizeAgents,
  parseSemver,
  planMachine,
  restartMechanism,
} from '../lib/update-planner.mjs'

type FixtureCase = {
  name: string
  state: any
  expected: {
    verdict: string
    reason?: string
    targetVersion: string | null
    stepKinds: string[]
    targets?: Record<string, string[]>
    onFailure?: Record<string, string>
    via?: Record<string, string>
    notes?: string[]
    reobserve?: true
  }
}

const REOBSERVE_NOTE = 'agent steps deferred until latest version is known'
const REOBSERVE_KINDS = new Set(['register_marketplace', 'refresh_marketplace', 'verify_installed'])

const fixturePath = fileURLToPath(new URL('./fixtures/update-planner-cases.json', import.meta.url))
const fixtureText = readFileSync(fixturePath, 'utf8')
const cases: FixtureCase[] = JSON.parse(fixtureText).cases

const plannerPath = fileURLToPath(new URL('../lib/update-planner.mjs', import.meta.url))
const plannerSource = readFileSync(plannerPath, 'utf8')

// Built from code points so this file itself contains neither character.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

/** The cases the design names explicitly; the fixture must carry every one. */
const REQUIRED_CASES = [
  'nothing installed on darwin',
  'nothing installed on linux',
  'nothing installed on win32',
  'marketplace missing but plugin cache present',
  'older installed version',
  'already latest with all agents running',
  'already latest with one agent down (reconcile)',
  'dirty clone',
  'clone not fast-forward',
  'clone fast-forward',
  'no restart authority at all (stage)',
  'six agents mixed on darwin',
  'same six on win32',
  'repair intent',
  'latched',
  'disabled',
  'disabled + restart_only',
  'major jump',
  'unknown latest',
  'restart_only with three agents',
  'refreshWatcher true with nothing else to do',
  'malformed agent ids ignored',
  'nothing newer but one agent runs an older version',
]

const DESIGN_STEP_KINDS = [
  'snapshot',
  'register_marketplace',
  'refresh_marketplace',
  'install_plugin',
  'update_plugin',
  'reinstall_plugin',
  'git_fast_forward',
  'verify_installed',
  'restart_agent',
  'verify_agent',
  'rollback',
  'stage_pending_restart',
  'manual_restart_required',
  'refresh_watcher',
]

const AGENT_TARGET_KINDS = new Set(['restart_agent', 'manual_restart_required'])

function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

describe('fixture file', () => {
  test('is well formed: LF endings, no em or en dashes, unique names', () => {
    assert.ok(!fixtureText.includes('\r'), 'fixture must use LF endings')
    assert.ok(!DASHES.test(fixtureText), 'fixture must not contain em or en dashes')
    const names = cases.map((c) => c.name)
    assert.deepEqual(names, [...new Set(names)], 'case names must be unique')
    assert.ok(cases.length >= 22, `expected at least 22 cases, got ${cases.length}`)
  })

  test('carries every case the design names', () => {
    const names = new Set(cases.map((c) => c.name))
    const missing = REQUIRED_CASES.filter((name) => !names.has(name))
    assert.deepEqual(missing, [])
  })

  test('every expected vocabulary token is one the planner exports', () => {
    for (const c of cases) {
      for (const kind of c.expected.stepKinds) {
        assert.ok(STEP_KINDS.includes(kind), `${c.name}: unknown step kind ${kind}`)
      }
      if (c.expected.reason !== undefined) {
        assert.ok(BLOCKED_REASONS.includes(c.expected.reason), `${c.name}: unknown reason ${c.expected.reason}`)
      }
      for (const policy of Object.values(c.expected.onFailure ?? {})) {
        assert.ok(ON_FAILURE.includes(policy), `${c.name}: unknown onFailure ${policy}`)
      }
      for (const via of Object.values(c.expected.via ?? {})) {
        assert.ok(RESTART_MECHANISMS.includes(via), `${c.name}: unknown via ${via}`)
      }
    }
  })

  test('exercises every step kind the planner can emit and every blocked reason', () => {
    const kinds = new Set<string>()
    const reasons = new Set<string>()
    for (const c of cases) {
      for (const kind of c.expected.stepKinds) kinds.add(kind)
      if (c.expected.reason) reasons.add(c.expected.reason)
    }
    // rollback is an executor escalation, never planned up front.
    const plannable = STEP_KINDS.filter((kind) => kind !== 'rollback')
    assert.deepEqual([...plannable].sort(), [...kinds].sort())
    assert.deepEqual([...BLOCKED_REASONS].sort(), [...reasons].sort())
  })
})

describe('vocabulary', () => {
  test('STEP_KINDS is exactly the design list', () => {
    assert.deepEqual([...STEP_KINDS].sort(), [...DESIGN_STEP_KINDS].sort())
  })

  test('mutating kinds are the four that touch the install on disk', () => {
    assert.deepEqual([...MUTATING_STEP_KINDS].sort(), ['git_fast_forward', 'install_plugin', 'reinstall_plugin', 'update_plugin'])
    for (const kind of MUTATING_STEP_KINDS) assert.ok(STEP_KINDS.includes(kind))
  })

  test('intents, install methods, policies and mechanisms are the documented sets', () => {
    assert.deepEqual([...INTENTS], ['update', 'reconcile', 'restart_only', 'repair'])
    assert.deepEqual([...INSTALL_METHODS], ['marketplace', 'clone'])
    assert.deepEqual([...ON_FAILURE], ['escalate', 'rollback', 'stop', 'continue'])
    assert.deepEqual([...RESTART_MECHANISMS], ['marker', 'service', 'recipe'])
  })
})

describe('module purity', () => {
  test('imports nothing and touches no clock, randomness, filesystem or environment', () => {
    const code = plannerSource
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    assert.doesNotMatch(code, /^\s*import\s/m, 'planner must not import')
    assert.doesNotMatch(code, /\brequire\s*\(/, 'planner must not require')
    assert.doesNotMatch(code, /\bDate\b/, 'planner must not read the clock')
    assert.doesNotMatch(code, /Math\.random/, 'planner must not use randomness')
    assert.doesNotMatch(code, /\bprocess\./, 'planner must not read process state')
  })

  test('source uses LF endings and no em or en dashes', () => {
    assert.ok(!plannerSource.includes('\r'))
    assert.ok(!DASHES.test(plannerSource))
  })
})

describe('semver helpers (local copy of lib/self-update.ts rules)', () => {
  test('parseSemver accepts strict three part versions only', () => {
    assert.deepEqual(parseSemver('0.38.3'), { major: 0, minor: 38, patch: 3 })
    assert.deepEqual(parseSemver('10.0.1'), { major: 10, minor: 0, patch: 1 })
    for (const bad of ['v0.38.3', '0.38', '01.2.3', '1.2.3-beta', '', null, undefined, 1, {}]) {
      assert.equal(parseSemver(bad as any), null, `should reject ${String(bad)}`)
    }
  })

  test('compareSemver orders by major, then minor, then patch', () => {
    const v = (s: string) => parseSemver(s)!
    assert.equal(compareSemver(v('0.38.3'), v('0.38.3')), 0)
    assert.equal(compareSemver(v('0.38.4'), v('0.38.3')), 1)
    assert.equal(compareSemver(v('0.38.3'), v('0.39.0')), -1)
    assert.equal(compareSemver(v('1.0.0'), v('0.99.99')), 1)
    assert.equal(compareSemver(v('0.38.10'), v('0.38.9')), 1)
  })
})

describe('agent helpers', () => {
  test('normalizeAgents sorts ascending by numeric id and names what it drops', () => {
    const { agents, notes } = normalizeAgents([
      { assistantId: '918', supervisor: 'none', recipe: false, cwd: null, running: true },
      { assistantId: '7', supervisor: 'none', recipe: false, cwd: null, running: true },
      { assistantId: 'x', supervisor: 'none', recipe: false, cwd: null, running: true },
      { assistantId: '7', supervisor: 'none', recipe: false, cwd: null, running: true },
      { assistantId: '1001', supervisor: 'none', recipe: false, cwd: null, running: true },
    ])
    assert.deepEqual(agents.map((a) => a.assistantId), ['7', '918', '1001'])
    assert.deepEqual(notes, ['ignored agent with malformed id "x"', 'ignored duplicate agent id "7"'])
  })

  test('normalizeAgents tolerates a missing or non-array fleet', () => {
    assert.deepEqual(normalizeAgents(undefined), { agents: [], notes: [] })
    assert.deepEqual(normalizeAgents(null), { agents: [], notes: [] })
    assert.deepEqual(normalizeAgents('nope' as any), { agents: [], notes: [] })
  })

  test('restartMechanism follows the authority ladder and the win32 service rule', () => {
    const base = { assistantId: '1', cwd: '/x', recipe: true, running: true }
    assert.equal(restartMechanism({ ...base, supervisor: 'launcher-live' }, 'darwin'), 'marker')
    assert.equal(restartMechanism({ ...base, supervisor: 'service' }, 'linux'), 'service')
    assert.equal(restartMechanism({ ...base, supervisor: 'service' }, 'win32'), 'recipe')
    assert.equal(restartMechanism({ ...base, supervisor: 'service', recipe: false }, 'win32'), null)
    assert.equal(restartMechanism({ ...base, supervisor: 'none' }, 'linux'), 'recipe')
    assert.equal(restartMechanism({ ...base, supervisor: 'none', recipe: false }, 'linux'), null)
    assert.equal(restartMechanism({ ...base, supervisor: 'none', cwd: null }, 'linux'), null)
    assert.equal(restartMechanism({ ...base, supervisor: 'none', cwd: '' }, 'linux'), null)
  })
})

/** Invariants that hold for every plan, whatever the input. */
function assertInvariants(name: string, state: any, plan: ReturnType<typeof planMachine>) {
  const label = (msg: string) => `${name}: ${msg}`

  // Shape.
  assert.ok(['nothing_to_do', 'plan', 'blocked'].includes(plan.verdict), label('verdict vocabulary'))
  assert.ok(plan.targetVersion === null || parseSemver(plan.targetVersion) !== null, label('targetVersion is null or strict semver'))
  assert.ok(Array.isArray(plan.steps), label('steps array'))
  assert.ok(Array.isArray(plan.notes), label('notes array'))
  if (plan.verdict === 'blocked') {
    assert.ok(BLOCKED_REASONS.includes(plan.reason as string), label(`blocked reason ${plan.reason}`))
  } else {
    assert.ok(!('reason' in plan), label('reason only on blocked'))
  }

  // A rollback latch means "install nothing": only restart_only gets past it,
  // it must say so in notes, and it must never carry a mutating step.
  if (state && state.rollbackLatched === true && plan.verdict !== 'blocked') {
    assert.equal(state.intent, 'restart_only', label('only restart_only passes a latch'))
    assert.ok(plan.notes.includes('updates latched, restart only'), label('latched restart is noted'))
    assert.equal(plan.steps.filter((s) => MUTATING_STEP_KINDS.includes(s.kind)).length, 0, label('latched plan installs nothing'))
  }

  // A re-observe plan is a partial plan: refresh + verify only, nothing that
  // could restart an agent twice or exit the watcher before the re-plan.
  if ('reobserve' in plan) {
    assert.equal(plan.reobserve, true, label('reobserve is exactly true when present'))
    assert.equal(plan.verdict, 'plan', label('reobserve is a plan'))
    assert.equal(plan.targetVersion, null, label('reobserve has no target'))
    assert.ok(plan.steps.every((s) => REOBSERVE_KINDS.has(s.kind)), label('reobserve carries only marketplace steps'))
    assert.equal(plan.steps[plan.steps.length - 1]?.kind, 'verify_installed', label('reobserve ends in verify_installed'))
    assert.ok(plan.notes.includes(REOBSERVE_NOTE), label('reobserve is explained in notes'))
  } else {
    assert.ok(!plan.notes.includes(REOBSERVE_NOTE), label('deferral note only on reobserve'))
  }

  // No undefined anywhere: a JSON round trip must be lossless.
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, label('JSON round trip'))

  // Determinism and no input mutation.
  const before = deepClone(state)
  const again = planMachine(deepClone(state))
  assert.deepEqual(again, plan, label('deterministic'))
  planMachine(state)
  assert.deepEqual(state, before, label('input not mutated'))

  // Nothing after a block; nothing_to_do is exactly "no steps".
  if (plan.verdict === 'blocked') assert.equal(plan.steps.length, 0, label('blocked has no steps'))
  if (plan.verdict === 'nothing_to_do') assert.equal(plan.steps.length, 0, label('nothing_to_do has no steps'))
  if (plan.verdict === 'plan') assert.ok(plan.steps.length > 0, label('plan has steps'))

  // Step ids: stable, unique, positional.
  const ids = plan.steps.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, label('step ids unique'))
  plan.steps.forEach((step, index) => {
    const expectedId = `s${String(index + 1).padStart(2, '0')}-${step.kind}${step.target ? `-${step.target}` : ''}`
    assert.equal(step.id, expectedId, label(`step id at ${index}`))
    assert.ok(STEP_KINDS.includes(step.kind), label(`step kind ${step.kind}`))
    assert.ok(ON_FAILURE.includes(step.onFailure), label(`onFailure ${step.onFailure}`))
    assert.equal(typeof step.why, 'string', label('why is a string'))
    assert.ok(step.why.length > 0 && step.why.length <= 120, label('why is short and present'))
    assert.doesNotMatch(step.why, DASHES, label('why has no em or en dashes'))
    assert.deepEqual(
      Object.keys(step).filter((k) => !['id', 'kind', 'target', 'via', 'onFailure', 'why'].includes(k)),
      [],
      label('no unexpected step fields'),
    )
    if (step.kind === 'restart_agent') {
      assert.ok(RESTART_MECHANISMS.includes(step.via as string), label('restart_agent carries via'))
      assert.ok(step.why.includes(step.via as string) || step.why.includes('launcher marker') || step.why.includes('service unit') || step.why.includes('launch recipe'), label('restart why names the mechanism'))
    } else {
      assert.ok(!('via' in step), label('via only on restart_agent'))
    }
    if (['restart_agent', 'verify_agent', 'manual_restart_required'].includes(step.kind)) {
      assert.match(step.target as string, /^\d+$/, label('agent steps target a numeric id'))
    } else {
      assert.ok(!('target' in step), label(`${step.kind} has no target`))
    }
  })

  // Snapshot precedes every mutating kind, exactly once when needed, never otherwise.
  const snapshotIndex = plan.steps.findIndex((s) => s.kind === 'snapshot')
  const snapshotCount = plan.steps.filter((s) => s.kind === 'snapshot').length
  const mutating = plan.steps.filter((s) => MUTATING_STEP_KINDS.includes(s.kind))
  if (mutating.length > 0) {
    assert.equal(snapshotCount, 1, label('exactly one snapshot when mutating'))
    for (const step of mutating) {
      assert.ok(plan.steps.indexOf(step) > snapshotIndex, label(`snapshot precedes ${step.kind}`))
    }
    assert.ok(mutating.length === 1, label('at most one mutating step per plan'))
    const verifyIndex = plan.steps.findIndex((s) => s.kind === 'verify_installed')
    assert.ok(verifyIndex > plan.steps.indexOf(mutating[0]), label('verify_installed follows the mutating step'))
  } else {
    assert.equal(snapshotCount, 0, label('no snapshot without a mutating step'))
  }

  // Agents ascend numerically and each is handled once.
  const agentOrder = plan.steps.filter((s) => AGENT_TARGET_KINDS.has(s.kind)).map((s) => s.target as string)
  assert.deepEqual(agentOrder, [...agentOrder].sort(compareIds), label('agents ascending'))
  assert.equal(new Set(agentOrder).size, agentOrder.length, label('each agent handled once'))

  // restart_agent is immediately followed by verify_agent for the same target.
  plan.steps.forEach((step, index) => {
    if (step.kind !== 'restart_agent') return
    const next = plan.steps[index + 1]
    assert.ok(next && next.kind === 'verify_agent' && next.target === step.target, label(`verify follows restart of ${step.target}`))
  })
  const verifies = plan.steps.filter((s) => s.kind === 'verify_agent').length
  const restarts = plan.steps.filter((s) => s.kind === 'restart_agent').length
  assert.equal(verifies, restarts, label('one verify per restart'))

  // stage_pending_restart only when something was installed and nobody restarts.
  const staged = plan.steps.filter((s) => s.kind === 'stage_pending_restart').length
  if (staged) {
    assert.equal(staged, 1, label('single stage step'))
    assert.ok(mutating.length === 1 && restarts === 0, label('stage only after an install with no restarts'))
  } else if (mutating.length === 1) {
    assert.ok(restarts > 0, label('install without restarts must stage'))
  }

  // Install phase precedes the agent phase; refresh_watcher is last.
  const firstAgentStep = plan.steps.findIndex((s) => ['restart_agent', 'verify_agent', 'manual_restart_required', 'stage_pending_restart'].includes(s.kind))
  const lastInstallStep = plan.steps.map((s) => s.kind).reduce((acc, kind, i) => (['snapshot', 'register_marketplace', 'refresh_marketplace', 'verify_installed', ...MUTATING_STEP_KINDS].includes(kind) ? i : acc), -1)
  if (firstAgentStep !== -1 && lastInstallStep !== -1) {
    assert.ok(lastInstallStep < firstAgentStep, label('install phase before agent phase'))
  }
  const watcherIndex = plan.steps.findIndex((s) => s.kind === 'refresh_watcher')
  if (watcherIndex !== -1) {
    assert.equal(watcherIndex, plan.steps.length - 1, label('refresh_watcher is last'))
    assert.equal(plan.steps.filter((s) => s.kind === 'refresh_watcher').length, 1, label('single refresh_watcher'))
  }
  if (state && state.refreshWatcher === true && plan.verdict !== 'blocked' && !('reobserve' in plan)) {
    assert.notEqual(watcherIndex, -1, label('refreshWatcher true yields a refresh_watcher step'))
  }
}

describe('fixture cases', () => {
  for (const c of cases) {
    describe(c.name, () => {
      test('produces the expected plan', () => {
        const plan = planMachine(deepClone(c.state))
        assert.equal(plan.verdict, c.expected.verdict, 'verdict')
        if (c.expected.verdict === 'blocked') {
          assert.equal(plan.reason, c.expected.reason, 'reason')
        }
        assert.equal(plan.targetVersion, c.expected.targetVersion, 'targetVersion')
        assert.deepEqual(plan.steps.map((s) => s.kind), c.expected.stepKinds, 'step kinds')
        for (const [kind, targets] of Object.entries(c.expected.targets ?? {})) {
          assert.deepEqual(plan.steps.filter((s) => s.kind === kind).map((s) => s.target), targets, `targets of ${kind}`)
        }
        for (const [kind, policy] of Object.entries(c.expected.onFailure ?? {})) {
          const matching = plan.steps.filter((s) => s.kind === kind)
          assert.ok(matching.length > 0, `expected at least one ${kind} step to check onFailure`)
          for (const step of matching) assert.equal(step.onFailure, policy, `onFailure of ${step.id}`)
        }
        for (const [target, via] of Object.entries(c.expected.via ?? {})) {
          const step = plan.steps.find((s) => s.kind === 'restart_agent' && s.target === target)
          assert.ok(step, `expected a restart_agent step for ${target}`)
          assert.equal(step.via, via, `via of ${step.id}`)
        }
        if (c.expected.notes) {
          assert.deepEqual(plan.notes, c.expected.notes, 'notes')
        } else {
          assert.deepEqual(plan.notes, [], 'no notes expected')
        }
        if (c.expected.reobserve) {
          assert.equal(plan.reobserve, true, 'reobserve')
        } else {
          assert.ok(!('reobserve' in plan), 'reobserve only on partial plans')
        }
      })

      test('holds every structural invariant', () => {
        const state = deepClone(c.state)
        assertInvariants(c.name, state, planMachine(state))
      })
    })
  }
})

describe('generated cases beyond the fixture', () => {
  test('a large fleet keeps ids unique, ordered and zero padded past 99 steps', () => {
    const agents = Array.from({ length: 120 }, (_, i) => ({
      assistantId: String(1000 - i),
      cwd: '/home/kc/hoai-agents/a' + i,
      supervisor: 'launcher-live',
      recipe: true,
      running: true,
    }))
    const state: any = {
      platform: 'linux',
      installMethod: 'marketplace',
      runningVersion: '0.38.3',
      marketplace: { registered: true, latestVersion: '0.38.3' },
      installed: { present: true, version: '0.38.3', installPath: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3' },
      autoUpdateEnabled: true,
      rollbackLatched: false,
      agents,
      intent: 'restart_only',
    }
    const plan = planMachine(state)
    assert.equal(plan.verdict, 'plan')
    assert.equal(plan.steps.length, 240)
    assert.equal(plan.steps[0].id, 's01-restart_agent-881')
    assert.equal(plan.steps[99].id, 's100-verify_agent-930')
    assert.equal(plan.steps[239].id, 's240-verify_agent-1000')
    assertInvariants('large fleet', state, plan)
  })

  test('every intent on a fully converged machine is either nothing_to_do or restarts', () => {
    const base: any = {
      platform: 'darwin',
      installMethod: 'marketplace',
      runningVersion: '0.38.3',
      marketplace: { registered: true, latestVersion: '0.38.3' },
      installed: { present: true, version: '0.38.3', installPath: '/Users/kc/.claude/plugins/cache/hoai/hoai/0.38.3' },
      autoUpdateEnabled: true,
      rollbackLatched: false,
      agents: [{ assistantId: '912', cwd: '/Users/kc/hoai-agents/ava', supervisor: 'launcher-live', recipe: true, running: true }],
    }
    const byIntent = Object.fromEntries(INTENTS.map((intent) => [intent, planMachine({ ...base, intent })]))
    assert.equal(byIntent.update.verdict, 'nothing_to_do')
    assert.equal(byIntent.reconcile.verdict, 'nothing_to_do')
    assert.deepEqual(byIntent.restart_only.steps.map((s) => s.kind), ['restart_agent', 'verify_agent'])
    assert.deepEqual(byIntent.repair.steps.map((s) => s.kind), ['refresh_marketplace', 'snapshot', 'reinstall_plugin', 'verify_installed', 'restart_agent', 'verify_agent'])
    for (const [intent, plan] of Object.entries(byIntent)) assertInvariants(`intent ${intent}`, { ...base, intent }, plan)
  })

  test('a plan is a plain object tree with no functions, symbols or prototypes to leak', () => {
    const plan = planMachine(deepClone(cases[0].state))
    const walk = (value: unknown, path: string) => {
      if (value === null) return
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`))
      if (typeof value === 'object') {
        assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} is a plain object`)
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`)
        return
      }
      assert.ok(['string', 'number', 'boolean'].includes(typeof value), `${path} is a primitive (${typeof value})`)
    }
    walk(plan, 'plan')
  })
})
