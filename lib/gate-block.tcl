# hoai startup gate block. ONE copy, two consumers: bin/hoai-core.mjs embeds it in
# the launcher's expect script, bin/bgos-agent copies it into the supervisor's
# run.expect at install time. It runs right after `spawn claude ...` and leaves:
#
#   hoai_outcome   live | live-but-not-signed-in | no-live-marker |
#                  gate-unrecognised | gate-unreadable:<gate> | gate-repeated:<gate> |
#                  gate-selection-stuck:<gate> |
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
# footer of the same paint, and answered by reading WHERE THE SELECTION MARKER
# SITS: Enter when it is on the wanted option, Down then Enter when it is on the
# declining one. If a future Claude Code flips the order, the answer flips with
# it. A screen whose options cannot be read is NOT answered. Nothing is sent on
# a timeout. Each gate is answered at most once, so a word that reappears in the
# live banner ("channels" does) can never turn into Enters typed into the REPL.
#
# WHEN a key is sent matters as much as which key (2026-09-22, measured on a
# returning owner's signed-in config, bare expect, 12 timed runs). A Down sent
# within about 100 ms of the gate's footer painting is PAINTED, the marker moves
# to "Yes", and is not honoured: the Enter that follows a full second later still
# declines and claude exits. From about 150 ms on, the same bytes work. Nothing
# resets on its own; the early key simply lands on a UI instance that is replaced
# when claude finishes initialising (it writes its terminal queries about 50 ms
# after the first paint). That is how a correct key came to look like "no
# keystroke works": 3 of 3 failing when sent mid-paint, 3 of 3 working when sent
# after the paint, same config, same bytes.
#
# A repaint cannot reveal that state, so the block does three things instead of
# trusting a fixed delay under launchd at login:
#   1. it waits until the screen has been QUIET for a full second before the
#      first key, so a slow start pushes the key later by itself;
#   2. the supervisor adds hoai_extra_settle seconds, which run.expect derives
#      from run.sh's own fail count, so a launch that lost the race is followed by
#      one that waits longer (2 s, 4 s, ... 10 s);
#   3. after every Down it reads the repaint, sends Down again if the marker is
#      not on the wanted option, and presses Enter only once it has sat there
#      for a quiet second.
# If claude exits anyway, that is outcome exited-during-startup with the gates
# answered first, never silence.

