# Anthropic-Compatible Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Add validated OpenAI Responses and Anthropic Messages provider support, while preserving legacy Chat Completions behavior and the extension-facing `/check`, `/polish`, and `/translate` contracts.

**Architecture:** `backend/config.py` resolves legacy versus explicit endpoint configuration. `backend/providers.py` owns protocol-specific request/response adapters behind `ProviderRequest`, `ProviderResult`, and `ProtocolAdapter`, while one shared transport owns timeout, retry, and HTTP error mapping. `backend/routes.py` supplies unchanged operation prompts and consumes normalized results, so the browser extension remains unaware of the selected upstream protocol.

**Tech Stack:** Python 3, FastAPI, httpx, PyYAML, Pydantic, pytest, pytest-asyncio, and the existing standard-library typing/dataclass stack.

## Global Constraints

- Implement the feature in the FastAPI backend only; do not change extension request bodies, response keys, timeouts, parsers, or UI.
- The only supported explicit endpoint values are `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`.
- When `ai.endpoint` is absent, retain the current legacy `/v1` normalization and Chat Completions URL behavior, including the `/v1/` double-slash result.
- Explicit endpoints are appended to the configured base after trimming trailing slashes, without URL-resolution semantics and without discarding custom gateway prefixes.
- Do not add streaming, tool calls, multimodal input, conversation state, provider autodetection, arbitrary endpoint paths, or provider SDK dependencies.
- Preserve empty-text short circuits, 50,000-character truncation, existing operation prompts and temperatures, route-level JSON parsers, timeout values, retry count, and extension-facing response contracts.
- `ai.messages_default_max_tokens` defaults to `4096` and must be a positive integer when configured.
- Provider-response validation failures map to HTTP 502; only the existing asyncio deadline/native asyncio timeout path maps to HTTP 504.
- All provider tests use mocked HTTP responses and never contact an external provider.
- Leave `backend/models.py`, `backend/requirements.txt`, `extension/src/api.js`, all other extension source, and unrelated files unchanged.

## Task 1: Add endpoint-aware configuration loading

**Implementer tier:** Standard
**Lane:** backend

**Files:**
- Modify: `backend/config.py:11-148`
- Test: `tests/test_backend.py:142-182`

**Interfaces:**
- Consumes: existing YAML `ai` configuration keys `api_key`, `model`, `api_base`, `timeout`, `temperature`, and `endpoints`.
- Produces: `SUPPORTED_ENDPOINTS` as one immutable collection containing exactly `"/v1/chat/completions"`, `"/v1/responses"`, and `"/v1/messages"`.
- Produces: `DEFAULT_MESSAGES_MAX_TOKENS: int` equal to `4096`.
- Produces: frozen `AIConfig` fields `endpoint: str | None = None` and `messages_default_max_tokens: int = 4096`, in addition to the existing fields.
- Produces: `load_config() -> AIConfig`, where `endpoint is None` selects legacy mode and a validated endpoint selects explicit mode; `AIConfig.api_base` contains the mode-specific resolved base.

### Configuration tests
- [ ] **Step 1: Write the failing configuration tests.** Extend `tests/test_backend.py` with a YAML-writing helper that always supplies `ai.api_key: test-key-12345`, then parameterize the expected resolved URL inputs for legacy mode: omitted `api_base` -> `https://api.openai.com/v1`, `https://gateway` -> `https://gateway/v1`, `https://gateway/v1` -> unchanged, `https://gateway/` -> `https://gateway/v1`, and `https://gateway/v1/` -> unchanged with its trailing slash. Assert each loaded config has `endpoint is None` and `messages_default_max_tokens == 4096`.
- [ ] **Step 2: Add explicit-mode configuration cases before implementation.** Assert omitted `api_base` with each supported endpoint resolves to `https://api.openai.com`; assert `https://gateway/proxy/` resolves to `https://gateway/proxy`; assert `https://gateway/proxy/v1` remains `https://gateway/proxy/v1`; and assert a configured `messages_default_max_tokens: 8192` is retained.
- [ ] **Step 3: Pin exact configuration rejection cases.** Parameterize present `endpoint` values `null`, `"chat/completions"`, `"/responses"`, a full URL, `/v1/unknown`, and a non-string value, and assert `load_config()` raises `RuntimeError`. Parameterize `messages_default_max_tokens` values `0`, `-1`, `true`, `"4096"`, `1.0`, `null`, and `[]`, asserting `RuntimeError`; omit the key to assert the `4096` default. In explicit mode, parameterize `api_base` as `""`, `null`, and `[]`, asserting `RuntimeError` before any URL is returned.
- [ ] **Step 4: Run the focused tests and confirm they fail for the missing endpoint fields and mode-specific defaults.** Run `python -m pytest tests/test_backend.py -k 'config or endpoint or messages_default' -q`. The pre-implementation failure must identify missing `AIConfig` fields or legacy-only resolution rather than a test collection failure.

