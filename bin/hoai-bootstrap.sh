#!/usr/bin/env bash
# =============================================================================
# hoai-bootstrap.sh, the one-click HOAI agent bootstrap for macOS and Linux.
# The exact behavioral mirror of bin/hoai-bootstrap.ps1 (Windows).
#
# The app creates the agent first and hands this script the pair code plus the
# assistant id and chat id, so nothing is ever typed by hand. The script then:
#   1. detects prerequisites and installs ONLY the gaps (node, bun with BOTH
#      bun and bunx on PATH, Claude Code; git only for a clone install),
#   2. stops at the login gate when Claude Code has no account yet (a visible
#      terminal opens; setup resumes the moment `claude auth status` says
#      loggedIn),
#   3. installs the HOAI plugin (marketplace by default, local clone fallback),
#   4. pairs this machine as the given assistant (the folder pin lands in the
#      workspace because pairing runs from there),
#   5. runs the preflight gate (bgos-doctor --preflight): the MCP initialize
#      handshake must succeed and `claude mcp list` must read Connected before
#      this script may claim success,
#   6. pre-seeds the one-time prompts (trust folder, bypass-permissions
#      warning) so the first launch never stalls on a hidden question, drops
#      the `hoai` alias onto the PATH, and starts the agent in a visible
#      terminal.
#
# Idempotent on purpose: every step detects before it acts, so re-running the
# script after a failure (or on a machine that already has everything) is
# always safe.
#
# Sentinel protocol (shared with the HOAI desktop app's connect panel):
#   ::hoa-step::<id>    entering a phase (tools, claude-login, plugin, pair,
#                       preflight, launch, online)
#   ::hoa-fail::<why>   terminal failure, right before a nonzero exit
#   ::hoa-workdir::<p>  the resolved agent workspace
#
# macOS ships bash 3.2, so: no associative arrays, no ${var,,}, no GNU-only
# flags on coreutils. set -u only, never set -e: every command carries its
# own exit gating (|| fail <reason>), mirroring the ps1's explicit checks,
# and the EXIT trap below turns anything that still slips through into a
# ::hoa-fail::script-error instead of a silent abort.
# =============================================================================
set -u

# Exit codes: 20-31 shared with the desktop one-click script, 32+ are ours.
# (A case table because macOS bash 3.2 has no associative arrays.)
exit_code_for() {
    case "$1" in
        git-missing)        echo 20 ;;
        claude-missing)     echo 21 ;;
        bun-install)        echo 22 ;;
        plugin-install)     echo 24 ;;
        pair-failed)        echo 25 ;;
        creds-missing)      echo 27 ;;
        claude-apikey-auth) echo 28 ;;
        script-error)       echo 29 ;;
        agent-id-missing)   echo 31 ;;
        preflight-failed)   echo 32 ;;
        login-timeout)      echo 33 ;;
        node-install)       echo 34 ;;
        channel-deaf)       echo 35 ;;
        *)                  echo 29 ;;
    esac
}

step() { printf '::hoa-step::%s\n' "$1"; }
say() { printf '%s\n' "$1"; }
fail() {
    printf '::hoa-fail::%s\n' "$1"
    DONE=1
    exit "$(exit_code_for "$1")"
}

# Any exit that did not pass through fail() or the happy path still ends in a
# sentinel, never a silent abort (this is what catches a set -u trip).
DONE=0
on_exit() {
    status=$?
    if [ "$DONE" -ne 1 ] && [ "$status" -ne 0 ]; then
        say '[hoai] unexpected error; see the output above.'
        printf '::hoa-fail::%s\n' 'script-error'
        exit "$(exit_code_for script-error)"
    fi
}
trap on_exit EXIT

