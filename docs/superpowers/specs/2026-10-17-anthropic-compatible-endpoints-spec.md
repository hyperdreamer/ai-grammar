# Anthropic-Compatible Endpoints Technical Specification

## 1. Scope and implementation target

Implement the approved provider-endpoint design in the FastAPI backend only. The feature adds native support for these upstream protocols:

| Configured endpoint | Protocol | Adapter |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI Chat Completions | `ChatCompletionsAdapter` |
| `/v1/responses` | OpenAI Responses | `ResponsesAdapter` |
| `/v1/messages` | Anthropic Messages | `MessagesAdapter` |

The browser extension continues to call the same local routes and receives the same response keys:

- `POST /check` -> `{"errors": [...], "model": string, "tokens_used": integer}`
- `POST /polish` -> `{"polished": string, "model": string, "tokens_used": integer}`
- `POST /translate` -> `{"translated": string, "model": string, "tokens_used": integer}`

There is no streaming, tool-call, multimodal, conversation-state, provider-autodetection, arbitrary endpoint path, SDK dependency, extension request change, or extension UI change in this work.

The implementation must retain the existing empty-text short circuits, 50,000-character truncation, prompt text, route-level JSON parsers, timeout values, retry count, and extension-facing response contracts.

## 2. Files and symbols

### Required implementation files

- `backend/config.py`
  - Extend `AIConfig` with `endpoint: str | None` and `messages_default_max_tokens: int`.
  - Add the supported endpoint constants and the default Messages token limit.
  - Update `load_config()` to validate `ai.endpoint`, validate `ai.messages_default_max_tokens`, and resolve the mode-specific `api_base` value.
- `backend/providers.py`
  - Add the normalized request/result types and protocol adapter interface.
  - Add `ChatCompletionsAdapter`, `ResponsesAdapter`, and `MessagesAdapter`.
  - Add endpoint URL resolution and adapter selection.
  - Refactor `_do_ai_call()` into shared transport/retry/error mapping around an adapter request and parsed result.
  - Add a shared `_call_provider()` used by every non-empty route.
  - Preserve `_call_ai()` as the grammar-check wrapper, or update its callers and tests together if it is made a thin wrapper over `_call_provider()`.
  - Keep `_parse_errors()`, `_parse_polished()`, and `_parse_translated()` as the route-level content parsers, with their existing behavior.
- `backend/routes.py`
  - Keep `/check`, `/polish`, and `/translate` routes and their response JSON unchanged.
  - Replace the inline Chat Completions request construction in `polish_text()` and `translate_text()` with `_call_provider()`.
  - Keep the existing prompt construction, temperature selection, input trimming, config error handling, and route-level parsing.
  - Remove route-local `httpx` request construction once all three routes use the provider layer.
- `tests/test_backend.py`
  - Extend the existing backend tests with configuration, URL, adapter, response-validation, retry, route, and compatibility coverage described below.
- `backend/config.example.yaml`
  - Show explicit Chat Completions configuration and document the two alternatives and Messages fallback.
- `README.md`
  - Document endpoint selection, legacy behavior, explicit URL behavior, authentication differences, and `messages_default_max_tokens`.

### Files that must not change

- `extension/src/api.js` and other extension source files: no request or response contract change.
- `backend/models.py`: `CheckRequest`, `TranslateRequest`, and the response model fields remain unchanged. Comments may be clarified, but no extension-facing field is added or removed.
- `backend/requirements.txt`: use `httpx` and the existing standard-library/Pydantic stack; do not add provider SDKs.

## 3. Configuration model and validation

### 3.1 `AIConfig`

Add these fields to `AIConfig`:

```text
endpoint: str | None = None
messages_default_max_tokens: int = 4096
```

`api_base` remains a string containing the resolved base used by the provider layer. Its resolved value depends on whether the endpoint is legacy or explicit. `endpoint=None` is the legacy-mode marker.

Define a single immutable set/tuple of supported explicit endpoints:

```text
SUPPORTED_ENDPOINTS = {
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
}
```

Define `DEFAULT_MESSAGES_MAX_TOKENS = 4096` in `backend/config.py` and use it both for the dataclass default and the loader default.

### 3.2 Endpoint validation

The loader must distinguish an omitted key from a present key:

- If `ai.endpoint` is absent, set `endpoint=None` and select legacy mode.
- If `ai.endpoint` is present, it must be a string equal to one of the three supported values, byte-for-byte. Do not add a leading slash, strip a suffix, infer a protocol, or accept aliases such as `chat/completions`, `/responses`, or a full URL.
- A present YAML `null`, non-string value, or unsupported string is a configuration error.