### Implementation and verification
- [ ] **Step 5: Add the constants and dataclass fields.** Define the exact supported endpoint collection and `DEFAULT_MESSAGES_MAX_TOKENS = 4096` near the existing defaults. Add the two frozen `AIConfig` fields with the specified defaults while retaining all existing temperature and timeout fields.
- [ ] **Step 6: Implement exact mode selection and validation in `load_config()`.** Distinguish an absent `endpoint` key from a present key using membership in `ai_section`; reject a present non-string or unsupported value with `RuntimeError`. Validate `messages_default_max_tokens` with `type(value) is int and value > 0`, rejecting booleans and all other types. In legacy mode use exactly `raw_base = ai_section.get("api_base", "https://api.openai.com/v1")`, then `raw_base.rstrip("/") + "/v1"` only when `raw_base.rstrip("/").endswith("/v1")` is false, preserving `https://gateway/v1/`. In explicit mode use default `https://api.openai.com`, reject an empty or non-string base, and store `raw_base.rstrip("/")` without adding or removing path segments. Keep API-key, timeout, and temperature behavior unchanged.
- [ ] **Step 7: Run the focused and existing backend tests.** Run `python -m pytest tests/test_backend.py -k 'config or endpoint or messages_default' -q` and then `python -m pytest tests/test_backend.py -q`; both commands must pass.
- [ ] **Step 8: Commit the configuration unit.** Run `git add backend/config.py tests/test_backend.py && git commit -m "feat(config): support explicit provider endpoints"`.

## Task 2: Define provider contracts and implement Chat Completions

**Implementer tier:** Advanced
**Lane:** backend

**Files:**
- Modify: `backend/providers.py:1-122`
- Test: `tests/test_backend.py:185-345`

**Interfaces:**
- Consumes: `AIConfig` from Task 1, including `model`, `api_key`, `api_base`, and `endpoint`.
- Produces: `ProviderRequest`, a `TypedDict` with `url: str`, `headers: dict[str, str]`, and `body: dict[str, Any]`.
- Produces: `ProviderResult`, a `TypedDict` with `content: str`, `tokens: int`, and `model: str`.
- Produces: `ProtocolAdapter`, a protocol with `build_request(*, config: AIConfig, system_prompt: str, user_text: str, temperature: float, max_tokens: int | None) -> ProviderRequest` and `parse_response(payload: object, *, configured_model: str) -> ProviderResult`.
- Produces: `ProviderResponseError`, an internal exception for malformed, missing, or unusable provider envelopes; adapters never perform network I/O and never raise a generic `KeyError`, `IndexError`, or `TypeError` for envelope defects.
- Produces: `_endpoint_url(config: AIConfig) -> str`, returning `config.api_base + "/chat/completions"` when `config.endpoint is None`, and `config.api_base.rstrip("/") + config.endpoint` for explicit mode.
- Produces: `ChatCompletionsAdapter`, implementing the `ProtocolAdapter` methods for both legacy and explicit Chat Completions modes.