# The default match buffer is 2000 bytes. A gate paint is 1 to 1.5 KB of escapes today, so the word
# that identifies the gate could be pushed out before its footer arrives. Measured by review.
match_max 100000
set timeout 12
set hoai_outcome ""
set hoai_answered {}
set hoai_screen ""
# Extra seconds to wait before the first key of each gate. The supervisor sets it
# from its fail count before this block runs; everything else leaves it at 0.
if {![info exists hoai_extra_settle]} { set hoai_extra_settle 0 }
set hoai_gap {(?:\x1b\[[0-9;?]*[A-Za-z]|[ \r\n])+}
# The selection marker, U+276F, as decoded UTF-8 and as the three raw bytes a
# launchd job with no LANG sees them.
set hoai_mark {(?:\u276f|\u00e2\u009d\u00af)}
# Every gate ends "Enter to confirm". The bare word is not enough: hoai resumes sessions, and a
# transcript that says "can you confirm the booking" painted above the prompt is not a gate.
set hoai_footer "Enter${hoai_gap}to${hoai_gap}confirm"

# The words of a raw paint, for a status line a person can read.
proc hoai_plain {raw} {
  regsub -all {\x1b\[[0-9;?<>=]*[A-Za-z]} $raw " " s
  regsub -all {\x1b\][^\a]*\a} $s "" s
  regsub -all {[^\x20-\x7e]+} $s " " s
  regsub -all { +} $s " " s
  return [string range [string trim $s] end-400 end]
}

# Wait until claude has written nothing for a full second (8 s at most), then any
# extra settle the supervisor asked for. The gate is a static screen, so silence
# means claude has finished setting itself up behind it.
proc hoai_wait_quiet {} {
  global hoai_extra_settle
  set until [expr {[clock seconds] + 8}]
  while {[clock seconds] < $until} {
    set quiet 1
    expect {
      -timeout 1
      -re {.+} { set quiet 0 }
      timeout {}
      eof {}
    }
    if {$quiet} { break }
  }
  if {$hoai_extra_settle > 0} { sleep $hoai_extra_settle }
}

# Which option is highlighted in `text`: the first of `want` / `avoid` to occur
# after the LAST selection marker. "unknown" when there is no marker to read.
proc hoai_selected {text want avoid} {
  global hoai_mark
  set last -1
  foreach hit [regexp -all -inline -indices -- $hoai_mark $text] { set last [lindex $hit 1] }
  if {$last < 0} { return unknown }
  set tail [string range $text [expr {$last + 1}] end]
  set w [string first $want $tail]
  set a [string first $avoid $tail]
  if {$w < 0 && $a < 0} { return unknown }
  if {$a < 0 || ($w >= 0 && $w < $a)} { return want }
  return avoid
}

# Answer one recognised gate. `want` is a word ONLY the wanted option carries and
# `avoid` a word ONLY the declining option carries: neither may occur in the
# prose above the options, or the order test reads the prose instead. That is
# why the dev-channels gate keys on "using" and not "local" (its prose says "for
# local channel development"), and the session-age gate on "recommended" and not
# "summary" (its prose says "resuming from a summary").
proc hoai_answer {gate body want avoid} {
  global hoai_outcome hoai_answered hoai_screen hoai_mark
  if {[lsearch -exact $hoai_answered $gate] >= 0} {
    set hoai_outcome "gate-repeated:$gate"
    set hoai_screen [hoai_plain $body]
    return
  }
  if {[string first $want $body] < 0 || [string first $avoid $body] < 0} {
    # BOTH options must be readable. With only the wanted word found, "it is
    # painted first" would be a guess, and the guess is an Enter on "No, exit".
    set hoai_outcome "gate-unreadable:$gate"
    set hoai_screen [hoai_plain $body]
    return
  }
  set state [hoai_selected $body $want $avoid]
  if {$state eq "unknown"} {
    # No marker to read (a glyph this build does not know). Fall back to paint
    # order: the option painted first is the highlighted default.
    set a [string first $avoid $body]
    set state [expr {($a >= 0 && $a < [string first $want $body]) ? "avoid" : "want"}]
  }
  lappend hoai_answered $gate
  hoai_wait_quiet
  set downs 0
  while {1} {
    set sent 0
    if {$state eq "avoid"} {
      if {$downs >= 4} {
        set hoai_outcome "gate-selection-stuck:$gate"
        set hoai_screen [hoai_plain $body]
        return
      }
      send -- "\x1b\[B"
      incr downs
      set sent 1
    }
    # Collect everything painted until the screen has been quiet for a second, then
    # read where the marker sits in it. Plain string scanning on purpose: in a Tcl
    # ARE an alternation makes the WHOLE expression greedy, so a pattern such as
    # marker(.{0,200}?)(Yes|exit) skips "exit" and reports "Yes". A test caught
    # exactly that.
    set painted ""
    expect {
      -timeout 1
      -re {.+} { append painted $expect_out(0,string); exp_continue }
      timeout {}
      eof { set hoai_outcome "exited-during-startup"; return }
    }
    set seen [hoai_selected $painted $want $avoid]
    if {$seen ne "unknown"} {
      set state $seen
    } elseif {$sent} {
      # The Down drew no repaint this block can read. Take the key at its word,
      # which is what a timed answer always did.
      set state want
    }
    if {$state eq "want"} { break }
  }
  send -- "\r"
}

# A screen with the gate footer that no rule recognises. Before calling it a gate,
# give a live marker five seconds to follow: a real gate never goes live by
# itself, while a busy first frame can carry the footer words a read ahead of
# its own live marker. Killing a healthy session is the worse mistake.
proc hoai_unrecognised {body} {
  global hoai_outcome hoai_screen hoai_gap
  set screen [hoai_plain $body]
  expect {
    -timeout 5
    -nocase -re {experimental}                       { set hoai_outcome live; return }
    -nocase -re {connecting}                         { set hoai_outcome live; return }
    -re "bypass${hoai_gap}permissions${hoai_gap}on"  { set hoai_outcome live; return }
    timeout {}
    eof { set hoai_outcome "exited-during-startup"; return }
  }
  set hoai_outcome "gate-unrecognised"
  set hoai_screen $screen
}

while {$hoai_outcome eq ""} {
  expect {
    -nocase -re {experimental}                        { set hoai_outcome live }
    -nocase -re {connecting}                          { set hoai_outcome live }
    -re "bypass${hoai_gap}permissions${hoai_gap}on"   { set hoai_outcome live }
    -re "safety(.*?)${hoai_footer}"                   { hoai_answer trust    $expect_out(1,string) "Yes"         "exit" }
    -re "Bypass(.*?)${hoai_footer}"                   { hoai_answer bypass   $expect_out(1,string) "Yes"         "exit" }
    -re "channels(.*?)${hoai_footer}"                 { hoai_answer channels $expect_out(1,string) "using"       "Exit" }
    -re "Resuming(.*?)${hoai_footer}"                 { hoai_answer resume   $expect_out(1,string) "recommended" "as-is" }
    -re "(.*)${hoai_footer}"                          { hoai_unrecognised $expect_out(1,string) }
    eof                                               { set hoai_outcome "exited-during-startup" }
    timeout                                           { set hoai_outcome "no-live-marker" }
  }
}

# A live TUI whose footer says "Not logged in" is up but cannot work. Naming that
# beats a five minute wait that ends in a guess. The PHRASE, with gaps, and not
# the bare "/login": the supervisor exits on this, and a resumed transcript or a
# tip line may mention /login in a session that is signed in perfectly well.
if {$hoai_outcome eq "live"} {
  set timeout 3
  expect {
    -re "Not${hoai_gap}logged${hoai_gap}in" { set hoai_outcome "live-but-not-signed-in" }
    timeout                                 {}
    eof                                     { set hoai_outcome "exited-during-startup" }
  }
}
