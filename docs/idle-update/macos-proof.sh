#!/usr/bin/env bash
# The launchd proof of the idle update, for a Mac (docs/idle-update/MACOS-PROOF.md).
#
# One scratch agent, installed by the REAL installer (bin/bgos-agent install --always-on)
# under a scratch HOME, so it runs exactly as Alex's agents do: launchd > run.sh > tmux on
# the agent's own socket > hoai > expect > claude > the daemon. claude is the rig's
# stand-in (no model), the backend is the rig's stub on 127.0.0.1. A staged build plus
# an idle agent must restart once, resume the same session, validate and report.
#
# Nothing real is touched: the job's label, plist, tmux socket and state all carry the
# scratch HOME's id; the stub never sends a watcher install; every process stopped is one
# this script started, by its exact pid or its own label and socket. launchctl's job list
# is compared before and after.
#
# usage (from this checkout, logged in to the Mac's desktop, `bun install` done):
#   bash docs/idle-update/macos-proof.sh
set -uo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
ID=7300001                    # no real agent has this id
FROM=0.81.0
TARGET=0.81.1
SCALE=5
ROOT=/private/tmp/idleupd-proof.$$   # the physical path: the installer compares HOME as typed
SH=$ROOT/home
CACHE=$SH/.claude/plugins/cache/hoai/hoai
WORK=$SH/agents/$ID
PORT=$((43000 + RANDOM % 6000))
LOG=$SH/.bgos-agent/logs/bgos-plugin-$ID.log
UID_N=$(id -u)
FAILS=()
STUB_PID=
LABEL=
SOCK=