### Contract and Chat tests
- [ ] **Step 1: Write the failing contract/request tests.** Add direct adapter tests that call `ChatCompletionsAdapter().build_request(...)` with `AIConfig(endpoint=None, api_base="https://gateway/v1", ...)` and with `endpoint="/v1/chat/completions", api_base="https://gateway/proxy/"`. Assert URLs are `https://gateway/v1/chat/completions` and `https://gateway/proxy/v1/chat/completions`, headers are exactly `Authorization: Bearer test-key` plus `Content-Type: application/json`, and the body contains only `model`, the two system/user messages, and `temperature` unless a positive token limit is supplied.
- [ ] **Step 2: Add the Chat token matrix.** Parameterize `max_tokens` as `None`, `0`, `-1`, and `128`; assert only `128` creates a `max_tokens` body key. Assert the system prompt and user text are placed verbatim in the message objects and the configured model and temperature are retained.
- [ ] **Step 3: Add the Chat normalization fixture and failures.** Use a payload with two choices, first content `<operation JSON>`, second distinct content, model `upstream-chat-model`, and usage `total_tokens: 15`; assert only the first content and `15` are returned. Add cases for absent usage -> `0`, `usage: null` -> `ProviderResponseError`, non-object usage -> error, absent `total_tokens` -> `0`, and null/non-negative-integer-invalid `total_tokens` -> error. With a valid `total_tokens: 15`, independently set each present `prompt_tokens` and `completion_tokens` to `-1`, `true`, `1.0`, `1.5`, `"1"`, `[]`, and `{}` and assert `ProviderResponseError`, proving every present token-count field is validated even when the total determines the result. Add missing/empty `choices`, missing `message`, missing `content`, null content, non-string content, and non-string present model cases; each must raise `ProviderResponseError`. Assert a missing model falls back to `configured_model`.
- [ ] **Step 4: Run the focused tests and confirm they fail before the adapter exists.** Run `python -m pytest tests/test_backend.py -k 'adapter or provider_request or chat or endpoint_url' -q` and record failures for the absent types/classes and behavior.

### Implementation and verification
- [ ] **Step 5: Add the shared provider types and strict JSON scalar helpers.** Import `TypedDict`, `Protocol`, and `Mapping`-compatible typing as needed. Implement `ProviderRequest`, `ProviderResult`, `ProtocolAdapter`, and `ProviderResponseError`. Add a private exact-integer helper that accepts only `type(value) is int and value >= 0`, rejecting booleans, floats including `1.0`, strings, arrays, objects, and negatives; add a private model helper that falls back only when the `model` key is absent and rejects a present non-string.
- [ ] **Step 6: Implement `_endpoint_url()` and `ChatCompletionsAdapter`.** Build the exact Bearer request body, include `max_tokens` only when `max_tokens > 0`, extract only `choices[0].message.content`, require it to be a string including an empty string, validate usage exactly as specified, and return a `ProviderResult`. Do not alter `_parse_errors()`, `_parse_polished()`, or `_parse_translated()` in this task.
- [ ] **Step 7: Run the adapter tests and the full current backend suite.** Run `python -m pytest tests/test_backend.py -k 'adapter or provider_request or chat or endpoint_url' -q`, then `python -m pytest tests/test_backend.py -q`; all must pass before committing.
- [ ] **Step 8: Commit the provider contract and Chat adapter.** Run `git add backend/providers.py tests/test_backend.py && git commit -m "feat(provider): add normalized Chat Completions adapter"`.

## Task 3: Implement strict OpenAI Responses adaptation

**Implementer tier:** Advanced
**Lane:** backend

**Files:**
- Modify: `backend/providers.py:40-246`
- Test: `tests/test_backend.py:250-442`

**Interfaces:**
- Consumes: `AIConfig` from Task 1 and `ProviderRequest`, `ProviderResult`, `ProtocolAdapter`, `ProviderResponseError`, `_endpoint_url`, and the exact non-negative-integer/model helpers from Task 2.
- Produces: `ResponsesAdapter`, implementing `build_request(...) -> ProviderRequest` and `parse_response(payload: object, *, configured_model: str) -> ProviderResult`.
- Produces: Responses request URL `config.api_base.rstrip("/") + "/v1/responses"`, Bearer authentication, `Content-Type: application/json`, and a body containing exactly `model`, `instructions`, `input`, `temperature`, `store: False`, plus `max_output_tokens` only for a positive caller limit.
- Produces: Responses normalization that accepts only a completed, error-free, complete envelope and returns concatenated `output_text` content, normalized integer usage, and the response model or configured fallback.

