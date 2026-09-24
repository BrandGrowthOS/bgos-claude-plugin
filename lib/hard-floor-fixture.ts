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
 * ONE FILE, ONE SCHEMA, ONE CASE LIST, ONE DIGEST. This file is BYTE
 * IDENTICAL in both repos (backend src/services/hard-floor-fixture.ts and
 * plugin lib/hard-floor-fixture.ts). It imports nothing, so it compiles
 * unchanged in both. Its four input kinds are the four both classifiers take
 * as they are: a shell command, a file path the action writes, a tool name,
 * and a permission request as the Claude Code CLI sends it (a tool name plus
 * its input rendered as JSON, possibly cut short). The server's card string
 * reading has no plugin twin, so its cases live in the backend's own spec.
 *
 * WHAT EACH SUITE CAN AND CANNOT SEE. Each repo's spec runs ITS classifier
 * over every case, asserts its own rule ids, words and version equal the ones
 * below, recomputes both digests, and compares them with the constants below
 * AND with a literal pinned in that spec file. Neither suite can read the
 * other repo, so neither can prove the other copy is the same: THE CROSS
 * REPO CHECK IS THE RECONCILIATION STEP, where this file is copied byte for
 * byte (cmp says nothing) and the two pinned digest literals are compared by
 * eye. A regeneration therefore shows up as a visible diff in FOUR places
 * (this file and one spec literal, in each repo), never as a silent green.
 *
 * To change the list: update BOTH classifiers, regenerate this file in ONE
 * place and copy it to the other, update the digest literal in BOTH specs,
 * and bump the rules version on both sides when what a rule matches changes.
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
];

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE). Identical in both repos, and pinned again as a literal in each repo's spec. */
export const HARD_FLOOR_FIXTURE_DIGEST =
  "9524af5c3f2b10e89775e484f24c7470c6c1719257219cc26bebb933308deb46";

/** sha256 of JSON.stringify(HARD_FLOOR_FIXTURE_RULES). Identical in both repos, and pinned again as a literal in each repo's spec. */
export const HARD_FLOOR_RULES_DIGEST =
  "5e1a1d280b70eaab889899dd83da5b81603b1362030c0b91b537624506237573";
