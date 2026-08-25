# hoai-add-to-path: add one directory to the CURRENT USER's PATH, once.
#
# Extracted from bin/hoai-bootstrap.ps1 Ensure-OnPath so the CLI onboarding
# path (`hoai setup <CODE>` and `hoai install-cli`) can use the SAME registry
# mechanism the one-click bootstrap uses, rather than inventing a second one.
# node cannot write the user environment block itself, hence a PowerShell hop.
#
# It only ever adds a DIRECTORY to PATH. It never writes an alias, and it never
# writes a channel flag: the correct channel spec is knowable only at run time
# from install-method detection (a spec frozen into an alias is the 2026-08-21
# silent-drop incident), so hoai resolves it on every launch instead.
#
# `setx` is deliberately not used: it truncates PATH at 1024 characters and
# flattens the machine PATH into the user PATH. SetEnvironmentVariable does not.
#
# HOAI_TEST_SKIP_USERPATH=1 keeps a matrix or test run from mutating the real
# user's registry PATH (same escape hatch as the bootstrap).
#
# Exit codes: 0 added or already present, 1 the directory does not exist or the
# write failed.

param(
    [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Dir)) {
    [Console]::Error.WriteLine('[hoai] not adding a directory that does not exist: ' + $Dir)
    exit 1
}

if ($env:HOAI_TEST_SKIP_USERPATH -eq '1') {
    [Console]::Out.WriteLine('[hoai] HOAI_TEST_SKIP_USERPATH=1, leaving the registry PATH alone')
    exit 0
}

try {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $current) { $current = '' }
    $already = $false
    foreach ($p in ($current -split ';' | Where-Object { $_ -ne '' })) {
        if ($p.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { $already = $true }
    }
    if ($already) {
        [Console]::Out.WriteLine('[hoai] already on your PATH: ' + $Dir)
        exit 0
    }
    [Environment]::SetEnvironmentVariable('Path', ($Dir + ';' + $current), 'User')
    [Console]::Out.WriteLine('[hoai] added to your PATH: ' + $Dir)
    exit 0
} catch {
    [Console]::Error.WriteLine('[hoai] could not update your PATH: ' + $_.Exception.Message)
    exit 1
}
