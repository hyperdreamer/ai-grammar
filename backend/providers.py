"""AI provider call logic — prompts, HTTP calls, and response parsing."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from typing import Any, Protocol, TypedDict

import httpx
from fastapi import HTTPException

from .config import AIConfig, _debug, _load_debug, DEFAULT_TEMPERATURE_CHECK

GRAMMAR_SYSTEM_PROMPT = """You are a grammar checker. Find issues in the text. Return ONLY a JSON array of objects with these fields:
- "start": int, 0-indexed character offset
- "end": int, 0-indexed character offset (exclusive)
- "error": string, original text
- "correction": string, fix
- "explanation": string, short reason (max 80 chars)
- "type": "error"|"improvement"|"idiom"

Types: error=spelling/grammar, improvement=clarity/conciseness, idiom=natural phrasing.
Offsets must be exact. Include spaces/newlines in count. Return [] if no issues. No markdown."""

POLISH_SYSTEM_PROMPT = """You are a text polisher. Improve the given text to be more natural, eloquent, and clear while preserving the exact meaning. Fix grammar, spelling, wordiness, and awkward phrasing. Return ONLY a JSON object with a single field:
- "polished": string, the improved version

Keep the tone and intent identical — only improve the quality of expression. No markdown, no extra text."""

TRANSLATE_SYSTEM_PROMPT = """You are a translator. Translate the given text into the target language. Return ONLY a JSON object with a single field:
- "translated": string, the translated text

Preserve the tone, intent, and formatting of the original. Do not add explanations, notes, or commentary. No markdown, no extra text."""


from .models import ErrorItem


# ---------------------------------------------------------------------------
# Provider protocol contracts
# ---------------------------------------------------------------------------


class ProviderRequest(TypedDict):
    """A fully-resolved HTTP request for one provider protocol call."""

    url: str
    headers: dict[str, str]
    body: dict[str, Any]


class ProviderResult(TypedDict):
    """The normalized result of one provider protocol call."""

    content: str
    tokens: int
    model: str


class ProviderResponseError(Exception):
    """A provider envelope was malformed, incomplete, or unusable.

    Adapters raise this instead of leaking ``KeyError``/``IndexError``/``TypeError``
    from envelope inspection, so callers can map one error class to HTTP 502.
    """


class ProtocolAdapter(Protocol):
    """A provider wire protocol: request construction and response parsing."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str,
        user_text: str,
        temperature: float,
        max_tokens: int | None,
    ) -> ProviderRequest: ...

    def parse_response(
        self, payload: object, *, configured_model: str
    ) -> ProviderResult: ...


# Sentinel distinguishing an absent key from a present ``None`` value.
_ABSENT = object()


def _require_non_negative_int(value: object, field: str) -> int:
    """Return *value* if it is a genuine non-negative integer, else raise.

    ``type(value) is int`` deliberately rejects ``bool`` (a subclass of ``int``),
    and floats such as ``1.0`` are rejected because they are not integers.
    """
    if type(value) is not int or value < 0:
        raise ProviderResponseError(
            f"provider response field {field} must be a non-negative integer, "
            f"got {value!r}"
        )
    return value


def _require_model(payload: Mapping[str, Any], configured_model: str) -> str:
    """Return the envelope's model, falling back only when the key is absent."""
    raw_model = payload.get("model", _ABSENT)
    if raw_model is _ABSENT:
        return configured_model
    if not isinstance(raw_model, str):
        raise ProviderResponseError(
            f"provider response field model must be a string, got {raw_model!r}"
        )
    return raw_model


def _require_usage_tokens(payload: Mapping[str, Any]) -> int:
    """Validate the Chat Completions usage envelope and return its token count.

    An absent ``usage`` or ``total_tokens`` yields ``0``. Every token-count field
    that is present is validated, even when ``total_tokens`` decides the result.
    """
    usage = payload.get("usage", _ABSENT)
    if usage is _ABSENT:
        return 0
    if not isinstance(usage, Mapping):
        raise ProviderResponseError(
            f"provider response field usage must be an object, got {usage!r}"
        )
    for field in ("total_tokens", "prompt_tokens", "completion_tokens"):
        if field in usage:
            _require_non_negative_int(usage[field], f"usage.{field}")
    return usage.get("total_tokens", 0)


