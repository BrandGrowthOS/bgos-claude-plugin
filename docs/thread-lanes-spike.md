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

## What changed in the builders

- `asideArgs` gains `--tools ""` (Finding 3). Everything else is as briefed.
- Both builders keep `--mcp-config <empty>` last and take the prompt on stdin (Finding 1).
- `threadLaneArgs` is unchanged from the brief.

None of this changes the wire contract with BGOS.
