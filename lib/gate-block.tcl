# hoai startup gate block. ONE copy, two consumers: bin/hoai-core.mjs embeds it in
# the launcher's expect script, bin/bgos-agent copies it into the supervisor's
# run.expect at install time. It runs right after `spawn claude ...` and leaves:
#
#   hoai_outcome   live | live-but-not-signed-in | no-live-marker |
#                  gate-unrecognised | gate-unreadable:<gate> | gate-repeated:<gate> |
#                  exited-during-startup
#   hoai_answered  the gates it answered, in order (trust bypass channels resume)
#   hoai_screen    the words of the screen it could not answer, else ""
#
# THE RULE: a key is only ever sent to a screen that was READ, and the key is
# derived from what that screen says. Every line below was run against the real
# CLI (Claude Code 2.1.278, 2026-09-21), not reasoned about:
#
#   * Folder trust and the bypass warning both list the DECLINING option first
#     ("No, exit"). Enter alone exits claude, code 0, nothing printed. Measured.
#   * The dev-channels warning lists the WANTED option first. The keys that accept
#     trust (Down, Enter) select "Exit" there. Measured, by accident, which is
#     exactly why no key may be chosen without knowing the screen.
#   * A Down arrow does move the selection over a raw PTY: ESC [ B, ESC O B,
#     Ctrl-N and j all work, with or without a settle delay. The earlier finding
#     that no keystroke works was a harness artefact.
#   * The TUI separates words with cursor moves as often as with spaces, so a
#     phrase only matches as its words with escapes allowed between them. The
#     old live marker {bypass permissions on} matched on some paints and not on
#     others, which is what the old blind Enters were papering over.
#
# So each gate is recognised by one word only it carries plus the "confirm"
# footer of the same paint, and answered by reading which option is painted
# first: Enter when the wanted one leads, Down then Enter when the declining one
# does. If a future Claude Code flips the order, the answer flips with it. A
# screen whose options cannot be read is NOT answered. Nothing is sent on a
# timeout. Each gate is answered at most once, so a word that reappears in the
# live banner ("channels" does) can never turn into Enters typed into the REPL.

set timeout 12
set hoai_outcome ""
set hoai_answered {}
set hoai_screen ""
set hoai_gap {(?:\x1b\[[0-9;?]*[A-Za-z]|[ \r\n])+}

# The words of a raw paint, for a status line a person can read.
proc hoai_plain {raw} {
  regsub -all {\x1b\[[0-9;?<>=]*[A-Za-z]} $raw " " s
  regsub -all {\x1b\][^\a]*\a} $s "" s
  regsub -all {[^\x20-\x7e]+} $s " " s
  regsub -all { +} $s " " s
  return [string range [string trim $s] 0 400]
}

# Answer one recognised gate. `want` is a word ONLY the wanted option carries and
# `avoid` a word ONLY the declining option carries: neither may occur in the
# prose above the options, or the order test reads the prose instead. That is
# why the dev-channels gate keys on "using" and not "local" (its prose says "for
# local channel development"), and the session-age gate on "recommended" and not
# "summary" (its prose says "resuming from a summary").
proc hoai_answer {gate body want avoid} {
  global hoai_outcome hoai_answered hoai_screen
  if {[lsearch -exact $hoai_answered $gate] >= 0} {
    set hoai_outcome "gate-repeated:$gate"
    set hoai_screen [hoai_plain $body]
    return
  }
  set w [string first $want $body]
  set a [string first $avoid $body]
  if {$w < 0} {
    set hoai_outcome "gate-unreadable:$gate"
    set hoai_screen [hoai_plain $body]
    return
  }
  lappend hoai_answered $gate
  sleep 1
  if {$a >= 0 && $a < $w} { send -- "\x1b\[B"; sleep 1 }
  send -- "\r"
}

while {$hoai_outcome eq ""} {
  expect {
    -re {(?i)experimental}                            { set hoai_outcome live }
    -re {(?i)connecting}                              { set hoai_outcome live }
    -re "bypass${hoai_gap}permissions${hoai_gap}on"   { set hoai_outcome live }
    -re {safety(.*?)confirm}                          { hoai_answer trust    $expect_out(1,string) "Yes"         "exit" }
    -re {Bypass(.*?)confirm}                          { hoai_answer bypass   $expect_out(1,string) "Yes"         "exit" }
    -re {channels(.*?)confirm}                        { hoai_answer channels $expect_out(1,string) "using"       "Exit" }
    -re {Resuming(.*?)confirm}                        { hoai_answer resume   $expect_out(1,string) "recommended" "as-is" }
    -re {(.*)confirm}                                 { set hoai_outcome "gate-unrecognised"; set hoai_screen [hoai_plain $expect_out(1,string)] }
    eof                                               { set hoai_outcome "exited-during-startup" }
    timeout                                           { set hoai_outcome "no-live-marker" }
  }
}

# A live TUI whose footer says "Not logged in · Run /login" is up but cannot
# work. Naming that beats a five minute wait that ends in a guess.
if {$hoai_outcome eq "live"} {
  set timeout 3
  expect {
    -re {/login} { set hoai_outcome "live-but-not-signed-in" }
    timeout      {}
    eof          { set hoai_outcome "exited-during-startup" }
  }
}