def _require_responses_usage_tokens(payload: Mapping[str, Any]) -> int:
    """Validate the Responses usage envelope and return its token count.

    Unlike Chat Completions, an absent *or null* ``usage`` normalizes to ``0``.
    ``total_tokens`` decides the result when it is present and non-null, but every
    present non-null component is validated regardless; when ``total_tokens`` is
    absent or null the validated ``input_tokens``/``output_tokens`` sum is used.
    """
    usage = payload.get("usage", _ABSENT)
    if usage is _ABSENT or usage is None:
        return 0
    if not isinstance(usage, Mapping):
        raise ProviderResponseError(
            f"provider response field usage must be an object, got {usage!r}"
        )

    component_sum = 0
    for field in ("input_tokens", "output_tokens"):
        value = usage.get(field, _ABSENT)
        if value is _ABSENT or value is None:
            continue
        component_sum += _require_non_negative_int(value, f"usage.{field}")

    total = usage.get("total_tokens", _ABSENT)
    if total is _ABSENT or total is None:
        return component_sum
    return _require_non_negative_int(total, "usage.total_tokens")


def _responses_output_text(payload: Mapping[str, Any]) -> str:
    """Concatenate the usable ``output_text`` parts of a Responses envelope.

    Only ``message`` output items are inspected, and within them only
    ``output_text`` content parts. Selected text is appended in provider order
    without separators; non-message items and non-``output_text`` parts are
    ignored. At least one selectable part is required.
    """
    output = payload.get("output", _ABSENT)
    if not isinstance(output, list):
        raise ProviderResponseError(
            f"provider response field output must be an array, got {output!r}"
        )

    texts: list[str] = []
    for item_index, item in enumerate(output):
        if not isinstance(item, Mapping):
            raise ProviderResponseError(
                f"provider response field output[{item_index}] must be an object, "
                f"got {item!r}"
            )
        if item.get("type") != "message":
            # Reasoning, tool-call, and other non-message items never carry output.
            continue

        content = item.get("content", _ABSENT)
        if not isinstance(content, list):
            raise ProviderResponseError(
                "provider response field "
                f"output[{item_index}].content must be an array, got {content!r}"
            )

        for part_index, part in enumerate(content):
            if not isinstance(part, Mapping):
                raise ProviderResponseError(
                    "provider response field "
                    f"output[{item_index}].content[{part_index}] must be an object, "
                    f"got {part!r}"
                )
            if part.get("type") != "output_text":
                continue
            text = part.get("text", _ABSENT)
            if not isinstance(text, str):
                raise ProviderResponseError(
                    "provider response field "
                    f"output[{item_index}].content[{part_index}].text must be a "
                    f"string, got {text!r}"
                )
            texts.append(text)

    if not texts:
        raise ProviderResponseError(
            "provider response has no usable output_text parts"
        )
    return "".join(texts)


def _messages_usage_tokens(payload: Mapping[str, Any]) -> int:
    """Validate the Messages usage envelope and return its summed token count.

    An absent ``usage`` normalizes to ``0``; a present non-object ``usage`` —
    including ``null`` — is malformed. ``input_tokens`` and ``output_tokens`` are
    summed, where an absent or null count contributes ``0`` while any other
    non-integer value is rejected.
    """
    usage = payload.get("usage", _ABSENT)
    if usage is _ABSENT:
        return 0
    if not isinstance(usage, Mapping):
        raise ProviderResponseError(
            f"provider response field usage must be an object, got {usage!r}"
        )

    total = 0
    for field in ("input_tokens", "output_tokens"):
        value = usage.get(field, _ABSENT)
        if value is _ABSENT or value is None:
            continue
        total += _require_non_negative_int(value, f"usage.{field}")
    return total


