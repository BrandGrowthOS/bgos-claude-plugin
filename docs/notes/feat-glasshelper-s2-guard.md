# Glass helper slice 2: the guard catches four more ways to hide a window

Stacked on the slice 1 branch. The guard (`scripts/build-guard.mjs`, `npm run guard:win`) already named
`CREATE_NEW_CONSOLE`, `DETACHED_PROCESS`, `ShowWindow`, `AllocConsole`, `schtasks` and `Schedule.Service`.
This slice closes what a hidden window could still slip through.

## What is new

| Rule | Where | Reports |
|---|---|---|
| `HIDDEN_FLAG_NUMBER` | native only | `CREATE_NO_WINDOW` (0x08000000) or `DETACHED_PROCESS` (0x00000008) written as a number: hex, with underscores or a type suffix, alone or OR'ed with others or already summed |
| `SHOW_WINDOW` | native only | now also `SW_HIDE` (`ShowWindow` and `ShowWindowAsync` were already reported, with any value) |
| `HIDDEN_STARTUP` | native only | `wShowWindow` (or `w_show_window`) set to `SW_HIDE` or to 0, the value that makes `STARTF_USESHOWWINDOW` hide the window |
| `SCHEDULED_TASK` | every root | now also `ITaskService` |

## How the number rule decides

- A hex, binary or octal number counts on any line that names a flag (`creation_flags`, `dwFlags`, `launch_flags`, `flag`, `CreateProcess...`), in every native file, tests and build scripts included. A call that ends its line takes its numbers from the next line.
- A decimal counts only on a line that names creation flags or a `CreateProcess` call (or just after one that ends its line), so a byte offset on a line that merely says flags (`offset + 78`) passes.
- A number is flagged when it has either hidden bit set. So `0x08000400` is reported and `0x04000000` is not.
- Same line only, like the other heuristics. A number built up on one line and used on another is not seen.
- Names are allowed: `CREATE_NO_WINDOW` is not reported, a number for it is. There are still no exemptions and no suppression comments, and a comment that holds the number is reported like any other text.

## What changed in native code

Slice 1 wrote its own hidden-window flag as a number. It now names it, with the same bits:

- `hoai-common` `config.rs`: `CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT` (was 0x08000400).
- `hoai-common` `tests/contract.rs`: the same expression. The separate check that bit 0x8 is clear was dropped, because naming `DETACHED_PROCESS` there would trip its own rule and the exact equality above it already excludes that bit.
- `hoai-helper` `build.rs`: `CREATE_NO_WINDOW` for the resource compiler.
- `hoai-helper` `Cargo.toml`: `windows-sys` (the workspace entry, which already carries `Win32_System_Threading`) as a Windows only build dependency, so `build.rs` can name the constant. `Cargo.lock` is unchanged: `hoai-helper` already lists `windows-sys`.

The constants are in the pinned windows-sys 0.61.2 source, module `Win32::System::Threading`, as plain `u32` values. Nothing here was compiled; the first build is CI's.

## Checked

- Red first: 15 new cases failed before the matcher change, and the decimal near miss failed before the decimal condition.
- One mutant per matcher (matcher removed, red, file restored with an equal sha256): `ITaskService`, `SW_HIDE`, `HIDDEN_STARTUP`, each hidden bit, decimal literals, the whole number matcher, the decimal condition, and the `ShowWindow` and `schtasks` names.
- `node scripts/build-guard.mjs --strict native` exits 0 on the real tree.

## Not covered

- A flag built across lines, from a variable, or read from a config file.
- `STARTF_USESHOWWINDOW` on its own is not reported: it only hides when `wShowWindow` is hidden, and that is what is matched.
- Task Scheduler through a type library import or a wrapper with another name.
- A shift such as `1 << 27` is not evaluated. It is reported only when the shift count happens to share a bit with a hidden flag, so do not rely on it.
- A number followed by a method call (`0x08000000.into()`) is not reported.
- `STARTF_USESHOWWINDOW`'s hidden value is matched only on the field's own line, `wShowWindow: 0` or `wShowWindow = SW_HIDE` (with typed, hex, binary and octal zeros), not through a separate variable.
