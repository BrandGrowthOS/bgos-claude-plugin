# /steer interrupt proof (0.64.0, 2026-10-09, macOS, Claude Code 2.1.295)

The question: can the daemon interrupt a running Claude Code turn? A channel
notification alone cannot: sent during a 60 s foreground command it was read
only after the command returned (probe-channel.ts, the `plain` mode). The
CLI's own Escape key, pressed through `tmux send-keys` into the CLI's pane,
interrupts the turn ("Interrupted"), and a channel message sent before or
after that Escape is answered at once. One Escape on an idle CLI changes
nothing (a draft in the composer survives it).

The live run used THIS daemon (server.ts 0.64.0, final code) in a real session
inside tmux, against a local stand-in backend (fake-backend.ts) so nothing
touched production. The forwarder hooks were wired by a settings file so the
daemon's hook rail reported live and idle.

- `daemon.log`: `steer: plain (idle)` for the idle steer, `steer: interrupted
  (turn_live)` for the steer sent during `python3 -c 'import time;time.sleep(150)'`.
- `daemon-backlog-run.log`: an earlier run where a steer arrived as backlog
  after a restart: `steer: plain (stale)`, delivered with no key.
- `transcript-excerpt.txt`: the session transcript: the Bash call rejected
  with `[Request interrupted by user for tool use]` at 19:45:22.591, the steer
  card (`steer="true"`) at 19:45:23.345, `reply` "STEERED 51" at 19:45:24.593.
  The idle steer's card carries no `steer` marker (nothing was interrupted).
- `fake-backend.log`: what the backend saw, ending in `REPLY "STEERED 51"`.
- `pane.txt`: the terminal at the end.

Paths are redacted. The stand-in has no WebSocket, so the daemon read messages
on its 10 s poll fallback; that, not the steer, is the gap between a message
being added and the daemon logging it.
