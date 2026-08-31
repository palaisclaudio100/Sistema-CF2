#!/bin/sh
set -eu

RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
ROOT="/tmp/cf2-backup-restore-$RUN_ID"
DOWNLOADS="$ROOT/downloads"
PG_ROOT="$ROOT/postgres"
WORK="$ROOT/work"

cleanup() {
  rm -rf -- "$ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -m 700 "$ROOT" "$DOWNLOADS" "$PG_ROOT" "$WORK"

fetch() {
  url="$1"
  output="$2"
  expected="$3"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url" -o "$output"
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

fetch \
  'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-18_18.6-1.pgdg12+2_amd64.deb' \
  "$DOWNLOADS/postgresql-18.deb" \
  '4af50c239aaee4a5f4a8d621356b42d2343f4a1ddb5ec710eb98b2d3737103d8'
fetch \
  'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-client-18_18.6-1.pgdg12+2_amd64.deb' \
  "$DOWNLOADS/postgresql-client-18.deb" \
  '6105a64b8166ae06c2b6c681d7e600458c598151c08b0f10bf5fa25ac711d6b9'
fetch \
  'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/libpq5_18.6-1.pgdg12+2_amd64.deb' \
  "$DOWNLOADS/libpq5.deb" \
  '9dc15f3f41090e632e0449693323f18c96bfd25794c439d8bcde06af6c5012f6'
fetch \
  'https://deb.debian.org/debian/pool/main/libu/liburing/liburing2_2.3-3_amd64.deb' \
  "$DOWNLOADS/liburing2.deb" \
  'c23077e3640e6cb4b819c134b3f41d5cf21b3edac099654b1b4142c3069a39a3'

for package in "$DOWNLOADS"/*.deb; do
  dpkg-deb -x "$package" "$PG_ROOT"
done

export PATH="$PG_ROOT/usr/lib/postgresql/18/bin:$PATH"
export LD_LIBRARY_PATH="$PG_ROOT/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CF2_GATE_RUN_ID="$RUN_ID"
export CF2_GATE_WORK_DIR="$WORK"

node "${CF2_GATE_SCRIPT:?CF2_GATE_SCRIPT_REQUIRED}"
