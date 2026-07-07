"""FastAPI application and route handlers for the AI Grammar backend."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import DEFAULT_MAX_TEXT_CHARS, _debug, _load_debug, load_config, DEFAULT_TEMPERATURE_POLISH, DEFAULT_TEMPERATURE_TRANSLATE
from .models import CheckRequest, TranslateRequest
from .providers import _call_ai, _parse_errors, _parse_polished, _parse_translated, POLISH_SYSTEM_PROMPT, TRANSLATE_SYSTEM_PROMPT, _do_ai_call

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Grammar Checker", version="1.0.7")

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
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Configuration error: {type(exc).__name__}: {exc}"
        )

    try:
        result = await _call_ai(text, request.language, config, request.max_tokens)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI call failed: {exc}")

    try:
        errors = _parse_errors(result["content"])
    except HTTPException:
        raise
    except Exception as exc:
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


@app.post("/polish", response_model=None)
async def polish_text(request: CheckRequest) -> Response:
    """Polish/improve text for clarity and naturalness."""
    text = request.text.strip()
    debug = _load_debug()
    _debug("polish", f"request: {len(text)} chars", enabled=debug)

    if not text:
        body = json.dumps({"polished": "", "model": "", "tokens_used": 0}, ensure_ascii=False)
        return Response(content=body.encode("utf-8"), media_type="application/json")

    if len(text) > DEFAULT_MAX_TEXT_CHARS:
        text = text[:DEFAULT_MAX_TEXT_CHARS]

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Configuration error: {type(exc).__name__}: {exc}")

    timeout = httpx.Timeout(
        connect=config.timeout.connect,
        read=config.timeout.read,
        write=config.timeout.write,
        pool=config.timeout.pool,
    )
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    body_data = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": POLISH_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": config.get_temperature("polish", DEFAULT_TEMPERATURE_POLISH),
    }
    if request.max_tokens and request.max_tokens > 0:
        body_data["max_tokens"] = request.max_tokens

    try:
        deadline = config.timeout.read + 5  # buffer so httpx fires first
        result = await _do_ai_call(body_data, headers, timeout, config, deadline=deadline)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI call failed: {exc}")

    try:
        polished = _parse_polished(result["content"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to parse AI response: {type(exc).__name__}: {exc}")

    body = json.dumps(
        {"polished": polished, "model": result["model"], "tokens_used": result["tokens"]},
        ensure_ascii=False,
    )
    _debug("polish", f"response: {len(polished)} chars model={result['model']} tokens={result['tokens']}", enabled=debug)

    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={"Connection": "close"},
    )


@app.post("/translate", response_model=None)
async def translate_text(request: TranslateRequest) -> Response:
    """Translate text to the target language."""
    text = request.text.strip()
    debug = _load_debug()
    _debug("translate", f"request: {len(text)} chars target={request.target_lang}", enabled=debug)

    if not text:
        body = json.dumps({"translated": "", "model": "", "tokens_used": 0}, ensure_ascii=False)
        return Response(content=body.encode("utf-8"), media_type="application/json")

    if len(text) > DEFAULT_MAX_TEXT_CHARS:
        text = text[:DEFAULT_MAX_TEXT_CHARS]

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Configuration error: {type(exc).__name__}: {exc}")

    timeout = httpx.Timeout(
        connect=config.timeout.connect,
        read=config.timeout.read,
        write=config.timeout.write,
        pool=config.timeout.pool,
    )
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    target_lang_label = "English" if request.target_lang == "en" else request.target_lang
    system_prompt = TRANSLATE_SYSTEM_PROMPT + f"\n\nTarget language: {target_lang_label}"
    body_data = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        "temperature": config.get_temperature("translate", DEFAULT_TEMPERATURE_TRANSLATE),
    }
    if request.max_tokens and request.max_tokens > 0:
        body_data["max_tokens"] = request.max_tokens

    try:
        deadline = config.timeout.read + 5  # buffer so httpx fires first
        result = await _do_ai_call(body_data, headers, timeout, config, deadline=deadline)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI call failed: {exc}")

    try:
        translated = _parse_translated(result["content"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to parse AI response: {type(exc).__name__}: {exc}")

    body = json.dumps(
        {"translated": translated, "model": result["model"], "tokens_used": result["tokens"]},
        ensure_ascii=False,
    )
    _debug("translate", f"response: {len(translated)} chars model={result['model']} tokens={result['tokens']}", enabled=debug)

    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={"Connection": "close"},
    )
