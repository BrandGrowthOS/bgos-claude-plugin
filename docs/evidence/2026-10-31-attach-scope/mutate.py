#!/usr/bin/env python3
"""Mutation proofs for the attach scope tests. Each mutant: apply one edit,
show the changed line, run the guarding test file(s), expect RED, restore.
A mutant whose test run fails to even load (syntax) is reported, not counted."""
import os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.chdir(ROOT)
ENV = dict(os.environ, PATH=os.path.expanduser('~/.bun/bin') + ':' + os.environ['PATH'])

UNIT = ['test/attach-scope.test.ts']
LAUNCH = ['test/attach-scope.launcher.test.ts']
E2E = ['test/attach-scope.e2e.test.ts']

M = [
  ('M1 wrong agent never refused', 'lib/attach-scope.mjs',
   "  const refuseWrong = effective === 'wrong-agent' || effective === 'strict'\n",
   "  const refuseWrong = false\n", UNIT + E2E),
  ('M2 fail open removed (unreadable judged)', 'lib/attach-scope.mjs',
   "  if (!envReadable || !self) return decide('attach', 'unreadable', null)\n",
   "", UNIT + E2E),
  ('M3 match inverted', 'lib/attach-scope.mjs',
   "  if (ownScope && scopeId === self) return decide('attach', 'match', null)\n",
   "  if (ownScope && scopeId !== self) return decide('attach', 'match', null)\n", UNIT + E2E),
  ('M4 unscoped refused outside strict', 'lib/attach-scope.mjs',
   "  return decide(effective === 'strict' ? 'refuse' : 'attach', 'unscoped', 'strict')\n",
   "  return decide(effective !== 'off' ? 'refuse' : 'attach', 'unscoped', 'strict')\n", UNIT),
  ('M5 default mode on', 'lib/attach-scope.mjs',
   "export const DEFAULT_ATTACH_SCOPE_MODE = 'off'\n",
   "export const DEFAULT_ATTACH_SCOPE_MODE = 'strict'\n", UNIT + E2E),
  ('M6 unknown mode not off in decide', 'lib/attach-scope.mjs',
   "  const effective = ATTACH_SCOPE_MODES.includes(mode) ? mode : DEFAULT_ATTACH_SCOPE_MODE\n",
   "  const effective = normalizeMode(mode) ?? 'wrong-agent'\n", UNIT),
  ('M7 invalid env setting obeyed as strict', 'lib/attach-scope.mjs',
   "    return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'env', invalid: `${ATTACH_SCOPE_MODE_ENV}=${oneLine(fromEnv, 40)}` }\n",
   "    return { mode: 'strict', source: 'env', invalid: `${ATTACH_SCOPE_MODE_ENV}=${oneLine(fromEnv, 40)}` }\n", UNIT),
  ('M8 env does not win over file', 'lib/attach-scope.mjs',
   "    if (mode) return { mode, source: 'env' }\n",
   "    if (mode && !readText) return { mode, source: 'env' }\n", UNIT),
  ('M9 scope digits check dropped', 'lib/attach-scope.mjs',
   "  if (!ID_RE.test(value)) return { state: 'unreadable' }\n",
   "", UNIT),
  ('M10 strict tally skips unscoped', 'lib/attach-scope.mjs',
   "    summary.wouldRefuseStrict += 1\n",
   "    if (outcome === 'wrong-agent') summary.wouldRefuseStrict += 1\n", UNIT),
  ('M11 no rotation', 'lib/attach-scope.mjs',
   "      if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)\n",
   "      if (false) renameSync(path, `${path}.1`)\n", UNIT),
  ('M12 telemetry throws', 'lib/attach-scope.mjs',
   "  } catch {\n    return false\n  }\n}\n\n/**\n * Every readable event",
   "  } catch (err) {\n    throw err\n  }\n}\n\n/**\n * Every readable event", UNIT),
  ('M13 doctor row never WARN', 'lib/attach-scope.mjs',
   "  if (d.outcome === 'wrong-agent') {\n    return {\n      name: 'Attach scope',\n      status: 'WARN',",
   "  if (d.outcome === 'wrong-agent') {\n    return {\n      name: 'Attach scope',\n      status: 'OK',", UNIT),
  ('M14 launcher keeps an inherited scope', 'bin/hoai-core.mjs',
   "  if (/^\\d{1,12}$/.test(id)) env[ATTACH_SCOPE_ENV] = id\n",
   "  if (/^\\d{1,12}$/.test(id) && !env[ATTACH_SCOPE_ENV]) env[ATTACH_SCOPE_ENV] = id\n", LAUNCH),
  ('M15 launcher passes an inherited scope it cannot name', 'bin/hoai-core.mjs',
   "  else delete env[ATTACH_SCOPE_ENV]\n",
   "", LAUNCH),
  ('M16 folder pin launch unscoped', 'bin/hoai-core.mjs',
   "      attachScope: declared.id,\n",
   "      attachScope: '',\n", LAUNCH),
  ('M17 launch never applies the scope', 'bin/hoai-core.mjs',
   "  applyAttachScope(env, plan.attachScope, plan.attachScopeDir)\n",
   "", LAUNCH),
  ('M18 supervised launch unscoped', 'bin/hoai-core.mjs',
   "      attachScope: serviceId,\n",
   "      attachScope: '',\n", LAUNCH),
  ('M19 server never refuses', 'server.ts',
   "  if (ATTACH_SCOPE.verdict !== 'refuse') return\n",
   "  if (true) return\n", E2E),
  ('M20 server judges the scope against itself', 'server.ts',
   "  assistantId: String(ASSISTANT_ID ?? ''),\n  cwd: ATTACH_SCOPE_FOLDER,",
   "  assistantId: String(process.env.HOAI_ATTACH_SCOPE ?? ''),\n  cwd: ATTACH_SCOPE_FOLDER,", E2E),
  ('M21 server records nothing', 'server.ts',
   "  recordAttachScopeEvent({\n    dir: ATTACH_SCOPE_STATE_DIR,",
   "  void ({\n    dir: ATTACH_SCOPE_STATE_DIR,", E2E),
  ('M22 measurement script ignores the env setting', 'bin/hoai-attach-scope.mjs',
   "  const mode = resolveAttachScopeMode({\n    env,",
   "  const mode = resolveAttachScopeMode({\n    env: {},", UNIT),
  ('M23 folder pin rule removed', 'lib/attach-scope.mjs',
   "  if (pin && pin !== self) return decide(",
   "  if (false) return decide(", UNIT + E2E),
  ('M24 inherited scope trusted', 'lib/attach-scope.mjs',
   "      ownScope = false\n", "", UNIT),
  ('M25 folder compare ignores case rule', 'lib/attach-scope.mjs',
   "    return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed\n",
   "    return trimmed\n", UNIT),
  ('M26 folder compare skips realpath', 'lib/attach-scope.mjs',
   "      out = realpath(out) || out\n", "", UNIT),
  ('M27 ids not normalized', 'lib/attach-scope.mjs',
   "  return id.replace(/^0+(?=\\d)/, '')\n", "  return id\n", UNIT),
  ('M28 gen1 launcher not recorded', 'lib/attach-scope.mjs',
   "  else if (continued) launcher = 'gen1'\n", "", UNIT),
  ('M29 distinct count is the boot count', 'lib/attach-scope.mjs',
   "  summary.distinctWouldRefuseStrict = strictKeys.size\n",
   "  summary.distinctWouldRefuseStrict = summary.wouldRefuseStrict\n", UNIT),
  ('M30 wrong agent by folder tallied as by scope', 'lib/attach-scope.mjs',
   "      const by = event.by === 'folder' ? 'folder' : 'scope'\n",
   "      const by = 'scope'\n", UNIT),
  ('M31 launcher never sets the scope folder', 'bin/hoai-core.mjs',
   "  if (folder) env[ATTACH_SCOPE_DIR_ENV] = folder\n",
   "  if (false) env[ATTACH_SCOPE_DIR_ENV] = folder\n", LAUNCH),
  ('M32 run plan omits the folder', 'bin/hoai-core.mjs',
   "      attachScope: declared.id,\n      attachScopeDir: cwd,\n",
   "      attachScope: declared.id,\n      attachScopeDir: '',\n", LAUNCH),
  ('M33 server serves the home notice', 'server.ts',
   "  const served = await serveScopeRefused({\n",
   "  const served = await serveHomeRefused({\n", E2E),
  ('M34 server reads no folder pin', 'server.ts',
   "  folderPinId: readFolderPinId(ATTACH_SCOPE_FOLDER),\n", "", E2E),
  ('M35 main never runs the scope step', 'server.ts',
   "  await attachScopeAtBoot()\n", "", E2E),
  ('M36 scope step runs before the duplicate check', 'server.ts',
   "  {\n    const verdict = decideDuplicateCopy({",
   "  await attachScopeAtBoot()\n  {\n    const verdict = decideDuplicateCopy({", ['test/duplicate-copy.e2e.test.ts']),
]

