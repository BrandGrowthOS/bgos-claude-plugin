#!/usr/bin/env python3
"""Mutation proof for board row 01a0db74: each mutant changes ONE line, must still parse, and must turn
the named test file red on an assertion (not on a load error). Restores the file after each run."""
import subprocess, sys, os, re

ROOT = '/Users/kc/hoai-work/mbplugtrack'
os.chdir(ROOT)

LIB = 'lib/follow-published.mjs'
AGENT = 'bin/bgos-agent'
CLAIM = 'bin/bgos-claim.mjs'
BOOT = 'bin/hoai-bootstrap.sh'
PS1 = 'bin/hoai-bootstrap.ps1'
SELF = 'lib/self-update.ts'

T_LIB = ['npx', 'tsx', '--test', 'test/follow-published.test.ts']
T_UPD = ['npx', 'tsx', '--test', 'test/bgos-agent.update-published.test.ts']
T_REEXEC = ['npx', 'tsx', '--test', 'test/bgos-agent.update-reexec.test.ts']
T_CLAIM = ['npx', 'tsx', '--test', 'test/bgos-claim.published.test.ts']
T_INST = ['npx', 'tsx', '--test', 'test/clone-install.published.test.ts']
T_SELF = ['bun', 'test', 'test/self-update.published-release.test.ts']

MUTANTS = [
    # lib/follow-published.mjs
    ('L1 no newer check: an ahead clone is moved back', LIB, "  if (!opts.fresh) {\n    if (from === null)", "  if (false) {\n    if (from === null)", T_LIB),
    ('L2 ahead reads as current', LIB, "      if (from === to) return result('current'", "      if (true) return result('current'", T_LIB),
    ('L3 local changes ignored', LIB, "  if (status.stdout.trim()) return result('dirty'", "  if (false) return result('dirty'", T_LIB),
    ('L4 tag package.json not checked', LIB, "  if (carried !== to) {", "  if (false) {", T_LIB),
    ('L5 a shallow clone is deepened', LIB, "  const depth = shallow.code === 0 && shallow.stdout.trim() === 'true' ? ['--depth', '1'] : []", "  const depth = []", T_LIB),
    ('L6 every stay is an error', LIB, "  if (outcome === 'current' || outcome === 'ahead') return 10", "  if (outcome === 'current') return 10", T_LIB),
    ('L7 an unreadable release falls back to main', LIB, "    return result('unknown', `${firstLine(error instanceof Error ? error.message : String(error))}; ${NOT_CHANGED} (it stays at ${at})`)", "    tag = 'v0.27.0'", T_LIB),
    # bin/bgos-agent update
    ('A1 update always takes the release, even backwards', AGENT, '    said="$(published_release "$PLUGIN_DIR" follow "$PLUGIN_DIR" 2>&1)" || rc=$?', '    said="$(published_release "$PLUGIN_DIR" follow "$PLUGIN_DIR" --fresh 2>&1)" || rc=$?', T_UPD),
    ('A2 an unreadable release is only a warning', AGENT, '      *) die "${said:-the published release could not be read; the plugin checkout was not changed}" ;;', '      *) warn "${said:-the published release could not be read; the plugin checkout was not changed}" ;;', T_UPD),
    ('A3 no hand over after a move', AGENT, '    if [ "$rc" -eq 0 ] && [ -f "$SELF" ]; then', '    if [ "$rc" -eq 10 ] && [ -f "$SELF" ]; then', T_REEXEC),
    # bin/bgos-agent install
    ('A4 install keeps a clone of main', AGENT, '  said="$(published_release "$partial" follow "$partial" --fresh 2>&1)" || rc=$?', '  said="$(published_release "$partial" follow "$partial" 2>&1)" || rc=$?', T_INST),
    ('A5 install keeps a clone it could not pin', AGENT, '  if [ "$rc" -ne 0 ] && [ "$rc" -ne 10 ]; then', '  if false; then', T_INST),
    # bin/bgos-claim.mjs
    ('C1 a new claim checkout stays on main', CLAIM, '      const pinned = await followPublishedRelease({ dir: partial, fresh: true, readPublishedTag })', '      const pinned = await followPublishedRelease({ dir: partial, readPublishedTag })', T_CLAIM),
    ('C2 a new claim checkout is kept when it could not be pinned', CLAIM, '      if (exitCodeFor(pinned.outcome) === 1) {', '      if (false) {', T_CLAIM),
    ('C3 an existing claim checkout is moved back', CLAIM, '    const followed = await followPublishedRelease({ dir: pluginDir, readPublishedTag })', '    const followed = await followPublishedRelease({ dir: pluginDir, fresh: true, readPublishedTag })', T_CLAIM),
    # bin/hoai-bootstrap.sh and .ps1
    ('S1 bootstrap.sh keeps main', BOOT, '        PINNED="$(node "$PLUGIN_PARTIAL/bin/hoai-published-release.mjs" follow "$PLUGIN_PARTIAL" --fresh 2>&1)" || PINNED_RC=$?', '        PINNED="$(node "$PLUGIN_PARTIAL/bin/hoai-published-release.mjs" follow "$PLUGIN_PARTIAL" 2>&1)" || PINNED_RC=$?', T_INST),
    ('S2 bootstrap.sh keeps a clone it could not pin', BOOT, '        if [ "$PINNED_RC" -ne 0 ] && [ "$PINNED_RC" -ne 10 ]; then', '        if false; then', T_INST),
    ('P1 bootstrap.ps1 keeps main', PS1, "        $pinned = (& node (Join-Path $pluginPartial 'bin\\hoai-published-release.mjs') follow $pluginPartial --fresh 2>&1 | Out-String).Trim()", "        $pinned = (& node (Join-Path $pluginPartial 'bin\\hoai-published-release.mjs') follow $pluginPartial 2>&1 | Out-String).Trim()", T_INST),
    # lib/self-update.ts
    ('U1 the daemon does not say it is ahead', SELF, '    compareSemver(runningSemver, latestSemver) > 0', '    compareSemver(runningSemver, latestSemver) < 0', T_SELF),
    # review fixes
    ('R1 a reset drops unpushed commits', LIB, "    if (own.code !== 0 || own.stdout.trim()) {", "    if (false) {", T_LIB),
    ('R2 bootstrap.sh removes an empty folder before the clone', BOOT, '        if [ -L "$PLUGIN_ROOT" ] || { [ -e "$PLUGIN_ROOT" ] && [ -n "$(ls -A "$PLUGIN_ROOT" 2>/dev/null)" ]; }; then', '        if [ -e "$PLUGIN_ROOT" ] && ! rmdir "$PLUGIN_ROOT" 2>/dev/null; then', T_INST),
    ('R3 install removes an empty folder before the clone', AGENT, '  if [ -L "$target" ] || { [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; }; then', '  if [ -e "$target" ] && ! rmdir "$target" 2>/dev/null; then', T_INST),
    ('R4 bootstrap.ps1 carries on after a refused move', PS1, "        if (-not (Test-Path (Join-Path $PluginRoot 'server.ts'))) {", "        if ($false) {", T_INST),
    ('R5 an ahead host is told it is up to date', AGENT, '    ok "no change: the plugin stays at $AFTER"', '    ok "already up to date at $AFTER"', T_UPD),
    ('R6 a host a major ahead gets the generic line', SELF, "    inspection.versionDecision.kind === 'skip' &&\n    runningSemver &&", "    inspection.versionDecision.kind === 'skip' && inspection.versionDecision.reason === 'not-newer' &&\n    runningSemver &&", T_SELF),
]

