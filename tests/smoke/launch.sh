#!/usr/bin/env bash
# Launch the built app under Xvfb, wait, screenshot, and verify it stays alive.
# Usage (inside dev container): tests/smoke/launch.sh /target/debug/dbstudio out.png
set -euo pipefail
BIN=${1:-/target/debug/dbstudio}
OUT=${2:-/work/tests/smoke/screenshot.png}
export HOME=$(mktemp -d)
export XDG_DATA_HOME=$HOME/.local/share
export WEBKIT_DISABLE_COMPOSITING_MODE=1
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
XVFB=$!
export DISPLAY=:99
sleep 1
dbus-run-session -- bash -c "
  echo '' | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 || true
  '$BIN' > \$HOME/app.log 2>&1 &
  APP=\$!
  sleep 12
  if ! kill -0 \$APP 2>/dev/null; then echo 'APP EXITED EARLY'; cat \$HOME/app.log; exit 1; fi
  import -window root '$OUT'
  echo 'APP ALIVE after 12s'
  ls -la \$XDG_DATA_HOME/dev.dbstudio.app/ 2>/dev/null || true
  kill \$APP
" ; RC=$?
kill $XVFB 2>/dev/null || true
exit $RC
