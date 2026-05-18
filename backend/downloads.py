import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import unquote, urlparse

import requests
from fastapi import HTTPException


@dataclass
class DownloadTask:
    url: str
    filename: str
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    progress: float = 0.0
    status: str = "pending"
    error: Optional[str] = None
    total_bytes: int = 0
    downloaded_bytes: int = 0
    speed_bytes_per_sec: float = 0.0
    started_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None
    stop_requested: bool = False
    worker: Optional[threading.Thread] = field(default=None, repr=False, compare=False)


class ModelDownloadManager:
    def __init__(self, get_directory: Callable[[], str], logger):
        self.get_directory = get_directory
        self.logger = logger
        self.active_downloads: Dict[str, DownloadTask] = {}
        self.lock = threading.Lock()

    def infer_filename_from_url(self, url: str) -> str:
        parsed = urlparse(str(url or ""))
        name = Path(unquote(parsed.path)).name
        if name and name.lower().endswith(".gguf"):
            return name
        return ""

    def sanitize_model_filename(self, filename: str, url: str = "") -> str:
        raw = str(filename or "").strip() or self.infer_filename_from_url(url)
        name = Path(raw).name
        if not name:
            raise HTTPException(status_code=400, detail="Filename is required.")
        if "/" in name or "\\" in name or name in {".", ".."}:
            raise HTTPException(status_code=400, detail="Filename must not contain path separators.")
        if not name.lower().endswith(".gguf"):
            inferred = self.infer_filename_from_url(url)
            if inferred:
                name = inferred
            else:
                raise HTTPException(status_code=400, detail="Model filename must end with .gguf.")
        return name

    def model_download_paths(self, filename: str) -> tuple[Path, Path]:
        gguf_path = Path(os.path.expanduser(self.get_directory()))
        gguf_path.mkdir(parents=True, exist_ok=True)
        final_path = gguf_path / filename
        part_path = gguf_path / f"{filename}.part"
        return final_path, part_path

    def chown_like_parent(self, path: Path) -> None:
        try:
            parent_stat = path.parent.stat()
            os.chown(path, parent_stat.st_uid, parent_stat.st_gid)
        except Exception:
            self.logger.debug("Unable to match downloaded model ownership to parent directory.", exc_info=True)

    def serialize_task(self, task: DownloadTask) -> Dict[str, Any]:
        return {
            "task_id": task.task_id,
            "url": task.url,
            "filename": task.filename,
            "progress": round(task.progress, 2),
            "status": task.status,
            "error": task.error,
            "total_bytes": task.total_bytes,
            "downloaded_bytes": task.downloaded_bytes,
            "speed_bytes_per_sec": round(task.speed_bytes_per_sec, 2),
            "started_at": task.started_at,
            "updated_at": task.updated_at,
            "completed_at": task.completed_at,
        }

    def list_tasks(self) -> list[Dict[str, Any]]:
        with self.lock:
            tasks = list(self.active_downloads.values())
        return [self.serialize_task(task) for task in tasks]

    def get_task_payload(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            task = self.active_downloads.get(task_id)
            return self.serialize_task(task) if task else None

    def run_download(self, task_id: str) -> None:
        with self.lock:
            task = self.active_downloads.get(task_id)
        if task is None:
            return

        final_path, part_path = self.model_download_paths(task.filename)
        resume_from = part_path.stat().st_size if part_path.exists() else 0
        headers = {"Range": f"bytes={resume_from}-"} if resume_from else {}
        last_tick = time.time()
        last_bytes = resume_from

        try:
            with self.lock:
                task.status = "downloading"
                task.stop_requested = False
                task.error = None
                task.downloaded_bytes = resume_from
                task.updated_at = datetime.now().isoformat()

            response = requests.get(task.url, headers=headers, stream=True, timeout=(20, 60))
            response.raise_for_status()

            if response.status_code == 206 and resume_from:
                content_range = response.headers.get("content-range", "")
                total_size = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range and content_range.rsplit("/", 1)[-1].isdigit() else 0
            else:
                if resume_from and response.status_code == 200:
                    resume_from = 0
                    part_path.unlink(missing_ok=True)
                total_size = int(response.headers.get("content-length", 0) or 0) + resume_from

            with self.lock:
                task.total_bytes = total_size
                task.downloaded_bytes = resume_from
                task.progress = (resume_from / total_size) * 100 if total_size else 0

            with open(part_path, "ab" if resume_from else "wb") as handle:
                self.chown_like_parent(part_path)
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    with self.lock:
                        should_stop = task.stop_requested
                    if should_stop:
                        with self.lock:
                            task.status = "paused"
                            task.updated_at = datetime.now().isoformat()
                        return
                    if not chunk:
                        continue
                    handle.write(chunk)
                    downloaded = handle.tell()
                    now = time.time()
                    if now - last_tick >= 0.5:
                        with self.lock:
                            task.downloaded_bytes = downloaded
                            task.progress = (downloaded / total_size) * 100 if total_size else task.progress
                            task.speed_bytes_per_sec = (downloaded - last_bytes) / max(now - last_tick, 0.001)
                            task.updated_at = datetime.now().isoformat()
                        last_tick = now
                        last_bytes = downloaded

            part_path.replace(final_path)
            self.chown_like_parent(final_path)
            with self.lock:
                task.downloaded_bytes = final_path.stat().st_size
                task.total_bytes = task.total_bytes or task.downloaded_bytes
                task.progress = 100
                task.status = "completed"
                task.completed_at = datetime.now().isoformat()
                task.updated_at = task.completed_at
                task.speed_bytes_per_sec = 0

        except Exception as exc:
            with self.lock:
                task.status = "error"
                task.error = str(exc)
                task.updated_at = datetime.now().isoformat()

    def start_worker(self, task: DownloadTask) -> None:
        worker = threading.Thread(target=self.run_download, args=(task.task_id,), daemon=True)
        task.worker = worker
        worker.start()

    def download_model(self, url: str, filename: str) -> str:
        final_filename = self.sanitize_model_filename(filename, url)
        final_path, _ = self.model_download_paths(final_filename)
        if final_path.exists():
            raise HTTPException(status_code=409, detail=f"Model already exists: {final_filename}")

        task = DownloadTask(url=str(url), filename=final_filename, status="queued")
        with self.lock:
            self.active_downloads[task.task_id] = task
        self.start_worker(task)
        return task.task_id

    def pause(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = self.active_downloads.get(task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="Download task not found")
            if task.status not in {"queued", "downloading"}:
                return self.serialize_task(task)
            task.stop_requested = True
            task.updated_at = datetime.now().isoformat()
            return self.serialize_task(task)

    def resume(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = self.active_downloads.get(task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="Download task not found")
            if task.status == "downloading":
                return self.serialize_task(task)
            if task.status == "completed":
                return self.serialize_task(task)
            task.stop_requested = False
            task.status = "queued"
            task.updated_at = datetime.now().isoformat()
            payload = self.serialize_task(task)
        self.start_worker(task)
        return payload

    def remove(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = self.active_downloads.get(task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="Download task not found")
            task.stop_requested = True
            self.active_downloads.pop(task_id, None)

        _, part_path = self.model_download_paths(task.filename)
        try:
            part_path.unlink(missing_ok=True)
        except Exception:
            self.logger.debug("Unable to remove partial model download file.", exc_info=True)
        return {"removed": task_id}
