// Frozen from 522fb683f2c696a05138f7f71b4b13350ffdf3a7:lib/lane-core.mjs.
// Only comments, formatting and imports of unchanged dependencies were adjusted.
// Keep these functions independent of the current launch and comparison code.
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { posix as posixPath, win32 as win32Path } from 'node:path';
export const PERSON_LANES_TOKEN = 'person_lanes';
export const LANE_MEMORY_RPC_TOKEN = 'lane_memory_rpc';
export const OWNER_LANE_STAMP = 'owner';
const PERSON_PREFIX = 'person:';
export function personLaneStamp(userId) {
    return `${PERSON_PREFIX}${userId}`;
}
export const LANE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isSafeLaneUserId(value) {
    return typeof value === 'string' && LANE_USER_ID_RE.test(value);
}
export function isSafeAssistantId(value) {
    const text = String(value ?? '');
    return /^[1-9][0-9]{0,15}$/.test(text);
}
export function laneUserHash(userId) {
    return createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
}
export function readLaneStamp(delivery) {
    if (!delivery || typeof delivery !== 'object')
        return null;
    const raw = delivery.lane;
    if (raw === undefined || raw === null)
        return null;
    return typeof raw === 'string' ? raw : `unreadable:${typeof raw}`;
}
export function ownerLaneVerdict(delivery) {
    const stamp = readLaneStamp(delivery);
    if (stamp === null || stamp === OWNER_LANE_STAMP)
        return { deliver: true };
    return { deliver: false, stamp };
}
export function ownerAnnounceRefused({ lanesOn, chatIsOthers }) {
    return lanesOn === true && chatIsOthers === true;
}
export function personLaneVerdict(delivery, lane) {
    const stamp = readLaneStamp(delivery);
    if (!isSafeLaneUserId(lane?.userId))
        return { deliver: false, reason: 'lane_unknown', stamp };
    if (stamp !== personLaneStamp(lane.userId))
        return { deliver: false, reason: 'stamp', stamp };
    const target = delivery?.assistantId ?? delivery?.assistant_id;
    if (target !== undefined && target !== null && String(target) !== String(lane.assistantId)) {
        return { deliver: false, reason: 'assistant', stamp };
    }
    return { deliver: true };
}
function flavor(platform) {
    return platform === 'win32' ? win32Path : posixPath;
}
export function lanePaths({ home, assistantId, userId, stateRoot, platform = process.platform }) {
    if (!isSafeAssistantId(assistantId))
        throw new Error(`lane: unsafe assistant id ${JSON.stringify(assistantId)}`);
    if (!isSafeLaneUserId(userId))
        throw new Error('lane: unsafe person id');
    const p = flavor(platform);
    const id = String(assistantId);
    const agentDir = p.join(home, '.bgos-agent', id);
    const peopleDir = p.join(agentDir, 'people');
    const laneDir = p.join(peopleDir, userId);
    const workDir = p.join(laneDir, 'work');
    const pluginState = stateRoot && String(stateRoot).trim() !== '' ? String(stateRoot) : p.join(home, '.bgos-plugin-state');
    const stateDir = p.join(pluginState, id, 'lanes', userId);
    return {
        agentDir,
        peopleDir,
        laneDir,
        workDir,
        sessionIdPath: p.join(laneDir, 'session-id'),
        laneJsonPath: p.join(laneDir, 'lane.json'),
        settingsPath: p.join(laneDir, 'settings.json'),
        mcpPath: p.join(laneDir, 'mcp.json'),
        configDir: p.join(laneDir, 'claude-config'),
        wakePath: p.join(laneDir, 'wake.json'),
        stopRequestPath: p.join(laneDir, 'stop-request.json'),
        revokedPath: p.join(laneDir, 'revoked.json'),
        claudeDebugPath: p.join(laneDir, 'claude-debug.log'),
        eventsPath: p.join(laneDir, 'events.jsonl'),
        launcherLockPath: p.join(laneDir, 'launcher.lock'),
        launcherLogPath: p.join(laneDir, 'launcher.log'),
        choicesPath: p.join(laneDir, 'choices.json'),
        restartRequestPath: p.join(laneDir, 'restart-request.json'),
        launchPolicyPath: p.join(laneDir, 'launch-policy.json'),
        systemPromptPath: p.join(laneDir, 'system-prompt.md'),
        memoryDir: p.join(workDir, 'memory'),
        memoryRpcDir: p.join(laneDir, 'memory-rpc'),
        stateDir,
        ticketPath: p.join(stateDir, 'ticket.json'),
        sessionPath: p.join(stateDir, 'session.json'),
        cursorPath: p.join(stateDir, 'cursor.json'),
        memoryTrashDir: p.join(stateDir, 'memory-trash'),
        daemonLockPath: p.join(stateDir, 'daemon.lock'),
        registryPath: p.join(peopleDir, 'registry.json'),
        loginModesPath: p.join(peopleDir, 'login-modes.json'),
        allowedChoicesPath: p.join(peopleDir, 'lane-models.json'),
        machineRegistryPath: p.join(home, '.bgos-agent', 'lanes-machine.json'),
    };
}
export function peopleDirOf({ home, assistantId, platform = process.platform }) {
    if (!isSafeAssistantId(assistantId))
        throw new Error('lane: unsafe assistant id');
    return flavor(platform).join(home, '.bgos-agent', String(assistantId), 'people');
}
export const LANE_BUILTIN_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
export const LANE_POLICY_TOOLS = Object.freeze(['WebFetch', 'WebSearch', 'Bash']);
export const LANE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?:\[1m\])?$/;
export const LANE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const LANE_BGOS_TOOLS = Object.freeze(['reply']);
export const LANE_MCP_SERVER_NAME = 'bgos';
export const LANE_CHANNEL_SPEC = `server:${LANE_MCP_SERVER_NAME}`;
export const LANE_PERMISSION_MODE = 'dontAsk';
export const LANE_FORBIDDEN_FLAGS = Object.freeze([
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--add-dir',
    '--continue',
]);
export function laneLaunchArgsFor({ mcpConfigPath, settingsPath, sessionArgs = [], debugFile, tools = LANE_BUILTIN_TOOLS, model = null, effort = null, systemPromptFile }) {
    if (!mcpConfigPath || !settingsPath)
        throw new Error('lane: launch needs its mcp config and settings files');
    const session = [...sessionArgs];
    if (session.some((arg) => LANE_FORBIDDEN_FLAGS.includes(String(arg)))) {
        throw new Error('lane: a forbidden flag reached the session args');
    }
    const toolList = [...tools];
    for (const base of LANE_BUILTIN_TOOLS) {
        if (!toolList.includes(base))
            throw new Error(`lane: the tool list lost ${base}`);
    }
    for (const tool of toolList) {
        if (!LANE_BUILTIN_TOOLS.includes(tool) && !LANE_POLICY_TOOLS.includes(tool))
            throw new Error(`lane: ${tool} is not a lane tool`);
    }
    if (model !== null && (typeof model !== 'string' || !LANE_MODEL_RE.test(model)))
        throw new Error('lane: unsafe model name');
    if (effort !== null && !LANE_EFFORT_LEVELS.includes(effort))
        throw new Error('lane: unknown effort level');
    return [
        '--restricted',
        '--strict-mcp-config',
        '--mcp-config', mcpConfigPath,
        '--settings', settingsPath,
        '--permission-mode', LANE_PERMISSION_MODE,
        '--tools', [...new Set(toolList)].join(','),
        '--dangerously-load-development-channels', LANE_CHANNEL_SPEC,
        ...(systemPromptFile ? ['--append-system-prompt-file', systemPromptFile] : []),
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        ...(debugFile ? ['--debug-file', debugFile] : []),
        ...session,
    ];
}
export function laneSessionArgs(sessionId, transcriptExists) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId ?? ''))) {
        throw new Error('lane: the session pin is not a session id');
    }
    return transcriptExists ? ['--resume', sessionId] : ['--session-id', sessionId];
}
export function permissionRulePath(absPath, platform = process.platform) {
    if (platform === 'win32') {
        return `/${String(absPath).replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')}`;
    }
    return `/${absPath}`;
}
export function laneAllowList(workDir, platform = process.platform) {
    const rule = permissionRulePath(workDir, platform);
    return [
        ...LANE_BGOS_TOOLS.map((tool) => `mcp__${LANE_MCP_SERVER_NAME}__${tool}`),
        `Read(${rule}/**)`,
        `Edit(${rule}/**)`,
    ];
}
function quoteArg(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}
export const LANE_PERMISSION_REQUEST_COMMAND = `cat >/dev/null; printf %s ${quoteArg(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Not available in a shared lane.' },
    },
}))}`;
export function laneSettingsBody({ workDir, userId, nodePath, floorHookPath, platform = process.platform, allowExtra = [], denyExtra = [], additionalDirectories = [], sandbox = null }) {
    if (!isSafeLaneUserId(userId))
        throw new Error('lane: unsafe person id');
    return {
        permissions: {
            allow: [...laneAllowList(workDir, platform), ...allowExtra],
            deny: ['AskUserQuestion', ...denyExtra],
            ...(additionalDirectories.length > 0 ? { additionalDirectories: [...additionalDirectories] } : {}),
        },
        ...(sandbox ? { sandbox: { ...sandbox } } : {}),
        remoteControlAtStartup: false,
        autoMemoryEnabled: false,
        hooks: {
            PreToolUse: [
                {
                    matcher: '*',
                    hooks: [
                        {
                            type: 'command',
                            command: `${quoteArg(nodePath)} ${quoteArg(floorHookPath)} --lane ${userId}`,
                            timeout: 5,
                        },
                    ],
                },
            ],
            ...(sandbox ? { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: LANE_PERMISSION_REQUEST_COMMAND, timeout: 5 }] }] } : {}),
        },
    };
}
export function laneMcpConfigBody({ nodePath, pluginRoot, env, platform = process.platform, extraServers = {} }) {
    const p = flavor(platform);
    const extras = {};
    for (const [name, def] of Object.entries(extraServers ?? {})) {
        if (name === LANE_MCP_SERVER_NAME || /hoai-browser/i.test(name))
            continue;
        extras[name] = def;
    }
    return {
        mcpServers: {
            ...extras,
            [LANE_MCP_SERVER_NAME]: {
                command: nodePath,
                args: [p.join(pluginRoot, 'bin', 'bgos-launch.mjs'), p.join(pluginRoot, 'lane-server.ts')],
                env: { ...env },
            },
        },
    };
}
export const LANE_ENV_KEEP = Object.freeze([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ',
    'TMPDIR', 'TEMP', 'TMP',
    'BUN_INSTALL',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'BGOS_PLUGIN_STATE_DIR',
]);
export const LANE_ENV_KEEP_WIN32 = Object.freeze([
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
    'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramData',
]);
export const LANE_LOGIN_ENV = Object.freeze([
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
]);
export const LANE_CLAUDE_FIXED_ENV = Object.freeze({ ENABLE_TOOL_SEARCH: 'false' });
export const LANE_SHELL_FIXED_ENV = Object.freeze({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
export function laneEnvForLaunch(laneEnv, policy) {
    if (policy?.shell !== true)
        return { ...laneEnv };
    if (laneEnv.HOAI_LANE_LOGIN_MODE !== LANE_LOGIN_OWN_TOKEN)
        throw new Error(LANE_SHELL_LOGIN_REQUIRED);
    const tempDir = flavor(process.platform).join(laneEnv.BGOS_LAUNCH_CWD, '.tmp');
    return {
        ...laneEnv,
        ...LANE_SHELL_FIXED_ENV,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
        CLAUDE_CODE_TMPDIR: '.tmp',
        SHELL: '/bin/bash',
        CLAUDE_CODE_SHELL_PREFIX: laneEnv.HOAI_LANE_SHELL_PREFIX || fileURLToPath(new URL('../bin/hoai-lane-shell.sh', import.meta.url)),
    };
}
export const LANE_SHELL_LOGIN_REQUIRED = 'Shell requires this lane to use own_token.';
export const LANE_LOGIN_INHERIT = 'inherit';
export const LANE_LOGIN_OWN_TOKEN = 'own_token';
export const LANE_LOGIN_MODES = Object.freeze([LANE_LOGIN_INHERIT, LANE_LOGIN_OWN_TOKEN]);
export function laneChildEnv({ ownerEnv, platform = process.platform, login, assistantId, userId, workDir, laneDir, stateDir, backendUrl }) {
    if (!isSafeLaneUserId(userId))
        throw new Error('lane: unsafe person id');
    if (!isSafeAssistantId(assistantId))
        throw new Error('lane: unsafe assistant id');
    const env = {};
    const source = ownerEnv ?? {};
    const keep = platform === 'win32' ? [...LANE_ENV_KEEP, ...LANE_ENV_KEEP_WIN32] : LANE_ENV_KEEP;
    for (const name of keep) {
        const value = source[name];
        if (typeof value === 'string' && value !== '')
            env[name] = value;
    }
    for (const [name, value] of Object.entries(source)) {
        if (/^LC_[A-Z_]+$/.test(name) && typeof value === 'string' && value !== '')
            env[name] = value;
    }
    if (login?.mode === LANE_LOGIN_INHERIT) {
        for (const name of LANE_LOGIN_ENV) {
            const value = source[name];
            if (typeof value === 'string')
                env[name] = value;
        }
    }
    else if (login?.mode === LANE_LOGIN_OWN_TOKEN) {
        if (typeof login.token !== 'string' || login.token.trim() === '')
            throw new Error('lane: own token login without a token');
        if (typeof login.configDir !== 'string' || login.configDir === '')
            throw new Error('lane: own token login without its config folder');
        env.CLAUDE_CONFIG_DIR = login.configDir;
        env.CLAUDE_CODE_OAUTH_TOKEN = login.token;
    }
    else {
        throw new Error('lane: unknown login mode');
    }
    Object.assign(env, LANE_CLAUDE_FIXED_ENV);
    Object.assign(env, laneDaemonEnv({ assistantId, userId, workDir, laneDir, stateDir, backendUrl, loginMode: login.mode, configDir: env.CLAUDE_CONFIG_DIR }));
    return env;
}
export function laneLaunchEnv({ policy, model = null, effort = null }) {
    return {
        HOAI_LANE_LAUNCH_POLICY: JSON.stringify(policy ?? null),
        ...(model ? { HOAI_LANE_LAUNCH_MODEL: String(model) } : {}),
        ...(effort ? { HOAI_LANE_LAUNCH_EFFORT: String(effort) } : {}),
    };
}
export function laneDaemonEnv({ assistantId, userId, workDir, laneDir, stateDir, backendUrl, loginMode, configDir = '' }) {
    return {
        BGOS_LANE_USER_ID: String(userId),
        BGOS_ASSISTANT_ID: String(assistantId),
        BGOS_LAUNCH_CWD: String(workDir),
        BGOS_LANE_DIR: String(laneDir),
        BGOS_LANE_STATE_DIR: String(stateDir),
        BGOS_BACKEND_URL: String(backendUrl ?? ''),
        BGOS_AUTO_APPROVE: 'false',
        HOAI_LANE_LOGIN_MODE: String(loginMode),
        ...(configDir ? { HOAI_LANE_CLAUDE_CONFIG_DIR: String(configDir) } : {}),
    };
}
export function laneClaudeHome(env, home) {
    return env.HOAI_LANE_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || flavor(process.platform).join(home, '.claude');
}
export function isInsideFolder(candidate, root, platform = process.platform) {
    const p = flavor(platform);
    const fold = (s) => (platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s);
    const rel = p.relative(fold(root), fold(candidate));
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}
export function confineLanePath(input, { workDir, realpath, platform = process.platform }) {
    if (typeof input !== 'string' || input.trim() === '')
        return { ok: false, reason: 'empty' };
    if (input.includes('\0'))
        return { ok: false, reason: 'nul' };
    const p = flavor(platform);
    let root;
    try {
        root = realpath(workDir);
    }
    catch {
        return { ok: false, reason: 'no_work_folder' };
    }
    const absolute = p.isAbsolute(input) ? input : p.join(root, input);
    let resolved;
    try {
        resolved = realpath(absolute);
    }
    catch {
        return { ok: false, reason: 'missing' };
    }
    if (!isInsideFolder(resolved, root, platform))
        return { ok: false, reason: 'outside' };
    return { ok: true, path: resolved };
}
export const LANE_IDLE_MS = 20 * 60_000;
export const LANE_TURN_STUCK_MS = 2 * 60 * 60_000;
export const LANE_MAX_RELAUNCHES = 3;
export const LANE_RELAUNCH_WINDOW_MS = 60 * 60_000;
export const LANE_PER_AGENT_CAP = 2;
export const LANE_BUDGET_BYTES = 1024 ** 3;
export const LANE_RESERVE_BYTES = 4 * 1024 ** 3;
export function decideLaneIdle({ lastActivityAtMs, inFlight, inFlightSinceMs = null, startedAtMs, nowMs, idleMs = LANE_IDLE_MS, stuckMs = LANE_TURN_STUCK_MS }) {
    if (inFlight) {
        const since = Number.isFinite(inFlightSinceMs) ? inFlightSinceMs : lastActivityAtMs;
        if (Number.isFinite(since) && nowMs - since >= stuckMs)
            return { stop: true, reason: 'stuck' };
        return { stop: false };
    }
    const last = Number.isFinite(lastActivityAtMs) ? Math.max(lastActivityAtMs, startedAtMs) : startedAtMs;
    return nowMs - last >= idleMs ? { stop: true, reason: 'idle' } : { stop: false };
}
export function decideLaneRelaunch({ relaunchesAtMs, nowMs, max = LANE_MAX_RELAUNCHES, windowMs = LANE_RELAUNCH_WINDOW_MS }) {
    const recent = (relaunchesAtMs ?? []).filter((t) => Number.isFinite(t) && nowMs - t < windowMs);
    return recent.length < max ? { relaunch: true, recent: [...recent, nowMs] } : { relaunch: false, recent };
}
export function laneMachineCeiling(availableBytes) {
    if (!Number.isFinite(availableBytes) || availableBytes <= 0)
        return 1;
    return Math.max(1, Math.floor((availableBytes - LANE_RESERVE_BYTES) / LANE_BUDGET_BYTES));
}
export function decideLaneCaps({ lanes, assistantId, userId, perAgentCap = LANE_PER_AGENT_CAP, machineCeiling }) {
    const all = lanes ?? [];
    if (all.some((l) => String(l.assistantId) === String(assistantId) && l.userId === userId))
        return { action: 'running' };
    const mine = all.filter((l) => String(l.assistantId) === String(assistantId));
    const lru = (list) => list
        .filter((l) => !l.inFlight)
        .sort((a, b) => (a.lastActivityAtMs ?? 0) - (b.lastActivityAtMs ?? 0))[0];
    if (mine.length >= perAgentCap) {
        const victim = lru(mine);
        return victim ? { action: 'evict', victim: { assistantId: String(victim.assistantId), userId: victim.userId } } : { action: 'busy', cap: 'agent' };
    }
    if (all.length >= Math.max(1, machineCeiling)) {
        const victim = lru(all);
        return victim ? { action: 'evict', victim: { assistantId: String(victim.assistantId), userId: victim.userId } } : { action: 'busy', cap: 'machine' };
    }
    return { action: 'start' };
}
export function availableBytesFromVmStat(text) {
    const raw = String(text ?? '');
    const page = Number(/page size of (\d+) bytes/.exec(raw)?.[1] ?? 0);
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(raw)?.[1] ?? 0);
    if (!page)
        return 0;
    return (pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable')) * page;
}
export function availableBytesFromMeminfo(text) {
    const kb = Number(/MemAvailable:\s+(\d+)\s+kB/.exec(String(text ?? ''))?.[1] ?? 0);
    return kb * 1024;
}
export const LANE_HELP_FLAGS = Object.freeze([
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config',
    '--settings',
    '--permission-mode',
    '--tools',
    '--session-id',
    '--resume',
    '--debug-file',
    '--model',
    '--effort',
]);
export const LANE_HIDDEN_VALUE_FLAGS = Object.freeze(['--dangerously-load-development-channels', '--append-system-prompt-file']);
export const LANE_MODE_PROBE_VALUE = 'hoai-lane-probe';
function outputText(out) {
    return `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`;
}
export function classifyLaneCliProbe({ help, mode, hidden }) {
    const missing = [];
    const helpText = outputText(help);
    for (const flag of LANE_HELP_FLAGS) {
        const re = new RegExp(`^\\s+(?:-[A-Za-z], )?${flag.replace(/[-]/g, '\\-')}(?=[\\s,<=[]|$)`, 'm');
        if (!re.test(helpText))
            missing.push(flag);
    }
    const modeText = outputText(mode);
    const choices = /Allowed choices are ([^\n]+)/i.exec(modeText)?.[1] ?? '';
    if (!choices.split(/[\s,.]+/).includes(LANE_PERMISSION_MODE))
        missing.push(`--permission-mode ${LANE_PERMISSION_MODE}`);
    for (const flag of LANE_HIDDEN_VALUE_FLAGS) {
        const text = outputText(hidden?.[flag]).toLowerCase();
        const known = /argument missing|missing required argument|requires an argument|expected an argument/.test(text) && !/unknown option/.test(text);
        if (!known)
            missing.push(flag);
    }
    return { ok: missing.length === 0, missing };
}
export const LANE_REPORT_EVENTS = Object.freeze(['lane_busy', 'lane_stopped', 'lane_failed']);
export const LANE_NOTICES = Object.freeze({
    login_token_missing: "I can't answer you yet. My owner set our conversations to use your own Claude sign in, and it is not set up on this computer. Your message is saved; once my owner adds it, send your message again.",
    login_token_failed: "I can't answer you right now. The Claude sign in set up for our conversations was refused (it may have expired). Your message is saved; once my owner renews it, send your message again.",
    new_session: 'I started a new conversation with you. What I saved in my memory about our conversations stays.',
    model_changed: 'I switched my model as you asked. It applies from your next message.',
    effort_changed: 'I switched my effort level as you asked. It applies from your next message.',
    choice_refused: 'That is not on the list my owner allows for our conversations, so I kept my current setting.',
    policy_tightened: 'My owner changed what I may do on their computer, so I stopped what I was doing. Please send your message again.',
    login_lane_own_token: "I can't run /login here. Our conversations use your own Claude sign in, which my owner set up on their computer, and /login cannot change it. It never signs in my owner's login for you either, so nothing was changed. If your sign in stopped working, ask my owner to set up a new one with you.",
    login_lane_shared: "I can't run /login here. Our conversations use my owner's Claude sign in, the same one my owner's own chats use, and a sign in cannot be finished from our conversation, so nothing was changed. If I have stopped answering, tell my owner: they can send /login in their own chat with me.",
    login_lane_shared_granted: "My owner allowed you to sign me back in, but /login can't run from our conversation yet: a sign in link and its code can't pass through it, so nothing was changed. Our conversations use my owner's Claude sign in, the same one my owner's own chats use. If I have stopped answering, tell my owner: they can send /login in their own chat with me.",
});
export function laneNoticeSentence(notice) {
    return Object.prototype.hasOwnProperty.call(LANE_NOTICES, notice) ? LANE_NOTICES[notice] : null;
}
export function parseLaneEventLine(line) {
    let raw;
    try {
        raw = JSON.parse(String(line));
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    if (LANE_REPORT_EVENTS.includes(raw.event)) {
        return { event: raw.event, ...(typeof raw.at === 'string' ? { at: raw.at } : {}) };
    }
    if (raw.event === 'notice' && Object.prototype.hasOwnProperty.call(LANE_NOTICES, raw.notice)) {
        const chatIds = Array.isArray(raw.chatIds)
            ? [...new Set(raw.chatIds.map((c) => Number(c)).filter((c) => Number.isSafeInteger(c) && c > 0))].slice(0, 5)
            : [];
        return { event: 'notice', notice: raw.notice, chatIds, ...(typeof raw.at === 'string' ? { at: raw.at } : {}) };
    }
    return null;
}
export function laneEventLine(event, nowIso = new Date().toISOString()) {
    return `${JSON.stringify({ ...event, at: nowIso })}\n`;
}
export function laneStateBody({ userId, assistantId, lastActivityAtMs, inFlight, inFlightSinceMs = null, loginMode, pid }) {
    return {
        v: 1,
        actorUserId: String(userId),
        assistantId: String(assistantId),
        lastActivityAt: Number.isFinite(lastActivityAtMs) ? new Date(lastActivityAtMs).toISOString() : null,
        inFlight: inFlight === true,
        inFlightSince: Number.isFinite(inFlightSinceMs) ? new Date(inFlightSinceMs).toISOString() : null,
        loginMode: String(loginMode ?? ''),
        pid: Number.isFinite(pid) ? pid : null,
    };
}
export function readLaneState(text) {
    try {
        const raw = JSON.parse(String(text));
        const ms = (v) => {
            const t = typeof v === 'string' ? Date.parse(v) : NaN;
            return Number.isFinite(t) ? t : null;
        };
        return {
            lastActivityAtMs: ms(raw?.lastActivityAt),
            inFlight: raw?.inFlight === true,
            inFlightSinceMs: ms(raw?.inFlightSince),
        };
    }
    catch {
        return { lastActivityAtMs: null, inFlight: false, inFlightSinceMs: null };
    }
}
