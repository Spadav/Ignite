import os
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List

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