### Responses request and envelope tests
- [ ] **Step 1: Write the failing request tests.** Build a `ResponsesAdapter` request with positive, zero, omitted, and negative token limits. Assert the exact `/v1/responses` URL, Bearer headers, `instructions`, string `input`, `temperature`, and unconditional `store is False`; assert `max_output_tokens` exists only for `128`.
- [ ] **Step 2: Add the success fixture and extraction assertions.** Use the approved fixture containing reasoning decoys, two message items, `output_text` parts `<part 1>`, `<part 2>`, and `<part 3>`, a refusal decoy, model `upstream-responses-model`, and usage `input_tokens: 7`, `output_tokens: 8`, `total_tokens: 99`. Assert normalized content is exactly `<part 1><part 2><part 3>` and tokens are `99`. Add the same fixture with `total_tokens: null` and assert component sum `15`; add absent/null usage -> `0`.
- [ ] **Step 3: Pin completion-state and populated-error ordering.** Parameterize status as `completed`, `failed`, `cancelled`, `incomplete`, `in_progress`, `queued`, missing, null, non-string values (`false`, `1`, and `{}`), and an unknown string; every non-`completed` case must raise `ProviderResponseError` even with parseable output text. For `completed`, allow error/incomplete_details omitted or exactly null, but reject each independently when set to `{}`, a populated object, `[]`, a populated array, `""`, a populated string, `False`, `True`, `0`, a positive integer, `0.0`, or a non-integral float. Wrap the `output` value in an access-tracking mapping whose `get`/`__getitem__` raises if read, and assert populated error fields fail before output access.
- [ ] **Step 4: Pin output and usage shape validation.** Add missing/non-list output, malformed message/content lists, non-string output text, no usable `output_text`, and a present non-string model. Test absent/null usage -> `0`; reject non-object usage values `false`, `1`, `"1"`, and `[]`; cover missing/null `total_tokens` fallback and null/missing components -> `0`; and invalid count values `-1`, `True`, `1.0`, `1.5`, `"1"`, `[]`, and `{}` for each applicable count field. When `total_tokens: 99` is present, independently vary each present non-null component over every invalid value and assert failure; absent/null components remain valid and do not change `99`. Assert a null `total_tokens` falls back to validated component sum.
- [ ] **Step 5: Run the focused Responses tests and confirm they fail before the adapter exists.** Run `python -m pytest tests/test_backend.py -k 'responses' -q`.

### Implementation and verification
- [ ] **Step 6: Implement `ResponsesAdapter.build_request()`.** Use the exact body and headers above; keep `store` a JSON boolean `False`; use `max_output_tokens` only for `max_tokens > 0`; do not add streaming, tools, response-format, metadata, or other provider fields.
- [ ] **Step 7: Implement `ResponsesAdapter.parse_response()` in validation order.** Require a JSON object, require `status == "completed"`, reject any present non-null `error` or `incomplete_details` before touching `output`, require a list output with message items and content lists, concatenate only string `output_text.text` values in provider order without separators, and reject an empty selection. Normalize usage with `total_tokens` precedence while independently validating every present non-null component; allow absent/null usage as zero. Use the shared model helper and wrap every envelope defect in `ProviderResponseError`.
- [ ] **Step 8: Run the Responses tests and all existing backend tests.** Run `python -m pytest tests/test_backend.py -k 'responses' -q` and `python -m pytest tests/test_backend.py -q`; both must pass.
- [ ] **Step 9: Commit the Responses adapter.** Run `git add backend/providers.py tests/test_backend.py && git commit -m "feat(provider): support OpenAI Responses envelopes"`.

