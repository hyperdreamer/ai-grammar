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
