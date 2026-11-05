# Owner-session model and effort controls

Status: proposal for Kc or Data approval. This draft changes no runtime permission, capability advertisement, terminal input, settings file, or supervisor behavior. BGOS keeps the Claude picker hidden. It addresses Ares round 1 on [BGOS #3060](https://github.com/BrandGrowthOS/BGOS/pull/3060).

## Feasibility and source evidence

| Route | What exists | Missing proof or work | Decision |
| --- | --- | --- | --- |
| A: owner terminal | `lib/compact-inject.ts` builds argv for fixed compact/goal operations; `resolveTmuxTarget` identifies the supervisor's pane and socket. `lib/compact-confirm.ts` confirms compact through a real transcript boundary. | No model/effort command builder, owner consent specific to these operations, empty-composer guarantee, settings acknowledgement, or Ultra Code status parser exists. | Preferred proposal for managed tmux owner sessions. Add exactly two typed operations only after approval and a trustworthy live status source. No arbitrary command API. |
| B: supervisor restart | `lib/lane-controls.ts` writes lane choices and requests restart. `lib/lane-core.mjs` validates the five ordinary efforts and resumes an exact pinned session. `bin/bgos-agent` owns the owner process and also pins/resumes its session. | The lane's paths, identity, policy and restart request are not an owner control API. Owner restart would interrupt work and reconnect the daemon; it needs a distinct consent and transaction. The current lane whitelist rejects ultracode. | Not an equivalent live switch. Could be a separately approved, explicitly labeled "Restart with settings" action at idle, with exact-session resume and post-start confirmation. Not the picker fallback. |

Baseline: `457210c` of the Claude plugin. Local offline CLI check reports Claude Code 2.1.308; no session was started.

The [status-line documentation](https://code.claude.com/docs/en/statusline) describes session_id, model.id and a live effort.level, including changes during a session. Its documented fields do not expose a separate Ultra Code flag. The current plugin's `lib/session-status.ts` reports liveness counts, not these settings. Neither it nor a compact transcript boundary proves a settings change.

The [current model documentation](https://code.claude.com/docs/en/model-config) now describes Ultra Code as a separate workflow setting. Newer CLIs accept `--effort ultracode`, but ordinary max remains distinct. That updates the older blanket claim about CLI flags; it does not make this repository's lane whitelist or owner restart path support it. The host's actual supported values and acknowledgements must decide availability.

## Route A: proposed permission and allowlist

An owner explicitly opts this assistant into remote model/effort terminal control. Existing remote-compact permission alone is insufficient. Backend ownership, main-chat identity, human principal and idle checks precede a typed command. The daemon repeats owner/session checks and holds an exclusive control lock against restart, compact, goal injection and incoming deliveries.

Permit only two operation kinds: `set_model` and `set_effort`. Build their text inside `compact-inject.ts`; never accept a slash command or concatenated user text on the wire.

- `set_model`: one discovered and owner-allowed family token, initially restricted to exact `opus`, `sonnet`, `haiku`, or `fable`. The frozen literal table maps each token to `/model <family>`. Supporting another family requires a deliberate allowlist change and host discovery.
- `set_effort`: one exact ordinary level `low`, `medium`, `high`, `xhigh`, or `max`, or `ultracode` only when the host can both apply and independently confirm it. Map these to fixed `/effort <level>` literals. No suffix, whitespace, newline, escape, arbitrary model ID, `off`, or command chaining is accepted in this first permission.
- Use argv execution and the existing validated, supervisor-owned socket and exact pane ID. Confirm the pane's process/session identity immediately before typing. Reject a shell prompt, permission dialog, unknown foreground process, nonempty draft, lost pane, active turn or identity change. Do not send Escape to discard user input.
- The current generic two-Enter sequence cannot be assumed safe for interactive model menus. Validate command-specific submission on the supported CLI version in an isolated terminal harness before enabling it. A second Enter can accept a different menu item and must not be copied blindly.

## Confirmation transaction

1. Obtain a fresh session-originated baseline containing exact session ID, resolved model ID, effort, runtime version and a monotonically increasing local observation sequence. A daemon cache, launch flag, echoed input, settings file, success exit code, or assistant prose is not confirmation.
2. For ordinary settings, an opt-in status-line bridge is a candidate: consume the CLI's own JSON locally and preserve the user's existing status-line output. Installing or composing that command is part of the approval, never a silent overwrite. Store only required settings facts in an owner-only location, outside project-writable files; bound input and refuse symlinks. A hostile process with the same OS identity remains outside this guarantee.
3. After each fixed command, require a newer observation from the same session with the requested setting. Map an alias to a resolved model only through the discovered host catalog. No next model turn is sent merely to produce evidence.
4. Ultra Code needs a separate native flag or independently parsed session-native status with a real fixture from the supported CLI. `effort.level === "xhigh"` does not confirm Ultra Code. Without that evidence, disable it with "This host cannot confirm Ultra Code remotely."
5. Apply model before effort and confirm both. Only then persist a confirmed report and post a success note. If the second operation fails, report the actual partial state and attempt a rollback only through the same checked transaction. If rollback cannot be confirmed, mark current state unknown; never claim the old state was restored.

## Failure modes and acceptance before enabling

Timeout, unsupported CLI output, unavailable status-line hooks, changed session, policy refusal, offline daemon, occupied composer, busy turn and partial application all return typed failures. No retry types a command into an uncertain terminal. Capability remains absent until the permission, safe target, catalog and confirmation source all pass preflight; losing one withdraws it.

Required isolated tests: exact literal allowlist including injection attempts; stale session and stale observation; false success from echoed input; ordinary xhigh versus Ultra Code; a simulated occupied composer; model success followed by effort failure; rollback failure; restart during acknowledgement; owner/recipient and main/side-chat boundaries. A fake terminal/session can prove transport mechanics without a model API. A real offline CLI fixture is still needed to prove its interactive status format and draft safety before a runtime implementation advertises support.

Route B additionally needs a stopped/started identity ledger, idle-only transition, exact pinned-session resume, preservation of pending deliveries and failed-start recovery. It must say that it restarts the owner session. Current lane code cannot be reused as an owner authorization shortcut, and its existing effort whitelist cannot reach Ultra Code.

No merge or activation is authorized by this proposal. Kc or Data approves the permission design before a separately reviewed runtime implementation is enabled.
