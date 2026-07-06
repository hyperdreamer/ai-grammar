"""Test command palette, auto-strip, and partial->full auto-complete on WhatsApp Web."""
import os, time, subprocess, urllib.request, json
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"
KILL_FILE = "/tmp/close_whatsapp_full_test"

print("=== Cleanup ===")
singleton = PROFILE / "SingletonLock"
if singleton.exists(): singleton.unlink()
if os.path.exists(KILL_FILE): os.remove(KILL_FILE)

print("=== Check backend ===")
req = urllib.request.Request("http://127.0.0.1:8766/check", method="POST",
    data=json.dumps({"text":"ping","language":"auto"}).encode(),
    headers={"Content-Type":"application/json"})
resp = urllib.request.urlopen(req, timeout=10)
assert resp.status == 200, f"Backend not 200: {resp.status}"
print(f"Backend OK: {resp.status}")

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE), headless=False,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()
    page.goto("https://web.whatsapp.com/")

    # Find editor
    ta = None
    for sel in ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]',
                '[contenteditable="true"]', 'footer div[contenteditable="true"]']:
        try:
            page.wait_for_selector(sel, timeout=30000)
            ta = page.query_selector(sel)
            if ta: print(f"Found: {sel}"); break
        except: continue
    assert ta, "No editor found"
    time.sleep(2)

    def type_and_wait(text, wait_for_sel, timeout=120):
        ta.click()
        page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
        time.sleep(0.5)
        page.keyboard.type(text, delay=25)
        print(f"  Typed: '{text[:50]}...'")
        for i in range(timeout // 5):
            time.sleep(5)
            el = page.query_selector(wait_for_sel)
            if el: return True, el
        return False, None

    def editor_text():
        return page.evaluate("""() => {
            const t = document.querySelector('[contenteditable="true"][role="textbox"]');
            return t ? (t.textContent||'').replace(/\\u200B/g,'') : 'NO_EDITOR';
        }""")

    results = {}

    # ── Test 1: Auto-check baseline ────────────────────────────────────
    print("\n=== Test 1: Auto-check baseline ===")
    ok, _ = type_and_wait("He go work everyday buy bus.",
                          '.ai-grammar-error[data-live-draft]')
    results["auto-check underlines"] = "PASS" if ok else "FAIL"

    # ── Test 2: ?/fix auto-strip ───────────────────────────────────────
    print("\n=== Test 2: ?/fix auto-strip ===")
    ok, _ = type_and_wait("He go work everyday buy bus. ?/fix",
                          '.ai-grammar-badge')
    text = editor_text()
    has_cmd = "?/fix" in text
    results["?/fix strips command"] = "PASS" if not has_cmd else f"FAIL (still has ?/fix)"

    # ── Test 3: ?/polish auto-strip ────────────────────────────────────
    print("\n=== Test 3: ?/polish auto-strip ===")
    ok, _ = type_and_wait("He go work everyday buy bus. ?/polish",
                          '.ai-grammar-badge')
    text = editor_text()
    has_cmd = "?/polish" in text
    results["?/polish strips command"] = "PASS" if not has_cmd else f"FAIL (still has ?/polish)"

    # ── Test 4: Command palette shows ──────────────────────────────────
    print("\n=== Test 4: Command palette ===")
    ta.click()
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.3)
    page.keyboard.type("test ?/", delay=25)
    time.sleep(1)
    palette = page.query_selector('#ai-grammar-palette')
    results["palette appears on ?/"] = "PASS" if palette else "FAIL"
    if palette:
        items = palette.query_selector_all('.agp-item')
        results["palette has items"] = f"PASS ({len(items)} items)" if len(items) > 2 else f"FAIL ({len(items)})"

    # ── Test 5: Partial->full auto-complete ────────────────────────────
    print("\n=== Test 5: Partial->full auto-complete ===")
    ta.click()
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.3)
    # Type partial command ?/fi — should expand to ?/fix
    page.keyboard.type("hello ?/fi", delay=25)
    time.sleep(2)  # Wait for 600ms debounce + expansion
    text = editor_text()
    expanded = "?/fix" in text
    results["partial ?/fi expands"] = "PASS" if expanded else f"FAIL (text: '{text[:30]}')"

    # ── Results ────────────────────────────────────────────────────────
    print("\n" + "="*50)
    for name, result in results.items():
        status = "✅" if result.startswith("PASS") else "❌"
        print(f"  {status} {name}: {result}")

    passed = sum(1 for v in results.values() if v.startswith("PASS"))
    total = len(results)
    print(f"\n  {passed}/{total} tests passed")

    # ── Keep open ──────────────────────────────────────────────────────
    print(f"\nRun: touch {KILL_FILE}  to close")
    while not os.path.exists(KILL_FILE):
        time.sleep(2)
    ctx.close()
    print("Done.")
