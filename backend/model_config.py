import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException


class ModelConfigService:
    def __init__(
        self,
        *,
        get_config: Callable[[], Dict[str, Any]],
        save_config: Callable[[Dict[str, Any]], Dict[str, Any]],
        get_gguf_directory: Callable[[], str],
        get_hardware_profile: Callable[[], Dict[str, Any]],
        infer_request_mode: Callable[..., str],
        is_docker_mode: Callable[[], bool],
    ):
        self.get_config = get_config
        self.save_config = save_config
        self.get_gguf_directory = get_gguf_directory
        self.get_hardware_profile = get_hardware_profile
        self.infer_request_mode = infer_request_mode
        self.is_docker_mode = is_docker_mode

    def sanitize_model_id(self, value: str) -> str:
        sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
        return sanitized or f"Model-{int(datetime.now().timestamp())}"

    def get_model_file_info(self, filename: str) -> Dict[str, Any]:
        model_path = Path(os.path.expanduser(self.get_gguf_directory())) / filename
        if not model_path.exists():
            raise HTTPException(status_code=404, detail="Model file not found")

        size_gib = round(model_path.stat().st_size / (1024 ** 3), 2)
        family = self.infer_request_mode(filename)

        return {
            "filename": filename,
            "size_gib": size_gib,
            "family": family,
        }

    def build_launch_presets(self, filename: str) -> List[Dict[str, Any]]:
        info = self.get_model_file_info(filename)
        hardware = self.get_hardware_profile()
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

    def resolve_launch_preset(self, filename: str, preset_id: Optional[str]) -> Dict[str, Any]:
        if preset_id == "custom":
            family = self.get_model_file_info(filename)["family"]
            return {
                "id": "custom",
                "name": "Custom",
                "summary": "Minimal starter config for manual editing.",
                "why_use": "Use this if you want full control over the llama.cpp flags yourself.",
                "why_not": "Ignite will not choose context, KV cache, offload, or performance flags for you.",
                "context": 0,
                "gpu_layers": 0,
                "flash_attention": False,
                "kv_cache": None,
                "batch": 0,
                "ubatch": 0,
                "template_mode": family,
            }
        presets = self.build_launch_presets(filename)
        if not preset_id:
            return next((preset for preset in presets if preset["id"] == "balanced"), presets[0])
        for preset in presets:
            if preset["id"] == preset_id:
                return preset
        raise HTTPException(status_code=400, detail=f"Unknown preset: {preset_id}")

    def build_generated_model_entry(
        self,
        filename: str,
        display_name: Optional[str] = None,
        preset_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        preset = self.resolve_launch_preset(filename, preset_id)
        model_path = f"/models/{filename}" if self.is_docker_mode() else str(
            Path(os.path.expanduser(self.get_gguf_directory())) / filename
        )
        command_parts = [
            "/app/llama-server" if self.is_docker_mode() else "llama-server",
            f"-m {model_path}",
            "--host 0.0.0.0" if self.is_docker_mode() else "--host 127.0.0.1",
            "--port ${PORT}",
        ]

        if preset["id"] != "custom":
            command_parts.extend([
                f"-ngl {preset['gpu_layers']}",
                "-fa on" if preset["flash_attention"] else "-fa off",
                f"-c {preset['context']}",
                f"-b {preset['batch']}",
                f"-ub {preset['ubatch']}",
            ])
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

    def get_configured_model_mode(self, model_id: str) -> str:
        if not model_id:
            return "chat"

        try:
            config = self.get_config()
        except Exception:
            return "chat"

        model_entry = (config.get("models") or {}).get(model_id) or {}
        metadata = model_entry.get("metadata") or {}
        explicit_mode = str(metadata.get("igniteRequestMode") or metadata.get("igniteTemplateMode") or "").strip().lower()
        if explicit_mode in {"chat", "completion"}:
            return explicit_mode

        return self.infer_request_mode(
            model_id,
            model_entry.get("name"),
            model_entry.get("useModelName"),
            model_entry.get("cmd"),
            " ".join(model_entry.get("aliases") or []),
        )

    def get_config_summary(self) -> Dict[str, Any]:
        try:
            config = self.get_config()
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

        default_model_mode = self.get_configured_model_mode(default_model_id) if default_model_id else "chat"

        return {
            "configured_model_count": len(model_ids),
            "configured_model_ids": model_ids,
            "default_model_id": default_model_id,
            "default_model_mode": default_model_mode,
        }

    def add_model_to_config(
        self,
        filename: str,
        model_id: Optional[str] = None,
        display_name: Optional[str] = None,
        preset_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        model_path = Path(os.path.expanduser(self.get_gguf_directory())) / filename
        if not model_path.exists():
            raise HTTPException(status_code=404, detail="Model file not found")

        config = self.get_config()
        models = config.setdefault("models", {})

        base_model_id = self.sanitize_model_id(model_id or Path(filename).stem)
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

        chosen_preset = self.resolve_launch_preset(filename, preset_id)
        models[final_model_id] = self.build_generated_model_entry(filename, display_name, chosen_preset["id"])

        health_check = config.get("healthCheck")
        if not isinstance(health_check, dict) or not health_check.get("model") or health_check.get("model") == "ExampleModel":
            config["healthCheck"] = {"model": final_model_id}

        config.setdefault("globalTTL", 0)
        config.setdefault("startPort", 5800)
        self.save_config(config)

        return {
            "saved": True,
            "model_id": final_model_id,
            "display_name": models[final_model_id]["name"],
            "preset_id": chosen_preset["id"],
        }
