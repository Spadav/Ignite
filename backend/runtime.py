import json
import logging
from typing import Any, Callable, Dict, Iterable, List
from urllib.parse import quote

import requests
from fastapi import HTTPException


class LlamaSwapRuntimeService:
    def __init__(self, get_base_url: Callable[[], str], logger: logging.Logger):
        self.get_base_url = get_base_url
        self.logger = logger

    def get_model_status(self) -> List[Dict[str, Any]]:
        for payload_type, payload in self._event_payloads(timeout=(1.0, 1.5)):
            if payload_type == "modelStatus" and isinstance(payload, list):
                return self._normalize_models(payload)
        return []

    def get_runtime_overview(self) -> Dict[str, Any]:
        overview: Dict[str, Any] = {"models": [], "metrics": [], "inflight_total": 0}

        for payload_type, payload in self._event_payloads(timeout=(1.0, 2.0)):
            self._apply_overview_payload(overview, payload_type, payload)
            if overview["models"] and overview["metrics"]:
                break

        return overview

    def get_capture(self, capture_id: int) -> Any:
        try:
            response = requests.get(f"{self.get_base_url()}/api/captures/{capture_id}", timeout=15)
            if response.status_code == 404:
                raise HTTPException(status_code=404, detail="Capture not found")
            if not response.ok:
                raise HTTPException(status_code=response.status_code, detail=f"Failed to fetch capture: {response.text[:300]}")
            return response.json()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to fetch capture: {exc}")

    def load_model(self, model_id: str) -> Dict[str, Any]:
        if not model_id:
            raise HTTPException(status_code=400, detail="Model ID is required")

        try:
            response = requests.get(f"{self.get_base_url()}/upstream/{quote(model_id)}/", timeout=60)
            if not response.ok:
                raise HTTPException(status_code=response.status_code, detail=f"Failed to load model: {response.text[:300]}")
            return {"ok": True, "model_id": model_id, "action": "load"}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to load model: {exc}")

    def unload_model(self, model_id: str) -> Dict[str, Any]:
        if not model_id:
            raise HTTPException(status_code=400, detail="Model ID is required")

        try:
            response = requests.post(f"{self.get_base_url()}/api/models/unload/{quote(model_id)}", timeout=15)
            if not response.ok:
                raise HTTPException(status_code=response.status_code, detail=f"Failed to unload model: {response.text[:300]}")
            return {"ok": True, "model_id": model_id, "action": "unload"}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to unload model: {exc}")

    def unload_all(self) -> Dict[str, Any]:
        try:
            response = requests.post(f"{self.get_base_url()}/api/models/unload", timeout=15)
            if not response.ok:
                raise HTTPException(status_code=response.status_code, detail=f"Failed to unload all models: {response.text[:300]}")
            return {"ok": True, "action": "unload_all"}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to unload all models: {exc}")

    def _event_payloads(self, timeout: tuple[float, float]) -> Iterable[tuple[str, Any]]:
        for data_lines in self._event_data_blocks(timeout):
            yield from self._decode_buffer(data_lines)

    def _event_data_blocks(self, timeout: tuple[float, float]) -> Iterable[List[str]]:
        try:
            with requests.get(f"{self.get_base_url()}/api/events", stream=True, timeout=timeout) as response:
                if response.status_code != 200:
                    return

                yield from self._split_event_data(response.iter_lines(decode_unicode=True))
        except Exception:
            self.logger.debug("Failed to read llama-swap runtime events.", exc_info=True)

    def _split_event_data(self, raw_lines: Iterable[str | None]) -> Iterable[List[str]]:
        data_lines: List[str] = []
        for raw_line in raw_lines:
            line = (raw_line or "").strip()
            if not line:
                if data_lines:
                    yield data_lines
                    data_lines = []
                continue
            if line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())

    def _decode_buffer(self, data_lines: List[str]) -> Iterable[tuple[str, Any]]:
        if not data_lines:
            return

        try:
            envelope = json.loads("\n".join(data_lines))
            if not isinstance(envelope, dict):
                return
            payload_type = str(envelope.get("type") or "")
            payload = envelope.get("data")
            if isinstance(payload, str):
                payload = json.loads(payload)
            yield payload_type, payload
        except Exception:
            self.logger.debug("Ignoring malformed llama-swap runtime event payload.", exc_info=True)

    def _normalize_models(self, payload: List[Any]) -> List[Dict[str, Any]]:
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

    def _apply_overview_payload(self, overview: Dict[str, Any], payload_type: str, payload: Any) -> None:
        if payload_type == "modelStatus" and isinstance(payload, list):
            overview["models"] = self._normalize_models(payload)
        elif payload_type == "metrics" and isinstance(payload, list):
            overview["metrics"] = [self._normalize_metric(item) for item in payload if isinstance(item, dict)]
        elif payload_type == "inflight" and isinstance(payload, dict):
            overview["inflight_total"] = int(payload.get("total") or 0)

    def _normalize_metric(self, item: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(item)
        tokens = item.get("tokens")
        if isinstance(tokens, dict):
            normalized["cache_tokens"] = tokens.get("cache_tokens", normalized.get("cache_tokens", -1))
            normalized["input_tokens"] = tokens.get("input_tokens", normalized.get("input_tokens", 0))
            normalized["output_tokens"] = tokens.get("output_tokens", normalized.get("output_tokens", 0))
            normalized["prompt_per_second"] = tokens.get("prompt_per_second", normalized.get("prompt_per_second", 0))
            normalized["tokens_per_second"] = tokens.get("tokens_per_second", normalized.get("tokens_per_second", 0))
        return normalized
