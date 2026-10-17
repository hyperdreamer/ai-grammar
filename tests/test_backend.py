"""Backend tests for AI Grammar Checker.

Requires: pytest, pytest-asyncio, httpx, pyyaml
Run from project root: python -m pytest tests/test_backend.py -v
"""

import asyncio
import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
import yaml
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_config_dir(tmp_path, monkeypatch):
    """Create a temporary config.yaml with a dummy API key."""
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        "ai:\n"
        "  api_key: test-key-12345\n"
        "  model: test-model\n"
        "server:\n"
        "  host: 127.0.0.1\n"
        "  port: 8766\n"
    )
    # Patch CONFIG_PATH in config module to point to temp file
    monkeypatch.setattr("backend.config.CONFIG_PATH", config_file)
    return config_file


@pytest_asyncio.fixture
async def client(temp_config_dir):
    """Async HTTP client pointing at the FastAPI app."""
    from backend.routes import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# ---------------------------------------------------------------------------
# Endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health_endpoint(client):
    """GET /health returns status ok."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_version_endpoint(client):
    """GET /version returns a version string."""
    resp = await client.get("/version")
    assert resp.status_code == 200
    data = resp.json()
    assert "version" in data
    assert isinstance(data["version"], str)


@pytest.mark.asyncio
async def test_check_empty_text(client):
    """POST /check with empty text returns empty results."""
    resp = await client.post("/check", json={"text": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"errors": [], "model": "", "tokens_used": 0}


@pytest.mark.asyncio
async def test_polish_empty_text(client):
    """POST /polish with empty text returns empty results."""
    resp = await client.post("/polish", json={"text": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"polished": "", "model": "", "tokens_used": 0}


@pytest.mark.asyncio
async def test_translate_empty_text(client):
    """POST /translate with empty text returns empty results."""
    resp = await client.post("/translate", json={"text": "", "target_lang": "zh"})
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"translated": "", "model": "", "tokens_used": 0}


@pytest.mark.asyncio
async def test_check_truncates_long_text(client, monkeypatch):
    """POST /check with 60K chars truncates to 50K before AI call."""
    long_text = "x" * 60000
    mock_result = {"content": "[]", "tokens": 10, "model": "test-model"}

    async def fake_call_ai(text, language, config, max_tokens=None):
        assert len(text) == 50000, f"Expected 50000 chars, got {len(text)}"
        return mock_result

    monkeypatch.setattr("backend.routes._call_ai", fake_call_ai)

    resp = await client.post("/check", json={"text": long_text})
    assert resp.status_code == 200
    data = resp.json()
    assert data["errors"] == []
    assert data["model"] == "test-model"


@pytest.mark.asyncio
async def test_cors_middleware_configured():
    """CORS middleware is configured with allow_all origins."""
    from backend.routes import app

    # Find the CORSMiddleware in the app's middleware stack
    cors_mw = None
    for mw in app.user_middleware:
        if mw.cls.__name__ == "CORSMiddleware":
            cors_mw = mw
            break
    assert cors_mw is not None, "CORSMiddleware not found"
    assert cors_mw.kwargs.get("allow_origins") == ["*"]


@pytest.mark.asyncio
async def test_validation_error(client):
    """POST /check with non-string text returns 422."""
    resp = await client.post("/check", json={"text": 123})
    assert resp.status_code == 422
    data = resp.json()
    assert "error" in data


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------


def test_config_load_from_env_var(tmp_path, monkeypatch):
    """load_config resolves $ prefixed keys from env."""
    config_file = tmp_path / "config.yaml"
    config_file.write_text("ai:\n  api_key: $TEST_API_KEY\n  model: test\n")
    monkeypatch.setattr("backend.config.CONFIG_PATH", config_file)
    monkeypatch.setenv("TEST_API_KEY", "secret-from-env")

    from backend.config import load_config

    cfg = load_config()
    assert cfg.api_key == "secret-from-env"
    assert cfg.model == "test"


def test_config_missing_key(tmp_path, monkeypatch):
    """load_config with no api_key raises RuntimeError."""
    config_file = tmp_path / "config.yaml"
    config_file.write_text("ai:\n  model: test\n")
    monkeypatch.setattr("backend.config.CONFIG_PATH", config_file)

    from backend.config import load_config

    with pytest.raises(RuntimeError, match="No API key configured"):
        load_config()


def test_config_env_var_not_set(tmp_path, monkeypatch):
    """load_config with $ENV_VAR that is unset raises RuntimeError."""
    config_file = tmp_path / "config.yaml"
    config_file.write_text("ai:\n  api_key: $MISSING_KEY\n  model: test\n")
    monkeypatch.setattr("backend.config.CONFIG_PATH", config_file)

    from backend.config import load_config

    with pytest.raises(RuntimeError, match="API key not found"):
        load_config()


# ---------------------------------------------------------------------------
# Endpoint-aware config tests
# ---------------------------------------------------------------------------

# Sentinel: pass this to _write_ai_config to omit the key entirely, so tests can
# tell an absent key apart from a present YAML ``null``.
_OMITTED = object()


def _write_ai_config(tmp_path, monkeypatch, **ai_overrides):
    """Write a config.yaml whose ai section always has a valid test API key."""
    ai_section = {"api_key": "test-key-12345"}
    for key, value in ai_overrides.items():
        if value is not _OMITTED:
            ai_section[key] = value
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump({"ai": ai_section}, sort_keys=False), encoding="utf-8"
    )
    monkeypatch.setattr("backend.config.CONFIG_PATH", config_file)
    return config_file


def test_config_supported_endpoints_and_defaults():
    """The supported endpoint collection is exact and immutable."""
    from backend.config import DEFAULT_MESSAGES_MAX_TOKENS, SUPPORTED_ENDPOINTS

    assert set(SUPPORTED_ENDPOINTS) == {
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/messages",
    }
    assert len(SUPPORTED_ENDPOINTS) == 3
    assert DEFAULT_MESSAGES_MAX_TOKENS == 4096
    # Pin immutability by type/behavior: a plain `list` has no `add` either,
    # so asserting only that `.add` raises would let a mutable list through.
    assert isinstance(SUPPORTED_ENDPOINTS, (frozenset, tuple))
    assert not hasattr(SUPPORTED_ENDPOINTS, "add")
    assert not hasattr(SUPPORTED_ENDPOINTS, "append")


def test_config_ai_config_endpoint_field_defaults():
    """AIConfig defaults select legacy mode and the 4096 Messages limit."""
    from backend.config import AIConfig

    cfg = AIConfig()
    assert cfg.endpoint is None
    assert cfg.messages_default_max_tokens == 4096


@pytest.mark.parametrize(
    "raw_api_base,expected_base",
    [
        (_OMITTED, "https://api.openai.com/v1"),
        ("https://gateway", "https://gateway/v1"),
        ("https://gateway/v1", "https://gateway/v1"),
        ("https://gateway/", "https://gateway/v1"),
        ("https://gateway/v1/", "https://gateway/v1/"),
    ],
    ids=["omitted", "no-v1-suffix", "v1-suffix", "trailing-slash", "v1-trailing-slash"],
)
def test_config_legacy_mode_api_base(
    tmp_path, monkeypatch, raw_api_base, expected_base
):
    """Omitted ai.endpoint keeps the legacy /v1 normalization unchanged."""
    _write_ai_config(tmp_path, monkeypatch, api_base=raw_api_base)

    from backend.config import load_config

    cfg = load_config()
    assert cfg.endpoint is None
    assert cfg.api_base == expected_base
    assert cfg.messages_default_max_tokens == 4096


@pytest.mark.parametrize(
    "endpoint",
    ["/v1/chat/completions", "/v1/responses", "/v1/messages"],
)
def test_config_explicit_mode_default_api_base(tmp_path, monkeypatch, endpoint):
    """An explicit endpoint with omitted api_base resolves to api.openai.com."""
    _write_ai_config(tmp_path, monkeypatch, endpoint=endpoint)

    from backend.config import load_config

    cfg = load_config()
    assert cfg.endpoint == endpoint
    assert cfg.api_base == "https://api.openai.com"
    assert cfg.messages_default_max_tokens == 4096


@pytest.mark.parametrize(
    "raw_api_base,expected_base",
    [
        ("https://gateway/proxy/", "https://gateway/proxy"),
        ("https://gateway/proxy", "https://gateway/proxy"),
        ("https://gateway/proxy/v1", "https://gateway/proxy/v1"),
    ],
    ids=["trailing-slash", "plain", "v1-suffix"],
)
def test_config_explicit_mode_api_base(tmp_path, monkeypatch, raw_api_base, expected_base):
    """Explicit mode trims trailing slashes without rewriting path segments."""
    _write_ai_config(
        tmp_path,
        monkeypatch,
        endpoint="/v1/messages",
        api_base=raw_api_base,
    )

    from backend.config import load_config

    cfg = load_config()
    assert cfg.endpoint == "/v1/messages"
    assert cfg.api_base == expected_base


def test_config_explicit_mode_retains_messages_default(tmp_path, monkeypatch):
    """A configured messages_default_max_tokens is retained in explicit mode."""
    _write_ai_config(
        tmp_path,
        monkeypatch,
        endpoint="/v1/messages",
        messages_default_max_tokens=8192,
    )

    from backend.config import load_config

    cfg = load_config()
    assert cfg.endpoint == "/v1/messages"
    assert cfg.messages_default_max_tokens == 8192


@pytest.mark.parametrize(
    "raw_endpoint",
    [
        None,
        "chat/completions",
        "/responses",
        "https://api.openai.com/v1/responses",
        "/v1/unknown",
        42,
    ],
    ids=["null", "missing-slash", "missing-v1", "full-url", "unsupported", "non-string"],
)
def test_config_rejects_invalid_endpoint(tmp_path, monkeypatch, raw_endpoint):
    """A present ai.endpoint must be one of the exact supported values."""
    _write_ai_config(tmp_path, monkeypatch, endpoint=raw_endpoint)

    from backend.config import load_config

    with pytest.raises(RuntimeError):
        load_config()


@pytest.mark.parametrize(
    "raw_value",
    [0, -1, True, "4096", 1.0, None, []],
    ids=["zero", "negative", "bool", "string", "float", "null", "list"],
)
def test_config_rejects_invalid_messages_default_max_tokens(
    tmp_path, monkeypatch, raw_value
):
    """messages_default_max_tokens must be a positive non-bool integer."""
    _write_ai_config(
        tmp_path, monkeypatch, messages_default_max_tokens=raw_value
    )

    from backend.config import load_config

    with pytest.raises(RuntimeError):
        load_config()


def test_config_messages_default_max_tokens_omitted(
    tmp_path, monkeypatch
):
    """Omitting messages_default_max_tokens yields the 4096 default."""
    _write_ai_config(tmp_path, monkeypatch)

    from backend.config import load_config

    cfg = load_config()
    assert cfg.messages_default_max_tokens == 4096


@pytest.mark.parametrize(
    "raw_api_base",
    ["", None, [], "/", "///"],
    ids=["empty-string", "null", "list", "slash-only", "slashes-only"],
)
def test_config_explicit_mode_rejects_invalid_api_base(
    tmp_path, monkeypatch, raw_api_base
):
    """Explicit mode rejects an empty or non-string api_base before use."""
    _write_ai_config(
        tmp_path,
        monkeypatch,
        endpoint="/v1/chat/completions",
        api_base=raw_api_base,
    )

    from backend.config import load_config

    with pytest.raises(RuntimeError):
        load_config()


# ---------------------------------------------------------------------------
# Parsing tests
# ---------------------------------------------------------------------------


def test_parse_errors_valid_json():
    """_parse_errors parses valid JSON array of errors."""
    from backend.providers import _parse_errors

    result = _parse_errors(
        '[{"start":0,"end":2,"error":"He","correction":"She","explanation":"pronoun","type":"error"}]'
    )
    assert len(result) == 1
    assert result[0].start == 0
    assert result[0].end == 2
    assert result[0].error == "He"
    assert result[0].correction == "She"


def test_parse_errors_markdown_fence():
    """_parse_errors strips markdown code fences."""
    from backend.providers import _parse_errors

    result = _parse_errors(
        '```json\n[{"start":0,"end":3,"error":"bad","correction":"good","explanation":"fix","type":"error"}]\n```'
    )
    assert len(result) == 1
    assert result[0].error == "bad"
    assert result[0].correction == "good"


def test_parse_errors_malformed_json():
    """_parse_errors raises HTTPException(502) on unparseable input."""
    from backend.providers import _parse_errors

    with pytest.raises(HTTPException) as exc_info:
        _parse_errors("not json at all")
    assert exc_info.value.status_code == 502


def test_parse_errors_empty_array():
    """_parse_errors returns empty list for []."""
    from backend.providers import _parse_errors

    result = _parse_errors("[]")
    assert isinstance(result, list)
    assert len(result) == 0


def test_parse_polished_valid():
    """_parse_polished extracts the polished field."""
    from backend.providers import _parse_polished

    result = _parse_polished('{"polished": "Hello world"}')
    assert result == "Hello world"


def test_parse_translated_valid():
    """_parse_translated extracts the translated field."""
    from backend.providers import _parse_translated

    result = _parse_translated('{"translated": "你好世界"}')
    assert result == "你好世界"


# ---------------------------------------------------------------------------
# AI call tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_do_ai_call_success(monkeypatch):
    """_do_ai_call returns structured result on success."""
    from backend.config import AIConfig, TimeoutConfig
    import httpx

    config = AIConfig(
        model="test-model",
        api_key="test-key",
        api_base="https://api.test.com/v1",
        timeout=TimeoutConfig(),
    )

    mock_response = MagicMock()
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "test content"}}],
        "usage": {"total_tokens": 42},
        "model": "test-model",
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        from backend.providers import _do_ai_call

        result = await _do_ai_call(
            body={"test": True},
            headers={"Authorization": "Bearer x"},
            timeout=httpx.Timeout(10),
            config=config,
            deadline=120,
        )

    assert result["content"] == "test content"
    assert result["tokens"] == 42
    assert result["model"] == "test-model"


@pytest.mark.asyncio
async def test_do_ai_call_retry_on_500(monkeypatch):
    """_do_ai_call retries once on HTTP 500 then succeeds."""
    from backend.config import AIConfig, TimeoutConfig
    import httpx

    config = AIConfig(
        model="test-model",
        api_key="test-key",
        api_base="https://api.test.com/v1",
        timeout=TimeoutConfig(),
    )

    fail_response = MagicMock()
    fail_response.status_code = 500
    fail_response.text = "Internal Server Error"
    fail_response.raise_for_status = MagicMock(
        side_effect=httpx.HTTPStatusError(
            "error", request=MagicMock(), response=fail_response
        )
    )

    ok_response = MagicMock()
    ok_response.json.return_value = {
        "choices": [{"message": {"content": "retry worked"}}],
        "usage": {"total_tokens": 1},
        "model": "test",
    }
    ok_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[fail_response, ok_response])

    with patch("httpx.AsyncClient", return_value=mock_client):
        with patch("asyncio.sleep", AsyncMock()):  # skip 1s delay
            from backend.providers import _do_ai_call

            result = await _do_ai_call(
                body={"test": True},
                headers={},
                timeout=httpx.Timeout(10),
                config=config,
                deadline=120,
            )

    assert result["content"] == "retry worked"
    assert mock_client.post.call_count == 2


@pytest.mark.asyncio
async def test_do_ai_call_timeout(monkeypatch):
    """_do_ai_call raises HTTPException(504) on timeout."""
    from backend.config import AIConfig, TimeoutConfig
    import httpx
    import asyncio as real_asyncio

    config = AIConfig(
        model="test-model",
        api_key="test-key",
        api_base="https://api.test.com/v1",
        timeout=TimeoutConfig(),
    )

    # Make asyncio.wait_for raise TimeoutError, then httpx.AsyncClient raises too
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(
        side_effect=real_asyncio.TimeoutError("timed out")
    )

    with patch("httpx.AsyncClient", return_value=mock_client):
        from backend.providers import _do_ai_call

        with pytest.raises(HTTPException) as exc_info:
            await _do_ai_call(
                body={"test": True},
                headers={},
                timeout=httpx.Timeout(10),
                config=config,
                deadline=120,
            )
        assert exc_info.value.status_code == 504

@pytest.mark.asyncio
@pytest.mark.parametrize("debug,expected_call_count", [(False, 0), (True, 2)])
async def test_do_ai_call_unexpected_error(monkeypatch, debug, expected_call_count):
    """_do_ai_call suppresses/emits traceback per debug flag, preserves error."""
    from backend.config import AIConfig, TimeoutConfig
    import httpx

    monkeypatch.setattr("backend.providers._load_debug", lambda: debug)

    config = AIConfig(
        model="test-model",
        api_key="test-key",
        api_base="https://api.test.com/v1",
        timeout=TimeoutConfig(),
    )

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=RuntimeError("simulated crash"))

    with patch("httpx.AsyncClient", return_value=mock_client):
        with patch("traceback.print_exc") as mock_print_exc:
            from backend.providers import _do_ai_call

            with pytest.raises(HTTPException) as exc_info:
                await _do_ai_call(
                    body={"test": True},
                    headers={},
                    timeout=httpx.Timeout(10),
                    config=config,
                    deadline=120,
                )
            assert mock_print_exc.call_count == expected_call_count
            assert exc_info.value.status_code == 502
            assert "Unexpected AI error" in exc_info.value.detail
            assert "RuntimeError" in exc_info.value.detail


@pytest.mark.asyncio
@pytest.mark.parametrize("debug,expected_call_count", [(False, 0), (True, 1)])
async def test_catch_all_handler_debug_gate(
    monkeypatch, debug, expected_call_count
):
    """catch_all_handler gates traceback.print_exc behind _load_debug,
    response payload unchanged."""
    monkeypatch.setattr("backend.routes._load_debug", lambda: debug)

    from backend.routes import catch_all_handler

    mock_request = MagicMock()
    exc = RuntimeError("simulated crash")

    with patch("traceback.print_exc") as mock_print_exc:
        resp = await catch_all_handler(mock_request, exc)

    assert mock_print_exc.call_count == expected_call_count
    assert resp.status_code == 500
    payload = json.loads(resp.body)
    assert payload == {"error": "Internal error: RuntimeError: simulated crash"}


# ---------------------------------------------------------------------------
# Provider adapter contract and Chat Completions tests
# ---------------------------------------------------------------------------


def _chat_config(**overrides):
    """Build an AIConfig for adapter tests, applying *overrides* last."""
    from backend.config import AIConfig

    fields = {
        "model": "test-model",
        "api_key": "test-key",
        "api_base": "https://gateway/v1",
        "endpoint": None,
    }
    fields.update(overrides)
    return AIConfig(**fields)


def _chat_payload():
    """A well-formed Chat Completions payload with two distinctly useful choices."""
    return {
        "model": "upstream-chat-model",
        "choices": [
            {"message": {"content": '{"operation": "result"}'}},
            {"message": {"content": "second choice content"}},
        ],
        "usage": {"total_tokens": 15},
    }


def _parse_chat(payload, configured_model="test-model"):
    """Parse *payload* with the Chat Completions adapter."""
    from backend.providers import ChatCompletionsAdapter

    return ChatCompletionsAdapter().parse_response(
        payload, configured_model=configured_model
    )


def test_provider_request_and_result_contracts():
    """ProviderRequest/ProviderResult expose exactly the documented keys."""
    from backend.providers import (
        ChatCompletionsAdapter,
        ProtocolAdapter,
        ProviderRequest,
        ProviderResult,
    )

    assert set(ProviderRequest.__annotations__) == {"url", "headers", "body"}
    assert set(ProviderResult.__annotations__) == {"content", "tokens", "model"}
    # The protocol declares both adapter methods; the adapter provides them.
    assert getattr(ProtocolAdapter, "_is_protocol", False)
    assert callable(ProtocolAdapter.build_request)
    assert callable(ProtocolAdapter.parse_response)
    adapter = ChatCompletionsAdapter()
    assert callable(adapter.build_request)
    assert callable(adapter.parse_response)


def test_adapter_response_error_is_dedicated_exception():
    """Envelope defects raise a dedicated error, never a generic builtin one."""
    from backend.providers import ProviderResponseError

    assert issubclass(ProviderResponseError, Exception)
    assert not issubclass(
        ProviderResponseError, (KeyError, IndexError, TypeError, ValueError)
    )


@pytest.mark.parametrize(
    "endpoint,api_base,expected_url",
    [
        (None, "https://gateway/v1", "https://gateway/v1/chat/completions"),
        (None, "https://gateway/v1/", "https://gateway/v1//chat/completions"),
        (None, "https://gateway", "https://gateway/chat/completions"),
        (
            "/v1/chat/completions",
            "https://gateway/proxy/",
            "https://gateway/proxy/v1/chat/completions",
        ),
        (
            "/v1/chat/completions",
            "https://gateway/proxy",
            "https://gateway/proxy/v1/chat/completions",
        ),
        (
            "/v1/chat/completions",
            "https://gateway/proxy/v1",
            "https://gateway/proxy/v1/v1/chat/completions",
        ),
        ("/v1/responses", "https://gateway/proxy/", "https://gateway/proxy/v1/responses"),
        ("/v1/messages", "https://gateway/proxy/", "https://gateway/proxy/v1/messages"),
    ],
    ids=[
        "legacy-v1-base",
        "legacy-trailing-slash-keeps-double-slash",
        "legacy-bare-base",
        "explicit-trailing-slash-base",
        "explicit-plain-base",
        "explicit-v1-prefixed-base",
        "explicit-responses",
        "explicit-messages",
    ],
)
def test_endpoint_url_matches_mode_contract(endpoint, api_base, expected_url):
    """Legacy mode concatenates /chat/completions; explicit mode appends the path."""
    from backend.providers import _endpoint_url

    config = _chat_config(endpoint=endpoint, api_base=api_base)
    assert _endpoint_url(config) == expected_url


def test_chat_adapter_build_request_legacy_mode():
    """Legacy mode targets the normalized /v1 base with a Bearer JSON request."""
    from backend.providers import ChatCompletionsAdapter

    config = _chat_config(endpoint=None, api_base="https://gateway/v1")
    request = ChatCompletionsAdapter().build_request(
        config=config,
        system_prompt="SYSTEM PROMPT",
        user_text="USER TEXT",
        temperature=0.1,
        max_tokens=None,
    )

    assert request["url"] == "https://gateway/v1/chat/completions"
    assert request["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
    }
    assert request["body"] == {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "SYSTEM PROMPT"},
            {"role": "user", "content": "USER TEXT"},
        ],
        "temperature": 0.1,
    }


def test_chat_adapter_build_request_explicit_mode():
    """Explicit mode appends the configured path without URL resolution."""
    from backend.providers import ChatCompletionsAdapter

    config = _chat_config(
        endpoint="/v1/chat/completions", api_base="https://gateway/proxy/"
    )
    request = ChatCompletionsAdapter().build_request(
        config=config,
        system_prompt="SYSTEM PROMPT",
        user_text="USER TEXT",
        temperature=0.3,
        max_tokens=None,
    )

    assert request["url"] == "https://gateway/proxy/v1/chat/completions"
    assert request["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
    }
    assert request["body"] == {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "SYSTEM PROMPT"},
            {"role": "user", "content": "USER TEXT"},
        ],
        "temperature": 0.3,
    }


@pytest.mark.parametrize(
    "max_tokens,expected",
    [
        (None, "omitted"),
        (0, "omitted"),
        (-1, "omitted"),
        (128, 128),
    ],
    ids=["none", "zero", "negative", "positive"],
)
def test_chat_adapter_max_tokens_matrix(max_tokens, expected):
    """Only a positive token limit reaches the request body."""
    from backend.providers import ChatCompletionsAdapter

    config = _chat_config(endpoint="/v1/chat/completions", api_base="https://gateway")
    body = ChatCompletionsAdapter().build_request(
        config=config,
        system_prompt="SYS",
        user_text="USER",
        temperature=0.3,
        max_tokens=max_tokens,
    )["body"]

    if expected == "omitted":
        assert "max_tokens" not in body
        assert set(body) == {"model", "messages", "temperature"}
    else:
        assert body["max_tokens"] == expected
        assert set(body) == {"model", "messages", "temperature", "max_tokens"}


def test_chat_adapter_places_prompts_and_temperature_verbatim():
    """System prompt and user text are copied verbatim, model/temperature retained."""
    from backend.providers import ChatCompletionsAdapter

    system_prompt = "SYSTEM  with  spaces\nand a newline"
    user_text = "  leading and trailing whitespace  \n\ttabbed  "
    config = _chat_config(model="gpt-4o-mini", endpoint=None)
    body = ChatCompletionsAdapter().build_request(
        config=config,
        system_prompt=system_prompt,
        user_text=user_text,
        temperature=0.42,
        max_tokens=64,
    )["body"]

    assert body["model"] == "gpt-4o-mini"
    assert body["temperature"] == 0.42
    assert body["messages"] == [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text},
    ]
    assert body["max_tokens"] == 64


def test_chat_adapter_normalizes_first_choice_and_usage():
    """Only choices[0].message.content, its model, and total_tokens are returned."""
    result = _parse_chat(_chat_payload())

    assert result == {
        "content": '{"operation": "result"}',
        "tokens": 15,
        "model": "upstream-chat-model",
    }
    assert "second choice content" not in result["content"]


def test_chat_adapter_accepts_empty_string_content():
    """An empty string is a legitimate content value."""
    payload = _chat_payload()
    payload["choices"][0]["message"]["content"] = ""
    assert _parse_chat(payload)["content"] == ""


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("usage"),
        lambda p: p["usage"].pop("total_tokens"),
        lambda p: p["usage"].__setitem__("total_tokens", 0),
    ],
    ids=["usage-absent", "total-tokens-absent", "total-tokens-zero"],
)
def test_chat_adapter_missing_usage_fields_default_to_zero(mutate):
    """Absent usage envelopes and absent total_tokens both yield 0 tokens."""
    payload = _chat_payload()
    mutate(payload)
    assert _parse_chat(payload)["tokens"] == 0


@pytest.mark.parametrize(
    "usage",
    [None, [], "usage", 15, True],
    ids=["null", "list", "string", "int", "bool"],
)
def test_chat_adapter_rejects_non_object_usage(usage):
    """A present but non-object usage envelope is a provider response error."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    payload["usage"] = usage
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


