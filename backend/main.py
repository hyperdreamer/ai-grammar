"""FastAPI backend for AI grammar and spelling checking."""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_MAX_TEXT_CHARS = 50_000

GRAMMAR_SYSTEM_PROMPT = """You are a precise grammar and spelling checker. Analyze the provided text and identify all errors: spelling mistakes, grammar errors, punctuation errors, and awkward phrasing.

Return a JSON array of error objects. Each object must have these fields:
- "start": integer, 0-indexed character offset where the error begins in the original text
- "end": integer, 0-indexed character offset where the error ends (exclusive)
- "error": string, the original erroneous text at that position
- "correction": string, the corrected version
- "explanation": string, brief explanation of the error type and correction (max 100 chars)

Rules:
- Only flag genuine errors. Do not flag stylistic preferences or regional spelling variants.
- The "start" and "end" must be exact character offsets in the original text as provided.
- Count characters as they appear — include spaces, newlines, and punctuation in your offset calculation.
- If the text has no errors, return an empty array [].
- Return ONLY the JSON array, no other text, no markdown fences, no explanation."""


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CheckRequest(BaseModel):
    """Request body for the /check endpoint."""

    text: str
    language: str = "auto"


class ErrorItem(BaseModel):
    """A single detected error with position and correction."""

    start: int
    end: int
    error: str
    correction: str
    explanation: str


class CheckResponse(BaseModel):
    """Response body returned by the /check endpoint."""

    errors: list[ErrorItem]
    model: str
    tokens_used: int
    error: str | None = None


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TimeoutConfig:
    """Per-phase HTTP timeouts for AI provider calls (all in seconds)."""

    connect: float = 10.0
    read: float = 120.0
    write: float = 60.0
    pool: float = 10.0


@dataclass(frozen=True)
class AIConfig:
    """Settings needed to call a configured AI provider."""

    provider: str = "openai"
    model: str = "gpt-4o-mini"
    api_key: str = ""
    api_base: str = "https://api.openai.com/v1"
    timeout: TimeoutConfig = TimeoutConfig()


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_config() -> AIConfig:
    """Load configuration from config.yaml with env-var resolution."""
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Config file not found: {CONFIG_PATH}")

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    ai_section = raw.get("ai", {})

    # Resolve API key: api_key_env takes priority
    api_key = ""
    env_ref = ai_section.get("api_key_env")
    if isinstance(env_ref, str) and env_ref:
        env_name = env_ref[1:] if env_ref.startswith("$") else env_ref
        api_key = os.getenv(env_name) or ""
        if not api_key:
            raise RuntimeError(
                f"API key not found in environment variable: {env_name}"
            )

    if not api_key:
        raw_key = ai_section.get("api_key", "")
        if isinstance(raw_key, str) and raw_key:
            if raw_key.startswith("$"):
                api_key = os.getenv(raw_key[1:]) or ""
            else:
                api_key = raw_key

    if not api_key:
        raise RuntimeError(
            "No API key configured. Set ai.api_key_env or ai.api_key in config.yaml."
        )

    timeout_raw = ai_section.get("timeout", {})
    timeout = TimeoutConfig(
        connect=float(timeout_raw.get("connect", 10)),
        read=float(timeout_raw.get("read", 120)),
        write=float(timeout_raw.get("write", 60)),
        pool=float(timeout_raw.get("pool", 10)),
    )

    return AIConfig(
        provider=ai_section.get("provider", "openai"),
        model=ai_section.get("model", "gpt-4o-mini"),
        api_key=api_key,
        api_base=ai_section.get("api_base", "https://api.openai.com/v1"),
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Grammar Checker", version="1.0.0")


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"error": str(exc)})


@app.exception_handler(Exception)
async def catch_all_handler(_request: Request, exc: Exception):
    import traceback

    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"error": f"Internal error: {type(exc).__name__}: {exc}"},
    )


def _error_payload(msg: str) -> dict[str, str]:
    return {"error": msg}


# ---------------------------------------------------------------------------
# AI provider call
# ---------------------------------------------------------------------------

async def _call_ai(text: str, language: str, config: AIConfig) -> dict[str, Any]:
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

    deadline = timeout_cfg.read + 60
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
        "temperature": 0.1,
        "max_tokens": 4096,
    }

    async def make_request():
        async with httpx.AsyncClient(timeout=timeout) as client:
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
            return {"content": content, "tokens": tokens, "model": data.get("model", config.model)}
        except asyncio.TimeoutError:
            last_exc = HTTPException(status_code=504, detail="AI provider timed out")
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:500]
            last_exc = HTTPException(
                status_code=502, detail=f"AI provider error: {exc.response.status_code} — {detail}"
            )
        except (httpx.RequestError, ValueError) as exc:
            last_exc = HTTPException(status_code=502, detail=f"AI provider connection error: {exc}")

        if attempt == 1:
            await asyncio.sleep(1)

    raise last_exc  # type: ignore[misc]


def _parse_errors(content: str) -> list[ErrorItem]:
    """Parse the AI response content into a list of ErrorItem objects."""
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
                    status_code=500,
                    detail=f"Failed to parse AI response as JSON: {content[:300]}",
                )
        else:
            raise HTTPException(
                status_code=500,
                detail=f"AI response is not valid JSON: {content[:300]}",
            )

    if not isinstance(raw_errors, list):
        raise HTTPException(
            status_code=500,
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
                )
            )
        except (KeyError, ValueError, TypeError) as exc:
            # Skip malformed error items
            print(f"Skipping malformed error item: {item} — {exc}")
            continue

    return errors


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/check", response_model=None)
async def check_grammar(request: CheckRequest) -> Response:
    """Check text for grammar and spelling errors."""
    text = request.text.strip()
    if not text:
        body = json.dumps({"errors": [], "model": "", "tokens_used": 0}, ensure_ascii=False)
        return Response(content=body.encode("utf-8"), media_type="application/json")

    if len(text) > DEFAULT_MAX_TEXT_CHARS:
        text = text[:DEFAULT_MAX_TEXT_CHARS]

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    try:
        result = await _call_ai(text, request.language, config)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AI call failed: {exc}")

    errors = _parse_errors(result["content"])

    body = json.dumps(
        {
            "errors": [e.model_dump() for e in errors],
            "model": result["model"],
            "tokens_used": result["tokens"],
        },
        ensure_ascii=False,
    )

    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={"Connection": "close"},
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("GRAMMAR_HOST", DEFAULT_HOST)
    port = int(os.environ.get("GRAMMAR_PORT", DEFAULT_PORT))
    uvicorn.run(app, host=host, port=port)
