#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

print_step "1/1" "Stopping Ignite"
(
  cd "$ROOT_DIR"
  docker_compose down
)

printf '\nIgnite stopped.\n'