@pytest.mark.parametrize(
    "value",
    [None, -1, True, 1.0, 1.5, "1", [], {}],
    ids=["null", "negative", "bool", "float-integral", "float-fractional", "string", "list", "dict"],
)
def test_chat_adapter_rejects_invalid_total_tokens(value):
    """total_tokens must be a genuine non-negative integer; null is not absent."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    payload["usage"]["total_tokens"] = value
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


@pytest.mark.parametrize("field", ["prompt_tokens", "completion_tokens"])
@pytest.mark.parametrize(
    "value",
    [-1, True, 1.0, 1.5, "1", [], {}],
    ids=["negative", "bool", "float-integral", "float-fractional", "string", "list", "dict"],
)
def test_chat_adapter_rejects_invalid_auxiliary_token_counts(field, value):
    """Every present token-count field is validated, even when the total decides."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    payload["usage"][field] = value
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("choices"),
        lambda p: p.__setitem__("choices", []),
        lambda p: p.__setitem__("choices", {"message": {"content": "x"}}),
        lambda p: p.__setitem__("choices", "not a list"),
        lambda p: p.__setitem__("choices", ["not an object"]),
        lambda p: p.__setitem__("choices", [None]),
    ],
    ids=[
        "choices-absent",
        "choices-empty",
        "choices-object",
        "choices-string",
        "choice-not-object",
        "choice-null",
    ],
)
def test_chat_adapter_rejects_unusable_choices(mutate):
    """choices must be a non-empty array whose first entry is an object."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    mutate(payload)
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["choices"][0].pop("message"),
        lambda p: p["choices"][0].__setitem__("message", None),
        lambda p: p["choices"][0].__setitem__("message", "text"),
        lambda p: p["choices"][0]["message"].pop("content"),
        lambda p: p["choices"][0]["message"].__setitem__("content", None),
        lambda p: p["choices"][0]["message"].__setitem__("content", 5),
        lambda p: p["choices"][0]["message"].__setitem__("content", ["x"]),
    ],
    ids=[
        "message-absent",
        "message-null",
        "message-string",
        "content-absent",
        "content-null",
        "content-int",
        "content-list",
    ],
)
def test_chat_adapter_rejects_unusable_message_content(mutate):
    """A missing, null, or non-string content is a provider response error."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    mutate(payload)
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