only = set(sys.argv[1:])
results = []
for name, path, old, new, tests in M:
    if only and name.split()[0] not in only:
        continue
    src = open(path).read()
    if src.count(old) != 1:
        results.append((name, 'SETUP-ERROR (anchor count %d)' % src.count(old)))
        print('!!', name, 'anchor count', src.count(old), flush=True)
        continue
    try:
        open(path, 'w').write(src.replace(old, new))
        first_old = old.strip().splitlines()[-1] if old.strip() else old
        print(f'== {name}  [{path}]', flush=True)
        print(f'   - {old.strip().splitlines()[0] if old.strip() else old!r}')
        print(f'   + {new.strip().splitlines()[0] if new.strip() else "(line deleted)"}', flush=True)
        r = subprocess.run(['npx', 'tsx', '--test', *tests], capture_output=True, text=True, env=ENV, timeout=600)
        out = r.stdout + r.stderr
        loaded = 'SyntaxError' not in out and 'ERR_MODULE_NOT_FOUND' not in out
        failed = [l.strip() for l in out.splitlines() if l.startswith('✖ ') and 'failing tests' not in l]
        failed = list(dict.fromkeys(failed))
        status = 'KILLED' if (r.returncode != 0 and loaded) else ('NO-COMPILE' if not loaded else 'SURVIVED')
        results.append((name, status))
        print(f'   -> {status}; red: {len(failed)}', flush=True)
        for f in failed[:4]:
            print(f'      {f}', flush=True)
    finally:
        open(path, 'w').write(src)

subprocess.run(['git', 'diff', '--stat'])
print('\nSUMMARY')
for n, s in results:
    print(f'{s:12} {n}')
