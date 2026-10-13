# screendump.ps1: attach to a hidden console and write its visible text to a file.
param(
  [Parameter(Mandatory = $true)][int]$ConsolePid,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$Lines = 45
)
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RmkConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD pos, out uint read);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Win; public COORD Max; }
}
'@
Add-Type -TypeDefinition $src
[RmkConsole]::FreeConsole() | Out-Null
if (-not [RmkConsole]::AttachConsole([uint32]$ConsolePid)) { Set-Content -Path $OutFile -Value ("attach failed err=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 2 }
$out = [RmkConsole]::CreateFileW('CONOUT$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, 0, [IntPtr]::Zero)
$info = New-Object RmkConsole+CSBI
if (-not [RmkConsole]::GetConsoleScreenBufferInfo($out, [ref]$info)) { Set-Content -Path $OutFile -Value 'no buffer info'; exit 3 }
$w = [int]$info.Size.X
$bottom = [Math]::Max([int]$info.Cursor.Y, [int]$info.Win.B)
$top = [Math]::Max(0, $bottom - $Lines)
$text = New-Object System.Text.StringBuilder
for ($y = $top; $y -le $bottom; $y++) {
  $buf = New-Object System.Text.StringBuilder $w
  $pos = New-Object RmkConsole+COORD; $pos.X = 0; $pos.Y = [int16]$y
  $read = [uint32]0
  [RmkConsole]::ReadConsoleOutputCharacterW($out, $buf, [uint32]$w, $pos, [ref]$read) | Out-Null
  [void]$text.Append($buf.ToString().TrimEnd()).Append("`n")
}
Set-Content -Path $OutFile -Value $text.ToString() -Encoding UTF8
exit 0