@pytest.mark.parametrize(
    "model",
    [5, None, [], {}, True],
    ids=["int", "null", "list", "dict", "bool"],
)
def test_chat_adapter_rejects_present_non_string_model(model):
    """A present model must be a string; only an absent key falls back."""
    from backend.providers import ProviderResponseError

    payload = _chat_payload()
    payload["model"] = model
    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


def test_chat_adapter_falls_back_when_model_absent():
    """An absent model key uses the configured model."""
    payload = _chat_payload()
    payload.pop("model")
    assert _parse_chat(payload, configured_model="fallback-model")["model"] == (
        "fallback-model"
    )


@pytest.mark.parametrize(
    "payload",
    [None, [], "envelope", 7],
    ids=["null", "list", "string", "int"],
)
def test_chat_adapter_rejects_non_object_payload(payload):
    """The response envelope itself must be a JSON object."""
    from backend.providers import ProviderResponseError

    with pytest.raises(ProviderResponseError):
        _parse_chat(payload)


# ---------------------------------------------------------------------------
# OpenAI Responses adapter tests
# ---------------------------------------------------------------------------

#: Sentinel for "the envelope key is missing entirely" in parametrized cases.
_MISSING = object()


class _OutputRead(RuntimeError):
    """Raised when an adapter reads the guarded output list too early."""


