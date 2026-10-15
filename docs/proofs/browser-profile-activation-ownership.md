# Physical activation and socket proof ownership

A held-engine regression reproduced a separate race: native activation opened the restored page before engine startup and socket proof completed, so the independent monitor could begin another proof during the original activation. This was demonstrated in a copied Companion fixture and is separate from the valid Socket.IO identifier rejection found in the actual two-machine trace.

The Companion now captures private ownership before its first activation await. Exact concurrent activation calls share one promise; a changed runtime or full authority refuses. Monitoring waits for the original activation. Concurrent proof calls share only the exact original runtime, RPC endpoint, socket and authority. Completed ownership is cleared so a previously proved runtime can reconnect normally after an actual endpoint disconnect. Failed partial activation cannot automatically restart.

Activity reports pending activation and proof promises. Disposal cancels activation, starts native disposal independently, and waits for the original engine creation, activation and proof work before clearing ownership. Normal daemon stop also starts that native cleanup before awaiting a held activation producer. No activation catch awaits its own Companion disposal.

Nine new cases cover held engine and socket proof, exact promise identity, crossed authority and socket, independent physical cleanup, failed partial activation, and legitimate reconnect. The 43 Companion cases and the four related suites totaling84 cases pass with no skips. TypeScript `--noEmit` exits0. Twelve copied-source executable mutations print the changed line, fail, restore exact bytes, and pass; their complete receipt is in `browser-profile-activation-ownership.json`.

The tests use actual Companion and runtime endpoint code with synthetic native runtime, engine and socket callbacks. They do not establish fresh Linux or full HOAI acceptance. Those require the final immutable package and separate two-machine run. Raw private receipts: `.tmp/activation-drills-4b7ffdb3/report.json` and `.tmp/activation-race-diagnostic.txt`.