def _messages_content_text(payload: Mapping[str, Any]) -> str:
    """Concatenate the usable ``text`` blocks of a Messages envelope.

    Only blocks whose ``type`` is exactly ``"text"`` contribute; thinking,
    tool-use, and other block types are ignored. Selected text is appended in
    provider order without separators. At least one selectable block is required,
    but truncated text is *not* rejected here — the transport layer owns that.
    """
    content = payload.get("content", _ABSENT)
    if not isinstance(content, list):
        raise ProviderResponseError(
            f"provider response field content must be an array, got {content!r}"
        )

    texts: list[str] = []
    for index, block in enumerate(content):
        if not isinstance(block, Mapping):
            raise ProviderResponseError(
                f"provider response field content[{index}] must be an object, "
                f"got {block!r}"
            )
        if block.get("type") != "text":
            continue
        text = block.get("text", _ABSENT)
        if not isinstance(text, str):
            raise ProviderResponseError(
                f"provider response field content[{index}].text must be a string, "
                f"got {text!r}"
            )
        texts.append(text)

    if not texts:
        raise ProviderResponseError("provider response has no usable text blocks")
    return "".join(texts)


def _endpoint_url(config: AIConfig) -> str:
    """Return the request URL for *config*'s configured mode.

    Legacy mode (``endpoint is None``) keeps the historical
    ``api_base + "/chat/completions"`` concatenation, including any double slash
    a trailing-slash base produces. Explicit mode trims trailing slashes from the
    base and appends the configured path verbatim — no URL resolution, so custom
    gateway prefixes are preserved.
    """
    if config.endpoint is None:
        return config.api_base + "/chat/completions"
    return config.api_base.rstrip("/") + config.endpoint