Raise the same configuration-level exception class used by `load_config()` for other invalid configuration (currently `RuntimeError`) before any HTTP client is created. The route handlers must convert this to their existing HTTP 500 configuration-error response. The invalid configuration must not result in an upstream request.

### 3.3 Messages fallback validation

`ai.messages_default_max_tokens` is optional and defaults to `4096`.

- It must be a positive integer when configured.
- Reject zero, negative values, booleans, non-integer strings, and other types as configuration errors.
- The value is only used by the Messages adapter, but it is validated at load time so a bad configuration never reaches a request.

### 3.4 API base resolution

The loader must retain the current legacy algorithm exactly and use a separate explicit algorithm.

#### Legacy mode: endpoint omitted

Use this pseudocode, preserving the current handling of trailing slashes:

```text
raw_base = ai_section.get("api_base", "https://api.openai.com/v1")
if not raw_base.rstrip("/").endswith("/v1"):
    resolved_base = raw_base.rstrip("/") + "/v1"
else:
    resolved_base = raw_base
```

Store `resolved_base` in `AIConfig.api_base`. The Chat Completions URL is then:

```text
resolved_base + "/chat/completions"
```

This deliberately preserves the existing behavior for a configured base ending in `/v1/`: the stored base retains its slash and the final URL contains `/v1//chat/completions`. Do not silently normalize that existing legacy URL.

Examples:

| Configuration | Resolved URL |
| --- | --- |
| no `api_base` | `https://api.openai.com/v1/chat/completions` |
| `https://gateway` | `https://gateway/v1/chat/completions` |
| `https://gateway/v1` | `https://gateway/v1/chat/completions` |
| `https://gateway/` | `https://gateway/v1/chat/completions` |
| `https://gateway/v1/` | `https://gateway/v1//chat/completions` |

#### Explicit mode: endpoint present

Use the explicit endpoint as a complete path relative to `api_base`:

```text
raw_base = ai_section.get("api_base", "https://api.openai.com")
resolved_base = raw_base.rstrip("/")
request_url = resolved_base + endpoint
```

The endpoint is already validated to begin with `/`. Do not use `urllib.parse.urljoin()` or another URL-resolution operation that can discard a gateway prefix. Do not append `/v1`, remove `/v1`, or otherwise rewrite path segments in explicit mode.

Examples:

| `api_base` | `endpoint` | URL |
| --- | --- | --- |
| omitted | `/v1/responses` | `https://api.openai.com/v1/responses` |
| `https://gateway.example/proxy` | `/v1/messages` | `https://gateway.example/proxy/v1/messages` |
| `https://gateway.example/proxy/` | `/v1/messages` | `https://gateway.example/proxy/v1/messages` |
| `https://gateway.example/proxy/v1` | `/v1/messages` | `https://gateway.example/proxy/v1/v1/messages` |

A configured `api_base` is otherwise used as supplied after removing only trailing `/` characters in explicit mode. The loader must reject an empty/non-string base as a configuration error rather than constructing a relative URL.

## 4. Provider-layer interface

The provider layer must expose one small internal seam. Route handlers supply operation data; an adapter owns protocol serialization and response extraction; shared transport owns HTTP behavior.

Use these logical types in `backend/providers.py`:

```text
ProviderRequest:
    url: str
    headers: dict[str, str]
    body: dict[str, Any]

ProviderResult:
    content: str
    tokens: int
    model: str
```

`ProviderResult` may be implemented as a `TypedDict` so existing route code can continue using `result["content"]`, `result["tokens"]`, and `result["model"]`.

Define a `ProtocolAdapter` interface with exactly these responsibilities:

```text
build_request(
    *,
    config: AIConfig,
    system_prompt: str,
    user_text: str,
    temperature: float,
    max_tokens: int | None,
) -> ProviderRequest

parse_response(
    payload: object,
    *,
    configured_model: str,
) -> ProviderResult
```

The adapter must not perform network I/O and must not raise a generic exception for a malformed provider envelope. Raise an internal provider-response error (for example `ProviderResponseError`) that the shared transport maps to HTTP 502. Route-level content parser errors remain `HTTPException(status_code=502)` as they are today.

Add a selector such as `_get_adapter(config)` with this fixed mapping:

- `config.endpoint is None` -> Chat Completions adapter in legacy URL mode.
- `config.endpoint == "/v1/chat/completions"` -> Chat Completions adapter in explicit URL mode.
- `config.endpoint == "/v1/responses"` -> Responses adapter.
- `config.endpoint == "/v1/messages"` -> Messages adapter.

A separate `_endpoint_url(config)` helper should implement the two URL algorithms in Section 3.4 so URL behavior is directly unit-testable.

