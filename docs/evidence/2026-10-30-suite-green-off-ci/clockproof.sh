#!/bin/bash
# Runs in the clean Debian 12 VM. Red first and mutation proof for the test-only clock fixes (59ea0a8, 212aa54).
# Trees arrive as tarballs in ~/trees/<name>.tar. N runs per check; a check's count is the runs that failed.
. ~/.profile
N=10
count() { # $1 dir, $2 test file -> failed runs of N
  local fails=0 i
  for i in $(seq 1 $N); do (cd "$1" && npx tsx --test "$2" > /tmp/one.log 2>&1) || fails=$((fails+1)); done
  echo "$fails"
}
prep() { # $1 name -> ~/w/<name> with deps
  rm -rf ~/w/$1 && mkdir -p ~/w/$1 && tar -xf ~/trees/$1.tar -C ~/w/$1
  (cd ~/w/$1 && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm t && ln -s ~/w/deps/node_modules node_modules)
}
mkdir -p ~/w/deps && tar -xf ~/trees/tip.tar -C ~/w/deps package.json bun.lock && (cd ~/w/deps && bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1)

LATE=test/private-turn-late-line.test.ts
AUTH=test/private-turn-owner-authority.test.ts
TAP=test/private-turn-owner-tap.test.ts

echo "## red first, at each fix's own commit (failed runs of $N)"
for c in 86fa955 59ea0a8; do prep $c; echo "$c $LATE: $(count ~/w/$c $LATE)"; done
for c in ffb2b3c 212aa54; do prep $c; echo "$c $AUTH: $(count ~/w/$c $AUTH)"; echo "$c $TAP: $(count ~/w/$c $TAP)"; done

echo "## the unmutated tip (failed runs of $N)"
prep tip
for f in $LATE $AUTH $TAP; do echo "tip $f: $(count ~/w/tip $f)"; done

mutant() { # $1 name, $2 file, $3 old line, $4 new line, $5.. test files
  local name=$1 file=$2 old=$3 new=$4; shift 4
  prep tip; mv ~/w/tip ~/w/$name
  python3 - "$HOME/w/$name/$file" "$old" "$new" <<'PY'
import sys
p, old, new = sys.argv[1:]
s = open(p).read()
assert s.count(old) == 1, f'{old!r} occurs {s.count(old)} times'
open(p, 'w').write(s.replace(old, new))
PY
  local line; line=$(grep -nF -- "${new:-__none__}" "$HOME/w/$name/$file" | head -1 | cut -d: -f1)
  echo "=== $name  $file"
  echo "-  $(echo "$old" | sed 's/^ *//')"
  echo "+  $(echo "$new" | sed 's/^ *//')"
  (cd ~/w/$name && bun build --no-bundle "$file" > /dev/null 2>&1) && echo "   parses" || echo "   DOES NOT PARSE: no kill"
  for f in "$@"; do echo "   $f: $(count ~/w/$name $f) of $N runs failed"; done
}
echo "## mutants of the tip"
mutant F1 test/helpers/file-clock.ts '    if (statSync(probe).mtimeMs > after) return' '    return' $LATE $AUTH
mutant F2 test/helpers/private-turn-host.ts '  fileClockPast(at)' '  void at' $AUTH $TAP
mutant F3 test/private-turn-late-line.test.ts '      fileClockPast(Date.now())' '      void Date.now()' $LATE
echo "## done"
