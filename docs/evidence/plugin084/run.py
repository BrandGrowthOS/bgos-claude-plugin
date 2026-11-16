"""Run a release check with local scratch state and retain its exact result."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
label, *command = sys.argv[1:]
cwd = ROOT
baseline = command[0] == '--baseline'
if baseline:
    cwd = ROOT / 'node_modules' / '.plugin084' / 'main'
    command.pop(0)
plain_tmp = command[0] == '--plain-tmp'
if plain_tmp:
    command.pop(0)
runtime = ROOT / 'node_modules' / '.plugin084' / label
env = {k: v for k, v in os.environ.items()
       if not k.startswith(('BGOS_', 'HOAI_', 'CLAUDE_', 'CLAUDECODE'))}
for key, suffix in {
    'HOME': 'home', 'TMPDIR': 'tmp', 'TMP': 'tmp', 'TEMP': 'tmp',
    'XDG_CACHE_HOME': 'cache', 'XDG_CONFIG_HOME': 'config',
    'BUN_INSTALL_CACHE_DIR': 'bun-cache', 'npm_config_cache': 'npm-cache',
}.items():
    path = ROOT / '.plugin084-tmp' / label if plain_tmp and suffix == 'tmp' else runtime / suffix
    path.mkdir(parents=True, exist_ok=True)
    env[key] = str(path.resolve())
env['npm_config_update_notifier'] = 'false'
env['npm_config_offline'] = 'true'
env['NO_COLOR'] = '1'
chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if chrome.is_file():
    env['HOAI_BROWSER_EXECUTABLE'] = str(chrome)
start = time.monotonic()
metadata = {
    'command': command, 'cwd': str(cwd),
    'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'environment': {k: env[k] for k in ['HOME', 'TMPDIR', 'npm_config_cache', 'npm_config_offline']},
    'browser': env.get('HOAI_BROWSER_EXECUTABLE'),
    'server_sha256': hashlib.sha256((cwd / 'server.ts').read_bytes()).hexdigest(),
}
if baseline:
    metadata['source_ref'] = json.loads((EVIDENCE / 'inputs.json').read_text())['main']
log = EVIDENCE / f'{label}.log'
with log.open('wb') as stream:
    result = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
metadata.update(exit_code=result.returncode, seconds=round(time.monotonic() - start, 3))
(EVIDENCE / f'{label}.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata, indent=2), flush=True)
print('\n'.join(log.read_text(errors='replace').splitlines()[-18:]), flush=True)
sys.exit(result.returncode)