### 4.1 Shared provider call

Add `_call_provider(system_prompt, user_text, temperature, config, max_tokens)` as the common operation entry point. It must:

1. Select the adapter.
2. Build the protocol-specific `ProviderRequest`.
3. Build the existing `httpx.Timeout` from `config.timeout`.
4. Set `deadline = config.timeout.read + 5`.
5. Call `_do_ai_call()` with the request, adapter, timeout, config, and deadline.
6. Return the normalized `{content, tokens, model}` result.

Keep `_call_ai(text, language, config, max_tokens)` as the grammar-specific wrapper. It must append the existing language instruction when `language != "auto"`, select the check temperature, and delegate to `_call_provider()`.

`polish_text()` and `translate_text()` must delegate to `_call_provider()` with the same prompt and temperature inputs they currently construct inline. This removes protocol branching from the routes without changing route-level behavior.

## 5. Exact operation inputs

The route layer supplies these values to `_call_provider()`:

| Route | System prompt | User text | Temperature | Token argument |
| --- | --- | --- | --- | --- |
| `/check` | `GRAMMAR_SYSTEM_PROMPT`, plus the existing `The text is in {language}...` suffix when language is not `auto` | stripped and max-50,000-character-truncated request text | `config.get_temperature("check", DEFAULT_TEMPERATURE_CHECK)` | `request.max_tokens` |
| `/polish` | `POLISH_SYSTEM_PROMPT` | stripped and max-50,000-character-truncated request text | `config.get_temperature("polish", DEFAULT_TEMPERATURE_POLISH)` | `request.max_tokens` |
| `/translate` | `TRANSLATE_SYSTEM_PROMPT` plus `\n\nTarget language: {target_lang_label}`, where `en` maps to `English` | stripped and max-50,000-character-truncated request text | `config.get_temperature("translate", DEFAULT_TEMPERATURE_TRANSLATE)` | `request.max_tokens` |

Preserve the current behavior that `/polish` does not use `request.language` in its prompt and `/translate` uses `target_lang`, not `language`.

For all protocols, a caller token limit is considered positive only when it is greater than zero. The test matrix must cover the three externally relevant states: omitted (`None`), zero, and a positive value such as `128`. Negative values are also non-positive and follow the zero behavior.

## 6. Exact upstream requests

All request bodies are JSON objects. The adapter must not add streaming, tools, response-format, metadata, or provider-specific fields beyond those listed here.

### 6.1 OpenAI Chat Completions

URL:

- Legacy mode: `_endpoint_url(config)` using the legacy URL algorithm.
- Explicit mode: `api_base.rstrip("/") + "/v1/chat/completions"`.

Headers generated by the adapter:

```json
{
  "Authorization": "Bearer <api_key>",
  "Content-Type": "application/json"
}
```

Body for every route:

```json
{
  "model": "<config.model>",
  "messages": [
    {"role": "system", "content": "<operation system prompt>"},
    {"role": "user", "content": "<operation user text>"}
  ],
  "temperature": "<operation temperature>"
}
```

When the caller limit is positive, add exactly:

```json
"max_tokens": 128
```

When omitted or zero/non-positive, omit `max_tokens` entirely.

### 6.2 OpenAI Responses

URL: `api_base.rstrip("/") + endpoint`, where endpoint is exactly `/v1/responses`.

Headers:

```json
{
  "Authorization": "Bearer <api_key>",
  "Content-Type": "application/json"
}
```

Body for every route:

```json
{
  "model": "<config.model>",
  "instructions": "<operation system prompt>",
  "input": "<operation user text>",
  "temperature": "<operation temperature>",
  "store": false
}
```

When the caller limit is positive, add exactly:

```json
"max_output_tokens": 128
```

When omitted or zero/non-positive, omit `max_output_tokens` entirely. `store` must always be present and exactly `false`; this only disables storage for later API retrieval and does not promise that a provider or gateway will omit abuse-monitoring or other operational logs.

### 6.3 Anthropic Messages

URL: `api_base.rstrip("/") + endpoint`, where endpoint is exactly `/v1/messages`.

Headers:

```json
{
  "x-api-key": "<api_key>",
  "anthropic-version": "2023-06-01",
  "Content-Type": "application/json"
}
```

Do not send an `Authorization` header for this adapter.

Body for every route:

```json
{
  "model": "<config.model>",
  "system": "<operation system prompt>",
  "messages": [
    {"role": "user", "content": "<operation user text>"}
  ],
  "temperature": "<operation temperature>",
  "max_tokens": "<effective max tokens>"
}
```

`max_tokens` is mandatory for Messages. Use the positive caller limit when present. When the caller limit is omitted, zero, or negative, use `config.messages_default_max_tokens` (default `4096`).

