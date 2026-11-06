# Thread lanes and By the way: CLI spike

**Date:** 2026-10-31. **CLI:** Claude Code 2.1.316, `--model haiku`, macOS.
**Where:** a throwaway folder in the session scratchpad (`plugin-spike/main` and `plugin-spike/wt`), with session ids generated for the spike only. No real agent's session or `~/.bgos-agent` state was touched. Seven real invocations; the spike transcripts were deleted afterwards.

Every command also carried `--strict-mcp-config --mcp-config <empty>` where `<empty>` is a file holding `{"mcpServers":{}}`.

## (a) Make a session

```
claude -p --model haiku --session-id <main> --strict-mcp-config --mcp-config <empty> "Remember ... Reply with just: ok"
-> Error: Invalid MCP configuration: MCP config file not found: <cwd>/Remember the code word ...
```

**Finding 1: `--mcp-config` is variadic** (`<configs...>`) and swallows a positional prompt that follows it. The plugin therefore never passes the prompt on the command line: a lane gets stream json on stdin, and an aside gets its prompt on stdin (`-p` reads stdin when no prompt is given), and `--mcp-config` stays the last flag of both builders. This first attempt failed at argument parsing, before any model call.

```
echo "Remember the code word PELICAN-42. Reply with just: ok" | claude -p --model haiku --session-id <main> --strict-mcp-config --mcp-config <empty>
-> ok   (transcript at ~/.claude/projects/<munged main cwd>/<main>.jsonl, 32 lines)
```

## (b) and (e) Fork with stream json and partial messages (the aside shape)

```
echo "What is the code word? Reply with only the word." | claude -p --model haiku --resume <main> --fork-session \
  --permission-mode dontAsk --max-turns 1 --output-format stream-json --include-partial-messages --verbose ...
```

Frames, in order:

```
system/init      session_id=346e3026-... (differs from <main>) cwd=<main folder> tools=27 mcp=[] permissionMode=dontAsk
system/status
stream_event     message_start
stream_event     content_block_start
stream_event     content_block_delta text_delta "PELIC"
stream_event     content_block_delta text_delta "AN-42"
assistant
stream_event     content_block_stop / message_delta / message_stop
rate_limit_event
result/success   session_id=346e3026-... is_error=false result="PELICAN-42" num_turns=1
```

**Finding 2:** `--fork-session` gives the fork its own id in the init frame, the fork's file lands beside the main one in the same project dir, and the main transcript is not appended to (still 32 lines, no copy of the question). Text arrives as `stream_event` / `content_block_delta` / `text_delta`, and the full answer is the `result` frame's `result`.

## (f) Does `--permission-mode dontAsk --max-turns 1` refuse a tool?

```
echo "Use the Read tool to read note.txt ... tell me its content." | claude -p ... --resume <main> --fork-session --permission-mode dontAsk --max-turns 1 ...
-> assistant tool_use Read {file_path: <main folder>/note.txt}
-> user tool_result "1\tsecret-file-content-XYZ"
-> result/error_max_turns is_error=true num_turns=2 permission_denials=[] (no result text)
```

**Finding 3: dontAsk did NOT refuse Read.** The read only tool ran (the file content reached the model) and `--max-turns 1` then ended the run as `error_max_turns` with no answer. So the aside builder adds **`--tools ""`**, which removes every tool:

```
... --resume <fork with a tool_use in its history> --fork-session --tools "" --permission-mode dontAsk --max-turns 1 ...
-> system/init tools=[]
-> result/success result="" (the model, asked to use a tool it no longer has, said nothing; the CLI added a synthetic "no visible output" nudge)
```

and with the real aside prompt on a normal question:

```
printf '[Side question from the owner. ... Do not use tools. ...]\n\nQuestion: which code word ...' | claude -p --resume <main> --fork-session --tools "" --permission-mode dontAsk --max-turns 1 --output-format stream-json --include-partial-messages --verbose ...
-> system/init tools=[]
-> text_delta "The code word was" / " PELIC" / "AN-42. Its number" / " part is 42."
-> result/success result="The code word was PELICAN-42. Its number part is 42." num_turns=1
```

`message_start` reports `cache_miss_reason: tools_changed`. Any aside built with `--strict-mcp-config` already changes the tool list of a main session that has this channel's MCP tools, so the cache prefix is not kept either way; refusing every tool is worth more than the cache. An empty answer (a fork that only tried a tool) is answered `failed`, never posted.

## (c) and (d) A lane from another cwd, two turns over stream json

`plugin-spike/scripts/lane-spike.mjs`: copy `<main>.jsonl` into the project dir of `plugin-spike/wt`, then spawn in `wt`:

```
claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --resume <main> --fork-session --strict-mcp-config --mcp-config <empty>
stdin:  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"What is the code word? ..."}]}}
-> system/init session_id=dbd3b62b-... cwd=<wt>          (the copied main file deleted here)
-> assistant "PELICAN-42"
-> result/success result="PELICAN-42" session_id=dbd3b62b-...
stdin:  {"type":"user", ... "Now reply with the code word spelled backwards, nothing else."}
-> system/init session_id=dbd3b62b-... cwd=<wt>          (again)
-> assistant "24-OCILEP"
-> result/success result="24-OCILEP"
stdin closed -> exit 0; wt project dir holds only dbd3b62b-....jsonl; the main transcript is intact (32 lines)
```