def parses(path):
    if path.endswith('.mjs'):
        return subprocess.run(['node', '--check', path], capture_output=True).returncode == 0
    if path.endswith('.sh') or path == AGENT:
        return subprocess.run(['bash', '-n', path], capture_output=True).returncode == 0
    if path.endswith('.ts'):
        return subprocess.run(['bun', 'build', '--no-bundle', path], capture_output=True).returncode == 0
    return True  # .ps1: no parser here; the change is a flag removal

only = sys.argv[1:]
results = []
for name, path, old, new, cmd in MUTANTS:
    if only and not any(name.startswith(o) for o in only):
        continue
    src = open(path).read()
    assert src.count(old) == 1, f'{name}: the line to mutate occurs {src.count(old)} times in {path}'
    lineno = src[: src.index(old)].count('\n') + 1
    open(path, 'w').write(src.replace(old, new))
    try:
        ok_parse = parses(path)
        print(f'\n=== {name}\n--- {path}:{lineno}\n-  {old.strip()}\n+  {new.strip()}', flush=True)
        if not ok_parse:
            print('    MUTANT DOES NOT PARSE: no kill'); results.append((name, 'NO-PARSE')); continue
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        out = r.stdout + r.stderr
        assertion = bool(re.search(r'AssertionError|expect\(received\)|error: expect', out))
        loadfail = bool(re.search(r'SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module', out)) and not assertion
        killed = r.returncode != 0 and assertion and not loadfail
        failing = [l.strip() for l in out.splitlines() if l.startswith('✖ ') or l.startswith('(fail)')]
        failing = list(dict.fromkeys(failing))[:4]
        print(f'    {"KILLED" if killed else "SURVIVED"} (rc {r.returncode})')
        for f in failing: print(f'      {f}')
        results.append((name, 'KILLED' if killed else 'SURVIVED'))
    finally:
        open(path, 'w').write(src)

print('\n=== summary')
for name, verdict in results: print(f'{verdict:9} {name}')
sys.exit(0 if all(v == 'KILLED' for _, v in results) else 1)
