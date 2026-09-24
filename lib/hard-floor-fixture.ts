/**
 * Cross-repo hard floor fixture, rules_version 1 (P2 stage 6, C-19).
 *
 * THE ANTI-DRIFT GUARD, on the secret-scan pattern. The floor list ("Always
 * ask before risky actions") is implemented twice: once in the platform
 * backend (backend/src/services/hard-floor.ts, jest), which stamps the floor
 * block on a request card and answers the relay's floor check, and once in
 * the Claude Code plugin (lib/hard-floor-core.mjs behind lib/hard-floor.ts,
 * node test), where a blocking hook and the permission relay decide whether
 * to ask. If they disagree, the plugin lets an action through that the server
 * would have held, or holds one the server then waves on, and the owner's
 * card says one thing while the machine does another.
 *
 * ONE FILE, ONE SCHEMA, TWO CASE LISTS, ONE DIGEST EACH. This file is BYTE
 * IDENTICAL in both repos (backend src/services/hard-floor-fixture.ts and
 * plugin lib/hard-floor-fixture.ts, which the plugin's .gitattributes keeps
 * at LF on a Windows checkout). It imports nothing, so it compiles
 * unchanged in both. HARD_FLOOR_FIXTURE's four input kinds are the four both
 * classifiers take as they are: a shell command, a file path the action
 * writes, a tool name, and a permission request as the Claude Code CLI sends
 * it (a tool name plus its input rendered as JSON, possibly cut short).
 * HARD_FLOOR_CARD_FIXTURE is the card kind: an approval card's `tool` string,
 * which the server's card reader must read as stated and, for a card the
 * Claude Code relay writes, which the plugin's card builder must produce
 * from the stated inputs, byte for byte.
 *
 * WHAT EACH SUITE CAN AND CANNOT SEE. Each repo's spec runs ITS classifier
 * over every case (and its card reader, or its card builder, over the card
 * cases), asserts its own rule ids, words and version equal the ones below,
 * recomputes the three data digests, and compares them with the constants
 * below AND with a literal pinned in that spec file. It ALSO pins the sha256
 * of this FILE'S BYTES as a literal, so a byte changed anywhere in one copy
 * (a comment, a type, this header) turns that repo's suite red until its
 * literal moves; the data digests alone let a comment drift on one side stay
 * green on both. Neither suite can read the other repo, so neither can prove
 * the other copy is the same: THE CROSS REPO CHECK IS THE RECONCILIATION
 * STEP, where this file is copied byte for byte (cmp says nothing) and the
 * two specs' literals are compared. A regeneration therefore shows up as a
 * visible diff in SIX places (this file and one spec's literals, in each
 * repo), never as a silent green.
 *
 * To change the list: update BOTH classifiers, regenerate this file in ONE
 * place and copy it to the other, update the digest literals and the file
 * sha256 literal in BOTH specs, and bump the rules version on both sides when
 * what a rule matches changes after a release has shipped it.
 *
 * The cases quote real inputs where there are real inputs: the part 24 live
 * probe's Claude Code input previews, the subagent housekeeping the CLI runs
 * through the same hook (`git status --short`, `true`), and the Codex
 * daemon's command shapes. Where the two first copies disagreed (a quoted
 * mention of `rm -rf`, a file two folders down `~/.config`, a `Read` of
 * `.env`), the case follows spec section 4.2: a mention is not the action,
 * a home settings file is directly in home or directly in a dot folder of
 * it, and only a write is a change.
 */

export interface HardFloorFixtureRule {
  id: string;
  words: string;
}

export type HardFloorFixtureInput =
  | { kind: "command"; command: string }
  | { kind: "path"; path: string }
  | { kind: "tool"; toolName: string }
  | { kind: "request"; toolName: string; inputPreview: string };

export interface HardFloorFixtureCase {
  /** Human name for the case, used in test output. Unique, snake case. */
  name: string;
  input: HardFloorFixtureInput;
  /** The rule both classifiers must report, or null when neither may match. */
  ruleId: string | null;
}

/**
 * What produced a card string: the Claude Code relay (the plugin's
 * `permissionCardTool`, from the three inputs in `relay`), or the Codex
 * daemon (codex-channel-bgos: a file change card's `toolLines`, or a command
 * card's command text), whose writer lives in neither of these two repos.
 */
export type HardFloorFixtureCardWriter =
  | "claude_relay"
  | "codex_file_change"
  | "codex_command";

/** The relay's inputs for one permission request, as `permissionCardTool` takes them. */
export interface HardFloorFixtureRelayInput {
  toolName: string;
  inputPreview: string;
  floorEvidence?: string;
}

export interface HardFloorFixtureCardCase {
  /** Human name for the case, used in test output. Unique, snake case. */
  name: string;
  writer: HardFloorFixtureCardWriter;
  /** For a `claude_relay` card only: what the relay was given. */
  relay?: HardFloorFixtureRelayInput;
  /** `approvalMeta.tool`, exactly as the card carries it. */
  tool: string;
  /** The rule the server's card reader must stamp, or null for none. */
  ruleId: string | null;
}

/** The cross repo key. Both classifiers export the same number. */
export const HARD_FLOOR_FIXTURE_RULES_VERSION = 1;

export const HARD_FLOOR_FIXTURE_RULES: HardFloorFixtureRule[] = [
  { id: "recursive_delete", words: "deleting a folder and everything in it" },
  { id: "force_push", words: "force pushing, which can overwrite history" },
  { id: "git_dir_write", words: "changing a file inside .git" },
  { id: "env_file_write", words: "changing an .env file" },
  {
    id: "home_dotfile_write",
    words: "changing a settings file in your home folder",
  },
  {
    id: "acts_on_owners_behalf",
    words: "sending, posting or paying on your behalf",
  },
];

