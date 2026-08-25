# An unbounded fetch on the startup path is a permanently silent daemon, and an unnarrated startup makes a hang look like a crash

**Date:** 2026-08-25

**Context:** An external tester's agent started, connected to Claude, and never contacted the backend. His daemon log ended at the SAME line on two separate starts, 11:09:40 and 11:15:34, with nothing after either:

```
[bgos] Chat cursor store: ...1041/chat-cursors.json (first run, no cursor file; recent-window backlog gate active)
[bgos] MCP server connected over stdio
```

Server side, the pairing's `last_seen_at` was frozen at 09:12 UTC while those starts happened at 11:09 and 11:15, and five messages sat queued. The process was alive and had never called out. His `hoai doctor` reported `HOAI backend HTTP 200`, so the host could reach the backend.

**Gotcha / Pattern:**

- **Nothing in the daemon was bounded.** `grep -c AbortSignal server.ts` returned **0** across 12 fetch call sites. A socket that connects and then stalls hangs `fetch` forever. Ironically the daemon's own diagnostic already did this right: `bin/bgos-doctor.mjs` `probeBackend` has always used an `AbortController` with a 10s deadline. The tool that only reports was bounded; the process that has to survive was not.
- **The hang was upstream of everything that delivers.** `main()` awaited `loadServedCapabilities()`, then `refreshSlashCommandRegistry()`, then `discoverChats()`, and only then armed the poll loop and the WS. A stall in any of the three meant the daemon never polled again, for the life of the process. Restarting produced the identical log because it re-entered the identical stall.
- **The log could not discriminate a hang from a crash.** `main().catch()` does log `Fatal error: ...`, so in hindsight a throw was already ruled out and a hang was the only shape left, but that reasoning needed someone to read `server.ts`. From the log alone, "stopped after `MCP server connected over stdio`" said nothing about WHICH of three phases stopped. That ambiguity, not the stall, is what cost a user most of a day.
- **`loadServedCapabilities` always logs its outcome** (`Capability canon fetch failed ...` on error, then `Capability canon ready ...` either way). Neither line appeared, which narrows the stall to inside the very first outbound HTTP call the process makes: `GET /integrations/capabilities?channel=claude`.
- **`hoai doctor`'s 200 does not exonerate that call.** The doctor probes `/service-options/health` UNAUTHENTICATED. The daemon's first call is authenticated and to a different route. Reachability of an open health endpoint is not reachability of the authenticated API.
- **Bounding a `fetch` is not enough: `fetch` resolves when the HEADERS land.** A body that stalls mid-stream hangs `response.json()` just as effectively. The deadline has to cover the body read, which is why the shared helper takes a `consume` callback and holds the deadline across it.
- **An abort is not a guarantee, it is a request.** A deadline built only on `AbortController` depends on the transport honouring the signal. The first version of the plain adapter here did exactly that and its own unit test hung, which is what caught it. The deadline is now a race AND an abort: the race releases the caller, the abort frees the socket.
- **A timeout must be distinguishable from a network error.** "The backend accepted the connection and never answered" and "the connection was refused" call for different responses and read completely differently in a log. Hence `FetchTimeoutError` / `isFetchTimeoutError`, with a name-based check so it survives being thrown across the bun and node module boundary this repo's mixed suite creates.
- **A warm-up must never gate delivery.** The capability canon has a bundled fallback, so waiting on it buys nothing a fallback does not already give. It now runs in the background. The slash-command registry is different: it has a genuine ordering reason to run first (an inbound slash command delivered before the registry exists routes wrong), so it stays awaited but bounded, and a deadline lets startup proceed without it. `discoverChats` stays awaited because it is not a warm-up at all: it decides what there is to poll, and a boot that discovers nothing self-heals on the next full cycle.

**How to apply next time:**

- Any new outbound call goes through `bgosCall` (server.ts) or `boundedFetch` (`lib/bounded-fetch.ts`). Do not hand-roll a deadline at a call site, and never add a bare `await fetch(` to the daemon; a source-contract test fails if one comes back.
- Pick the deadline per USE and say why in a comment. The ordinary bound is 30s (the edge closes idle connections at 60s). A startup warm-up with a fallback gives up in 8s. `send_to_peer` is the one bound that must sit ABOVE the ordinary one, because the backend deliberately holds that request open for up to 50s.
- Before adding anything to `main()` between the transport connect and the poll loop, ask whether it can fail without harming message delivery. If it can, it does not belong on the awaited path. If it must be awaited, bound it.
- Wrap every startup step in `startupPhase`. The rule that makes a log readable: a phase with a `start` and no `ok` names the hang; a `FAILED` line names the throw and carries its message; the absence of `startup complete: polling armed, message delivery is live` means delivery never came up.
- When a diagnostic and the daemon disagree, check whether they are even calling the same thing. Authenticated versus unauthenticated, and one route versus another, is exactly where "doctor says 200" stops being evidence.

**Regression guard:** `test/bounded-fetch.test.ts` (18 tests: the deadline fires and is logged, it covers the body read, it releases the caller even when the transport ignores the abort, and a connection failure is NOT reported as a timeout) and `test/startup-reaches-poll.test.ts` (13 tests: a mirror of `main()`'s startup reaches the polling phase with a warm-up that hangs, one that throws, and a registry walk that hangs, plus source contracts pinning that the warm-up is not awaited, the registry stays bounded, every phase is narrated, and no bare `await fetch(` returns to `server.ts`). Ten compiling mutants, all killed.
