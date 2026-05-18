import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

import docker
import requests
from fastapi import HTTPException, UploadFile


class SpeechService:
    def __init__(
        self,
        *,
        is_docker: bool,
        docker_port: int,
        container_name: str,
        cache_container_dir: str,
        alias_container_file: str,
        get_settings: Callable[[], Dict[str, Any]],
        get_docker_client: Callable[[], Optional[docker.DockerClient]],
        is_docker_mode: Callable[[], bool],
        stop_and_remove_container: Callable[[Any, int, str, str], None],
        connect_extra_networks: Callable[[Any, Any, List[str], str], None],
        get_gpu_container_options: Callable[[Any], Tuple[Dict[str, str], Dict[str, Any]]],
        logger: logging.Logger,
    ):
        self.is_docker = is_docker
        self.docker_port = docker_port
        self.container_name = container_name
        self.cache_container_dir = cache_container_dir
        self.alias_container_file = alias_container_file
        self.audio_subdir = Path("audio")
        self.cache_subdir = Path("audio") / "huggingface"
        self.alias_filename = "model_aliases.json"
        self.get_settings = get_settings
        self.get_docker_client = get_docker_client
        self.is_docker_mode = is_docker_mode
        self.stop_and_remove_container = stop_and_remove_container
        self.connect_extra_networks = connect_extra_networks
        self.get_gpu_container_options = get_gpu_container_options
        self.logger = logger

    def get_base_url(self) -> Optional[str]:
        configured = os.environ.get("SPEACHES_URL", "").strip()
        if configured:
            return configured.rstrip("/")
        if self.is_docker:
            return "http://speaches:8000"
        return None

    def get_status(self) -> Dict[str, Any]:
        base_url = self.get_base_url()
        host_port = int(os.environ.get("SPEACHES_PORT", str(self.docker_port)))
        accel_info = self.get_runtime_info()

        status = {
            "enabled": bool(base_url),
            "reachable": False,
            "base_url": base_url,
            "port": host_port,
            "health_url": f"{base_url}/health" if base_url else "",
            "api_base_url": f"http://127.0.0.1:{host_port}/v1",
            "details": None,
            "error": "",
            "accel": accel_info.get("accel"),
            "image": accel_info.get("image"),
        }

        if not base_url:
            status["error"] = "Speech service is not configured."
            return status

        try:
            response = requests.get(f"{base_url}/health", timeout=5)
            if response.status_code != 200:
                status["error"] = f"Health check returned HTTP {response.status_code}"
                return status
            try:
                payload = response.json()
            except Exception:
                payload = {"status": response.text.strip() or "OK"}
            try:
                models_response = requests.get(f"{base_url}/v1/models", timeout=5)
                if models_response.status_code == 200:
                    models_payload = models_response.json()
                    payload["model_count"] = len(models_payload.get("data") or [])
            except Exception:
                self.logger.debug("Failed to include speech model count in health payload.", exc_info=True)
            status["reachable"] = True
            status["details"] = payload
            return status
        except Exception as exc:
            status["error"] = str(exc)
            return status

    def require_base_url(self) -> str:
        base_url = self.get_base_url()
        if not base_url:
            raise HTTPException(status_code=503, detail="Speech service is not configured.")
        return base_url

    def request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
    ) -> Any:
        base_url = self.require_base_url()
        try:
            response = requests.request(
                method,
                f"{base_url}{path}",
                params=params,
                json=json_body,
                timeout=timeout,
            )
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"Speech service request failed: {exc}")

        if response.status_code >= 400:
            detail = response.text.strip() or f"Speech service returned HTTP {response.status_code}"
            raise HTTPException(status_code=response.status_code, detail=detail[:500])

        if not response.content:
            return {"ok": True, "status_code": response.status_code}

        try:
            return response.json()
        except Exception:
            text = response.text.strip()
            if text:
                return {"ok": True, "message": text, "status_code": response.status_code}
            raise HTTPException(status_code=502, detail="Speech service returned an empty non-JSON response.")

    def get_registry(self, task: str = "", search: str = "") -> Dict[str, Any]:
        payload = self.request_json("/v1/registry", timeout=60)
        models = payload.get("data") or []

        normalized_task = task.strip().lower()
        normalized_search = search.strip().lower()

        def matches(model: Dict[str, Any]) -> bool:
            model_task = str(model.get("task") or "").strip().lower()
            model_id = str(model.get("id") or "")
            if normalized_task and model_task != normalized_task:
                return False
            if normalized_search and normalized_search not in model_id.lower():
                return False
            return True

        filtered = [model for model in models if matches(model)]
        return {
            "data": filtered,
            "object": payload.get("object", "list"),
            "count": len(filtered),
            "available_tasks": sorted({str(model.get("task") or "") for model in models if model.get("task")}),
        }

    def get_installed_models(self) -> Dict[str, Any]:
        payload = self.request_json("/v1/models", timeout=30)
        return {
            "data": payload.get("data") or [],
            "object": payload.get("object", "list"),
            "count": len(payload.get("data") or []),
        }

    def get_voices(self, model: str = "") -> Dict[str, Any]:
        params = {"model": model} if model.strip() else None
        payload = self.request_json("/v1/audio/voices", params=params, timeout=30)
        if isinstance(payload, dict):
            return payload
        return {"voices": payload}

    def install_model(self, model_id: str) -> Dict[str, Any]:
        if not model_id.strip():
            raise HTTPException(status_code=400, detail="Model id is required.")
        return self.request_json(
            f"/v1/models/{quote(model_id.strip(), safe='')}",
            method="POST",
            timeout=600,
        )

    def get_runtime_info(self) -> Dict[str, Any]:
        settings = self.get_settings()
        desired = str(settings.get("speaches_accel") or os.environ.get("SPEACHES_ACCEL") or "cpu").strip().lower()
        if desired not in {"cpu", "cuda"}:
            desired = "cpu"

        info = {
            "desired": desired,
            "accel": desired,
            "image": "",
            "container_present": False,
        }

        client = self.get_docker_client()
        if client is None:
            return info

        try:
            container = client.containers.get(self.container_name)
        except Exception:
            return info

        image = (
            container.attrs.get("Config", {}).get("Image")
            or (container.image.tags[0] if container.image.tags else "")
        )
        accel = "cuda" if "cuda" in image.lower() else "cpu"
        info.update({
            "accel": accel,
            "image": image,
            "container_present": True,
        })
        return info

    def get_cache_host_dir(self) -> str:
        models_dir = (
            os.environ.get("IGNITE_MODELS_DIR")
            or os.environ.get("SWAPDECK_MODELS_DIR")
            or str(Path.cwd().parent / "models")
        )
        return str(Path(models_dir) / self.cache_subdir)

    def get_alias_host_file(self) -> str:
        models_dir = (
            os.environ.get("IGNITE_MODELS_DIR")
            or os.environ.get("SWAPDECK_MODELS_DIR")
            or str(Path.cwd().parent / "models")
        )
        return str(Path(models_dir) / self.audio_subdir / self.alias_filename)

    def get_alias_runtime_file(self) -> Path:
        docker_path = Path("/models") / self.audio_subdir / self.alias_filename
        if self.is_docker:
            return docker_path
        return Path(self.get_alias_host_file())

    def ensure_alias_file(self) -> None:
        candidate_files = [self.get_alias_runtime_file(), Path(self.get_alias_host_file())]
        for candidate in candidate_files:
            try:
                candidate.parent.mkdir(parents=True, exist_ok=True)
                if candidate.is_dir():
                    raise RuntimeError(f"{candidate} is a directory")
                if not candidate.exists():
                    candidate.write_text("{}\n", encoding="utf-8")
                return
            except Exception:
                continue

    def ensure_cache_dir(self) -> None:
        candidate_dirs = [Path("/models") / self.cache_subdir, Path(self.get_cache_host_dir())]
        for candidate in candidate_dirs:
            try:
                candidate.mkdir(parents=True, exist_ok=True)
                return
            except Exception:
                continue

    def get_cache_volumes(self) -> Dict[str, Dict[str, str]]:
        self.ensure_cache_dir()
        self.ensure_alias_file()
        return {
            self.get_cache_host_dir(): {
                "bind": self.cache_container_dir,
                "mode": "rw",
            },
            self.get_alias_host_file(): {
                "bind": self.alias_container_file,
                "mode": "rw",
            },
        }

    def read_aliases(self) -> Dict[str, str]:
        self.ensure_alias_file()
        alias_file = self.get_alias_runtime_file()
        try:
            raw = alias_file.read_text(encoding="utf-8").strip()
            data = json.loads(raw or "{}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read speech aliases: {exc}")

        if not isinstance(data, dict):
            raise HTTPException(status_code=500, detail="Speech alias file must contain a JSON object.")

        aliases: Dict[str, str] = {}
        for key, value in data.items():
            alias = str(key).strip()
            target = str(value).strip()
            if alias and target:
                aliases[alias] = target
        return aliases

    def write_aliases(self, aliases: Dict[str, str]) -> Dict[str, Any]:
        normalized: Dict[str, str] = {}
        for key, value in (aliases or {}).items():
            alias = str(key).strip()
            target = str(value).strip()
            if not alias and not target:
                continue
            if not alias or not target:
                raise HTTPException(status_code=400, detail="Speech aliases require both alias and target model.")
            normalized[alias] = target

        self.ensure_alias_file()
        alias_file = self.get_alias_runtime_file()
        try:
            alias_file.write_text(json.dumps(normalized, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to write speech aliases: {exc}")

        settings = self.get_settings()
        accel = str(settings.get("speaches_accel") or os.environ.get("SPEACHES_ACCEL") or "cpu").strip().lower()
        if accel not in {"cpu", "cuda"}:
            accel = "cpu"
        if self.is_docker_mode():
            self.recreate_container(accel)

        return {
            "aliases": normalized,
            "file": str(alias_file),
            "restarted": self.is_docker_mode(),
        }

    def recreate_container(self, accel: str) -> Dict[str, Any]:
        if accel not in {"cpu", "cuda"}:
            raise HTTPException(status_code=400, detail="Speech acceleration must be 'cpu' or 'cuda'.")

        client = self.get_docker_client()
        if client is None:
            raise HTTPException(status_code=503, detail="Docker runtime control is not available.")

        image = f"ghcr.io/speaches-ai/speaches:latest-{accel}"

        try:
            client.images.pull(image)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to pull speech image {image}: {exc}")

        try:
            existing = client.containers.get(self.container_name)
        except Exception:
            existing = None

        network_names: List[str] = []
        ports: Dict[str, Any] = {"8000/tcp": int(os.environ.get("SPEACHES_PORT", str(self.docker_port)))}
        volumes = self.get_cache_volumes()
        restart_policy = {"Name": "no"}

        if existing is not None:
            attrs = existing.attrs
            network_names = list((attrs.get("NetworkSettings", {}) or {}).get("Networks", {}).keys())
            restart_policy = (attrs.get("HostConfig", {}) or {}).get("RestartPolicy") or {"Name": "no"}

            port_bindings = (attrs.get("HostConfig", {}) or {}).get("PortBindings") or {}
            if port_bindings:
                normalized_ports: Dict[str, Any] = {}
                for container_port, bindings in port_bindings.items():
                    if not bindings:
                        continue
                    binding = bindings[0]
                    host_ip = binding.get("HostIp") or "0.0.0.0"
                    host_port = int(binding.get("HostPort") or os.environ.get("SPEACHES_PORT", str(self.docker_port)))
                    normalized_ports[container_port] = host_port if host_ip in {"0.0.0.0", ""} else (host_ip, host_port)
                if normalized_ports:
                    ports = normalized_ports

            self.stop_and_remove_container(
                existing,
                stop_timeout=15,
                stop_message="Ignoring failure while stopping existing speech container before recreate.",
                remove_error="Failed to remove existing speech container",
            )

        if not network_names:
            try:
                network_names = [network.name for network in client.networks.list(names=["ignite_default"])]
            except Exception:
                network_names = []

        environment = {}
        gpu_kwargs: Dict[str, Any] = {}
        if accel == "cuda":
            environment, gpu_kwargs = self.get_gpu_container_options(client)

        primary_network = network_names[0] if network_names else None

        try:
            container = client.containers.run(
                image,
                name=self.container_name,
                detach=True,
                ports=ports,
                volumes=volumes,
                environment=environment,
                restart_policy=restart_policy,
                network=primary_network,
                **gpu_kwargs,
            )
            self.connect_extra_networks(
                client,
                container,
                network_names,
                "Ignoring failure while connecting speech container to extra Docker network.",
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to start speech container: {exc}")

        return {
            "ok": True,
            "accel": accel,
            "image": image,
        }

    def synthesize(self, model: str, text: str, voice: str = "") -> Tuple[bytes, str]:
        payload: Dict[str, Any] = {
            "model": model,
            "input": text,
        }
        if voice:
            payload["voice"] = voice

        try:
            response = requests.post(
                f"{self.require_base_url()}/v1/audio/speech",
                json=payload,
                timeout=120,
            )
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"Speech synthesis request failed: {exc}")

        if response.status_code >= 400:
            detail = response.text.strip() or f"Speech service returned HTTP {response.status_code}"
            raise HTTPException(status_code=response.status_code, detail=detail[:500])

        return response.content, response.headers.get("content-type", "audio/mpeg")

    async def transcribe(self, model: str, file: UploadFile) -> Any:
        try:
            file_bytes = await file.read()
            response = requests.post(
                f"{self.require_base_url()}/v1/audio/transcriptions",
                data={"model": model},
                files={"file": (file.filename or "audio.wav", file_bytes, file.content_type or "application/octet-stream")},
                timeout=300,
            )
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"Speech transcription request failed: {exc}")

        if response.status_code >= 400:
            detail = response.text.strip() or f"Speech service returned HTTP {response.status_code}"
            raise HTTPException(status_code=response.status_code, detail=detail[:500])

        try:
            return response.json()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Speech service returned invalid JSON: {exc}")
