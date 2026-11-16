/**
 * Source guard: skills_rpc is wired into server.ts the way its tests assume
 * (skills view design, section 7 row 3).
 *
 * lib/skills-inventory.ts and lib/skills-rpc.ts are tested on their own; what
 * they cannot see is how server.ts hands them the world:
 *
 * 1. The lane: answers go to integrations/skills-rpc/:rpcId/ack and /result.
 * 2. The folder: the agent folder is the launcher-supplied BGOS_LAUNCH_CWD, and
 *    NOTHING when that env is absent (LAUNCH_CWD falls back to process.cwd(),
 *    which is the plugin cache on a marketplace install, and a Remove there
 *    would delete the plugin's own skills). The config dir is the resolved
 *    CLAUDE_CONFIG_DIR, never a hardcoded ~/.claude.
 * 3. The guards: whenArmed, the update drain, and the boot home check.
 * 4. The token: skills_list is declared only because this handler exists.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const REGISTRATION = "realtimeSocket.on('skills_rpc', whenArmed('skills_rpc',"

test('a skill write with unknown identity consumes the teach window before another write', () => {
  const start = server.indexOf('function onHookPayload(')
  const end = server.indexOf('  const receivedAt =', start)
  assert.ok(start > 0 && end > start)
  const js = ts.transpileModule(server.slice(start, end) + '}\n', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  let available = true
  let ident: string | null = null
  const stamps: unknown[][] = []
  const scope = {
    parseHookEvent: () => ({ name: 'PostToolUse' }),
    skillFolderOfWrite: () => 'foo',
    SKILLS_AGENT_DIR: 'agent',
    SKILL_ORIGINS_FILE: 'origins.json',
    pathJoin: join,
    identOf: () => ident,
    readOrigins: () => ({ v: 1, skills: {} }),
    teachWindows: { take: () => {
      if (!available) return null
      available = false
      return { by: 'owner' }
    } },
    turnChat: { current: () => ({ chatId: 'chat' }) },
    stampOrigin: (...args: unknown[]) => { stamps.push(args) },
    log: () => {},
  }
  const hook = new Function(...Object.keys(scope), js + '\nreturn onHookPayload')(...Object.values(scope))
  const write = { tool_name: 'Write', tool_input: { file_path: 'SKILL.md' } }
  hook(write)
  ident = '1:2'
  hook(write)
  assert.deepEqual(stamps, [], 'a later write must not inherit the consumed approval')
  available = true
  hook(write)
  assert.deepEqual(stamps, [['origins.json', 'foo', { origin: 'taught', ident: '1:2' }]])
})

test('inventory list applies origins from the sidecar beside the skills trash', () => {
  assert.match(constructionSlice(), /list: \(\) =>\s*applyOrigins\(\s*listSkills\(/)
  assert.match(constructionSlice(), /\}\),\s*SKILL_ORIGINS_FILE/)
  assert.match(server, /const SKILL_ORIGINS_FILE = pathJoin\(pathDirname\(skillsTrashDir\(\)\), 'skill-origins.json'\)/)
})

test('all six tap delivery sites note the teach window through one wrapper', () => {
  assert.equal((server.match(/\bprivateTapCard\(/g) ?? []).length, 1)
  assert.equal((server.match(/\bprivateTapCardNoting\(\{/g) ?? []).length, 6)
  const wrapper = server.slice(server.indexOf('function privateTapCardNoting('), server.indexOf('function privateTapCardNoting(') + 850)
  assert.match(wrapper, /try\s*\{\s*teachWindows.noteTap\(/)
  for (const field of ['chatId', 'tapperUserId', 'ownerUserId', 'callbackData', 'posted']) assert.ok(wrapper.includes(`${field}: input.${field}`), field)
  assert.match(wrapper, /now: Date.now\(\)/)
  assert.match(wrapper, /return privateTapCard\(input\)/)
})

test('only a PostToolUse Write takes the current chat window for an unstamped skill', () => {
  const hook = server.slice(server.indexOf('function onHookPayload('), server.indexOf('function startHookIntakeIfHolder('))
  assert.match(hook, /event.name === 'PostToolUse' && payload.tool_name === 'Write'/)
  assert.match(hook, /skillFolderOfWrite\([^\n]*file_path[^\n]*SKILLS_AGENT_DIR\)/)
  assert.match(hook, /readOrigins\(SKILL_ORIGINS_FILE\)/)
  assert.match(hook, /stamp\?\.ident !== ident/)
  assert.match(hook, /teachWindows.take\(String\(turnChat.current\(Date.now\(\)\)\?\.chatId \?\? ''\), Date.now\(\)\)/)
  assert.match(hook, /stampOrigin\(SKILL_ORIGINS_FILE, folder, \{ origin: 'taught', ident \}\)/)
})

test('install wiring stamps shared origin with destination identity and the offer', () => {
  const built = constructionSlice()
  assert.match(built, /onInstalled: \(dest\) =>/)
  assert.match(built, /identOf\(dest, false\)/)
  assert.match(built, /stampOrigin\(SKILL_ORIGINS_FILE, pathBasename\(dest\),/)
  assert.match(built, /origin: 'shared'/)
  assert.match(built, /offerId: typeof payload.offerId === 'string' \? payload.offerId : undefined/)
})

function handlerSlice(): string {
  const at = server.indexOf(REGISTRATION)
  assert.ok(at > 0, 'skills_rpc is not registered')
  const next = server.indexOf('realtimeSocket.on(', at + REGISTRATION.length)
  return server.slice(at, next > at ? next : at + 1200)
}

function constructionSlice(): string {
  const at = server.indexOf('new SkillsRpcHandler(')
  assert.ok(at > 0, 'server.ts never constructs a SkillsRpcHandler')
  const end = server.indexOf('\n})\n', at)
  assert.ok(end > at)
  return server.slice(at, end)
}

test('the handler answers on the skills lane, behind the drain and the lock', () => {
  const built = constructionSlice()
  assert.match(built, /bgosPost\(`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`/)
  assert.match(built, /bgosPost\(\s*`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`/)
  assert.doesNotMatch(built, /memory-rpc|voice-rpc/)
  const handler = handlerSlice()
  assert.match(handler, /^realtimeSocket\.on\('skills_rpc', whenArmed\('skills_rpc', \(payload: any\) => \{\n\s*if \(updateDrainMode\) return\n/)
  assert.ok(handler.includes('normalizeSkillsRpc('))
  assert.ok(handler.includes('trackMessageOperation(() => skillsRpc.handle(frame))'))
})

test('the agent folder is BGOS_LAUNCH_CWD or nothing, the config dir the resolved one', () => {
  assert.match(
    server,
    /\nconst SKILLS_AGENT_DIR: string \| null = process\.env\.BGOS_LAUNCH_CWD\?\.trim\(\) \? LAUNCH_CWD : null\n/,
  )
  const built = constructionSlice()
  assert.ok(built.includes('agentDir: SKILLS_AGENT_DIR'))
  assert.ok(built.includes('configDir: CLAUDE_CONFIG_DIR'))
  assert.ok(!built.includes('process.cwd()'))
  assert.ok(!built.includes("'.claude'"))
  assert.match(built, /trashDir: skillsTrashDir\(\)/)
  const trash = server.slice(server.indexOf('const skillsTrashDir = '), server.indexOf('const skillsRpc = new SkillsRpcHandler('))
  assert.match(trash, /pluginStateDirFor\(/)
  assert.ok(trash.includes("'skills-trash'"))
  assert.match(built, /\n\s*homeConfirmed: \(\) => HOME_CONFIRMED,\n/)
})

test('the share ops (row 6) get the same agent folder and post progress on the skills lane', () => {
  const built = constructionSlice()
  for (const op of ['exportSkill: (payload) =>', 'installBundle: (payload, progress) =>']) {
    const at = built.indexOf(op)
    assert.ok(at > 0, `${op} is not wired`)
    const slice = built.slice(at, built.indexOf('}),', at))
    assert.ok(slice.includes('agentDir: SKILLS_AGENT_DIR'), op)
    assert.ok(slice.includes('configDir: CLAUDE_CONFIG_DIR'), op)
    assert.ok(slice.includes('managedDir: SKILLS_MANAGED_DIR'), op)
  }
  const install = built.slice(built.indexOf('installBundle: (payload, progress) =>'))
  assert.ok(install.includes('trashDir: skillsTrashDir()'))
  assert.ok(install.includes('platform: process.platform'))
  assert.ok(install.includes('progress,'))
  assert.match(built, /postProgress: \(rpcId, body\) =>\n\s*bgosPost\(`integrations\/skills-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/progress`, body\)/)
})
