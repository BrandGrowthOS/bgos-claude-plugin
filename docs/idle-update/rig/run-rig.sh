#!/usr/bin/env bash
# Run one rig scenario from WSL on this Windows box: list the scheduled work on
# both sides (Windows tasks inside rig.mjs; WSL systemd timers, unit files and
# crontab here) before and after, and run rig.mjs under Windows node through this
# box's heavy queue (~/.local/bin/heavy: FIFO tickets and its slots, never a raw flock).
# usage: run-rig.sh <idle|busy|broken|stagger|wake|many> [scale] [agents] [busy cases, comma separated]
# many is stagger-many.mjs: fifteen real controllers in their own processes, without the real chain's 0.9 GB per agent.
set -u
scenario=${1:?scenario}
scale=${2:-5}
count=${3:-15}
cases=${4:+ --cases $4}
script='docs\idle-update\rig\rig.mjs'
what=" --scenario $scenario"
if [ "$scenario" = many ]; then script='docs\idle-update\rig\stagger-many.mjs'; what=''; fi
RUN_WIN='E:\bgos-worktrees\idleupd\rig-run'
RUN_WSL=/mnt/e/bgos-worktrees/idleupd/rig-run
PLUGIN_WIN='E:\bgos-worktrees\idleupd\bgos-claude-plugin'
HEAVY=${HEAVY:-$HOME/.local/bin/heavy}
mkdir -p "$RUN_WSL"
wsl_jobs() {
  {
    # Transient units (a tmux spawn scope of any session on this box) come and go on their own: not scheduled work.
    echo '# systemctl --user list-unit-files (not transient)'
    systemctl --user list-unit-files --no-pager --no-legend 2>&1 | awk '$2 != "transient"'
    # Sorted: list-timers orders by the next run, which moves on its own.
    echo '# systemctl --user list-timers (unit, activates)'
    systemctl --user list-timers --all --no-pager --no-legend 2>&1 | awk '{print $(NF-1), $NF}' | sort
    echo '# systemctl list-timers (unit, activates)'
    systemctl list-timers --all --no-pager --no-legend 2>&1 | awk '{print $(NF-1), $NF}' | sort
    echo '# crontab -l'
    crontab -l 2>&1
  }
}
before=$(wsl_jobs); hb=$(printf '%s' "$before" | sha256sum | cut -c1-12)
echo "[run-rig] WSL scheduled work before: $hb"
# cmd.exe starts through a fresh cd: a working folder held through a long queue wait can go stale on /mnt/e,
# and cmd.exe then fails with no output.
"$HEAVY" bash -c 'cd "$1" || { echo "[run-rig] run folder unreadable" >&2; exit 97; }; exec cmd.exe /c "$2"' launch "$RUN_WSL" "cd /d $PLUGIN_WIN && set TEMP=E:\bgos-worktrees\idleupd\tmp&& set TMP=E:\bgos-worktrees\idleupd\tmp&& node $script --run-dir $RUN_WIN$what --scale $scale --agents $count$cases" 2>&1 | tr -d '\r'
rc=${PIPESTATUS[0]}
after=$(wsl_jobs); ha=$(printf '%s' "$after" | sha256sum | cut -c1-12)
echo "[run-rig] WSL scheduled work after: $ha"
if [ "$hb" != "$ha" ]; then
  echo "[run-rig] FAIL: WSL scheduled work changed"
  diff <(echo "$before") <(echo "$after")
  exit 1
fi
echo "[run-rig] WSL scheduled work identical"
exit "$rc"
