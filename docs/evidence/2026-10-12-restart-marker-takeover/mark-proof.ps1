# mark-proof.ps1: read-only checks around ONE restart marker write, for one agent.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\mark-proof.ps1 -Id 909
#
# It reads plain state files, logs and the process table, writes exactly one
# file (the marker, ASCII, with a new timestamp), and never starts, stops or
# signals anything. It never opens a credentials file. Everything it prints is
# also saved to %TEMP%\hoai-marker-proof-<id>-<time>.txt.
#
# Before the fix (daemon 0.67.5) it shows the cause: the launcher spent its
# 3 marker relaunches per hour and ignores markers for good. After the fix
# (daemon 0.68.3 or later, agent restarted once onto it) it shows the daemon's
# takeover bringing the agent back on the same session.
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [int]$WatchSeconds = 120
)
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:USERPROFILE '.bgos-agent'
$st = Join-Path $root $Id
$log = Join-Path $root "logs\bgos-plugin-$Id.log"
$wlog = Join-Path $root 'watcher\logs\watcher.log'
$wstate = Join-Path $root 'watcher\keepalive-state.json'
$marker = Join-Path $st 'restart-requested.json'
$out = Join-Path $env:TEMP ("hoai-marker-proof-$Id-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
function Say([string]$s) { $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $s; Write-Output $line; Add-Content -Path $out -Value $line }
function Proc([int]$p) { Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue }
function Kids([int]$p) { @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(claude|node|cmd)\.exe$' }) }
function Json([string]$path) { if (Test-Path $path) { try { Get-Content $path -Raw | ConvertFrom-Json } catch { $null } } else { $null } }
function LinesSince([string]$path, [string]$pattern, [datetime]$sinceUtc) {
  if (-not (Test-Path $path)) { return @() }
  @(Select-String -Path $path -Pattern $pattern | Where-Object { $_.Line -match '^(\S+Z) ' -and [datetime]::Parse($Matches[1]).ToUniversalTime() -ge $sinceUtc } | ForEach-Object { $_.Line })
}
function Boots([datetime]$sinceUtc) { @(LinesSince $log '\[bgos\] Starting BGOS channel plugin' $sinceUtc) }

Say "agent $Id, state folder $st"

# 0. Which code runs. The takeover exists only in a daemon that logged 'restart takeover: armed' after its own start.
$lastStart = Select-String -Path $log -Pattern '\[bgos\] Starting BGOS channel plugin' -ErrorAction SilentlyContinue | Select-Object -Last 1
$lastArmed = Select-String -Path $log -Pattern 'restart takeover: armed' -ErrorAction SilentlyContinue | Select-Object -Last 1
$version = Select-String -Path $log -Pattern 'version heartbeat armed \((v[^,]+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
if ($version) { Say ("running daemon: " + $version.Matches[0].Groups[1].Value) }
$takeover = $lastStart -and $lastArmed -and $lastArmed.LineNumber -gt $lastStart.LineNumber
Say ("restart takeover in the running daemon: " + $(if ($takeover) { 'YES (fix loaded)' } else { 'no (0.67.x or earlier: this run shows the cause)' }))

# 1. Who supervises this agent, and since when.
$sup = Json "$st\supervisor.json"
if ($sup) { Say "supervisor.json: launcher pid $($sup.pid), startedAt $($sup.startedAt)" } else { Say 'supervisor.json: ABSENT (no live hoai launcher declared; a marker is then read by nobody)' }
$launcher = if ($sup) { Proc $sup.pid } else { $null }
if ($launcher) { Say "launcher pid $($launcher.ProcessId) alive since $($launcher.CreationDate): $($launcher.CommandLine)" } elseif ($sup) { Say "launcher pid $($sup.pid) is NOT running" }
$rec = Json "$st\launch.json"
if ($rec) { Say "launch.json (rewritten before every claude launch): startedAt $($rec.startedAt)" }
$pin = if (Test-Path "$st\session-id") { (Get-Content "$st\session-id" -Raw).Trim() } else { '' }
Say "session-id (the pinned session every restart resumes): $pin"
$before = if ($launcher) { Kids $launcher.ProcessId } else { @() }
foreach ($k in $before) { Say "launcher child: pid $($k.ProcessId) $($k.Name) since $($k.CreationDate)" }
if (Test-Path $marker) { Say "NOTE: a marker is ALREADY on disk (written $((Get-Item $marker).LastWriteTime)). A launcher that still reads markers takes one within 3 s; one that sits there means this launcher stopped reading them." }
$ledger = Json "$st\restart-takeovers.json"
if ($ledger) { Say "takeovers recorded: $(@($ledger.takeovers).Count) (cap 3 per rolling hour)" }

# 2. How many times did THIS launcher already restart claude in the last hour?
if ($launcher) {
  $hourAgo = (Get-Date).ToUniversalTime().AddHours(-1)
  $since = $launcher.CreationDate.ToUniversalTime()
  $from = if ($since -gt $hourAgo) { $since } else { $hourAgo }
  $n = @(Boots $from).Count
  $relaunches = if ($since -gt $hourAgo) { [Math]::Max(0, $n - 1) } else { $n }
  Say "daemon boots under this launcher in the last hour: $n, so about $relaunches marker relaunches. The launcher allows 3 per rolling hour; the 4th is deleted and ignored, and after that this launcher never reads a marker again (bin/hoai-core.mjs:2228, :2293, :2295-2299)."
}

# 3. The one write.
$t0 = (Get-Date).ToUniversalTime()
[IO.File]::WriteAllText($marker, '{"reason":"marker proof","requestedBy":"mark"}', [Text.Encoding]::ASCII)
Say "WROTE $marker at $($t0.ToString('o'))"
$gone = $null
for ($i = 1; $i -le $WatchSeconds; $i++) {
  Start-Sleep -Seconds 1
  $exists = Test-Path $marker
  if (-not $exists -and -not $gone) { $gone = $i; Say "marker gone after about $i s" }
  if ($i -in 5, 20, 45, 90, $WatchSeconds) {
    $s2 = Json "$st\supervisor.json"
    $l2 = if ($s2) { Proc $s2.pid } else { $null }
    $k2 = if ($l2) { Kids $l2.ProcessId } else { @() }
    Say ("t+{0}s marker={1} launcher={2} children={3}" -f $i, $(if ($exists) { 'PRESENT' } else { 'gone' }), $(if ($l2) { $l2.ProcessId } else { 'none' }), (($k2 | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ', '))
  }
}

# 4. What happened, from both sides.
$boots = @(Boots $t0)
Say "daemon boots since the write: $($boots.Count)"
Say 'daemon and helper lines since the write:'
foreach ($l in (LinesSince $log 'restart takeover|Starting BGOS channel plugin' $t0)) { Say "  $l" }
Say 'watcher lines since the write (a {} marker from the keep-alive sweep would show here):'
foreach ($l in (LinesSince $wlog "keep-alive $Id\b|restart $Id via" $t0)) { Say "  $l" }
$ws = Json $wstate
if ($ws -and $ws.agents.$Id) { Say ("watcher keepalive-state for ${Id}: " + ($ws.agents.$Id | ConvertTo-Json -Compress)) }
$s3 = Json "$st\supervisor.json"
Say ("supervisor.json now: " + $(if ($s3) { "pid $($s3.pid), startedAt $($s3.startedAt)" } else { 'ABSENT' }))
$pin2 = if (Test-Path "$st\session-id") { (Get-Content "$st\session-id" -Raw).Trim() } else { '' }
Say ("session-id now: $pin2 " + $(if ($pin2 -eq $pin) { '(SAME session)' } else { '(CHANGED)' }))
$claudes = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue | Where-Object { $pin -and $_.CommandLine -match [regex]::Escape($pin) })
Say "claude processes carrying this agent's pin: $($claudes.Count)"
foreach ($c in $claudes) { Say "  pid $($c.ProcessId) parent $($c.ParentProcessId) since $($c.CreationDate): $($c.CommandLine)" }
if (Test-Path "$st\restart-requested.claimed.json") { Say ("claimed marker (the daemon took it over): " + (Get-Content "$st\restart-requested.claimed.json" -Raw)) }
$ledger2 = Json "$st\restart-takeovers.json"
if ($ledger2) { Say ("takeover ledger now: " + ($ledger2.takeovers | ConvertTo-Json -Compress)) }

$sameClaude = @($before | Where-Object { $p = $_.ProcessId; @(Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).Count -gt 0 -and $_.Name -eq 'claude.exe' })
if ($boots.Count -ge 1 -and $claudes.Count -eq 1 -and $pin2 -eq $pin) { Say 'VERDICT: the agent restarted, ONE claude, SAME session.' }
elseif ($boots.Count -ge 1) { Say 'VERDICT: the agent restarted; check the claude count and the session line above.' }
elseif ($gone -and $sameClaude.Count -gt 0) { Say 'VERDICT: marker deleted, same claude, no new daemon: the launcher spent its budget and IGNORED it ("restart marker ignored" on its console). Every later marker will stay on disk. A 0.68.3 daemon takes such a marker over.' }
elseif (-not $gone) { Say 'VERDICT: marker still on disk and no restart: the launcher stopped reading markers, or no launcher is alive.' }
else { Say 'VERDICT: marker deleted and no daemon boot logged; read the lines above.' }
Say "saved to $out"
