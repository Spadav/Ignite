#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

print_step "1/4" "Checking Docker"
ensure_docker

print_step "2/4" "Preparing config and models folders"
ensure_layout
print_paths

print_step "3/4" "Checking Docker GPU support"
if docker run --rm --gpus all --entrypoint sh ghcr.io/ggml-org/llama.cpp:server-cuda -lc 'nvidia-smi -L' >/tmp/ignite-gpu-check.log 2>&1; then
  printf 'GPU passthrough is ready.\n'
else
  cat /tmp/ignite-gpu-check.log >&2 || true
  fail "Docker GPU support is not ready. Install/configure NVIDIA Container Toolkit before using Ignite."
fi

print_step "4/4" "Ignite is ready to start"
printf 'Run: ./scripts/start.sh\n'
printf 'Then open: http://127.0.0.1:%s\n' "$IGNITE_PORT"