## Task 4: Implement Anthropic Messages adaptation

**Implementer tier:** Advanced
**Lane:** backend

**Files:**
- Modify: `backend/providers.py:40-246`
- Test: `tests/test_backend.py:250-442`

**Interfaces:**
- Consumes: `AIConfig` from Task 1, including `messages_default_max_tokens`; `ProviderRequest`, `ProviderResult`, `ProtocolAdapter`, `ProviderResponseError`, and the exact scalar/model helpers from Task 2.
- Produces: `MessagesAdapter`, implementing `build_request(...) -> ProviderRequest` and `parse_response(payload: object, *, configured_model: str) -> ProviderResult`.
- Produces: Messages request URL `config.api_base.rstrip("/") + "/v1/messages"`, headers exactly `x-api-key`, `anthropic-version: 2023-06-01`, and `Content-Type: application/json`, with no `Authorization` header.
- Produces: Messages request body containing exactly `model`, top-level `system`, one user message containing `user_text`, `temperature`, and mandatory effective `max_tokens`; positive caller limits win, while omitted/zero/negative limits use `config.messages_default_max_tokens`.
- Produces: Messages normalization that concatenates text blocks, sums input/output tokens, allows `stop_reason: "max_tokens"`, and rejects malformed response shapes through `ProviderResponseError`.

### Messages request and response tests
- [ ] **Step 1: Write the failing request tests.** Parameterize caller `max_tokens` as `None`, `0`, `-1`, and `128` with default fallback `4096`, then repeat with configured fallback `8192`. Assert the exact URL, exact three headers with no Bearer header, one user message, top-level system prompt, temperature, and effective `max_tokens`.
- [ ] **Step 2: Add the approved Messages success fixture.** Use thinking decoy plus text blocks `<part 1>` and `<part 2>`, `stop_reason: "end_turn"`, model `upstream-messages-model`, and input/output usage `7`/`8`; assert content `<part 1><part 2>`, tokens `15`, and upstream model selection. Assert absent model falls back to the configured model.
- [ ] **Step 3: Add truncation and response-shape cases.** Assert `stop_reason: "max_tokens"` preserves extracted content, any other string preserves extraction, and a present non-string stop reason raises `ProviderResponseError`. Add missing/non-list content, non-object blocks, non-string text, no text blocks, and a present non-string model. Assert absent usage normalizes to zero; reject null usage and non-object usage values `false`, `1`, `"1"`, and `[]`. For an object usage, allow missing/null individual counts as zero and reject each invalid count value `-1`, `true`, `1.0`, `1.5`, `"1"`, `[]`, and `{}` in both `input_tokens` and `output_tokens`. Add HTTP-success error-shaped objects with no usable content; each malformed envelope raises `ProviderResponseError`.
- [ ] **Step 4: Run the focused Messages tests and confirm they fail before the adapter exists.** Run `python -m pytest tests/test_backend.py -k 'messages' -q`.

### Implementation and verification
- [ ] **Step 5: Implement `MessagesAdapter.build_request()`.** Select the positive caller limit or the configured fallback, always emit `max_tokens`, put the system prompt at the top level, and serialize user text as exactly `[{"role": "user", "content": user_text}]`.
- [ ] **Step 6: Implement `MessagesAdapter.parse_response()`.** Require an object and a list `content`; inspect only blocks with `type == "text"`, require each selected `text` to be a string, concatenate in order without separators, and reject an empty selection. Treat a present non-string `stop_reason` as malformed but do not reject the valid string `"max_tokens"`. Require absent or object usage, sum validated `input_tokens` and `output_tokens`, and treat missing/null counts as zero. Do not reject truncated text at the adapter boundary.
- [ ] **Step 7: Run Messages tests and the full backend suite.** Run `python -m pytest tests/test_backend.py -k 'messages' -q` and `python -m pytest tests/test_backend.py -q`; both must pass.
- [ ] **Step 8: Commit the Messages adapter.** Run `git add backend/providers.py tests/test_backend.py && git commit -m "feat(provider): support Anthropic Messages"`.