## 7. Exact response normalization and validation

The adapter returns only the normalized provider result. The route parsers continue to decide whether the text contains the expected grammar/polish/translation JSON.

### 7.1 Common model and usage rules

- Use the response `model` string when it is present and valid; if it is absent, use `config.model`.
- A present non-string model is malformed and must become an upstream 502 rather than leaking `null` into a route response.
- A missing usage object is allowed and normalizes to `tokens=0`, unless the protocol-specific rules below define additional null handling.
- A non-null usage value must be a JSON object. The protocol-specific rules below define whether a null usage value is allowed.
- Every present token-count value must be an exact non-negative JSON integer. Reject booleans, floating-point values (including integral-valued floats), strings, arrays, objects, and negative integers with upstream HTTP 502. In Python, enforce an exact `int` type rather than `isinstance(value, int)` so booleans are rejected.
- Token counts normalize to integers.

### 7.2 Chat Completions response

Require:

- the top-level payload is an object;
- `choices` is a non-empty list;
- `choices[0]` is an object with a `message` object;
- `message.content` is a string, including an empty string if the route parser will reject it later.

Extract only `choices[0].message.content`. Do not concatenate additional choices.

If `usage` is absent, normalize tokens to `0`. If present, `usage` must be an object; `usage: null` is malformed. Use `usage.total_tokens` when present; if absent, use `0`. A present `total_tokens` must be an exact non-negative JSON integer, so null and other non-integer values produce HTTP 502. Do not synthesize a sum from prompt/completion fields.

Use `payload.model` when present, otherwise `config.model`.

### 7.3 Responses response

Require the top-level payload to be an object and validate completion state before reading usable text.

1. `status` must be exactly the string `"completed"`.
2. Missing, null, non-string, unknown, or non-completed values are unusable. In particular, `failed`, `cancelled`, `incomplete`, `in_progress`, and `queued` always produce HTTP 502, even if `output` contains parseable text.
3. `error` and `incomplete_details` are optional. Each field is valid only when it is absent or exactly JSON `null`. Any present non-null value is populated and produces HTTP 502, including an object, empty object, list, string, boolean, or number. A completed response with `error: null` and `incomplete_details: null` is valid.
4. `output` must be a list containing at least one message item with usable text. For each output item in order, inspect only items whose `type` is `"message"`; inspect their `content` list; for each content part whose `type` is `"output_text"`, require a string `text` and append it without inserting a separator. Ignore non-message output items and non-`output_text` content parts.
5. Missing output, malformed output/content lists, a non-string `output_text.text`, or no text-bearing `output_text` parts is an unusable envelope and produces HTTP 502.

The normalized content is the concatenation of all selected output text parts in provider order.

Usage normalization:

- If `usage` is absent or null, use `0`.
- If `usage` is present and non-null, it must be an object.
- If `usage.total_tokens` is present and non-null, it must be an exact non-negative JSON integer; use it as the normalized result, but still validate every present non-null `input_tokens` and `output_tokens` value independently.
- If `usage.total_tokens` is absent or null, sum `input_tokens` and `output_tokens` after validating them.
- For `input_tokens` and `output_tokens`, absent or null values contribute zero; every other present value must be an exact non-negative JSON integer, even when a valid `total_tokens` determines the result.
- Invalid usage or count values produce HTTP 502.

Use the response `model` when present, otherwise `config.model`.

### 7.4 Messages response

Require the top-level payload to be an object and `content` to be a list. For each block in order:

- inspect only blocks whose `type` is `"text"`;
- require `text` to be a string;
- concatenate all selected text values without inserting a separator;
- ignore non-text blocks.

A missing/malformed content list, a non-string text block, or no text blocks is an unusable envelope and produces HTTP 502. A successful response with `stop_reason: "max_tokens"` is not rejected by the adapter: return the text extracted so far, even though it may be truncated. Route parsing retains its existing behavior. All three route parsers strip Markdown code fences when present. If direct JSON parsing fails, `_parse_errors()` may recover a JSON array substring from surrounding prose, while `_parse_polished()` and `_parse_translated()` may recover a JSON object substring; preserve these recovery paths. The route returns HTTP 502 only when its existing parser cannot recover operation JSON it accepts or its existing checks reject the recovered value. For `/polish` and `/translate`, preserve the existing required-field and non-empty-string checks. For `/check`, the parsed or recovered value must be an array; malformed individual items follow `_parse_errors()`'s existing behavior and are skipped, so the route may return HTTP 200 with valid items or an empty array. Do not make the route parsers stricter in this feature.

