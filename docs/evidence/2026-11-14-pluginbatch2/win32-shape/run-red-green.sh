#!/bin/bash
# Runs the two Windows only failures of PR #376 (run 43586786959) Windows shaped on this OS, in the checkout given
# (default: the current folder). Before the fix both print the Windows assertion; after it both pass.
#   bash docs/evidence/2026-11-14-pluginbatch2/win32-shape/run-red-green.sh [checkout]
root="${1:-.}"
shim="$(cd "$(dirname "$0")" && pwd)/register.mjs"
cd "$root" || exit 2
echo "--- #365 test/idle-update.never-arrived.test.ts, node:path as path.win32 (lib and test)"
WIN32_PATH_FILES=lib/idle-update.mjs,test/idle-update.never-arrived.test.ts \
  node --import tsx --import "$shim" --test-reporter=spec --test-name-pattern='a follower: its one way back' \
  --test test/idle-update.never-arrived.test.ts 2>&1 | grep -E "^(✔|✖) a follower|!==|ℹ (pass|fail)"
echo "--- #372 test/own-messages.test.ts, chmodSync as on Windows (a no-op)"
WIN32_FS_FILES=test/own-messages.test.ts \
  node --import tsx --import "$shim" --test-reporter=spec --test-name-pattern='a write that fails' \
  --test test/own-messages.test.ts 2>&1 | grep -E "^(✔|✖) a write|!==|ℹ (pass|fail)"
