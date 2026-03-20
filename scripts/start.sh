#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

print_step "1/3" "Checking Docker"
ensure_docker

print_step "2/3" "Preparing config and models folders"
ensure_layout

print_step "3/3" "Starting Ignite"
(
  cd "$ROOT_DIR"
  docker_compose up -d --build
)

printf 'llama-swap API: http://127.0.0.1:%s/v1\n' "$LLAMA_SWAP_PORT"
printf 'Ignite UI: http://127.0.0.1:%s\n' "$IGNITE_PORT"
printf 'Stop later with: ./scripts/stop.sh\n'
