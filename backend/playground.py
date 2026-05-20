import time
from typing import Any, Callable, Dict

import requests
from fastapi import HTTPException


class PlaygroundService:
    def __init__(
        self,
        *,
        get_base_url: Callable[[], str],
        get_model_mode: Callable[[str], str],
    ):
        self.get_base_url = get_base_url
        self.get_model_mode = get_model_mode

    def test_prompt(self, prompt: Any) -> Dict[str, Any]:
        try:
            request_mode = self.get_model_mode(prompt.model)
            endpoint = "/v1/chat/completions"
            image_data_url = (prompt.image_data_url or "").strip()
            generation_settings = self._generation_settings(prompt)

            if request_mode == "completion":
                if image_data_url:
                    raise HTTPException(status_code=400, detail="Completion models do not support image input in Test.")
                endpoint = "/v1/completions"
                payload = {
                    "prompt": prompt.prompt,
                    **generation_settings,
                }
            else:
                payload = {
                    "messages": [{"role": "user", "content": self._chat_user_content(prompt.prompt, image_data_url)}],
                    **generation_settings,
                }

            if prompt.model:
                payload["model"] = prompt.model

            start = time.time()
            response = requests.post(
                f"{self.get_base_url()}{endpoint}",
                json=payload,
                timeout=120,
            )
            duration_ms = int((time.time() - start) * 1000)

            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)

            return self._format_response(
                response.json(),
                prompt.model,
                request_mode,
                generation_settings,
                duration_ms,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Request failed: {exc}")

    def _generation_settings(self, prompt: Any) -> Dict[str, Any]:
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
        return generation_settings

    def _chat_user_content(self, prompt_text: str, image_data_url: str) -> Any:
        if not image_data_url:
            return prompt_text

        user_content = []
        if prompt_text.strip():
            user_content.append({"type": "text", "text": prompt_text})
        user_content.append({"type": "image_url", "image_url": {"url": image_data_url}})
        return user_content

    def _format_response(
        self,
        result: Dict[str, Any],
        requested_model: str,
        request_mode: str,
        generation_settings: Dict[str, Any],
        duration_ms: int,
    ) -> Dict[str, Any]:
        choice = result.get("choices", [{}])[0]
        if request_mode == "completion":
            content = choice.get("text", "")
            reasoning = ""
        else:
            message = choice.get("message", {})
            content = message.get("content", "")
            reasoning = message.get("reasoning_content", "")
        usage = result.get("usage", {})

        return {
            "response": content,
            "reasoning": reasoning,
            "tokens": usage.get("completion_tokens", 0),
            "duration_ms": duration_ms,
            "model": result.get("model", requested_model),
            "usage": usage,
            "timings": result.get("timings", {}),
            "id": result.get("id"),
            "object": result.get("object"),
            "created": result.get("created"),
            "system_fingerprint": result.get("system_fingerprint"),
            "finish_reason": choice.get("finish_reason"),
            "request_mode": request_mode,
            "request_settings": generation_settings,
        }
