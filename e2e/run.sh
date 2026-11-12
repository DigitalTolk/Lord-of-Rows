#!/usr/bin/env bash
# End-to-end tests: real app binary + real databases, driven through WebDriver
# (tauri-driver -> WebKitWebDriver). Run inside the dev container:
#   docker compose run --rm dev e2e/run.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-fund --silent
export E2E_HOME=$(mktemp -d)
export HOME=$E2E_HOME XDG_DATA_HOME=$E2E_HOME/.local/share
# SQLite fixture used by the tests.
export E2E_SQLITE=$E2E_HOME/demo.sqlite
sqlite3 "$E2E_SQLITE" "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total NUMERIC(12,2));
INSERT INTO customers (name, email) VALUES ('Ada','ada@example.com'),('Grace','grace@example.com');
INSERT INTO orders (customer_id, total) VALUES (1, 10.5),(2, 99.99);
CREATE VIEW customer_totals AS SELECT c.name, sum(o.total) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id;"
# The app opens sign-in pages of access providers with $BROWSER on Linux; this one just
# follows the redirects back to the app (see fixtures/fake-browser.mjs).
export BROWSER=$PWD/fixtures/fake-browser.mjs
export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
rm -f /tmp/.X97-lock; Xvfb :97 -screen 0 1600x1000x24 >/dev/null 2>&1 & XVFB=$!
export DISPLAY=:97
trap 'kill $XVFB 2>/dev/null || true' EXIT
dbus-run-session -- bash -c '
  echo "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
  tauri-driver --port 4444 >/tmp/tauri-driver.log 2>&1 & TD=$!
  sleep 1
  node --test --test-concurrency=1 --test-reporter=spec $@; RC=$?
  kill $TD 2>/dev/null; exit $RC' bash "${@:-$(ls tests/*.test.mjs | sort)}"