For other stop reasons, retain the same extraction behavior. A present non-string `stop_reason` is malformed and produces HTTP 502; a valid string `"max_tokens"` is explicitly allowed.

Usage normalization always sums `input_tokens + output_tokens`. Missing or null individual counts contribute zero. A present non-object usage value or invalid/negative count produces HTTP 502.

Use the response `model` when present, otherwise `config.model`.

## 8. Shared timeout, retry, and error mapping

`_do_ai_call()` remains the only network transport and error-mapping seam for all adapters.

### Request timing and retries

- Construct `httpx.Timeout` from `TimeoutConfig.connect`, `.read`, `.write`, and `.pool` without changing defaults or units.
- Use the existing hard deadline `config.timeout.read + 5` for each attempt via `asyncio.wait_for()`.
- A native `asyncio.TimeoutError` raised inside `make_request()` is indistinguishable at the transport catch site from an `asyncio.wait_for()` expiry; both map to HTTP 504. `httpx.TimeoutException` (including `httpx.ReadTimeout`) remains an HTTP 502 provider error.
- Make at most two attempts total.
- After the first failed attempt, await the existing one-second delay before retrying. Do not delay after the second attempt.
- Retry policy remains shared across HTTP errors, transport errors, timeout errors, JSON decoding errors, adapter envelope-validation errors, and unexpected errors, matching the current `_do_ai_call()` behavior.

### Final error mapping

After the final attempt:

| Failure | Backend result |
| --- | --- |
| `asyncio.TimeoutError` observed by the transport boundary, whether from the outer `asyncio.wait_for()` deadline or raised natively inside `make_request()` | HTTP 504, detail `AI provider timed out` |
| Upstream non-2xx response | HTTP 502, detail includes upstream status and up to the first 500 characters of response text |
| `httpx` request/timeout error (including `httpx.ReadTimeout`) | HTTP 502, detail identifies the provider error |
| Invalid JSON body, malformed protocol envelope, unusable status/error/output/content/usage field | HTTP 502, never HTTP 500 |
| Unexpected exception | HTTP 502, preserving the current debug-gated traceback behavior and exception type in the detail |

The exact upstream 502 rule is: a non-empty route request that receives an HTTP-success response which is missing, malformed, unsuccessful, incomplete, or otherwise unusable at the selected protocol seam must result in an HTTP 502 response from the backend. It must not be converted to a successful route response merely because some text is present. FastAPI's response body remains its existing HTTPException shape, `{"detail": "..."}`. After text extraction, route-level parsing preserves the existing code-fence stripping and JSON-substring recovery behavior; return HTTP 502 when the route parser cannot recover operation JSON it accepts or its existing checks reject the recovered value.

In particular:

- An `asyncio.TimeoutError` raised natively inside `make_request()` and an actual outer deadline expiry both map to HTTP 504; test these separately because their sources differ even though the catch-site exception type is the same.
- An `httpx.TimeoutException` is not an `asyncio.TimeoutError` and maps to HTTP 502.
- Every Responses status other than exactly `completed` is HTTP 502.
- Responses `error` or `incomplete_details` values that are present and non-null are HTTP 502, even when status is `completed` and output text exists.
- Messages `stop_reason: max_tokens` is not itself HTTP 502; the route follows its existing parser behavior exactly as specified in Sections 7.4 and 12.
- A provider HTTP error is always mapped to backend 502, not passed through as the provider's status.

Do not let provider-response validation escape into the application catch-all as HTTP 500. Use the internal provider-response exception or an equivalent explicit mapping.

## 9. Route integration and extension compatibility

For non-empty input:

- `/check` loads config and calls `_call_ai()`; it then calls `_parse_errors()` and returns the existing `errors`, `model`, and `tokens_used` keys.
- `/polish` loads config and calls `_call_provider()` with `POLISH_SYSTEM_PROMPT`; it then calls `_parse_polished()` and returns the existing `polished`, `model`, and `tokens_used` keys.
- `/translate` loads config and calls `_call_provider()` with the current target-language prompt; it then calls `_parse_translated()` and returns the existing `translated`, `model`, and `tokens_used` keys.

For empty or whitespace-only input, retain the current immediate 200 response with empty output and zero tokens, without loading configuration or making an upstream request.

The extension-facing behavior remains compatible with `extension/src/api.js`:

- successful local responses still have status 200 and the same JSON property names;
- provider protocol, authentication, status, output parts, and usage fields never appear in the local response;
- local HTTP 502/504 errors continue to be consumed by the extension's existing `errorEnvelope()` path;
- no extension request body, timeout, URL, or parser changes are allowed.

## 10. Configuration example and README changes

