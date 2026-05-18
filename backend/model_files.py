import os
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List
from urllib.parse import quote

import requests
from fastapi import HTTPException


class ModelFileService:
    def __init__(self, get_directory: Callable[[], str], logger):
        self.get_directory = get_directory
        self.logger = logger

    def model_dir(self) -> Path:
        return Path(os.path.expanduser(self.get_directory()))

    def list_gguf_files(self) -> List[Dict[str, Any]]:
        models = []
        gguf_path = self.model_dir()

        if not gguf_path.exists():
            return models

        for file_path in gguf_path.glob("*.gguf"):
            try:
                stat = file_path.stat()
                models.append({
                    "filename": file_path.name,
                    "size_bytes": stat.st_size,
                    "size_gb": round(stat.st_size / (1024 ** 3), 2),
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
            except Exception:
                self.logger.debug("Unable to read GGUF model file metadata.", exc_info=True)

        return models

    def list_hf_gguf_files(self, repo_id: str) -> List[Dict[str, Any]]:
        hf_token = os.environ.get("HF_TOKEN")
        request_url = f"https://huggingface.co/api/models/{repo_id}"
        request_params = [("expand[]", "siblings")]

        def fetch_model_info(use_auth: bool) -> requests.Response:
            headers = {}
            if use_auth and hf_token:
                headers["Authorization"] = f"Bearer {hf_token}"
            return requests.get(
                request_url,
                params=request_params,
                headers=headers,
                timeout=20,
            )

        response = fetch_model_info(use_auth=bool(hf_token))
        if hf_token and response.status_code in {401, 403}:
            self.logger.warning("HF_TOKEN was rejected for repo %s; retrying anonymously", repo_id)
            response = fetch_model_info(use_auth=False)

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

    def delete_model(self, filename: str) -> Dict[str, Any]:
        file_path = self.model_dir() / filename
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Model file not found")

        file_path.unlink()
        return {"deleted": filename}

    def rename_model(self, old_name: str, new_name: str) -> Dict[str, Any]:
        old_path = self.model_dir() / old_name
        new_path = self.model_dir() / new_name

        if not old_path.exists():
            raise HTTPException(status_code=404, detail="Model file not found")

        if new_path.exists():
            raise HTTPException(status_code=409, detail="Target filename already exists")

        old_path.rename(new_path)
        return {"renamed": {"from": old_name, "to": new_name}}