## Task 5: Refactor shared transport and integrate all routes

**Implementer tier:** Capable
**Lane:** backend

**Files:**
- Modify: `backend/providers.py:40-122`
- Modify: `backend/routes.py:15-279`
- Test: `tests/test_backend.py:22-442`

**Interfaces:**
- Consumes: `AIConfig`, `ProviderRequest`, `ProviderResult`, `ProtocolAdapter`, `ProviderResponseError`, `ChatCompletionsAdapter`, `ResponsesAdapter`, `MessagesAdapter`, `_endpoint_url()`, and `_parse_errors()`, `_parse_polished()`, `_parse_translated()` from the previous tasks.
- Produces: `_get_adapter(config: AIConfig) -> ProtocolAdapter`, mapping `endpoint is None` and `/v1/chat/completions` to `ChatCompletionsAdapter`, `/v1/responses` to `ResponsesAdapter`, and `/v1/messages` to `MessagesAdapter`.
- Produces: `async def _do_ai_call(request: ProviderRequest, adapter: ProtocolAdapter, timeout: httpx.Timeout, config: AIConfig, deadline: float) -> ProviderResult`, the only network and retry seam. It posts `request.body` to `request.url` with `request.headers`, parses JSON, invokes `adapter.parse_response(...)`, and maps final failures to HTTP 502/504.
- Produces: `async def _call_provider(system_prompt: str, user_text: str, temperature: float, config: AIConfig, max_tokens: int | None = None) -> ProviderResult`, which selects an adapter, builds a request, constructs `httpx.Timeout` from all four `TimeoutConfig` values, sets `deadline = config.timeout.read + 5`, and calls `_do_ai_call()`.
- Preserves: `async def _call_ai(text: str, language: str, config: AIConfig, max_tokens: int | None = None) -> ProviderResult`, including the existing language suffix and check temperature, delegating to `_call_provider()`.
- Preserves route result shapes exactly: `/check` returns `errors`, `model`, `tokens_used`; `/polish` returns `polished`, `model`, `tokens_used`; `/translate` returns `translated`, `model`, `tokens_used`.