# --- arguments ---------------------------------------------------------------
PAIR_CODE=""
ASSISTANT_ID=""
CHAT_ID=""
BACKEND="https://api.brandgrowthos.ai/api/v1"
WORKDIR=""
INSTALL_METHOD="auto"
NO_LAUNCH=0
NON_INTERACTIVE=0
LOGIN_TIMEOUT_MINUTES=15
MARKETPLACE_SOURCE="BrandGrowthOS/hoai-marketplace"
TOOLS_ROOT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --pair-code)             PAIR_CODE="${2:-}"; shift; shift ;;
        --assistant-id)          ASSISTANT_ID="${2:-}"; shift; shift ;;
        --chat-id)               CHAT_ID="${2:-}"; shift; shift ;;
        --backend)               BACKEND="${2:-}"; shift; shift ;;
        --workdir)               WORKDIR="${2:-}"; shift; shift ;;
        --install-method)        INSTALL_METHOD="${2:-}"; shift; shift ;;
        --no-launch)             NO_LAUNCH=1; shift ;;
        --non-interactive)       NON_INTERACTIVE=1; shift ;;
        --login-timeout-minutes) LOGIN_TIMEOUT_MINUTES="${2:-}"; shift; shift ;;
        --marketplace-source)    MARKETPLACE_SOURCE="${2:-}"; shift; shift ;;
        --tools-root)            TOOLS_ROOT="${2:-}"; shift; shift ;;
        *) say "[hoai] unknown option: $1"; fail 'script-error' ;;
    esac
done

case "$INSTALL_METHOD" in
    auto|marketplace|clone) ;;
    *) say "[hoai] --install-method must be auto, marketplace, or clone (got: $INSTALL_METHOD)"; fail 'script-error' ;;
esac
case "$ASSISTANT_ID" in
    ''|*[!0-9]*) say 'The assistant id must be a number (the app supplies it).'; fail 'agent-id-missing' ;;
esac
if [ -z "$PAIR_CODE" ]; then fail 'creds-missing'; fi

# --- resolved locations ------------------------------------------------------
UNAME="$(uname)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOCAL_BIN="$HOME/.local/bin"
if [ -z "$WORKDIR" ]; then WORKDIR="$HOME/.bgos-agent/${ASSISTANT_ID}-workspace"; fi
mkdir -p "$LOCAL_BIN" "$WORKDIR" || fail 'script-error'
printf '::hoa-workdir::%s\n' "$WORKDIR"

# Prepend a directory to this process's PATH, once. (Tools installed a moment
# ago must resolve in THIS run, without a new shell.)
ensure_on_path_now() {
    case ":$PATH:" in
        *":$1:"*) ;;
        *) PATH="$1:$PATH"; export PATH ;;
    esac
}

# Refresh this process's PATH view of the standard install locations.
refresh_known_paths() {
    local dir
    for dir in "$HOME/.local/bin" "$HOME/.bun/bin"; do
        if [ -d "$dir" ]; then ensure_on_path_now "$dir"; fi
    done
}

# Make a HOME-relative directory stick on PATH for future shells. Appends an
# export line to ~/.zshrc and ~/.bashrc (whichever exist; a fresh macOS
# account may have neither, and zsh is the default login shell there, so
# ~/.zshrc gets created). Idempotent: a profile that already mentions the
# directory, however the user spelled it, is left alone.
ensure_in_profiles() {
    local rel line rc wrote_any
    rel="$1"
    line="export PATH=\"\$HOME/$rel:\$PATH\""
    wrote_any=0
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [ ! -f "$rc" ]; then continue; fi
        wrote_any=1
        if ! grep -qF "$rel" "$rc" 2>/dev/null; then
            printf '\n# added by hoai-bootstrap (keeps bun, bunx and hoai resolvable)\n%s\n' "$line" >> "$rc"
            say "[hoai] added to your PATH in $rc: \$HOME/$rel"
        fi
    done
    if [ "$wrote_any" -eq 0 ] && [ "$UNAME" = "Darwin" ]; then
        printf '# created by hoai-bootstrap\n%s\n' "$line" > "$HOME/.zshrc"
        say "[hoai] created ~/.zshrc with \$HOME/$rel on PATH"
    fi
}

