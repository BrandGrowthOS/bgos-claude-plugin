# hoai-agent-viewer.ps1: Show agent windows on Windows (board row d133ddb2, Kc's choice 3).
#
#   -Mode view (default)  a WATCH ONLY window on one agent's hidden console. It attaches to that
#                         console (the one its hoai launcher runs in), reads the visible screen a
#                         few times a second and draws it in a window of its own. It never opens
#                         the console's input, so nothing typed or clicked here can reach the agent,
#                         and it never resizes, shows or closes the agent's console. Closing this
#                         window ends only this process: the agent keeps running. It closes itself
#                         when the agent's launcher leaves the console.
#   -Mode hide            hide the agent console's own window (SW_HIDE) and exit: a console a
#                         supervisor left on screen before agents ran hidden (the old minimized task
#                         launcher, the old cmd /k create launch). Hiding never closes anything. A
#                         console Windows Terminal hosts cannot be hidden this way (exit 4, untouched):
#                         it shows until the agent's next start, which is hidden.
#
# Started by the watcher (lib/agent-windows.mjs) through hoai-agent-viewer.vbs, with window style 0
# so no console flashes; every argument is digits; the agent's name arrives in HOAI_VIEWER_NAME.
# Exit codes: 0 done, 2 the agent console could not be attached, 4 hosted by a terminal application
# (hide mode), 5 the helper did not compile.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+$')][string]$ConsolePid,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+$')][string]$AssistantId,
  [ValidateSet('view', 'hide')][string]$Mode = 'view'
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class HoaiAgentConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);

  // A console a terminal application hosts (Windows Terminal) has only a pseudo window: hiding that
  // hides nothing on screen, and the terminal's own window is not ours to touch.
  public static bool HostedByTerminal(IntPtr window) {
    StringBuilder name = new StringBuilder(64);
    GetClassNameW(window, name, name.Capacity);
    return name.ToString() == "PseudoConsoleWindow";
  }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] list, uint count);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SmallRect { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct ScreenInfo { public Coord Size; public Coord Cursor; public ushort Attributes; public SmallRect Window; public Coord MaxSize; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out ScreenInfo info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleOutputCharacterW(IntPtr output, [Out] char[] text, uint length, Coord at, out uint read);

  // The screen buffer is opened to READ it, and for nothing else.
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ_AND_WRITE = 3;
  const uint OPEN_EXISTING = 3;

  // Is this process (the agent's launcher) still on the console this process is attached to?
  public static bool Attached(uint processId) {
    uint[] list = new uint[64];
    uint count = GetConsoleProcessList(list, (uint)list.Length);
    if (count > list.Length) {
      list = new uint[count + 16];
      count = GetConsoleProcessList(list, (uint)list.Length);
    }
    for (int i = 0; i < count && i < list.Length; i++) {
      if (list[i] == processId) return true;
    }
    return false;
  }

  // The visible part of the console's ACTIVE screen buffer, row by row. CONOUT$ is opened again on
  // every read, because the agent's terminal UI switches buffers.
  public static string Snapshot() {
    IntPtr output = CreateFileW("CONOUT$", GENERIC_READ, FILE_SHARE_READ_AND_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (output == IntPtr.Zero || output == new IntPtr(-1)) return null;
    try {
      ScreenInfo info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return null;
      int width = info.Window.Right - info.Window.Left + 1;
      if (width <= 0) return "";
      char[] row = new char[width];
      StringBuilder all = new StringBuilder();
      for (int y = info.Window.Top; y <= info.Window.Bottom; y++) {
        Coord at;
        at.X = info.Window.Left;
        at.Y = (short)y;
        uint read;
        if (!ReadConsoleOutputCharacterW(output, row, (uint)width, at, out read)) return null;
        all.Append(new string(row, 0, (int)Math.Min(read, (uint)width)).TrimEnd());
        if (y < info.Window.Bottom) all.Append("\r\n");
      }
      return all.ToString();
    } finally {
      CloseHandle(output);
    }
  }
}

public class HoaiAgentViewerForm : Form {
  readonly uint agent;
  readonly TextBox screen;
  readonly Timer timer;
  string last;

  public HoaiAgentViewerForm(uint agentPid, string title, string footer) {
    agent = agentPid;
    Text = title;
    ClientSize = new Size(980, 620);
    BackColor = Color.FromArgb(12, 12, 12);
    screen = new TextBox();
    screen.Multiline = true;
    screen.ReadOnly = true;
    screen.WordWrap = false;
    screen.ScrollBars = ScrollBars.Both;
    screen.Dock = DockStyle.Fill;
    screen.Font = new Font("Consolas", 10f);
    screen.BackColor = Color.FromArgb(12, 12, 12);
    screen.ForeColor = Color.FromArgb(204, 204, 204);
    screen.BorderStyle = BorderStyle.None;
    screen.TabStop = false;
    Label note = new Label();
    note.Text = footer;
    note.Dock = DockStyle.Bottom;
    note.Height = 26;
    note.TextAlign = ContentAlignment.MiddleLeft;
    note.Padding = new Padding(8, 0, 8, 0);
    note.BackColor = Color.FromArgb(32, 32, 32);
    note.ForeColor = Color.FromArgb(170, 170, 170);
    Controls.Add(screen);
    Controls.Add(note);
    timer = new Timer();
    timer.Interval = 400;
    timer.Tick += new EventHandler(Tick);
    Load += new EventHandler(Loaded);
    FormClosed += delegate { timer.Stop(); };
  }

  // A new viewer never takes the keyboard from whatever the owner is typing in.
  protected override bool ShowWithoutActivation { get { return true; } }

  void Loaded(object sender, EventArgs e) {
    // This process starts with window style 0 (so its own console never shows), and a first
    // ShowWindow that asks for the default style would take that one: the form asks for
    // SW_SHOWNOACTIVATE (4) explicitly, so it shows, without taking the keyboard.
    HoaiAgentConsole.ShowWindow(Handle, 4);
    Tick(sender, e);
    timer.Start();
  }

  void Tick(object sender, EventArgs e) {
    if (!HoaiAgentConsole.Attached(agent)) {
      timer.Stop();
      Close();
      return;
    }
    string text = HoaiAgentConsole.Snapshot();
    if (text == null || text == last) return;
    last = text;
    screen.Text = text;
  }
}

public static class HoaiAgentViewer {
  public static void Run(uint agentPid, string title, string footer) {
    Application.EnableVisualStyles();
    Application.Run(new HoaiAgentViewerForm(agentPid, title, footer));
  }
}
'@

try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
} catch {
  exit 5
}

$target = [uint32]$ConsolePid

if ($Mode -eq 'hide') {
  [HoaiAgentConsole]::FreeConsole() | Out-Null
  if (-not [HoaiAgentConsole]::AttachConsole($target)) { exit 2 }
  $console = [HoaiAgentConsole]::GetConsoleWindow()
  if ($console -ne [IntPtr]::Zero -and [HoaiAgentConsole]::HostedByTerminal($console)) {
    [HoaiAgentConsole]::FreeConsole() | Out-Null
    exit 4
  }
  if ($console -ne [IntPtr]::Zero -and [HoaiAgentConsole]::IsWindowVisible($console)) {
    [HoaiAgentConsole]::ShowWindow($console, 0) | Out-Null
  }
  [HoaiAgentConsole]::FreeConsole() | Out-Null
  exit 0
}

$name = [string]$env:HOAI_VIEWER_NAME
if (-not $name) { $name = "Agent $AssistantId" }
$computer = [string]$env:COMPUTERNAME
$dot = [string][char]0x00B7
$title = "HOAI $dot $name (watch only)"
$footer = "Watching $name on $computer. Close this window any time: $name keeps running."

[HoaiAgentConsole]::FreeConsole() | Out-Null
if (-not [HoaiAgentConsole]::AttachConsole($target)) { exit 2 }
# A Ctrl+C the agent's console raises (hoai stopping claude, say) is not this window's to act on.
[HoaiAgentConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
try {
  [HoaiAgentViewer]::Run($target, $title, $footer)
} finally {
  # Leave the agent's console before this process ends, so nothing of this host lingers on it.
  [HoaiAgentConsole]::FreeConsole() | Out-Null
}
exit 0
