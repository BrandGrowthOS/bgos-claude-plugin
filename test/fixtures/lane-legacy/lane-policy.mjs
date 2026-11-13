// Frozen from 522fb683f2c696a05138f7f71b4b13350ffdf3a7:lib/lane-policy.mjs.
// Only comments, formatting and imports of unchanged dependencies were adjusted.
// Keep these functions independent of the current launch and comparison code.
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { isInsideFolder, LANE_EFFORT_LEVELS, LANE_MODEL_RE, permissionRulePath, personLaneStamp } from './lane-core.mjs';
export const TOOL_POLICY_VERSION = 1;
export const LAUNCH_POLICY_OPTIONS = Object.freeze(['webFetch', 'readAgentFolder', 'shell', 'ownerMcpServers']);
export const TOOL_POLICY_OPTIONS = Object.freeze([...LAUNCH_POLICY_OPTIONS, 'browser']);
export const LOCKED_TOOL_POLICY = Object.freeze({
    v: 1,
    webFetch: false,
    readAgentFolder: false,
    browser: false,
    shell: false,
    ownerMcpServers: false,
});
export function readToolPolicy(raw) {
    const r = (raw);
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== TOOL_POLICY_VERSION)
        return { ...LOCKED_TOOL_POLICY };
    const out = ({ v: 1 });
    for (const option of TOOL_POLICY_OPTIONS)
        out[option] = r[option] === true;
    return (out);
}
export function heartbeatToolPolicy(body) {
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'toolPolicy'))
        return null;
    return readToolPolicy(body.toolPolicy);
}
export function laneMePolicy(body, lane) {
    if (!body || typeof body !== 'object')
        return null;
    if (body.actorUserId !== lane?.userId || String(body.assistantId) !== String(lane?.assistantId))
        return null;
    if (body.lane !== personLaneStamp(lane.userId))
        return null;
    return readToolPolicy(body.toolPolicy);
}
export function compareToolPolicy(launched, current) {
    const a = readToolPolicy(launched);
    const b = readToolPolicy(current);
    if (LAUNCH_POLICY_OPTIONS.some((o) => a[o] && !b[o]))
        return 'tighter';
    if (LAUNCH_POLICY_OPTIONS.some((o) => !a[o] && b[o]))
        return 'looser';
    return 'same';
}
export function laneToolsFor(policy, baseTools) {
    const p = readToolPolicy(policy);
    return [
        ...baseTools,
        ...(p.webFetch ? ['WebFetch', 'WebSearch'] : []),
        ...(p.shell ? ['Bash'] : []),
    ];
}
export function laneAllowAdditions(policy, { agentFolder = null, ownerServerNames = [], platform = process.platform } = {}) {
    const p = readToolPolicy(policy);
    return [
        ...(p.webFetch ? ['WebFetch', 'WebSearch'] : []),
        ...(p.shell ? ['Bash'] : []),
        ...(p.readAgentFolder && agentFolder ? [`Read(${permissionRulePath(agentFolder, platform)}/**)`] : []),
        ...(p.ownerMcpServers ? ownerServerNames.map((name) => `mcp__${name}`) : []),
    ];
}
export function laneDenyAdditions(policy, { agentFolder = null, platform = process.platform } = {}) {
    const p = readToolPolicy(policy);
    return p.readAgentFolder && agentFolder
        ? [`Edit(${permissionRulePath(agentFolder, platform)}/**)`, ...laneAgentFolderSecretDenies(agentFolder, platform)]
        : [];
}
export function laneAgentFolderSecretDenies(agentFolder, platform = process.platform) {
    const root = permissionRulePath(agentFolder, platform);
    return [
        `Read(${root}/.mcp.json)`,
        `Read(${root}/**/.mcp.json)`,
        `Read(${root}/.git/**)`,
        `Read(${root}/**/.git/**)`,
        `Read(${root}/.claude/**)`,
        `Read(${root}/**/.env*)`,
        `Read(${root}/.env*)`,
        `Read(${root}/**/credentials*.json)`,
    ];
}
export function laneShellSandboxAvailable({ platform = process.platform, exists, onPath }) {
    if (platform === 'darwin')
        return exists('/usr/bin/sandbox-exec');
    if (platform === 'linux')
        return onPath('bwrap') && onPath('socat');
    return false;
}
export const LANE_SHELL_SANDBOX = Object.freeze({
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: Object.freeze({ strictAllowlist: true, allowedDomains: Object.freeze([]) }),
});
export function laneShellSandbox({ home, workDir, agentFolder = null, platform = process.platform, shellPrefix = null }) {
    const sharedTemp = platform === 'darwin' ? ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'] : ['/tmp', '/var/tmp'];
    return {
        ...LANE_SHELL_SANDBOX,
        filesystem: {
            denyRead: [home, ...sharedTemp],
            allowRead: [workDir, ...(agentFolder ? [agentFolder] : []), ...(shellPrefix ? [shellPrefix] : [])],
            denyWrite: sharedTemp,
        },
    };
}
export function laneShellReadDenies({ home, laneDir, otherLaneDirs = [], agentFolder = null, platform = process.platform }) {
    const p = flavor(platform);
    const rule = (abs) => `Read(${permissionRulePath(abs, platform)})`;
    const inHome = (rel) => rule(p.join(home, rel));
    return [
        inHome('.ssh/**'), inHome('.aws/**'), inHome('.gnupg/**'), inHome('.config/gcloud/**'), inHome('.config/gh/**'),
        inHome('.claude/**'), inHome('.claude.json'), inHome('.netrc'), inHome('.git-credentials'), inHome('.npmrc'),
        inHome('.docker/config.json'), inHome('.env*'), inHome('Library/Keychains/**'),
        inHome('**/.env*'), inHome('**/.mcp.json'), inHome('**/credentials*.json'),
        inHome('.bgos-plugin-state/**'),
        inHome('.bgos-agent/*.json'),
        inHome('.bgos-agent/**/credentials*.json'),
        inHome('.bgos-agent/*/browser/**'),
        inHome('.bgos-agent/*/people/*.json'),
        inHome('.bgos-agent/logs/**'), inHome('.bgos-agent/**/*.log'),
        ...otherLaneDirs.map((dir) => rule(p.join(dir, '**'))),
        ...['mcp.json', 'settings.json', 'launch-policy.json', 'choices.json', 'restart-request.json', 'events.jsonl',
            'lane.json', 'session-id', 'stop-request.json', 'revoked.json', 'wake.json', 'start-failures.json',
            'launcher.log', 'lane-daemon.log', 'claude-debug.log', 'launcher.lock', 'claude-config/**', 'memory-rpc/**']
            .map((name) => rule(p.join(laneDir, name))),
        ...(agentFolder ? laneAgentFolderSecretDenies(agentFolder, platform) : []),
    ];
}
const RULE_UNSAFE_RE = /[\0\n\r()[\]{}*?"'`\\]/;
function flavor(platform) {
    return platform === 'win32' ? win32Path : posixPath;
}
export function agentFolderVerdict(folder, { home, stateRoots, realpath, platform = process.platform }) {
    const p = flavor(platform);
    if (typeof folder !== 'string' || folder.trim() === '')
        return { ok: false, reason: 'none' };
    if (!p.isAbsolute(folder))
        return { ok: false, reason: 'not_absolute' };
    if (RULE_UNSAFE_RE.test(folder))
        return { ok: false, reason: 'unsafe_characters' };
    let real;
    let realHome;
    try {
        real = realpath(folder);
        realHome = realpath(home);
    }
    catch {
        return { ok: false, reason: 'missing' };
    }
    if (RULE_UNSAFE_RE.test(real))
        return { ok: false, reason: 'unsafe_characters' };
    if (isInsideFolder(realHome, real, platform))
        return { ok: false, reason: 'home_or_above' };
    for (const root of stateRoots) {
        let realRoot = root;
        try {
            realRoot = realpath(root);
        }
        catch { }
        if (isInsideFolder(realRoot, real, platform))
            return { ok: false, reason: 'holds_agent_state' };
        if (isInsideFolder(real, realRoot, platform))
            return { ok: false, reason: 'inside_agent_state' };
    }
    return { ok: true, path: real };
}
export const OWNER_MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_MCP_NAME_REFUSED_RE = /bgos|hoai/i;
const OWNER_MCP_BODY_REFUSED_RE = /server\.ts|lane-server|bgos-launch|claude-channel-bgos|BGOS_|HOAI_RELAY|hoai-browser/i;
export const OWNER_MCP_MAX = 20;
function serverShapeOk(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def))
        return false;
    if (typeof def.command === 'string' && def.command.trim() !== '')
        return true;
    return typeof def.url === 'string' && /^https?:\/\//.test(def.url);
}
export function ownerMcpServersFrom(claudeJson, { agentFolder = null } = {}) {
    const merged = {};
    const add = (block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block))
            return;
        for (const [name, def] of Object.entries(block))
            merged[name] = def;
    };
    add(claudeJson?.mcpServers);
    if (agentFolder)
        add(claudeJson?.projects?.[agentFolder]?.mcpServers);
    const servers = {};
    const skipped = [];
    for (const [name, def] of Object.entries(merged)) {
        const body = (() => { try {
            return JSON.stringify(def);
        }
        catch {
            return '';
        } })();
        if (!OWNER_MCP_NAME_RE.test(name) ||
            OWNER_MCP_NAME_REFUSED_RE.test(name) ||
            !serverShapeOk(def) ||
            body === '' ||
            OWNER_MCP_BODY_REFUSED_RE.test(body) ||
            Object.keys(servers).length >= OWNER_MCP_MAX) {
            skipped.push(name);
            continue;
        }
        servers[name] = def;
    }
    return { servers, skipped };
}
export { LANE_EFFORT_LEVELS, LANE_MODEL_RE };
export const LANE_CHOICE_DEFAULT = 'default';
export function readLaneAllowedChoices(text) {
    let raw;
    try {
        raw = JSON.parse(String(text));
    }
    catch {
        return { models: [], efforts: [] };
    }
    const list = (value, ok) => (Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && ok(v)))] : []);
    return {
        models: list(raw?.models, (m) => LANE_MODEL_RE.test(m)),
        efforts: list(raw?.efforts, (e) => LANE_EFFORT_LEVELS.includes(e)),
    };
}
export function laneChoiceVerdict({ kind, value, allowed }) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '')
        return { ok: false, reason: 'empty' };
    if (text.toLowerCase() === LANE_CHOICE_DEFAULT)
        return { ok: true, value: null };
    const list = kind === 'model' ? allowed?.models ?? [] : allowed?.efforts ?? [];
    const shapeOk = kind === 'model' ? LANE_MODEL_RE.test(text) : LANE_EFFORT_LEVELS.includes(text);
    return shapeOk && list.includes(text) ? { ok: true, value: text } : { ok: false, reason: 'not_allowed' };
}
export function readLaneChoices(text) {
    let raw;
    try {
        raw = JSON.parse(String(text));
    }
    catch {
        return { model: null, effort: null, chatId: null };
    }
    return {
        model: typeof raw?.model === 'string' && LANE_MODEL_RE.test(raw.model) ? raw.model : null,
        effort: typeof raw?.effort === 'string' && LANE_EFFORT_LEVELS.includes(raw.effort) ? raw.effort : null,
        chatId: typeof raw?.chatId === 'string' && /^[1-9][0-9]*$/.test(raw.chatId) ? raw.chatId : null,
    };
}
export function effectiveLaneChoices(choices, allowed) {
    const c = choices ?? {};
    return {
        model: c.model && (allowed?.models ?? []).includes(c.model) && LANE_MODEL_RE.test(c.model) ? c.model : null,
        effort: c.effort && (allowed?.efforts ?? []).includes(c.effort) && LANE_EFFORT_LEVELS.includes(c.effort) ? c.effort : null,
    };
}
export const LANE_RESTART_REASONS = Object.freeze(['new', 'model', 'effort', 'policy_tightened', 'policy_loosened', 'lane_list_changed']);
export const LANE_IDLE_RESTART_QUIET_MS = 60_000;
export function readLaneRestartRequest(text) {
    let raw;
    try {
        raw = JSON.parse(String(text));
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r) => LANE_RESTART_REASONS.includes(r)) : [];
    if (reasons.length === 0)
        return null;
    return {
        reasons,
        when: raw.when === 'now' ? 'now' : 'idle',
        fresh: raw.fresh === true,
        chatId: typeof raw.chatId === 'string' && /^[1-9][0-9]*$/.test(raw.chatId) ? raw.chatId : null,
    };
}
export function mergeLaneRestartRequests(existing, next) {
    if (!existing)
        return next;
    if (!next)
        return existing;
    return {
        reasons: [...new Set([...existing.reasons, ...next.reasons])],
        when: existing.when === 'now' || next.when === 'now' ? 'now' : 'idle',
        fresh: existing.fresh === true || next.fresh === true,
        chatId: next.chatId ?? existing.chatId ?? null,
    };
}
export function decideLaneRestart({ request, inFlight, lastActivityAtMs, startedAtMs, nowMs, quietMs = LANE_IDLE_RESTART_QUIET_MS }) {
    if (!request)
        return 'wait';
    if (request.when === 'now')
        return 'now';
    if (inFlight)
        return 'wait';
    const last = Number.isFinite(lastActivityAtMs) ? Math.max(lastActivityAtMs, startedAtMs ?? 0) : startedAtMs ?? 0;
    return nowMs - last >= quietMs ? 'now' : 'wait';
}
