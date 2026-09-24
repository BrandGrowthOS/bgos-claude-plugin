/**
 * Cross-repo hard floor fixture, rules_version 1.
 *
 * THE ANTI-DRIFT GUARD. The hard floor list ("Always ask before risky
 * actions") is implemented twice: once in the platform backend
 * (backend/src/services/hard-floor.ts, jest), which stamps the floor block on
 * a request card and answers the relay's floor check, and once in the Claude
 * Code plugin (lib/hard-floor-core.mjs behind lib/hard-floor.ts, node test),
 * where a blocking hook and the permission relay decide whether to ask. If
 * they disagree, the plugin lets an action through that the server would have
 * held, or holds one the server then waves on.
 *
 * This file is BYTE IDENTICAL in both repos. Each repo's spec runs ITS
 * classifier over every case and asserts the rule (or null), asserts its own
 * rule ids, words and version equal the ones below, and asserts the two
 * digests. Change a rule id, a word, the version or a case in one repo only,
 * and that repo's suite goes red.
 *
 * Four input kinds, the same four on both sides: a shell command, a file
 * path, a tool name, and a permission request as the Claude Code CLI sends it
 * (a tool name plus its input rendered as JSON, possibly cut short).
 *
 * To change the list: update BOTH classifiers, regenerate BOTH fixtures with
 * matching digests, and bump the rules version on both sides.
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
  /** Human name for the case, used in test output. Unique. */
  name: string;
  input: HardFloorFixtureInput;
  /** The rule both classifiers must report, or null when neither may match. */
  ruleId: string | null;
}

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
  // Commands: a recursive delete.
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
    input: { kind: "command", command: "bash -c \"rm -rf build\"" },
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
    name: "quoted_mention_asks_too",
    input: { kind: "command", command: "grep -rn \"rm -rf\" scripts" },
    ruleId: "recursive_delete",
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
      command: "pwsh -Command \"Remove-Item -Recurse build\"",
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
    input: { kind: "command", command: "cmd /c \"rd /s /q build\"" },
    ruleId: "recursive_delete",
  },
  // Commands: a force push.
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
  // Commands that must never ask.
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
  // Paths: inside .git.
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
  // Paths: an .env file.
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
  // Paths: a settings file in the home folder.
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
    name: "home_xdg_config_file",
    input: { kind: "path", path: "/home/kc/.config/gh/hosts.yml" },
    ruleId: "home_dotfile_write",
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
    input: { kind: "path", path: "/home/kc/.bgos-agent/7-workspace/src/app.ts" },
    ruleId: null,
  },
  {
    name: "dot_folder_outside_home",
    input: { kind: "path", path: "/work/repo/.vscode/settings.json" },
    ruleId: null,
  },
  // Tool names: acting on the owner's behalf.
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
  // Permission requests, as the Claude Code CLI renders them (map part 24).
  {
    name: "request_bash_rm_rf_verbatim",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        "{ \"command\": \"rm -rf doomed\", \"description\": \"Remove doomed directory\" }",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_bash_force_push_verbatim",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview:
        "{ \"command\": \"git push --force origin main\", \"description\": \"Force push main to origin\" }",
    },
    ruleId: "force_push",
  },
  {
    name: "request_bash_git_status",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: "{ \"command\": \"git status --short\" }",
    },
    ruleId: null,
  },
  {
    name: "request_bash_description_is_not_the_command",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: "{ \"command\": \"ls\", \"description\": \"rm -rf later\" }",
    },
    ruleId: null,
  },
  {
    name: "request_powershell_remove_item",
    input: {
      kind: "request",
      toolName: "PowerShell",
      inputPreview: "{ \"command\": \"Remove-Item -Recurse -Force build\" }",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_edit_env",
    input: {
      kind: "request",
      toolName: "Edit",
      inputPreview:
        "{ \"file_path\": \"/work/repo/.env\", \"old_string\": \"A=1\\n\", \"new_string\": \"A=2\\n\", \"replace_all\": false }",
    },
    ruleId: "env_file_write",
  },
  {
    name: "request_write_git_dir",
    input: {
      kind: "request",
      toolName: "Write",
      inputPreview:
        "{ \"file_path\": \"/work/repo/.git/probe-note.txt\", \"content\": \"hello\\n\" }",
    },
    ruleId: "git_dir_write",
  },
  {
    name: "request_multiedit_bashrc",
    input: {
      kind: "request",
      toolName: "MultiEdit",
      inputPreview: "{ \"file_path\": \"~/.bashrc\", \"edits\": [] }",
    },
    ruleId: "home_dotfile_write",
  },
  {
    name: "request_notebook_path",
    input: {
      kind: "request",
      toolName: "NotebookEdit",
      inputPreview:
        "{ \"notebook_path\": \"/work/repo/.git/scratch.ipynb\", \"new_source\": \"x\" }",
    },
    ruleId: "git_dir_write",
  },
  {
    name: "request_edit_ordinary_file",
    input: {
      kind: "request",
      toolName: "Edit",
      inputPreview:
        "{ \"file_path\": \"/work/repo/src/app.ts\", \"old_string\": \"a\", \"new_string\": \"b\" }",
    },
    ruleId: null,
  },
  {
    name: "request_read_is_not_a_change",
    input: {
      kind: "request",
      toolName: "Read",
      inputPreview: "{ \"file_path\": \"/work/repo/.env\" }",
    },
    ruleId: null,
  },
  {
    name: "request_mcp_send",
    input: {
      kind: "request",
      toolName: "mcp__gmail__send_email",
      inputPreview: "{ \"to\": \"someone@example.com\" }",
    },
    ruleId: "acts_on_owners_behalf",
  },
  {
    name: "request_own_channel_reply",
    input: {
      kind: "request",
      toolName: "mcp__plugin_hoai_bgos__reply",
      inputPreview: "{ \"text\": \"rm -rf done\" }",
    },
    ruleId: null,
  },
  {
    name: "request_preview_cut_short",
    input: {
      kind: "request",
      toolName: "Bash",
      inputPreview: "{ \"command\": \"rm -rf build && echo one && echo tw",
    },
    ruleId: "recursive_delete",
  },
  {
    name: "request_preview_plain_text",
    input: { kind: "request", toolName: "Bash", inputPreview: "rm -rf build" },
    ruleId: "recursive_delete",
  },
];

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE). Identical in both repos. */
export const HARD_FLOOR_FIXTURE_DIGEST =
  "d1a8f074d7d1403b5992d967c916b17b8c81471ab7b93296551b8b70e5738eb4";

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE_RULES). Identical in both repos. */
export const HARD_FLOOR_RULES_DIGEST =
  "5e1a1d280b70eaab889899dd83da5b81603b1362030c0b91b537624506237573";
