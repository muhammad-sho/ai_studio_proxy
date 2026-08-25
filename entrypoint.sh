#!/bin/sh
set -eu

db_path="${DB_PATH:-/data/ai-studio-proxy.db}"
db_dir=$(dirname "$db_path")

mkdir -p "$db_dir"

legacy_db=/data/local-gemini-proxy.db
if [ "$db_path" = "/data/ai-studio-proxy.db" ] && [ -e "$legacy_db" ] && [ ! -e "$db_path" ]; then
  mv "$legacy_db" "$db_path"
  for sidecar_suffix in -wal -shm; do
    if [ -e "${legacy_db}${sidecar_suffix}" ]; then
      mv "${legacy_db}${sidecar_suffix}" "${db_path}${sidecar_suffix}"
    fi
  done
fi

if [ -d "$db_path" ]; then
  echo "Database path is a directory: $db_path" >&2
  exit 1
fi

if [ ! -e "$db_path" ]; then
  touch "$db_path"
fi

dir_uid=$(stat -c '%u' "$db_dir")
dir_gid=$(stat -c '%g' "$db_dir")

if [ "$dir_uid" = "0" ]; then
  # A directory created with sudo is commonly root-owned. The image starts
  # as root only long enough to make the mounted SQLite directory writable by
  # the unprivileged node user, then drops privileges before starting Node.
  dir_uid=1000
  dir_gid=1000
  chown "$dir_uid:$dir_gid" "$db_dir"
fi

chown "$dir_uid:$dir_gid" "$db_path"
chmod 600 "$db_path"

for sidecar in "${db_path}-wal" "${db_path}-shm"; do
  if [ -e "$sidecar" ]; then
    chown "$dir_uid:$dir_gid" "$sidecar"
    chmod 600 "$sidecar"
  fi
done

exec su-exec "$dir_uid:$dir_gid" node server.js