# Open a visible terminal running the given shell command. Returns nonzero
# when no terminal could be opened (headless box, automation denied); the
# caller then prints manual instructions instead. The appended `exec bash`
# keeps Linux windows open after the command, like the ps1's -NoExit.
open_terminal_with() {
    if [ "$UNAME" = "Darwin" ]; then
        osascript -e "tell application \"Terminal\" to do script \"$1\"" >/dev/null 2>&1
        return $?
    fi
    if command -v x-terminal-emulator >/dev/null 2>&1; then
        x-terminal-emulator -e bash -c "$1; exec bash" >/dev/null 2>&1 &
        return 0
    fi
    if command -v gnome-terminal >/dev/null 2>&1; then
        gnome-terminal -- bash -c "$1; exec bash" >/dev/null 2>&1 &
        return 0
    fi
    if command -v konsole >/dev/null 2>&1; then
        konsole -e bash -c "$1; exec bash" >/dev/null 2>&1 &
        return 0
    fi
    if command -v xterm >/dev/null 2>&1; then
        xterm -e bash -c "$1; exec bash" >/dev/null 2>&1 &
        return 0
    fi
    return 1
}

# =============================================================================
step 'tools'
say 'Checking this computer (node, bun, Claude Code)...'
refresh_known_paths

# --- node (runs the pairing CLI, the doctor, and the plugin launch shim) -----
if ! command -v node >/dev/null 2>&1; then
    say 'Node.js is not installed yet. Installing it now (one time)...'
    if command -v brew >/dev/null 2>&1; then
        brew install node || fail 'node-install'
        refresh_known_paths
    else
        # No package manager to lean on. A system-wide install would need
        # sudo, and a bootstrap must never ask for a password; hand back the
        # one-line instruction instead.
        say 'Node.js is required. Install it from https://nodejs.org and run this script again.'
        fail 'node-install'
    fi
    command -v node >/dev/null 2>&1 || fail 'node-install'
    say "Node.js ready: $(node --version)"
else
    say "Node.js present: $(node --version)"
fi

# --- bun (the plugin's runtime; BOTH bun and bunx must be on PATH) -----------
if ! command -v bun >/dev/null 2>&1; then
    say 'Bun is not installed yet. Installing it now (one time)...'
    curl -fsSL https://bun.sh/install | bash || fail 'bun-install'
    export BUN_INSTALL="$HOME/.bun"
    ensure_on_path_now "$BUN_INSTALL/bin"
    command -v bun >/dev/null 2>&1 || fail 'bun-install'
fi

# Claude Code pins its PATH at launch, and ~/.bun/bin is often missing from
# it while ~/.local/bin is on every login shell's PATH. Link BOTH names
# there: bun launches the plugin, bunx is what the agent's tool calls spawn.
# One missing sibling is the exact Mac mini defect (bun resolved, bunx did
# not, and the agent's first tool call died with ENOENT). bun dispatches on
# argv[0], so a link named bunx pointing at the bun binary behaves as bunx.
mkdir -p "$LOCAL_BIN"
BUN_REAL="$HOME/.bun/bin/bun"
if [ ! -x "$BUN_REAL" ]; then BUN_REAL="$(command -v bun)"; fi
BUNX_REAL="$HOME/.bun/bin/bunx"
if [ ! -e "$BUNX_REAL" ]; then
    if command -v bunx >/dev/null 2>&1; then
        BUNX_REAL="$(command -v bunx)"
    else
        BUNX_REAL="$BUN_REAL"
    fi
fi
# Never link a path onto itself: when command -v resolved a previous run's
# ~/.local/bin link, relinking would turn it into a self-loop and break bun.
if [ "$BUN_REAL" != "$LOCAL_BIN/bun" ]; then
    ln -sf "$BUN_REAL" "$LOCAL_BIN/bun" || fail 'bun-install'