class _GuardedOutput(list):
    """A real list that raises on every read of its contents.

    ``isinstance(guarded, list)`` stays True, so an adapter that validates the
    envelope in the wrong order reaches this object and trips it. A correctly
    ordered adapter rejects populated ``error``/``incomplete_details`` fields
    first and never touches the payload's output.
    """

    def _trip(self, how):
        raise _OutputRead(f"output read via {how} before envelope validation")

    def __getitem__(self, index):
        self._trip("__getitem__")

    def __iter__(self):
        self._trip("__iter__")

    def __len__(self):
        self._trip("__len__")

    def __contains__(self, item):
        self._trip("__contains__")

    def get(self, *args, **kwargs):
        self._trip("get")


def _responses_config(**overrides):
    """Build an AIConfig for Responses tests, applying *overrides* last."""
    from backend.config import AIConfig

    fields = {
        "model": "test-model",
        "api_key": "test-key",
        "api_base": "https://gateway/proxy/",
        "endpoint": "/v1/responses",
    }
    fields.update(overrides)
    return AIConfig(**fields)


def _responses_payload():
    """The approved Responses fixture: decoys plus three usable output_text parts."""
    return {
        "id": "resp_test",
        "object": "response",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "model": "upstream-responses-model",
        "output": [
            {
                "type": "reasoning",
                "summary": [
                    {"type": "output_text", "text": "<ignored non-message decoy>"}
                ],
            },
            {
                "type": "message",
                "id": "msg_test",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "<part 1>", "annotations": []},
                    {"type": "refusal", "text": "<ignored non-output_text decoy>"},
                    {"type": "output_text", "text": "<part 2>", "annotations": []},
                ],
            },
            {
                "type": "reasoning",
                "summary": [
                    {"type": "output_text", "text": "<ignored between-message decoy>"}
                ],
            },
            {
                "type": "message",
                "id": "msg_test_2",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "<part 3>", "annotations": []}
                ],
            },
        ],
        "usage": {"input_tokens": 7, "output_tokens": 8, "total_tokens": 99},
    }


