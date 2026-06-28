# AI Grammar Checker

Chrome extension that detects grammar and spelling errors in submitted text using AI. Highlights errors inline and shows corrections in a tooltip.

## Architecture

```
extension/          # Chrome Extension (Manifest V3)
  manifest.json     # Permissions, content scripts, keyboard shortcut
  background.js     # Service worker — backend communication, state management
  content.js        # Content script — text detection, highlighting, tooltips
  popup.html        # Settings popup (enable/disable, language, host/port)
  popup.js          # Popup logic
backend/            # FastAPI server
  main.py           # /check endpoint — AI grammar correction
  config.yaml       # Active config (gitignored)
  config.example.yaml  # Documented example
  requirements.txt
```

## How It Works

1. **Content script** watches the page for newly submitted text (messages, comments, posts) using `MutationObserver`.
2. When new text blocks appear, the text is sent to the **background service worker**.
3. The background forwards it to the **FastAPI backend** (`POST /check`).
4. The backend calls an AI model (OpenAI, Anthropic, etc.) with a grammar-checking prompt.
5. The AI returns structured JSON with error positions and corrections.
6. Errors are shown in a **floating notification panel** (bottom-right) with the original text struck through and the correction in green.
7. The notification auto-dismisses after 30 seconds, or can be closed manually.

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
cp config.example.yaml config.yaml
# Edit config.yaml — set your AI provider, model, and API key
python main.py
```

The backend runs on `http://127.0.0.1:8766` by default.

### 2. Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory
4. The extension icon appears in the toolbar

## Usage

### Automatic mode (default)

Type and submit text in any message box, comment field, or post form. After submission, the extension automatically detects the new text and checks it for errors. Highlighted errors appear with wavy red underlines.

### Manual mode

1. Select any text on a page
2. Press `Ctrl+Shift+G` (Mac: `Cmd+Shift+G`)
3. Errors in the selection will be highlighted

### Popup settings

Click the extension icon to:
- Enable/disable the checker
- Select language (helps AI focus on language-specific errors)
- Configure backend host and port

### Inline commands (`?/` postfix)

Type these commands directly in any text input — the extension detects them **as you type** (no submit needed) and executes immediately, then strips the command from your input:

| Command | Action |
|---------|--------|
| `off?/` | Disable auto grammar checking |
| `on?/` | Enable auto grammar checking |
| `check?/` | Force grammar check of all text on the current page |
| `lang en?/` | Set language to English (also: zh, ja, ko, fr, de, es, ru, pt, it, ar, auto) |
| `help?/` | Show all available commands |

Commands use `?/` as a **postfix** (e.g., `off?/`), detected inline via a 600ms debounce after you stop typing.

## Configuration

### Environment variables

Set `GRAMMAR_HOST` and `GRAMMAR_PORT` to override the default listen address.

### AI Provider

The backend uses OpenAI-compatible chat APIs. Configure in `backend/config.yaml`:

```yaml
ai:
  provider: openai
  model: gpt-4o-mini          # Fast and cheap, good for grammar
  api_base: https://api.openai.com/v1
  api_key_env: OPENAI_API_KEY  # Reads from environment variable
```

Works with:
- OpenAI (gpt-4o-mini, gpt-4o)
- Anthropic (via compatible proxy)
- DeepSeek (deepseek-chat)
- Any OpenAI-compatible API (chat2api, local LLMs, etc.)

### Recommended models

| Model | Speed | Quality | Cost |
|---|---|---|---|
| gpt-4o-mini | Fast | Good | Very low |
| gpt-4o | Moderate | Excellent | Medium |
| claude-haiku | Fast | Good | Low |
| deepseek-chat | Moderate | Good | Very low |

Smaller models work well because grammar checking is a focused task with a structured output format.

## Keyboard Shortcut

| Action | Shortcut |
|---|---|
| Check selected text | `Ctrl+Shift+G` / `Cmd+Shift+G` |

## Limitations

- **Not realtime** — grammar checking runs after text is submitted, not while typing
- **Text only** — checks text content, not images or other media
- **Plain text areas only** — rich text editors (Google Docs, Notion) may not work reliably
- **Text length** — maximum 50,000 characters per check (configurable in backend)