### Transport and route tests
- [ ] **Step 1: Add mocked HTTP helpers and protocol-valid fixtures.** In `tests/test_backend.py`, define deterministic fake responses/clients compatible with the current `httpx.AsyncClient` patch seam. Provide operation-valid Chat (`choices[0].message.content`), Responses (`status: completed` plus output text), and Messages (`content` text blocks) payloads with known models and token counts. Record URL, headers, and JSON body on each `post()` call.
- [ ] **Step 2: Add adapter-selection and `_call_provider()` tests.** Parameterize the four endpoint modes and assert `_get_adapter()` returns the specified class. Call `_call_provider()` with each protocol and assert the deadline uses `read + 5`, the timeout object receives connect/read/write/pool unchanged, and the normalized result is returned.
- [ ] **Step 3: Add the 36-case route/protocol/token matrix.** Parameterize `/check`, `/polish`, and `/translate` across explicit Chat, Responses, and Messages endpoints with omitted, `0`, and `128` caller token limits, plus the same three states through legacy Chat mode. Assert exact URLs, headers, prompt fields, user text, model, operation temperature, and protocol token-field rules: Chat `max_tokens` omitted unless positive; Responses `max_output_tokens` omitted unless positive and `store` always false; Messages always sends `4096` or configured fallback unless the positive caller limit is used. Assert local status `200`, exact route key set, normalized model/tokens, and no upstream fields leak into the local response.
- [ ] **Step 4: Add exact prompt and route-behavior assertions.** Assert `/check` uses the existing grammar prompt plus the language suffix only when language is not `auto`; `/polish` does not use `request.language`; `/translate` appends `Target language: English` for `en` and otherwise the target label. Send 60,000-character inputs and assert the provider receives exactly the first 50,000 characters. Keep route parser calls after successful provider normalization.
- [ ] **Step 5: Add configuration and endpoint short-circuit integration tests.** Parameterize invalid endpoint values and explicit empty/non-string `api_base`; patch `httpx.AsyncClient` and assert `load_config()` produces the existing configuration HTTP 500 without constructing a client or calling `post()`. For whitespace-only `/check`, `/polish`, and `/translate`, patch both `backend.config.load_config` and `httpx.AsyncClient` to raise if called; assert the existing empty 200 responses and zero tokens succeed without either call.
- [ ] **Step 6: Add Responses status/error route tests.** Run all statuses `completed`, `failed`, `cancelled`, `incomplete`, `in_progress`, `queued`, missing, null, and unknown through a non-empty route with parseable output; assert every non-completed result is HTTP 502 and the route parser is not called. For completed responses, test omitted/null error fields as successful and each falsey/truthy non-null `error` or `incomplete_details` value as HTTP 502 before output extraction. Test malformed output and usage values through the same backend error shape.
- [ ] **Step 7: Add Messages truncation parser tests.** For each route, return `stop_reason: "max_tokens"` and verify valid code-fenced text and valid operation JSON surrounded by prose still return 200 through the existing parser recovery. Assert unrecoverable or required-field-missing polish/translation JSON returns 502; assert check accepts valid arrays, rejects unrecoverable/non-array content, and skips malformed individual error items while returning remaining valid items or an empty array. Assert a route-level parser failure after a successful provider response makes only one provider call.
- [ ] **Step 8: Add shared transport retry/error tests.** Assert one HTTP 500 followed by success makes two calls with one one-second delay; final non-2xx maps to HTTP 502 with status and up to 500 response-text characters. Assert native `asyncio.TimeoutError` raised by mocked `post()` maps to HTTP 504 after two attempts; separately use a blocking awaitable longer than a small `asyncio.wait_for()` deadline and assert the same 504/two attempts. Assert `httpx.ReadTimeout` maps to 502 after two attempts. Assert malformed JSON, `ProviderResponseError`, and unexpected exceptions retry once and finish at 502, with debug-gated traceback call counts unchanged from the existing behavior. Do not retry a route parser failure because parsing happens after transport success.
- [ ] **Step 9: Run the new focused tests and confirm they fail before refactoring.** Run `python -m pytest tests/test_backend.py -k 'provider or route or transport or retry or protocol or empty or timeout' -q` and record failures for the old `_do_ai_call` signature, hard-coded URL, and inline route requests.

### Implementation and verification
- [ ] **Step 10: Refactor `_do_ai_call()` around `ProviderRequest` and `ProtocolAdapter`.** Remove URL/body/header construction from transport. Inside each of at most two attempts, define `make_request()` to create the existing `httpx.AsyncClient` limits, post the request, call `raise_for_status()`, parse JSON, and call `adapter.parse_response(payload, configured_model=config.model)`. Execute it as `await asyncio.wait_for(make_request(), timeout=deadline)` on every attempt. Catch `asyncio.TimeoutError` before httpx errors and map it to `HTTPException(status_code=504, detail="AI provider timed out")`; map HTTP status errors, request/timeout errors, JSON decode errors, `ProviderResponseError`, and unexpected exceptions to the existing 502 shape. Retry every listed failure after exactly one first-attempt delay and never delay after attempt two; retain debug traceback behavior.
- [ ] **Step 11: Implement `_get_adapter()`, `_call_provider()`, and the grammar wrapper.** Select the exact adapter mapping, build the `httpx.Timeout` from connect/read/write/pool, compute `config.timeout.read + 5`, and delegate. Preserve `_call_ai()` signature, prompt suffix, temperature lookup, and token argument while making it a thin `_call_provider()` wrapper.
- [ ] **Step 12: Replace inline route provider calls.** Remove `httpx` request construction from `polish_text()` and `translate_text()`. Keep all existing config exception handling, trimming, truncation, prompt construction, temperature lookup, parser calls, debug messages, response headers, empty short circuits, and JSON keys. Call `_call_provider()` with the exact system prompt, trimmed user text, selected temperature, config, and request token argument.
- [ ] **Step 13: Run all backend and compatibility tests.** Run `python -m pytest tests/test_backend.py -q`, then `python -m pytest -q`. The suite must pass without network access. Confirm the extension source remains unmodified with `git diff --name-only -- extension` returning no path.
- [ ] **Step 14: Commit the shared integration.** Run `git add backend/providers.py backend/routes.py tests/test_backend.py && git commit -m "feat(backend): route all operations through provider adapters"`.

