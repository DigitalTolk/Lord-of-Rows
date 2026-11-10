#!/usr/bin/env bash
# Private QA instance on display :98 with its own HOME (does not touch the user's :99 preview).
pkill -f "Xvfb :98" 2>/dev/null; rm -f /tmp/.X98-lock /tmp/.X11-unix/X98
export DISPLAY=:98 HOME=/tmp/qa XDG_DATA_HOME=/tmp/qa/.local/share WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
rm -rf /tmp/qa; mkdir -p $XDG_DATA_HOME
Xvfb :98 -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 1
fluxbox >/dev/null 2>&1 &
nohup dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; exec /target/debug/dbstudio' >/tmp/qa.log 2>&1 &
echo started
