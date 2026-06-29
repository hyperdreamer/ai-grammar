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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_MAX_TEXT_CHARS = 50_000

# ---------------------------------------------------------------------------
# Debug logging (timestamped stderr, gated by config.debug)
# ---------------------------------------------------------------------------


def _debug(tag: str, msg: str, *, enabled: bool = False) -> None:
    """Print a timestamped debug message to stderr when *enabled* is True."""
    if not enabled:
        return
    import sys
    from datetime import datetime, timezone

    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[DEBUG][{tag}] {ts} {msg}", file=sys.stderr, flush=True)

GRAMMAR_SYSTEM_PROMPT = """You are a grammar checker. Find issues in the text. Return ONLY a JSON array of objects with these fields:
- "start": int, 0-indexed character offset
- "end": int, 0-indexed character offset (exclusive)
- "error": string, original text
- "correction": string, fix
- "explanation": string, short reason (max 80 chars)
- "type": "error"|"improvement"|"idiom"

Types: error=spelling/grammar, improvement=clarity/conciseness, idiom=natural phrasing.
Offsets must be exact. Include spaces/newlines in count. Return [] if no issues. No markdown."""


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
    type: str = "error"  # "error", "improvement", or "idiom"


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


@dataclass(frozen=True)
class ServerConfig:
    """Server listen address loaded from config.yaml."""

    host: str = "127.0.0.1"
    port: int = 8766
    debug: bool = False


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

    # Resolve API key: $ prefix means read from env var
    api_key = ""
    raw_key = ai_section.get("api_key", "")
    if isinstance(raw_key, str) and raw_key:
        if raw_key.startswith("$"):
            env_name = raw_key[1:]
            api_key = os.getenv(env_name) or ""
            if not api_key:
                raise RuntimeError(
                    f"API key not found in environment variable: {env_name}"
                )
        else:
            api_key = raw_key

    if not api_key:
        raise RuntimeError(
            "No API key configured. Set ai.api_key in config.yaml."
        )

    timeout_raw = ai_section.get("timeout", {})
    timeout = TimeoutConfig(
        connect=float(timeout_raw.get("connect", 10)),
        read=float(timeout_raw.get("read", 120)),
        write=float(timeout_raw.get("write", 60)),
        pool=float(timeout_raw.get("pool", 10)),
    )

    # Normalize api_base: auto-append /v1 if not present
    api_base = ai_section.get("api_base", "https://api.openai.com/v1")
    if not api_base.rstrip("/").endswith("/v1"):
        api_base = api_base.rstrip("/") + "/v1"

    return AIConfig(
        provider=ai_section.get("provider", "openai"),
        model=ai_section.get("model", "gpt-4o-mini"),
        api_key=api_key,
        api_base=api_base,
        timeout=timeout,
    )


def load_server_config() -> ServerConfig:
    """Load server listen address from config.yaml, with env-var override."""
    if not CONFIG_PATH.exists():
        return ServerConfig()

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    server_section = raw.get("server", {})

    host = os.environ.get("GRAMMAR_HOST") or server_section.get("host", DEFAULT_HOST)
    port = int(os.environ.get("GRAMMAR_PORT", 0)) or server_section.get("port", DEFAULT_PORT)

    return ServerConfig(
        host=host,
        port=port,
        debug=bool(raw.get("debug", False)),
    )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Grammar Checker", version="1.0.6")

# Allow requests from any origin (content scripts run in page context)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for testing
STATIC_DIR = Path(__file__).parents[1] / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


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


def _load_debug() -> bool:
    """Read the debug flag from config.yaml (lightweight, no full config load)."""
    if not CONFIG_PATH.exists():
        return False
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return bool(raw.get("debug", False))


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

    deadline = 30  # grammar checks are fast, no need for long timeout
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
        "max_tokens": 2048,  # grammar responses are small
    }

    debug = _load_debug()
    _debug("ai", f"calling provider={config.provider} model={config.model} base={config.api_base} text={len(text)}chars lang={language}", enabled=debug)

    # Reuse a single client for connection keep-alive
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
            # Any other unexpected error — log and return 502 instead of 500
            import traceback
            traceback.print_exc()
            last_exc = HTTPException(status_code=502, detail=f"Unexpected AI error: {type(exc).__name__}: {exc}")

        if attempt == 1:
            await asyncio.sleep(1)

    raise last_exc  # type: ignore[misc]


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


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}

@app.get("/version")
async def version():
    """Return extension version from manifest."""
    manifest_path = Path(__file__).parents[1] / "extension" / "manifest.json"
    try:
        with open(manifest_path) as f:
            data = json.load(f)
        return {"version": data.get("version", "unknown")}
    except Exception:
        return {"version": "unknown"}


@app.post("/check", response_model=None)
async def check_grammar(request: CheckRequest) -> Response:
    """Check text for grammar and spelling errors."""
    text = request.text.strip()
    debug = _load_debug()
    _debug("check", f"request: {len(text)} chars lang={request.language}", enabled=debug)
    if not text:
        body = json.dumps({"errors": [], "model": "", "tokens_used": 0}, ensure_ascii=False)
        return Response(content=body.encode("utf-8"), media_type="application/json")

    if len(text) > DEFAULT_MAX_TEXT_CHARS:
        text = text[:DEFAULT_MAX_TEXT_CHARS]

    try:
        config = load_config()
    except RuntimeError as exc:
        # Misconfiguration is a genuine server-side problem
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        # Bad/unreadable config file (YAML error, bad value, OSError, ...)
        raise HTTPException(
            status_code=500, detail=f"Configuration error: {type(exc).__name__}: {exc}"
        )

    try:
        result = await _call_ai(text, request.language, config)
    except HTTPException:
        raise
    except Exception as exc:
        # AI provider problems must surface as 502, never 500
        raise HTTPException(status_code=502, detail=f"AI call failed: {exc}")

    try:
        errors = _parse_errors(result["content"])
    except HTTPException:
        raise
    except Exception as exc:
        # Malformed AI output should never escape as a 500
        raise HTTPException(
            status_code=502, detail=f"Failed to parse AI response: {type(exc).__name__}: {exc}"
        )

    body = json.dumps(
        {
            "errors": [e.model_dump() for e in errors],
            "model": result["model"],
            "tokens_used": result["tokens"],
        },
        ensure_ascii=False,
    )

    _debug("check", f"response: {len(errors)} errors model={result['model']} tokens={result['tokens']}", enabled=debug)

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

    server = load_server_config()
    uvicorn.run(app, host=server.host, port=server.port)