**Finding 4:** a fork started from another cwd finds the main session once its transcript is copied into that cwd's project dir, and the copy can be deleted as soon as the init frame arrives (the second turn still knew everything).

**Finding 5: stream json input repeats the `system/init` frame at the start of EVERY turn** (same session id). The first run of the spike script crashed deleting the already deleted copy on the second init. The lane manager records the fork id from the first init only and drops the copy idempotently (`test/thread-lanes.test.ts`, "the init frame records the fork id ... once").

## (g) Confinement: what a lane may write (2026-11-01, review finding 1)

**Where:** CLI 2.1.316 on macOS, against a fake Anthropic Messages API on `127.0.0.1` (a local script that answers each request with the next scripted `tool_use` and logs every `tool_result`; no model ran), `CLAUDE_CONFIG_DIR` and `ANTHROPIC_BASE_URL` pointed at throwaway places, `env -i` with a dummy key. The repository was a throwaway one under the home folder (the sandbox lets every command write the temp folders, so a probe under `/tmp` proves nothing: the first round there wrote everywhere), removed afterwards. The lane's worktree was made by `git worktree add` exactly as the daemon does.

**Before (the reviewer's point, confirmed).** Today's lane command with default settings: every `Write`, `Edit` and Bash redirect, inside the worktree or not, was refused ("you haven't granted it yet"), so a working thread could do nothing; and with the owner's permissive settings it would have inherited them.

**The lane now runs** `--restricted --tools <list> --permission-mode acceptEdits --settings <json>` (lib/thread-lane-args.ts `threadLaneArgs`), the settings being `permissions.allow` `Read(//<worktree>/**)`, `Edit(//<worktree>/**)`, `Bash(git add:*)`, `Bash(git commit:*)`, `additionalDirectories: [<worktree>]`, `sandbox: {enabled, autoAllowBashIfSandboxed, allowUnsandboxedCommands: false, filesystem.denyWrite: <source repository state>}` and `remoteControlAtStartup: false`. Measured with that exact command (built by the shipped code):

| Probe | Result |
|---|---|
| `Write` and `Edit` inside the worktree | done |
| `Write` in the main checkout, `Read` there, `Write` elsewhere in the home folder | refused: "is outside <worktree>; --restricted confines the file tools to the working directory" |
| Bash `echo > <worktree>/x` | done |
| Bash `echo > <main checkout>/x`, `python3 open(..., 'w')`, `node writeFileSync` elsewhere | refused by the operating system ("operation not permitted", EPERM) |
| the same with `dangerouslyDisableSandbox: true` | refused (allowUnsandboxedCommands false) |
| Bash write to the source repository's `.git/hooks`, `.git/config` | refused (the CLI's own protection) |
| Bash write to `.git/refs/heads/main`, `.git/index`, another worktree's admin dir | refused once listed in `denyWrite`; **written without it** (the CLI opens a worktree's common git dir to the sandbox) |
| `git add -A`, `git commit -qm x` in the worktree | done, on `hoai/thread-<root>`; the main checkout's HEAD, index and branch unchanged |
| `git -c user.email=... commit` | refused "requires approval" (the allow rule matches `git commit`, not `git -c`) |
| a lane whose cwd is a subfolder of its worktree | writes anywhere in the worktree (the additional directory widens both the file tools and the sandbox) |
| read only lane (`--tools Read,Glob,Grep,WebFetch,WebSearch --permission-mode dontAsk`, deny `Bash,Edit,Write,NotebookEdit`, the agent folder as an additional directory) | `Read` of the agent folder done; `Write`, `Edit`, `Bash`, `NotebookEdit`: "No such tool available ... disabled for this session, in subagents as well as here" |
| a `CLAUDE.md` canary in the main folder | still reached the lane's request (it rides in the forked conversation), although `--restricted` loads no `CLAUDE.md` itself |

**What is guaranteed (as measured on 2.1.316, macOS):** the built in file tools write and read only inside the worktree (a read only lane: read the agent folder, write nothing, no Bash); no user, project or local setting of the owner applies (no permissive allow rule, no hook, no plugin, no Remote Control); Bash, and every program it starts, writes only inside the worktree, the temp folders and the git state a worktree needs, and never the main checkout, its index, HEAD, `packed-refs`, a branch that existed when the lane started (other than its own), or another worktree's admin dir; one tool argument cannot switch the sandbox off; bypass is refused by the CLI under `--restricted`.

