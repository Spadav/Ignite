#!/usr/bin/env python3
"""
Llama Swap Control Panel - Backend
Manages llama-swap service, models, and configuration
"""
import os
import sys
import re
import json
import glob
import shutil
import subprocess
import logging
from pathlib import Path
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
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
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl
import uvicorn

# Configuration
LLAMA_SWAP_PROCESS_FILE = "/tmp/llama_swap.pid"
LLAMA_SWAP_LOG_FILE = "/tmp/llama_swap.log"

SETTINGS_FILE = Path(__file__).parent / "settings.json"
FRONTEND_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
CONFIG_EXAMPLE_FILE = Path(__file__).resolve().parent.parent / "config" / "config.example.yaml"
NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
IS_DOCKER = os.environ.get("SWAPDECK_DOCKER") == "1"
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
}

DOCKER_DEFAULT_SETTINGS = {
    "gguf_directory": "/models",
    "llama_swap_dir": "/runtime",
    "llama_swap_config": "/config/config.yaml",
    "llama_swap_port": 8090,
    "backend_port": 3000,
}

DEFAULT_SETTINGS = DOCKER_DEFAULT_SETTINGS if IS_DOCKER else LOCAL_DEFAULT_SETTINGS
DOCKER_SOCKET_PATH = "/var/run/docker.sock"
DOCKER_RUNTIME_CONTAINER = os.environ.get("IGNITE_RUNTIME_CONTAINER", "llama-runtime")
DOCKER_SUPPORT_CONTAINERS = [name for name in [os.environ.get("IGNITE_LLMFIT_CONTAINER", "llmfit")] if name]
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


def load_settings() -> Dict[str, Any]:
    """Load settings from settings.json, falling back to defaults if missing."""
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r") as f:
                saved = json.load(f)
            settings.update(saved)
        except Exception as e:
            logger.warning(f"Failed to load settings.json, using defaults: {e}")
    return settings


def save_settings(new_settings: Dict[str, Any]) -> None:
    """Save settings to settings.json."""
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


@dataclass
class DownloadTask:
    url: str
    filename: str
    progress: float = 0.0
    status: str = "pending"
    error: Optional[str] = None

active_downloads: Dict[str, DownloadTask] = {}
docker_gpu_preflight_cache: Dict[str, Any] = {"checked_at": None, "result": None}


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


