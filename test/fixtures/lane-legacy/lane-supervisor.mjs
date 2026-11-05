// Frozen from 522fb683f2c696a05138f7f71b4b13350ffdf3a7:lib/lane-supervisor.mjs.
// Only comments, formatting and imports of unchanged dependencies were adjusted.
// Keep these functions independent of the current launch and comparison code.
import * as nodeFs from 'node:fs';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { agentFolderVerdict, decideLaneRestart, effectiveLaneChoices, laneAllowAdditions, laneDenyAdditions, laneShellReadDenies, laneShellSandbox, laneShellSandboxAvailable, laneToolsFor, ownerMcpServersFrom, readLaneAllowedChoices, readLaneChoices, readLaneRestartRequest, readToolPolicy, LOCKED_TOOL_POLICY, laneMePolicy, } from './lane-policy.mjs';
import { laneSystemPromptBody } from '../../../lib/lane-memory.mjs';
import { ensureLaneSession, fetchLaneMe, laneApiBase } from '../../../lib/lane-session.mjs';
import { availableBytesFromMeminfo, availableBytesFromVmStat, decideLaneCaps, decideLaneIdle, decideLaneRelaunch, laneChildEnv, laneEnvForLaunch, laneDaemonEnv, laneEventLine, laneLaunchArgsFor, laneMachineCeiling, laneLaunchEnv, laneMcpConfigBody, lanePaths, laneSessionArgs, laneSettingsBody, LANE_BUILTIN_TOOLS, LANE_ENV_KEEP, LANE_LOGIN_OWN_TOKEN, LANE_SHELL_LOGIN_REQUIRED, readLaneState, } from './lane-core.mjs';
import { laneConfigSeed, laneTokenStore, loginModeFor, resolveLaneLogin } from '../../../lib/lane-login.mjs';
import { findOnPath } from '../../../lib/lane-cli-probe.mjs';
import { acquireLaneLock, isLiveSupervisor, releaseLaneLock, updateRegistry } from '../../../lib/lane-registry.mjs';
import { buildGateAutoAcceptExpect, ensurePinnedSessionId, EXIT_SUPERVISED_SIGNED_OUT, freshPinnedSessionId, sessionTranscriptPath, tclQuote, } from '../../../bin/hoai-core.mjs';
export function laneArgsTclSafe(args) {
    return args.every((a) => !/[{}\\]/.test(String(a)));
}
export const LANE_WATCH_MS = 5_000;
export const LANE_STOP_GRACE_MS = 10_000;
export const LANE_START_FAILURES_MAX = 3;
export const LANE_START_FAILURES_WINDOW_MS = 60 * 60_000;
export const LANE_NOTICE_TIMEOUT_MS = 90_000;
const START_FAILURE_REASONS = new Set(['no_session', 'identity']);
function writeJsonPrivate(fs, path, value) {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, path);
}
function readJson(fs, path) {
    try {
        return JSON.parse(String(fs.readFileSync(path, 'utf8')));
    }
    catch {
        return null;
    }
}
export function defaultAvailableBytes({ platform = process.platform, run = spawnSync, fs = nodeFs } = {}) {
    try {
        if (platform === 'darwin')
            return availableBytesFromVmStat(String(run('vm_stat', [], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''));
        if (platform === 'linux')
            return availableBytesFromMeminfo(String(fs.readFileSync('/proc/meminfo', 'utf8')));
    }
    catch { }
    return 0;
}
export function defaultSpawnExpect(script, { cwd, env, logPath, fs = nodeFs, spawn = nodeSpawn }) {
    let errFd = 'ignore';
    try {
        errFd = fs.openSync(logPath, 'a', 0o600);
    }
    catch { }
    const child = spawn('expect', ['-c', script], { cwd, env, stdio: ['ignore', 'ignore', errFd] });
    if (typeof errFd === 'number')
        try {
            fs.closeSync(errFd);
        }
        catch { }
    return child;
}
export function defaultRunNotice({ nodePath, pluginRoot, env, cwd, spawn = nodeSpawn, timeoutMs = LANE_NOTICE_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(nodePath, [join(pluginRoot, 'bin', 'bgos-launch.mjs'), join(pluginRoot, 'lane-server.ts')], { cwd, env, stdio: 'ignore' });
        }
        catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch { }
        }, timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}
