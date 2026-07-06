"""Configuration loading for the AI Grammar backend."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

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


# ---------------------------------------------------------------------------
# Configuration dataclasses
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


def _load_debug() -> bool:
    """Read the debug flag from config.yaml (lightweight, no full config load)."""
    if not CONFIG_PATH.exists():
        return False
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return bool(raw.get("debug", False))