def get_gpu_stats() -> Dict[str, Any]:
    """Get NVIDIA GPU statistics using nvidia-smi"""
    try:
        result = run_command(["nvidia-smi", "--query-gpu=memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"])
        if result.returncode == 0:
            parts = result.stdout.strip().split(",")
            if len(parts) >= 2:
                return {
                    "memory_used_gb": round(int(parts[0].strip()) / 1024, 1),
                    "memory_total_gb": round(int(parts[1].strip()) / 1024, 1),
                    "temperature_c": int(parts[2].strip()) if len(parts) > 2 else 0,
                    "available": True,
                }
        return {"memory_used_gb": 0, "memory_total_gb": 0, "temperature_c": 0, "available": False}
    except Exception:
        return {"memory_used_gb": 0, "memory_total_gb": 0, "temperature_c": 0, "available": False}


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

    try:
        test = run_command(
            ["docker", "run", "--rm", "--gpus", "all", "--entrypoint", "sh", "ghcr.io/ggml-org/llama.cpp:server-cuda", "-lc", "nvidia-smi -L"],
            timeout=20.0,
        )
        if test.returncode == 0 and "GPU " in (test.stdout or ""):
            preflight["gpu_ready"] = True
            preflight["state"] = "ready"
            preflight["message"] = "Docker GPU runtime is ready."
            docker_gpu_preflight_cache.update({"checked_at": datetime.now(), "result": preflight})
            return preflight

        failure_text = "\n".join(filter(None, [(test.stdout or "").strip(), (test.stderr or "").strip()]))
    except Exception as e:
        failure_text = str(e)

    preflight["state"] = "docker_gpu_not_ready"
    preflight["message"] = "Docker is installed, but GPU passthrough is not configured."
    preflight["details"] = [
        "Host `nvidia-smi` works, but `docker run --gpus all ...` does not.",
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


def get_recent_logs(lines: int = 100) -> List[str]:
    """Get recent llama-swap logs"""
    try:
        if os.path.exists(LLAMA_SWAP_LOG_FILE):
            with open(LLAMA_SWAP_LOG_FILE, "r") as f:
                all_lines = f.readlines()
                return [line.rstrip() for line in all_lines[-lines:]]
        return []
    except Exception:
        return []


def get_upstream_logs(lines: int = 100) -> List[str]:
    """Get model/upstream-related logs by filtering out noisy proxy request lines."""
    all_logs = get_recent_logs(lines=lines * 6)
    if not all_logs:
        return []

    filtered = []
    for line in all_logs:
        # Hide routine access logs to keep model process output visible.
        if "Request " in line and "HTTP/1.1" in line:
            continue
        if "GET /v1/models" in line:
            continue
        filtered.append(line)

    return filtered[-lines:]


def get_llama_swap_events(lines: int = 100) -> List[str]:
    """Fetch recent llama-swap events from its API, if available."""
    base_url = get_llama_swap_base_url()
    try:
        response = requests.get(f"{base_url}/api/events", timeout=3)
        if response.status_code != 200:
            return []

        content_type = response.headers.get("content-type", "").lower()
        if "application/json" in content_type:
            payload = response.json()
            if isinstance(payload, list):
                return [str(item) for item in payload[-lines:]]
            return [json.dumps(payload)]

        raw_lines = [line for line in response.text.splitlines() if line.strip()]
        return raw_lines[-lines:]
    except Exception:
        return []


def list_gguf_files() -> List[Dict[str, Any]]:
    """List all GGUF model files in the directory"""
    models = []
    gguf_path = Path(os.path.expanduser(settings["gguf_directory"]))
    
    if not gguf_path.exists():
        return models
    
    for file_path in gguf_path.glob("*.gguf"):
        try:
            stat = file_path.stat()
            models.append({
                "filename": file_path.name,
                "size_bytes": stat.st_size,
                "size_gb": round(stat.st_size / (1024**3), 2),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
            })
        except Exception:
            continue
    
    return models


def delete_model(filename: str) -> Dict[str, Any]:
    """Delete a model file"""
    file_path = Path(os.path.expanduser(settings["gguf_directory"])) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Model file not found")
    
    file_path.unlink()
    return {"deleted": filename}


def download_model(url: str, filename: str) -> str:
    """Start downloading a model from HuggingFace"""
    task_id = filename
    active_downloads[task_id] = DownloadTask(url=str(url), filename=filename, status="downloading")
    return task_id


def list_hf_gguf_files(repo_id: str) -> List[Dict[str, Any]]:
    """List GGUF files in a Hugging Face repository."""
    headers = {}
    hf_token = os.environ.get("HF_TOKEN")
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    response = requests.get(
        f"https://huggingface.co/api/models/{repo_id}",
        params=[("expand[]", "siblings")],
        headers=headers,
        timeout=20,
    )

    if response.status_code == 404:
        raise HTTPException(status_code=404, detail=f"Repo not found: {repo_id}")
    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"Hugging Face API error: {response.text}",
        )

    data = response.json()
    siblings = data.get("siblings") or []
    files = []

    for item in siblings:
        rfilename = item.get("rfilename") or ""
        if not rfilename.lower().endswith(".gguf"):
            continue

        files.append({
            "path": rfilename,
            "filename": Path(rfilename).name,
            "size_bytes": item.get("size"),
            "download_url": f"https://huggingface.co/{repo_id}/resolve/main/{quote(rfilename, safe='/')}?download=true",
        })

    files.sort(key=lambda x: x["path"].lower())
    return files


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
            pass

    gpu = get_gpu_stats()
    return {
        "source": "local",
        "gpu_name": None,
        "memory_total_gb": float(gpu.get("memory_total_gb") or 0),
        "available": bool(gpu.get("available")),
        "backend": "local",
    }


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
    }


