#!/usr/bin/env bash
set -u
export DISPLAY=:99 HOME=/home/app XDG_DATA_HOME=/home/app/.local/share WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
mkdir -p $XDG_DATA_HOME /home/app/demo
# Clear stale display locks left by a previous run (container restart keeps /tmp).
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
# VNC is reachable only through the 127.0.0.1-bound port mapping in docker-compose.
x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/tmp/vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
# Demo SQLite database so there's something to open immediately.
if [ ! -f /home/app/demo/demo.sqlite ]; then
  sqlite3 /home/app/demo/demo.sqlite <<'SQL'
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, country TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total NUMERIC(12,2) NOT NULL, status TEXT, meta JSON);
CREATE INDEX orders_customer ON orders(customer_id);
INSERT INTO customers (name, email, country) VALUES ('Ada Lovelace','ada@example.com','UK'),('Grace Hopper','grace@example.com','US'),('Alan Turing','alan@example.com','UK'),('Katherine Johnson','kj@example.com','US'),('Edsger Dijkstra',NULL,'NL');
INSERT INTO orders (customer_id,total,status,meta) VALUES (1,120.50,'paid','{"items":3}'),(1,15.00,'refunded',NULL),(2,999.99,'paid','{"items":1,"gift":true}'),(3,42.00,'pending',NULL),(4,310.10,'paid','{"items":7}');
CREATE VIEW customer_totals AS SELECT c.name, count(o.id) AS orders, sum(o.total) AS revenue FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id;
SQL
fi
echo "noVNC ready: http://localhost:6080/vnc.html?autoconnect=1&resize=scale"
dbus-run-session -- bash -c '
  echo "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
  while true; do /target/debug/dbstudio; echo "app exited; restarting in 2s"; sleep 2; done'
