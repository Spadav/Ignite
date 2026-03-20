#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

print_step "1/4" "Checking Docker"
ensure_docker

print_step "2/4" "Preparing config and models folders"
ensure_layout

print_step "3/4" "Pulling latest repo changes"
git -C "$ROOT_DIR" pull --ff-only

print_step "4/4" "Rebuilding and restarting Ignite"
(
  cd "$ROOT_DIR"
  docker_compose up -d --build
)

printf '\nIgnite updated.\n'
