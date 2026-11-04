#!/usr/bin/env python3
"""One compiling mutant at a time, always restored. Run from the repo root."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
out = root / 'docs/evidence/2026-11-03-market'
env = dict(os.environ, PATH=f"{root}/.tools/bin:{root}/node_modules/.bin:{os.environ['PATH']}", TMPDIR=str(root / '.tmp'))
mutants = [
    ('M1', 'server.ts', "const MARKETPLACE_ATTACH = INSTALL_METHOD === 'marketplace'", "const MARKETPLACE_ATTACH = INSTALL_METHOD === 'clone'", 'marketplace real boot: a non agent folder'),
    ('M2', 'lib/marketplace-attach.ts', 'if (ownPin || ownHome)', 'if (false && (ownPin || ownHome))', 'marketplace.*(agent home|both agents)'),
    ('M3', 'lib/marketplace-attach.ts', "if (decision.outcome !== 'unscoped') return result()", "if (decision.outcome !== 'unscoped') { decision = { ...decision, verdict: 'attach' }; return result() }", 'marketplace.*(two agents|both agents)'),
    ('M4', 'lib/marketplace-attach.ts', "if (decision.outcome !== 'unscoped') return result()", "if (decision.outcome === 'match') decision = { ...decision, outcome: 'unscoped', verdict: 'refuse' }; if (decision.outcome !== 'unscoped') return result()", 'marketplace.*(scope opts in)'),
    ('M5', 'lib/marketplace-attach.ts', "return { decision: fallback, modeInfo:", "return { decision: { ...fallback, verdict: 'refuse' }, modeInfo:", 'marketplace: unreadable evidence'),
    ('M6', 'lib/attach-scope.mjs', 'ownScope = false', 'ownScope = true', 'marketplace.*(scope opts in)'),
    ('M7', 'server.ts', "recordAttachScopeEvent({\n    dir: process.env", "void ({\n    dir: process.env", 'marketplace real boot: a non agent folder'),
    ('M8', 'lib/pair-required-server.mjs', 'async () => ({ tools: [] })', "async () => ({ tools: [{ name: 'reply', inputSchema: { type: 'object' } }] })", 'marketplace real boot: a non agent folder'),
    ('M9', 'lib/marketplace-attach.ts', "if (setting.invalid || (setting.source !== 'default' && setting.mode === 'off'))", 'if (false)', 'marketplace: explicit opt-ins'),
    ('M10', 'lib/marketplace-attach.ts', "if (['1', 'true'].includes((env.BGOS_ALLOW_ANY_FOLDER ?? '').trim().toLowerCase()))", 'if (false)', 'marketplace: explicit opt-ins'),
    ('M11', 'lib/marketplace-attach.ts', "const assistantId = rawId === '${user_config.assistant_id}' ? '' : rawId", 'const assistantId = rawId', 'marketplace: an unsubstituted'),
    ('M12', 'lib/marketplace-attach.ts', "const recorded = sameAgent(credentials?.assistantId, assistantId) && typeof credentials?.homeDir === 'string'", "const recorded = typeof credentials?.homeDir === 'string'", 'marketplace: a rejected credentials'),
    ('M13', 'lib/marketplace-attach.ts', 'if (matches.length === 1)', 'if (false)', 'marketplace: two recorded homes'),
    ('M14', 'server.ts', 'homeCheckPassed(HOME_BINDING) || MARKETPLACE_ATTACH?.homeMatched === true', 'homeCheckPassed(HOME_BINDING)', 'marketplace: canonical home'),
    ('M15', 'lib/marketplace-attach.ts', 'if (matches.length === 1)', 'if (matches.length >= 1)', 'marketplace: two recorded homes'),
]
failed = []
for name, filename, before, after, pattern in mutants:
    if len(sys.argv) > 1 and name not in sys.argv[1:]: continue
    path = root / filename
    original = path.read_text()
    assert original.count(before) == 1, (name, 'anchor count', original.count(before))
    try:
        path.write_text(original.replace(before, after, 1))
        compile_result = subprocess.run(['node_modules/.bin/tsc', '--noEmit'], cwd=root, env=env, capture_output=True, text=True)
        if compile_result.returncode:
            print(name, 'NO-COMPILE', flush=True)
            (out / f'{name}.log').write_text(compile_result.stdout + compile_result.stderr)
            failed.append(name)
            continue
        test = subprocess.run(['node_modules/.bin/tsx', '--test', '--test-concurrency=4', '--test-name-pattern=' + pattern,
            'test/marketplace-attach.test.ts', 'test/marketplace-attach.e2e.test.ts'], cwd=root, env=env, capture_output=True, text=True, timeout=120)
        (out / f'{name}.log').write_text(test.stdout + test.stderr)
        killed = test.returncode != 0 and 'AssertionError' in test.stdout + test.stderr
        print(name, 'KILLED' if killed else 'SURVIVED', filename, pattern, flush=True)
        if not killed: failed.append(name)
    finally:
        path.write_text(original)
if failed: sys.exit('Failed mutants: ' + ', '.join(failed))
