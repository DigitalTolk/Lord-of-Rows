#!/usr/bin/env bash
# Load the demo fixtures (shop schema/tables) into the docker-compose test databases.
# The integration tests (e.g. SSH tunnel tests) and E2E specs expect them.
# Usage (from the repo root, services up): tests/fixtures/load.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
wait_for() { for _ in $(seq 1 60); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done; echo "timed out: $*" >&2; return 1; }

wait_for docker compose exec -T postgres pg_isready -U dbs_test -d dbs_test
docker compose exec -T postgres psql -q -U dbs_test -d dbs_test -v ON_ERROR_STOP=1 < tests/fixtures/demo_pg.sql
echo "postgres: demo fixtures loaded"

for svc in mysql mariadb; do
  wait_for docker compose exec -T "$svc" sh -c 'mysqladmin ping -udbs_test -pdbs_test --silent 2>/dev/null || mariadb-admin ping -udbs_test -pdbs_test --silent'
  # MariaDB names the recursive-CTE limit max_recursive_iterations.
  if [ "$svc" = mariadb ]; then sql="$(sed 's/cte_max_recursion_depth/max_recursive_iterations/' tests/fixtures/demo_mysql.sql)"; else sql="$(cat tests/fixtures/demo_mysql.sql)"; fi
  printf '%s\n' "$sql" | docker compose exec -T "$svc" sh -c 'command -v mysql >/dev/null && exec mysql -udbs_test -pdbs_test dbs_test || exec mariadb -udbs_test -pdbs_test dbs_test'
  echo "$svc: demo fixtures loaded"
done
