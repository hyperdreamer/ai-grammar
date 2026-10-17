# AI Provider Endpoint Support Design

## Background

The FastAPI backend currently sends `/check`, `/polish`, and `/translate` requests through the OpenAI-compatible Chat Completions protocol. `ai.api_base` is normalized to include `/v1`, and the backend appends `/chat/completions`. The extension communicates only with the backend routes and does not need to know which upstream protocol is configured.

The feature adds native OpenAI Responses and Anthropic Messages support, including Anthropic-compatible gateways, while retaining existing OpenAI-compatible behavior for current configurations.

## Goals

- Support the exact upstream endpoint paths `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`.
- Preserve the existing configuration and URL behavior when `ai.endpoint` is absent.
- Keep the extension-facing route and response contracts unchanged.
- Normalize provider-specific requests and responses behind one internal result shape.
- Document and test protocol-specific authentication, token limits, and response extraction.

## Non-Goals

- Streaming responses, tool calls, multimodal inputs, or conversation state.
- Arbitrary endpoint paths or provider-specific URL autodetection.
- Changes to the browser extension request format or user interface.
- New provider SDK dependencies.

## Configuration and URL Resolution

`ai.endpoint` is optional. If it is absent, preserve legacy behavior: when `api_base` is omitted, retain the current default `https://api.openai.com/v1`; normalize `api_base` to end in `/v1` (adding it only when missing), then send the request to `/chat/completions`. This preserves the URL produced by existing configurations, including configurations whose base already contains `/v1` and the current trailing-slash behavior.

When `ai.endpoint` is present, it must exactly equal one of:

- `/v1/chat/completions`
- `/v1/responses`
- `/v1/messages`

For explicit endpoints, if `api_base` is omitted, default it to `https://api.openai.com` without `/v1`. If configured, use `api_base` as written, trim trailing slashes from the base, ensure the endpoint begins with `/`, and concatenate the two strings. Do not use URL resolution that discards a custom gateway prefix. An explicit endpoint is a complete path relative to the configured base; the loader does not infer, append, or remove path segments.

The example configuration will show the explicit Chat Completions endpoint and document the Responses and Messages alternatives. `ai.messages_default_max_tokens` is a positive integer setting for the Messages protocol, defaulting to `4096`.

## Architecture and Data Flow

A protocol adapter selected by the configured endpoint owns request serialization, authentication headers, and response extraction. Check, polish, and translate provide their system prompt, user text, temperature, and optional output-token limit to the shared provider layer. The selected adapter produces a protocol request; shared HTTP transport retains the current timeout, deadline, and retry behavior. The adapter parses the upstream response into the existing internal `{content, tokens, model}` result used by route handlers and parsers.

The endpoint-to-protocol mapping is fixed:

| Endpoint | Protocol |
|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions |
| `/v1/responses` | OpenAI Responses |
| `/v1/messages` | Anthropic Messages |

### Chat Completions

Retain the current `messages` request shape, Bearer authentication, response extraction from `choices[0].message.content`, and existing token usage behavior. A positive caller token limit is sent as `max_tokens`; zero or omission continues to omit the field.

### OpenAI Responses

Send the system prompt as `instructions`, the user text as `input`, and temperature as `temperature`. Map a positive caller token limit to `max_output_tokens`; zero or omission leaves it out. Set `store: false` to disable storage of the generated response for later API retrieval. Provider and gateway retention policies, including abuse-monitoring logs, still apply. Authenticate with `Authorization: Bearer ...`.

Before extracting content, require a completed Responses envelope with `status: "completed"` and no provider `error` or `incomplete_details`. Treat `failed`, `cancelled`, `incomplete`, `in_progress`, `queued`, missing or unknown status, and any error or incomplete details as the existing upstream 502 behavior, even when the envelope contains parseable text. Extract and concatenate text from `output` message items' `content` parts whose type is `output_text`. Do not rely on SDK-only convenience properties. Normalize usage from the response usage object, preferring `total_tokens` when present and otherwise summing input and output token counts.

### Anthropic Messages

Send the system prompt in the top-level `system` field and the user text in a single user message. Authenticate with `x-api-key` and send `anthropic-version: 2023-06-01`.

Anthropic requires `max_tokens`: use the positive caller-supplied limit when present; otherwise, including a caller value of zero, use `ai.messages_default_max_tokens` (default `4096`). Extract and concatenate text blocks from the response `content` array whose type is `text`. Normalize token usage by summing input and output token counts. If `stop_reason` is `max_tokens`, retain any extracted text as a truncated but valid provider response; the existing route parser must reject invalid or incomplete JSON, missing required fields, or empty required text with its established upstream 502 behavior.

## Error Handling

Provider-specific HTTP errors continue through the shared retry and HTTP error mapping. Missing, malformed, or unusable protocol response fields become an upstream 502 response rather than an internal server error. Responses that are failed, cancelled, incomplete, queued, in progress, or otherwise unfinished are upstream failures even when text is present. Messages `stop_reason: max_tokens` is handled as described above; route-level parsers decide whether the truncated content is usable. Existing route-level JSON parsing and validation remain unchanged. Endpoint validation errors are reported as configuration errors before sending an upstream request.

## Testing Strategy

Backend unit tests will verify:

- Legacy URL normalization and Chat Completions URL when `endpoint` is absent, for omitted bases and bases both with and without `/v1`; characterize the current double-slash result for a legacy base ending in `/v1/`.
- Explicit endpoint mode with an omitted base, which must default to `https://api.openai.com`, and legacy mode with an omitted base, which must default to `https://api.openai.com/v1`.
- Acceptance of the three supported explicit endpoints and rejection of arbitrary paths.
- Explicit endpoint concatenation preserving gateway path prefixes and avoiding duplicate slash separators.
- Each protocol's exact URL, request body, authentication/version headers, text extraction, model selection, and token usage normalization.
- Positive, zero, and omitted token limits for all protocols, including the configurable 4096 Messages fallback.
- `store: false` for Responses requests, without asserting that provider or gateway retention is disabled.
- Responses envelopes with parseable JSON but failed, cancelled, incomplete, in-progress, queued, missing, or unknown completion status produce the established upstream error behavior.
- Messages responses with `stop_reason: max_tokens` preserve text extraction, while truncated or malformed JSON reaches the established route parser error behavior.
- Malformed or unsuccessful response shapes produce the established upstream error behavior.
- Non-empty requests from `/check`, `/polish`, and `/translate` are exercised through each protocol, while preserving their existing extension-facing response formats.

Tests use mocked HTTP responses and do not contact external providers. The full backend test suite remains the verification gate.

## Approved Decisions

- The existing Chat Completions endpoint is explicit as `/v1/chat/completions` in new configuration.
- Provider selection is determined by a validated endpoint, not URL autodetection or a second protocol setting.
- Existing configurations without `endpoint` preserve their current request URL behavior.
- Explicit endpoints are limited to the three supported paths and are appended to the configured base without URL-resolution semantics; omitted `api_base` defaults to `https://api.openai.com` in explicit mode.
- The legacy mode retains the current `https://api.openai.com/v1` default and normalization, including its existing trailing-slash behavior.
- The Messages fallback output limit is configurable and defaults to `4096`; the extension's current explicit limit remains unchanged.
- No extension UI or request-contract change is included.
