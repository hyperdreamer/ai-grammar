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

# Default temperatures per endpoint (used when config doesn't override)
DEFAULT_TEMPERATURE_CHECK = 0.1
DEFAULT_TEMPERATURE_POLISH = 0.3
DEFAULT_TEMPERATURE_TRANSLATE = 0.3

# Explicit provider endpoint paths accepted from ai.endpoint. Only these exact
# values are supported; omitting the key keeps legacy /v1 normalization.
SUPPORTED_ENDPOINTS = frozenset(
    {
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/messages",
    }
)

# Fallback max_tokens for the Messages protocol when the caller supplies none.
DEFAULT_MESSAGES_MAX_TOKENS = 4096


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
    temperature: float | None = None  # global override for all endpoints
    endpoint_temperatures: dict[str, float] | None = None  # per-endpoint overrides
    endpoint: str | None = None  # explicit provider path; None selects legacy mode
    messages_default_max_tokens: int = DEFAULT_MESSAGES_MAX_TOKENS

    def get_temperature(self, endpoint: str, default: float) -> float:
        """Return the temperature for *endpoint*, falling back through
        global override → per-endpoint → caller-supplied default."""
        if self.temperature is not None:
            return self.temperature
        if self.endpoint_temperatures and endpoint in self.endpoint_temperatures:
            return self.endpoint_temperatures[endpoint]
        return default


@dataclass(frozen=True)
class ServerConfig:
    """Server listen address loaded from config.yaml."""

    host: str = "127.0.0.1"
    port: int = 8766
    debug: bool = False


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def _resolve_endpoint(ai_section: dict) -> str | None:
    """Return the validated explicit endpoint, or None for legacy mode.

    An absent ``ai.endpoint`` key selects legacy mode; a present key must hold
    one of the exact ``SUPPORTED_ENDPOINTS`` strings.
    """
    if "endpoint" not in ai_section:
        return None
    raw_endpoint = ai_section["endpoint"]
    if not isinstance(raw_endpoint, str) or raw_endpoint not in SUPPORTED_ENDPOINTS:
        supported = ", ".join(sorted(SUPPORTED_ENDPOINTS))
        raise RuntimeError(
            f"Unsupported ai.endpoint value: {raw_endpoint!r}. "
            f"Use one of: {supported}"
        )
    return raw_endpoint


def _resolve_messages_max_tokens(ai_section: dict) -> int:
    """Return the validated ``ai.messages_default_max_tokens`` value."""
    if "messages_default_max_tokens" not in ai_section:
        return DEFAULT_MESSAGES_MAX_TOKENS
    raw_value = ai_section["messages_default_max_tokens"]
    # ``type(...) is int`` deliberately rejects bool (a subclass of int).
    if type(raw_value) is not int or raw_value <= 0:
        raise RuntimeError(
            "ai.messages_default_max_tokens must be a positive integer, "
            f"got {raw_value!r}"
        )
    return raw_value


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

    endpoint = _resolve_endpoint(ai_section)
    messages_default_max_tokens = _resolve_messages_max_tokens(ai_section)

    if endpoint is None:
        # Legacy mode: auto-append /v1 if not present (trailing slash preserved)
        raw_base = ai_section.get("api_base", "https://api.openai.com/v1")
        if not raw_base.rstrip("/").endswith("/v1"):
            api_base = raw_base.rstrip("/") + "/v1"
        else:
            api_base = raw_base
    else:
        # Explicit mode: trim trailing slashes, keep every path segment as-is.
        # Validation runs on the POST-strip value: a slash-only base such as
        # "/" would otherwise resolve to "" and build a relative request URL.
        raw_base = ai_section.get("api_base", "https://api.openai.com")
        if isinstance(raw_base, str):
            api_base = raw_base.rstrip("/")
        else:
            api_base = raw_base
        if not isinstance(api_base, str) or not api_base:
            raise RuntimeError(
                "ai.api_base must be a non-empty string when ai.endpoint is set."
            )

    # Temperature config: global override or per-endpoint
    temperature = ai_section.get("temperature")
    if temperature is not None:
        temperature = float(temperature)
    endpoint_temperatures = None
    endpoints_raw = ai_section.get("endpoints", {})
    if isinstance(endpoints_raw, dict) and endpoints_raw:
        endpoint_temperatures = {
            k: float(v) for k, v in endpoints_raw.items() if v is not None
        }

    return AIConfig(
        model=ai_section.get("model", "gpt-4o-mini"),
        api_key=api_key,
        api_base=api_base,
        timeout=timeout,
        temperature=temperature,
        endpoint_temperatures=endpoint_temperatures,
        endpoint=endpoint,
        messages_default_max_tokens=messages_default_max_tokens,
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
