# AI Grammar Checker

Chrome MV3 extension that detects grammar, spelling, and style issues in text using AI. Works on any web page — WhatsApp Web, Microsoft Teams, generic text inputs, and CodeMirror editors exposed through open Shadow DOM. Highlights errors inline, shows corrections in tooltips, and offers one-click fixing, polishing, and translation.

## Architecture

```
extension/               # Chrome Extension (Manifest V3)
  manifest.json
  content.js             # Bundled shared modules (built from src/)
  src/                   # ESM source modules
    content.js           # Entry point — init, platform detection
    api.js               # Shared backend fetch wrappers (check, polish, translate)
    state.js             # Mutable state, safeGetStorage, escapeHtml
    styles.js            # CSS injection (underlines, tooltips, badges)
    dom-utils.js         # DOM helpers (shadow-aware event/text extraction)
    codemirror-bridge.js # Capability-based CodeMirror adapter + scroll support
    highlight.js         # Error highlighting (DOM + overlay strategies)
    tooltip.js           # Floating tooltip with smart positioning
    apply-correction.js  # Correction injection (beforeinput → execCommand → CDP fallback)
    indicators.js        # Badges (pending/result), green checks, error floats
    live-draft.js        # Live draft idle-poll checking + inline highlights
    check-text.js        # Post-submit grammar check pipeline
    mutation-observer.js # DOM mutation → detect new messages
    commands.js          # ?/fix, ?/polish, ?/lang, command palette, language picker
    languages.js         # 42-language map with search/autocomplete
    selection-check.js   # Manual selection → grammar check
    conversation.js      # Chat-scoped conversation key tracking
    events.js            # Tooltip/correction event delegation
  teams-bridge.js        # Teams CKEditor live-draft + command bar + error panel
  whatsapp-bridge.js     # WhatsApp DOM adapter (bidi normalization, overlay rendering)
  background.js           # Service worker — CKEditor MAIN-world bridge
  popup.html/js           # Settings popup
  package.json            # esbuild build config

backend/                 # FastAPI server
  config.py              # Config loading (yaml + env vars), dataclasses
  models.py              # Pydantic request/response models
  providers.py           # AI prompts, HTTP calls, response parsing, retry logic
  routes.py              # FastAPI app, CORS, endpoints (/check, /polish, /translate)
  main.py                # Entry point
  config.yaml            # Server + AI provider settings
  config.example.yaml
  requirements.txt

tests/                   # Test suite
  test_backend.py        # 24 pytest tests (config, parsing, endpoints, AI retry)
  test_*.py              # Playwright browser tests (extension, WhatsApp, and Pi WebUI)

.github/workflows/
  ci.yml                 # Backend pytest + extension build on push/PR
```

### Platform adapters

The extension uses a **thin adapter** pattern for platform-specific code:

| Bridge | Lines | Pattern | What it does |
|---|---|---|---|
| `whatsapp-bridge.js` | 499 | Thin DOM adapter (~95% platform-specific) | Bidi text normalization, WhatsApp DOM selectors, overlay rendering, chat-switch detection |
| `teams-bridge.js` | 1,593 | Substantial subsystem (~63% platform-specific) | CKEditor live-draft, floating command bar, error panel, translate picker, grammar toggle |

Shared modules drive all backend communication and badge/indicator logic via `window.__aiGrammar`. Platform bridges expose platform-specific APIs (e.g., `window.__aiWhatsApp`).

## Building

```bash
cd extension
npm install
npm run build      # esbuild bundles src/ → content.js (IIFE, ~137KB)
```

The bundled `content.js` is committed to the repo so the extension works without a build step.

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
cp config.example.yaml config.yaml
# Edit config.yaml — set your AI provider, model, and API key
python main.py          # Runs on http://127.0.0.1:8766
```

### 2. Extension

1. Open `chrome://extensions/`, enable "Developer mode"
2. Click "Load unpacked" → select the `extension/` directory
3. Click the extension icon to open settings

## Backend API

| Endpoint | Method | Purpose | Response |
|---|---|---|---|
| `/health` | GET | Health check | `{"status": "ok"}` |
| `/version` | GET | Extension version from manifest | `{"version": "7.4.1"}` |
| `/check` | POST | Grammar/spell check | `{"errors": [...], "model": "...", "tokens_used": N}` |
| `/polish` | POST | AI text polish/rewrite | `{"polished": "...", "model": "...", "tokens_used": N}` |
| `/translate` | POST | Language translation | `{"translated": "...", "model": "...", "tokens_used": N}` |

All endpoints accept `{"text": "...", "language": "auto"}`. The backend sends structured prompts to the configured provider protocol and parses the JSON response. The endpoint is selectable, but the local contract above is fixed: the browser extension keeps using these same routes and response keys regardless of which upstream protocol is configured.

### Provider endpoints

`ai.endpoint` selects the upstream protocol. Only these exact values are supported:

| `ai.endpoint` | Protocol | Authentication |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions | `Authorization: Bearer <key>` |
| `/v1/responses` | OpenAI Responses | `Authorization: Bearer <key>` |
| `/v1/messages` | Anthropic Messages | `x-api-key: <key>` (plus `anthropic-version: 2023-06-01`) |

Omitting `ai.endpoint` keeps the legacy behavior: `api_base` defaults to `https://api.openai.com/v1`, is normalized with `/v1` (appended unless it already ends in `/v1`, so a base ending in `/v1/` keeps that trailing slash and produces a `//` in the request URL), and the Chat Completions path is used.