def _parse_responses(payload, configured_model="test-model"):
    """Parse *payload* with the Responses adapter."""
    from backend.providers import ResponsesAdapter

    return ResponsesAdapter().parse_response(
        payload, configured_model=configured_model
    )


# -- request construction ---------------------------------------------------


def test_responses_adapter_build_request_explicit_mode():
    """Explicit mode appends /v1/responses and sends the exact Responses body."""
    from backend.providers import ResponsesAdapter

    config = _responses_config(api_base="https://gateway/proxy/")
    request = ResponsesAdapter().build_request(
        config=config,
        system_prompt="SYSTEM PROMPT",
        user_text="USER TEXT",
        temperature=0.1,
        max_tokens=None,
    )

    assert request["url"] == "https://gateway/proxy/v1/responses"
    assert request["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
    }
    assert request["body"] == {
        "model": "test-model",
        "instructions": "SYSTEM PROMPT",
        "input": "USER TEXT",
        "temperature": 0.1,
        "store": False,
    }


@pytest.mark.parametrize(
    "api_base,expected_url",
    [
        ("https://gateway/proxy/", "https://gateway/proxy/v1/responses"),
        ("https://gateway/proxy", "https://gateway/proxy/v1/responses"),
        ("https://gateway/proxy/v1", "https://gateway/proxy/v1/v1/responses"),
    ],
    ids=["trailing-slash-base", "plain-base", "v1-prefixed-base"],
)
def test_responses_adapter_url_is_plain_concatenation(api_base, expected_url):
    """Trailing slashes are trimmed; no URL resolution drops gateway prefixes."""
    from backend.providers import ResponsesAdapter

    config = _responses_config(api_base=api_base)
    request = ResponsesAdapter().build_request(
        config=config,
        system_prompt="SYS",
        user_text="USER",
        temperature=0.3,
        max_tokens=None,
    )
    assert request["url"] == expected_url