Update `backend/config.example.yaml` to make explicit Chat Completions the documented new configuration:

```yaml
ai:
  model: gpt-4o-mini
  endpoint: /v1/chat/completions
  api_base: https://api.openai.com
  api_key: $OPENAI_API_KEY
  messages_default_max_tokens: 4096
```

The comments must document:

- omitting `endpoint` retains legacy `/v1` normalization and Chat Completions behavior;
- the only explicit endpoint values are `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`;
- explicit mode appends the endpoint to the configured gateway prefix after trimming trailing slashes;
- explicit mode defaults `api_base` to `https://api.openai.com` when omitted;
- `messages_default_max_tokens` is used only when Messages receives no positive caller limit and defaults to 4096;
- Messages authentication uses the configured key through `x-api-key`, while the two OpenAI protocols use Bearer authentication.

Update `README.md` to:

- replace the statement that the backend always calls `/v1/chat/completions`;
- describe the three endpoint/protocol choices and legacy omission behavior;
- show the explicit Chat Completions example and commented Responses/Messages alternatives;
- document that `api_base` has different defaults in legacy and explicit modes and that explicit paths preserve custom gateway prefixes;
- document the Messages fallback token setting and the fact that the extension/backend route contract is unchanged;
- leave extension setup, route names, response keys, and UI documentation unchanged.

## 11. Mock fixtures

Use deterministic mocked JSON fixtures in `tests/test_backend.py`. Tests must patch the existing `httpx.AsyncClient` seam or an equivalent injected transport and must never contact a provider.

### Chat Completions success fixture

```json
{
  "id": "chatcmpl_test",
  "object": "chat.completion",
  "model": "upstream-chat-model",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "<operation JSON>"},
      "finish_reason": "stop"
    },
    {
      "index": 1,
      "message": {"role": "assistant", "content": "<distinct second-choice JSON>"},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 7,
    "completion_tokens": 8,
    "total_tokens": 15
  }
}
```

Use `total_tokens: 15` as the normalized count and assert the normalized content is exactly the first choice's `<operation JSON>`, not the distinct second-choice content.

### Responses success fixture

```json
{
  "id": "resp_test",
  "object": "response",
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "model": "upstream-responses-model",
  "output": [
    {
      "type": "reasoning",
      "summary": [{"type": "output_text", "text": "<ignored non-message decoy>"}]
    },
    {
      "type": "message",
      "id": "msg_test",
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "<part 1>", "annotations": []},
        {"type": "refusal", "text": "<ignored non-output_text decoy>"},
        {"type": "output_text", "text": "<part 2>", "annotations": []}
      ]
    },
    {
      "type": "reasoning",
      "summary": [{"type": "output_text", "text": "<ignored between-message decoy>"}]
    },
    {
      "type": "message",
      "id": "msg_test_2",
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "<part 3>", "annotations": []}
      ]
    }
  ],
  "usage": {
    "input_tokens": 7,
    "output_tokens": 8,
    "total_tokens": 99
  }
}
```

Assert normalized content is exactly `<part 1><part 2><part 3>` (excluding the non-message and non-`output_text` decoys), proving extraction concatenates selected text across multiple messages in provider order. Assert normalized usage is `99`, proving `total_tokens` takes precedence. Add a variant with `total_tokens: null`, `input_tokens: 7`, and `output_tokens: 8`; it must fall back to the component sum `15`. With `total_tokens: 99`, test every present non-null component independently using negative integer, boolean, integral and non-integral float, numeric string, array, and object values; each must produce HTTP 502. Missing or null components remain valid and normalize to `99`.

### Messages success fixture

```json
{
  "id": "msg_test",
  "type": "message",
  "role": "assistant",
  "model": "upstream-messages-model",
  "content": [
    {"type": "thinking", "thinking": "<ignored non-text decoy>"},
    {"type": "text", "text": "<part 1>"},
    {"type": "text", "text": "<part 2>"}
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7,
    "output_tokens": 8
  }
}
```

Assert normalized content is exactly `<part 1><part 2>` (excluding the thinking block) and normalized usage is `15`.

Operation fixtures must substitute complete route-valid text:

- `/check`: `[]` or a valid error array;
- `/polish`: `{"polished":"Polished output"}`;
- `/translate`: `{"translated":"Translated output"}`.

### Unusable response fixtures

Add fixtures/parameterized cases for:

