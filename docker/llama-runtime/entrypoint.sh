#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${LLAMA_SWAP_CONFIG:-/config/config.yaml}"
LISTEN_ADDR="${LLAMA_SWAP_LISTEN:-0.0.0.0:8090}"
EXAMPLE_CONFIG_FILE="/config/config.example.yaml"

mkdir -p /config /models

if [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ -f "$EXAMPLE_CONFIG_FILE" ]]; then
    cp "$EXAMPLE_CONFIG_FILE" "$CONFIG_FILE"
    echo "llama-runtime: initialized $CONFIG_FILE from $EXAMPLE_CONFIG_FILE" >&2
  else
    cat >&2 <<EOF
llama-runtime: missing config file at $CONFIG_FILE

Ignite expects either:
- ./config/config.yaml
- or ./config/config.example.yaml so it can seed the real config on first startup
EOF
    exit 1
  fi
fi

exec /usr/local/bin/llama-swap --config "$CONFIG_FILE" --watch-config --listen "$LISTEN_ADDR"
