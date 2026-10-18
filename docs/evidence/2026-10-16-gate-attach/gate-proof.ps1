# gate-proof.ps1: read-only proof of one Windows agent's start, for board row d806c69f (agent 888,
# 16 Oct 07:59Z: the gate helper logged "start" and "accepted" but no "attached", and the agent
# never came up).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\gate-proof.ps1 -Id 888
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\gate-proof.ps1 -Id 888 -Since 2026-10-16T07:55:00Z -ConsolePid 25088
#
# It reads the gate helper's log, the agent's supervisor.json, launch-status, daemon log and channel
# beacon, and nothing else: no credentials file, no process is started, stopped or signalled, and
# nothing is written but its own report (%TEMP%\hoai-gate-proof-<id>-<time>.txt).
#
# The gate log is shared by every agent of this Windows user, so only helpers of THIS agent's
# launcher count: those whose "start" names its console (-ConsolePid, by default the launcher pid in
# supervisor.json; every relaunch under one launcher shares it). Only the newest of those helper
# runs since -Since is judged (the newest in the whole log when there is no launcher pid), so an
# older PASS (an earlier start, or another agent's) never outweighs a newer UNPROVEN. A helper run
# begins at its "start" line: a pid Windows reused for a later helper is a second run.
#
# PASS needs, from that ONE helper run since -Since (default: the last 30 minutes):
# "start", "attached" AND "accepted", then a daemon boot within 3 minutes of that accepted and a
# channel beacon after it. "accepted" alone is never a pass: a helper whose "attached" line was
# lost wrote exactly that.
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [string]$Since = '',
  [int]$ConsolePid = 0
)
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:USERPROFILE '.bgos-agent'
$gateLog = Join-Path $root 'logs\win32-gate-helper.log'
$daemonLog = Join-Path $root "logs\bgos-plugin-$Id.log"
$statusFile = Join-Path $root "$Id\launch-status"
$supervisorFile = Join-Path $root "$Id\supervisor.json"
$stateRoot = if ($env:BGOS_PLUGIN_STATE_DIR) { $env:BGOS_PLUGIN_STATE_DIR } else { Join-Path $env:USERPROFILE '.bgos-plugin-state' }
$beaconFile = Join-Path $stateRoot "$Id\channel-beacon.json"
$out = Join-Path $env:TEMP ("hoai-gate-proof-$Id-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$from = if ($Since) { [datetime]::Parse($Since).ToUniversalTime() } else { (Get-Date).ToUniversalTime().AddMinutes(-30) }
function Say([string]$s) { Write-Output $s; Add-Content -Path $out -Value $s }
function Lines([string]$path) {
  if (-not (Test-Path $path)) { return @() }
  # Shared read, opened and closed at once: a live helper's log write is never held off for long.
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  try { $r = New-Object IO.StreamReader($fs); @($r.ReadToEnd() -split "`r?`n") } finally { $fs.Close() }
}

if ($ConsolePid -le 0 -and (Test-Path $supervisorFile)) {
  try { $ConsolePid = [int]((Lines $supervisorFile) -join "`n" | ConvertFrom-Json).pid } catch {}
}
Say "agent $Id, since $($from.ToString('o')) (UTC)"
if ($ConsolePid -gt 0) { Say "this agent's launcher (console) pid: $ConsolePid" } else { Say 'WARNING: no launcher pid (no supervisor.json, no -ConsolePid): only the newest helper run in the log is judged, and on a PC with several agents it can be another agent''s' }

# 1. The gate helper, one verdict per helper run. A run begins at its "start" line, so a pid that
#    Windows reused for a later helper is a run of its own, never merged with the earlier one.
$runs = New-Object System.Collections.ArrayList
$open = @{}
$errors = 0
$last = $null
foreach ($line in (Lines $gateLog)) {
  if ($line -match '^(\S+) pid=(\d+) (.*)$') {
    $at = [datetime]::Parse($Matches[1]).ToUniversalTime()
    $last = $at
    if ($at -lt $from) { continue }
    $hp = $Matches[2]; $text = $Matches[3]; $word = ($text -split '[ :]')[0]
    if ($word -eq 'start' -or -not $open.Contains($hp)) {
      $open[$hp] = $runs.Count
      [void]$runs.Add([ordered]@{ pid = $hp; words = @(); lines = @(); acceptedAt = $null; console = 0 })
    }
    $run = $runs[$open[$hp]]
    if ($text -match '^start console=(\d+)') { $run.console = [int]$Matches[1] }
    $run.words += $word
    $run.lines += $line
    if ($word -eq 'accepted') { $run.acceptedAt = $at }
  } elseif ($line -match 'Add-Content|being used by another process' -and $last -and $last -ge $from) {
    $errors++
  }
}
if ($errors -gt 0) { Say "gate log: $errors line(s) of Add-Content's refusal (a log write the helper lost; the 888 cause, an old helper)" }
if ($runs.Count -eq 0) { Say "gate log: NO helper since then ($gateLog)" }
# The newest run that counts: this launcher's when its pid is known, else the newest in the log.
$newest = -1
for ($i = 0; $i -lt $runs.Count; $i++) { if ($ConsolePid -le 0 -or $runs[$i].console -eq $ConsolePid) { $newest = $i } }
$passAt = $null
for ($i = 0; $i -lt $runs.Count; $i++) {
  $h = $runs[$i]; $hp = $h.pid
  if ($ConsolePid -gt 0 -and $h.console -ne $ConsolePid) { Say "helper pid $hp : another launcher's (console $($h.console)), not judged"; continue }
  if ($i -ne $newest) { Say "helper pid $hp : an earlier helper run (console $($h.console)), not judged: only the newest helper run counts"; continue }
  $ok = ($h.words -contains 'start') -and ($h.words -contains 'attached') -and ($h.words -contains 'accepted')
  $verdict = if ($ok) { 'PASS (start, attached, accepted)' } elseif ($h.words -contains 'unproven') { 'UNPROVEN (exit 6: hoai relaunches claude for it)' } elseif ($h.words -contains 'accepted') { 'FAIL (accepted WITHOUT attached: the 888 shape)' } else { 'NOT PASSED (' + ($h.words -join ', ') + ')' }
  Say "helper pid $hp : $verdict"
  foreach ($l in $h.lines) { Say "    $l" }
  if ($ok) { $passAt = $h.acceptedAt }
}

# 2. What hoai recorded about the launch (health-relaunch, health-relaunch-refused, no-channel-heartbeat).
if (Test-Path $statusFile) { Say ("launch-status: " + ((Lines $statusFile) -join ' ').Trim()) } else { Say 'launch-status: none (a clean start writes none on Windows)' }

# 3. The daemon boot and the channel beacon after the passing helper.
$boot = $null
foreach ($line in (Lines $daemonLog)) {
  if ($line -match '^(\S+Z) .*\[bgos\] Starting BGOS channel plugin') {
    $at = [datetime]::Parse($Matches[1]).ToUniversalTime()
    if ($passAt -and $at -ge $passAt.AddSeconds(-5) -and $at -le $passAt.AddMinutes(3) -and -not $boot) { $boot = $at }
  }
}
Say ("daemon boot within 3 minutes of the passing helper: " + $(if ($boot) { $boot.ToString('o') } else { 'NONE' }))
$beaconAt = $null
if (Test-Path $beaconFile) {
  try { $b = (Lines $beaconFile) -join "`n" | ConvertFrom-Json; $beaconAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$b.beaconAt).UtcDateTime } catch {}
}
Say ("channel beacon: " + $(if ($beaconAt) { $beaconAt.ToString('o') + ' (' + [int]((Get-Date).ToUniversalTime() - $beaconAt).TotalSeconds + ' s ago)' } else { "none readable ($beaconFile)" }))

$pass = $passAt -and $boot -and $beaconAt -and $beaconAt -ge $passAt
Say $(if ($pass) { 'RESULT: PASS' } else { 'RESULT: FAIL (see the lines above)' })
Say "report saved to $out"