@pytest.mark.parametrize(
    "max_tokens,expected",
    [
        (None, "omitted"),
        (0, "omitted"),
        (-1, "omitted"),
        (128, 128),
    ],
    ids=["omitted", "zero", "negative", "positive"],
)
def test_responses_adapter_max_output_tokens_matrix(max_tokens, expected):
    """Only a positive token limit becomes max_output_tokens; store is always False."""
    from backend.providers import ResponsesAdapter

    config = _responses_config(api_base="https://gateway/proxy/")
    request = ResponsesAdapter().build_request(
        config=config,
        system_prompt="SYSTEM PROMPT",
        user_text="USER TEXT",
        temperature=0.3,
        max_tokens=max_tokens,
    )

    assert request["url"] == "https://gateway/proxy/v1/responses"
    assert request["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
    }
    body = request["body"]
    assert body["model"] == "test-model"
    assert body["instructions"] == "SYSTEM PROMPT"
    assert body["input"] == "USER TEXT"
    assert isinstance(body["input"], str)
    assert body["temperature"] == 0.3
    assert body["store"] is False

    if expected == "omitted":
        assert "max_output_tokens" not in body
        assert set(body) == {"model", "instructions", "input", "temperature", "store"}
    else:
        assert body["max_output_tokens"] == expected
        assert set(body) == {
            "model",
            "instructions",
            "input",
            "temperature",
            "store",
            "max_output_tokens",
        }


