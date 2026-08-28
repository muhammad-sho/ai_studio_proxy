#!/bin/sh
set -eu

# Docker Compose stays configuration-free. Optional settings live beside the
# persistent data in ./volumes/.env and never need to be named in Compose.
# Explicit container environment variables always take precedence.
if [ -r /data/.env ]; then
  while IFS= read -r env_line || [ -n "$env_line" ]; do
    case "$env_line" in
      "" | \#*) continue ;;
    esac
    env_name=${env_line%%=*}
    env_value=${env_line#*=}
    case "$env_name" in
      DB_PATH|DEBUG|TRUST_PROXY|REQUEST_TIMEOUT_MS|MAX_BODY_BYTES|MAX_RESPONSE_BYTES|LOG_BODY_MAX_BYTES|MAX_LOG_ENTRIES|USAGE_RETENTION_DAYS|CORS_ORIGIN)
        if ! printenv "$env_name" >/dev/null; then export "$env_name=$env_value"; fi
        ;;
    esac
  done < /data/.env
fi

db_path="${DB_PATH:-/data/ai-studio-proxy.db}"
case "$db_path" in
  /*) ;;
  *) echo "DB_PATH must be an absolute path inside the container" >&2; exit 1 ;;
esac

db_dir=$(dirname "$db_path")
db_name=$(basename "$db_path")
mkdir -p "$db_dir"
db_dir=$(cd "$db_dir" && pwd -P)

if [ "$db_dir" = "/" ] || [ "$db_name" = "." ] || [ "$db_name" = ".." ]; then
  echo "DB_PATH must name a file inside a non-root directory" >&2
  exit 1
fi

db_path="$db_dir/$db_name"
if [ -d "$db_path" ]; then
  echo "Database path is a directory: $db_path" >&2
  exit 1
fi
if [ -L "$db_path" ]; then
  echo "Database path must not be a symlink: $db_path" >&2
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
  if [ -L "$sidecar" ]; then
    echo "Database sidecar must not be a symlink: $sidecar" >&2
    exit 1
  fi
  if [ -e "$sidecar" ]; then
    chown "$dir_uid:$dir_gid" "$sidecar"
    chmod 600 "$sidecar"
  fi
done

export DB_PATH="$db_path"
exec su-exec "$dir_uid:$dir_gid" node server.js