export const HARD_FLOOR_FIXTURE: HardFloorFixtureCase[] = [
  {
    name: "rm_rf",
    input: { kind: "command", command: "rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_fr",
    input: { kind: "command", command: "rm -fr build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_r",
    input: { kind: "command", command: "rm -r build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_capital_r",
    input: { kind: "command", command: "rm -R build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_recursive_long_option",
    input: { kind: "command", command: "rm --recursive build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_rfv_cluster",
    input: { kind: "command", command: "rm -rfv build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_flag_after_operand",
    input: { kind: "command", command: "rm build -r" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_by_absolute_path",
    input: { kind: "command", command: "/bin/rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "sudo_rm_rf",
    input: { kind: "command", command: "sudo rm -rf /var/tmp/cache" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_after_and",
    input: { kind: "command", command: "cd app && rm -rf node_modules" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_after_semicolon",
    input: { kind: "command", command: "ls; rm -rf dist" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_inside_bash_c",
    input: { kind: "command", command: 'bash -c "rm -rf build"' },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_inside_subshell",
    input: { kind: "command", command: "(cd app; rm -rf build)" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_inside_command_substitution",
    input: { kind: "command", command: "echo $(rm -rf build)" },
    ruleId: "recursive_delete",
  },
  {
    name: "find_exec_rm_rf",
    input: { kind: "command", command: "find . -name tmp -exec rm -rf {} +" },
    ruleId: "recursive_delete",
  },
  {
    name: "xargs_rm_rf",
    input: { kind: "command", command: "ls | xargs rm -rf" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_rf_continued_line",
    input: { kind: "command", command: "rm -rf \\\n  build" },
    ruleId: "recursive_delete",
  },
  {
    name: "quoted_mention_does_not_ask",
    input: { kind: "command", command: 'grep -rn "rm -rf" scripts' },
    ruleId: null,
  },
  {
    name: "powershell_remove_item_recurse",
    input: { kind: "command", command: "Remove-Item -Recurse -Force build" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_remove_item_path_then_recurse",
    input: { kind: "command", command: "Remove-Item -Path .\\build -Recurse" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_remove_item_lowercase",
    input: { kind: "command", command: "remove-item build -recurse" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_rm_alias_recurse",
    input: { kind: "command", command: "rm build -Recurse" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_ri_alias_recurse_prefix",
    input: { kind: "command", command: "ri build -rec" },
    ruleId: "recursive_delete",
  },
  {
    name: "pwsh_command_remove_item",
    input: {
      kind: "command",
      command: 'pwsh -Command "Remove-Item -Recurse build"',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "cmd_rmdir_s",
    input: { kind: "command", command: "rmdir /s /q build" },
    ruleId: "recursive_delete",
  },
  {
    name: "cmd_rd_capital_s",
    input: { kind: "command", command: "rd /S build" },
    ruleId: "recursive_delete",
  },
  {
    name: "cmd_rd_combined_flags",
    input: { kind: "command", command: "rd /s/q build" },
    ruleId: "recursive_delete",
  },
  {
    name: "cmd_c_rd_s",
    input: { kind: "command", command: 'cmd /c "rd /s /q build"' },
    ruleId: "recursive_delete",
  },
  {
    name: "git_push_force",
    input: { kind: "command", command: "git push --force origin main" },
    ruleId: "force_push",
  },
  {
    name: "git_push_f",
    input: { kind: "command", command: "git push -f origin main" },
    ruleId: "force_push",
  },
  {
    name: "git_push_force_last",
    input: { kind: "command", command: "git push origin main --force" },
    ruleId: "force_push",
  },
  {
    name: "git_push_force_with_lease",
    input: { kind: "command", command: "git push --force-with-lease" },
    ruleId: "force_push",
  },
  {
    name: "git_push_force_with_lease_value",
    input: {
      kind: "command",
      command: "git push --force-with-lease=main:abc123 origin main",
    },
    ruleId: "force_push",
  },
  {
    name: "git_push_cluster_uf",
    input: { kind: "command", command: "git push -uf origin feature" },
    ruleId: "force_push",
  },
  {
    name: "git_push_plus_refspec",
    input: { kind: "command", command: "git push origin +main" },
    ruleId: "force_push",
  },
  {
    name: "git_dash_c_push_force",
    input: { kind: "command", command: "git -C repo push -f" },
    ruleId: "force_push",
  },
  {
    name: "force_push_after_commit",
    input: {
      kind: "command",
      command: "git commit -m wip && git push --force",
    },
    ruleId: "force_push",
  },
  {
    name: "delete_and_force_push_names_the_delete",
    input: {
      kind: "command",
      command: "git push -f origin main; rm -rf build",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "git_status",
    input: { kind: "command", command: "git status --short" },
    ruleId: null,
  },
  {
    name: "rm_single_file",
    input: { kind: "command", command: "rm file.txt" },
    ruleId: null,
  },
  {
    name: "rm_force_single_file",
    input: { kind: "command", command: "rm -f file.txt" },
    ruleId: null,
  },
  {
    name: "rm_interactive_verbose",
    input: { kind: "command", command: "rm -iv notes.md" },
    ruleId: null,
  },
  {
    name: "rm_file_named_dash_r",
    input: { kind: "command", command: "rm -- -r" },
    ruleId: null,
  },
  {
    name: "git_rm_recursive_is_git",
    input: { kind: "command", command: "git rm -r --cached build" },
    ruleId: null,
  },
  {
    name: "rmdir_empty_folder",
    input: { kind: "command", command: "rmdir build" },
    ruleId: null,
  },
  {
    name: "powershell_remove_item_file",
    input: { kind: "command", command: "Remove-Item build.log" },
    ruleId: null,
  },
  {
    name: "powershell_rm_force_is_not_recurse",
    input: { kind: "command", command: "rm -Force build.log" },
    ruleId: null,
  },
  {
    name: "ls_recursive_is_not_delete",
    input: { kind: "command", command: "ls -R build" },
    ruleId: null,
  },
  {
    name: "git_push_plain",
    input: { kind: "command", command: "git push origin main" },
    ruleId: null,
  },
  {
    name: "git_push_set_upstream",
    input: { kind: "command", command: "git push -u origin feature" },
    ruleId: null,
  },
  {
    name: "git_fetch_force_is_not_push",
    input: { kind: "command", command: "git fetch --force origin" },
    ruleId: null,
  },
  {
    name: "echo_harmless",
    input: { kind: "command", command: "echo laneq-harmless-echo" },
    ruleId: null,
  },
  {
    name: "subagent_true",
    input: { kind: "command", command: "true" },
    ruleId: null,
  },
  {
    name: "git_dir_config",
    input: { kind: "path", path: "/work/repo/.git/config" },
    ruleId: "git_dir_write",
  },
  {
    name: "git_dir_hook_windows",
    input: { kind: "path", path: "C:\\work\\repo\\.git\\hooks\\pre-commit" },
    ruleId: "git_dir_write",
  },
  {
    name: "git_dir_relative",
    input: { kind: "path", path: ".git/info/exclude" },
    ruleId: "git_dir_write",
  },
  {
    name: "gitignore_is_not_git_dir",
    input: { kind: "path", path: "/work/repo/.gitignore" },
    ruleId: null,
  },
  {
    name: "github_folder_is_not_git_dir",
    input: { kind: "path", path: "/work/repo/.github/workflows/ci.yml" },
    ruleId: null,
  },
  {
    name: "git_entry_itself_is_not_inside",
    input: { kind: "path", path: "/work/repo/.git" },
    ruleId: null,
  },
  {
    name: "env_file",
    input: { kind: "path", path: "/work/repo/.env" },
    ruleId: "env_file_write",
  },
  {
    name: "env_local_in_subfolder",
    input: { kind: "path", path: "/work/repo/apps/web/.env.local" },
    ruleId: "env_file_write",
  },
  {
    name: "env_production_windows",
    input: { kind: "path", path: "C:\\work\\repo\\.env.production" },
    ruleId: "env_file_write",
  },
  {
    name: "env_example_asks_too",
    input: { kind: "path", path: "/work/repo/.env.example" },
    ruleId: "env_file_write",
  },
  {
    name: "envrc_is_not_env",
    input: { kind: "path", path: "/work/repo/.envrc" },
    ruleId: null,
  },
  {
    name: "named_env_suffix_is_not_env",
    input: { kind: "path", path: "/work/repo/config/prod.env" },
    ruleId: null,
  },
  {
    name: "env_module_is_not_env",
    input: { kind: "path", path: "/work/repo/src/env.ts" },
    ruleId: null,
  },
  {
    name: "home_env_is_env_first",
    input: { kind: "path", path: "/home/kc/.env" },
    ruleId: "env_file_write",
  },
  {
    name: "home_bashrc_tilde",
    input: { kind: "path", path: "~/.bashrc" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_ssh_config_linux",
    input: { kind: "path", path: "/home/kc/.ssh/config" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_gitconfig_windows",
    input: { kind: "path", path: "C:\\Users\\kc\\.gitconfig" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_zshrc_macos",
    input: { kind: "path", path: "/Users/kc/.zshrc" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_claude_settings",
    input: { kind: "path", path: "/home/kc/.claude/settings.json" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_xdg_config_file_is_too_deep",
    input: { kind: "path", path: "/home/kc/.config/gh/hosts.yml" },
    ruleId: null,
  },
  {
    name: "home_windows_seen_from_wsl",
    input: { kind: "path", path: "/mnt/c/Users/kc/.gitconfig" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_of_root",
    input: { kind: "path", path: "/root/.profile" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_dollar_home",
    input: { kind: "path", path: "$HOME/.npmrc" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_project_file",
    input: { kind: "path", path: "/home/kc/projects/app/src/index.ts" },
    ruleId: null,
  },
  {
    name: "home_plain_file",
    input: { kind: "path", path: "/home/kc/notes.txt" },
    ruleId: null,
  },
  {
    name: "home_claude_memory_is_not_settings",
    input: {
      kind: "path",
      path: "/home/kc/.claude/projects/app/memory/MEMORY.md",
    },
    ruleId: null,
  },
  {
    name: "home_agent_workspace_is_not_settings",
    input: {
      kind: "path",
      path: "/home/kc/.bgos-agent/7-workspace/src/app.ts",
    },
    ruleId: null,
  },
  {
    name: "dot_folder_outside_home",
    input: { kind: "path", path: "/work/repo/.vscode/settings.json" },
    ruleId: null,
  },
  {
    name: "mcp_send_email",
    input: { kind: "tool", toolName: "mcp__gmail__send_email" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_slack_post_message",
    input: { kind: "tool", toolName: "mcp__slack__slack_post_message" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_camel_case_send",
    input: { kind: "tool", toolName: "mcp__mail__sendMessage" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_pay_invoice",
    input: { kind: "tool", toolName: "mcp__stripe__pay_invoice" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_transfer_funds",
    input: { kind: "tool", toolName: "mcp__bank__transfer_funds" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_delete_file",
    input: { kind: "tool", toolName: "mcp__filesystem__delete_file" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_hyphen_submit",
    input: { kind: "tool", toolName: "mcp__forms__submit-form" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_remove_member",
    input: { kind: "tool", toolName: "mcp__team__remove_member" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_list_posts_is_a_list",
    input: { kind: "tool", toolName: "mcp__blog__list_posts" },
    ruleId: null,
  },
  {
    name: "mcp_past_form_is_a_list",
    input: { kind: "tool", toolName: "mcp__gmail__list_sent_messages" },
    ruleId: null,
  },
  {
    name: "mcp_payload_is_not_pay",
    input: { kind: "tool", toolName: "mcp__http__get_payload" },
    ruleId: null,
  },
  {
    name: "mcp_poster_is_not_post",
    input: { kind: "tool", toolName: "mcp__design__make_poster" },
    ruleId: null,
  },
  {
    name: "mcp_sender_is_not_send",
    input: { kind: "tool", toolName: "mcp__gmail__get_sender" },
    ruleId: null,
  },
  {
    name: "mcp_server_name_is_not_the_tool",
    input: { kind: "tool", toolName: "mcp__post-office__list_boxes" },
    ruleId: null,
  },
  {
    name: "own_channel_reply",
    input: { kind: "tool", toolName: "mcp__bgos__reply" },
    ruleId: null,
  },
  {
    name: "own_channel_plugin_reply",
    input: { kind: "tool", toolName: "mcp__plugin_hoai_bgos__reply" },
    ruleId: null,
  },
  {
    name: "own_channel_send_to_peer",
    input: { kind: "tool", toolName: "mcp__plugin_hoai_bgos__send_to_peer" },
    ruleId: null,
  },
  {
    name: "builtin_tool_is_not_mcp",
    input: { kind: "tool", toolName: "WebFetch" },
    ruleId: null,
  },
  {
    name: "request_bash_rm_rf_verbatim",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        '{ "command": "rm -rf doomed", "description": "Remove doomed directory" }',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_bash_force_push_verbatim",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        '{ "command": "git push --force origin main", "description": "Force push main to origin" }',
    },
    ruleId: "force_push",
  },
  {
    name: "request_bash_git_status",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: '{ "command": "git status --short" }',
    },
    ruleId: null,
  },
  {
    name: "request_bash_description_is_not_the_command",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: '{ "command": "ls", "description": "rm -rf later" }',
    },
    ruleId: null,
  },
  {
    name: "request_powershell_remove_item",
    input: {
      kind: "request",
      toolName: "PowerShell",
      inputPreview: '{ "command": "Remove-Item -Recurse -Force build" }',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_edit_env",
    input: {
      kind: "request",
      toolName: "Edit",
      inputPreview:
        '{ "file_path": "/work/repo/.env", "old_string": "A=1\\n", "new_string": "A=2\\n", "replace_all": false }',
    },
    ruleId: "env_file_write",
  },
  {
    name: "request_write_git_dir",
    input: {
      kind: "request",
      toolName: "Write",
      inputPreview:
        '{ "file_path": "/work/repo/.git/probe-note.txt", "content": "hello\\n" }',
    },
    ruleId: "git_dir_write",
  },
  {
    name: "request_multiedit_bashrc",
    input: {
      kind: "request",
      toolName: "MultiEdit",
      inputPreview: '{ "file_path": "~/.bashrc", "edits": [] }',
    },
    ruleId: "home_dotfile_write",
  },
  {
    name: "request_notebook_path",
    input: {
      kind: "request",
      toolName: "NotebookEdit",
      inputPreview:
        '{ "notebook_path": "/work/repo/.git/scratch.ipynb", "new_source": "x" }',
    },
    ruleId: "git_dir_write",
  },
  {
    name: "request_edit_ordinary_file",
    input: {
      kind: "request",
      toolName: "Edit",
      inputPreview:
        '{ "file_path": "/work/repo/src/app.ts", "old_string": "a", "new_string": "b" }',
    },
    ruleId: null,
  },
  {
    name: "request_read_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Read",
      inputPreview: '{ "file_path": "/work/repo/.env" }',
    },
    ruleId: null,
  },
  {
    name: "request_mcp_send",
    input: {
      kind: "request",
      toolName: "mcp__gmail__send_email",
      inputPreview: '{ "to": "someone@example.com" }',
    },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "request_own_channel_reply",
    input: {
      kind: "request",
      toolName: "mcp__plugin_hoai_bgos__reply",
      inputPreview: '{ "text": "rm -rf done" }',
    },
    ruleId: null,
  },
  {
    name: "request_preview_cut_short",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: '{ "command": "rm -rf build && echo one && echo tw',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_preview_plain_text",
    input: { kind: "request", toolName: "Bash", inputPreview: "rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_rf_probe_command",
    input: { kind: "command", command: "rm -rf doomed" },
    ruleId: "recursive_delete",
  },
  {
    name: "xargs_n_rm_rf",
    input: { kind: "command", command: "ls -d */ | xargs -n 1 rm -rf" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_pipeline_into_remove_item",
    input: {
      kind: "command",
      command: "Get-ChildItem dist | Remove-Item -Recurse",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "bash_lc_script_codex_argv",
    input: { kind: "command", command: "/bin/bash -lc 'rm -rf build'" },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_exe_command_codex_argv",
    input: {
      kind: "command",
      command:
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "Remove-Item build -Recurse"',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "git_dash_c_push_fu_cluster",
    input: { kind: "command", command: "git -C repo push -fu origin main" },
    ruleId: "force_push",
  },
  {
    name: "git_push_no_force_with_lease",
    input: {
      kind: "command",
      command: "git push --no-force-with-lease origin main",
    },
    ruleId: null,
  },
  {
    name: "del_s_deletes_files_not_a_folder",
    input: { kind: "command", command: "del /s /q *.tmp" },
    ruleId: null,
  },
  {
    name: "remove_item_force_without_recurse",
    input: { kind: "command", command: "Remove-Item notes.txt -Force" },
    ruleId: null,
  },
  {
    name: "echo_quoted_rm_rf",
    input: { kind: "command", command: 'echo "rm -rf build"' },
    ruleId: null,
  },
  {
    name: "commit_message_mentions_rm_rf",
    input: {
      kind: "command",
      command: 'git commit -m "stop the rm -rf of the cache"',
    },
    ruleId: null,
  },
  {
    name: "env_local_relative",
    input: { kind: "path", path: ".env.local" },
    ruleId: "env_file_write",
  },
  {
    name: "env_production_in_a_folder",
    input: { kind: "path", path: "config/.env.production" },
    ruleId: "env_file_write",
  },
  {
    name: "home_ssh_config_tilde",
    input: { kind: "path", path: "~/.ssh/config" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_aws_credentials_macos",
    input: { kind: "path", path: "/Users/kc/.aws/credentials" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "home_plain_file_tilde",
    input: { kind: "path", path: "~/notes.txt" },
    ruleId: null,
  },
  {
    name: "home_claude_memory_tilde",
    input: { kind: "path", path: "~/.claude/projects/p/memory/notes.md" },
    ruleId: null,
  },
  {
    name: "mcp_camel_case_publish_post",
    input: { kind: "tool", toolName: "mcp__blog__publishPost" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_upper_snake_submit_form",
    input: { kind: "tool", toolName: "mcp__forms__SUBMIT_FORM" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_plugin_server_tweet",
    input: { kind: "tool", toolName: "mcp__plugin_social_x__tweet" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "mcp_list_by_sender_is_not_send",
    input: { kind: "tool", toolName: "mcp__mail__list_by_sender" },
    ruleId: null,
  },
  {
    name: "own_channel_standalone_meeting_reply",
    input: { kind: "tool", toolName: "mcp__bgos__meeting_reply" },
    ruleId: null,
  },
  {
    name: "builtin_send_message_is_not_mcp",
    input: { kind: "tool", toolName: "SendMessage" },
    ruleId: null,
  },
  {
    name: "request_mcp_transfer_funds",
    input: {
      kind: "request",
      toolName: "mcp__bank__transfer_funds",
      inputPreview: '{ "amount": 10, "to": "savings" }',
    },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "request_own_channel_send_to_peer",
    input: {
      kind: "request",
      toolName: "mcp__plugin_hoai_bgos__send_to_peer",
      inputPreview: '{ "peer": 12, "text": "hi" }',
    },
    ruleId: null,
  },
  {
    name: "request_bash_true_housekeeping",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: '{ "command": "true", "description": "No-op" }',
    },
    ruleId: null,
  },
  {
    name: "request_write_env",
    input: {
      kind: "request",
      toolName: "Write",
      inputPreview: '{ "file_path": "/srv/app/.env", "content": "A=1\\n" }',
    },
    ruleId: "env_file_write",
  },
  {
    name: "request_edit_root_profile",
    input: {
      kind: "request",
      toolName: "Edit",
      inputPreview:
        '{ "file_path": "/root/.profile", "old_string": "a", "new_string": "b" }',
    },
    ruleId: "home_dotfile_write",
  },
  {
    name: "request_read_bashrc_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Read",
      inputPreview: '{ "file_path": "/home/u/.bashrc" }',
    },
    ruleId: null,
  },
  {
    name: "request_read_git_config_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Read",
      inputPreview: '{ "file_path": "/work/repo/.git/config", "limit": 40 }',
    },
    ruleId: null,
  },
  {
    name: "request_grep_env_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Grep",
      inputPreview: '{ "pattern": "KEY", "path": "/work/repo/.env" }',
    },
    ruleId: null,
  },
  {
    name: "request_task_command_is_not_a_shell",
    input: {
      kind: "request",
      toolName: "Task",
      inputPreview: '{ "command": "rm -rf build" }',
    },
    ruleId: null,
  },
  {
    name: "command_substitution_in_double_quotes",
    input: { kind: "command", command: 'echo "$(rm -rf build)"' },
    ruleId: "recursive_delete",
  },
  {
    name: "command_substitution_in_an_assignment",
    input: { kind: "command", command: 'x="$(rm -rf build)"' },
    ruleId: "recursive_delete",
  },
  {
    name: "backtick_in_double_quotes",
    input: { kind: "command", command: 'echo "`rm -rf build`"' },
    ruleId: "recursive_delete",
  },
  {
    name: "command_substitution_in_a_sentence",
    input: {
      kind: "command",
      command: 'echo "removed $(rm -rfv build | wc -l) files"',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "single_quoted_substitution_is_text",
    input: { kind: "command", command: "echo '$(rm -rf build)'" },
    ruleId: null,
  },
  {
    name: "sudo_long_user_option",
    input: { kind: "command", command: "sudo --user root rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "sudo_long_user_equals",
    input: { kind: "command", command: "sudo --user=root rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "timeout_long_signal_option",
    input: { kind: "command", command: "timeout --signal KILL 5 rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_namespace_push_force",
    input: { kind: "command", command: "git --namespace foo push -f" },
    ruleId: "force_push",
  },
  {
    name: "rd_joined_q_s",
    input: { kind: "command", command: "rd /q/s build" },
    ruleId: "recursive_delete",
  },
  {
    name: "windows_powershell_positional_command",
    input: {
      kind: "command",
      command: 'powershell "Remove-Item build -Recurse"',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "windows_powershell_options_then_positional",
    input: {
      kind: "command",
      command:
        'powershell -NoProfile -ExecutionPolicy Bypass "Remove-Item build -Recurse"',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "pwsh_positional_is_a_file",
    input: { kind: "command", command: "pwsh cleanup.ps1" },
    ruleId: null,
  },
  {
    name: "wsl_rm_rf",
    input: { kind: "command", command: "wsl rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "wsl_exe_e_rm_rf",
    input: { kind: "command", command: "wsl.exe -e rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "wsl_distribution_and_user",
    input: {
      kind: "command",
      command: "wsl -d Ubuntu -u root -- rm -rf build",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "wsl_list_is_not_a_command",
    input: { kind: "command", command: "wsl --list" },
    ruleId: null,
  },
  {
    name: "su_c_script",
    input: { kind: "command", command: "su -c 'rm -rf build'" },
    ruleId: "recursive_delete",
  },
  {
    name: "su_user_c_script",
    input: { kind: "command", command: "su root -c 'rm -rf build'" },
    ruleId: "recursive_delete",
  },
  {
    name: "here_string_to_bash",
    input: { kind: "command", command: "bash <<< 'rm -rf build'" },
    ruleId: "recursive_delete",
  },
  {
    name: "echo_piped_into_bash",
    input: { kind: "command", command: "echo 'rm -rf build' | bash" },
    ruleId: "recursive_delete",
  },
  {
    name: "heredoc_fed_to_bash",
    input: { kind: "command", command: "bash <<'EOF'\nrm -rf build\nEOF" },
    ruleId: "recursive_delete",
  },
  {
    name: "heredoc_piped_into_bash",
    input: {
      kind: "command",
      command: "cat <<'EOF' | bash\nrm -rf build\nEOF",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "heredoc_writing_a_script_does_not_ask",
    input: {
      kind: "command",
      command: "cat > cleanup.sh <<'EOF'\nrm -rf build\nEOF",
    },
    ruleId: null,
  },
  {
    name: "heredoc_with_tabs_is_data",
    input: {
      kind: "command",
      command: "cat <<-EOF\n\trm -rf build\n\tEOF\necho ok",
    },
    ruleId: null,
  },
  {
    name: "command_after_a_heredoc_still_counts",
    input: {
      kind: "command",
      command: "cat > notes.txt <<EOF\nhello\nEOF\nrm -rf build",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "comment_is_not_a_command",
    input: { kind: "command", command: "true # ; rm -rf x" },
    ruleId: null,
  },
  {
    name: "comment_line_then_a_command",
    input: { kind: "command", command: "# clean up\nrm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "hash_inside_a_word_is_not_a_comment",
    input: { kind: "command", command: "echo a#b; rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "parameter_length_is_not_a_comment",
    input: { kind: "command", command: "echo ${#list[@]}; rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "mcp_other_plugin_named_bgos_is_not_the_channel",
    input: { kind: "tool", toolName: "mcp__plugin_mail_bgos__send_email" },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "own_channel_previous_plugin_name",
    input: { kind: "tool", toolName: "mcp__plugin_bgos_bgos__reply" },
    ruleId: null,
  },
  {
    name: "own_channel_qa_install",
    input: { kind: "tool", toolName: "mcp__plugin_hoaiq_bgos__reply" },
    ruleId: null,
  },
  {
    name: "bash_c_double_dash_script",
    input: { kind: "command", command: "bash -c -- 'rm -rf build'" },
    ruleId: "recursive_delete",
  },
  {
    name: "bash_c_with_no_script_is_nothing",
    input: { kind: "command", command: "bash -c --" },
    ruleId: null,
  },
  {
    name: "env_split_string",
    input: { kind: "command", command: 'env -S "rm -rf build"' },
    ruleId: "recursive_delete",
  },
  {
    name: "env_split_string_long_joined",
    input: {
      kind: "command",
      command: "env --split-string='git push --force'",
    },
    ruleId: "force_push",
  },
  {
    name: "sudo_clustered_login_and_user",
    input: { kind: "command", command: "sudo -iu root rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "sudo_user_value_joined",
    input: { kind: "command", command: "sudo -uroot rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "ansi_c_quoted_program",
    input: { kind: "command", command: "$'rm' -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "ansi_c_hex_escape_in_program",
    input: { kind: "command", command: "$'r\\x6d' -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "ansi_c_escaped_quote_then_a_command",
    input: { kind: "command", command: "echo $'it\\'s'; rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "ansi_c_quoted_mention_is_text",
    input: { kind: "command", command: "echo $'rm -rf build'" },
    ruleId: null,
  },
  {
    name: "locale_string_mention_is_text",
    input: { kind: "command", command: 'echo $"rm -rf build"' },
    ruleId: null,
  },
  {
    name: "backslash_inside_program_name",
    input: { kind: "command", command: "r\\m -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "backslash_escaped_flag",
    input: { kind: "command", command: "rm -\\rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "backslash_inside_git",
    input: { kind: "command", command: "g\\it push -f origin main" },
    ruleId: "force_push",
  },
  {
    name: "windows_relative_exe_is_not_rm",
    input: { kind: "command", command: "bin\\cleanup.exe -r build" },
    ruleId: null,
  },
  {
    name: "powershell_backtick_line_continuation",
    input: {
      kind: "command",
      command: "Remove-Item build `\n  -Recurse -Force",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "powershell_continuation_without_recurse",
    input: { kind: "command", command: "Remove-Item notes.txt `\n  -Force" },
    ruleId: null,
  },
  {
    name: "request_third_party_mcp_shell_is_read_by_name_only",
    input: {
      kind: "request",
      toolName: "mcp__shell__run",
      inputPreview: '{ "command": "rm -rf build" }',
    },
    ruleId: null,
  },
  {
    name: "rm_long_prefix_r",
    input: { kind: "command", command: "rm --r build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_long_prefix_rec_with_force",
    input: { kind: "command", command: "rm --rec -f build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_long_prefix_recur",
    input: { kind: "command", command: "rm --recur build" },
    ruleId: "recursive_delete",
  },
  {
    name: "rm_long_force_is_not_recursive",
    input: { kind: "command", command: "rm --force build" },
    ruleId: null,
  },
  {
    name: "rm_double_dash_then_a_file_named_like_a_flag",
    input: { kind: "command", command: "rm -- --r" },
    ruleId: null,
  },
  {
    name: "git_push_mirror",
    input: { kind: "command", command: "git push --mirror backup" },
    ruleId: "force_push",
  },
  {
    name: "git_push_mirror_abbreviated",
    input: { kind: "command", command: "git push --mirr backup" },
    ruleId: "force_push",
  },
  {
    name: "git_push_all_is_not_a_mirror",
    input: { kind: "command", command: "git push --all origin" },
    ruleId: null,
  },
  {
    name: "git_push_delete_long",
    input: { kind: "command", command: "git push --delete origin old-branch" },
    ruleId: "force_push",
  },
  {
    name: "git_push_delete_short",
    input: { kind: "command", command: "git push -d origin old-branch" },
    ruleId: "force_push",
  },
  {
    name: "git_push_delete_abbreviated",
    input: { kind: "command", command: "git push --dele origin old-branch" },
    ruleId: "force_push",
  },
  {
    name: "git_push_ambiguous_d_prefix_is_refused_by_git",
    input: { kind: "command", command: "git push --d origin old-branch" },
    ruleId: null,
  },
  {
    name: "git_branch_delete_is_not_a_push",
    input: { kind: "command", command: "git branch --delete old-branch" },
    ruleId: null,
  },
  {
    name: "git_push_empty_source_refspec",
    input: { kind: "command", command: "git push origin :old-branch" },
    ruleId: "force_push",
  },
  {
    name: "git_push_empty_source_full_ref",
    input: {
      kind: "command",
      command: "git push origin ':refs/heads/old-branch'",
    },
    ruleId: "force_push",
  },
  {
    name: "git_push_refspec_with_a_source",
    input: { kind: "command", command: "git push origin HEAD:main" },
    ruleId: null,
  },
  {
    name: "git_push_bare_colon_pushes_matching",
    input: { kind: "command", command: "git push origin :" },
    ruleId: null,
  },
  {
    name: "git_push_force_with_lease_abbreviated",
    input: { kind: "command", command: "git push --force-w origin main" },
    ruleId: "force_push",
  },
  {
    name: "find_delete",
    input: { kind: "command", command: "find build -delete" },
    ruleId: "recursive_delete",
  },
  {
    name: "find_named_files_delete",
    input: { kind: "command", command: "find . -name '*.log' -delete" },
    ruleId: "recursive_delete",
  },
  {
    name: "find_without_delete",
    input: { kind: "command", command: "find build -name '*.log'" },
    ruleId: null,
  },
  {
    name: "git_clean_fd",
    input: { kind: "command", command: "git clean -fd" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_clean_xdf_any_order",
    input: { kind: "command", command: "git clean -xdf" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_clean_split_flags",
    input: { kind: "command", command: "git clean -f -d" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_clean_long_force_with_x",
    input: { kind: "command", command: "git -C app clean --force -x" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_clean_ignored_only",
    input: { kind: "command", command: "git clean -fX" },
    ruleId: "recursive_delete",
  },
  {
    name: "git_clean_force_alone_is_files_only",
    input: { kind: "command", command: "git clean -f" },
    ruleId: null,
  },
  {
    name: "git_clean_dry_run_of_folders",
    input: { kind: "command", command: "git clean -nd" },
    ruleId: null,
  },
  {
    name: "git_clean_exclude_pattern_is_not_a_flag",
    input: { kind: "command", command: "git clean -f -e -d" },
    ruleId: null,
  },
  {
    name: "rsync_delete",
    input: { kind: "command", command: "rsync -a --delete src/ backup/" },
    ruleId: "recursive_delete",
  },
  {
    name: "rsync_delete_after",
    input: {
      kind: "command",
      command: "rsync -av --delete-after src/ backup/",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "rsync_del_alias",
    input: { kind: "command", command: "rsync -a --del src/ backup/" },
    ruleId: "recursive_delete",
  },
  {
    name: "rsync_without_delete",
    input: { kind: "command", command: "rsync -av src/ backup/" },
    ruleId: null,
  },
  {
    name: "redirect_append_env",
    input: { kind: "command", command: "echo API_KEY=abc >> .env" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_truncate_env_local",
    input: { kind: "command", command: "printf 'A=1\\n' > config/.env.local" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_into_git_config",
    input: { kind: "command", command: "echo '[core]' > .git/config" },
    ruleId: "git_dir_write",
  },
  {
    name: "redirect_append_bashrc",
    input: {
      kind: "command",
      command: "echo 'export PATH=$PATH:/opt/x' >> ~/.bashrc",
    },
    ruleId: "home_dotfile_write",
  },
  {
    name: "redirect_stderr_into_env",
    input: { kind: "command", command: "make 2> .env" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_both_streams_into_env",
    input: { kind: "command", command: "npm run setup &> .env" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_heredoc_into_env",
    input: { kind: "command", command: "cat > .env <<'EOF'\nAPI_KEY=abc\nEOF" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_bare_truncate_env",
    input: { kind: "command", command: "> .env" },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_inside_bash_lc",
    input: { kind: "command", command: 'bash -lc "echo API_KEY=abc >> .env"' },
    ruleId: "env_file_write",
  },
  {
    name: "redirect_before_the_program",
    input: { kind: "command", command: "> build.log rm -rf build" },
    ruleId: "recursive_delete",
  },
  {
    name: "redirect_into_envrc_is_not_env",
    input: { kind: "command", command: "echo x >> .envrc" },
    ruleId: null,
  },
  {
    name: "redirect_reading_env_is_not_writing",
    input: { kind: "command", command: "sort < .env" },
    ruleId: null,
  },
  {
    name: "redirect_stream_dup_is_not_a_file",
    input: { kind: "command", command: "npm test 2>&1" },
    ruleId: null,
  },
  {
    name: "redirect_after_a_single_file_rm",
    input: { kind: "command", command: "rm notes.txt 2>/dev/null" },
    ruleId: null,
  },
  {
    name: "tee_env",
    input: { kind: "command", command: "echo A=1 | tee .env" },
    ruleId: "env_file_write",
  },
  {
    name: "tee_append_bashrc_with_sudo",
    input: {
      kind: "command",
      command: "echo 'alias ll=ls' | sudo tee -a ~/.bashrc",
    },
    ruleId: "home_dotfile_write",
  },
  {
    name: "tee_git_hook",
    input: {
      kind: "command",
      command: "cat hook.sh | tee .git/hooks/pre-commit > /dev/null",
    },
    ruleId: "git_dir_write",
  },
  {
    name: "tee_ordinary_file",
    input: { kind: "command", command: "npm test | tee test.log" },
    ruleId: null,
  },
  {
    name: "sed_in_place_env",
    input: { kind: "command", command: "sed -i 's/DEBUG=0/DEBUG=1/' .env" },
    ruleId: "env_file_write",
  },
  {
    name: "sed_in_place_backup_suffix",
    input: { kind: "command", command: "sed -i.bak -e 's/a/b/' ~/.zshrc" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "sed_in_place_bsd_empty_suffix",
    input: { kind: "command", command: "sed -i '' 's/a/b/' .env.production" },
    ruleId: "env_file_write",
  },
  {
    name: "sed_in_place_long_option",
    input: { kind: "command", command: "sed --in-place 's/a/b/' .git/config" },
    ruleId: "git_dir_write",
  },
  {
    name: "sed_in_place_suffix_e_is_not_a_script",
    input: { kind: "command", command: "sed -ie 's/a/b/' .env" },
    ruleId: "env_file_write",
  },
  {
    name: "sed_reading_env",
    input: { kind: "command", command: "sed -n '1,5p' .env" },
    ruleId: null,
  },
  {
    name: "sed_in_place_script_names_git",
    input: { kind: "command", command: "sed -i 's/.git/x/' README.md" },
    ruleId: null,
  },
  {
    name: "sed_in_place_ordinary_file",
    input: { kind: "command", command: "sed -i 's/a/b/' src/app.ts" },
    ruleId: null,
  },
  {
    name: "cp_example_onto_env",
    input: { kind: "command", command: "cp .env.example .env" },
    ruleId: "env_file_write",
  },
  {
    name: "cp_env_into_a_folder_is_a_new_env",
    input: { kind: "command", command: "cp .env deploy/" },
    ruleId: "env_file_write",
  },
  {
    name: "cp_into_home_dot_folder",
    input: { kind: "command", command: "cp id_ed25519 ~/.ssh/" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "cp_several_sources_into_home",
    input: { kind: "command", command: "cp .bashrc .profile ~" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "cp_target_directory_git_hooks",
    input: { kind: "command", command: "cp -t .git/hooks pre-commit" },
    ruleId: "git_dir_write",
  },
  {
    name: "cp_with_a_redirect_after_it",
    input: { kind: "command", command: "cp .env.example .env 2>/dev/null" },
    ruleId: "env_file_write",
  },
  {
    name: "mv_onto_gitconfig",
    input: { kind: "command", command: "mv /tmp/gitconfig ~/.gitconfig" },
    ruleId: "home_dotfile_write",
  },
  {
    name: "mv_into_git_dir",
    input: { kind: "command", command: "mv pre-commit .git/hooks/pre-commit" },
    ruleId: "git_dir_write",
  },
  {
    name: "cp_env_to_a_named_file_reads_it",
    input: { kind: "command", command: "cp .env backup/env.txt" },
    ruleId: null,
  },
  {
    name: "mv_ordinary",
    input: { kind: "command", command: "mv notes.txt docs/notes.txt" },
    ruleId: null,
  },
  {
    name: "sed_in_place_bsd_empty_suffix_then_a_script_naming_git",
    input: { kind: "command", command: "sed -i '' 's/.git/x/' README.md" },
    ruleId: null,
  },
  {
    name: "redirect_does_not_outlive_its_command",
    input: { kind: "command", command: "echo > $(rm -rf build)" },
    ruleId: "recursive_delete",
  },
  {
    name: "redirect_dup_operator_onto_a_file",
    input: { kind: "command", command: "npm run setup >& .env" },
    ruleId: "env_file_write",
  },
  {
    name: "input_redirect_is_not_the_destination",
    input: {
      kind: "command",
      command: "cp hook .git/hooks/pre-commit < /dev/null",
    },
    ruleId: "git_dir_write",
  },
  {
    name: "cp_powershell_named_destination_onto_env",
    input: {
      kind: "command",
      command: "cp -Path .env.example -Destination .env",
    },
    ruleId: "env_file_write",
  },
  {
    name: "cp_powershell_named_destination_elsewhere",
    input: {
      kind: "command",
      command: "cp -Path .env -Destination backup -Force",
    },
    ruleId: null,
  },
  {
    name: "mv_powershell_recurse_into_git_dir",
    input: { kind: "command", command: "mv -Recurse hooks .git/" },
    ruleId: "git_dir_write",
  },
  {
    name: "cp_powershell_colon_destination_elsewhere",
    input: { kind: "command", command: "cp .env -Destination:backup" },
    ruleId: null,
  },
  {
    name: "request_bash_redirect_into_env",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        '{ "command": "echo API_KEY=abc >> .env", "description": "Add the key" }',
    },
    ruleId: "env_file_write",
  },
  {
    name: "request_bash_git_clean",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        '{ "command": "git clean -fdx", "description": "Remove untracked files" }',
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_bash_cat_env_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        '{ "command": "cat .env", "description": "Show the env file" }',
    },
    ruleId: null,
  },
];

/**
 * THE CARD STRINGS. The server stamps the floor on a request card by reading
 * its `approvalMeta.tool` (hard-floor-card.ts, `classifyFloorCard`), so what a
 * writer puts there and what the reader reads are one contract across repos.
 * The backend's spec runs its card reader over every case; the plugin's test
 * builds every `claude_relay` case from its `relay` inputs with
 * `permissionCardTool` and asserts the SAME string, and that its own reading
 * of those inputs names the same rule. A `codex_*` case is the shape
 * codex-channel-bgos writes, which the server must read as stated; its writer
 * is in a third repo that neither suite can see.
 *
 * The relay's three shapes: an MCP tool as `<tool_name> <input_preview>` (the
 * bare name when there is no preview); a held shell command whose match the
 * card would not show (the preview over the 2000 character cap, or cut in the
 * middle by the CLI) as the lead line `{"command":"<evidence>"}` above the
 * preview; anything else as the preview, capped with `...`.
 */
export const HARD_FLOOR_CARD_FIXTURE: HardFloorFixtureCardCase[] = [
  {
    name: "card_relay_mcp_name_then_preview",
    writer: "claude_relay",
    relay: {
      toolName: "mcp__gmail__send_email",
      inputPreview: '{ "to": "kc@example.com", "subject": "Hi" }',
    },
    tool: 'mcp__gmail__send_email { "to": "kc@example.com", "subject": "Hi" }',
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "card_relay_mcp_bare_name",
    writer: "claude_relay",
    relay: { toolName: "mcp__gmail__reply_to_thread", inputPreview: "" },
    tool: "mcp__gmail__reply_to_thread",
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "card_relay_mcp_read_tool",
    writer: "claude_relay",
    relay: {
      toolName: "mcp__gmail__search_threads",
      inputPreview: '{ "q": "from:kc" }',
    },
    tool: 'mcp__gmail__search_threads { "q": "from:kc" }',
    ruleId: null,
  },
  {
    name: "card_relay_mcp_own_channel",
    writer: "claude_relay",
    relay: {
      toolName: "mcp__plugin_hoai_bgos__reply",
      inputPreview: '{ "chat_id": "7", "text": "done" }',
    },
    tool: 'mcp__plugin_hoai_bgos__reply { "chat_id": "7", "text": "done" }',
    ruleId: null,
  },
  {
    name: "card_relay_shell_short_preview_is_the_card",
    writer: "claude_relay",
    relay: {
      toolName: "Bash",
      inputPreview:
        '{ "command": "rm -rf doomed", "description": "Remove doomed directory" }',
      floorEvidence: "rm -rf doomed",
    },
    tool: '{ "command": "rm -rf doomed", "description": "Remove doomed directory" }',
    ruleId: "recursive_delete",
  },
  {
    name: "card_relay_shell_capped_leads_with_evidence",
    writer: "claude_relay",
    relay: {
      toolName: "Bash",
      inputPreview:
        '{ "command": "echo ' +
        "y".repeat(2100) +
        ' && rm -rf build", "description": "Clean the build" }',
      floorEvidence: "rm -rf build",
    },
    tool:
      '{"command":"rm -rf build"}\n{ "command": "echo ' +
      "y".repeat(1951) +
      "...",
    ruleId: "recursive_delete",
  },
  {
    name: "card_relay_shell_capped_redirect_leads_with_evidence",
    writer: "claude_relay",
    relay: {
      toolName: "Bash",
      inputPreview:
        '{ "command": "echo ' +
        "y".repeat(2100) +
        ' && echo API_KEY=abc >> .env", "description": "Add the key" }',
      floorEvidence: "echo API_KEY=abc >> .env",
    },
    tool:
      '{"command":"echo API_KEY=abc >> .env"}\n{ "command": "echo ' +
      "y".repeat(1939) +
      "...",
    ruleId: "env_file_write",
  },
  {
    name: "card_relay_shell_capped_without_evidence_is_its_head",
    writer: "claude_relay",
    relay: {
      toolName: "Bash",
      inputPreview:
        '{ "command": "echo ' +
        "y".repeat(2100) +
        ' && ls", "description": "List" }',
    },
    tool: '{ "command": "echo ' + "y".repeat(1978) + "...",
    ruleId: null,
  },
  {
    name: "card_relay_shell_elided_leads_with_evidence",
    writer: "claude_relay",
    relay: {
      toolName: "Bash",
      inputPreview:
        '{ "command": "echo aa\n\u22EF 2600 code points elided \u22EF\necho bb", "description": "d" }',
      floorEvidence: "git push --force origin main",
    },
    tool: '{"command":"git push --force origin main"}\n{ "command": "echo aa\n\u22EF 2600 code points elided \u22EF\necho bb", "description": "d" }',
    ruleId: "force_push",
  },
  {
    name: "card_relay_bare_shell_name",
    writer: "claude_relay",
    relay: { toolName: "Bash", inputPreview: "" },
    tool: "Bash",
    ruleId: null,
  },
  {
    name: "card_relay_edit_of_env",
    writer: "claude_relay",
    relay: {
      toolName: "Edit",
      inputPreview:
        '{ "file_path": "/srv/app/.env", "old_string": "A=1", "new_string": "A=2", "replace_all": false }',
    },
    tool: '{ "file_path": "/srv/app/.env", "old_string": "A=1", "new_string": "A=2", "replace_all": false }',
    ruleId: "env_file_write",
  },
  {
    name: "card_relay_read_of_env",
    writer: "claude_relay",
    relay: { toolName: "Read", inputPreview: '{ "file_path": "/srv/app/.env" }' },
    tool: '{ "file_path": "/srv/app/.env" }',
    ruleId: null,
  },
  {
    name: "card_codex_add_env",
    writer: "codex_file_change",
    tool: ".env (add)",
    ruleId: "env_file_write",
  },
  {
    name: "card_codex_update_inside_git",
    writer: "codex_file_change",
    tool: "README.md (update)\n.git/info/exclude (update)",
    ruleId: "git_dir_write",
  },
  {
    name: "card_codex_update_home_settings",
    writer: "codex_file_change",
    tool: "~/.gitconfig (update)",
    ruleId: "home_dotfile_write",
  },
  {
    name: "card_codex_rename_into_env",
    writer: "codex_file_change",
    tool: "config/env.example -> .env (rename)",
    ruleId: "env_file_write",
  },
  {
    name: "card_codex_rename_into_git",
    writer: "codex_file_change",
    tool: "hooks/pre-commit -> .git/hooks/pre-commit (rename)",
    ruleId: "git_dir_write",
  },
  {
    name: "card_codex_rename_arrow_into_env",
    writer: "codex_file_change",
    tool: "env.sample \u2192 .env.local (rename)",
    ruleId: "env_file_write",
  },
  {
    name: "card_codex_rename_ordinary",
    writer: "codex_file_change",
    tool: "src/old.ts -> src/new.ts (rename)",
    ruleId: null,
  },
  {
    name: "card_codex_rename_row_naming_only_its_source",
    writer: "codex_file_change",
    tool: "config/env.example (rename)",
    ruleId: null,
  },
  {
    name: "card_codex_list_past_its_cap",
    writer: "codex_file_change",
    tool: "src/a.ts (update)\n.env (update)\nand 21 more files",
    ruleId: "env_file_write",
  },
  {
    name: "card_codex_ordinary_list_past_its_cap",
    writer: "codex_file_change",
    tool: "src/a.ts (update)\nsrc/b.ts (update)\nand 1 more file",
    ruleId: null,
  },
  {
    name: "card_codex_command_git_clean",
    writer: "codex_command",
    tool: "bash -lc 'git clean -fdx'",
    ruleId: "recursive_delete",
  },
  {
    name: "card_codex_command_redirect_into_env",
    writer: "codex_command",
    tool: "/bin/bash -lc 'echo API_KEY=abc >> .env'",
    ruleId: "env_file_write",
  },
  {
    name: "card_codex_command_harmless",
    writer: "codex_command",
    tool: "bash -lc 'git status --short'",
    ruleId: null,
  },
];

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE). Identical in both repos, and pinned again as a literal in each repo's spec. */
export const HARD_FLOOR_FIXTURE_DIGEST =
  "19c12d28cf3cffa382a38927cab05bacc8060dfbdad6e423791c25665f07ddf8";

/** sha256 of JSON.stringify(HARD_FLOOR_CARD_FIXTURE). Identical in both repos, and pinned again as a literal in each repo's spec. */
export const HARD_FLOOR_CARD_FIXTURE_DIGEST =
  "dee81aa8df1f5c008b5af7a4b8ab464ca46d7a56d5e3116693007499cb7dd280";

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE_RULES). Identical in both repos, and pinned again as a literal in each repo's spec. */
export const HARD_FLOOR_RULES_DIGEST =
  "5e1a1d280b70eaab889899dd83da5b81603b1362030c0b91b537624506237573";