With an explicit `ai.endpoint`, the path is appended to `api_base` after trimming trailing slashes — no URL resolution — so a custom gateway prefix is preserved rather than discarded. Explicit mode also defaults `api_base` to `https://api.openai.com` when it is omitted.

### Configuration

```yaml
# backend/config.yaml
server:
  host: 127.0.0.1
  port: 8766

ai:
  model: gpt-4o-mini
  endpoint: /v1/chat/completions       # OpenAI Chat Completions (Bearer auth)
  api_base: https://api.openai.com     # gateway prefix; the endpoint is appended
  api_key: $OPENAI_API_KEY             # $ prefix = read from env var
  messages_default_max_tokens: 4096    # /v1/messages fallback only

# ── or switch the upstream protocol ──
# ai:
#   endpoint: /v1/responses            # OpenAI Responses, still Bearer auth
#
# ai:
#   endpoint: /v1/messages             # Anthropic Messages, x-api-key auth
#   api_base: https://api.anthropic.com
```

`messages_default_max_tokens` (default `4096`, must be a positive integer) is the `max_tokens` value used for `/v1/messages` when the caller supplies no positive limit. The Messages protocol requires `max_tokens`; the OpenAI protocols simply omit the field when there is no caller limit. A positive caller limit always wins over this fallback.

With `/v1/responses`, each request sets `store: false`. This disables storage of the generated response for later API retrieval only — provider and gateway retention policies, including abuse-monitoring logs, still apply. It does not prevent all retention.

To change the AI temperature (defaults: check=0.1, polish=0.3, translate=0.3):
```yaml
ai:
  temperature: 1              # global override for all endpoints
  # ── or per-endpoint ──
  endpoints:
    check: 0.0
    polish: 0.7
```

Works with any provider exposing one of the three supported protocols — OpenAI, Anthropic, DeepSeek, local LLMs, and compatible gateways.

## Usage

### Auto-check (WhatsApp Web, Teams, generic pages)

- **Post-submit** — messages are checked automatically after sending (WhatsApp, generic textareas)
- **Live draft** — text you're composing is checked after a configurable pause (all platforms)
- **Manual selection** — `Ctrl+Shift+L` checks selected text

### Inline commands (`?/` prefix)

Type `?/` in any text input to open the command palette:

| Command | Action |
|---|---|
| `?/fix` | Auto-correct grammar errors in your draft |
| `?/polish` | AI-rewrite for clarity and naturalness |
| `?/check` | Force an immediate grammar check with inline highlights |
| `?/lang` | Translate to another language (42-language picker) |
| `?/off` / `?/on` | Toggle grammar checking |
| `?/help` | Show all available commands |

### Microsoft Teams

Teams uses CKEditor 5 — `?/` text commands don't work. Instead, a **floating command bar** appears above the editor:

| Button | Action |
|---|---|
| 🟢 On / 🔴 Off | Toggle grammar checking |
| ✨ Polish | AI-rewrite draft |
| 🔧 Fix | Auto-correct all errors |
| 🔍 Check | Immediate grammar check |
| 🌐 Translate | Language translation picker |

Errors appear in a popup panel with per-error corrections and an "Apply all fixes" button. The panel auto-dismisses as you type.

### Highlight colors

- 🔴 **Red underline** — error (spelling, grammar, punctuation)
- 🟢 **Green underline** — improvement (wordiness, awkward phrasing)
- 🔵 **Blue underline** — idiom (more natural expression)

## Popup Settings

| Setting | Default | Description |
|---|---|---|
| Enabled | ON | Toggle grammar checking globally |
| Language | Auto-detect | Language for error detection |
| Backend host | 127.0.0.1:8766 | Backend address |
| Live check delay | 5s | Idle time before auto-checking draft |
| Min characters | 30 | Minimum text length to trigger checking |
| Max tokens | 4096 | AI output token limit (0 = unbounded) |

## Testing

```bash
# Backend unit tests (no AI provider needed)
python -m pytest tests/test_backend.py -v     # 20 tests — config, parsing, endpoints, AI retry

# Browser integration tests (requires running backend + Chrome)
python tests/test_commands_local.py           # Command palette on contentEditable
python tests/test_full_commands.py            # Commands on WhatsApp Web profile

# Extension unit regressions + build verification
(cd extension && npm test && npm run build)

# Pi WebUI CodeMirror/open-Shadow-DOM regression
# Requires a Pi WebUI target and the grammar backend on :8766.
# Override AI_GRAMMAR_TARGET_URL when the target is not the local dev server.
python tests/test_pi_webui_shadow_dom.py
```

CI runs `pytest test_backend.py`, `npm test`, and `npm run build` on every push via GitHub Actions.

## Limitations

- **Text only** — no image/media checking
- **Max 50,000 characters** per check (configurable)
- **Teams CKEditor** — no inline underlines or `?/` commands (uses popup panel + command bar instead)
- **WhatsApp Lexical** — programmatic text insertion is blocked; clipboard fallback used
- **Requires running backend** on `localhost:8766`

## Recommended AI Models

| Model | Speed | Quality | Cost |
|---|---|---|---|
| `gpt-4o-mini` | Fast | Good | Very low |
| `gpt-4o` | Moderate | Excellent | Medium |
| `claude-haiku` | Fast | Good | Low |
| `deepseek-chat` | Moderate | Good | Very low |

Smaller models work well — grammar checking is a focused task with structured JSON output.