**What is NOT guaranteed:**
- Reads by Bash are not confined beyond the secret paths (the sandbox confines writes; `cat <main checkout>/file` worked). The person's own agent reading its own folder is accepted. Refused since the gate review (finding 6, `filesystem.denyRead`, lib/thread-lane-args.ts `laneSecretPaths`): `~/.ssh`, the CLI's `.credentials.json` (in `~/.claude` and in `CLAUDE_CONFIG_DIR`) and `~/.bgos-agent` (with narrow `filesystem.allowRead` entries for an internal workspace and the agent's own email files; the parent denial also covers credentials created after startup). Measured on 2.1.317, macOS, against a fake API: with the shipped settings `cat` of a key in `.ssh` and of `.bgos-agent/credentials-7.json` answered "Operation not permitted" while an ordinary file in the same home read fine; without them both printed. Only paths that exist when the lane starts are named.
- Network: WebFetch, WebSearch and Bash's network follow the CLI's sandbox defaults, not narrowed here.
- A branch or worktree created AFTER the lane started is not in its `denyWrite` list until the lane's next start (each start reads them again). Git objects stay writable (content addressed, a commit needs them). Since the gate review (finding 4) the stash (`refs/stash`, `logs/refs/stash`), `refs/tags`, `refs/remotes`, `refs/notes` and `refs/replace` are refused whole; measured on 2.1.317, macOS: a Bash write into each answered "operation not permitted" (also for the stash and replace paths that did not exist yet) while the lane's own branch stayed writable. On Linux the sandbox binds over real paths only, so before a lane starts the daemon writes each branch kept only in `packed-refs` out as a loose ref (same commit, through a `.lock`) and makes the ref folders; when it cannot, the lane gets no Bash. A repository on the reftable backend (every ref in one place) gets no Bash either. Linux itself was not measured here.
- A host without the CLI's sandbox (no `sandbox-exec` on macOS, no `bwrap` and `socat` on Linux): the lane gets no Bash at all rather than an unconfined one; so does a lane whose repository state cannot be read.
- Linux was not measured here (person lanes measured the same flags on macOS only too); Windows runs no thread lanes in phase 1.
- The lane needs a CLI with `--restricted` (measured 2.1.301 and later). Threads are declared only where lib/threads-cli.ts says the CLI has it (and every other flag a lane and an aside need); a turn or a side question that still reaches an older one fails with that cause in plain words, never the generic "turn failed".
- The CLI process itself (not its tools) created an empty `.claude/` folder in the main checkout and the worktree; nothing was written into it.

## What changed in the builders

- `asideArgs` gains `--tools ""` (Finding 3), and since the gate review (finding 5) `--settings {"disableAllHooks":true}`: measured on 2.1.317, the aside had run the owner's user and project SessionStart, UserPromptSubmit and Stop hooks; with it none runs (also when the project sets it false and adds a local hook) and the answer still arrives. Everything else is as briefed.
- Both builders keep `--mcp-config <empty>` last and take the prompt on stdin (Finding 1).
- `threadLaneArgs` runs every lane confined (section (g)); `assertConfined` refuses a lane command without `--restricted`, `--tools`, `--permission-mode` or `--settings`, or with a bypass or `--add-dir`.

None of this changes the wire contract with BGOS.


## (h) Selective thread hooks and inherited goals (2026-11-06)

Measured on CLI 2.1.319 on macOS with an isolated configuration, a local scripted Messages API and dummy credentials. See `test/thread-lane-goal.test.ts`; run with `THREADS_GOAL_CLAUDE` set to a local CLI executable.

An active `/goal` is restored from the latest `goal_status` attachment, even in a restricted fork. `--settings` with an empty Stop array does not clear that session hook. Turning off all hooks prevents the trusted guards from running, so thread lanes no longer use that switch. The manager changes only the latest active goal attachment in the child transcript to the same `met: true, sentinel: true` attachment that the real `/goal clear` command writes. Transcript UUIDs, parent links, previous verdicts and conversation rows stay intact. The parent file stays byte for byte unchanged. Before a later process resumes an older fork, its own transcript receives the same preparation if needed.

`--restricted` still excludes inherited settings and plugins. The lane explicitly installs the trusted hooks from `hooks/hooks.json`, resolving their script paths from the installed plugin and omitting only the Stop event. The UserPromptSubmit private boundary, PreToolUse floor and private tool guard keep their matchers, timeouts and synchronous execution. All other non-Stop plugin hooks remain too. No parent hook configuration is copied. The aside remains a separate, tool-free command with its existing settings.

The unchanged production command answered in one model request with zero goal checks. For canary coverage, only the test replaces the empty strict MCP configuration with a harmless local fixture tool matching both trusted PreToolUse guards. Wrappers execute the real guard scripts and record their exit status without changing matchers or results. The private prompt boundary and both tool guards executed successfully on the first fork and in a new process resuming the same fork. Both turns ended with zero goal checks. Production still uses an empty strict MCP configuration and its confined built-in tool list.

A control bypassing only child goal preparation restored the active parent into the child copy. The third feedback block caused SIGTERM and exactly one failure reply naming the Stop hook and `/goal`, before the CLI's nine-block fallback. This retains the loop breaker as a second line. These measurements cover this CLI version on macOS; the full suite covers the existing cross-platform argument, permission and hook contracts.