class ChatCompletionsAdapter:
    """The OpenAI-compatible Chat Completions protocol (legacy and explicit)."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str,
        user_text: str,
        temperature: float,
        max_tokens: int | None,
    ) -> ProviderRequest:
        body: dict[str, Any] = {
            "model": config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            "temperature": temperature,
        }
        # Only include max_tokens if explicitly set (0 or None = unbounded)
        if max_tokens is not None and max_tokens > 0:
            body["max_tokens"] = max_tokens

        return {
            "url": _endpoint_url(config),
            "headers": {
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            "body": body,
        }

    def parse_response(
        self, payload: object, *, configured_model: str
    ) -> ProviderResult:
        if not isinstance(payload, Mapping):
            raise ProviderResponseError(
                f"provider response must be an object, got {type(payload).__name__}"
            )

        choices = payload.get("choices", _ABSENT)
        if choices is _ABSENT:
            raise ProviderResponseError("provider response is missing choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderResponseError(
                f"provider response choices must be a non-empty array, got {choices!r}"
            )

        first_choice = choices[0]
        if not isinstance(first_choice, Mapping):
            raise ProviderResponseError(
                f"provider response choices[0] must be an object, got {first_choice!r}"
            )

        message = first_choice.get("message", _ABSENT)
        if not isinstance(message, Mapping):
            raise ProviderResponseError(
                f"provider response choices[0].message must be an object, got {message!r}"
            )

        content = message.get("content", _ABSENT)
        if not isinstance(content, str):
            # An empty string is legitimate content; None/absent is not.
            raise ProviderResponseError(
                "provider response choices[0].message.content must be a string, "
                f"got {content!r}"
            )

        return {
            "content": content,
            "tokens": _require_usage_tokens(payload),
            "model": _require_model(payload, configured_model),
        }


class ResponsesAdapter:
    """The OpenAI Responses protocol (explicit ``/v1/responses`` mode)."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str,
        user_text: str,
        temperature: float,
        max_tokens: int | None,
    ) -> ProviderRequest:
        body: dict[str, Any] = {
            "model": config.model,
            "instructions": system_prompt,
            "input": user_text,
            "temperature": temperature,
            # Always present and exactly the JSON boolean false.
            "store": False,
        }
        # Only include max_output_tokens for a positive caller limit.
        if max_tokens is not None and max_tokens > 0:
            body["max_output_tokens"] = max_tokens

        return {
            "url": _endpoint_url(config),
            "headers": {
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            "body": body,
        }

    def parse_response(
        self, payload: object, *, configured_model: str
    ) -> ProviderResult:
        if not isinstance(payload, Mapping):
            raise ProviderResponseError(
                f"provider response must be an object, got {type(payload).__name__}"
            )

        # Completion state first: no other field can rescue a non-completed call.
        status = payload.get("status", _ABSENT)
        if not isinstance(status, str) or status != "completed":
            raise ProviderResponseError(
                "provider response field status must be 'completed', "
                f"got {status!r}"
            )

        # Error fields are checked before the output list is ever touched, so an
        # error-bearing envelope can never contribute text.
        for field in ("error", "incomplete_details"):
            value = payload.get(field, _ABSENT)
            if value is not _ABSENT and value is not None:
                raise ProviderResponseError(
                    f"provider response field {field} must be absent or null, "
                    f"got {value!r}"
                )

        return {
            "content": _responses_output_text(payload),
            "tokens": _require_responses_usage_tokens(payload),
            "model": _require_model(payload, configured_model),
        }


class MessagesAdapter:
    """The Anthropic Messages protocol (explicit ``/v1/messages`` mode)."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str,
        user_text: str,
        temperature: float,
        max_tokens: int | None,
    ) -> ProviderRequest:
        # max_tokens is mandatory for the Messages protocol, so a positive caller
        # limit wins and everything else falls back to the configured default.
        effective_max_tokens = (
            max_tokens
            if max_tokens is not None and max_tokens > 0
            else config.messages_default_max_tokens
        )
        body: dict[str, Any] = {
            "model": config.model,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_text}],
            "temperature": temperature,
            "max_tokens": effective_max_tokens,
        }

        return {
            "url": config.api_base.rstrip("/") + "/v1/messages",
            "headers": {
                "x-api-key": config.api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            "body": body,
        }

    def parse_response(
        self, payload: object, *, configured_model: str
    ) -> ProviderResult:
        if not isinstance(payload, Mapping):
            raise ProviderResponseError(
                f"provider response must be an object, got {type(payload).__name__}"
            )

        # A present stop_reason must be a string; "max_tokens" (truncation) is a
        # legitimate value and must not be rejected.
        stop_reason = payload.get("stop_reason", _ABSENT)
        if stop_reason is not _ABSENT and not isinstance(stop_reason, str):
            raise ProviderResponseError(
                "provider response field stop_reason must be a string, "
                f"got {stop_reason!r}"
            )

        return {
            "content": _messages_content_text(payload),
            "tokens": _messages_usage_tokens(payload),
            "model": _require_model(payload, configured_model),
        }


# ---------------------------------------------------------------------------
# AI provider call
# ---------------------------------------------------------------------------

async def _do_ai_call(body: dict, headers: dict, timeout: httpx.Timeout, config: AIConfig, deadline: float) -> dict[str, Any]:
    """Shared AI provider call with retry logic."""
    debug = _load_debug()
    _debug("ai", f"calling model={config.model} base={config.api_base}", enabled=debug)

    async def make_request():
        async with httpx.AsyncClient(timeout=timeout, limits=httpx.Limits(max_keepalive_connections=5)) as client:
            resp = await client.post(
                f"{config.api_base}/chat/completions",
                headers=headers,
                json=body,
            )
            resp.raise_for_status()
            return resp.json()

    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            data = await asyncio.wait_for(make_request(), timeout=deadline)
            content = data["choices"][0]["message"]["content"]
            tokens = data.get("usage", {}).get("total_tokens", 0)
            _debug("ai", f"response: {len(content)} chars tokens={tokens} model={data.get('model', config.model)}", enabled=debug)
            return {"content": content, "tokens": tokens, "model": data.get("model", config.model)}
        except asyncio.TimeoutError:
            last_exc = HTTPException(status_code=504, detail="AI provider timed out")
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:500]
            last_exc = HTTPException(
                status_code=502, detail=f"AI provider error: {exc.response.status_code} — {detail}"
            )
        except (httpx.RequestError, httpx.TimeoutException, ValueError, KeyError, IndexError) as exc:
            last_exc = HTTPException(status_code=502, detail=f"AI provider error: {exc}")
        except Exception as exc:
            import traceback
            if debug:
                traceback.print_exc()
            last_exc = HTTPException(status_code=502, detail=f"Unexpected AI error: {type(exc).__name__}: {exc}")

        if attempt == 1:
            await asyncio.sleep(1)

    raise last_exc  # type: ignore[misc]


async def _call_ai(text: str, language: str, config: AIConfig, max_tokens: int | None = None) -> dict[str, Any]:
    """Send text to AI provider for grammar checking and parse the response."""
    system_prompt = GRAMMAR_SYSTEM_PROMPT
    if language != "auto":
        system_prompt += f"\n\nThe text is in {language}. Focus on errors specific to this language."

    timeout_cfg = config.timeout
    timeout = httpx.Timeout(
        connect=timeout_cfg.connect,
        read=timeout_cfg.read,
        write=timeout_cfg.write,
        pool=timeout_cfg.pool,
    )

    deadline = timeout_cfg.read + 5  # buffer so httpx fires first
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }

    body = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        "temperature": config.get_temperature("check", DEFAULT_TEMPERATURE_CHECK),
    }
    # Only include max_tokens if explicitly set (0 or None = unbounded)
    if max_tokens and max_tokens > 0:
        body["max_tokens"] = max_tokens

    return await _do_ai_call(body, headers, timeout, config, deadline)


def _parse_errors(content: str) -> list[ErrorItem]:
    """Parse the AI response content into a list of ErrorItem objects."""
    # AI may return null/non-string content — treat as a bad upstream response
    if not isinstance(content, str):
        raise HTTPException(
            status_code=502,
            detail="AI response had no text content",
        )

    # Strip markdown code fences if present
    content = content.strip()
    if content.startswith("```"):
        # Remove opening fence line
        content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3]
    content = content.strip()

    try:
        raw_errors = json.loads(content)
    except json.JSONDecodeError:
        # Try to extract JSON array from the response
        match = re.search(r"\[.*\]", content, re.DOTALL)
        if match:
            try:
                raw_errors = json.loads(match.group(0))
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to parse AI response as JSON: {content[:300]}",
                )
        else:
            raise HTTPException(
                status_code=502,
                detail=f"AI response is not valid JSON: {content[:300]}",
            )

    if not isinstance(raw_errors, list):
        raise HTTPException(
            status_code=502,
            detail=f"AI response is not a JSON array: {content[:300]}",
        )

    errors: list[ErrorItem] = []
    for item in raw_errors:
        try:
            errors.append(
                ErrorItem(
                    start=int(item["start"]),
                    end=int(item["end"]),
                    error=str(item["error"]),
                    correction=str(item["correction"]),
                    explanation=str(item.get("explanation", "")),
                    type=str(item.get("type", "error")),
                )
            )
        except (KeyError, ValueError, TypeError) as exc:
            # Skip malformed error items
            print(f"Skipping malformed error item: {item} — {exc}")
            continue

    return errors


def _parse_polished(content: str) -> str:
    """Parse AI polish response — extract the 'polished' field from JSON."""
    if not isinstance(content, str):
        raise HTTPException(status_code=502, detail="AI response had no text content")

    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3]
    content = content.strip()

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
            except json.JSONDecodeError:
                raise HTTPException(status_code=502, detail=f"Failed to parse AI response: {content[:300]}")
        else:
            raise HTTPException(status_code=502, detail=f"AI response is not valid JSON: {content[:300]}")

    polished = data.get("polished", "")
    if not polished or not isinstance(polished, str):
        raise HTTPException(status_code=502, detail=f"AI response missing 'polished' field: {content[:300]}")

    return polished


def _parse_translated(content: str) -> str:
    """Parse AI translate response — extract the 'translated' field from JSON."""
    if not isinstance(content, str):
        raise HTTPException(status_code=502, detail="AI response had no text content")

    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3]
    content = content.strip()

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
            except json.JSONDecodeError:
                raise HTTPException(status_code=502, detail=f"Failed to parse AI response: {content[:300]}")
        else:
            raise HTTPException(status_code=502, detail=f"AI response is not valid JSON: {content[:300]}")

    translated = data.get("translated", "")
    if not translated or not isinstance(translated, str):
        raise HTTPException(status_code=502, detail=f"AI response missing 'translated' field: {content[:300]}")

    return translated
