' hoai-agent-viewer.vbs: run hoai-agent-viewer.ps1 (beside this file) with no console window.
' Show agent windows (board row d133ddb2): the watcher runs
'   wscript //B hoai-agent-viewer.vbs -ConsolePid <digits> -AssistantId <digits>
' (lib/agent-windows.mjs). The arguments are forwarded as they are (digits only, checked by the
' watcher and again by the ps1), the window style is 0 and nothing waits on the viewer.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File """ & here & "\hoai-agent-viewer.ps1""" & args, 0, False