fi
if [ "$BUNX_REAL" != "$LOCAL_BIN/bunx" ]; then
    ln -sf "$BUNX_REAL" "$LOCAL_BIN/bunx" || fail 'bun-install'
fi
ensure_on_path_now "$LOCAL_BIN"
command -v bun >/dev/null 2>&1 || fail 'bun-install'
command -v bunx >/dev/null 2>&1 || fail 'bun-install'
say "Bun present: $(bun --version)"

# --- Claude Code -------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
    say 'Claude Code is not installed yet. Installing it now (one time)...'
    curl -fsSL https://claude.ai/install.sh | bash || fail 'claude-missing'
    # The official installer lands in ~/.local/bin; make sure this process
    # sees it without a new shell.
    refresh_known_paths
    command -v claude >/dev/null 2>&1 || fail 'claude-missing'
fi
say "Claude Code present: $(claude --version 2>/dev/null | head -n 1)"

# API-key auth silently drops inbound channel messages; say so before pairing.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    say '[hoai] warning: ANTHROPIC_API_KEY is set. The HOAI channel needs a Claude subscription login (claude auth login), not API-key auth.'
fi

# The agent will be launched from a fresh terminal, so the PATH additions
# must survive this process too.
ensure_in_profiles ".local/bin"
if [ -d "$HOME/.bun/bin" ]; then ensure_in_profiles ".bun/bin"; fi

# =============================================================================
# The login gate: the ONE human step. Only reached when Claude Code has no
# logged-in account; otherwise setup flows straight through.
# =============================================================================

# True when `claude auth status --json` reports loggedIn. The CLI may print
# human lines before the JSON, so the parser finds the first '{' itself.
auth_logged_in() {
    claude auth status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => { d += c; });
        process.stdin.on("end", () => {
            const at = d.indexOf("{");
            if (at < 0) process.exit(1);
            let parsed;
            try { parsed = JSON.parse(d.slice(at)); } catch (e) { process.exit(1); }
            process.exit(parsed && parsed.loggedIn ? 0 : 1);
        });
    ' 2>/dev/null
}

# Prints the auth method ("claude.ai", "apiKey", ...) or nothing at all.
auth_method() {
    claude auth status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => { d += c; });
        process.stdin.on("end", () => {
            const at = d.indexOf("{");
            if (at < 0) return;
            let parsed;
            try { parsed = JSON.parse(d.slice(at)); } catch (e) { return; }
            if (parsed && parsed.authMethod) process.stdout.write(String(parsed.authMethod));
        });
    ' 2>/dev/null
}

LOGGED_IN=0
if auth_logged_in; then LOGGED_IN=1; fi
if [ "$LOGGED_IN" -ne 1 ]; then
    step 'claude-login'
    say 'Claude Code needs you to sign in (this is the one step setup cannot do for you).'
    if [ "$NON_INTERACTIVE" -ne 1 ]; then
        if open_terminal_with 'claude auth login --claudeai'; then
            say 'A terminal window is opening. Follow the sign-in link it shows, then come back here; setup resumes by itself.'
        else
            say 'Could not open a terminal window automatically. In another terminal, run: claude auth login --claudeai'
            say 'Setup keeps waiting here and resumes as soon as the login lands.'
        fi
    else
        say 'Non-interactive mode: waiting for a login to appear (complete `claude auth login` on this machine).'
    fi
    WAITED=0
    LIMIT=$((LOGIN_TIMEOUT_MINUTES * 60))
    while [ "$WAITED" -lt "$LIMIT" ]; do
        sleep 5
        WAITED=$((WAITED + 5))
        if auth_logged_in; then LOGGED_IN=1; break; fi
    done
    if [ "$LOGGED_IN" -ne 1 ]; then
        say "No login appeared within $LOGIN_TIMEOUT_MINUTES minutes."
        fail 'login-timeout'
    fi
    say 'Signed in.'
