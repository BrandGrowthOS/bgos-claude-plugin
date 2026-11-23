# A fake never holds a real agent's history

**What happened.** 0.86.2 cleared an inherited `/goal` in a thread's copy of the main transcript by reading the whole file into one string, parsing every line and writing it back, synchronously in the daemon. Every unit test passed: the fake file system's transcript was one line. On a real agent, whose main session had run for days, the first thread message took the daemon down (0.87.0), and again after each restart.

**Rule.** Anything the daemon reads from a session transcript is sized by how long the agent has lived, not by the test. Read it in bounded pieces (a tail, a backwards scan, a stream), never whole, and never synchronously on the event loop. And a feature that spawns the real CLI on a real session needs one live test that runs the real CLI on a real sized session before it ships.

**Where.** `lib/thread-transcript.ts`, `test/thread-transcript.test.ts` (byte equality with the string rule at every chunk size, bounded memory on 160 MB), `test/thread-live.e2e.test.ts` (the real daemon and CLI on a 300 MB transcript: 1482 MB of growth on 0.87.0), `docs/release-checklist.md`.
