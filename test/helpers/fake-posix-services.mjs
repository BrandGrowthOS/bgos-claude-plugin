#!/usr/bin/env node
/**
 * A faked launchd gui/<uid> domain, systemd --user manager and tmux socket
 * directory for the bin/bgos-agent tests, run as the `launchctl`, `systemctl`,
 * `loginctl` and `tmux` on PATH: `node fake-posix-services.mjs <state.json> <tool> args...`.
 * Its state is ONE file per user account, shared by every HOME a test runs
 * bgos-agent from, which is exactly the hazard under test: one domain, one
 * manager and one socket directory per account, whatever HOME is set.
 * Nothing real is ever touched.
 *
 * It models the primitives, never the decisions:
 *   launchctl  bootout gui/<uid>/<label> | bootout gui/<uid> <plist> (the label
 *              is read from the plist, as launchctl does), bootstrap gui/<uid>
 *              <plist>, kickstart -k gui/<uid>/<label>, print gui/<uid>/<label>
 *              (the shape test/helpers/fake-service-host.ts prints), list
 *   systemctl  --user show-environment, daemon-reload, enable [--now], disable
 *              [--now], start, restart, stop, is-active [--quiet], status, show,
 *              list-units. The manager reads unit files ONLY from its own HOME
 *              (state.managerHome), as a real user manager reads only the
 *              account's ~/.config/systemd/user; a drop-in's Conflicts= makes a
 *              start stop the other unit first (one job).
 *   tmux       -L <socket> kill-server | has-session | list-sessions
 * `state.panes` (socket -> working directories) answers `tmux list-panes`.
 * Every call is appended to state.calls with the loaded jobs, enabled and active
 * units and live tmux servers right after it, so a test can prove "never two at
 * once" and "never none". `fail` in the state makes matching calls fail (a substring, or the
 * whole line with `exact`); `killCallerOn` (a whole line) kills the process that ran that call,
 * once, right after it (an installer inside the job it ends). `watch` (a path) records that file's
 * content in each call as `watched` (what a job started by that call would run); `unloadWith`
 * ({ line, label, skip }) unloads that job when that whole line runs, after `skip` runs of it (an
 * earlier bootout that was only slow, finishing then).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const plistValue = (content, key) => {
  const m = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(content)
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null
}
const plistArgs = (content) => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)
  return block ? [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&amp;/g, '&')) : []
}
const unitLine = (content, key) => {
  const line = String(content).split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1) : null
}

export function readState(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function newState({ uid = 501, managerHome }) {
  return { uid, managerHome, launchd: {}, enabled: [], active: [], tmux: [], fail: [], calls: [] }
}

function run(state, tool, args) {
  const out = (stdout = '', code = 0, stderr = '') => ({ code, stdout, stderr })
  const unitDir = join(state.managerHome, '.config', 'systemd', 'user')
  const unitFile = (unit) => join(unitDir, `${unit.replace(/\.service$/, '')}.service`)
  const unitName = (unit) => unit.replace(/\.service$/, '')
  if (tool === 'launchctl') {
    const [verb] = args
    const labelOf = (target) => target.replace(new RegExp(`^gui/${state.uid}/`), '')
    if (verb === 'bootout') {
      let label
      if (args.length >= 3) {
        if (!existsSync(args[2])) return out('', 5, 'Boot-out failed: 5: Input/output error')
        label = plistValue(readFileSync(args[2], 'utf8'), 'Label')
      } else label = labelOf(args[1])
      if (!state.launchd[label]) return out('', 113, `Boot-out failed: 113: Could not find service "${label}" in domain for user gui: ${state.uid}`)
      delete state.launchd[label]
      return out()
    }
    if (verb === 'bootstrap') {
      const plistPath = args[2]
      if (!existsSync(plistPath)) return out('', 5, 'Bootstrap failed: 5: Input/output error')
      const content = readFileSync(plistPath, 'utf8')
      const label = plistValue(content, 'Label')
      if (state.launchd[label]) return out('', 5, 'Bootstrap failed: 5: Input/output error')
      state.launchd[label] = { plistPath, content }
      return out()
    }
    if (verb === 'kickstart') {
      const label = labelOf(args[2])
      return state.launchd[label] ? out() : out('', 113, `Could not find service "${label}" in domain for user gui: ${state.uid}`)
    }
    if (verb === 'print') {
      const label = labelOf(args[1])
      const job = state.launchd[label]
      if (!job) return out('', 113, `Bad request.\nCould not find service "${label}" in domain for user gui: ${state.uid}`)
      const argv = plistArgs(job.content)
      const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(job.content)?.[1] ?? ''
      const env = [...envBlock.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)].map((m) => `\t\t${m[1]} => ${m[2].replace(/&amp;/g, '&')}`)
      return out(
        [
          `gui/${state.uid}/${label} = {`,
          '\tactive count = 1',
          `\tpath = ${job.plistPath}`,
          '\ttype = LaunchAgent',
          '\tstate = running',
          '',
          `\tprogram = ${argv[0] ?? ''}`,
          '\targuments = {',
          ...argv.map((a) => `\t\t${a}`),
          '\t}',
          '',
          `\tworking directory = ${plistValue(job.content, 'WorkingDirectory') ?? ''}`,
          '',
          '\tenvironment = {',
          ...env,
          `\t\tXPC_SERVICE_NAME => ${label}`,
          '\t}',
          '',
          `\tdomain = gui/${state.uid} [100005]`,
          '}',
          '',
        ].join('\n'),
      )
    }
    if (verb === 'list') return out(['PID\tStatus\tLabel', ...Object.keys(state.launchd).map((l, i) => `${1000 + i}\t0\t${l}`)].join('\n') + '\n')
    return out('', 1, `fake launchctl: ${verb} is not modelled`)
  }
  if (tool === 'systemctl') {
    if (args[0] !== '--user') return out('', 1, 'fake systemctl: only --user')
    const verb = args[1]
    const unit = unitName(args[args.length - 1])
    const known = (u) => existsSync(unitFile(u))
    const conflicts = (u) => {
      const dir = `${unitFile(u)}.d`
      if (!existsSync(dir)) return []
      const found = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.conf')) continue
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
          const m = /^Conflicts=(.+)\.service$/.exec(line.trim())
          if (m) found.push(m[1])
        }
      }
      return found
    }
    const stop = (u) => (state.active = state.active.filter((a) => a !== u))
    const startUnit = (u) => {
      for (const other of conflicts(u)) stop(other)
      if (!state.active.includes(u)) state.active.push(u)
    }
    switch (verb) {
      case 'show-environment':
        // The manager's own environment: its HOME is the account's, whatever HOME the caller has.
        return out(`HOME=${state.managerHome}\nPATH=/usr/bin:/bin\n`)
      case 'daemon-reload':
        return out()
      case 'enable':
        if (!known(unit)) return out('', 1, `Failed to enable unit: Unit file ${unit}.service does not exist.`)
        if (!state.enabled.includes(unit)) state.enabled.push(unit)
        if (args.includes('--now')) startUnit(unit)
        return out()
      case 'disable':
        if (!known(unit) && !state.enabled.includes(unit)) return out('', 1, `Failed to disable unit: Unit file ${unit}.service does not exist.`)
        state.enabled = state.enabled.filter((e) => e !== unit)
        if (args.includes('--now')) stop(unit)
        return out()
      case 'start':
        if (!known(unit)) return out('', 5, `Failed to start ${unit}.service: Unit ${unit}.service not found.`)
        startUnit(unit)
        return out()
      case 'restart':
        if (!known(unit)) return out('', 5, `Failed to restart ${unit}.service: Unit ${unit}.service not found.`)
        stop(unit)
        startUnit(unit)
        return out()
      case 'stop':
        if (!known(unit) && !state.active.includes(unit)) return out('', 5, `Failed to stop ${unit}.service: Unit ${unit}.service not loaded.`)
        stop(unit)
        return out()
      case 'is-active':
        return state.active.includes(unit) ? out('active\n') : out('inactive\n', 3)
      case 'status':
        return known(unit) ? out(`● ${unit}.service\n   Active: ${state.active.includes(unit) ? 'active (running)' : 'inactive (dead)'}\n`, state.active.includes(unit) ? 0 : 3) : out('', 4, `Unit ${unit}.service could not be found.`)
      case 'show': {
        if (!known(unit) && !state.enabled.includes(unit)) {
          return out('LoadState=not-found\nActiveState=inactive\nFragmentPath=\nWorkingDirectory=\nEnvironment=\n')
        }
        const content = known(unit) ? readFileSync(unitFile(unit), 'utf8') : ''
        const envs = content.split('\n').filter((l) => l.startsWith('Environment=')).map((l) => l.slice('Environment='.length).replace(/^"(.*)"$/, '$1'))
        return out(
          [
            `Environment=${envs.join(' ')}`,
            `WorkingDirectory=${unitLine(content, 'WorkingDirectory') ?? ''}`,
            `FragmentPath=${unitFile(unit)}`,
            'LoadState=loaded',
            `ActiveState=${state.active.includes(unit) ? 'active' : 'inactive'}`,
          ].join('\n') + '\n',
        )
      }
      case 'list-units':
        return out(state.enabled.concat(state.active.filter((a) => !state.enabled.includes(a))).map((u) => `${u}.service loaded ${state.active.includes(u) ? 'active running' : 'inactive dead'} x`).join('\n') + '\n')
      default:
        return out('', 1, `fake systemctl: ${verb} is not modelled`)
    }
  }
  if (tool === 'loginctl') return out()
  if (tool === 'tmux') {
    const at = args.indexOf('-L')
    const socket = at >= 0 ? args[at + 1] : 'default'
    const verb = args.find((a, i) => i > at + 1 && !a.startsWith('-') && args[i - 1] !== '-f') ?? ''
    if (verb === 'kill-server') {
      if (!state.tmux.includes(socket)) return out('', 1, 'no server running')
      state.tmux = state.tmux.filter((s) => s !== socket)
      return out()
    }
    if (verb === 'has-session' || verb === 'list-sessions') return state.tmux.includes(socket) ? out(`${socket}: 1 windows\n`) : out('', 1, 'no server running')
    // list-panes -a -F '#{pane_current_path}': where the server's panes run (state.panes, seeded by a test).
    if (verb === 'list-panes') return state.tmux.includes(socket) ? out(((state.panes ?? {})[socket] ?? []).map((p) => `${p}\n`).join('')) : out('', 1, 'no server running')
    return out()
  }
  return out('', 127, `fake: ${tool} is not modelled`)
}

function main() {
  const [statePath, tool, ...args] = process.argv.slice(2)
  const state = readState(statePath)
  const line = `${tool} ${args.join(' ')}`
  // A match is a substring, or the whole line when `exact` is set (ai.bgos.agent.42 is a prefix of its scoped label).
  const matches = (f, text) => (f.exact ? text === f.match : text.includes(f.match))
  const failure = (state.fail ?? []).find((f) => matches(f, line) && (f.times ?? 1) > 0)
  let result
  if (failure) {
    failure.times = (failure.times ?? 1) - 1
    result = { code: failure.code ?? 1, stdout: '', stderr: failure.stderr ?? `fake: ${failure.match} failed` }
  } else result = run(state, tool, args)
  const slow = state.unloadWith
  if (slow && line === slow.line) {
    if ((slow.skip ?? 0) > 0) slow.skip -= 1
    else {
      delete state.launchd[slow.label]
      state.unloadWith = null
    }
  }
  const watched = state.watch && existsSync(state.watch) ? readFileSync(state.watch, 'utf8') : null
  state.calls.push({ cmd: line, code: result.code, loaded: Object.keys(state.launchd), enabled: [...state.enabled], active: [...state.active], tmux: [...state.tmux], ...(state.watch ? { watched } : {}) })
  // killCallerOn: the caller lives inside what this command ends (a hoai-agent install typed into the
  // agent's own session dies at the bootout of its job): the command is done, then the caller is killed.
  const kill = state.killCallerOn && line === state.killCallerOn
  if (kill) state.killCallerOn = null
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  if (kill) process.kill(process.ppid, 'SIGKILL')
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(`${result.stderr}\n`)
  process.exit(result.code)
}

if (process.argv[1] && /fake-posix-services\.mjs$/.test(process.argv[1])) main()
