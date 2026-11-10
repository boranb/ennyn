#!/bin/sh
# A copy of the hand-written ticket queue that ennyn lock keeps step with (test/heavy-lock.test.mjs), its folder taken
# from ENNYN_LOCK_DIR as the command takes it. The rest is as written.
# One heavy job at a time on this machine, first come first served: suites run through this.
# A waiter takes a ticket in queue/; it takes the lock only when its ticket is the oldest live one.
# A ticket whose pid is gone is dropped; a lock older than 120 minutes is a dead run's.
set -u
base="${ENNYN_LOCK_DIR:-$HOME/.ennyn-lock}"
lock="$base/suite.lock"
queue="$base/queue"
mkdir -p "$queue"
ticket="$queue/$(perl -MTime::HiRes=time -e 'printf "%017.6f", time')-$$"
: > "$ticket"
trap 'rm -f "$ticket"' EXIT
trap 'exit 130' INT TERM HUP
while :; do
  for t in "$queue"/*; do
    [ -e "$t" ] || continue
    p=${t##*-}
    kill -0 "$p" 2>/dev/null || rm -f "$t"
  done
  first=$(ls "$queue" | sort | head -n 1)
  if [ "$queue/$first" = "$ticket" ]; then
    if mkdir "$lock" 2>/dev/null; then break; fi
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null; continue; fi
  fi
  sleep 3
done
rm -f "$ticket"
trap 'rmdir "$lock" 2>/dev/null' EXIT
echo "lock taken: $(pwd) load $(uptime | sed 's/.*averages: //')"
"$@"
