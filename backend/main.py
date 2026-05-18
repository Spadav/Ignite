#!/usr/bin/env python3
"""
Llama Swap Control Panel - Backend
Manages llama-swap service, models, and configuration
"""
import os
import sys
import re
import json
import shutil
import subprocess
import logging
import time
import asyncio
from functools import lru_cache
from pathlib import Path
from typing import Optional, Dict, List, Any
from datetime import datetime, timedelta
from urllib.parse import quote

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('/tmp/llama_control_panel.log')
    ]
)
logger = logging.getLogger(__name__)

import yaml
import requests
import docker
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Form, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl, Field
import uvicorn
from downloads import ModelDownloadManager
from logs import LogService
from model_config import ModelConfigService
from model_files import ModelFileService
from speech import SpeechService

# Configuration
LLAMA_SWAP_PROCESS_FILE = "/tmp/llama_swap.pid"
LLAMA_SWAP_LOG_FILE = "/tmp/llama_swap.log"

LEGACY_SETTINGS_FILE = Path(__file__).parent / "settings.json"
SETTINGS_FILE = Path(
    os.environ.get(
        "IGNITE_SETTINGS_FILE",
        "/config/ignite-settings.json"
        if os.environ.get("IGNITE_DOCKER", os.environ.get("SWAPDECK_DOCKER", "0")) == "1"
        else str(LEGACY_SETTINGS_FILE),
    )
)
FRONTEND_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
CONFIG_EXAMPLE_FILE = Path(__file__).resolve().parent.parent / "config" / "config.example.yaml"
NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
IS_DOCKER = os.environ.get("IGNITE_DOCKER", os.environ.get("SWAPDECK_DOCKER", "0")) == "1"
FALLBACK_CONFIG_GUIDE = """Ignite Config Guide

Core fields:
- models: dictionary of model definitions
- healthCheck.model: model used for readiness checks
- globalTTL: default unload timer in seconds
- startPort: starting value for ${PORT} macro expansion

Per-model essentials:
- cmd: command used to start the model server
- proxy: upstream URL llama-swap forwards to
- name: display name
- aliases: extra model IDs using the same definition
- checkEndpoint: health endpoint checked before serving traffic
- filters.stripParams: request fields removed before forwarding
- filters.setParams: request fields enforced server-side

Advanced sections:
- macros: reusable substitutions
- groups: model loading/swap behavior
- hooks: startup actions like preload
- peers: remote providers or other llama-swap instances
- apiKeys: optional auth requirement for requests
"""

LOCAL_DEFAULT_SETTINGS = {
    "gguf_directory": "~/models",
    "llama_swap_dir": "~/llama-swap",
    "llama_swap_config": "~/llama-swap/config.yaml",
    "llama_swap_port": 8090,
    "backend_port": 8091,
    "advanced_gpu_mode": False,
    "restart_on_boot": False,
    "speaches_accel": os.environ.get("SPEACHES_ACCEL", "cpu").strip().lower() or "cpu",
    "llama_cpp_image": os.environ.get("LLAMA_CPP_IMAGE", "spadav/llama-cpp-server:latest").strip() or "spadav/llama-cpp-server:latest",
    "llama_swap_version": os.environ.get("LLAMA_SWAP_VERSION", "211").strip().lstrip("v") or "211",
}

DOCKER_IGNITE_PORT = int(os.environ.get("IGNITE_PORT", "3000"))
DOCKER_LLAMA_SWAP_PORT = int(os.environ.get("LLAMA_SWAP_PORT", "8090"))
DOCKER_SPEACHES_PORT = int(os.environ.get("SPEACHES_PORT", "8000"))

DOCKER_DEFAULT_SETTINGS = {
    "gguf_directory": "/models",
    "llama_swap_dir": "/runtime",
    "llama_swap_config": "/config/config.yaml",
    "llama_swap_port": DOCKER_LLAMA_SWAP_PORT,
    "backend_port": DOCKER_IGNITE_PORT,
    "advanced_gpu_mode": False,
    "restart_on_boot": False,
    "speaches_accel": os.environ.get("SPEACHES_ACCEL", "cpu").strip().lower() or "cpu",
    "llama_cpp_image": os.environ.get("LLAMA_CPP_IMAGE", "spadav/llama-cpp-server:latest").strip() or "spadav/llama-cpp-server:latest",
    "llama_swap_version": os.environ.get("LLAMA_SWAP_VERSION", "211").strip().lstrip("v") or "211",
}

DEFAULT_SETTINGS = DOCKER_DEFAULT_SETTINGS if IS_DOCKER else LOCAL_DEFAULT_SETTINGS
DOCKER_SOCKET_PATH = "/var/run/docker.sock"
DOCKER_RUNTIME_CONTAINER = os.environ.get("IGNITE_RUNTIME_CONTAINER", "llama-runtime")
DOCKER_LLMFIT_CONTAINER = os.environ.get("IGNITE_LLMFIT_CONTAINER", "llmfit")
DOCKER_SPEACHES_CONTAINER = os.environ.get("IGNITE_SPEACHES_CONTAINER", "speaches")
SPEACHES_CACHE_CONTAINER_DIR = "/home/ubuntu/.cache/huggingface/hub"
SPEACHES_ALIAS_CONTAINER_FILE = "/home/ubuntu/speaches/model_aliases.json"
DOCKER_SUPPORT_CONTAINERS = [
    name for name in [DOCKER_LLMFIT_CONTAINER, DOCKER_SPEACHES_CONTAINER] if name
]
DOCKER_CONTROL_WARNING = (
    "Ignite runtime controls use the host Docker socket. That gives this container control over "
    "other Docker containers on this machine."
)


def is_docker_managed_runtime() -> bool:
    return IS_DOCKER or bool(os.environ.get("LLAMA_SWAP_URL"))


def get_runtime_mode() -> str:
    return "docker" if is_docker_managed_runtime() else "local"


def get_docker_client() -> Optional[docker.DockerClient]:
    if not is_docker_managed_runtime():
        return None
    if not os.path.exists(DOCKER_SOCKET_PATH):
        return None
    try:
        client = docker.DockerClient(base_url=f"unix://{DOCKER_SOCKET_PATH}")
        client.ping()
        return client
    except Exception:
        return None


def can_manage_docker_runtime() -> bool:
    return get_docker_client() is not None


def get_docker_control_warning() -> Optional[str]:
    if not is_docker_managed_runtime():
        return None
    if not can_manage_docker_runtime():
        return None
    return DOCKER_CONTROL_WARNING


def get_docker_log_container_map() -> Dict[str, str]:
    return {
        "ignite": "ignite",
        "runtime": DOCKER_RUNTIME_CONTAINER,
        "llmfit": DOCKER_LLMFIT_CONTAINER,
        "speaches": DOCKER_SPEACHES_CONTAINER,
    }


def stop_and_remove_container(existing, stop_timeout: int, stop_message: str, remove_error: str) -> None:
    try:
        existing.stop(timeout=stop_timeout)
    except Exception:
        logger.debug(stop_message, exc_info=True)
    try:
        existing.remove()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{remove_error}: {exc}")


def connect_extra_networks(client, container, network_names: List[str], message: str) -> None:
    for extra_network in network_names[1:]:
        try:
            client.networks.get(extra_network).connect(container)
        except Exception:
            logger.debug(message, exc_info=True)


