# win32-limit-screen.ps1: read the screen of the hidden console a HOAI agent
# runs in, and press ONE Enter there only on the screen the watcher approved.
#
# Why: when a Claude usage limit stops a turn, Claude Code opens its rate limit
# options picker ("What do you want to do?") and every queued message waits
# until someone presses Enter. On Windows the agent runs in the hidden console
# of its hoai-core --keep-alive launcher, where nobody can see it. The watcher
# (lib/watcher-limit.mjs) decides whether usage is back and whether the screen
# is the limit picker with its pointer on "Stop and wait for limit to reset";
# this helper only reads and, when told, presses.
#
#   -Mode read                 print one line: HOAI-SCREEN <sha256 hex> <base64 of the UTF-8 text>
#                              (the visible rows of the active screen buffer, trailing spaces
#                              trimmed, joined by LF). Sends nothing.
#   -Mode press -ExpectHash H  read the screen again; ONLY if its sha256 is still H, write one
#                              Enter key event (down and up) to the console input. Nothing else:
#                              there is no parameter for another key or for any text.
#
# Exit codes: 0 ok, 2 could not attach, 3 could not write the key, 4 could not
# read the screen, 5 add-type failed, 7 the screen is not the approved one
# (nothing was sent), 64 a press without a hash.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{1,10}$')][string]$ConsolePid,
  [Parameter(Mandatory = $true)][ValidateSet('read', 'press')][string]$Mode,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectHash = ''
)
if ($Mode -eq 'press' -and -not $ExpectHash) { exit 64 }

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HoaiLimitConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr h, [Out] char[] buf, uint len, COORD pos, out uint read);
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
  const uint GENERIC_RW = 0xC0000000;
  const uint SHARE_RW = 3;
  const uint OPEN_EXISTING = 3;

  // The visible rows of the console's ACTIVE screen buffer. CONOUT$ is opened on every read: the
  // TUI may switch buffers, and a handle opened before the switch keeps reading the old one.
  public static string Snapshot() {
    IntPtr output = CreateFileW("CONOUT$", GENERIC_RW, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (output == IntPtr.Zero || output == new IntPtr(-1)) return null;
    try {
      CSBI info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return null;
      int width = info.Win.R - info.Win.L + 1;
      if (width <= 0) return null;
      StringBuilder all = new StringBuilder();
      for (int y = info.Win.T; y <= info.Win.B; y++) {
        char[] row = new char[width];
        COORD at; at.X = info.Win.L; at.Y = (short)y;
        uint read;
        if (!ReadConsoleOutputCharacterW(output, row, (uint)width, at, out read)) return null;
        all.Append(new string(row, 0, (int)read).TrimEnd());
        if (y < info.Win.B) all.Append('\n');
      }
      return all.ToString();
    } finally {
      CloseHandle(output);
    }
  }

  public static string Sha256Hex(string text) {
    using (var sha = System.Security.Cryptography.SHA256.Create()) {
      byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
      StringBuilder hex = new StringBuilder();
      foreach (byte b in hash) hex.Append(b.ToString("x2"));
      return hex.ToString();
    }
  }

  // One Enter: a key down and a key up of VK_RETURN, and nothing else.
  public static bool PressEnter() {
    IntPtr input = CreateFileW("CONIN$", GENERIC_RW, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (input == IntPtr.Zero || input == new IntPtr(-1)) return false;
    try {
      INPUT_RECORD[] recs = new INPUT_RECORD[2];
      for (int i = 0; i < 2; i++) {
        INPUT_RECORD r = new INPUT_RECORD();
        r.EventType = 1;
        r.KeyDown = i == 0 ? 1 : 0;
        r.RepeatCount = 1;
        r.VirtualKeyCode = 0x0D;
        r.VirtualScanCode = 0x1C;
        r.UnicodeChar = (char)13;
        r.ControlKeyState = 0;
        recs[i] = r;
      }
      uint written;
      return WriteConsoleInputW(input, recs, 2, out written) && written == 2;
    } finally {
      CloseHandle(input);
    }
  }
}
'@
# The pipe the watcher reads, taken before this process leaves its own console.
$stdout = [Console]::OpenStandardOutput()
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { exit 5 }
[HoaiLimitConsole]::FreeConsole() | Out-Null
if (-not [HoaiLimitConsole]::AttachConsole([uint32]$ConsolePid)) { exit 2 }
$text = [HoaiLimitConsole]::Snapshot()
if ($null -eq $text) { exit 4 }
$hash = [HoaiLimitConsole]::Sha256Hex($text)
if ($Mode -eq 'read') {
  $line = 'HOAI-SCREEN ' + $hash + ' ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)) + "`n"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($line)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
  exit 0
}
# press: only the screen the watcher approved, read again just now.
if ($hash -cne $ExpectHash) { exit 7 }
if (-not [HoaiLimitConsole]::PressEnter()) { exit 3 }
exit 0
