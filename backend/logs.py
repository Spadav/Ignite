import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

import docker
import requests
from fastapi import HTTPException
from fastapi.responses import StreamingResponse


class LogService:
    def __init__(
        self,
        log_file: str,
        get_base_url: Callable[[], str],
        is_docker_mode: Callable[[], bool],
        get_docker_client: Callable[[], Optional[docker.DockerClient]],
        get_container_map: Callable[[], Dict[str, str]],
        logger: logging.Logger,
    ):
        self.log_file = log_file
        self.get_base_url = get_base_url
        self.is_docker_mode = is_docker_mode
        self.get_docker_client = get_docker_client
        self.get_container_map = get_container_map
        self.logger = logger

    def get_recent_logs(self, lines: int = 100) -> List[str]:
        try:
            if os.path.exists(self.log_file):
                with open(self.log_file, "r") as handle:
                    all_lines = handle.readlines()
                    return [line.rstrip() for line in all_lines[-lines:]]
            return []
        except Exception:
            self.logger.debug("Failed to read recent llama-swap logs", exc_info=True)
            return []

    def get_upstream_logs(self, lines: int = 100) -> List[str]:
        all_logs = self.get_recent_logs(lines=lines * 6)
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

    def get_docker_container_logs(self, stream_name: str, lines: int = 200) -> List[str]:
        if not self.is_docker_mode():
            raise HTTPException(status_code=400, detail="Docker container logs are only available in Docker mode")

        client = self.get_docker_client()
        if client is None:
            raise HTTPException(
                status_code=503,
                detail="Docker log access is unavailable. Mount /var/run/docker.sock into the Ignite container.",
            )

        container_name = self.get_container_map().get(stream_name)
        if not container_name:
            raise HTTPException(status_code=404, detail=f"Unknown Docker log stream: {stream_name}")

        try:
            container = client.containers.get(container_name)
            raw_logs = container.logs(stdout=True, stderr=True, tail=lines)
            text = raw_logs.decode("utf-8", errors="replace")
            return [line.rstrip() for line in text.splitlines() if line.strip()]
        except docker.errors.NotFound:
            raise HTTPException(status_code=404, detail=f"Docker container '{container_name}' was not found")

    def get_llama_swap_events(self, lines: int = 100) -> List[str]:
        base_url = self.get_base_url()
        try:
            with requests.get(f"{base_url}/api/events", stream=True, timeout=(0.5, 0.5)) as response:
                if response.status_code != 200:
                    return []

                content_type = response.headers.get("content-type", "").lower()
                if "application/json" in content_type:
                    payload = response.json()
                    if isinstance(payload, list):
                        return [str(item) for item in payload[-lines:]]
                    return [json.dumps(payload)]

                raw_lines: List[str] = []
                for raw_line in response.iter_lines(decode_unicode=True):
                    if raw_line is None:
                        continue
                    line = raw_line.strip()
                    if not line:
                        continue
                    raw_lines.append(line)
                    if len(raw_lines) >= lines:
                        break

                return raw_lines[-lines:]
        except Exception:
            self.logger.debug("Failed to read llama-swap events", exc_info=True)
            return []

    def get_event_logs(self, lines: int = 100) -> List[str]:
        events = self.get_llama_swap_events(lines)
        if events:
            return events
        return self.get_upstream_logs(lines)

    def stream_logs(self, stream_type: str) -> StreamingResponse:
        if stream_type not in {"proxy", "upstream"}:
            raise HTTPException(status_code=404, detail="Unknown stream type")

        target_url = f"{self.get_base_url()}/logs/stream/{stream_type}"

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
                        yield f"data: {line}\n\n"
            except Exception as exc:
                yield f"data: [error] Failed to read {stream_type} stream: {exc}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