def rename_model(old_name: str, new_name: str) -> Dict[str, Any]:
    """Rename a model file"""
    old_path = Path(os.path.expanduser(settings["gguf_directory"])) / old_name
    new_path = Path(os.path.expanduser(settings["gguf_directory"])) / new_name
    
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Model file not found")
    
    if new_path.exists():
        raise HTTPException(status_code=409, detail="Target filename already exists")
    
    old_path.rename(new_path)
    return {"renamed": {"from": old_name, "to": new_name}}


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


def sanitize_model_id(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return sanitized or f"Model-{int(datetime.now().timestamp())}"


def get_model_file_info(filename: str) -> Dict[str, Any]:
    model_path = Path(os.path.expanduser(settings["gguf_directory"])) / filename
    if not model_path.exists():
        raise HTTPException(status_code=404, detail="Model file not found")

    size_gib = round(model_path.stat().st_size / (1024 ** 3), 2)
    family = infer_request_mode(filename)

    return {
        "filename": filename,
        "size_gib": size_gib,
        "family": family,
    }


def build_launch_presets(filename: str) -> List[Dict[str, Any]]:
    info = get_model_file_info(filename)
    hardware = get_effective_hardware_profile()
    vram_gib = hardware["memory_total_gb"] if hardware.get("available") else 0
    can_quantize_kv = vram_gib > 0

    if vram_gib >= 40:
        balanced_ctx = 65536
        long_ctx = 131072
    elif vram_gib >= 24:
        balanced_ctx = 32768
        long_ctx = 65536
    elif vram_gib >= 16:
        balanced_ctx = 16384
        long_ctx = 32768
    else:
        balanced_ctx = 8192
        long_ctx = 16384

    if info["size_gib"] > max(vram_gib - 2, 0) and vram_gib > 0:
        balanced_ctx = min(balanced_ctx, 16384)
        long_ctx = min(long_ctx, 32768)

    safe_preset = {
        "id": "safe",
        "name": "Safe",
        "summary": "Highest chance to load cleanly on limited VRAM.",
        "why_use": "Use this first if you are unsure, or if larger context settings fail to load.",
        "why_not": "Lower context length and less aggressive performance tuning.",
        "context": min(8192, balanced_ctx),
        "gpu_layers": 99 if vram_gib > 0 else 0,
        "flash_attention": vram_gib > 0,
        "kv_cache": {"k": "q8_0", "v": "q8_0"} if can_quantize_kv and info["size_gib"] <= 12 else None,
        "batch": 512,
        "ubatch": 256,
        "template_mode": info["family"],
    }

    balanced_preset = {
        "id": "balanced",
        "name": "Balanced",
        "summary": "Recommended default for most systems.",
        "why_use": "Good tradeoff between speed, context length, and stability.",
        "why_not": "May still be too aggressive for very large models on tight VRAM.",
        "context": balanced_ctx,
        "gpu_layers": 99 if vram_gib > 0 else 0,
        "flash_attention": vram_gib > 0,
        "kv_cache": {"k": "q8_0", "v": "q8_0"} if can_quantize_kv and balanced_ctx >= 16384 else None,
        "batch": 1024 if vram_gib >= 16 else 512,
        "ubatch": 512 if vram_gib >= 16 else 256,
        "template_mode": info["family"],
    }

    long_context_preset = {
        "id": "long-context",
        "name": "Long Context",
        "summary": "Pushes context length higher with safer KV choices.",
        "why_use": "Use for long chats, larger documents, or repo-scale prompts.",
        "why_not": "More likely to hit VRAM limits or reduce throughput.",
        "context": long_ctx,
        "gpu_layers": 99 if vram_gib > 0 else 0,
        "flash_attention": vram_gib > 0,
        "kv_cache": {"k": "q4_0", "v": "q4_0"} if can_quantize_kv else None,
        "batch": 512,
        "ubatch": 256,
        "template_mode": info["family"],
    }

    presets = [safe_preset, balanced_preset, long_context_preset]
    if vram_gib <= 0:
        for preset in presets:
            preset["summary"] = f"{preset['summary']} CPU-only mode."
            preset["flash_attention"] = False
            preset["kv_cache"] = None
            preset["gpu_layers"] = 0
            preset["batch"] = 256
            preset["ubatch"] = 128

    return presets


def resolve_launch_preset(filename: str, preset_id: Optional[str]) -> Dict[str, Any]:
    presets = build_launch_presets(filename)
    if not preset_id:
        return next((preset for preset in presets if preset["id"] == "balanced"), presets[0])
    for preset in presets:
        if preset["id"] == preset_id:
            return preset
    raise HTTPException(status_code=400, detail=f"Unknown preset: {preset_id}")


def build_generated_model_entry(filename: str, display_name: Optional[str] = None, preset_id: Optional[str] = None) -> Dict[str, Any]:
    preset = resolve_launch_preset(filename, preset_id)
    model_path = f"/models/{filename}" if is_docker_managed_runtime() else str(
        Path(os.path.expanduser(settings["gguf_directory"])) / filename
    )
    command_parts = [
        "/app/llama-server" if is_docker_managed_runtime() else "llama-server",
        f"-m {model_path}",
        "--host 0.0.0.0" if is_docker_managed_runtime() else "--host 127.0.0.1",
        "--port ${PORT}",
        f"-ngl {preset['gpu_layers']}",
        "-fa on" if preset["flash_attention"] else "-fa off",
        f"-c {preset['context']}",
        f"-b {preset['batch']}",
        f"-ub {preset['ubatch']}",
    ]
    if preset.get("kv_cache"):
        command_parts.append(f"--cache-type-k {preset['kv_cache']['k']}")
        command_parts.append(f"--cache-type-v {preset['kv_cache']['v']}")

    return {
        "name": display_name or Path(filename).stem,
        "cmd": "\n".join(command_parts),
        "proxy": "http://127.0.0.1:${PORT}",
        "metadata": {
            "ignitePreset": preset["id"],
            "igniteTemplateMode": preset["template_mode"],
            "igniteRequestMode": preset["template_mode"],
            "igniteContext": preset["context"],
        },
    }


def get_configured_model_mode(model_id: str) -> str:
    if not model_id:
        return "chat"

    try:
        config = get_config()
    except Exception:
        return "chat"

    model_entry = (config.get("models") or {}).get(model_id) or {}
    metadata = model_entry.get("metadata") or {}
    explicit_mode = str(metadata.get("igniteRequestMode") or metadata.get("igniteTemplateMode") or "").strip().lower()
    if explicit_mode in {"chat", "completion"}:
        return explicit_mode

    return infer_request_mode(
        model_id,
        model_entry.get("name"),
        model_entry.get("useModelName"),
        model_entry.get("cmd"),
        " ".join(model_entry.get("aliases") or []),
    )


def get_config_summary() -> Dict[str, Any]:
    try:
        config = get_config()
    except Exception:
        return {
            "configured_model_count": 0,
            "configured_model_ids": [],
            "default_model_id": "",
            "default_model_mode": "chat",
        }

    models = config.get("models") or {}
    model_ids = list(models.keys())
    default_model_id = str((config.get("healthCheck") or {}).get("model") or "").strip()
    if default_model_id not in models:
        default_model_id = model_ids[0] if model_ids else ""

    default_model_mode = get_configured_model_mode(default_model_id) if default_model_id else "chat"

    return {
        "configured_model_count": len(model_ids),
        "configured_model_ids": model_ids,
        "default_model_id": default_model_id,
        "default_model_mode": default_model_mode,
    }


def add_model_to_config(filename: str, model_id: Optional[str] = None, display_name: Optional[str] = None, preset_id: Optional[str] = None) -> Dict[str, Any]:
    model_path = Path(os.path.expanduser(settings["gguf_directory"])) / filename
    if not model_path.exists():
        raise HTTPException(status_code=404, detail="Model file not found")

    config = get_config()
    models = config.setdefault("models", {})

    base_model_id = sanitize_model_id(model_id or Path(filename).stem)
    final_model_id = base_model_id
    suffix = 2
    while final_model_id in models:
        if models[final_model_id].get("cmd", "").find(filename) != -1:
            raise HTTPException(status_code=409, detail=f"Model already configured as {final_model_id}")
        final_model_id = f"{base_model_id}-{suffix}"
        suffix += 1

    if (
        "ExampleModel" in models
        and len(models) == 1
        and "REPLACE_WITH_MODEL.gguf" in str(models["ExampleModel"].get("cmd", ""))
    ):
        models.pop("ExampleModel", None)

    chosen_preset = resolve_launch_preset(filename, preset_id)
    models[final_model_id] = build_generated_model_entry(filename, display_name, chosen_preset["id"])

    health_check = config.get("healthCheck")
    if not isinstance(health_check, dict) or not health_check.get("model") or health_check.get("model") == "ExampleModel":
        config["healthCheck"] = {"model": final_model_id}

    config.setdefault("globalTTL", 0)
    config.setdefault("startPort", 5800)
    save_config(config)

    return {
        "saved": True,
        "model_id": final_model_id,
        "display_name": models[final_model_id]["name"],
        "preset_id": chosen_preset["id"],
    }


class RawConfigRequest(BaseModel):
    content: str


@app.get("/api/models")
def api_list_models():
    """List all GGUF model files with metadata"""
    return list_gguf_files()


@app.delete("/api/models/{filename}")
def api_delete_model(filename: str):
    """Delete a model file"""
    return delete_model(filename)


@app.post("/api/models/download")
def api_download_model(req: DownloadRequest):
    """Start downloading a model from HuggingFace"""
    task_id = download_model(req.url, req.filename)
    return {"task_id": task_id, "status": "started"}


@app.get("/api/hf/repo-files")
def api_hf_repo_files(repo_id: str = Query(..., description="owner/repo")):
    """List GGUF files for a Hugging Face repository."""
    repo_id = repo_id.strip()
    if not repo_id or "/" not in repo_id:
        raise HTTPException(status_code=400, detail="repo_id must be in format owner/repo")
    return {"repo_id": repo_id, "files": list_hf_gguf_files(repo_id)}


@app.put("/api/models/{old_name}")
def api_rename_model(old_name: str, new_name: str):
    """Rename a model file"""
    return rename_model(old_name, new_name)


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
        "presets": build_launch_presets(filename),
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
    return add_model_to_config(
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


@app.get("/api/status")
def api_status():
    """Get llama-swap status and GPU stats"""
    logger.info("API: /api/status called")
    running = is_llama_swap_running()
    pid = get_llama_swap_pid() if running else None
    gpu_stats = get_runtime_gpu_stats()
    docker_gpu = get_docker_gpu_preflight()
    config_summary = get_config_summary()
    
    logger.info(f"Status: running={running}, pid={pid}, gpu={gpu_stats}, docker_gpu={docker_gpu.get('state')}")
    
    return {
        "running": running,
        "pid": pid,
        "gpu": gpu_stats,
        "docker_gpu": docker_gpu,
        "docker_control_available": can_manage_docker_runtime(),
        "docker_control_warning": get_docker_control_warning(),
        "runtime_mode": get_runtime_mode(),
        "config_path": settings["llama_swap_config"],
        "config_exists": Path(os.path.expanduser(settings["llama_swap_config"])).exists(),
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
    return get_recent_logs(lines)


@app.get("/api/logs/upstream")
def api_upstream_logs(lines: int = 100):
    """Get recent upstream/model logs (filtered)."""
    return get_upstream_logs(lines)


@app.get("/api/logs/events")
def api_log_events(lines: int = 100):
    """Get recent llama-swap event logs from its own API."""
    events = get_llama_swap_events(lines)
    if events:
        return events
    # Fallback to captured upstream/model logs when events API is empty/unavailable.
    return get_upstream_logs(lines)


@app.get("/api/logs/stream/{stream_type}")
def api_stream_logs(stream_type: str):
    """Proxy llama-swap SSE log streams to the frontend."""
    if stream_type not in {"proxy", "upstream"}:
        raise HTTPException(status_code=404, detail="Unknown stream type")

    target_url = f"{get_llama_swap_base_url()}/logs/stream/{stream_type}"

    def event_generator():
        try:
            with requests.get(target_url, stream=True, timeout=(3, None)) as response:
                if response.status_code != 200:
                    yield f"data: [error] Upstream returned HTTP {response.status_code}\n\n"
                    return

                for raw_line in response.iter_lines(decode_unicode=True):
                    if raw_line is None:
                        continue
                    line = raw_line.strip()
                    if not line:
                        continue
                    # Forward every line as a simple SSE data message.
                    yield f"data: {line}\n\n"
        except Exception as e:
            yield f"data: [error] Failed to read {stream_type} stream: {e}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/test")
def api_test_prompt(prompt: TestPrompt):
    """Send a test prompt to the selected model via llama-swap OpenAI-compatible API"""
    import time
    try:
        request_mode = get_configured_model_mode(prompt.model)
        endpoint = "/v1/chat/completions"
        payload: Dict[str, Any]

        if request_mode == "completion":
            endpoint = "/v1/completions"
            payload = {
                "prompt": prompt.prompt,
                "max_tokens": 512,
            }
        else:
            payload = {
                "messages": [{"role": "user", "content": prompt.prompt}],
                "max_tokens": 512,
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
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Request failed: {str(e)}")


@app.websocket("/ws/download/{task_id}")
async def websocket_download(websocket: WebSocket, task_id: str):
    """WebSocket for download progress updates"""
    await websocket.accept()
    
    if task_id not in active_downloads:
        await websocket.close()
        return
    
    task = active_downloads[task_id]
    dest_path = Path(os.path.expanduser(settings["gguf_directory"])) / task.filename
    
    try:
        response = requests.get(task.url, stream=True)
        response.raise_for_status()
        
        total_size = int(response.headers.get("content-length", 0))
        downloaded = 0
        
        with open(dest_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size:
                        task.progress = (downloaded / total_size) * 100
                    await websocket.send_json({"progress": task.progress, "status": "downloading"})
        
        task.progress = 100
        task.status = "completed"
        await websocket.send_json({"progress": 100, "status": "completed"})
        
    except Exception as e:
        task.status = "error"
        task.error = str(e)
        await websocket.send_json({"status": "error", "error": str(e)})
    
    del active_downloads[task_id]
    await websocket.close()


@app.get("/api/settings")
def api_get_settings():
    """Get current settings"""
    return {
        **settings,
        "_meta": {
            "runtime_mode": get_runtime_mode(),
            "managed_runtime": is_docker_managed_runtime(),
            "config_exists": Path(os.path.expanduser(settings["llama_swap_config"])).exists(),
            "docker_control_warning": get_docker_control_warning(),
        },
    }


@app.put("/api/settings")
def api_save_settings(new_settings: Dict[str, Any]):
    """Save settings to settings.json and update in-memory values"""
    global settings
    # Only allow known keys
    for key in DEFAULT_SETTINGS:
        if key in new_settings:
            settings[key] = new_settings[key]
    save_settings(settings)
    return settings


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
