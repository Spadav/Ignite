#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${LLAMA_SWAP_CONFIG:-/config/config.yaml}"
LISTEN_ADDR="${LLAMA_SWAP_LISTEN:-0.0.0.0:8090}"

mkdir -p /config /models

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat >&2 <<EOF
llama-runtime: missing config file at $CONFIG_FILE

Phase 0 note:
- create ./config/config.yaml on the host
- ensure model commands inside it point to a llama-server binary available in this container
EOF
  exit 1
fi

exec /usr/local/bin/llama-swap --config "$CONFIG_FILE" --watch-config --listen "$LISTEN_ADDR"