def get_managed_docker_restart_policies() -> Dict[str, Optional[str]]:
    client = get_docker_client()
    if client is None:
        return {}

    policies: Dict[str, Optional[str]] = {}
    container_names = ["ignite", DOCKER_RUNTIME_CONTAINER, *DOCKER_SUPPORT_CONTAINERS]
    for container_name in container_names:
        try:
            container = client.containers.get(container_name)
            policy = (((container.attrs or {}).get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name")
            policies[container_name] = policy or "no"
        except Exception:
            policies[container_name] = None
    return policies


def get_docker_restart_policy_name() -> Optional[str]:
    policies = get_managed_docker_restart_policies()
    if not policies:
        return None
    available = [policy for policy in policies.values() if policy is not None]
    if not available:
        return None
    if len(set(available)) == 1:
        return available[0]
    return "mismatch"


def reconcile_docker_restart_policy_from_settings() -> None:
    if not is_docker_managed_runtime():
        return

    desired_enabled = bool(settings.get("restart_on_boot"))
    desired_policy = "unless-stopped" if desired_enabled else "no"
    current_policy = get_docker_restart_policy_name()

    if current_policy == desired_policy:
        return

    try:
        apply_docker_restart_policy(desired_enabled)
        logger.info("Reconciled Docker restart policy to '%s' from saved Ignite settings.", desired_policy)
    except Exception as exc:
        logger.warning("Failed to reconcile Docker restart policy on startup: %s", exc)


def apply_docker_restart_policy(enabled: bool) -> None:
    client = get_docker_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Docker runtime control is not available.")

    policy_name = "unless-stopped" if enabled else "no"
    policy = {"Name": policy_name}

    container_names = ["ignite", DOCKER_RUNTIME_CONTAINER, *DOCKER_SUPPORT_CONTAINERS]
    errors = []
    for container_name in container_names:
        try:
            container = client.containers.get(container_name)
            container.update(restart_policy=policy)
        except Exception as exc:
            errors.append(f"{container_name}: {exc}")

    if errors:
        raise HTTPException(
            status_code=500,
            detail="Failed to update Docker restart policy: " + "; ".join(errors),
        )


def get_llama_swap_executable() -> str:
    """Resolve llama-swap to an executable path that also works from GUI-launched shells."""
    configured = os.environ.get("LLAMA_SWAP_BIN")
    candidates = [
        configured,
        shutil.which("llama-swap"),
        os.path.expanduser("~/.local/bin/llama-swap"),
        "/home/linuxbrew/.linuxbrew/bin/llama-swap",
        "/usr/local/bin/llama-swap",
        "/usr/bin/llama-swap",
    ]

    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    raise HTTPException(
        status_code=500,
        detail=(
            "Failed to find llama-swap executable. Set LLAMA_SWAP_BIN or install "
            "llama-swap somewhere in PATH."
        ),
    )


def get_llama_swap_base_url() -> str:
    """Resolve the base URL for talking to llama-swap."""
    configured = os.environ.get("LLAMA_SWAP_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    return f"http://127.0.0.1:{settings['llama_swap_port']}"


def get_llmfit_base_url() -> Optional[str]:
    configured = os.environ.get("LLMFIT_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    if IS_DOCKER:
        return "http://llmfit:8787"
    return None


def normalize_llama_swap_version(version: str) -> str:
    normalized = str(version or "").strip().lstrip("v")
    if not normalized:
        raise HTTPException(status_code=400, detail="llama-swap version is required.")
    if not re.fullmatch(r"\d+", normalized):
        raise HTTPException(status_code=400, detail="llama-swap version must be a numeric release, for example 214.")
    return normalized


def rebuild_runtime_container(llama_cpp_image: str, llama_swap_version: Optional[str] = None) -> Dict[str, Any]:
    image_ref = str(llama_cpp_image or "").strip()
    if not image_ref:
        raise HTTPException(status_code=400, detail="llama.cpp image is required.")
    swap_version = normalize_llama_swap_version(
        llama_swap_version if llama_swap_version is not None else settings.get("llama_swap_version", "211")
    )

    client = get_docker_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Docker runtime control is not available.")

    repo_root = get_repo_root()
    image_tag = "ignite-llama-runtime"

    try:
        build_stream = client.api.build(
            path=str(repo_root),
            dockerfile="docker/llama-runtime/Dockerfile",
            tag=image_tag,
            rm=True,
            pull=True,
            decode=True,
            buildargs={"LLAMA_CPP_IMAGE": image_ref, "LLAMA_SWAP_VERSION": swap_version},
        )
        build_errors: List[str] = []
        for chunk in build_stream:
            if "error" in chunk:
                build_errors.append(str(chunk.get("error") or "").strip())
        if build_errors:
            raise HTTPException(status_code=500, detail=f"Failed to build runtime image: {build_errors[-1]}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to build runtime image: {exc}")

    try:
        existing = client.containers.get(DOCKER_RUNTIME_CONTAINER)
    except Exception:
        existing = None

    if existing is None:
        raise HTTPException(status_code=503, detail="Runtime container was not found. Check the compose stack first.")

    attrs = existing.attrs
    network_names = list((attrs.get("NetworkSettings", {}) or {}).get("Networks", {}).keys())
    restart_policy = (attrs.get("HostConfig", {}) or {}).get("RestartPolicy") or {"Name": "no"}
    labels = dict((attrs.get("Config", {}) or {}).get("Labels") or {})
    environment: Dict[str, str] = {}
    for entry in (attrs.get("Config", {}) or {}).get("Env", []) or []:
        if "=" in entry:
            key, value = entry.split("=", 1)
            environment[key] = value

    volumes: Dict[str, Dict[str, str]] = {}
    for mount in attrs.get("Mounts", []) or []:
        mount_type = mount.get("Type")
        destination = mount.get("Destination")
        mode = mount.get("Mode") or "rw"
        if mount_type == "volume":
            volumes[mount.get("Name")] = {"bind": destination, "mode": mode}
        elif mount_type == "bind":
            volumes[mount.get("Source")] = {"bind": destination, "mode": mode}

    ports: Dict[str, Any] = {}
    port_bindings = (attrs.get("HostConfig", {}) or {}).get("PortBindings") or {}
    for container_port, bindings in port_bindings.items():
        if not bindings:
            continue
        binding = bindings[0]
        host_ip = binding.get("HostIp") or "0.0.0.0"
        host_port = int(binding.get("HostPort") or os.environ.get("LLAMA_SWAP_PORT", str(DOCKER_LLAMA_SWAP_PORT)))
        ports[container_port] = host_port if host_ip in {"0.0.0.0", ""} else (host_ip, host_port)

    command = (attrs.get("Config", {}) or {}).get("Cmd")
    entrypoint = (attrs.get("Config", {}) or {}).get("Entrypoint")
    working_dir = (attrs.get("Config", {}) or {}).get("WorkingDir") or None

    if not labels.get("com.docker.compose.project") or not labels.get("com.docker.compose.service"):
        try:
            ignite_container = client.containers.get("ignite")
            ignite_labels = dict((ignite_container.attrs.get("Config", {}) or {}).get("Labels") or {})
        except Exception:
            ignite_labels = {}

        image_id = ""
        try:
            image_id = client.images.get(image_tag).id
        except Exception:
            image_id = ""

        labels.update({
            "com.docker.compose.project": ignite_labels.get("com.docker.compose.project", "ignite"),
            "com.docker.compose.project.config_files": ignite_labels.get("com.docker.compose.project.config_files", str(get_repo_root() / "docker-compose.yml")),
            "com.docker.compose.project.working_dir": ignite_labels.get("com.docker.compose.project.working_dir", str(get_repo_root())),
            "com.docker.compose.version": ignite_labels.get("com.docker.compose.version", ""),
            "com.docker.compose.service": "llama-runtime",
            "com.docker.compose.container-number": "1",
            "com.docker.compose.oneoff": "False",
            "com.docker.compose.image": image_id,
        })
        labels = {key: value for key, value in labels.items() if value != ""}

    stop_and_remove_container(
        existing,
        stop_timeout=20,
        stop_message="Ignoring failure while stopping existing runtime container before recreate.",
        remove_error="Failed to remove existing runtime container",
    )

    gpu_environment, gpu_kwargs = get_docker_gpu_container_options(client)
    environment.update(gpu_environment)

    try:
        container = client.containers.run(
            image_tag,
            name=DOCKER_RUNTIME_CONTAINER,
            detach=True,
            ports=ports,
            volumes=volumes,
            environment=environment,
            labels=labels,
            restart_policy=restart_policy,
            network=(network_names[0] if network_names else None),
            command=command,
            entrypoint=entrypoint,
            working_dir=working_dir,
            **gpu_kwargs,
        )
        connect_extra_networks(
            client,
            container,
            network_names,
            "Ignoring failure while connecting runtime container to extra Docker network.",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start rebuilt runtime container: {exc}")

    return {
        "ok": True,
        "image": image_tag,
        "llama_cpp_image": image_ref,
        "llama_swap_version": swap_version,
        "container": DOCKER_RUNTIME_CONTAINER,
    }


def clear_update_caches() -> None:
    runtime_versions_cache.update({"checked_at": None, "result": None})
    updates_cache.update({"checked_at": None, "result": None})


def recreate_container_with_image(container_name: str, image: str) -> Dict[str, Any]:
    image_ref = str(image or "").strip()
    if not image_ref:
        raise HTTPException(status_code=400, detail="Image is required.")

    client = get_docker_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Docker runtime control is not available.")

    try:
        client.images.pull(image_ref)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to pull image {image_ref}: {exc}")

    try:
        existing = client.containers.get(container_name)
    except Exception:
        existing = None

    if existing is None:
        raise HTTPException(status_code=503, detail=f"Container '{container_name}' was not found.")

    attrs = existing.attrs
    config = (attrs.get("Config") or {})
    host_config = (attrs.get("HostConfig") or {})
    network_names = list(((attrs.get("NetworkSettings") or {}).get("Networks") or {}).keys())
    restart_policy = host_config.get("RestartPolicy") or {"Name": "no"}
    labels = dict(config.get("Labels") or {})
    command = config.get("Cmd")
    entrypoint = config.get("Entrypoint")
    working_dir = config.get("WorkingDir") or None
    environment: Dict[str, str] = {}

    for entry in config.get("Env") or []:
        if "=" in entry:
            key, value = entry.split("=", 1)
            environment[key] = value

    volumes: Dict[str, Dict[str, str]] = {}
    for mount in attrs.get("Mounts", []) or []:
        mount_type = mount.get("Type")
        destination = mount.get("Destination")
        mode = mount.get("Mode") or "rw"
        if mount_type == "volume":
            volumes[mount.get("Name")] = {"bind": destination, "mode": mode}
        elif mount_type == "bind":
            volumes[mount.get("Source")] = {"bind": destination, "mode": mode}

    ports: Dict[str, Any] = {}
    for container_port, bindings in (host_config.get("PortBindings") or {}).items():
        if not bindings:
            continue
        binding = bindings[0]
        host_ip = binding.get("HostIp") or "0.0.0.0"
        host_port = int(binding.get("HostPort") or 0)
        if host_port:
            ports[container_port] = host_port if host_ip in {"0.0.0.0", ""} else (host_ip, host_port)

    stop_and_remove_container(
        existing,
        stop_timeout=20,
        stop_message="Ignoring failure while stopping existing support container before recreate.",
        remove_error=f"Failed to remove existing container '{container_name}'",
    )

    try:
        container = client.containers.run(
            image_ref,
            name=container_name,
            detach=True,
            ports=ports or None,
            volumes=volumes or None,
            environment=environment or None,
            labels=labels or None,
            restart_policy=restart_policy,
            network=(network_names[0] if network_names else None),
            command=command,
            entrypoint=entrypoint,
            working_dir=working_dir,
        )
        connect_extra_networks(
            client,
            container,
            network_names,
            "Ignoring failure while connecting updated support container to extra Docker network.",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start updated container '{container_name}': {exc}")

    return {"ok": True, "container": container_name, "image": image_ref}


def run_update_action(action: str) -> Dict[str, Any]:
    normalized = str(action or "").strip().lower()
    if not is_docker_managed_runtime():
        raise HTTPException(status_code=400, detail="Update buttons are only available for Docker-managed Ignite.")

    started_at = datetime.now()
    if normalized == "runtime":
        image_ref = str(settings.get("llama_cpp_image") or parse_current_runtime_refs()["llama_cpp_image"]).strip()
        swap_version = normalize_llama_swap_version(settings.get("llama_swap_version", "211"))
        result = rebuild_runtime_container(image_ref, swap_version)
        clear_update_caches()
        versions = get_runtime_binary_versions(refresh=True)
        return {
            "ok": True,
            "action": normalized,
            "title": "Runtime updated",
            "message": f"Runtime rebuilt from {image_ref}.",
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now().isoformat(),
            "result": result,
            "versions": versions,
        }

    if normalized == "llama-swap":
        release = fetch_github_json("https://api.github.com/repos/mostlygeek/llama-swap/releases/latest")
        latest_tag = str((release or {}).get("tag_name") or "").strip()
        if not latest_tag:
            raise HTTPException(status_code=502, detail="Could not read latest llama-swap release from GitHub.")
        swap_version = normalize_llama_swap_version(latest_tag)
        image_ref = str(settings.get("llama_cpp_image") or parse_current_runtime_refs()["llama_cpp_image"]).strip()
        settings["llama_swap_version"] = swap_version
        save_settings(settings)
        result = rebuild_runtime_container(image_ref, swap_version)
        clear_update_caches()
        versions = get_runtime_binary_versions(refresh=True)
        return {
            "ok": True,
            "action": normalized,
            "title": "llama-swap updated",
            "message": f"llama-swap updated to v{swap_version} and runtime was rebuilt.",
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now().isoformat(),
            "result": result,
            "versions": versions,
        }

    if normalized == "speech":
        accel = str(settings.get("speaches_accel") or os.environ.get("SPEACHES_ACCEL") or "cpu").strip().lower()
        if accel not in {"cpu", "cuda"}:
            accel = "cpu"
        result = speech_service.recreate_container(accel)
        clear_update_caches()
        return {
            "ok": True,
            "action": normalized,
            "title": "Speech updated",
            "message": f"Speaches refreshed with the latest {accel} image.",
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now().isoformat(),
            "result": result,
        }

    if normalized == "llmfit":
        refs = parse_current_runtime_refs()
        result = recreate_container_with_image(DOCKER_LLMFIT_CONTAINER, refs["llmfit_image"])
        clear_update_caches()
        return {
            "ok": True,
            "action": normalized,
            "title": "llmfit updated",
            "message": f"llmfit refreshed from {refs['llmfit_image']}.",
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now().isoformat(),
            "result": result,
        }

    if normalized == "ignite":
        raise HTTPException(
            status_code=501,
            detail=(
                "Ignite app self-update needs a host checkout action. Runtime, speech, and llmfit can be updated "
                "from the UI now; app self-update will be added separately so it can safely run git pull on the host."
            ),
        )

    raise HTTPException(status_code=404, detail=f"Unknown update action: {action}")


def load_settings() -> Dict[str, Any]:
    """Load settings from settings.json, falling back to defaults if missing."""
    settings = dict(DEFAULT_SETTINGS)
    settings_path = SETTINGS_FILE
    if not settings_path.exists() and IS_DOCKER and LEGACY_SETTINGS_FILE.exists():
        settings_path = LEGACY_SETTINGS_FILE

    if settings_path.exists():
        try:
            with open(settings_path, "r") as f:
                saved = json.load(f)
            settings.update(saved)
        except Exception as e:
            logger.warning(f"Failed to load settings.json, using defaults: {e}")
    return settings


def save_settings(new_settings: Dict[str, Any]) -> None:
    """Save settings to settings.json."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(new_settings, f, indent=2)
        f.write("\n")


settings = load_settings()

logger.info(f"LLAMA_SWAP_CONFIG: {settings['llama_swap_config']}")
logger.info(f"GGUF_DIRECTORY: {settings['gguf_directory']}")

app = FastAPI(title="LLM Control Panel", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve built frontend files when available (single-process runtime mode).
if (FRONTEND_DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST_DIR / "assets"), name="assets")


@app.on_event("startup")
def reconcile_runtime_settings_on_startup():
    reconcile_docker_restart_policy_from_settings()


docker_gpu_preflight_cache: Dict[str, Any] = {"checked_at": None, "result": None}
runtime_versions_cache: Dict[str, Any] = {"checked_at": None, "result": None}
updates_cache: Dict[str, Any] = {"checked_at": None, "result": None}
download_manager = ModelDownloadManager(lambda: settings["gguf_directory"], logger)
log_service = LogService(
    LLAMA_SWAP_LOG_FILE,
    get_base_url=get_llama_swap_base_url,
    is_docker_mode=is_docker_managed_runtime,
    get_docker_client=get_docker_client,
    get_container_map=get_docker_log_container_map,
    logger=logger,
)
model_file_service = ModelFileService(lambda: settings["gguf_directory"], logger)


def run_command(cmd: List[str], timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Run a shell command and return the result"""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail=f"Command timed out: {' '.join(cmd)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Command failed: {str(e)}")


@lru_cache(maxsize=1)
def get_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read_text_if_exists(path: Path) -> str:
    try:
        return path.read_text()
    except Exception:
        return ""


def parse_current_runtime_refs() -> Dict[str, Any]:
    env_ignite_version = os.environ.get("IGNITE_APP_VERSION", "").strip()
    env_llama_cpp_image = os.environ.get("LLAMA_CPP_IMAGE_REF", "").strip()
    env_llmfit_image = os.environ.get("LLMFIT_IMAGE_REF", "").strip()
    configured_llama_cpp_image = str(settings.get("llama_cpp_image") or "").strip()

    repo_root = get_repo_root()
    runtime_dockerfile = read_text_if_exists(repo_root / "docker" / "llama-runtime" / "Dockerfile")
    compose_yaml = read_text_if_exists(repo_root / "docker-compose.yml")
    frontend_package = read_text_if_exists(repo_root / "frontend" / "package.json")

    llama_cpp_image = None
    llmfit_image = None
    ignite_version = None

    image_match = re.search(r"ARG\s+LLAMA_CPP_IMAGE=(.+)", runtime_dockerfile)
    if image_match:
        llama_cpp_image = image_match.group(1).strip()

    llmfit_match = re.search(r"image:\s*(ghcr\.io/alexsjones/llmfit:[^\s]+)", compose_yaml)
    if llmfit_match:
        llmfit_image = llmfit_match.group(1).strip()

    try:
        package_data = json.loads(frontend_package) if frontend_package else {}
        ignite_version = package_data.get("version")
    except Exception:
        ignite_version = None

    return {
        "ignite_version": env_ignite_version or ignite_version or "unknown",
        "llama_cpp_image": configured_llama_cpp_image or env_llama_cpp_image or llama_cpp_image or "spadav/llama-cpp-server:latest",
        "llmfit_image": env_llmfit_image or llmfit_image or "ghcr.io/alexsjones/llmfit:latest",
    }


def get_runtime_binary_versions(refresh: bool = False) -> Dict[str, Any]:
    checked_at = runtime_versions_cache.get("checked_at")
    cached_result = runtime_versions_cache.get("result")
    if (
        not refresh
        and isinstance(checked_at, datetime)
        and isinstance(cached_result, dict)
    ):
        cache_age = datetime.now() - checked_at
        probe_state = str(cached_result.get("probe_state") or "unknown")
        max_age = timedelta(minutes=5) if probe_state == "ok" else timedelta(seconds=30)
        if cache_age < max_age:
            return cached_result

    result = {
        "llama_swap_version": "unknown",
        "llama_swap_build": "",
        "llama_swap_commit": "",
        "llama_cpp_version": "unknown",
        "llama_cpp_build": "",
        "llama_cpp_commit": "",
        "probe_state": "unknown",
        "probe_message": "",
    }

    client = get_docker_client()
    if client is None:
        result.update(
            {
                "probe_state": "docker_unavailable",
                "probe_message": "Ignite cannot reach Docker, so runtime versions could not be checked.",
            }
        )
        runtime_versions_cache.update({"checked_at": datetime.now(), "result": result})
        return result

    try:
        container = client.containers.get(DOCKER_RUNTIME_CONTAINER)
        container.reload()
        container_status = str(getattr(container, "status", "") or "").lower()
        if container_status != "running":
            result.update(
                {
                    "probe_state": "runtime_offline",
                    "probe_message": "The runtime container is not running, so current llama-swap and llama.cpp versions are unavailable.",
                }
            )
            runtime_versions_cache.update({"checked_at": datetime.now(), "result": result})
            return result

        swap_exec_result = container.exec_run(
            ["/bin/bash", "-lc", "llama-swap --version || /usr/local/bin/llama-swap --version || llama-swap -v"],
            stdout=True,
            stderr=True,
        )
        swap_output = ""
        if getattr(swap_exec_result, "output", None):
            swap_output = swap_exec_result.output.decode("utf-8", errors="replace")

        swap_match = re.search(r"version:\s*(\d+)\s*\(([^)]+)\)", swap_output)
        if swap_match:
            build = swap_match.group(1).strip()
            commit = swap_match.group(2).strip()
            result.update(
                {
                    "llama_swap_version": f"v{build}",
                    "llama_swap_build": build,
                    "llama_swap_commit": commit,
                }
            )

        exec_result = container.exec_run(
            ["/bin/bash", "-lc", "/app/llama-server --version || llama-server --version"],
            stdout=True,
            stderr=True,
        )
        version_output = ""
        if getattr(exec_result, "output", None):
            version_output = exec_result.output.decode("utf-8", errors="replace")

        match = re.search(r"version:\s*(\d+)\s*\(([^)]+)\)", version_output)
        if match:
            build = match.group(1).strip()
            commit = match.group(2).strip()
            result.update(
                {
                    "llama_cpp_version": f"{build} ({commit})",
                    "llama_cpp_build": build,
                    "llama_cpp_commit": commit,
                }
            )
        if result["llama_swap_version"] != "unknown" or result["llama_cpp_version"] != "unknown":
            result.update({"probe_state": "ok", "probe_message": ""})
        else:
            result.update(
                {
                    "probe_state": "probe_failed",
                    "probe_message": "Ignite reached the runtime container, but could not read version information from it.",
                }
            )
    except Exception as exc:
        logger.warning("Failed to detect runtime llama.cpp version: %s", exc)
        result.update(
            {
                "probe_state": "probe_failed",
                "probe_message": "Ignite could not read version information from the runtime container.",
            }
        )

    runtime_versions_cache.update({"checked_at": datetime.now(), "result": result})
    return result


def fetch_github_json(url: str) -> Optional[Dict[str, Any]]:
    try:
        response = requests.get(
            url,
            timeout=10,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "ignite-update-check",
            },
        )
        response.raise_for_status()
        return response.json()
    except Exception:
        return None


def compare_numeric_versions(current: str, latest_tag: str) -> str:
    current_num = re.sub(r"^[^\d]*", "", str(current or ""))
    latest_num = re.sub(r"^[^\d]*", "", str(latest_tag or ""))
    if not current_num or not latest_num:
        return "unknown"
    try:
        current_val = int(current_num)
        latest_val = int(latest_num)
        if current_val == latest_val:
            return "up_to_date"
        if current_val < latest_val:
            return "update_available"
        return "ahead_or_custom"
    except Exception:
        return "unknown"


def get_updates_payload(refresh: bool = False) -> Dict[str, Any]:
    checked_at = updates_cache.get("checked_at")
    if (
        not refresh
        and isinstance(checked_at, datetime)
        and datetime.now() - checked_at < timedelta(minutes=15)
        and isinstance(updates_cache.get("result"), dict)
    ):
        return updates_cache["result"]

    refs = parse_current_runtime_refs()
    runtime_versions = get_runtime_binary_versions(refresh=refresh)
    llama_swap_release = fetch_github_json("https://api.github.com/repos/mostlygeek/llama-swap/releases/latest")
    llama_cpp_repo = fetch_github_json("https://api.github.com/repos/ggml-org/llama.cpp")
    llama_cpp_latest_commit = fetch_github_json("https://api.github.com/repos/ggml-org/llama.cpp/commits/master")
    llmfit_repo = fetch_github_json("https://api.github.com/repos/alexsjones/llmfit")

    latest_llama_cpp_sha = str((llama_cpp_latest_commit or {}).get("sha") or "").strip()
    current_llama_cpp_commit = runtime_versions.get("llama_cpp_commit", "")
    runtime_probe_state = str(runtime_versions.get("probe_state") or "unknown")
    runtime_probe_message = str(runtime_versions.get("probe_message") or "").strip()
    if current_llama_cpp_commit and latest_llama_cpp_sha:
        llama_cpp_status = "up_to_date" if latest_llama_cpp_sha.startswith(current_llama_cpp_commit) else "upstream_ahead"
        latest_llama_cpp_label = f"master ({latest_llama_cpp_sha[:9]})"
    else:
        llama_cpp_status = runtime_probe_state if runtime_probe_state != "ok" else "unknown"
        latest_llama_cpp_label = (llama_cpp_repo or {}).get("pushed_at")

    llama_swap_status = compare_numeric_versions(runtime_versions["llama_swap_build"], llama_swap_release.get("tag_name", "")) if llama_swap_release else "unknown"
    if runtime_versions["llama_swap_version"] == "unknown" and runtime_probe_state != "ok":
        llama_swap_status = runtime_probe_state

    updates_notice = None
    if runtime_probe_state in {"runtime_offline", "docker_unavailable", "probe_failed"}:
        updates_notice = {
            "state": runtime_probe_state,
            "message": runtime_probe_message or "Ignite could not read current runtime versions.",
        }

    components = [
        {
            "id": "ignite",
            "name": "Ignite",
            "current": refs["ignite_version"],
            "latest": None,
            "status": "local_app",
            "summary": "Ignite is your app layer. Update it by pulling the repo and rebuilding the stack.",
            "update_action": "ignite",
            "update_available_in_ui": False,
            "update_disabled_reason": "App self-update needs a host checkout action and is not automated yet.",
            "changelog_url": "https://github.com/Spadav/Ignite/commits/main",
            "release_url": "https://github.com/Spadav/Ignite",
            "update_path_label": "Refresh Installed Runtime",
            "update_script": "./scripts/update.sh",
            "version_upgrade_label": "",
            "manual_update": [
                "git pull --ff-only",
                "docker compose build --pull ignite llama-runtime",
                "docker compose pull llmfit",
                "docker compose up -d",
            ],
        },
        {
            "id": "llama-swap",
            "name": "llama-swap",
            "current": runtime_versions["llama_swap_version"] if runtime_versions["llama_swap_version"] != "unknown" else ("Runtime offline" if runtime_probe_state == "runtime_offline" else "Unavailable"),
            "latest": llama_swap_release.get("tag_name") if llama_swap_release else None,
            "status": llama_swap_status,
            "summary": "Pinned release inside the runtime image. This can be compared directly to the latest upstream release.",
            "update_action": "llama-swap",
            "update_available_in_ui": True,
            "changelog_url": (llama_swap_release or {}).get("html_url") or "https://github.com/mostlygeek/llama-swap/releases",
            "release_url": "https://github.com/mostlygeek/llama-swap/releases",
            "update_path_label": "Refresh Installed Runtime",
            "update_script": "./scripts/update.sh",
            "version_upgrade_label": "Upgrade To New Version",
            "manual_update": [
                "Edit docker/llama-runtime/Dockerfile",
                "Bump LLAMA_SWAP_VERSION",
                "docker compose build --pull llama-runtime ignite",
                "docker compose up -d",
            ],
        },
        {
            "id": "llama.cpp",
            "name": "llama.cpp",
            "current": runtime_versions["llama_cpp_version"] if runtime_versions["llama_cpp_version"] != "unknown" else ("Runtime offline" if runtime_probe_state == "runtime_offline" else "Unavailable"),
            "latest": latest_llama_cpp_label,
            "status": llama_cpp_status,
            "summary": "Reported directly by the running runtime container. `./scripts/update.sh` refreshes the published runtime image. Upstream master may still move ahead between image publishes.",
            "update_action": "runtime",
            "update_available_in_ui": True,
            "changelog_url": "https://github.com/ggml-org/llama.cpp/commits/master",
            "release_url": "https://github.com/ggml-org/llama.cpp",
            "update_path_label": "Refresh Runtime Image",
            "update_script": "./scripts/update.sh",
            "version_upgrade_label": "",
            "manual_update": [
                "docker compose build --pull llama-runtime ignite",
                "docker compose up -d",
            ],
        },
        {
            "id": "speaches",
            "name": "Speaches",
            "current": f"ghcr.io/speaches-ai/speaches:latest-{str(settings.get('speaches_accel') or 'cpu').strip().lower()}",
            "latest": None,
            "status": "floating_image",
            "summary": "Speech service for STT/TTS. This uses the selected CPU/CUDA floating image and updates when pulled again.",
            "update_action": "speech",
            "update_available_in_ui": True,
            "changelog_url": "https://github.com/speaches-ai/speaches/commits/master",
            "release_url": "https://github.com/speaches-ai/speaches",
            "update_path_label": "Refresh Speech Image",
            "update_script": "./scripts/update.sh",
            "version_upgrade_label": "",
            "manual_update": [
                "docker compose pull speaches",
                "docker compose up -d speaches",
            ],
        },
        {
            "id": "llmfit",
            "name": "llmfit",
            "current": refs["llmfit_image"],
            "latest": (llmfit_repo or {}).get("pushed_at"),
            "status": "floating_image",
            "summary": "This uses the floating `latest` image tag. Pull again to refresh to the newest published image.",
            "update_action": "llmfit",
            "update_available_in_ui": True,
            "changelog_url": "https://github.com/alexsjones/llmfit/commits/main",
            "release_url": "https://github.com/alexsjones/llmfit",
            "update_path_label": "Refresh Runtime Image",
            "update_script": "./scripts/update.sh",
            "version_upgrade_label": "",
            "manual_update": [
                "docker compose pull llmfit",
                "docker compose up -d llmfit",
            ],
        },
    ]

    payload = {
        "checked_at": datetime.now().isoformat(),
        "components": components,
        "runtime_notice": updates_notice,
    }
    updates_cache.update({"checked_at": datetime.now(), "result": payload})
    return payload


def get_gpu_stats() -> Dict[str, Any]:
    """Get NVIDIA GPU statistics using nvidia-smi."""
    empty = {
        "memory_used_gb": 0,
        "memory_total_gb": 0,
        "temperature_c": 0,
        "available": False,
        "gpus": [],
        "count": 0,
    }

    try:
        result = run_command(
            [
                "nvidia-smi",
                "--query-gpu=index,uuid,name,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ]
        )
        if result.returncode != 0:
            return empty

        gpus = []
        for line in (result.stdout or "").splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 6:
                continue

            try:
                gpus.append(
                    {
                        "index": int(parts[0]),
                        "uuid": parts[1],
                        "name": parts[2],
                        "memory_used_gb": round(int(parts[3]) / 1024, 1),
                        "memory_total_gb": round(int(parts[4]) / 1024, 1),
                        "temperature_c": int(parts[5]),
                    }
                )
            except Exception:
                continue

        if not gpus:
            return empty

        primary = gpus[0]
        return {
            "memory_used_gb": sum(gpu["memory_used_gb"] for gpu in gpus),
            "memory_total_gb": sum(gpu["memory_total_gb"] for gpu in gpus),
            "temperature_c": primary["temperature_c"],
            "available": True,
            "gpus": gpus,
            "count": len(gpus),
            "primary_name": primary["name"],
        }
    except Exception:
        return empty


def get_docker_gpu_preflight() -> Dict[str, Any]:
    """Report whether Docker can expose an NVIDIA GPU to runtime containers."""
    checked_at = docker_gpu_preflight_cache.get("checked_at")
    if isinstance(checked_at, datetime) and datetime.now() - checked_at < timedelta(seconds=60):
        cached = docker_gpu_preflight_cache.get("result")
        if isinstance(cached, dict):
            return cached

    if IS_DOCKER:
        preflight = {
            "docker_installed": False,
            "host_nvidia_smi": False,
            "gpu_ready": False,
            "state": "containerized",
            "message": "Docker GPU preflight is only available from the host-side Ignite process.",
            "details": [
                "This Ignite instance is running inside Docker.",
                "Use `docker run --rm --gpus all ... nvidia-smi -L` on the host to verify GPU passthrough.",
            ],
        }
        docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
        return preflight

    docker_bin = shutil.which("docker")
    nvidia_smi_bin = shutil.which("nvidia-smi")
    preflight = {
        "docker_installed": bool(docker_bin),
        "host_nvidia_smi": bool(nvidia_smi_bin),
        "gpu_ready": False,
        "state": "unknown",
        "message": "",
        "details": [],
    }

    if not docker_bin:
        preflight["state"] = "docker_missing"
        preflight["message"] = "Docker is not installed or not in PATH."
        docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
        return preflight

    if not nvidia_smi_bin:
        preflight["state"] = "host_gpu_missing"
        preflight["message"] = "NVIDIA GPU tools are not available on the host."
        preflight["details"] = [
            "Install NVIDIA drivers and confirm `nvidia-smi` works on the host."
        ]
        docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
        return preflight

    try:
        docker_info = run_command(
            ["docker", "info", "--format", "{{json .Runtimes}} {{json .CDISpecDirs}}"],
            timeout=10.0,
        )
        info_text = (docker_info.stdout or "").strip()
    except Exception as e:
        preflight["state"] = "docker_unreachable"
        preflight["message"] = "Docker is installed but not reachable from Ignite."
        preflight["details"] = [str(e)]
        docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
        return preflight

    runtimes_text = info_text.lower()
    has_nvidia_runtime = '"nvidia"' in runtimes_text
    has_cdi_dirs = "/etc/cdi" in info_text or "/var/run/cdi" in info_text
    has_nvidia_ctk = bool(shutil.which("nvidia-ctk"))

    if has_nvidia_runtime:
        test_command = [
            "docker",
            "run",
            "--rm",
            "--runtime=nvidia",
            "-e",
            "NVIDIA_VISIBLE_DEVICES=all",
            "-e",
            "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
            "--entrypoint",
            "sh",
            "spadav/llama-cpp-server:latest",
            "-lc",
            "nvidia-smi -L",
        ]
        preferred_mode = "nvidia-runtime"
    else:
        test_command = [
            "docker",
            "run",
            "--rm",
            "--gpus",
            "all",
            "--entrypoint",
            "sh",
            "spadav/llama-cpp-server:latest",
            "-lc",
            "nvidia-smi -L",
        ]
        preferred_mode = "cdi"

    try:
        test = run_command(
            test_command,
            timeout=20.0,
        )
        if test.returncode == 0 and "GPU " in (test.stdout or ""):
            preflight["gpu_ready"] = True
            preflight["state"] = "ready"
            preflight["message"] = "Docker GPU runtime is ready."
            preflight["preferred_mode"] = preferred_mode
            docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
            return preflight

        failure_text = "\n".join(filter(None, [(test.stdout or "").strip(), (test.stderr or "").strip()]))
    except Exception as e:
        failure_text = str(e)

    preflight["state"] = "docker_gpu_not_ready"
    preflight["message"] = "Docker is installed, but GPU passthrough is not configured."
    preflight["details"] = [
        f"Host `nvidia-smi` works, but Docker GPU startup failed in {preferred_mode} mode.",
        f"NVIDIA Container Toolkit installed: {'yes' if has_nvidia_ctk else 'no'}",
        f"Docker NVIDIA runtime registered: {'yes' if has_nvidia_runtime else 'no'}",
        f"Docker CDI directories visible: {'yes' if has_cdi_dirs else 'no'}",
    ]
    if failure_text:
        preflight["details"].append(f"Docker error: {failure_text}")
    preflight["details"].append(
        "Install and configure NVIDIA Container Toolkit on the host, then verify `docker run --gpus all ... nvidia-smi -L`."
    )
    docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
    return preflight


def get_docker_gpu_container_options(client, visible_devices: str = "all") -> tuple[Dict[str, str], Dict[str, Any]]:
    environment = {
        "NVIDIA_VISIBLE_DEVICES": str(visible_devices or "all"),
        "NVIDIA_DRIVER_CAPABILITIES": "compute,utility",
    }
    try:
        runtimes = (client.info() or {}).get("Runtimes") or {}
    except Exception:
        runtimes = {}

    if "nvidia" in runtimes:
        return environment, {"runtime": "nvidia"}

    return environment, {
        "device_requests": [docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])]
    }


speech_service = SpeechService(
    is_docker=IS_DOCKER,
    docker_port=DOCKER_SPEACHES_PORT,
    container_name=DOCKER_SPEACHES_CONTAINER,
    cache_container_dir=SPEACHES_CACHE_CONTAINER_DIR,
    alias_container_file=SPEACHES_ALIAS_CONTAINER_FILE,
    get_settings=lambda: settings,
    get_docker_client=get_docker_client,
    is_docker_mode=is_docker_managed_runtime,
    stop_and_remove_container=stop_and_remove_container,
    connect_extra_networks=connect_extra_networks,
    get_gpu_container_options=get_docker_gpu_container_options,
    logger=logger,
)


def is_llama_swap_running() -> bool:
    """Check if llama-swap is running via a lightweight endpoint."""
    base_url = get_llama_swap_base_url()
    try:
        logger.info("Checking if llama-swap is running...")
        # /v1/models avoids triggering expensive model health workflows that / may invoke.
        response = requests.get(f"{base_url}/v1/models", timeout=2)
        logger.info(f"llama-swap responded with status {response.status_code}")
        return response.status_code == 200
    except requests.ConnectionError:
        logger.info(f"llama-swap not responding at {base_url}")
        return False
    except Exception as e:
        logger.error(f"Error checking llama-swap status: {e}")
        return False


def get_llama_swap_pid() -> Optional[int]:
    """Get the PID of the running llama-swap process"""
    if IS_DOCKER or os.environ.get("LLAMA_SWAP_URL"):
        return None
    try:
        llama_swap_bin = get_llama_swap_executable()
        result = run_command(["pgrep", "-f", llama_swap_bin])
        if result.returncode == 0:
            pid = int(result.stdout.strip().split()[0])
            logger.info(f"Found llama-swap PID: {pid}")
            return pid
        return None
    except Exception:
        return None


def infer_request_mode(*values: Optional[str]) -> str:
    completion_tokens = [
        "starcoder",
        "codegemma",
        "deepseek-coder",
        "coder",
        "completion",
        "code",
        "fim",
    ]
    chat_tokens = [
        "instruct",
        "chat",
        "assistant",
        "qwen",
        "llama",
        "mistral",
        "gemma",
        "--jinja",
        "chat-template",
    ]

    normalized = " ".join(str(value or "").lower() for value in values if value)
    if any(token in normalized for token in chat_tokens):
        return "chat"
    if any(token in normalized for token in completion_tokens):
        return "completion"
    return "chat"


def start_llama_swap() -> Dict[str, Any]:
    """Start llama-swap service locally or validate the Docker-managed runtime."""
    try:
        if is_llama_swap_running():
            return {"running": True, "pid": get_llama_swap_pid()}

        if IS_DOCKER or os.environ.get("LLAMA_SWAP_URL"):
            client = get_docker_client()
            if client is None:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Docker runtime control is unavailable. Mount /var/run/docker.sock into the Ignite "
                        "container to allow start/stop actions."
                    ),
                )

            started = []
            runtime_found = False
            for container_name in [*DOCKER_SUPPORT_CONTAINERS, DOCKER_RUNTIME_CONTAINER]:
                try:
                    container = client.containers.get(container_name)
                    if container_name == DOCKER_RUNTIME_CONTAINER:
                        runtime_found = True
                    if container.status != "running":
                        container.start()
                        started.append(container_name)
                except docker.errors.NotFound:
                    continue

            if not runtime_found:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Docker runtime container '{DOCKER_RUNTIME_CONTAINER}' was not found. "
                        "Check the compose stack before using runtime controls."
                    ),
                )

            return {
                "running": is_llama_swap_running(),
                "pid": None,
                "message": "Docker runtime start requested",
                "containers_started": started,
            }

        swap_dir = os.path.expanduser(settings["llama_swap_dir"])
        swap_config = os.path.expanduser(settings["llama_swap_config"])
        swap_port = settings["llama_swap_port"]
        llama_swap_bin = get_llama_swap_executable()
        log_handle = open(LLAMA_SWAP_LOG_FILE, "a")
        process = subprocess.Popen(
            [
                llama_swap_bin,
                "--config", swap_config,
                "--listen", f"0.0.0.0:{swap_port}",
            ],
            cwd=swap_dir,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        Path(LLAMA_SWAP_PROCESS_FILE).write_text(f"{process.pid}\n")

        return {"running": True, "pid": process.pid, "message": "llama-swap started"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start llama-swap: {str(e)}")


def stop_llama_swap() -> Dict[str, Any]:
    """Stop llama-swap and child processes in local mode."""
    try:
        if IS_DOCKER or os.environ.get("LLAMA_SWAP_URL"):
            client = get_docker_client()
            if client is None:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Docker runtime control is unavailable. Mount /var/run/docker.sock into the Ignite "
                        "container to allow start/stop actions."
                    ),
                )
            try:
                container = client.containers.get(DOCKER_RUNTIME_CONTAINER)
                if container.status == "running":
                    container.stop(timeout=20)
                return {"stopped": True, "message": "Docker runtime stopped"}
            except docker.errors.NotFound:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Docker runtime container '{DOCKER_RUNTIME_CONTAINER}' was not found. "
                        "Check the compose stack before using runtime controls."
                    ),
                )

        llama_swap_bin = get_llama_swap_executable()
        # Kill llama-server first, then llama-swap
        for pattern in ["llama-server", llama_swap_bin]:
            subprocess.run(["pkill", "-f", pattern], capture_output=True)

        import time
        time.sleep(1)

        # Force kill any survivors
        for pattern in ["llama-server", llama_swap_bin]:
            subprocess.run(["pkill", "-9", "-f", pattern], capture_output=True)

        # Close the terminal window by killing the bash shell that has our command
        swap_dir = os.path.expanduser(settings["llama_swap_dir"])
        subprocess.run(
            ["pkill", "-f", f"cd {swap_dir} && {llama_swap_bin}"],
            capture_output=True
        )

        if os.path.exists(LLAMA_SWAP_PROCESS_FILE):
            os.remove(LLAMA_SWAP_PROCESS_FILE)
        return {"stopped": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop llama-swap: {str(e)}")


def get_llama_swap_model_status() -> List[Dict[str, Any]]:
    """Read current model states from llama-swap's SSE event stream."""
    base_url = get_llama_swap_base_url()
    data_lines: List[str] = []

    try:
        with requests.get(f"{base_url}/api/events", stream=True, timeout=(1.0, 1.5)) as response:
            if response.status_code != 200:
                return []

            for raw_line in response.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line.strip()
                if not line:
                    if data_lines:
                        payload_text = "\n".join(data_lines)
                        try:
                            envelope = json.loads(payload_text)
                            payload_type = envelope.get("type") if isinstance(envelope, dict) else None
                            payload = envelope.get("data") if isinstance(envelope, dict) else None
                            if payload_type == "modelStatus" and isinstance(payload, str):
                                payload = json.loads(payload)
                            if payload_type == "modelStatus" and isinstance(payload, list):
                                normalized = []
                                for item in payload:
                                    if not isinstance(item, dict):
                                        continue
                                    normalized.append(
                                        {
                                            "id": str(item.get("id") or item.get("model") or ""),
                                            "name": str(item.get("name") or item.get("id") or item.get("model") or ""),
                                            "state": str(item.get("state") or "unknown"),
                                            "aliases": item.get("aliases") or [],
                                            "unlisted": bool(item.get("unlisted", False)),
                                            "peer_id": item.get("peerID"),
                                        }
                                    )
                                return normalized
                        except Exception:
                            return []

                    data_lines = []
                    continue

                if line.startswith("data:"):
                    data_lines.append(line.split(":", 1)[1].strip())
                    continue

        return []
    except Exception:
        return []


def get_llama_swap_runtime_overview() -> Dict[str, Any]:
    """Read current runtime model state, metrics, and inflight count from llama-swap's SSE event stream."""
    base_url = get_llama_swap_base_url()
    data_lines: List[str] = []
    models: List[Dict[str, Any]] = []
    metrics: List[Dict[str, Any]] = []
    inflight_total = 0

    def normalize_metric_item(item: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(item)
        tokens = item.get("tokens")
        if isinstance(tokens, dict):
            # Preserve the raw nested metrics from newer llama-swap while
            # restoring the flat fields the current frontend expects.
            normalized["cache_tokens"] = tokens.get("cache_tokens", normalized.get("cache_tokens", -1))
            normalized["input_tokens"] = tokens.get("input_tokens", normalized.get("input_tokens", 0))
            normalized["output_tokens"] = tokens.get("output_tokens", normalized.get("output_tokens", 0))
            normalized["prompt_per_second"] = tokens.get("prompt_per_second", normalized.get("prompt_per_second", 0))
            normalized["tokens_per_second"] = tokens.get("tokens_per_second", normalized.get("tokens_per_second", 0))
        return normalized

    try:
        with requests.get(f"{base_url}/api/events", stream=True, timeout=(1.0, 2.0)) as response:
            if response.status_code != 200:
                return {"models": models, "metrics": metrics, "inflight_total": inflight_total}

            for raw_line in response.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line.strip()
                if not line:
                    if data_lines:
                        payload_text = "\n".join(data_lines)
                        try:
                            envelope = json.loads(payload_text)
                            payload_type = envelope.get("type") if isinstance(envelope, dict) else None
                            payload = envelope.get("data") if isinstance(envelope, dict) else None
                            if isinstance(payload, str):
                                payload = json.loads(payload)

                            if payload_type == "modelStatus" and isinstance(payload, list):
                                normalized = []
                                for item in payload:
                                    if not isinstance(item, dict):
                                        continue
                                    normalized.append(
                                        {
                                            "id": str(item.get("id") or item.get("model") or ""),
                                            "name": str(item.get("name") or item.get("id") or item.get("model") or ""),
                                            "state": str(item.get("state") or "unknown"),
                                            "aliases": item.get("aliases") or [],
                                            "unlisted": bool(item.get("unlisted", False)),
                                            "peer_id": item.get("peerID"),
                                        }
                                    )
                                models = normalized
                            elif payload_type == "metrics" and isinstance(payload, list):
                                metrics = [normalize_metric_item(item) for item in payload if isinstance(item, dict)]
                            elif payload_type == "inflight" and isinstance(payload, dict):
                                inflight_total = int(payload.get("total") or 0)
                        except Exception:
                            logger.debug("Ignoring malformed llama-swap runtime event payload.", exc_info=True)

                    data_lines = []
                    if models and metrics:
                        break
                    continue

                if line.startswith("data:"):
                    data_lines.append(line.split(":", 1)[1].strip())
                    continue

        return {"models": models, "metrics": metrics, "inflight_total": inflight_total}
    except Exception:
        return {"models": models, "metrics": metrics, "inflight_total": inflight_total}


def get_llama_swap_capture(capture_id: int) -> Any:
    base_url = get_llama_swap_base_url()
    try:
        response = requests.get(f"{base_url}/api/captures/{capture_id}", timeout=15)
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="Capture not found")
        if not response.ok:
            raise HTTPException(status_code=response.status_code, detail=f"Failed to fetch capture: {response.text[:300]}")
        return response.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch capture: {exc}")


def request_llama_swap_model_load(model_id: str) -> Dict[str, Any]:
    if not model_id:
        raise HTTPException(status_code=400, detail="Model ID is required")

    base_url = get_llama_swap_base_url()
    try:
        response = requests.get(f"{base_url}/upstream/{quote(model_id)}/", timeout=60)
        if not response.ok:
            raise HTTPException(status_code=response.status_code, detail=f"Failed to load model: {response.text[:300]}")
        return {"ok": True, "model_id": model_id, "action": "load"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {exc}")


def request_llama_swap_model_unload(model_id: str) -> Dict[str, Any]:
    if not model_id:
        raise HTTPException(status_code=400, detail="Model ID is required")

    base_url = get_llama_swap_base_url()
    try:
        response = requests.post(f"{base_url}/api/models/unload/{quote(model_id)}", timeout=15)
        if not response.ok:
            raise HTTPException(status_code=response.status_code, detail=f"Failed to unload model: {response.text[:300]}")
        return {"ok": True, "model_id": model_id, "action": "unload"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to unload model: {exc}")


def request_llama_swap_unload_all() -> Dict[str, Any]:
    base_url = get_llama_swap_base_url()
    try:
        response = requests.post(f"{base_url}/api/models/unload", timeout=15)
        if not response.ok:
            raise HTTPException(status_code=response.status_code, detail=f"Failed to unload all models: {response.text[:300]}")
        return {"ok": True, "action": "unload_all"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to unload all models: {exc}")


def get_config() -> Dict[str, Any]:
    """Get llama-swap configuration"""
    config_path = os.path.expanduser(settings["llama_swap_config"])
    logger.info(f"Loading config from: {config_path}")
    config_file = Path(config_path)
    
    if not config_file.exists():
        logger.warning(f"Config file not found: {config_file}")
        raise HTTPException(status_code=404, detail=f"Config file not found: {config_file}")
    
    try:
        with open(config_file, "r") as f:
            config = yaml.safe_load(f) or {}
        logger.info(f"Config loaded successfully: {list(config.keys())}")
        return config
    except Exception as e:
        logger.error(f"Error loading config: {e}")
        raise HTTPException(status_code=500, detail=f"Error loading config: {str(e)}")


def save_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Save llama-swap configuration"""
    config_file = Path(os.path.expanduser(settings["llama_swap_config"]))
    config_file.parent.mkdir(parents=True, exist_ok=True)
    
    with open(config_file, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    
    return {"saved": True}


def get_config_raw() -> str:
    """Get raw llama-swap configuration text."""
    config_file = Path(os.path.expanduser(settings["llama_swap_config"]))

    if not config_file.exists():
        raise HTTPException(status_code=404, detail=f"Config file not found: {config_file}")

    try:
        return config_file.read_text()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error loading raw config: {str(e)}")


def save_config_raw(content: str) -> Dict[str, Any]:
    """Validate and save raw llama-swap configuration text."""
    config_file = Path(os.path.expanduser(settings["llama_swap_config"]))

    try:
        parsed = yaml.safe_load(content) if content.strip() else {}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {str(e)}")

    if parsed is None:
        parsed = {}

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Config root must be a YAML mapping/object")

    try:
        config_file.parent.mkdir(parents=True, exist_ok=True)
        config_file.write_text(content if content.endswith("\n") else f"{content}\n")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving raw config: {str(e)}")

    return {"saved": True}


def get_config_guide() -> str:
    """Get the bundled llama-swap config example used as a guide."""
    if not CONFIG_EXAMPLE_FILE.exists():
        return FALLBACK_CONFIG_GUIDE

    try:
        return CONFIG_EXAMPLE_FILE.read_text()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error loading config guide: {str(e)}")


def get_llmfit_recommendations(use_case: str = "chat", limit: int = 6, runtime: str = "llamacpp") -> Dict[str, Any]:
    base_url = get_llmfit_base_url()
    if not base_url:
        raise HTTPException(
            status_code=503,
            detail="llmfit is not configured. Set LLMFIT_URL or run the Docker Compose stack with the llmfit service.",
        )

    try:
        response = requests.get(
            f"{base_url}/api/v1/models/top",
            params={
                "limit": max(1, min(limit, 12)),
                "min_fit": "good",
                "runtime": runtime,
                "use_case": use_case,
            },
            timeout=20,
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Failed to reach llmfit: {e}")

    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    try:
        return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Invalid llmfit response: {e}")


def get_effective_hardware_profile() -> Dict[str, Any]:
    if is_docker_managed_runtime():
        try:
            payload = get_llmfit_recommendations(use_case="chat", limit=1)
            system = payload.get("system") or {}
            gpu_name = system.get("gpu_name") if system.get("has_gpu") else None
            gpu_vram_gb = system.get("gpu_vram_gb") if system.get("has_gpu") else 0
            return {
                "source": "llmfit",
                "gpu_name": gpu_name,
                "memory_total_gb": float(gpu_vram_gb or 0),
                "available": bool(system.get("has_gpu")),
                "backend": system.get("backend"),
            }
        except Exception:
            logger.debug("Unable to read llmfit hardware profile; falling back to local GPU stats.", exc_info=True)

    gpu = get_gpu_stats()
    return {
        "source": "local",
        "gpu_name": None,
        "memory_total_gb": float(gpu.get("memory_total_gb") or 0),
        "available": bool(gpu.get("available")),
        "backend": "local",
    }


model_config_service = ModelConfigService(
    get_config=get_config,
    save_config=save_config,
    get_gguf_directory=lambda: settings["gguf_directory"],
    get_hardware_profile=get_effective_hardware_profile,
    infer_request_mode=infer_request_mode,
    is_docker_mode=is_docker_managed_runtime,
)


def get_runtime_gpu_stats() -> Dict[str, Any]:
    gpu = get_gpu_stats()
    if gpu.get("available"):
        return gpu

    hardware = get_effective_hardware_profile()
    return {
        "memory_used_gb": 0,
        "memory_total_gb": round(float(hardware.get("memory_total_gb") or 0), 1),
        "temperature_c": 0,
        "available": bool(hardware.get("available")),
        "source": hardware.get("source"),
        "gpus": [],
        "count": 0,
    }


def get_runtime_gpu_warning(gpu_stats: Dict[str, Any], docker_gpu: Dict[str, Any]) -> Optional[Dict[str, str]]:
    if not is_docker_managed_runtime():
        return None

    if not gpu_stats.get("available"):
        return None

    if gpu_stats.get("gpus"):
        return None

    if (docker_gpu or {}).get("state") not in ("ready", "containerized"):
        return None

    return {
        "kind": "runtime_cuda_unavailable",
        "message": (
            "A GPU is present on the host, but the running llama-runtime container currently sees zero CUDA devices. "
            "Models pinned with `--main-gpu 0` or advanced GPU assignment can fail until the stack is recreated cleanly."
        ),
        "next_step": "Recreate the stack with `docker compose down && docker compose up -d --build` after confirming host `nvidia-smi` works.",
    }



class DownloadRequest(BaseModel):
    url: str
    filename: str


class AddModelToConfigRequest(BaseModel):
    filename: str
    config_key: Optional[str] = None
    display_name: Optional[str] = None
    preset_id: Optional[str] = None


class TestPrompt(BaseModel):
    prompt: str
    model: str = ""
    image_data_url: str = ""
    max_tokens: Optional[int] = 512
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    min_p: Optional[float] = None
    repeat_penalty: Optional[float] = None
    seed: Optional[int] = None
    stop: Optional[List[str]] = None


class SpeechSynthesisRequest(BaseModel):
    model: str
    input: str
    voice: Optional[str] = None


class SpeechAliasesRequest(BaseModel):
    aliases: Dict[str, str] = Field(default_factory=dict)


class RawConfigRequest(BaseModel):
    content: str


@app.get("/api/models")
def api_list_models():
    """List all GGUF model files with metadata"""
    return model_file_service.list_gguf_files()


@app.delete("/api/models/{filename}")
def api_delete_model(filename: str):
    """Delete a model file"""
    return model_file_service.delete_model(filename)


@app.post("/api/models/download")
def api_download_model(req: DownloadRequest):
    """Start downloading a model from HuggingFace"""
    task_id = download_manager.download_model(req.url, req.filename)
    return {"task_id": task_id, "status": "started"}


@app.get("/api/models/downloads")
def api_list_model_downloads():
    """List active and recent model download tasks."""
    return {"downloads": download_manager.list_tasks()}


@app.post("/api/models/downloads/{task_id}/pause")
def api_pause_model_download(task_id: str):
    return download_manager.pause(task_id)


@app.post("/api/models/downloads/{task_id}/resume")
def api_resume_model_download(task_id: str):
    return download_manager.resume(task_id)


@app.delete("/api/models/downloads/{task_id}")
def api_remove_model_download(task_id: str):
    return download_manager.remove(task_id)


@app.get("/api/hf/repo-files")
def api_hf_repo_files(repo_id: str = Query(..., description="owner/repo")):
    """List GGUF files for a Hugging Face repository."""
    repo_id = repo_id.strip()
    if not repo_id or "/" not in repo_id:
        raise HTTPException(status_code=400, detail="repo_id must be in format owner/repo")
    return {"repo_id": repo_id, "files": model_file_service.list_hf_gguf_files(repo_id)}


@app.put("/api/models/{old_name}")
def api_rename_model(old_name: str, new_name: str):
    """Rename a model file"""
    return model_file_service.rename_model(old_name, new_name)


@app.get("/api/models/{filename}/presets")
def api_model_presets(filename: str):
    """Generate launch presets for a model based on detected hardware and file characteristics."""
    hardware = get_effective_hardware_profile()
    return {
        "filename": filename,
        "hardware": {
            "gpu": hardware,
            "runtime_mode": get_runtime_mode(),
        },
        "presets": model_config_service.build_launch_presets(filename),
    }


@app.get("/api/config")
def api_get_config():
    """Get llama-swap configuration"""
    logger.info("API: /api/config called")
    return get_config()


@app.put("/api/config")
def api_save_config(config: Dict[str, Any]):
    """Save llama-swap configuration"""
    return save_config(config)


@app.get("/api/config/raw")
def api_get_config_raw():
    """Get raw llama-swap configuration text."""
    return {"content": get_config_raw()}


@app.put("/api/config/raw")
def api_save_config_raw(payload: RawConfigRequest):
    """Save raw llama-swap configuration text."""
    return save_config_raw(payload.content)


@app.get("/api/config/guide")
def api_get_config_guide():
    """Get the bundled llama-swap config example as a guide."""
    return {"content": get_config_guide()}


@app.post("/api/config/add-model")
def api_add_model_to_config(request: AddModelToConfigRequest):
    """Append a discovered GGUF model to the active llama-swap config with generated defaults."""
    return model_config_service.add_model_to_config(
        filename=request.filename,
        model_id=request.config_key,
        display_name=request.display_name,
        preset_id=request.preset_id,
    )


@app.get("/api/discover/recommendations")
def api_discover_recommendations(
    use_case: str = Query("chat", description="Recommendation profile such as chat or coding"),
    limit: int = Query(6, ge=1, le=12),
):
    """Proxy llmfit recommendations for the current machine."""
    return get_llmfit_recommendations(use_case=use_case, limit=limit)


@app.get("/api/updates")
def api_get_updates(refresh: bool = Query(False)):
    """Get current versions, update signals, and changelog links for Ignite runtime components."""
    return get_updates_payload(refresh=refresh)


@app.post("/api/updates/actions/{action}")
def api_run_update_action(action: str):
    """Run a managed update action for one Docker-backed Ignite service."""
    return run_update_action(action)


@app.get("/api/runtime/models")
def api_runtime_models():
    """Get current model states from llama-swap."""
    return {"models": get_llama_swap_model_status()}


@app.get("/api/speech/registry")
def api_speech_registry(task: str = Query(""), search: str = Query("")):
    """List downloadable speech models from the remote Speaches registry."""
    return speech_service.get_registry(task=task, search=search)


@app.get("/api/speech/models")
def api_speech_models():
    """List locally installed speech models."""
    return speech_service.get_installed_models()


@app.get("/api/speech/voices")
def api_speech_voices(model: str = Query("")):
    """List available voices from the speech service."""
    return speech_service.get_voices(model=model)


@app.get("/api/speech/aliases")
def api_speech_aliases():
    """Read OpenAI-compatible speech aliases from the shared audio folder."""
    return {
        "aliases": speech_service.read_aliases(),
        "file": str(speech_service.get_alias_runtime_file()),
        "container_file": SPEACHES_ALIAS_CONTAINER_FILE,
    }


@app.put("/api/speech/aliases")
def api_save_speech_aliases(request: SpeechAliasesRequest):
    """Save speech aliases and restart Speaches so its alias cache reloads."""
    return speech_service.write_aliases(request.aliases)


@app.post("/api/speech/models/install/{model_id:path}")
def api_speech_model_install(model_id: str):
    """Download or install a speech model through Speaches."""
    return speech_service.install_model(model_id)


@app.post("/api/speech/test/tts")
def api_speech_test_tts(request: SpeechSynthesisRequest):
    """Synthesize speech through Speaches and return audio bytes."""
    content, media_type = speech_service.synthesize(request.model, request.input, request.voice)
    return Response(content=content, media_type=media_type)


@app.post("/api/speech/test/stt")
async def api_speech_test_stt(
    model: str = Form(...),
    file: UploadFile = File(...),
):
    """Transcribe speech through Speaches and return JSON."""
    return await speech_service.transcribe(model, file)


@app.get("/api/runtime/overview")
def api_runtime_overview():
    """Get model states, request metrics, and inflight count from llama-swap."""
    return get_llama_swap_runtime_overview()


@app.get("/api/runtime/captures/{capture_id}")
def api_runtime_capture(capture_id: int):
    """Get a stored request/response capture from llama-swap."""
    return get_llama_swap_capture(capture_id)


@app.post("/api/runtime/models/load/{model_id}")
def api_runtime_model_load(model_id: str):
    """Explicitly load a model through llama-swap."""
    return request_llama_swap_model_load(model_id)


@app.post("/api/runtime/models/unload/{model_id}")
def api_runtime_model_unload(model_id: str):
    """Explicitly unload a model through llama-swap."""
    return request_llama_swap_model_unload(model_id)


@app.post("/api/runtime/models/unload")
def api_runtime_models_unload_all():
    """Unload all currently loaded models."""
    return request_llama_swap_unload_all()


@app.get("/api/status")
def api_status():
    """Get llama-swap status and GPU stats"""
    logger.info("API: /api/status called")
    running = is_llama_swap_running()
    pid = get_llama_swap_pid() if running else None
    gpu_stats = get_runtime_gpu_stats()
    docker_gpu = get_docker_gpu_preflight()
    runtime_gpu_warning = get_runtime_gpu_warning(gpu_stats, docker_gpu)
    config_summary = model_config_service.get_config_summary()
    speech_status = speech_service.get_status()
    
    logger.info(f"Status: running={running}, pid={pid}, gpu={gpu_stats}, docker_gpu={docker_gpu.get('state')}")
    
    return {
        "running": running,
        "pid": pid,
        "gpu": gpu_stats,
        "docker_gpu": docker_gpu,
        "runtime_gpu_warning": runtime_gpu_warning,
        "docker_control_available": can_manage_docker_runtime(),
        "docker_control_warning": get_docker_control_warning(),
        "runtime_mode": get_runtime_mode(),
        "backend_port": settings["backend_port"],
        "llama_swap_port": settings["llama_swap_port"],
        "speaches_port": speech_status.get("port", DOCKER_SPEACHES_PORT),
        "config_path": settings["llama_swap_config"],
        "config_exists": Path(os.path.expanduser(settings["llama_swap_config"])).exists(),
        "speech": speech_status,
        **config_summary,
    }


@app.post("/api/service/start")
def api_start_service():
    """Start llama-swap service"""
    return start_llama_swap()


@app.post("/api/service/stop")
def api_stop_service():
    """Stop llama-swap service"""
    return stop_llama_swap()


@app.get("/api/logs")
def api_logs(lines: int = 100):
    """Get recent llama-swap logs"""
    return log_service.get_recent_logs(lines)


@app.get("/api/logs/upstream")
def api_upstream_logs(lines: int = 100):
    """Get recent upstream/model logs (filtered)."""
    return log_service.get_upstream_logs(lines)


@app.get("/api/logs/docker/{stream_name}")
def api_docker_logs(stream_name: str, lines: int = 200):
    """Get recent Docker container logs for Ignite-managed services."""
    return log_service.get_docker_container_logs(stream_name, lines)


@app.get("/api/logs/events")
def api_log_events(lines: int = 100):
    """Get recent llama-swap event logs from its own API."""
    return log_service.get_event_logs(lines)


@app.get("/api/logs/stream/{stream_type}")
def api_stream_logs(stream_type: str):
    """Proxy llama-swap SSE log streams to the frontend."""
    return log_service.stream_logs(stream_type)


@app.post("/api/test")
def api_test_prompt(prompt: TestPrompt):
    """Send a test prompt to the selected model via llama-swap OpenAI-compatible API"""
    import time
    try:
        request_mode = model_config_service.get_configured_model_mode(prompt.model)
        endpoint = "/v1/chat/completions"
        payload: Dict[str, Any]
        image_data_url = (prompt.image_data_url or "").strip()
        max_tokens = prompt.max_tokens if prompt.max_tokens is not None else 512
        generation_settings = {
            "max_tokens": max_tokens,
        }
        for key in ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "seed"]:
            value = getattr(prompt, key)
            if value is not None:
                generation_settings[key] = value
        if prompt.stop:
            generation_settings["stop"] = [item for item in prompt.stop if str(item).strip()]

        if request_mode == "completion":
            if image_data_url:
                raise HTTPException(status_code=400, detail="Completion models do not support image input in Test.")
            endpoint = "/v1/completions"
            payload = {
                "prompt": prompt.prompt,
                **generation_settings,
            }
        else:
            user_content: Any
            if image_data_url:
                user_content = []
                if prompt.prompt.strip():
                    user_content.append({"type": "text", "text": prompt.prompt})
                user_content.append({"type": "image_url", "image_url": {"url": image_data_url}})
            else:
                user_content = prompt.prompt

            payload = {
                "messages": [{"role": "user", "content": user_content}],
                **generation_settings,
            }

        if prompt.model:
            payload["model"] = prompt.model

        start = time.time()
        response = requests.post(
            f"{get_llama_swap_base_url()}{endpoint}",
            json=payload,
            timeout=120
        )
        duration_ms = int((time.time() - start) * 1000)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        result = response.json()
        choice = result.get("choices", [{}])[0]
        if request_mode == "completion":
            content = choice.get("text", "")
            reasoning = ""
        else:
            message = choice.get("message", {})
            content = message.get("content", "")
            reasoning = message.get("reasoning_content", "")
        usage = result.get("usage", {})
        timings = result.get("timings", {})
        tokens = usage.get("completion_tokens", 0)

        return {
            "response": content,
            "reasoning": reasoning,
            "tokens": tokens,
            "duration_ms": duration_ms,
            "model": result.get("model", prompt.model),
            "usage": usage,
            "timings": timings,
            "id": result.get("id"),
            "object": result.get("object"),
            "created": result.get("created"),
            "system_fingerprint": result.get("system_fingerprint"),
            "finish_reason": choice.get("finish_reason"),
            "request_mode": request_mode,
            "request_settings": generation_settings,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Request failed: {str(e)}")


@app.websocket("/ws/download/{task_id}")
async def websocket_download(websocket: WebSocket, task_id: str):
    """WebSocket for download progress updates"""
    await websocket.accept()
    try:
        while True:
            payload = download_manager.get_task_payload(task_id)
            if payload is None:
                await websocket.send_json({"status": "missing", "error": "Download task not found"})
                break
            await websocket.send_json(payload)
            if payload["status"] in {"completed", "error", "paused"}:
                break
            await asyncio.sleep(0.5)
    finally:
        await websocket.close()


@app.get("/api/settings")
def api_get_settings():
    """Get current settings"""
    docker_restart_policies = get_managed_docker_restart_policies() if is_docker_managed_runtime() else {}
    docker_restart_policy = get_docker_restart_policy_name() if is_docker_managed_runtime() else None
    runtime_refs = parse_current_runtime_refs() if is_docker_managed_runtime() else None
    restart_on_boot = (
        docker_restart_policy == "unless-stopped"
        if docker_restart_policy is not None
        else bool(settings.get("restart_on_boot"))
    )
    return {
        **settings,
        "restart_on_boot": restart_on_boot,
        "_meta": {
            "runtime_mode": get_runtime_mode(),
            "managed_runtime": is_docker_managed_runtime(),
            "config_exists": Path(os.path.expanduser(settings["llama_swap_config"])).exists(),
            "docker_control_warning": get_docker_control_warning(),
            "docker_restart_policy": docker_restart_policy,
            "docker_restart_policies": docker_restart_policies if is_docker_managed_runtime() else None,
            "docker_restart_policy_mismatch": docker_restart_policy == "mismatch",
            "docker_paths": {
                "models_dir": os.environ.get("IGNITE_MODELS_DIR", os.environ.get("SWAPDECK_MODELS_DIR", "./models")),
                "config_dir": os.environ.get("IGNITE_CONFIG_DIR", os.environ.get("SWAPDECK_CONFIG_DIR", "./config")),
            } if is_docker_managed_runtime() else None,
            "runtime_refs": runtime_refs,
            "speech_runtime": speech_service.get_runtime_info() if is_docker_managed_runtime() else None,
            "speech_accel_options": ["cpu", "cuda"] if is_docker_managed_runtime() else None,
        },
    }


@app.put("/api/settings")
def api_save_settings(new_settings: Dict[str, Any]):
    """Save settings to settings.json and update in-memory values"""
    global settings
    requested_speaches_accel = None
    requested_llama_cpp_image = None
    # Only allow known keys
    for key in DEFAULT_SETTINGS:
        if key in new_settings:
            settings[key] = new_settings[key]
    if is_docker_managed_runtime() and "restart_on_boot" in new_settings:
        apply_docker_restart_policy(bool(new_settings["restart_on_boot"]))
    if is_docker_managed_runtime() and "speaches_accel" in new_settings:
        requested_speaches_accel = str(new_settings["speaches_accel"] or "").strip().lower() or "cpu"
        if requested_speaches_accel not in {"cpu", "cuda"}:
            raise HTTPException(status_code=400, detail="Speech acceleration must be 'cpu' or 'cuda'.")
        settings["speaches_accel"] = requested_speaches_accel
    if is_docker_managed_runtime() and "llama_cpp_image" in new_settings:
        requested_llama_cpp_image = str(new_settings["llama_cpp_image"] or "").strip()
        if not requested_llama_cpp_image:
            raise HTTPException(status_code=400, detail="llama.cpp image is required.")
        settings["llama_cpp_image"] = requested_llama_cpp_image
    if is_docker_managed_runtime() and "llama_swap_version" in new_settings:
        settings["llama_swap_version"] = normalize_llama_swap_version(str(new_settings["llama_swap_version"] or ""))
    if requested_llama_cpp_image is not None:
        rebuild_runtime_container(requested_llama_cpp_image, settings.get("llama_swap_version", "211"))
    save_settings(settings)
    if requested_speaches_accel is not None:
        speech_service.recreate_container(requested_speaches_accel)
    return api_get_settings()


@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.get("/", include_in_schema=False)
def serve_frontend_index():
    """Serve the built frontend index if present."""
    index_file = FRONTEND_DIST_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=NO_CACHE_HEADERS)
    raise HTTPException(
        status_code=404,
        detail="Frontend build not found. Run `cd frontend && npm run build`."
    )


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend_spa(full_path: str):
    """SPA fallback for client-side routes when serving built frontend."""
    if full_path.startswith(("api/", "ws/", "health")):
        raise HTTPException(status_code=404, detail="Not Found")

    candidate = FRONTEND_DIST_DIR / full_path
    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)

    index_file = FRONTEND_DIST_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=NO_CACHE_HEADERS)
    raise HTTPException(
        status_code=404,
        detail="Frontend build not found. Run `cd frontend && npm run build`."
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=settings["backend_port"])
