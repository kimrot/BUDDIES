#!/bin/sh
# Private development Postgres inside ./data/pg (no sudo, no system config).
#   sh scripts/dev-db.sh start | stop | status | reset | psql
# Connection: postgres://buddies@127.0.0.1:5433/buddies (the server's dev default)
set -e
cd "$(dirname "$0")/.."
DIR="data/pg"
PORT="${DEV_PG_PORT:-5433}"
URL="postgres://buddies@127.0.0.1:$PORT/buddies"

# Find Postgres binaries (newest installed version).
BIN="$(pg_config --bindir 2>/dev/null || true)"
[ -x "$BIN/initdb" ] || BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -x "$BIN/initdb" ] || { echo "PostgreSQL server binaries not found. Install e.g.: sudo apt install postgresql"; exit 1; }

case "$1" in
  start)
    if [ ! -f "$DIR/PG_VERSION" ]; then
      mkdir -p "$DIR" && chmod 700 "$DIR"
      "$BIN/initdb" -D "$DIR" -U buddies --auth=trust -E UTF8 >/dev/null
      echo "Created dev database cluster in $DIR"
    fi
    if "$BIN/pg_ctl" -D "$DIR" status >/dev/null 2>&1; then echo "Already running: $URL"; exit 0; fi
    # TCP on localhost only; no Unix socket (keeps it independent of the system Postgres).
    "$BIN/pg_ctl" -D "$DIR" -l "$DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
    "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U buddies -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'buddies'" | grep -q 1 \
      || "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U buddies buddies
    echo "Dev database running: $URL"
    ;;
  stop) "$BIN/pg_ctl" -D "$DIR" stop -m fast ;;
  status) "$BIN/pg_ctl" -D "$DIR" status ;;
  reset)
    "$BIN/pg_ctl" -D "$DIR" stop -m fast >/dev/null 2>&1 || true
    rm -rf "$DIR" && echo "Dev database deleted. Run: npm run db:start"
    ;;
  psql) exec "$BIN/psql" "$URL" ;;
  *) echo "usage: sh scripts/dev-db.sh start|stop|status|reset|psql"; exit 1 ;;
esac
