# hoai: thin dispatcher for bin/hoai-core.mjs (Windows PowerShell / pwsh).
# Every decision lives in the core; this only picks a JS runtime and passes
# the args and the exit code through.
#
# Two homes: inside the plugin's bin/ (core sits next to this file), or copied
# into the hoai bin dir by the bootstrap, which leaves a hoai-plugin-root.txt
# breadcrumb naming the plugin root the core lives under.
$core = Join-Path $PSScriptRoot 'hoai-core.mjs'
if (-not (Test-Path $core)) {
  $breadcrumb = Join-Path $PSScriptRoot 'hoai-plugin-root.txt'
  if (Test-Path $breadcrumb) {
    $pluginRoot = (Get-Content $breadcrumb -Raw).Trim()
    if ($pluginRoot) { $core = Join-Path $pluginRoot 'bin\hoai-core.mjs' }
  }
}
if (-not (Test-Path $core)) {
  [Console]::Error.WriteLine('hoai: hoai-core.mjs not found next to this script or via hoai-plugin-root.txt; reinstall with the HOAI app or hoai-bootstrap')
  exit 127
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source $core @args
  exit $LASTEXITCODE
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) {
  & $bun.Source $core @args
  exit $LASTEXITCODE
}

[Console]::Error.WriteLine('hoai: neither node nor bun was found; install Node 18+ (nodejs.org) or bun (bun.sh)')
exit 127