## Task 6: Document explicit endpoint configuration and verify the deliverable

**Implementer tier:** Standard
**Lane:** documentation

**Files:**
- Modify: `backend/config.example.yaml:1-51`
- Modify: `README.md:1-221`

**Interfaces:**
- Consumes: final configuration behavior from `load_config()`, the three endpoint-to-protocol mappings, the exact authentication rules, and the unchanged local route/response contracts from Tasks 1 and 5.
- Produces: an example configuration whose `ai` section uses `endpoint: /v1/chat/completions`, `api_base: https://api.openai.com`, and `messages_default_max_tokens: 4096`.
- Produces: comments and README text documenting legacy omission behavior, the three exact explicit endpoint values, explicit gateway-prefix concatenation, mode-specific `api_base` defaults, Messages `x-api-key` authentication, OpenAI Bearer authentication, the Messages fallback token setting, and unchanged extension/backend contracts.

### Documentation tests and implementation
- [ ] **Step 1: Record documentation assertions before editing.** Use `rg -n` to locate the existing `/v1/chat/completions`, `/v1 auto-appended`, and configuration examples in `README.md` and `backend/config.example.yaml`; identify the statements that must be replaced while leaving extension setup, route names, response keys, UI documentation, and temperature documentation intact.
- [ ] **Step 2: Update `backend/config.example.yaml`.** Set the documented `ai` example to exactly include `model: gpt-4o-mini`, `endpoint: /v1/chat/completions`, `api_base: https://api.openai.com`, `api_key: $OPENAI_API_KEY`, and `messages_default_max_tokens: 4096`. Add comments stating that omitting `endpoint` retains legacy `/v1` normalization and Chat Completions, that only the three supported values are accepted, that explicit mode trims trailing base slashes while preserving gateway prefixes and defaults the base to `https://api.openai.com`, that the Messages fallback applies only without a positive caller limit, and that Messages uses `x-api-key` while both OpenAI protocols use Bearer authentication.
- [ ] **Step 3: Update the README backend configuration section.** Replace the claim that the backend always calls Chat Completions with the three endpoint/protocol choices and explicit example, add commented Responses and Messages alternatives, explain legacy omission versus explicit `api_base` defaults and custom gateway prefix preservation, document `messages_default_max_tokens`, and state that the browser extension continues to use the same local routes and response keys. Explain that Responses `store: false` disables storage of the generated response for later API retrieval only; provider and gateway retention policies, including abuse-monitoring logs, still apply. Do not claim that this setting prevents all retention. Do not alter extension setup, route table names, response key names, UI instructions, or unrelated model/temperature text.
- [ ] **Step 4: Run documentation and regression checks.** Run `git diff --check`; run `rg -n '/v1/chat/completions|/v1/responses|/v1/messages|messages_default_max_tokens|x-api-key|Bearer' backend/config.example.yaml README.md`; run `python -m pytest tests/test_backend.py -q` and `python -m pytest -q`. Confirm `git diff --name-only` lists only the task’s two documentation files relative to its starting commit.
- [ ] **Step 5: Commit the documentation unit.** Run `git add backend/config.example.yaml README.md && git commit -m "docs: describe configurable provider endpoints"`.

### Final plan-to-implementation acceptance checks
- [ ] **Step 6: Verify the complete implementation against the approved contract.** Confirm the full suite passes with `python -m pytest -q`, no provider network calls occur in tests, all 27 explicit route/protocol/token cases and 9 legacy Chat cases are present, and the final implementation has no changes under `extension/`, no provider SDK dependency, and no modification to `backend/models.py` or `backend/requirements.txt`.
