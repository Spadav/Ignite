#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

CONFIG_DIR="${IGNITE_CONFIG_DIR:-${SWAPDECK_CONFIG_DIR:-$ROOT_DIR/config}}"
MODELS_DIR="${IGNITE_MODELS_DIR:-${SWAPDECK_MODELS_DIR:-$ROOT_DIR/models}}"
IGNITE_PORT="${IGNITE_PORT:-3000}"
LLAMA_SWAP_PORT="${LLAMA_SWAP_PORT:-8090}"
SPEACHES_PORT="${SPEACHES_PORT:-8000}"
SPEACHES_ACCEL="${SPEACHES_ACCEL:-cpu}"
LLAMA_CPP_IMAGE="${LLAMA_CPP_IMAGE:-}"
LLAMA_SWAP_VERSION="${LLAMA_SWAP_VERSION:-}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
SPEACHES_CUDA_COMPOSE_FILE="$ROOT_DIR/docker-compose.speaches-cuda.yml"
GPU_CDI_COMPOSE_FILE="$ROOT_DIR/docker-compose.gpu-cdi.yml"
GPU_NVIDIA_COMPOSE_FILE="$ROOT_DIR/docker-compose.gpu-nvidia.yml"
GPU_COMPOSE_FILE="${IGNITE_GPU_COMPOSE_FILE:-}"

load_persisted_runtime_overrides() {
  local settings_file="$CONFIG_DIR/ignite-settings.json"
  [[ -f "$settings_file" ]] || return
  command -v python3 >/dev/null 2>&1 || return

  local persisted_speaches_accel persisted_llama_cpp_image persisted_llama_swap_version
  persisted_speaches_accel="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print((data.get("speaches_accel") or "").strip())' "$settings_file" 2>/dev/null || true)"
  persisted_llama_cpp_image="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print((data.get("llama_cpp_image") or "").strip())' "$settings_file" 2>/dev/null || true)"
  persisted_llama_swap_version="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(str(data.get("llama_swap_version") or "").strip().lstrip("v"))' "$settings_file" 2>/dev/null || true)"

  if [[ -z "${SPEACHES_ACCEL:-}" || "${SPEACHES_ACCEL}" == "cpu" ]]; then
    if [[ "$persisted_speaches_accel" == "cpu" || "$persisted_speaches_accel" == "cuda" ]]; then
      SPEACHES_ACCEL="$persisted_speaches_accel"
    fi
  fi

  if [[ -z "${LLAMA_CPP_IMAGE:-}" && -n "$persisted_llama_cpp_image" ]]; then
    LLAMA_CPP_IMAGE="$persisted_llama_cpp_image"
  fi

  if [[ -z "${LLAMA_SWAP_VERSION:-}" && -n "$persisted_llama_swap_version" ]]; then
    LLAMA_SWAP_VERSION="$persisted_llama_swap_version"
  fi

  export SPEACHES_ACCEL
  export LLAMA_CPP_IMAGE
  export LLAMA_SWAP_VERSION
}

load_persisted_runtime_overrides

detect_gpu_compose_file() {
  [[ -n "${GPU_COMPOSE_FILE:-}" ]] && return
  command -v docker >/dev/null 2>&1 || return

  local docker_info
  docker_info="$(docker info --format '{{json .Runtimes}} {{json .CDISpecDirs}}' 2>/dev/null || true)"
  if [[ "$docker_info" == *'"nvidia"'* ]]; then
    GPU_COMPOSE_FILE="$GPU_NVIDIA_COMPOSE_FILE"
  elif [[ "$docker_info" == *"/etc/cdi"* || "$docker_info" == *"/var/run/cdi"* ]]; then
    GPU_COMPOSE_FILE="$GPU_CDI_COMPOSE_FILE"
  fi
  export GPU_COMPOSE_FILE
}

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
  detect_gpu_compose_file
  if [[ -n "${GPU_COMPOSE_FILE:-}" && -f "${GPU_COMPOSE_FILE}" ]]; then
    compose_args+=("-f" "$GPU_COMPOSE_FILE")
  fi
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
  mkdir -p "$CONFIG_DIR" "$MODELS_DIR" "$MODELS_DIR/audio/huggingface"
  if [[ ! -f "$MODELS_DIR/audio/model_aliases.json" ]]; then
    printf '{}\n' > "$MODELS_DIR/audio/model_aliases.json"
  fi
  if [[ ! -f "$CONFIG_DIR/config.yaml" && -f "$CONFIG_DIR/config.example.yaml" ]]; then
    cp "$CONFIG_DIR/config.example.yaml" "$CONFIG_DIR/config.yaml"
  fi
}

print_paths() {
  printf 'Project: %s\n' "$ROOT_DIR"
  printf 'Config:  %s\n' "$CONFIG_DIR"
  printf 'Models:  %s\n' "$MODELS_DIR"
  printf 'Audio Models: %s\n' "$MODELS_DIR/audio"
  printf 'UI Port:  %s\n' "$IGNITE_PORT"
  printf 'API Port: %s\n' "$LLAMA_SWAP_PORT"
  printf 'Speech:   %s\n' "$SPEACHES_PORT"
  printf 'Speech Accel: %s\n' "$SPEACHES_ACCEL"
  printf 'llama.cpp Image: %s\n' "${LLAMA_CPP_IMAGE:-spadav/llama-cpp-server:latest}"
  printf 'llama-swap Version: %s\n' "${LLAMA_SWAP_VERSION:-211}"
  detect_gpu_compose_file
  if [[ -n "${GPU_COMPOSE_FILE:-}" ]]; then
    printf 'GPU Mode: %s\n' "$(basename "$GPU_COMPOSE_FILE")"
  else
    printf 'GPU Mode: none\n'
  fi
}
