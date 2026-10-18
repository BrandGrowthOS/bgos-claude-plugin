# win32-accept-dev-channels.ps1: accept Claude Code's "WARNING: Loading
# development channels" gate on the console a HOAI agent runs in, without a
# terminal emulator and without a human.
#
# Why: Claude Code 2.1.241 shows that gate at EVERY launch that carries
# --dangerously-load-development-channels, for marketplace installs as much
# as for clones (verified live on Windows, 2026-08-25, disposable E2E). Its
# default answer is "1. I am using this for local development", so ONE Enter
# accepts it. No settings key silences it (binary grep), and on Windows there
# is no `expect`, so an unattended relaunch (a one-click update, a watcher
# restart) would strand on it forever.
#
# How: hoai-core spawns this helper right after spawning claude, hidden, with
# the pid of the console they share. The helper attaches to that console,
# polls the visible screen buffer, and injects a single Enter key event ONLY
# once the gate's marker text is on screen. It never presses blindly: the
# bypass-permissions warning (default "No, exit") is suppressed by the
# settings file and this helper does not touch it. If the marker never shows
# (a newer CLI stopped prompting), it exits quietly after the timeout.
#
# Exit codes: 0 accepted, 2 could not attach, 3 could not inject, 4 timeout, 5 add-type failed, 6 unproven.
#
# "accepted" is a claim about the log as much as the console: with -LogFile
# (hoai always passes one), 0 means the Enter was written AND both "attached"
# and "accepted" are on record in the log. 6 means the Enter was written but one
# of those two lines could not be recorded, so nothing proves the gate was
# answered on this console (agent
# 888, 16 Oct 07:59Z, a cold start after logon: "start", then "accepted" 16 s
# later, no "attached", and claude never started its MCP server). An
# unattended hoai relaunches claude for a 6 (bin/hoai-core.mjs
# WIN32_GATE_EXIT_UNPROVEN).
param(
  [Parameter(Mandatory = $true)][int]$ConsolePid,
  [int]$TimeoutSeconds = 120,
  [string]$Marker = 'Loading development channels',
  [string]$LogFile = ''
)
# Note appends one line and says whether it did. The log is opened append-only
# (every write lands at the end) and shares read, write and delete, so the
# line lands beside hoai's own handle on the log, another agent's helper, and
# any reader (an indexer, a scanner, a person's tail). The 0.69.6 helper used
# Add-Content, which shares no read: any process with the log open for reading
# made it fail, with a NON-terminating error its `catch {}` never saw, so the
# line was lost and the helper carried on (agent 888, 16 Oct 07:59Z; measured
# on scratch files, 2026-10-16). A write that still fails (a process holding
# the log exclusively) is retried for about a second, then reported on stderr,
# which hoai points at the same log through the handle it already holds. The
# FileSystemRights constructor is .NET Framework's, which powershell.exe runs.
function Note([string]$line) {
  if (-not $LogFile) { return $true }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Date).ToString('o') + ' pid=' + $PID + ' ' + $line + "`r`n")
  $why = ''
  for ($try = 1; $try -le 10; $try++) {
    try {
      $fs = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append, [System.Security.AccessControl.FileSystemRights]::AppendData, [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None)
      try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      return $true
    } catch { $why = $_.Exception.Message; Start-Sleep -Milliseconds 100 }
  }
  $host.UI.WriteErrorLine('log write refused, one line lost: ' + $why)
  return $false
}
[void](Note "start console=$ConsolePid timeout=$TimeoutSeconds")

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HoaiConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD pos, out uint read);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Win; public COORD Max; }
  [StructLayout(LayoutKind.Explicit, Size = 20)] public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort RepeatCount;
    [FieldOffset(10)] public ushort VirtualKeyCode;
    [FieldOffset(12)] public ushort VirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint ControlKeyState;
  }
}
'@
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { [void](Note ("add-type failed: " + $_.Exception.Message)); exit 5 }
[HoaiConsole]::FreeConsole() | Out-Null
if (-not [HoaiConsole]::AttachConsole([uint32]$ConsolePid)) { [void](Note ("attach failed err=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())); exit 2 }
$attachedNoted = Note "attached"
# GENERIC_READ | GENERIC_WRITE as an unsigned literal (0xC0000000 parses as a
# negative int32 in PowerShell and fails the cast).
$GENERIC_RW = [uint32]3221225472; $SHARE_RW = [uint32]3; $OPEN_EXISTING = [uint32]3
$in = [HoaiConsole]::CreateFileW('CONIN$', $GENERIC_RW, $SHARE_RW, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  # Re-open CONOUT$ on EVERY poll: the TUI switches to an alternate screen
  # buffer after start, and a handle opened before that switch keeps reading
  # the old buffer, where the gate never appears.
  $out = [HoaiConsole]::CreateFileW('CONOUT$', $GENERIC_RW, $SHARE_RW, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
  $info = New-Object HoaiConsole+CSBI
  if ([HoaiConsole]::GetConsoleScreenBufferInfo($out, [ref]$info)) {
    $w = [int]$info.Size.X
    $top = [Math]::Max(0, [int]$info.Cursor.Y - 40)
    $text = New-Object System.Text.StringBuilder
    for ($y = $top; $y -le [int]$info.Cursor.Y; $y++) {
      $buf = New-Object System.Text.StringBuilder $w
      $pos = New-Object HoaiConsole+COORD; $pos.X = 0; $pos.Y = [int16]$y
      $read = [uint32]0
      [HoaiConsole]::ReadConsoleOutputCharacterW($out, $buf, [uint32]$w, $pos, [ref]$read) | Out-Null
      [void]$text.Append($buf.ToString()).Append("`n")
    }
    if ($text.ToString().Contains($Marker)) {
      $recs = New-Object 'HoaiConsole+INPUT_RECORD[]' 2
      for ($i = 0; $i -lt 2; $i++) {
        $r = New-Object HoaiConsole+INPUT_RECORD
        $r.EventType = 1; $r.KeyDown = $(if ($i -eq 0) { 1 } else { 0 }); $r.RepeatCount = 1
        $r.VirtualKeyCode = 0x0D; $r.VirtualScanCode = 0x1C; $r.UnicodeChar = [char]13; $r.ControlKeyState = 0
        $recs[$i] = $r
      }
      $written = [uint32]0
      if (-not [HoaiConsole]::WriteConsoleInputW($in, $recs, 2, [ref]$written)) { [void](Note ("inject failed err=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())); exit 3 }
      # Success only with both lines on record: the log is what proves the gate
      # was answered on this console. A press the log cannot show is exit 6,
      # and its note avoids both words, so a check that looks for them fails.
      if ($attachedNoted -and (Note "accepted")) { exit 0 }
      [void](Note ("unproven: the Enter was written but the log does not show it (attach line recorded: " + $attachedNoted + ")"))
      exit 6
    }
  }
  [HoaiConsole]::CloseHandle($out) | Out-Null
  Start-Sleep -Milliseconds 500
}
[void](Note "timeout without the gate on screen")
exit 4
