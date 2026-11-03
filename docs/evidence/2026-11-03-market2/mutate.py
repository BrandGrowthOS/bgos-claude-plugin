#!/usr/bin/env python3
"""Reintroduce each reviewed defect, require compiling assertion failures, restore bytes."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
ENV = dict(os.environ, PATH=f"{ROOT}/node_modules/.bin:{os.environ['PATH']}")
TESTS = ['test/marketplace-attach.test.ts', 'test/marketplace-attach.e2e.test.ts']
MUTANTS = [
    ('M1', 'bin/hoai-core.mjs',
     'legacy !== null || exists(legacyPath) || ids.length !== 1', 'ids.length !== 1',
     'market2 launcher: legacy plus numbered'),
    ('M2', 'bin/hoai-core.mjs',
     "const explicitPath = String(env.BGOS_CREDENTIALS_PATH ?? '').trim()", "const explicitPath = ''",
     'market2 launcher: explicit path plus numbered'),
    ('M3', 'bin/hoai-core.mjs',
     'if (!env.BGOS_PAIRING_TOKEN && credentials?.pairingToken &&',
     'if (credentials?.homeDir && !env.BGOS_PAIRING_TOKEN && credentials?.pairingToken &&',
     'market2 launcher: (legacy without home|explicit legacy without home)'),
    ('M4', 'bin/hoai-core.mjs',
     '!explicitPath && selectedPath === legacyPath ? legacy : readFile(selectedPath)',
     'selectedPath === legacyPath ? legacy : readFile(selectedPath)',
     'market2 launcher: explicit legacy without home'),
    ('M5', 'bin/hoai-core.mjs',
     'applyAttachScope(env, plan.attachScope, plan.attachScopeDir)',
     "applyAttachScope(env, '', plan.attachScopeDir)",
     'market2 launcher:'),
    ('M6', 'lib/marketplace-attach.ts',
     "if (ownPin || ownHome) decision = { ...decision, verdict: 'attach', outcome: 'match' }",
     "if (ownPin || ownHome) decision = { ...decision, verdict: 'attach', outcome: 'match', refusedFrom: null }",
     'market2 forecast:'),
    ('M7', 'lib/attach-scope.mjs',
     " && !(outcome === 'match' && event.refusedFrom === 'strict')", '',
     'market2 forecast:'),
    ('M8', 'lib/attach-scope.mjs',
     "mode === 'home' ? mode : normalizeMode(mode) ?? DEFAULT_ATTACH_SCOPE_MODE",
     'normalizeMode(mode) ?? DEFAULT_ATTACH_SCOPE_MODE',
     'market2 diagnostics: doctor'),
    ('M9', 'bin/hoai-attach-scope.mjs',
     'const mode = effectiveAttachScopeMode(setting, installMethod)', 'const mode = setting',
     'market2 diagnostics: installed'),
    ('M10', 'lib/attach-scope.mjs',
     "installMethod === 'marketplace' && setting.source === 'default'",
     "installMethod === 'clone' && setting.source === 'default'",
     'market2 diagnostics:'),
    ('M11', 'bin/hoai-attach-scope.mjs',
     'JSON.stringify({ mode, setting, installMethod, summary, eventsDir: dir }',
     'JSON.stringify({ mode, setting: mode, installMethod, summary, eventsDir: dir }',
     'market2 diagnostics: installed'),
]
results = []
originals = {name: (ROOT / name).read_bytes() for _, name, *_ in MUTANTS}
try:
    for name, filename, before, after, pattern in MUTANTS:
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        path = ROOT / filename
        original = originals[filename]
        source = original.decode()
        assert source.count(before) == 1, (name, 'anchor count', source.count(before))
        try:
            path.write_text(source.replace(before, after, 1))
            compile_result = subprocess.run([str(ROOT / 'node_modules/.bin/tsc'), '--noEmit'], cwd=ROOT,
                                            env=ENV, capture_output=True, text=True, timeout=90)
            (OUT / f'{name}-tsc.log').write_text(compile_result.stdout + compile_result.stderr)
            if compile_result.returncode:
                results.append(dict(mutant=name, file=filename, compiled=False, killed=False))
                print(name, 'NO-COMPILE', flush=True)
                continue
            test = subprocess.run([str(ROOT / 'node_modules/.bin/tsx'), '--test', '--test-concurrency=4',
                                   '--test-reporter=tap', '--test-name-pattern=' + pattern, *TESTS],
                                  cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=120)
            output = test.stdout + test.stderr
            (OUT / f'{name}.log').write_text(output)
            killed = test.returncode == 1 and 'ERR_ASSERTION' in output and 'not ok ' in output
            results.append(dict(mutant=name, file=filename, pattern=pattern, compiled=True,
                                killed=killed, test_exit=test.returncode))
            print(name, 'KILLED' if killed else 'SURVIVED', pattern, flush=True)
        finally:
            path.write_bytes(original)
finally:
    restored = all((ROOT / name).read_bytes() == body for name, body in originals.items())
    (OUT / 'mutations.json').write_text(json.dumps(dict(results=results, restored=restored,
        sha256={name: hashlib.sha256(body).hexdigest() for name, body in originals.items()}), indent=2) + '\n')
    assert restored, 'source bytes must be restored'
if not results or not all(row['compiled'] and row['killed'] for row in results):
    sys.exit('Mutation proof failed')