export async function defaultLaunchFacts({ paths, assistantId, userId, backendUrl, fs = nodeFs, fetch: doFetch, log = () => { } }) {
    const apiBase = laneApiBase(backendUrl);
    const lane = { userId, assistantId: String(assistantId) };
    if (!apiBase)
        return { policy: { ...LOCKED_TOOL_POLICY }, read: false };
    const session = await ensureLaneSession({ lane, sessionPath: paths.sessionPath, ticketPath: paths.ticketPath, apiBase, fs, ...(doFetch ? { fetch: doFetch } : {}), log });
    if (!session)
        return { policy: { ...LOCKED_TOOL_POLICY }, read: false };
    const me = await fetchLaneMe({ session, lane, apiBase, ...(doFetch ? { fetch: doFetch } : {}), log });
    const policy = me ? laneMePolicy(me, lane) : null;
    return policy ? { policy, read: true } : { policy: { ...LOCKED_TOOL_POLICY }, read: false };
}
export function defaultReadClaudeJson({ home, ownerEnv, fs = nodeFs }) {
    const dir = typeof ownerEnv?.CLAUDE_CONFIG_DIR === 'string' && ownerEnv.CLAUDE_CONFIG_DIR !== '' ? ownerEnv.CLAUDE_CONFIG_DIR : home;
    try {
        return JSON.parse(String(fs.readFileSync(join(dir, '.claude.json'), 'utf8')));
    }
    catch {
        return null;
    }
}
function minimalEnv(ownerEnv) {
    const env = {};
    for (const name of LANE_ENV_KEEP) {
        if (typeof ownerEnv?.[name] === 'string' && ownerEnv[name] !== '')
            env[name] = ownerEnv[name];
    }
    return env;
}
export async function superviseLane(o) {
    const fs = o.fs ?? nodeFs;
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const platform = o.platform ?? process.platform;
    const selfPid = o.selfPid ?? process.pid;
    const isAlive = o.isAlive ?? ((pid) => isLiveSupervisor(pid));
    const log = o.log ?? (() => { });
    const watchMs = o.watchMs ?? LANE_WATCH_MS;
    const stopGraceMs = o.stopGraceMs ?? LANE_STOP_GRACE_MS;
    const spawnExpect = o.spawnExpect ?? defaultSpawnExpect;
    const runNotice = o.runNotice ?? defaultRunNotice;
    const availableBytes = o.availableBytes ?? (() => defaultAvailableBytes({ platform }));
    const paths = lanePaths({ home: o.home, assistantId: o.assistantId, userId: o.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform });
    const tokenStore = o.tokenStore ?? laneTokenStore({ platform, fs, fileStoreDir: () => paths.stateDir });
    fs.mkdirSync(paths.workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(paths.laneDir, 0o700);
    }
    catch { }
    const lock = acquireLaneLock(paths.launcherLockPath, { fs, selfPid, isAlive });
    if (!lock.acquired) {
        log(`lane already supervised by pid ${lock.holderPid}`);
        return { outcome: 'already_running' };
    }
    const event = (e) => {
        try {
            fs.appendFileSync(paths.eventsPath, laneEventLine(e, new Date(now()).toISOString()), { mode: 0o600 });
        }
        catch (err) {
            log(`could not record ${e.event}: ${String(err)}`);
        }
    };
    const noticeEnv = (notice) => ({
        ...minimalEnv(o.ownerEnv),
        ...laneDaemonEnv({
            assistantId: o.assistantId,
            userId: o.userId,
            workDir: paths.workDir,
            laneDir: paths.laneDir,
            stateDir: paths.stateDir,
            backendUrl: o.backendUrl,
            loginMode: LANE_LOGIN_OWN_TOKEN,
        }),
        HOAI_LANE_NOTICE: notice,
    });
    let registered = false;
    try {
        try {
            fs.unlinkSync(paths.stopRequestPath);
        }
        catch { }
        if (fs.existsSync(paths.revokedPath)) {
            log('lane revoked; not starting');
            return { outcome: 'stopped', reason: 'revoked' };
        }
        const mode = loginModeFor(paths.loginModesPath, o.userId, { fs });
        const resolved = resolveLaneLogin({ mode, assistantId: o.assistantId, userId: o.userId, configDir: paths.configDir, store: tokenStore });
        if (!resolved.ok) {
            log(`lane login: ${resolved.notice} (${resolved.reason}); Claude is not started and the owner's login is not used`);
            await runNotice({ nodePath: o.nodePath, pluginRoot: o.pluginRoot, env: noticeEnv(resolved.notice), cwd: paths.workDir });
            event({ event: 'lane_failed' });
            return { outcome: 'failed', reason: resolved.notice };
        }
        const login = resolved.login;
        const decision = updateRegistry(paths.machineRegistryPath, (registry) => {
            const lanes = registry.lanes.map((l) => {
                let state = { lastActivityAtMs: null, inFlight: false };
                try {
                    const lp = lanePaths({ home: o.home, assistantId: l.assistantId, userId: l.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform });
                    state = readLaneState(fs.readFileSync(lp.laneJsonPath, 'utf8'));
                }
                catch { }
                const started = Date.parse(String(l.startedAt ?? ''));
                return {
                    assistantId: l.assistantId,
                    userId: l.userId,
                    lastActivityAtMs: state.lastActivityAtMs ?? (Number.isFinite(started) ? started : 0),
                    inFlight: state.inFlight,
                };
            });
            const caps = decideLaneCaps({ lanes, assistantId: o.assistantId, userId: o.userId, machineCeiling: laneMachineCeiling(availableBytes()) });
            if (caps.action === 'busy' || caps.action === 'running')
                return { result: caps };
            if (caps.action === 'evict') {
                try {
                    const victim = lanePaths({ home: o.home, assistantId: caps.victim.assistantId, userId: caps.victim.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform });
                    writeJsonPrivate(fs, victim.stopRequestPath, { reason: 'evicted', at: new Date(now()).toISOString(), by: 'supervisor' });
                }
                catch (err) {
                    log(`could not ask the evicted lane to stop: ${String(err)}`);
                }
            }
            const entry = { assistantId: String(o.assistantId), userId: o.userId, supervisorPid: selfPid, startedAt: new Date(now()).toISOString() };
            return { registry: { v: 1, lanes: [...registry.lanes, entry] }, result: caps };
        }, { fs, isAlive });
        if (decision.action === 'busy') {
            log(`lane busy: the ${decision.cap} cap is full of busy lanes`);
            event({ event: 'lane_busy' });
            return { outcome: 'busy', reason: decision.cap };
        }
        if (decision.action === 'running') {
            log('lane already listed as running; leaving it');
            return { outcome: 'already_running' };
        }
        registered = true;
        if (decision.action === 'evict')
            log(`asked lane ${decision.victim.assistantId}/${decision.victim.userId} to stop for room`);
        const laneEnv = { ...laneChildEnv({
                ownerEnv: o.ownerEnv,
                platform,
                login,
                assistantId: o.assistantId,
                userId: o.userId,
                workDir: paths.workDir,
                laneDir: paths.laneDir,
                stateDir: paths.stateDir,
                backendUrl: o.backendUrl,
            }), HOAI_LANE_SHELL_PREFIX: join(o.pluginRoot, 'bin', 'hoai-lane-shell.sh') };
        if (login.mode === LANE_LOGIN_OWN_TOKEN) {
            const seedPath = join(paths.configDir, '.claude.json');
            writeJsonPrivate(fs, seedPath, laneConfigSeed({ workDir: paths.workDir, existing: readJson(fs, seedPath) }));
        }
        const writePin = (p, c) => { try {
            fs.writeFileSync(p, `${c}\n`, { mode: 0o600 });
            return true;
        }
        catch {
            return false;
        } };
        let pin = ensurePinnedSessionId({
            path: paths.sessionIdPath,
            readFile: (p) => { try {
                return fs.readFileSync(p, 'utf8');
            }
            catch {
                return '';
            } },
            writeFile: writePin,
            generateId: o.generateId ?? randomUUID,
        });
        if (!pin)
            throw new Error('could not write the lane\'s session pin');
        const configDirForTranscript = login.mode === LANE_LOGIN_OWN_TOKEN ? paths.configDir : (o.ownerEnv?.CLAUDE_CONFIG_DIR ?? '');
        let transcript = sessionTranscriptPath(o.home, paths.workDir, pin, configDirForTranscript);
        const launchFacts = o.launchFacts ?? (() => defaultLaunchFacts({ paths, assistantId: o.assistantId, userId: o.userId, backendUrl: o.backendUrl, fs, log }));
        const readClaudeJson = o.readClaudeJson ?? (() => defaultReadClaudeJson({ home: o.home, ownerEnv: o.ownerEnv, fs }));
        let relaunchesAtMs = [];
        for (;;) {
            const launch = await prepareLaneLaunch({ o, fs, paths, platform, login, launchFacts, readClaudeJson, log, now });
            const sessionArgs = laneSessionArgs(pin, fs.existsSync(transcript));
            const debugFile = login.mode === LANE_LOGIN_OWN_TOKEN ? paths.claudeDebugPath : undefined;
            if (debugFile) {
                try {
                    fs.writeFileSync(debugFile, '', { mode: 0o600 });
                }
                catch { }
            }
            const args = laneLaunchArgsFor({
                mcpConfigPath: paths.mcpPath,
                settingsPath: paths.settingsPath,
                sessionArgs,
                debugFile,
                tools: launch.tools,
                model: launch.model,
                effort: launch.effort,
                systemPromptFile: paths.systemPromptPath,
            });
            if (!laneArgsTclSafe(args)) {
                log('a lane argument holds a brace or a backslash; not launching');
                event({ event: 'lane_failed' });
                return { outcome: 'failed', reason: 'unsafe_args' };
            }
            const script = buildGateAutoAcceptExpect({
                claudePath: tclQuote(o.claudePath),
                args,
                ...(o.gateBlock !== undefined ? { gateBlock: o.gateBlock } : {}),
                supervised: { stateDir: paths.laneDir, interactive: false, compact: 'compact=off reason=lane', denyPermissionPrompts: true },
            });
            const startedAtMs = now();
            const child = spawnExpect(script, { cwd: paths.workDir, env: laneEnvForLaunch(laneEnv, launch.policy), logPath: paths.launcherLogPath, fs });
            log(`lane started (pid ${child.pid ?? '?'}, ${sessionArgs[0]} ${pin}, login ${login.mode}, tools ${launch.tools.join(',')}${launch.model ? `, model ${launch.model}` : ''}${launch.effort ? `, effort ${launch.effort}` : ''}, policy ${launch.policyRead ? 'read' : 'locked (unread)'})`);
            const result = await watchLane({
                child, paths, fs, now, sleep, startedAtMs, watchMs, stopGraceMs, log,
                laneDirsSnapshot: launch.shellLaneDirs,
                listLaneDirs: () => otherLaneDirsOf({ fs, home: o.home, ownLaneDir: paths.laneDir }),
            });
            if (result.kind === 'restart') {
                const request = result.request;
                if (request.fresh) {
                    const fresh = freshPinnedSessionId({ path: paths.sessionIdPath, writeFile: writePin, generateId: o.generateId ?? randomUUID });
                    if (!fresh) {
                        log('could not write a new session pin for /new; stopping rather than resuming the old conversation');
                        event({ event: 'lane_failed' });
                        return { outcome: 'failed', reason: 'repin_failed' };
                    }
                    pin = fresh;
                    transcript = sessionTranscriptPath(o.home, paths.workDir, pin, configDirForTranscript);
                }
                log(`lane restarting (${request.reasons.join(', ')}${request.fresh ? ', new session' : ''})`);
                continue;
            }
            if (result.kind === 'stop') {
                try {
                    fs.unlinkSync(paths.stopRequestPath);
                }
                catch { }
                if (result.reason === 'login_failed') {
                    event({ event: 'lane_failed' });
                    return { outcome: 'failed', reason: result.reason };
                }
                if (START_FAILURE_REASONS.has(result.reason) && recordStartFailure({ fs, paths, now })) {
                    event({ event: 'lane_failed' });
                    return { outcome: 'failed', reason: result.reason };
                }
                event({ event: 'lane_stopped' });
                return { outcome: 'stopped', reason: result.reason };
            }
            if (result.code === EXIT_SUPERVISED_SIGNED_OUT) {
                log('lane Claude came up signed out');
                if (login.mode === LANE_LOGIN_OWN_TOKEN) {
                    await runNotice({ nodePath: o.nodePath, pluginRoot: o.pluginRoot, env: noticeEnv('login_token_failed'), cwd: paths.workDir });
                }
                event({ event: 'lane_failed' });
                return { outcome: 'failed', reason: 'signed_out' };
            }
            const again = decideLaneRelaunch({ relaunchesAtMs, nowMs: now() });
            if (!again.relaunch) {
                log(`lane crashed ${relaunchesAtMs.length} times this hour; giving up`);
                event({ event: 'lane_failed' });
                return { outcome: 'failed', reason: 'crash_loop' };
            }
            relaunchesAtMs = again.recent;
            log(`lane Claude exited (code ${String(result.code)}); relaunching with the same pin`);
        }
    }
    finally {
        if (registered) {
            try {
                updateRegistry(paths.machineRegistryPath, (registry) => ({
                    registry: { v: 1, lanes: registry.lanes.filter((l) => !(String(l.assistantId) === String(o.assistantId) && l.userId === o.userId && l.supervisorPid === selfPid)) },
                    result: null,
                }), { fs, isAlive });
            }
            catch (err) {
                log(`could not leave the registry: ${String(err)}`);
            }
        }
        releaseLaneLock(paths.launcherLockPath, { fs, selfPid });
    }
}
export async function prepareLaneLaunch({ o, fs, paths, platform, login, launchFacts, readClaudeJson, log, now }) {
    let facts = { policy: { ...LOCKED_TOOL_POLICY }, read: false };
    try {
        facts = await launchFacts();
    }
    catch (err) {
        log(`the share's policy could not be read (${String(err?.message ?? err)}); launching the locked base`);
    }
    const requested = readToolPolicy(facts?.policy);
    const shellAvailable = o.shellSandboxAvailable ?? (() => laneShellSandboxAvailable({
        platform,
        exists: (p) => fs.existsSync(p),
        onPath: (name) => findOnPath(name, { pathVar: o.ownerEnv?.PATH ?? '', fs }) !== null,
    }));
    const shellRefused = requested.shell
        ? (login.mode !== LANE_LOGIN_OWN_TOKEN ? 'login_mode' : (!shellAvailable() ? 'no_sandbox' : null))
        : null;
    if (shellRefused === 'login_mode')
        log(LANE_SHELL_LOGIN_REQUIRED);
    if (shellRefused === 'no_sandbox')
        log('shell refused: this host has no Bash sandbox, so the lane gets no shell');
    const policy = shellRefused ? { ...requested, shell: false } : requested;
    let agentFolder = null;
    if (policy.readAgentFolder) {
        const verdict = agentFolderVerdict(o.agentFolder, {
            home: o.home,
            stateRoots: [join(o.home, '.bgos-agent'), join(o.home, '.bgos-plugin-state'), ...(o.ownerEnv?.BGOS_PLUGIN_STATE_DIR ? [o.ownerEnv.BGOS_PLUGIN_STATE_DIR] : [])],
            realpath: (p) => fs.realpathSync(p),
            platform,
        });
        if (verdict.ok)
            agentFolder = verdict.path;
        else
            log(`readAgentFolder refused (${verdict.reason}): the agent folder stays closed to this lane`);
    }
    let ownerServers = {};
    if (policy.ownerMcpServers) {
        const found = ownerMcpServersFrom(readClaudeJson(), { agentFolder: typeof o.agentFolder === 'string' ? o.agentFolder : null });
        ownerServers = found.servers;
        if (found.skipped.length > 0)
            log(`owner MCP servers not loaded in a lane: ${found.skipped.join(', ')}`);
    }
    const ownerServerNames = Object.keys(ownerServers);
    let shellDenies = [];
    let shellLaneDirs = null;
    if (policy.shell) {
        let knownAgentFolder = agentFolder;
        if (!knownAgentFolder && typeof o.agentFolder === 'string' && o.agentFolder !== '') {
            try {
                knownAgentFolder = fs.realpathSync(o.agentFolder);
            }
            catch { }
        }
        shellLaneDirs = otherLaneDirsOf({ fs, home: o.home, ownLaneDir: paths.laneDir });
        shellDenies = laneShellReadDenies({ home: o.home, laneDir: paths.laneDir, otherLaneDirs: shellLaneDirs, agentFolder: knownAgentFolder, platform });
    }
    if (policy.shell)
        fs.mkdirSync(join(paths.workDir, '.tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.memoryDir, { recursive: true, mode: 0o700 });
    writeJsonPrivate(fs, paths.settingsPath, laneSettingsBody({
        workDir: paths.workDir,
        userId: o.userId,
        nodePath: o.nodePath,
        floorHookPath: join(o.pluginRoot, 'bin', 'hoai-lane-floor-hook.mjs'),
        platform,
        allowExtra: laneAllowAdditions(policy, { agentFolder, ownerServerNames, platform }),
        denyExtra: [...laneDenyAdditions(policy, { agentFolder, platform }), ...shellDenies],
        additionalDirectories: agentFolder ? [agentFolder] : [],
        sandbox: policy.shell ? laneShellSandbox({ home: o.home, workDir: paths.workDir, agentFolder, platform, shellPrefix: join(o.pluginRoot, 'bin', 'hoai-lane-shell.sh') }) : null,
    }));
    const allowed = (() => { try {
        return readLaneAllowedChoices(fs.readFileSync(paths.allowedChoicesPath, 'utf8'));
    }
    catch {
        return { models: [], efforts: [] };
    } })();
    const choices = (() => { try {
        return readLaneChoices(fs.readFileSync(paths.choicesPath, 'utf8'));
    }
    catch {
        return readLaneChoices('');
    } })();
    const effective = effectiveLaneChoices(choices, allowed);
    writeJsonPrivate(fs, paths.mcpPath, laneMcpConfigBody({
        nodePath: o.nodePath,
        pluginRoot: o.pluginRoot,
        platform,
        extraServers: ownerServers,
        env: {
            ...laneDaemonEnv({
                assistantId: o.assistantId,
                userId: o.userId,
                workDir: paths.workDir,
                laneDir: paths.laneDir,
                stateDir: paths.stateDir,
                backendUrl: o.backendUrl,
                loginMode: login.mode,
                configDir: login.mode === LANE_LOGIN_OWN_TOKEN ? paths.configDir : o.ownerEnv?.CLAUDE_CONFIG_DIR,
            }),
            ...laneLaunchEnv({ policy: requested, model: effective.model, effort: effective.effort }),
        },
    }));
    let indexText = null;
    try {
        indexText = String(fs.readFileSync(join(paths.memoryDir, 'MEMORY.md'), 'utf8'));
    }
    catch { }
    const promptTmp = `${paths.systemPromptPath}.${process.pid}.tmp`;
    fs.writeFileSync(promptTmp, laneSystemPromptBody({ workDir: paths.workDir, memoryDir: paths.memoryDir, indexText, policy, agentFolder, ownerServerNames }), { mode: 0o600 });
    fs.renameSync(promptTmp, paths.systemPromptPath);
    if (choices.model && !effective.model)
        log(`the person's model ${choices.model} is no longer on the owner's list; the agent's own model is used`);
    if (choices.effort && !effective.effort)
        log(`the person's effort ${choices.effort} is no longer on the owner's list; the agent's own effort is used`);
    const tools = laneToolsFor(policy, LANE_BUILTIN_TOOLS);
    writeJsonPrivate(fs, paths.launchPolicyPath, {
        v: 1,
        policy,
        ...(shellRefused ? { shellRefused } : {}),
        policyRead: facts?.read === true,
        tools,
        agentFolder,
        ownerServers: ownerServerNames,
        model: effective.model,
        effort: effective.effort,
        at: new Date(now()).toISOString(),
    });
    return { policy, policyRead: facts?.read === true, tools, model: effective.model, effort: effective.effort, shellLaneDirs };
}
export function otherLaneDirsOf({ fs, home, ownLaneDir }) {
    const out = [];
    const root = join(home, '.bgos-agent');
    let agents = [];
    try {
        agents = fs.readdirSync(root);
    }
    catch {
        return out;
    }
    for (const agent of agents) {
        if (!/^[1-9][0-9]{0,15}$/.test(agent))
            continue;
        let people = [];
        try {
            people = fs.readdirSync(join(root, agent, 'people'));
        }
        catch {
            continue;
        }
        for (const person of people) {
            const dir = join(root, agent, 'people', person);
            if (dir === ownLaneDir || !/^[A-Za-z0-9_-]{1,128}$/.test(person))
                continue;
            try {
                if (fs.statSync(dir).isDirectory())
                    out.push(dir);
            }
            catch { }
        }
    }
    return out;
}
function recordStartFailure({ fs, paths, now }) {
    const path = join(paths.laneDir, 'start-failures.json');
    const nowMs = now();
    const prior = Array.isArray(readJson(fs, path)) ? readJson(fs, path) : [];
    const recent = [...prior.filter((t) => Number.isFinite(t) && nowMs - t < LANE_START_FAILURES_WINDOW_MS), nowMs];
    try {
        writeJsonPrivate(fs, path, recent);
    }
    catch { }
    return recent.length >= LANE_START_FAILURES_MAX;
}
function takeRestartRequest(fs, path) {
    const taken = `${path}.taken-${process.pid}`;
    try {
        fs.renameSync(path, taken);
    }
    catch {
        return null;
    }
    let request = null;
    try {
        request = readLaneRestartRequest(fs.readFileSync(taken, 'utf8'));
    }
    catch { }
    try {
        fs.unlinkSync(taken);
    }
    catch { }
    return request;
}
export function watchLane({ child, paths, fs, now, sleep, startedAtMs, watchMs, stopGraceMs, log, laneDirsSnapshot = null, listLaneDirs = () => [] }) {
    return new Promise((resolve) => {
        let stopping = null;
        let exited = false;
        let exitCode = null;
        child.on('exit', (code) => {
            exited = true;
            exitCode = code;
            if (stopping === null)
                resolve({ kind: 'exit', code });
        });
        child.on('error', (err) => {
            log(`lane spawn error: ${String(err?.message ?? err)}`);
            exited = true;
            if (stopping === null)
                resolve({ kind: 'exit', code: null });
        });
        const stop = async (reason, restart = null) => {
            if (stopping !== null || exited)
                return;
            stopping = reason;
            log(`stopping the lane: ${reason}`);
            try {
                child.kill('SIGTERM');
            }
            catch { }
            const deadline = now() + stopGraceMs;
            while (!exited && now() < deadline)
                await sleep(Math.min(250, watchMs));
            if (!exited) {
                try {
                    child.kill('SIGKILL');
                }
                catch { }
            }
            resolve(restart ? { kind: 'restart', request: restart, code: exitCode } : { kind: 'stop', reason, code: exitCode });
        };
        const look = async () => {
            while (!exited && stopping === null) {
                await sleep(watchMs);
                if (exited || stopping !== null)
                    return;
                const asked = readJson(fs, paths.stopRequestPath);
                if (asked) {
                    await stop(typeof asked.reason === 'string' ? asked.reason : 'requested');
                    return;
                }
                let state = { lastActivityAtMs: null, inFlight: false, inFlightSinceMs: null };
                try {
                    state = readLaneState(fs.readFileSync(paths.laneJsonPath, 'utf8'));
                }
                catch { }
                const pending = readJson(fs, paths.restartRequestPath);
                if (pending) {
                    const request = readLaneRestartRequest(JSON.stringify(pending));
                    if (!request) {
                        try {
                            fs.unlinkSync(paths.restartRequestPath);
                        }
                        catch { }
                    }
                    else if (decideLaneRestart({ request, inFlight: state.inFlight, lastActivityAtMs: state.lastActivityAtMs, startedAtMs, nowMs: now() }) === 'now') {
                        const taken = takeRestartRequest(fs, paths.restartRequestPath);
                        if (taken) {
                            await stop(`restart (${taken.reasons.join(', ')})`, taken);
                            return;
                        }
                    }
                }
                if (Array.isArray(laneDirsSnapshot)) {
                    let fresh = [];
                    try {
                        fresh = listLaneDirs().filter((dir) => !laneDirsSnapshot.includes(dir));
                    }
                    catch { }
                    if (fresh.length > 0) {
                        await stop('restart (a new lane appeared on this machine)', { reasons: ['lane_list_changed'], when: 'now', fresh: false, chatId: null });
                        return;
                    }
                }
                const idle = decideLaneIdle({ ...state, startedAtMs, nowMs: now() });
                if (idle.stop) {
                    try {
                        writeJsonPrivate(fs, paths.stopRequestPath, { reason: idle.reason, at: new Date(now()).toISOString(), by: 'supervisor' });
                    }
                    catch { }
                    await stop(idle.reason);
                    return;
                }
            }
        };
        void look();
    });
}
