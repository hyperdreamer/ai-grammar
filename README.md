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
6. Issues are **highlighted inline** with colored wavy underlines:
   - 🔴 **Red** — errors (spelling, grammar, punctuation)
   - 🟢 **Green** — improvements (awkward phrasing, wordiness)
   - 🔵 **Blue** — idioms (more natural expressions)
7. **Hover or click** on highlighted text to see the correction in a tooltip. Click "Apply fix" to correct inline.

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

Click the extension icon to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Enabled** | ON | Toggle grammar checking |
| **Language** | Auto-detect | Focus on language-specific errors |
| **Backend host** | 127.0.0.1:8766 | Where the backend is running |
| **Live check delay** | 5s | How long after you stop typing before checking |
| **Min characters** | 30 | Minimum text length to trigger checking |
| **Max tokens** | 4096 | AI output limit (0 = unbounded) |

Changes save automatically as you type.

### Theme

The extension automatically matches your browser/OS theme — no manual toggle needed. Every UI surface (popup, test page, tooltips, error panels, command palette, status badge) uses `prefers-color-scheme` to render in light or dark mode. Switch your system to light mode and all extension UI follows.

### Inline commands (`?/` prefix)

Type `?/` in any text input to open the **command palette** — a popup menu listing all available commands. Use arrow keys to navigate, Enter to select, or click a command. You can also type the full command directly (e.g., `?/off`).

| Command | Action |
|---------|--------|
| `?/off` | Disable auto grammar checking |
| `?/on` | Enable auto grammar checking |
| `?/check` | Force grammar check of all text on the current page |
| `?/fix` | Auto-correct the text you typed (everything before `?/fix`) |
| `?/polish` | Polish/improve the text for clarity and naturalness (everything before `?/polish`) |
| `?/lang en` | Set language to English (also: zh, ja, ko, fr, de, es, ru, pt, it, ar, auto) |
| `?/help` | Show all available commands |

The palette opens when you type `?/`. Arrow keys navigate, Enter selects, Escape closes. Type more to filter (e.g., `?/o` filters to `?/off` and `?/on`). Prefix shortcuts auto-execute when only one match remains (e.g., `?/pol` → `?/polish`).

## Configuration

### Server

The backend listens on `127.0.0.1:8766` by default. Change in `backend/config.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 8766
```

### AI Provider

The backend uses OpenAI-compatible chat APIs. Configure in `backend/config.yaml`:

```yaml
ai:
  provider: openai
  model: gpt-4o-mini
  api_base: https://api.openai.com  # /v1 auto-appended
  api_key: ***            # reads from env var
  # api_key: sk-abc123    # or inline key

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