def test_responses_adapter_places_prompts_and_temperature_verbatim():
    """Instructions and input are copied verbatim; model/temperature are retained."""
    from backend.providers import ResponsesAdapter

    system_prompt = "SYSTEM  with  spaces\nand a newline"
    user_text = "  leading and trailing whitespace  \n\ttabbed  "
    config = _responses_config(model="gpt-4o-mini")
    body = ResponsesAdapter().build_request(
        config=config,
        system_prompt=system_prompt,
        user_text=user_text,
        temperature=0.42,
        max_tokens=64,
    )["body"]

    assert body["model"] == "gpt-4o-mini"
    assert body["instructions"] == system_prompt
    assert body["input"] == user_text
    assert body["temperature"] == 0.42
    assert body["max_output_tokens"] == 64
    assert body["store"] is False


# -- success extraction -----------------------------------------------------


def test_responses_adapter_normalizes_output_text_and_usage():
    """Only message output_text parts concatenate; total_tokens takes precedence."""
    result = _parse_responses(_responses_payload())

    assert result == {
        "content": "<part 1><part 2><part 3>",
        "tokens": 99,
        "model": "upstream-responses-model",
    }


def test_responses_adapter_falls_back_to_component_sum_when_total_null():
    """A null total_tokens sums the validated input/output components."""
    payload = _responses_payload()
    payload["usage"]["total_tokens"] = None

    assert _parse_responses(payload)["tokens"] == 15


@pytest.mark.parametrize("usage_state", [_MISSING, None], ids=["absent", "null"])
def test_responses_adapter_absent_or_null_usage_normalizes_to_zero(usage_state):
    """Responses allows an absent or explicitly null usage envelope."""
    payload = _responses_payload()
    if usage_state is _MISSING:
        payload.pop("usage")
    else:
        payload["usage"] = None

    assert _parse_responses(payload)["tokens"] == 0


def test_responses_adapter_falls_back_when_model_absent():
    """An absent model key uses the configured model."""
    payload = _responses_payload()
    payload.pop("model")

    assert _parse_responses(payload, configured_model="fallback-model")["model"] == (
        "fallback-model"
    )


# -- completion state -------------------------------------------------------


@pytest.mark.parametrize(
    "status",
    [
        _MISSING,
        None,
        False,
        1,
        {},
        "failed",
        "cancelled",
        "incomplete",
        "in_progress",
        "queued",
        "unknown-status",
    ],
    ids=[
        "missing",
        "null",
        "false",
        "int",
        "object",
        "failed",
        "cancelled",
        "incomplete",
        "in_progress",
        "queued",
        "unknown",
    ],
)
def test_responses_adapter_rejects_non_completed_status(status):
    """Only the exact string 'completed' is a usable envelope, despite usable text."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    if status is _MISSING:
        payload.pop("status")
    else:
        payload["status"] = status

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


def test_responses_adapter_rejects_failed_status_with_route_valid_text():
    """A failed envelope is rejected even when output holds parseable operation JSON."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    payload["status"] = "failed"
    payload["output"] = [
        {
            "type": "message",
            "content": [
                {"type": "output_text", "text": '{"polished":"Polished output"}'}
            ],
        }
    ]

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


@pytest.mark.parametrize(
    "error_state", [_MISSING, None], ids=["error-omitted", "error-null"]
)
@pytest.mark.parametrize(
    "details_state",
    [_MISSING, None],
    ids=["incomplete-details-omitted", "incomplete-details-null"],
)
def test_responses_adapter_accepts_absent_or_null_error_fields(
    error_state, details_state
):
    """A completed envelope is valid when both error fields are absent or null."""
    payload = _responses_payload()
    for field, state in (
        ("error", error_state),
        ("incomplete_details", details_state),
    ):
        if state is _MISSING:
            payload.pop(field)
        else:
            payload[field] = None

    assert _parse_responses(payload) == {
        "content": "<part 1><part 2><part 3>",
        "tokens": 99,
        "model": "upstream-responses-model",
    }