- Chat: missing `choices`, empty `choices`, missing `message`, missing `content`, `content: null`, and non-string content.
- Responses: missing status, `status: null`, each of `failed`, `cancelled`, `incomplete`, `in_progress`, and `queued`, an unknown status, `error: {"code":"provider_error"}`, `error: {}`, `incomplete_details: {"reason":"limit"}`, missing output, non-list output, malformed message/content lists, non-string output text, and no `output_text` parts. For error-field validation, test `error` and `incomplete_details` independently with falsey and truthy non-null values: `{}`, a populated object, `[]`, a populated array, `""`, a populated string, `false`, `true`, `0`, a positive integer, `0.0`, and a non-integral float. Each must produce HTTP 502 even when parseable operation text is present. Assert the route parser is not called for these cases. Add an adapter-level access-tracking mapping or equivalent sentinel around `output` and prove each populated error field is rejected before output extraction accesses it.
- Responses null cases: `error: null` and `incomplete_details: null` together must succeed when status is completed; either field omitted must also succeed; any non-null value must produce 502.
- Messages: missing/non-list content, non-string text, no text blocks, invalid usage, and HTTP-success error-shaped objects with no usable content.
- Usage/count validation for each adapter: absent usage; protocol-specific null usage; non-object usage values (boolean, number, string, array); missing counts; null counts where allowed; valid zero and positive counts; and invalid negative integer, boolean, float (including `1.0`), numeric string, array, and object count values. For Chat, cover absent usage, invalid null/non-object usage, absent `total_tokens` (zero), and null `total_tokens` (502). For Responses, cover null usage (zero), non-object usage (502), null `total_tokens` (fallback to components), null/missing components (zero), and `total_tokens` precedence. When `total_tokens: 99` is present, independently vary each present non-null `input_tokens` and `output_tokens` across every invalid count type and assert HTTP 502; absent/null components still yield `99`. For Messages, cover absent usage (zero), null/non-object usage (502), and null/missing input/output counts (zero).
- All protocols: mocked non-2xx responses with provider error JSON must map to backend 502 and exercise the shared retry path.

For every unsuccessful Responses fixture, include parseable operation text in the output where possible to prove status/error validation occurs before text acceptance. For the falsey/truthy `error` and `incomplete_details` cases, also prove extraction is not attempted, using the output-access sentinel described above.

## 12. Comprehensive mocked test matrix

Extend `tests/test_backend.py` with parametrized tests. The matrix must assert both the mocked HTTP call and the local route response.

### Configuration and URL matrix

| Case | Mode | `api_base` | `endpoint` | Expected URL/result |
| --- | --- | --- | --- | --- |
| 1 | legacy | omitted | omitted | `https://api.openai.com/v1/chat/completions` |
| 2 | legacy | `https://gateway` | omitted | `https://gateway/v1/chat/completions` |
| 3 | legacy | `https://gateway/v1` | omitted | `https://gateway/v1/chat/completions` |
| 4 | legacy | `https://gateway/v1/` | omitted | `https://gateway/v1//chat/completions` |
| 5 | explicit | omitted | `/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| 6 | explicit | omitted | `/v1/responses` | `https://api.openai.com/v1/responses` |
| 7 | explicit | omitted | `/v1/messages` | `https://api.openai.com/v1/messages` |
| 8 | explicit | `https://gateway/proxy/` | `/v1/messages` | `https://gateway/proxy/v1/messages` |
| 9 | explicit | `https://gateway/proxy` | `/v1/responses` | `https://gateway/proxy/v1/responses` |
| 10 | explicit | `https://gateway/proxy/v1` | `/v1/messages` | `https://gateway/proxy/v1/v1/messages` |

Also test every supported endpoint is accepted, and arbitrary paths, full URLs, missing leading slashes, null, and non-string endpoint values are rejected before an `httpx.AsyncClient` is constructed or `post()` is called. In explicit mode, test empty and non-string `api_base` values are rejected under the same no-construction/no-post assertion. For each of `/check`, `/polish`, and `/translate`, add whitespace-only input cases that make both `load_config()` and the `AsyncClient` constructor fail if called; assert the existing empty response succeeds without either call.

### Route/protocol/token matrix

Exercise all 3 routes through all 3 explicit protocols, with all 3 token states:

| Route | Protocols | Token states |
| --- | --- | --- |
| `/check` | Chat, Responses, Messages | omitted, `0`, `128` |
| `/polish` | Chat, Responses, Messages | omitted, `0`, `128` |
| `/translate` | Chat, Responses, Messages | omitted, `0`, `128` |

This is 27 route/protocol/token cases. Add the same three token states for legacy-mode Chat Completions route calls so the legacy compatibility path is exercised, for 9 additional cases.

For each case assert:

1. URL is exactly the configured/mapped URL.
2. Headers exactly match the selected protocol requirements.
3. Prompt and user text are in the protocol-specific fields.
4. Model and temperature are present with existing values.
5. Chat omits `max_tokens` for omitted/zero and includes positive `max_tokens`.
6. Responses omits `max_output_tokens` for omitted/zero and includes positive `max_output_tokens`.
7. Responses always includes `store: false`.
8. Messages sends `max_tokens: 4096` for omitted/zero and `max_tokens: 128` for positive, or the configured fallback when set to another positive value.
9. The local route returns the unchanged route-specific response keys and normalized model/token values.

### Responses status/error matrix

Parameterize the completion-status cases `completed`, `failed`, `cancelled`, `incomplete`, `in_progress`, `queued`, missing, null, and unknown. For `completed`, parameterize:

- both error fields omitted;
- both fields null;
- `error` omitted and `incomplete_details` null;
- `error` null and `incomplete_details` omitted;
- each field independently set to a non-null object, empty object, list, string, boolean, and number;
- both fields populated with non-null values;
- malformed output.

For every non-null value above, test `error` and `incomplete_details` independently with both falsey and truthy values (empty/populated object, array, and string; `false`/`true`; zero/positive integer; zero/non-integral float) and assert HTTP 502. Include parseable route-valid output, assert the route parser is not invoked, and add the adapter-level output-access sentinel to prove error validation precedes extraction. Only the four omitted/null combinations without other faults may reach route parsing. All other cases must return HTTP 502.

### Messages truncation matrix

For each route, mock `stop_reason: "max_tokens"` and verify the unchanged route-parser behavior:

- All routes: a valid code-fenced operation response and a valid operation JSON substring surrounded by prose are accepted with HTTP 200, proving existing fence stripping and substring recovery remain intact.
- `/polish` and `/translate`: complete valid route JSON -> HTTP 200; truncated/unrecoverable JSON, a recovered value missing the required field, or empty required text -> HTTP 502.
- `/check`: valid `[]` or a valid error array -> HTTP 200; text from which no array can be recovered, or a recovered non-array JSON value -> HTTP 502. A syntactically valid or recovered array with malformed individual items must retain `_parse_errors()` behavior: skip malformed items and return HTTP 200 with remaining valid items or an empty array if none remain.

These cases prove that the adapter preserves truncated text and does not treat `max_tokens` as a provider-envelope failure, while route parsing retains its existing behavior without making the parsers stricter.

### Shared transport matrix

Retain and generalize the existing tests for:

- one HTTP 500 followed by success -> two calls, one retry, successful result;
- final HTTP failure -> HTTP 502 with status/detail mapping;
- a native `asyncio.TimeoutError` raised from mocked `post()` -> HTTP 504 after two attempts;
- a blocking mocked `post()` that exceeds the actual `asyncio.wait_for()` deadline -> HTTP 504 after two attempts;
- an `httpx.ReadTimeout` -> HTTP 502 after two attempts;
- unexpected exception with debug disabled/enabled -> same 502 result and current traceback call counts;
- malformed JSON/envelope -> retry once, then HTTP 502;
- route-level operation text that the existing parser cannot recover or rejects -> HTTP 502 without a second provider request, because the route parser runs after transport succeeds; fenced and prose-wrapped recoverable JSON must instead succeed as specified in the parser matrix.

### Extension-facing compatibility matrix

For each route and each protocol, run a valid non-empty request and assert exact local JSON key sets:

- `/check`: keys are `errors`, `model`, `tokens_used`;
- `/polish`: keys are `polished`, `model`, `tokens_used`;
- `/translate`: keys are `translated`, `model`, `tokens_used`.

Assert that no upstream fields such as `status`, `output`, `content`, `stop_reason`, `usage`, or provider error objects leak into the local response. Existing extension tests and `extension/src/api.js` remain unchanged.

## 13. Acceptance criteria

The implementation is ready when:

1. Existing configurations with no `ai.endpoint` produce the same Chat Completions URL, including the `/v1/` trailing-slash result.
2. Explicit configurations select exactly one of the three adapters and preserve custom gateway prefixes.
3. All request bodies and headers match Section 6 exactly.
4. All response extraction and usage rules match Section 7, including Responses null-versus-populated error fields and Messages `max_tokens` handling.
5. Every malformed, incomplete, failed, or otherwise unusable provider envelope produces backend HTTP 502, while outer deadline expiry remains HTTP 504.
6. Messages `stop_reason: max_tokens` reaches route parsing, with each route retaining its existing parser behavior exactly as specified in the truncation matrix.
7. `/check`, `/polish`, and `/translate` return unchanged extension-facing response contracts across all protocols.
8. The configuration example and README describe both legacy and explicit modes accurately.
9. The complete mocked test matrix passes without network access.
10. No extension implementation code, provider SDK, or commit is added as part of the specification work.
