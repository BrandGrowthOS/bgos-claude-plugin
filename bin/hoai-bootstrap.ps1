# =============================================================================
# hoai-bootstrap.ps1, the one-click HOAI agent bootstrap for Windows.
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
# Windows PowerShell 5.1 compatible: no &&, no ternaries, ASCII only.
# =============================================================================
param(
    [Parameter(Mandatory = $true)][string]$PairCode,
    [Parameter(Mandatory = $true)][string]$AssistantId,
    [string]$ChatId = "",
    [string]$Backend = "https://api.brandgrowthos.ai/api/v1",
    [string]$Workdir = "",
    [ValidateSet("auto", "marketplace", "clone")][string]$InstallMethod = "auto",
    [switch]$NoLaunch,
    [switch]$NonInteractive,
    [int]$LoginTimeoutMinutes = 15
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Exit codes: 20-31 shared with the desktop one-click script, 32+ are ours.
$EXIT = @{
    'git-missing'      = 20
    'claude-missing'   = 21
    'bun-install'      = 22
    'plugin-install'   = 24
    'pair-failed'      = 25
    'creds-missing'    = 27
    'claude-apikey-auth' = 28
    'script-error'     = 29
    'agent-id-missing' = 31
    'preflight-failed' = 32
    'login-timeout'    = 33
    'node-install'     = 34
}

function Step { param([string]$Name) [Console]::Out.WriteLine('::hoa-step::' + $Name); [Console]::Out.Flush() }
function Say { param([string]$Text) [Console]::Out.WriteLine($Text); [Console]::Out.Flush() }
function Fail {
    param([string]$Reason)
    if ($Error.Count -gt 0) { [Console]::Out.WriteLine('[hoai] last error: ' + $Error[0].ToString()) }
    [Console]::Out.WriteLine('::hoa-fail::' + $Reason)
    [Console]::Out.Flush()
    exit $EXIT[$Reason]
}
function Has { param([string]$Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Any terminating error still ends in a sentinel, never a silent abort.
trap {
    [Console]::Out.WriteLine('[hoai] unexpected: ' + $_.Exception.Message)
    [Console]::Out.WriteLine('::hoa-fail::script-error')
    [Console]::Out.Flush()
    exit $EXIT['script-error']
}

# Old Windows PowerShell defaults to TLS 1.0, which the installer endpoints
# refuse. Best effort, never fatal.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# --- resolved locations ------------------------------------------------------
$HoaiRoot = Join-Path $env:LOCALAPPDATA 'hoai'
$HoaiBin = Join-Path $HoaiRoot 'bin'
$ClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
if (-not $ClaudeConfigDir) { $ClaudeConfigDir = Join-Path $env:USERPROFILE '.claude' }
if (-not $Workdir) { $Workdir = Join-Path $env:USERPROFILE ('.bgos-agent\' + $AssistantId + '-workspace') }
New-Item -ItemType Directory -Force -Path $HoaiBin | Out-Null
New-Item -ItemType Directory -Force -Path $Workdir | Out-Null
[Console]::Out.WriteLine('::hoa-workdir::' + $Workdir)

if ($AssistantId -notmatch '^[0-9]+$') { Say 'The assistant id must be a number (the app supplies it).'; Fail 'agent-id-missing' }
if (-not $PairCode) { Fail 'creds-missing' }

# Prepend a directory to the User PATH (registry) and this process, once.
function Ensure-OnPath {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return }
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $current) { $current = '' }
    $parts = $current -split ';' | Where-Object { $_ -ne '' }
    $already = $false
    foreach ($p in $parts) { if ($p.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { $already = $true } }
    if (-not $already) {
        [Environment]::SetEnvironmentVariable('Path', ($Dir + ';' + $current), 'User')
        Say ('[hoai] added to your PATH: ' + $Dir)
    }
    if (($env:Path -split ';') -notcontains $Dir) { $env:Path = $Dir + ';' + $env:Path }
}

# Refresh this process's PATH view of the standard install locations, so tools
# installed a moment ago resolve without a new shell.
function Refresh-KnownPaths {
    $known = @(
        (Join-Path $env:USERPROFILE '.bun\bin'),
        (Join-Path $env:USERPROFILE '.local\bin'),
        (Join-Path $HoaiRoot 'node'),
        $HoaiBin
    )
    foreach ($dir in $known) {
        if ((Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = $dir + ';' + $env:Path }
    }
}

# =============================================================================
Step 'tools'
Say 'Checking this computer (node, bun, Claude Code)...'
Refresh-KnownPaths

# --- node (runs the pairing CLI, the doctor, and the plugin launch shim) -----
if (-not (Has 'node')) {
    Say 'Node.js is not installed yet. Installing it now (one time)...'
    $nodeInstalled = $false
    if (Has 'winget') {
        $global:LASTEXITCODE = 1
        & winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) { $nodeInstalled = $true }
        Refresh-KnownPaths
        # winget installs machine-wide into Program Files; a new process sees
        # it, this one may not. Probe the usual home.
        $pf = Join-Path $env:ProgramFiles 'nodejs'
        if ((Test-Path (Join-Path $pf 'node.exe')) -and (($env:Path -split ';') -notcontains $pf)) { $env:Path = $pf + ';' + $env:Path }
    }
    if (-not (Has 'node')) {
        # Direct zip fallback: official dist index, latest LTS, win-x64.
        try {
            $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -ErrorAction Stop
            $lts = $null
            foreach ($entry in $index) { if ($entry.lts -and (-not $lts)) { $lts = $entry } }
            if (-not $lts) { Fail 'node-install' }
            $ver = $lts.version
            $zipUrl = 'https://nodejs.org/dist/' + $ver + '/node-' + $ver + '-win-x64.zip'
            $zipPath = Join-Path $env:TEMP ('hoai-node-' + $ver + '.zip')
            Say ('Downloading ' + $zipUrl)
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
            $extractDir = Join-Path $env:TEMP ('hoai-node-extract')
            if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
            $inner = Get-ChildItem $extractDir -Directory | Select-Object -First 1
            $nodeDir = Join-Path $HoaiRoot 'node'
            if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
            Move-Item $inner.FullName $nodeDir
            Ensure-OnPath $nodeDir
            $nodeInstalled = $true
        } catch {
            Say ('[hoai] node zip install failed: ' + $_.Exception.Message)
            Fail 'node-install'
        }
    }
    if (-not (Has 'node')) { Fail 'node-install' }
    Say ('Node.js ready: ' + (& node --version))
} else {
    Say ('Node.js present: ' + (& node --version))
}

# --- bun (the plugin's runtime; BOTH bun and bunx must be on PATH) -----------
if (-not (Has 'bun')) {
    Say 'Bun is not installed yet. Installing it now (one time)...'
    try {
        # Child scope so the installer's $ErrorActionPreference = "Stop" and
        # other globals cannot leak into this script.
        & ([scriptblock]::Create((Invoke-RestMethod 'https://bun.sh/install.ps1' -ErrorAction Stop)))
    } catch {
        Say ('[hoai] bun installer failed: ' + $_.Exception.Message)
        Fail 'bun-install'
    }
    $ErrorActionPreference = 'Continue'
    Refresh-KnownPaths
    if (-not (Has 'bun')) { Fail 'bun-install' }
}
# The Windows installer ships bun.exe AND bunx.exe side by side, but Claude
# Code pins its PATH at launch, so both names must resolve from the User PATH
# BEFORE the agent ever starts. This is the fix for the bare-bun ENOENT.
$bunDir = Split-Path -Parent (Get-Command 'bun').Source
Ensure-OnPath $bunDir
$bunxPath = Join-Path $bunDir 'bunx.exe'
if (-not (Test-Path $bunxPath)) {
    # Restore the missing sibling: bunx is byte-identical to bun.
    try { Copy-Item (Get-Command 'bun').Source $bunxPath -Force } catch { }
}
if (-not (Has 'bunx')) { Say '[hoai] warning: bunx still does not resolve on PATH; the doctor will flag this.' }
Say ('Bun present: ' + (& bun --version))

# --- Claude Code -------------------------------------------------------------
$claudeWasJustInstalled = $false
if (-not (Has 'claude')) {
    Say 'Claude Code is not installed yet. Installing it now (one time)...'
    try {
        & ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1' -ErrorAction Stop)))
    } catch {
        Say ('[hoai] claude installer failed: ' + $_.Exception.Message)
        Fail 'claude-missing'
    }
    $ErrorActionPreference = 'Continue'
    $claudeWasJustInstalled = $true
    Refresh-KnownPaths
    if (-not (Has 'claude')) { Fail 'claude-missing' }
}
Say ('Claude Code present: ' + ((& claude --version) | Select-Object -First 1))

# API-key auth silently drops inbound channel messages; say so before pairing.
if ($env:ANTHROPIC_API_KEY) { Say '[hoai] warning: ANTHROPIC_API_KEY is set. The HOAI channel needs a Claude subscription login (claude auth login), not API-key auth.' }

# =============================================================================
# The login gate: the ONE human step. Only reached when Claude Code has no
# logged-in account; otherwise setup flows straight through.
# =============================================================================
function Get-AuthStatus {
    $raw = ''
    try { $raw = (& claude auth status --json 2>$null | Out-String) } catch { return $null }
    $jsonStart = $raw.IndexOf('{')
    if ($jsonStart -lt 0) { return $null }
    try { return ($raw.Substring($jsonStart) | ConvertFrom-Json) } catch { return $null }
}

$auth = Get-AuthStatus
$loggedIn = $false
if ($auth -and $auth.loggedIn) { $loggedIn = $true }
if (-not $loggedIn) {
    Step 'claude-login'
    Say 'Claude Code needs you to sign in (this is the one step setup cannot do for you).'
    if (-not $NonInteractive) {
        Say 'A terminal window is opening. Follow the sign-in link it shows, then come back here; setup resumes by itself.'
        Start-Process powershell -ArgumentList '-NoExit', '-Command', 'claude auth login --claudeai'
    } else {
        Say 'NonInteractive mode: waiting for a login to appear (complete `claude auth login` on this machine).'
    }
    $deadline = (Get-Date).AddMinutes($LoginTimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $auth = Get-AuthStatus
        if ($auth -and $auth.loggedIn) { $loggedIn = $true; break }
    }
    if (-not $loggedIn) { Say ('No login appeared within ' + $LoginTimeoutMinutes + ' minutes.'); Fail 'login-timeout' }
    Say 'Signed in.'
}
if ($auth -and $auth.authMethod -and ($auth.authMethod -ne 'claude.ai')) {
    Say ('[hoai] warning: Claude Code auth method is "' + $auth.authMethod + '", not a claude.ai subscription login. Inbound chat messages will NOT reach the agent until you run: claude auth login --claudeai')
}

# =============================================================================
Step 'plugin'
$ResolvedMethod = $InstallMethod
if ($ResolvedMethod -eq 'auto') { $ResolvedMethod = 'marketplace' }
$PluginRoot = ''

if ($ResolvedMethod -eq 'marketplace') {
    Say 'Installing the HOAI plugin from the Claude Code marketplace...'
    $global:LASTEXITCODE = 1
    & claude plugin marketplace add BrandGrowthOS/hoai-marketplace
    if ($LASTEXITCODE -ne 0) {
        # Idempotency: an already-added marketplace can refuse the re-add.
        & claude plugin marketplace update hoai
    }
    $global:LASTEXITCODE = 1
    & claude plugin install hoai@hoai
    if ($LASTEXITCODE -ne 0) {
        # Already installed is fine; anything else is not. `claude plugin list`
        # decides which one this was.
        $listOut = (& claude plugin list 2>$null | Out-String)
        if ($listOut -notmatch 'hoai') { Fail 'plugin-install' }
    }
    $cacheRoot = Join-Path $ClaudeConfigDir 'plugins\cache\hoai\hoai'
    if (Test-Path $cacheRoot) {
        $newest = Get-ChildItem $cacheRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($newest) { $PluginRoot = $newest.FullName }
    }
    if (-not $PluginRoot) { Say ('[hoai] could not locate the installed plugin under ' + $cacheRoot); Fail 'plugin-install' }
} else {
    if (-not (Has 'git')) {
        Say 'git is required for a clone install. Install Git for Windows (https://git-scm.com/download/win) or use the marketplace method.'
        Fail 'git-missing'
    }
    $PluginRoot = Join-Path $env:USERPROFILE 'bgos-claude-plugin'
    if (-not (Test-Path (Join-Path $PluginRoot 'server.ts'))) {
        Say ('Cloning the HOAI plugin to ' + $PluginRoot)
        $global:LASTEXITCODE = 1
        & git clone --depth 1 https://github.com/BrandGrowthOS/bgos-claude-plugin.git $PluginRoot
        if ($LASTEXITCODE -ne 0) { Fail 'plugin-install' }
    }
    Say 'Installing plugin dependencies (bun install)...'
    Push-Location $PluginRoot
    & bun install --no-summary
    Pop-Location
    # The workspace .mcp.json launches the node shim, never bare bun.
    $mcpConfig = @{
        mcpServers = @{
            bgos = @{
                command = 'node'
                args = @((Join-Path $PluginRoot 'bin\bgos-launch.mjs'), (Join-Path $PluginRoot 'server.ts'))
                env = @{ BGOS_BACKEND_URL = $Backend; BGOS_AUTO_APPROVE = 'true' }
            }
        }
    }
    $mcpPath = Join-Path $Workdir '.mcp.json'
    ($mcpConfig | ConvertTo-Json -Depth 6) | Out-File -FilePath $mcpPath -Encoding utf8
    Say ('Wrote ' + $mcpPath)
}
Say ('Plugin ready at ' + $PluginRoot + ' (' + $ResolvedMethod + ' install)')

# --- the hoai alias ----------------------------------------------------------
foreach ($aliasFile in @('hoai.ps1', 'hoai.cmd')) {
    $src = Join-Path $PluginRoot ('bin\' + $aliasFile)
    if (Test-Path $src) { Copy-Item $src (Join-Path $HoaiBin $aliasFile) -Force }
}
# The alias needs to find the plugin + core script no matter where it runs.
('' + $PluginRoot) | Out-File -FilePath (Join-Path $HoaiBin 'hoai-plugin-root.txt') -Encoding ascii
Ensure-OnPath $HoaiBin

# --- CLAUDE.md stub (the agent's standing instructions) ----------------------
$claudeMd = Join-Path $Workdir 'CLAUDE.md'
if (-not (Test-Path $claudeMd)) {
    $stub = @(
        '## HOAI (BGOS) plugin',
        '',
        'You are connected to the HOAI chat app via the `bgos` MCP plugin. Messages',
        'from the user (and other agents) arrive as `<channel source="bgos">` events.',
        '',
        '- Always answer the user through the `reply` tool; plain terminal output',
        '  never reaches their chat.',
        '- For peer-agent messages (meta carries `peer_conversation_id` or',
        '  `turn_state`), use `send_to_peer`, not `reply`.',
        '',
        'See the plugin README Step 5 for the full peer-tool guidance.'
    )
    $stub -join [Environment]::NewLine | Out-File -FilePath $claudeMd -Encoding utf8
}
if ($ChatId -match '^[0-9]+$') {
    ('' + $ChatId) | Out-File -FilePath (Join-Path $Workdir '.bgos-chat-id') -Encoding ascii
}

# =============================================================================
Step 'pair'
Say ('Pairing this computer as assistant ' + $AssistantId + '...')
Push-Location $Workdir
$global:LASTEXITCODE = 1
& node (Join-Path $PluginRoot 'bin\bgos-pair.mjs') $PairCode --assistant-id $AssistantId --backend $Backend
$pairExit = $LASTEXITCODE
Pop-Location
if ($pairExit -eq 3) {
    # Paired but the mirror probe wants an env pin. Pairing ran from the
    # workspace, so the folder pin (.bgos-agent-id) is what the daemon
    # actually resolves; verify both anchors exist and let the preflight
    # prove the result instead of failing a pairing that works.
    $pinOk = Test-Path (Join-Path $Workdir '.bgos-agent-id')
    $credsOk = Test-Path (Join-Path $env:USERPROFILE ('.bgos-agent\credentials-' + $AssistantId + '.json'))
    if ($pinOk -and $credsOk) {
        Say '[hoai] pairing wrote the folder pin + per-assistant credentials; the preflight below is the proof.'
    } else {
        Fail 'pair-failed'
    }
} elseif ($pairExit -ne 0) {
    Fail 'pair-failed'
}

# =============================================================================
Step 'preflight'
Say 'Verifying the launch end to end before claiming success...'
# Pre-seed the one-time prompts FIRST so the mcp-list probe (and the real
# launch) never stall on a hidden question:
#   .claude.json  projects[<workdir>].hasTrustDialogAccepted (trust dialog)
#                 hasCompletedOnboarding + theme (first-run wizard)
#   settings.json skipDangerousModePermissionPrompt (bypass warning, whose
#                 DEFAULT answer is exit, so it must never be blind-Entered)
$preseed = @'
const fs = require("fs");
const path = require("path");
const [configDir, workdir] = process.argv.slice(1);
function load(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } }
const cfgPath = path.join(configDir, ".claude.json");
const cfg = load(cfgPath);
if (cfg.hasCompletedOnboarding === undefined) cfg.hasCompletedOnboarding = true;
if (cfg.theme === undefined) cfg.theme = "dark";
cfg.projects = cfg.projects || {};
const existing = cfg.projects[workdir] || {};
existing.hasTrustDialogAccepted = true;
if (existing.hasCompletedProjectOnboarding === undefined) existing.hasCompletedProjectOnboarding = true;
cfg.projects[workdir] = existing;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const setPath = path.join(configDir, "settings.json");
const settings = load(setPath);
settings.skipDangerousModePermissionPrompt = true;
fs.writeFileSync(setPath, JSON.stringify(settings, null, 2));
console.log("[hoai] pre-seeded trust + prompt acceptance for " + workdir);
'@
$preseedPath = Join-Path $env:TEMP 'hoai-preseed.js'
$preseed | Out-File -FilePath $preseedPath -Encoding utf8
& node $preseedPath $ClaudeConfigDir $Workdir

$global:LASTEXITCODE = 1
& node (Join-Path $PluginRoot 'bin\bgos-doctor.mjs') --preflight --assistant-id $AssistantId --workdir $Workdir --backend $Backend
if ($LASTEXITCODE -ne 0) {
    Say 'Preflight FAILED. The table above names the broken piece and its fix command.'
    Fail 'preflight-failed'
}
Say 'Preflight passed: MCP handshake ok, channel Connected.'

# =============================================================================
Step 'launch'
if ($NoLaunch) {
    Say 'Skipping launch (-NoLaunch). Start the agent any time: open the folder, run hoai.'
} else {
    Say 'Starting your agent in a new window...'
    $hoaiCmd = Join-Path $HoaiBin 'hoai.cmd'
    if (Test-Path $hoaiCmd) {
        Start-Process cmd -WorkingDirectory $Workdir -ArgumentList '/k', $hoaiCmd
    } else {
        Start-Process powershell -WorkingDirectory $Workdir -ArgumentList '-NoExit', '-Command', 'hoai'
    }
}

Step 'online'
Say ''
Say ('Done. Your agent (assistant ' + $AssistantId + ') is paired and verified on this computer.')
Say ('  workspace : ' + $Workdir)
Say '  trouble?  : open that folder and run: hoai doctor'
Say 'The HOAI app flips to Connected the moment the agent reports in.'
exit 0