@pytest.mark.parametrize("field", ["error", "incomplete_details"])
@pytest.mark.parametrize(
    "value",
    [{}, {"code": "provider_error"}, [], ["populated"], "", "populated", False, True, 0, 1, 0.0, 1.5],
    ids=[
        "empty-object",
        "populated-object",
        "empty-array",
        "populated-array",
        "empty-string",
        "populated-string",
        "false",
        "true",
        "zero",
        "positive-int",
        "zero-float",
        "fractional-float",
    ],
)
def test_responses_adapter_rejects_populated_error_fields_before_output_access(
    field, value
):
    """Any present non-null error field is fatal before the output is read."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    payload["output"] = _GuardedOutput(payload["output"])
    payload[field] = value

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


def test_responses_guarded_output_trips_when_read():
    """Positive control: the guard fires if extraction is actually attempted."""
    payload = _responses_payload()
    payload["output"] = _GuardedOutput(payload["output"])

    with pytest.raises(_OutputRead):
        _parse_responses(payload)


# -- output shape validation ------------------------------------------------


def _only_content(content):
    """Build an output list holding one message item with *content*."""
    return [{"type": "message", "content": content}]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("output"),
        lambda p: p.__setitem__("output", None),
        lambda p: p.__setitem__("output", {"type": "message"}),
        lambda p: p.__setitem__("output", "not a list"),
        lambda p: p.__setitem__("output", []),
        lambda p: p.__setitem__("output", ["not an object"]),
        lambda p: p.__setitem__("output", [None]),
        lambda p: p.__setitem__("output", [{"type": "message"}]),
        lambda p: p.__setitem__("output", _only_content(None)),
        lambda p: p.__setitem__("output", _only_content("text")),
        lambda p: p.__setitem__("output", _only_content({"type": "output_text"})),
        lambda p: p.__setitem__("output", _only_content(["not a part"])),
        lambda p: p.__setitem__("output", _only_content([{"type": "output_text"}])),
        lambda p: p.__setitem__(
            "output", _only_content([{"type": "output_text", "text": None}])
        ),
        lambda p: p.__setitem__(
            "output", _only_content([{"type": "output_text", "text": 5}])
        ),
        lambda p: p.__setitem__(
            "output", _only_content([{"type": "output_text", "text": ["x"]}])
        ),
        lambda p: p.__setitem__(
            "output",
            [
                {
                    "type": "reasoning",
                    "summary": [{"type": "output_text", "text": "decoy"}],
                }
            ],
        ),
        lambda p: p.__setitem__(
            "output", _only_content([{"type": "refusal", "text": "decoy"}])
        ),
    ],
    ids=[
        "output-absent",
        "output-null",
        "output-object",
        "output-string",
        "output-empty",
        "output-item-string",
        "output-item-null",
        "content-absent",
        "content-null",
        "content-string",
        "content-object",
        "content-part-string",
        "output-text-absent",
        "output-text-null",
        "output-text-int",
        "output-text-list",
        "only-reasoning-decoy",
        "only-refusal-part",
    ],
)
def test_responses_adapter_rejects_unusable_output(mutate):
    """Missing/malformed output and unusable output_text parts are fatal."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    mutate(payload)

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


@pytest.mark.parametrize(
    "model",
    [5, None, [], {}, True],
    ids=["int", "null", "list", "dict", "bool"],
)
def test_responses_adapter_rejects_present_non_string_model(model):
    """A present model must be a string; only an absent key falls back."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    payload["model"] = model

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


@pytest.mark.parametrize(
    "payload",
    [None, [], "envelope", 7],
    ids=["null", "list", "string", "int"],
)
def test_responses_adapter_rejects_non_object_payload(payload):
    """The response envelope itself must be a JSON object."""
    from backend.providers import ProviderResponseError

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


# -- usage shape validation -------------------------------------------------


@pytest.mark.parametrize(
    "usage",
    [False, True, 1, "1", []],
    ids=["false", "true", "int", "string", "list"],
)
def test_responses_adapter_rejects_non_object_usage(usage):
    """A present non-object usage envelope is a provider response error."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    payload["usage"] = usage

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


@pytest.mark.parametrize("field", ["total_tokens", "input_tokens", "output_tokens"])
@pytest.mark.parametrize(
    "value",
    [-1, True, 1.0, 1.5, "1", [], {}],
    ids=[
        "negative",
        "bool",
        "float-integral",
        "float-fractional",
        "string",
        "list",
        "dict",
    ],
)
def test_responses_adapter_rejects_invalid_count_values(field, value):
    """Every token count must be an exact non-negative integer."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    # The fixture's other counts stay valid, so only *field* is at fault.
    payload["usage"][field] = value

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)


@pytest.mark.parametrize("component", ["input_tokens", "output_tokens"])
@pytest.mark.parametrize("state", [_MISSING, None], ids=["absent", "null"])
def test_responses_adapter_absent_or_null_components_keep_total(component, state):
    """Absent/null components stay valid and do not change total_tokens=99."""
    payload = _responses_payload()
    if state is _MISSING:
        payload["usage"].pop(component)
    else:
        payload["usage"][component] = None

    assert _parse_responses(payload)["tokens"] == 99


@pytest.mark.parametrize(
    "total_state", [_MISSING, None], ids=["total-absent", "total-null"]
)
@pytest.mark.parametrize(
    "input_state", [_MISSING, None], ids=["input-absent", "input-null"]
)
@pytest.mark.parametrize(
    "output_state", [_MISSING, None], ids=["output-absent", "output-null"]
)
def test_responses_adapter_absent_counts_normalize_to_zero(
    total_state, input_state, output_state
):
    """Absent/null totals and components all contribute zero."""
    payload = _responses_payload()
    usage = payload["usage"]
    for field, state in (
        ("total_tokens", total_state),
        ("input_tokens", input_state),
        ("output_tokens", output_state),
    ):
        if state is _MISSING:
            usage.pop(field)
        else:
            usage[field] = None

    assert _parse_responses(payload)["tokens"] == 0


def test_responses_adapter_null_total_still_validates_components():
    """A null total_tokens does not excuse an invalid component count."""
    from backend.providers import ProviderResponseError

    payload = _responses_payload()
    payload["usage"]["total_tokens"] = None
    payload["usage"]["input_tokens"] = "7"

    with pytest.raises(ProviderResponseError):
        _parse_responses(payload)
