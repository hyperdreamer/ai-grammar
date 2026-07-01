#!/usr/bin/env python3
"""
CDP Fixer daemon for AI Grammar Checker.

Listens on :8767 for POST /fix with {"text": "..."} from the extension.
Connects to Chromium's DevTools Protocol on :9222 and uses
Input.dispatchKeyEvent to clear the WhatsApp contentEditable and
retype the corrected text — exactly what Playwright does internally.
"""

import asyncio
import json
import logging
import sys

from aiohttp import web, ClientSession, ClientTimeout

logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format='[cdp-fixer] %(levelname)s %(message)s')
log = logging.getLogger('cdp-fixer')

CDP_BASE = "http://127.0.0.1:9222"
WA_PATTERN = "web.whatsapp.com"
FIXER_PORT = 8767


# ---------------------------------------------------------------------------
# CDP helpers
# ---------------------------------------------------------------------------

async def cdp_list_pages(session):
    """GET /json — list all debuggable pages."""
    try:
        async with session.get(f"{CDP_BASE}/json", timeout=ClientTimeout(total=3)) as resp:
            return await resp.json()
    except Exception as e:
        log.warning("CDP list pages failed: %s", e)
        return []


def find_whatsapp_page(pages):
    """Return the first page whose url contains web.whatsapp.com."""
    for p in pages:
        if WA_PATTERN in p.get("url", ""):
            return p
    return None


async def cdp_send(ws, method, params=None, wait_result=True):
    """Send a CDP command and optionally await the result."""
    msg_id = id(method)  # unique-ish per call
    payload = {"id": msg_id, "method": method}
    if params:
        payload["params"] = params

    await ws.send(json.dumps(payload))

    if not wait_result:
        return None

    # Read responses until we get one with matching id
    while True:
        raw = await ws.recv()
        resp = json.loads(raw)
        if resp.get("id") == msg_id:
            if "error" in resp:
                log.error("CDP error for %s: %s", method, resp["error"])
            return resp.get("result")


async def dispatch_key(ws, type_, key, code, modifiers=0, vk=0, text=None):
    """Dispatch a single keyboard event via CDP."""
    params = {
        "type": type_,
        "key": key,
        "code": code,
        "modifiers": modifiers,
        "windowsVirtualKeyCode": vk,
    }
    if text is not None:
        params["text"] = text
    # Don't wait for result on every key event — too slow
    await cdp_send(ws, "Input.dispatchKeyEvent", params, wait_result=False)


async def focus_contenteditable(ws):
    """Focus the WhatsApp contentEditable input via JS evaluation."""
    script = '''
    (() => {
        const el = document.querySelector('div[contenteditable="true"][role="textbox"]');
        if (el) { el.focus(); return true; }
        return false;
    })()
    '''
    result = await cdp_send(ws, "Runtime.evaluate", {
        "expression": script,
        "returnByValue": True,
    })
    if result and result.get("result", {}).get("value"):
        return True
    # Fallback: try broader selector
    script2 = '''
    (() => {
        const el = document.querySelector('footer div[contenteditable="true"], div[contenteditable="true"][data-placeholder], div[contenteditable="true"][aria-placeholder]');
        if (el) { el.focus(); return true; }
        return false;
    })()
    '''
    result = await cdp_send(ws, "Runtime.evaluate", {
        "expression": script2,
        "returnByValue": True,
    })
    return bool(result and result.get("result", {}).get("value"))


# ---------------------------------------------------------------------------
# Key dispatch sequences
# ---------------------------------------------------------------------------

# Character → key mapping for common chars
CHAR_MAP = {
    ' ':  ('Space', 'Space', 32),
    '.':  ('Period', 'Period', 190),
    ',':  ('Comma', 'Comma', 188),
    '!':  ('Exclamation', 'Digit1', 49, 1),   # Shift+1
    '?':  ('?', 'Slash', 191, 1),              # Shift+/
    "'":  ('\'', 'Quote', 222),
    '"':  ('"', 'Quote', 222, 1),              # Shift+'
    '-':  ('-', 'Minus', 189),
    ':':  (':', 'Semicolon', 186, 1),           # Shift+;
    ';':  (';', 'Semicolon', 186),
    '(':  ('(', 'Digit9', 57, 1),              # Shift+9
    ')':  (')', 'Digit0', 48, 1),              # Shift+0
    '\n': ('Enter', 'Enter', 13),
}


