# Chat attachment limit audit

Paired-agent chat reply documents and archives accept up to 200 MB (200 * 1024 * 1024 bytes). `server.ts` enforces this before reading or uploading a local file. Its agent instructions, the bundled guide in `lib/capabilities.ts` and the README attachment table now say 200 MB. Upload deadline comments reflect the larger document size.

Inbound chat attachments in `lib/message-text.ts` and `lib/inbound-channel.ts` carry links and metadata without a byte cap. The plugin does not download these files itself. Outbound URL attachments also forward their references without downloading their bytes. Neither path has a 25 MB cap to raise. This checkout has no `src/` directory; implementation helpers live in `lib/`.

## Limits left unchanged

| Location | Limit | Reason |
| --- | --- | --- |
| `server.ts` `SIZE_LIMITS.image` and README | 10 MB | Separate image media limit. |
| `server.ts` `SIZE_LIMITS.video` and README | 100 MB | Separate video media limit. |
| `server.ts` `SIZE_LIMITS.audio` and README | 20 MB | Separate audio media limit. The bundled guide's existing 25 MB audio wording is also outside this document limit change. |
| `server.ts` `S3_THRESHOLD` and README | 5 MB | Selects inline data or a presigned upload, rather than the largest attachment. |
| `lib/lane-daemon.ts` `LANE_INLINE_FILE_MAX_BYTES`, enforced in `lane-server.ts` | 5 MB | The separate person lane only supports inline attachments; raising its cap requires an upload transport change. |
| `lib/boards-tools.ts` `MAX_ATTACH_BYTES` | 25 MB | Board card attachments use a separate API and server limit. |
| `lib/boards-tools.ts` `MAX_DOWNLOAD_BYTES` | 100 MB | Bounds board downloads, not chat attachment downloads. |
| `lib/email-files.ts` `EMAIL_FILE_MAX_BYTES` | 25 MB per file | Inbound email attachment limit. |
| `lib/email-files.ts` `EMAIL_FILES_TOTAL_BYTES` | 25 MB per email | Inbound email aggregate limit. |
| `lib/email-files.ts` `EMAIL_FILES_ROOT_MAX_BYTES` | 1 GB | Retained inbound email files on disk. |
| `lib/email-outbound-files.ts` `AGENT_EMAIL_OUTBOUND_MAX_BYTES` | 25 MB per file and per email | Outbound email limit. Its related tool instructions and upload comments in `server.ts` and `lib/agent-email-tools.ts` remain 25 MB. |
| `lib/email-outbound-content.ts` `OFFICE_TEXT_MAX` and related content checks | 25 MB | Bounds email document text extraction and content scanning. |
| `bin/bgos-claim.mjs` `PACK_ZIP_MAX_BYTES` | 25 MB | Agent pack installation archive, not a ZIP sent through chat. |
| `lib/export-pack.ts` `DEFAULT_MAX_PACK_BYTES` | 26214400 bytes | Default agent pack export limit. |
| `lib/browser-profile-core/profile-file-crypto.js` `MAX_FILE_BYTES` and derived `MAX_CIPHER_BYTES` | 25 MB plaintext, plus encryption overhead | Encrypted Agent Browser file transfer protocol. Staging, file clients and browser download capture inherit this limit; these are separate from BGOS chat. |
| `server.ts` `CAPABILITIES_FETCH_MAX_BYTES` and `BOARDS_FETCH_MAX_BYTES` | 1 MB and 4 MB | Bound JSON capability and board responses. |
| `bin/hoai-floor-hook.mjs` `FLOOR_HOOK_STDIN_MAX_BYTES` | 16 MB | Local floor hook stdin, not chat attachment bytes. |
| `bin/hoai-lane-floor-hook.mjs` `LANE_FLOOR_STDIN_MAX_BYTES` | 16 MB | Local lane floor hook stdin. |
| `bin/hoai-private-turn-hook.mjs` stdin bound | 16 MB | Private tool control payload. |
| `bin/hoai-hook.mjs` `SPOOL_MAX_BYTES` and `PAYLOAD_MAX_BYTES` | 2 MB and 256 KB | Hook event spool and individual event payload. |
| `bin/hoai-statusline-bridge.mjs`, using `lib/model-control-store.mjs` `STATUS_INPUT_MAX_BYTES` | 256 KB | Local status input. |
| `lib/voice-rpc.ts` `VOICE_SPEED_MAX`, `VOICE_INSTRUCTIONS_MAX` and `VOICE_MEMORY_MAX` | 1.5 speed, 2000 and 8000 characters | Live voice configuration and context, not chat document files. |
| `lib/bounded-fetch.ts` `UPLOAD_DEADLINE_MS` | 600000 ms | Shared upload timeout, not a byte limit. Its board attachment references remain 25 MB. |

`test/chat-attachment-limit.test.ts` exercises the shipping resolver with a 200 MB document, rejects both one byte above the limit and 201 MB for text, PDF and ZIP files before any read or upload, and checks 200 MB inbound metadata across socket, poll and stream payloads. It also asserts the preserved media caps and the updated guidance.

The release check in `scripts/check-version-bump.mjs` requires an advance when shipping code changes, so `package.json`, `.claude-plugin/plugin.json` and the changelog advance to patch version 0.86.11.
