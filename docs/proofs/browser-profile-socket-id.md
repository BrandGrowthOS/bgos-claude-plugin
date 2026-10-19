# Socket transport identifier repair

The runtime socket identifier uses the Socket.IO base64url alphabet. A valid leading underscore or hyphen previously failed the agent permission and shared runtime validators. The dedicated shared predicate now accepts exactly 1 to 64 base64url characters without normalization. General actor and runtime identifiers retain their existing grammar.

The sixteen shared core modules are pinned to committed BGOS source `f6b5f0c0bde1c7f1c28dc664985c2a7e9a330715`. The permission client uses that predicate at its original binding check. Signed request, read and consume tests retain the exact socket identifier; malformed identifiers fail before HTTP.

Validation: 61 selected tests passed with no skips, TypeScript `--noEmit` passed, and an independent review ran 18 permission and cross-tree vendor tests successfully. The shared BGOS change separately has fourteen executable mutation drills. The attached plugin mutation receipt changes the real copied permission guard to reject all bindings, records assertion failure, restores the exact bytes and records all sixteen permission tests passing. The working source is unchanged by the drill. An initial reporter-format check failed before any mutation and is excluded.

This repair does not establish a completed browser round trip. The disposable two-machine acceptance and final packaged Codex acceptance remain separate requirements.