say() { printf '[proof %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { FAILS+=("$1"); say "FAIL $1"; }
pass() { say "PASS $1"; }
die() { say "STOP $*"; exit 2; }

for tool in bun node expect tmux git launchctl plutil; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
done
[ -x /usr/libexec/PlistBuddy ] || die "/usr/libexec/PlistBuddy is missing"
[ -d "$REPO/node_modules" ] || die "run bun install in $REPO first"
[ "$(uname -s)" = Darwin ] || die "this proof is for macOS"

# The scratch agent's own environment: nothing of the person's HOME, config dir or plugin root.
SPATH="$SH/.local/bin:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):$(dirname "$(command -v expect)"):$(dirname "$(command -v tmux)"):/usr/bin:/bin:/usr/sbin:/sbin"
scratch() { env -i HOME="$SH" USER="$USER" LOGNAME="${LOGNAME:-$USER}" TMPDIR="${TMPDIR:-/tmp}" PATH="$SPATH" BGOS_PLUGIN_DIR="$CACHE/$FROM" "$@"; }
agent() { scratch bash "$CACHE/$FROM/bin/bgos-agent" "$@" --assistant "$ID"; }
jobs_now() { launchctl list | awk 'NR > 1 { print $3 }' | sort; }

teardown() {
  say 'teardown: uninstall the scratch agent, then its own label and socket, then the stub by its pid'
  [ -f "$CACHE/$FROM/bin/bgos-agent" ] && agent uninstall >>"$ROOT/teardown.log" 2>&1
  [ -n "$LABEL" ] && launchctl bootout "gui/$UID_N/$LABEL" >>"$ROOT/teardown.log" 2>&1
  [ -n "$SOCK" ] && tmux -L "$SOCK" kill-server >>"$ROOT/teardown.log" 2>&1
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
}
trap teardown EXIT

say "scratch HOME $SH, stub port $PORT"
JOBS_BEFORE=$(jobs_now)
mkdir -p "$CACHE" "$WORK" "$SH/.local/bin" "$SH/.bgos-agent"

# Two builds of this checkout, as Claude Code's marketplace cache holds them.
for v in "$FROM" "$TARGET"; do
  rsync -a --exclude .git --exclude test --exclude docs "$REPO/" "$CACHE/$v/" || die "copy of $v failed"
  node -e 'const fs=require("fs");const [v,...ps]=process.argv.slice(1);for(const p of ps){const d=JSON.parse(fs.readFileSync(p,"utf8"));d.version=v;fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")}' \
    "$v" "$CACHE/$v/package.json" "$CACHE/$v/.claude-plugin/plugin.json" || die "version rewrite of $v failed"
done
stage() {
  node -e 'const fs=require("fs");const [cfg,cache,v]=process.argv.slice(1);const at=new Date().toISOString();const p=cfg+"/plugins/installed_plugins.json";fs.writeFileSync(p+".tmp",JSON.stringify({version:2,plugins:{"hoai@hoai":[{scope:"user",installPath:cache+"/"+v,version:v,installedAt:at,lastUpdated:at,gitCommitSha:"proof"}]}},null,2)+"\n");fs.renameSync(p+".tmp",p)' \
    "$SH/.claude" "$CACHE" "$1"
}
stage "$FROM"
printf '{"enabledPlugins":{"hoai@hoai":true}}\n' >"$SH/.claude/settings.json"
printf '%s\n' "$ID" >"$WORK/.bgos-agent-id"
printf '{"backendUrl":"http://127.0.0.1:%s","pairingToken":"rig-token-%s","pairingId":"rig-%s","userId":"1","assistantId":"%s","pairedAt":"%s","homeDir":"%s","homeSource":"pin"}\n' \
  "$PORT" "$ID" "$ID" "$ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WORK" >"$SH/.bgos-agent/credentials-$ID.json"

say 'compiling the stand-in claude into the scratch HOME'
bun build --compile "$REPO/docs/idle-update/rig/stand-in-claude.ts" --outfile "$SH/.local/bin/claude" >"$ROOT/stand-in-build.log" 2>&1 || die "stand-in build failed (see $ROOT/stand-in-build.log)"

node "$REPO/docs/idle-update/rig/stub-backend.mjs" --port "$PORT" --dir "$ROOT" --always-on >"$ROOT/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do [ -f "$ROOT/stub-ready.json" ] && break; sleep 0.2; done
[ -f "$ROOT/stub-ready.json" ] || die "the stub did not start (see $ROOT/stub.log)"

HID=$(scratch node "$CACHE/$FROM/bin/hoai-agent-service.mjs" home-id --os Darwin) || die 'no home id'
LABEL="ai.bgos.agent.$ID.home-$HID"
SOCK="hoai-$ID-home-$HID"
PLIST="$SH/Library/LaunchAgents/$LABEL.plist"

say "installing with the real installer: label $LABEL"
agent install --always-on --no-clone --dir "$WORK" >"$ROOT/install.log" 2>&1 || die "install failed (see $ROOT/install.log)"
[ -f "$PLIST" ] || die "no plist at $PLIST"
# The plist carries fixed variables only; the proof's three go in the scratch plist itself.
for kv in "BGOS_IDLE_UPDATE_SCALE=$SCALE" "HOAI_BROWSER_HOST=off" "HOAI_RIG_DIR=$ROOT"; do
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:${kv%%=*} string ${kv#*=}" "$PLIST" >/dev/null 2>&1 ||
    /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:${kv%%=*} ${kv#*=}" "$PLIST"
done
agent restart >"$ROOT/restart.log" 2>&1 || die "restart failed (see $ROOT/restart.log)"

wait_for() { # $1 what, $2 seconds, $3... grep -E pattern in the daemon log
  local what=$1 secs=$2 pattern=$3 i
  for i in $(seq 1 "$secs"); do grep -Eq "$pattern" "$LOG" 2>/dev/null && return 0; sleep 1; done
  fail "$what (no match for /$pattern/ in $secs s)"
  return 1
}
launches() { local n; n=$(grep -c '"mode"' "$WORK/.rig/launches.jsonl" 2>/dev/null); echo "${n:-0}"; }

wait_for "the daemon armed on $FROM at scale $SCALE" 240 "idle update: armed on $FROM: .*BGOS_IDLE_UPDATE_SCALE=$SCALE" || exit 1
BEFORE=$(launches)
say "armed; $BEFORE launch(es) so far; staging $TARGET"
stage "$TARGET"
wait_for "the restart onto $TARGET validated" 1200 "idle update: restarted onto $TARGET from $FROM" || exit 1
say 'validated; watching two more minutes for a second restart'
sleep 120

AFTER=$(launches)
[ "$AFTER" -eq $((BEFORE + 1)) ] && pass "one restart ($BEFORE launch(es) before staging, $AFTER after)" || fail "expected exactly one more launch: $BEFORE before, $AFTER after"
node -e '
const fs = require("fs")
const [launches, requests, record, id, target] = process.argv.slice(1)
const lines = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const runs = lines(launches).filter((l) => l.mode)
const [prev, last] = runs.slice(-2)
const out = []
out.push([last && last.version === target && last.mode === "resume" && last.sessionId === prev.sessionId && last.resumedLines > 0, `context kept: the last launch resumed session ${last && last.sessionId} on ${last && last.version}`])
const beats = lines(requests).filter((r) => r.path === "integrations/heartbeat" && r.assistantId === id && typeof (r.body || {}).daemonVersion === "string")
const beat = beats[beats.length - 1]
out.push([beat && beat.body.daemonVersion === target && !beat.body.lastError, `reported: the last versioned heartbeat says ${beat && beat.body.daemonVersion}, lastError ${JSON.stringify(beat && beat.body.lastError)}`])
const rec = JSON.parse(fs.readFileSync(record, "utf8"))
out.push([rec.state === "validated" && rec.target === target, `record ${rec.state} for ${rec.target}`])
for (const [ok, what] of out) console.log(`${ok ? "PASS" : "FAIL"} ${what}`)
' "$WORK/.rig/launches.jsonl" "$ROOT/stub-requests.jsonl" "$SH/.bgos-agent/$ID/idle-update.json" "$ID" "$TARGET" >"$ROOT/checks.txt" 2>&1 || true
while IFS= read -r line; do case "$line" in PASS*) pass "${line#PASS }" ;; *) fail "${line#FAIL }" ;; esac; done <"$ROOT/checks.txt"
# The old daemon must have ended through its own shutdown (stdin closed, SIGTERM, SIGHUP, its output pipe), which is
# what records a clean end; one killed by a signal it does not handle leaves no line, and a slow start would roll back.
# Only after the scaled arm: the job restart before it ended the installer's first daemon too.
ENDED=$(awk -v s="BGOS_IDLE_UPDATE_SCALE=$SCALE" 'index($0, "idle update: armed on") && index($0, s) { on = 1 } on && /shutting down/' "$LOG" | head -1)
if [ -n "$ENDED" ]; then pass "the old daemon ended through its shutdown: $(printf '%s' "$ENDED" | cut -c1-160)"
else fail 'the old daemon left no shutdown line: it died on a signal it does not handle'; fi
grep -E 'idle update: ' "$LOG" | sed 's/^/  /'

trap - EXIT
teardown
launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 && fail "the scratch job $LABEL is still loaded" || pass "the scratch job is gone"
JOBS_AFTER=$(jobs_now)
if [ "$JOBS_BEFORE" = "$JOBS_AFTER" ]; then pass 'launchctl job list identical before and after'; else
  fail 'launchctl job list changed'; diff <(echo "$JOBS_BEFORE") <(echo "$JOBS_AFTER") | sed 's/^/  /'
fi

say "evidence kept in $ROOT (daemon log $LOG)"
if [ ${#FAILS[@]} -eq 0 ]; then echo "MACOS PROOF PASS"; exit 0; fi
echo "MACOS PROOF FAIL: ${FAILS[*]}"
exit 1