def char_to_key(c):
    """Map a single character to (key, code, vk, modifiers)."""
    if c in CHAR_MAP:
        entry = CHAR_MAP[c]
        if len(entry) == 4:
            return entry[0], entry[1], entry[2], entry[3]
        return entry[0], entry[1], entry[2], 0
    
    if c.isupper():
        lower = c.lower()
        return lower, f"Key{c.upper()}", ord(c.upper()), 1  # Shift
    if c.islower():
        return c, f"Key{c.upper()}", ord(c.upper()), 0
    if c.isdigit():
        return c, f"Digit{c}", ord(c), 0
    
    # Fallback: try to type the char using its code point
    return c, f"Key{c.upper()}", ord(c.upper()) if ord(c) < 256 else 0, 0


async def clear_and_type(ws, text, delay=0.02):
    """Clear the contentEditable and type the corrected text.

    Replicates the proven Playwright approach:
      1. Ctrl+A (select all)
      2. Backspace (delete)
      3. Type each character with delay
    """
    # Select all (Ctrl+A)
    await dispatch_key(ws, "keyDown", "a", "KeyA", modifiers=2, vk=65)
    await dispatch_key(ws, "keyUp", "a", "KeyA", modifiers=2, vk=65)
    await asyncio.sleep(0.05)

    # Delete (Backspace)
    await dispatch_key(ws, "keyDown", "Backspace", "Backspace", vk=8)
    await dispatch_key(ws, "keyUp", "Backspace", "Backspace", vk=8)
    await asyncio.sleep(0.1)

    # Type text character by character
    for c in text:
        key, code, vk, mods = char_to_key(c)
        await dispatch_key(ws, "keyDown", key, code, modifiers=mods, vk=vk, text=c)
        await dispatch_key(ws, "keyUp", key, code, modifiers=mods, vk=vk)
        await asyncio.sleep(delay)

    log.info("Typed %d characters", len(text))


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

async def handle_fix(request):
    """POST /fix — receive corrected text, type it via CDP."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

    text = (data.get("text", "") or "").strip()
    if not text:
        return web.json_response({"ok": False, "error": "No text provided"}, status=400)

    log.info("Fix request: %d chars", len(text))

    timeout = ClientTimeout(total=5)
    async with ClientSession(timeout=timeout) as session:
        # Find WhatsApp page
        pages = await cdp_list_pages(session)
        wa_page = find_whatsapp_page(pages)
        if not wa_page:
            log.warning("WhatsApp tab not found in %d pages", len(pages))
            return web.json_response({"ok": False, "error": "WhatsApp tab not found"})

        ws_url = wa_page.get("webSocketDebuggerUrl")
        if not ws_url:
            return web.json_response({"ok": False, "error": "No debugger URL for WhatsApp tab"})

        log.info("Connecting to %s", ws_url)

        try:
            # Import here to avoid dependency at module level
            import websockets
            async with websockets.connect(ws_url, max_size=2**24) as ws:
                # Enable runtime for JS evaluation
                await cdp_send(ws, "Runtime.enable")
                await asyncio.sleep(0.1)

                # Focus the contentEditable
                focused = await focus_contenteditable(ws)
                if not focused:
                    return web.json_response({"ok": False, "error": "Could not focus WhatsApp input"})

                await asyncio.sleep(0.2)

                # Clear and type
                await clear_and_type(ws, text)

            log.info("Fix applied successfully")
            return web.json_response({"ok": True})

        except Exception as e:
            log.error("CDP error: %s", e)
            return web.json_response({"ok": False, "error": str(e)})


async def handle_health(request):
    """GET /health"""
    return web.json_response({"status": "ok"})


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    app = web.Application()
    app.router.add_post("/fix", handle_fix)
    app.router.add_get("/health", handle_health)

    log.info("CDP Fixer starting on :%d (CDP port :9222)", FIXER_PORT)
    web.run_app(app, host="127.0.0.1", port=FIXER_PORT, print=lambda *a: None)


if __name__ == "__main__":
    main()