fi
AUTH_METHOD="$(auth_method)"
if [ -n "$AUTH_METHOD" ] && [ "$AUTH_METHOD" != "claude.ai" ]; then
    say "[hoai] warning: Claude Code auth method is \"$AUTH_METHOD\", not a claude.ai subscription login. Inbound chat messages will NOT reach the agent until you run: claude auth login --claudeai"
fi

# =============================================================================
step 'plugin'
RESOLVED_METHOD="$INSTALL_METHOD"
if [ "$RESOLVED_METHOD" = "auto" ]; then RESOLVED_METHOD="marketplace"; fi
PLUGIN_ROOT=""

if [ "$RESOLVED_METHOD" = "marketplace" ]; then
    say 'Installing the HOAI plugin from the Claude Code marketplace...'
    if ! claude plugin marketplace add "$MARKETPLACE_SOURCE"; then
        # Idempotency: an already-added marketplace can refuse the re-add.
        claude plugin marketplace update hoai
    fi
    if ! claude plugin install hoai@hoai; then
        # Already installed is fine; anything else is not. `claude plugin list`
        # decides which one this was.
        LIST_OUT="$(claude plugin list 2>/dev/null)"
        case "$LIST_OUT" in
            *hoai*) ;;
            *) fail 'plugin-install' ;;
        esac
    fi
    CACHE_ROOT="$CONFIG_DIR/plugins/cache/hoai/hoai"
    # Newest version directory by name, like the ps1's Sort Name -Descending:
    # the glob expands ascending, so the last hit wins.
    if [ -d "$CACHE_ROOT" ]; then
        for d in "$CACHE_ROOT"/*; do
            if [ -d "$d" ]; then PLUGIN_ROOT="$d"; fi
        done
    fi
    if [ -z "$PLUGIN_ROOT" ] || [ ! -d "$PLUGIN_ROOT" ]; then
        say "[hoai] could not locate the installed plugin under $CACHE_ROOT"
        fail 'plugin-install'
    fi
else
    if ! command -v git >/dev/null 2>&1; then
        say 'git is required for a clone install. Install it (xcode-select --install on macOS, or your package manager) or use the marketplace method.'
        fail 'git-missing'
    fi
    PLUGIN_ROOT="$HOME/bgos-claude-plugin"
    if [ ! -f "$PLUGIN_ROOT/server.ts" ]; then
        say "Cloning the HOAI plugin to $PLUGIN_ROOT"
        git clone --depth 1 https://github.com/BrandGrowthOS/bgos-claude-plugin.git "$PLUGIN_ROOT" || fail 'plugin-install'
    fi
    say 'Installing plugin dependencies (bun install)...'
    ( cd "$PLUGIN_ROOT" && bun install --no-summary ) \
        || say '[hoai] bun install reported an issue (continuing; the preflight below decides)'
    # The workspace .mcp.json launches the node shim, never bare bun. JSON via
    # node + JSON.stringify with the values passed as env vars (no shell/JSON
    # interpolation), so a path or URL with special characters cannot corrupt
    # or inject into the config. Same pattern as bin/bgos-agent.
    HOA_PLUGIN="$PLUGIN_ROOT" HOA_BACKEND="$BACKEND" node -e '
        const e = process.env;
        const path = require("path");
        const cfg = { mcpServers: { bgos: {
            command: "node",
            args: [path.join(e.HOA_PLUGIN, "bin", "bgos-launch.mjs"), path.join(e.HOA_PLUGIN, "server.ts")],
            env: { BGOS_BACKEND_URL: e.HOA_BACKEND, BGOS_AUTO_APPROVE: "true" }
        } } };
        process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    ' > "$WORKDIR/.mcp.json" || fail 'plugin-install'
    say "Wrote $WORKDIR/.mcp.json"
fi
say "Plugin ready at $PLUGIN_ROOT ($RESOLVED_METHOD install)"

# --- the hoai alias ----------------------------------------------------------
# A symlink is enough here: bin/hoai resolves its own directory THROUGH
# symlinks, so a ~/.local/bin/hoai link still finds the real checkout and
# needs no hoai-plugin-root.txt breadcrumb (that file is for copied installs).
if [ -f "$PLUGIN_ROOT/bin/hoai" ]; then
    chmod +x "$PLUGIN_ROOT/bin/hoai" 2>/dev/null
    if [ "$PLUGIN_ROOT/bin/hoai" != "$LOCAL_BIN/hoai" ]; then
        ln -sf "$PLUGIN_ROOT/bin/hoai" "$LOCAL_BIN/hoai"
    fi
else
    say "[hoai] warning: $PLUGIN_ROOT/bin/hoai not found; the hoai command will not be on PATH."
fi
ensure_on_path_now "$LOCAL_BIN"

# --- CLAUDE.md stub (the agent's standing instructions) ----------------------
if [ ! -f "$WORKDIR/CLAUDE.md" ]; then
    cat > "$WORKDIR/CLAUDE.md" <<'MD'
## HOAI (BGOS) plugin

You are connected to the HOAI chat app via the `bgos` MCP plugin. Messages
from the user (and other agents) arrive as `<channel source="bgos">` events.

- Always answer the user through the `reply` tool; plain terminal output
  never reaches their chat.
- For peer-agent messages (meta carries `peer_conversation_id` or
  `turn_state`), use `send_to_peer`, not `reply`.

See the plugin README Step 5 for the full peer-tool guidance.
MD
fi
case "$CHAT_ID" in
    ''|*[!0-9]*) ;;
    *) printf '%s\n' "$CHAT_ID" > "$WORKDIR/.bgos-chat-id" ;;
esac

# =============================================================================
step 'pair'
say "Pairing this computer as assistant $ASSISTANT_ID..."
[ -n "$TOOLS_ROOT" ] || TOOLS_ROOT="$PLUGIN_ROOT"
( cd "$WORKDIR" && node "$TOOLS_ROOT/bin/bgos-pair.mjs" "$PAIR_CODE" --assistant-id "$ASSISTANT_ID" --backend "$BACKEND" )
PAIR_EXIT=$?
if [ "$PAIR_EXIT" -eq 3 ]; then
    # Paired but the mirror probe wants an env pin. Pairing ran from the
    # workspace, so the folder pin (.bgos-agent-id) is what the daemon
    # actually resolves; verify both anchors exist and let the preflight
    # prove the result instead of failing a pairing that works.
    if [ -f "$WORKDIR/.bgos-agent-id" ] && [ -f "$HOME/.bgos-agent/credentials-$ASSISTANT_ID.json" ]; then
        say '[hoai] pairing wrote the folder pin + per-assistant credentials; the preflight below is the proof.'
    else
        fail 'pair-failed'
    fi
elif [ "$PAIR_EXIT" -ne 0 ]; then
    fail 'pair-failed'
fi

# =============================================================================
step 'preflight'
say 'Verifying the launch end to end before claiming success...'
# Pre-seed the one-time prompts FIRST so the mcp-list probe (and the real
# launch) never stall on a hidden question:
#   .claude.json  projects[<workdir>].hasTrustDialogAccepted (trust dialog)
#                 hasCompletedOnboarding + theme (first-run wizard)
#   settings.json skipDangerousModePermissionPrompt (bypass warning, whose
#                 DEFAULT answer is exit, so it must never be blind-Entered)
# The heredoc delimiter is quoted so nothing in the script expands here.
# Run from a file, argv[0] is node and argv[1] is the script path, so the
# real arguments start at index 2.
PRESEED_JS="${TMPDIR:-/tmp}/hoai-preseed.js"
cat > "$PRESEED_JS" <<'JS'
const fs = require("fs");
const path = require("path");
const [configDir, workdir] = process.argv.slice(2);
function load(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } }
const cfgPath = path.join(configDir, ".claude.json");
const cfg = load(cfgPath);
if (cfg.hasCompletedOnboarding === undefined) cfg.hasCompletedOnboarding = true;
if (cfg.theme === undefined) cfg.theme = "dark";
cfg.projects = cfg.projects || {};
// The FULL entry shape Claude Code itself writes on a real trust accept. A
// minimal {hasTrustDialogAccepted:true} entry is NOT honoured (verified live
// 2026-08-22 on 2.1.239: the dialog still rendered until the sibling fields
// existed), and the key must match process.cwd() byte for byte.
function seed(key) {
  const existing = cfg.projects[key] || {};
  cfg.projects[key] = Object.assign({
    allowedTools: [],
    disabledMcpjsonServers: [],
    enabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    mcpContextUris: [],
    projectOnboardingSeenCount: 1,
    hasCompletedProjectOnboarding: true,
  }, existing, { hasTrustDialogAccepted: true });
}
seed(workdir);
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const setPath = path.join(configDir, "settings.json");
const settings = load(setPath);
settings.skipDangerousModePermissionPrompt = true;
fs.writeFileSync(setPath, JSON.stringify(settings, null, 2));
console.log("[hoai] pre-seeded trust + prompt acceptance for " + workdir);
JS
node "$PRESEED_JS" "$CONFIG_DIR" "$WORKDIR" \
    || say '[hoai] warning: prompt pre-seed failed; the first launch may stop on a one-time question.'

if ! node "$TOOLS_ROOT/bin/bgos-doctor.mjs" --preflight --assistant-id "$ASSISTANT_ID" --workdir "$WORKDIR" --backend "$BACKEND"; then
    say 'Preflight FAILED. The table above names the broken piece and its fix command.'
    fail 'preflight-failed'
fi
say 'Preflight passed: MCP handshake ok, channel Connected.'

# =============================================================================
step 'launch'
if [ "$NO_LAUNCH" -eq 1 ] || [ "$NON_INTERACTIVE" -eq 1 ]; then
    say 'Skipping launch. Start the agent any time:'
    say "  cd \"$WORKDIR\" && hoai"
    step 'online'
    say "Done (not launched). Your agent (assistant $ASSISTANT_ID) is paired and preflight-verified."
    say "  workspace : $WORKDIR"
    DONE=1
    exit 0
fi
# Epoch ms of the launch instant, for the channel-live wait below. macOS date
# has no %N; node is already a hard prerequisite, so ask it.
LAUNCH_EPOCH_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
say 'Starting your agent in a new window...'
if ! open_terminal_with "cd '$WORKDIR' && hoai"; then
    say 'Could not open a terminal window automatically. Start the agent yourself:'
    say "  cd \"$WORKDIR\" && hoai"
fi

step 'online'
# The last gate, and the one Connected cannot fake: on a first-ever pairing
# the daemon asks the session to greet the user (boot hello), the greeting's
# tool call writes the channel-live marker, and setup only claims success
# once that marker is touched AFTER this launch. A wrong channel flag loads
# the plugin, connects, and still drops every message; this catches exactly
# that (Vulcan E2E, 2026-08-22).
say 'Waiting for your agent to say hello in the app (the end-to-end channel proof)...'
if ! node "$TOOLS_ROOT/bin/bgos-doctor.mjs" --wait-live-since "$LAUNCH_EPOCH_MS" --wait-live-timeout 150 --assistant-id "$ASSISTANT_ID" --workdir "$WORKDIR"; then
    say 'The agent started but never proved it can hear the channel. Run: hoai doctor'
    fail 'channel-deaf'
fi
say ''
say "Done. Your agent (assistant $ASSISTANT_ID) is live on this computer and answered in the app."
say "  workspace : $WORKDIR"
say '  trouble?  : open that folder and run: hoai doctor'
DONE=1
exit 0
