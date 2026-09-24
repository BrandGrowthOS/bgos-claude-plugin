/**
 * The hard floor, rules_version 1: the typed surface of the list.
 *
 * "Always ask before risky actions" is the owner's per agent switch, OFF by
 * default and stored on the server only. With it on, six kinds of action
 * always ask the owner, even under full access:
 *
 *   recursive_delete       deleting a folder and everything in it
 *   force_push             force pushing, which can overwrite history
 *   git_dir_write          changing a file inside .git
 *   env_file_write         changing an .env file
 *   home_dotfile_write     changing a settings file in your home folder
 *   acts_on_owners_behalf  sending, posting or paying on your behalf
 *
 * THE LIST ITSELF LIVES IN lib/hard-floor-core.mjs, and this file re-exports
 * it with types. That is deliberate and it is the whole reason there are two
 * files: the blocking hook (bin/hoai-floor-hook.mjs) runs on a bare `node`,
 * which before 22.18 cannot import TypeScript, so the one implementation has
 * to be plain JavaScript. The daemon (server.ts, under bun) and the tests
 * import THIS file. See the core's header for what the list deliberately
 * does not catch.
 *
 * THE SERVER OWNS THE LIST AND THE SWITCH. backend/src/services/hard-floor.ts
 * is the copy that decides what the owner sees. This mirror is held to it by
 * a shared fixture, lib/hard-floor-fixture.ts, copied byte for byte from the
 * server's (the reconciliation step compares the two files), and the rules
 * version. The switch never reaches this plugin: the relay asks the server a
 * question per matched request (POST .../floor-check, lib/floor-check.ts) and
 * the answer is a decision, not a copy of the setting.
 */

import * as core from './hard-floor-core.mjs'

export type HardFloorRuleId =
  | 'recursive_delete'
  | 'force_push'
  | 'git_dir_write'
  | 'env_file_write'
  | 'home_dotfile_write'
  | 'acts_on_owners_behalf'

export interface HardFloorRule {
  readonly id: HardFloorRuleId
  /** Finishes "{Agent} always asks before this: {words}." on the card. */
  readonly words: string
}

export interface HardFloorMatch {
  ruleId: HardFloorRuleId
  rulesVersion: number
  words: string
  /** What matched: the command segment, the path, or the tool name. */
  evidence: string
}

/** The four input kinds the shared fixture exercises, the same on both sides. */
export type HardFloorInput =
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'request'; toolName: string; inputPreview: string }

export const HARD_FLOOR_RULES_VERSION: number = core.HARD_FLOOR_RULES_VERSION

export const HARD_FLOOR_RULES: readonly HardFloorRule[] =
  core.HARD_FLOOR_RULES as readonly HardFloorRule[]

export const HARD_FLOOR_RULE_IDS: readonly HardFloorRuleId[] = HARD_FLOOR_RULES.map(
  (rule) => rule.id,
)

export const FLOOR_SHELL_TOOLS: readonly string[] = core.FLOOR_SHELL_TOOLS
export const FLOOR_EDIT_TOOLS: readonly string[] = core.FLOOR_EDIT_TOOLS
export const HARD_FLOOR_MAX_TEXT: number = core.HARD_FLOOR_MAX_TEXT

/** The words for a rule id, or null for an id this release does not know. */
export function hardFloorWords(ruleId: string): string | null {
  return HARD_FLOOR_RULES.find((rule) => rule.id === ruleId)?.words ?? null
}

export function classifyFloor(input: HardFloorInput): HardFloorMatch | null {
  return core.classifyFloor(input) as HardFloorMatch | null
}

export function classifyCommand(command: unknown): HardFloorRuleId | null {
  return core.classifyCommand(command) as HardFloorRuleId | null
}

export function commandFloorMatch(
  command: unknown,
): { ruleId: HardFloorRuleId; evidence: string } | null {
  return core.commandFloorMatch(command) as { ruleId: HardFloorRuleId; evidence: string } | null
}

export function classifyPath(filePath: unknown): HardFloorRuleId | null {
  return core.classifyPath(filePath) as HardFloorRuleId | null
}

export function classifyToolName(toolName: unknown): HardFloorRuleId | null {
  return core.classifyToolName(toolName) as HardFloorRuleId | null
}

/** The hook's question: a tool name and its structured input. */
export function classifyToolCall(toolName: unknown, toolInput: unknown): HardFloorMatch | null {
  return core.classifyToolCall(toolName, toolInput) as HardFloorMatch | null
}

/** The relay's question: a tool name and the CLI's `input_preview` string. */
export function classifyPermissionRequest(
  toolName: unknown,
  inputPreview: unknown,
): HardFloorMatch | null {
  return core.classifyPermissionRequest(toolName, inputPreview) as HardFloorMatch | null
}

/** What a permission request's preview says the tool input was. */
export function readToolInput(toolName: unknown, inputPreview: unknown): Record<string, unknown> {
  return core.readToolInput(toolName, inputPreview) as Record<string, unknown>
}

/** One simple command as the shell reader splits it. */
export interface SimpleCommand {
  words: string[]
  stdin: string[]
  pipedFrom: SimpleCommand | null
}

export const lexShell: (text: string) => { commands: SimpleCommand[]; nested: string[] } =
  core.lexShell
export const quoteWords: (words: string[]) => string = core.quoteWords
export const isOwnChannelServer: (server: unknown) => boolean = core.isOwnChannelServer
export const toolNameWords: (name: unknown) => string[] = core.toolNameWords

/** The HOAI channel's own MCP server names, exact (spec 4.2). */
export const HOAI_OWN_SERVERS: readonly string[] = core.HOAI_OWN_SERVERS

/** The CLI's middle cut mark in a preview (truncateForPreview, Claude Code 2.1.281). */
export const PREVIEW_ELISION_RE: RegExp = core.PREVIEW_ELISION_RE

/** True when a permission request's preview carries the CLI's middle cut. */
export function previewIsElided(inputPreview: unknown): boolean {
  return core.previewIsElided(inputPreview) as boolean
}
