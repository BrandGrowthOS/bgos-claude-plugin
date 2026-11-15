# Claude Code 2.1.319, Autonomee's pane (2026-11-12)

`pane.ansi` is the bottom of assistant 863's tmux pane on kc-server, read only with
`tmux -S /tmp/tmux-1000/hoai-863 capture-pane -p -e -t %0`. The first line (the
agent's last answer) is replaced with `● Done.`; the rest is byte for byte. tmux
reported the cursor at x=2, y=46 of the full 50 row pane, visible; in this 8 row
crop (rows 46 to 50 become rows 3 to 7) that is x=2, y=3.

Two things on it stop every model or effort switch with `composer_unknown`:

1. Row 4 (the message box's bottom rule) starts with
   `[hoai] launch: outcome=live answered=[channels] compact=on`. The supervised
   expect script prints that line after Claude Code is live, so it lands on top of
   the drawn frame, and Claude Code never repaints that row.
2. Row 3, the prompt, holds only dim (SGR 2) text: Claude Code's hint
   `restart the session to load it`. 2.1.319 draws no inverse cursor cell, and the
   reader refused any dim text there.
