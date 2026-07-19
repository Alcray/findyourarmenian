#!/bin/sh
set -eu

# Railway volumes are mounted as root. Keep privileged filesystem work scoped to
# the fixed application data directory, then run the service as the node user.
data_root=/app/data

if [ -L "$data_root" ]; then
  echo "Refusing to initialize a symlinked data directory: $data_root" >&2
  exit 1
fi

mkdir -p "$data_root/raw-runs"
chown -Rh node:node "$data_root"

exec su-exec node "$@"
