#!/usr/bin/env bash
# =============================================================================
# Clean-env matrix runner for hoai-bootstrap.sh, one STATE per invocation,
# inside WSL Ubuntu (the Windows Sandbox substitute documented in the
# oneclick handoff). Each state gets a throwaway HOME and a PATH containing
# only the system dirs (WSL Ubuntu ships neither node, bun, nor claude
# there, verified), plus per-state pre-installed tools copied in, so the
# bootstrap's detect-only-install-the-gaps behavior is exercised for real.
#
#   ./run-wsl-state.sh <a|b|c|d> <pair-code> <assistant-id> <repo-dir> [seed-dir]
#
# States (from the design page's owner-requirement table):
#   a  nothing installed            expect: node + bun + claude installed,
#                                   login gate engaged, resumed on credential
#                                   drop, pair + preflight pass
#   b  only bun (node missing)      expect: node installed, bun untouched,
#                                   claude present (seeded), pair + preflight
#   c  bun missing                  expect: bun installed (both bun AND bunx
#                                   resolvable), pair + preflight
#   d  no Claude Code               expect: claude installed, the login gate
#                                   STOPS the run, resumes only after the
#                                   credential drop, pair + preflight
#
# seed-dir may hold: claude-bin/ (a prior state's ~/.local/{bin,share} claude
# install to copy), node-home/ (~/.local/node-lts + bin symlink sources),
# bun-home/ (~/.bun), credentials.json (a logged-in Claude credential file,
# dropped into the state's config dir WHEN the login gate engages, which is
# how an unattended run passes a human-only step; documented as such).
# =============================================================================
set -u

STATE="${1:?state a|b|c|d}"
PAIR_CODE="${2:?pair code}"
ASSISTANT_ID="${3:?assistant id}"
REPO_DIR="${4:?path to the bgos-claude-plugin checkout}"
SEED_DIR="${5:-}"

ROOT="/tmp/hoai-matrix/$STATE"
rm -rf "$ROOT"
mkdir -p "$ROOT/home"
export HOME="$ROOT/home"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"
# Only the system dirs: no user-level node/bun/claude can leak in.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export BGOS_PLUGIN_STATE_DIR="$HOME/.bgos-plugin-state"

echo "=== matrix state $STATE: HOME=$HOME"
echo "=== preconditions:"
for tool in node bun bunx claude git curl; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "    $tool: $(command -v "$tool")"
    else
        echo "    $tool: ABSENT"
    fi
done

seed_claude() {
    [ -n "$SEED_DIR" ] && [ -d "$SEED_DIR/claude-local" ] || { echo "state $STATE needs a claude seed"; exit 90; }
    mkdir -p "$HOME/.local"
    cp -a "$SEED_DIR/claude-local/." "$HOME/.local/"
    cp "$SEED_DIR/credentials.json" "$CLAUDE_CONFIG_DIR/.credentials.json"
    export PATH="$HOME/.local/bin:$PATH"
    echo "    seeded claude: $(command -v claude || echo MISSING)"
}
seed_node() {
    [ -n "$SEED_DIR" ] && [ -d "$SEED_DIR/node-lts" ] || { echo "state $STATE needs a node seed"; exit 90; }
    mkdir -p "$HOME/.local/node-lts" "$HOME/.local/bin"
    cp -a "$SEED_DIR/node-lts/." "$HOME/.local/node-lts/"
    for tool in node npm npx; do ln -sf "$HOME/.local/node-lts/bin/$tool" "$HOME/.local/bin/$tool"; done
    export PATH="$HOME/.local/bin:$PATH"
    echo "    seeded node: $(node --version 2>/dev/null || echo MISSING)"
}
seed_bun() {
    [ -n "$SEED_DIR" ] && [ -d "$SEED_DIR/bun-home" ] || { echo "state $STATE needs a bun seed"; exit 90; }
    mkdir -p "$HOME/.bun"
    cp -a "$SEED_DIR/bun-home/." "$HOME/.bun/"
    export PATH="$HOME/.bun/bin:$PATH"
    echo "    seeded bun: $(bun --version 2>/dev/null || echo MISSING)"
}

case "$STATE" in
    a) : ;;                            # nothing installed
    b) seed_claude; seed_bun ;;        # node missing
    c) seed_claude; seed_node ;;       # bun missing
    d) seed_node; seed_bun ;;          # claude missing: the login gate state
    *) echo "unknown state $STATE"; exit 90 ;;
esac

# The login gate passes only when a login appears. States a and d install
# claude fresh (never logged in), so a watcher drops a real credential file
# into the config dir ~20s after the gate engages; the bootstrap's poll then
# sees loggedIn and resumes. This is the unattended stand-in for the one
# human step, and the delay proves the gate actually WAITED.
if [ "$STATE" = "a" ] || [ "$STATE" = "d" ]; then
    [ -n "$SEED_DIR" ] && [ -f "$SEED_DIR/credentials.json" ] || { echo "state $STATE needs credentials.json in the seed dir"; exit 90; }
    (
        while true; do
            sleep 5
            if grep -q '::hoa-step::claude-login' "$ROOT/run.log" 2>/dev/null; then
                sleep 20
                mkdir -p "$CLAUDE_CONFIG_DIR"
                cp "$SEED_DIR/credentials.json" "$CLAUDE_CONFIG_DIR/.credentials.json"
                echo "[matrix] credential drop completed (login gate held for 20s+)"
                exit 0
            fi
        done
    ) &
    DROPPER=$!
fi

WORKDIR="$HOME/agent-workspace"
START=$(date +%s)
bash "$REPO_DIR/bin/hoai-bootstrap.sh" \
    --pair-code "$PAIR_CODE" \
    --assistant-id "$ASSISTANT_ID" \
    --workdir "$WORKDIR" \
    --marketplace-source "$REPO_DIR/../hoai-marketplace" \
    --tools-root "$REPO_DIR" \
    --non-interactive \
    --login-timeout-minutes 5 \
    2>&1 | tee "$ROOT/run.log"
EXIT_CODE=${PIPESTATUS[0]}
DUR=$(( $(date +%s) - START ))
[ -n "${DROPPER:-}" ] && kill "$DROPPER" 2>/dev/null

echo "=== state $STATE finished: exit=$EXIT_CODE after ${DUR}s"
echo "=== postconditions:"
for tool in node bun bunx claude; do
    echo "    $tool: $(command -v "$tool" 2>/dev/null || echo ABSENT) $($tool --version 2>/dev/null | head -1)"
done
echo "    steps: $(grep -o '::hoa-step::[a-z-]*' "$ROOT/run.log" | tr '\n' ' ')"
echo "    fails: $(grep -o '::hoa-fail::[a-z-]*' "$ROOT/run.log" | tr '\n' ' ')"
exit "$EXIT_CODE"
