# A channel-only session writes no transcript, so `--resume` is doomed and the relaunch must reuse the pinned id

**Date:** 2026-08-25

**Context:** Every update restart in the E2E showed TWO gate-helper runs two seconds apart (`start ... attached ... accepted`, twice) and the daemon booted once. The launcher (`bin/hoai-core.mjs`) relaunched with `--resume <pinned>`, Claude Code rejected it immediately (no such conversation), the never-leave-dead fallback minted a NEW pinned id and launched again with `--session-id <new>`.

**Gotcha / Pattern:** Claude Code writes a session transcript to `<config>/projects/<munged cwd>/<id>.jsonl` on the first turn. A channel session that has only ever received channel notifications and made tool calls (`channel_ack`, chat replies through the plugin) had NO transcript anywhere under either config root on CLI 2.1.241. The old rule was "we launched the pinned id, so it exists, resume it"; true for interactive sessions, false here. Cost per restart: a doomed launch plus the loss of the agent's pinned identity (a fresh uuid each time), which is exactly what pinning was meant to prevent.

**How to apply next time:** Let the transcript on disk decide on EVERY relaunch (`sessionTranscriptPath(home, cwd, id, env.CLAUDE_CONFIG_DIR)`): exists means `--resume <id>`, absent means `--session-id <id>` again with the SAME id, never `--continue`. Keep the fresh fallback for a resume that is rejected fast. Verified live: a restart-only job after the fix produced one gate run, the child ran `--session-id f2f33b57...` (the same pinned id), the probe was answered in 36s. Session CONTINUITY across restarts is still not proven (there is nothing to resume); identity (assistant id + cwd + pinned id) is.

**Regression guard:** `test/hoai-supervise.test.ts` (`a marker relaunch of a session with NO transcript creates it again by the SAME id (one launch, pin kept)`; the resume-path tests now seed the transcript explicitly).
