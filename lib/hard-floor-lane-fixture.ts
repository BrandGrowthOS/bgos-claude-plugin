/**
 * Cross-repo LANE floor fixture, rules_version 4 (person lanes, shared agents
 * Phase 3; design 2026-10-15 section 7.2 item 8).
 *
 * The cases a person's lane floor must answer, written once. The backend's
 * classifier (src/services/hard-floor-lane.ts) runs them here from P2; the
 * Claude Code plugin's copy of this file runs them against its own lane hook
 * from P3, BYTE IDENTICAL, as hard-floor-fixture.ts already is for the
 * owner's list. Each repo pins the sha256 of its own copy in its spec, so a
 * byte changed on one side turns that side red until the pair is reconciled.
 *
 * A case is a permission request as the CLI sends it (a tool name and its
 * input preview), the lane's person, and the rule id the lane answer must
 * carry, or null to proceed. Version 3's rule ids win where both lists match.
 *
 * No imports. LF line endings. No em or en dashes.
 */

export const HARD_FLOOR_LANE_FIXTURE_RULES_VERSION = 4;

export interface HardFloorLaneCase {
  readonly name: string;
  readonly toolName: string;
  readonly inputPreview: string;
  readonly actorUserId: string;
  readonly expected: string | null;
}

const ME = 'user_lanecase_me';

export const HARD_FLOOR_LANE_FIXTURE: readonly HardFloorLaneCase[] = [
  // Secrets of the owner, read through any tool.
  {
    name: 'read an ssh key',
    toolName: 'Read',
    inputPreview: '{"file_path":"/Users/kc/.ssh/id_ed25519"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'grep the aws folder',
    toolName: 'Grep',
    inputPreview: '{"pattern":"key","path":"~/.aws"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'gcloud credentials',
    toolName: 'Read',
    inputPreview: '{"file_path":"/home/kc/.config/gcloud/credentials.db"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'gnupg',
    toolName: 'Glob',
    inputPreview: '{"pattern":"**/*","path":"$HOME/.gnupg"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'the home claude folder',
    toolName: 'Read',
    inputPreview: '{"file_path":"/Users/kc/.claude/.credentials.json"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'the home claude json',
    toolName: 'Read',
    inputPreview: '{"file_path":"~/.claude.json"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'an env file anywhere',
    toolName: 'Read',
    inputPreview: '{"file_path":"/Users/kc/project/.env.local"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a windows env file',
    toolName: 'Read',
    inputPreview: '{"file_path":"C:\\\\Users\\\\kc\\\\app\\\\.env"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: "the agent's browser profile",
    toolName: 'Read',
    inputPreview:
      '{"file_path":"/Users/kc/.bgos-agent/1076/browser/owner/Cookies"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: "another person's lane",
    toolName: 'Read',
    inputPreview:
      '{"file_path":"/Users/kc/.bgos-agent/1076/people/user_other/work/notes.md"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'the people folder itself',
    toolName: 'Glob',
    inputPreview: '{"pattern":"*","path":"/Users/kc/.bgos-agent/1076/people"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'the plugin state',
    toolName: 'Read',
    inputPreview:
      '{"file_path":"/Users/kc/.bgos-plugin-state/1076/chat-cursors.json"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a credentials file',
    toolName: 'Read',
    inputPreview: '{"file_path":"/Users/kc/.bgos-agent/credentials-1076.json"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a macOS keychain',
    toolName: 'Read',
    inputPreview:
      '{"file_path":"/Users/kc/Library/Keychains/login.keychain-db"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a shell read of a key, if a policy ever allows the shell',
    toolName: 'Bash',
    inputPreview: '{"command":"cat ~/.ssh/id_rsa"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a relative climb to the home claude folder',
    toolName: 'Read',
    inputPreview: '{"file_path":"../../../../.claude/settings.json"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  // A climb is resolved before the path is judged: `..` out of the lane's
  // own folder lands where it lands, and a relative climb above the folder
  // the command runs in (unknown to the floor) is held.
  {
    name: "a climb out of my own lane into another person's",
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/../user_other/work/notes.md"}`,
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: "a climb out of my own lane to the agent's browser profile",
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/work/../../../browser/Default/Cookies"}`,
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a climb out of my own lane to the home claude folder',
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/work/../../../../../.claude/settings.json"}`,
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a relative climb above the working folder, to anywhere',
    toolName: 'Bash',
    inputPreview: '{"command":"cat ../../user_other/work/notes.md"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  {
    name: 'a climb above home, into another account',
    toolName: 'Read',
    inputPreview: '{"file_path":"~/../another_account/notes.md"}',
    actorUserId: ME,
    expected: 'reads_a_secret',
  },
  // The lane's own folder and its own work are not secrets.
  {
    name: 'a step down and back up, inside my own lane',
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/work/drafts/../notes.md"}`,
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'a step down and back up, relative',
    toolName: 'Read',
    inputPreview: '{"file_path":"./work/drafts/../plan.md"}',
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'my own lane folder',
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/work/notes.md"}`,
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'my own skills, relative',
    toolName: 'Read',
    inputPreview: '{"file_path":".claude/skills/recipe/SKILL.md"}',
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'my own skills, inside my lane',
    toolName: 'Read',
    inputPreview: `{"file_path":"/Users/kc/.bgos-agent/1076/people/${ME}/work/.claude/skills/x/SKILL.md"}`,
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'a plain work file',
    toolName: 'Write',
    inputPreview: '{"file_path":"work/plan.md","content":"hello"}',
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'a web search',
    toolName: 'WebSearch',
    inputPreview: '{"query":"weather in Dubai"}',
    actorUserId: ME,
    expected: null,
  },
  {
    name: 'a file merely named like the folder',
    toolName: 'Read',
    inputPreview: '{"file_path":"docs/ssh-setup.md"}',
    actorUserId: ME,
    expected: null,
  },
  // Version 3's list still answers first, by its own rule ids.
  {
    name: 'a recursive delete',
    toolName: 'Bash',
    inputPreview: '{"command":"rm -rf build"}',
    actorUserId: ME,
    expected: 'recursive_delete',
  },
  {
    name: 'writing an env file is version 3',
    toolName: 'Write',
    inputPreview: '{"file_path":"/Users/kc/app/.env","content":"A=1"}',
    actorUserId: ME,
    expected: 'env_file_write',
  },
];
