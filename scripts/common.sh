#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${IGNITE_CONFIG_DIR:-${SWAPDECK_CONFIG_DIR:-$ROOT_DIR/config}}"
MODELS_DIR="${IGNITE_MODELS_DIR:-${SWAPDECK_MODELS_DIR:-$ROOT_DIR/models}}"
IGNITE_PORT="${IGNITE_PORT:-3000}"
LLAMA_SWAP_PORT="${LLAMA_SWAP_PORT:-8090}"
SPEACHES_PORT="${SPEACHES_PORT:-8000}"
SPEACHES_ACCEL="${SPEACHES_ACCEL:-cpu}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
SPEACHES_CUDA_COMPOSE_FILE="$ROOT_DIR/docker-compose.speaches-cuda.yml"

print_step() {
  printf '\n[%s] %s\n' "$1" "$2"
}

fail() {
  printf '\n[error] %s\n' "$1" >&2
  exit 1
}

ensure_command() {
  local command_name="$1"
  local hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "$hint"
  fi
}

docker_compose() {
  local compose_args=("-f" "$COMPOSE_FILE")
  if [[ "${SPEACHES_ACCEL}" == "cuda" ]]; then
    compose_args+=("-f" "$SPEACHES_CUDA_COMPOSE_FILE")
  fi
  docker compose "${compose_args[@]}" "$@"
}

ensure_supported_platform() {
  local platform
  platform="$(uname -s)"
  if [[ "$platform" != "Linux" ]]; then
    fail "Ignite currently supports Linux only. Windows and macOS wrapper scripts are not implemented yet."
  fi
}

ensure_docker() {
  ensure_supported_platform
  ensure_command docker "Docker is required. Install Docker first."
  if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not running or not accessible for this user."
  fi
}

ensure_layout() {
  mkdir -p "$CONFIG_DIR" "$MODELS_DIR"
  if [[ ! -f "$CONFIG_DIR/config.yaml" && -f "$CONFIG_DIR/config.example.yaml" ]]; then
    cp "$CONFIG_DIR/config.example.yaml" "$CONFIG_DIR/config.yaml"
  fi
}

print_paths() {
  printf 'Project: %s\n' "$ROOT_DIR"
  printf 'Config:  %s\n' "$CONFIG_DIR"
  printf 'Models:  %s\n' "$MODELS_DIR"
  printf 'UI Port:  %s\n' "$IGNITE_PORT"
  printf 'API Port: %s\n' "$LLAMA_SWAP_PORT"
  printf 'Speech:   %s\n' "$SPEACHES_PORT"
  printf 'Speech Accel: %s\n' "$SPEACHES_ACCEL"
}
