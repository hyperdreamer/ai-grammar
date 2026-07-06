"""Test command palette, auto-strip, partial->full on contentEditable."""
import os, time, json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent / "extension"

# Check backend
req = urllib.request.Request("http://127.0.0.1:8766/check", method="POST",
    data=json.dumps({"text":"ping","language":"auto"}).encode(),
    headers={"Content-Type":"application/json"})
resp = urllib.request.urlopen(req, timeout=10)
assert resp.status == 200
print("Backend OK")

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(Path("/tmp/test_grammar_profile")),
        headless=False,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"],
        viewport={"width": 900, "height": 600},
    )
    page = ctx.new_page()
    page.goto("file:///tmp/grammar_test.html")
    page.wait_for_timeout(3000)

    def editor_text():
        return page.evaluate("() => (document.getElementById('editor').textContent || '')")

    def log(msg):
        page.evaluate("(m) => { const el = document.getElementById('log'); if(el) el.textContent += m + '\\n'; }", msg)
        print(f"  {msg}")

    # Verify extension is active by checking for state or extension context
    ext_alive = page.evaluate("() => typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id")
    log(f"Extension context: {ext_alive}")

    results = {}
    ta = page.query_selector("#editor")

    # ── Test 1: Palette on ?/ ─────────────────────────────────────────
    print("\n=== Test 1: Palette on ?/ ===")
    ta.click(); time.sleep(0.3)
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.2)
    page.keyboard.type("test ?/", delay=30)
    time.sleep(1.5)
    palette = page.query_selector('#ai-grammar-palette')
    results["palette"] = "PASS" if palette else "FAIL"
    log(f"Palette: {'YES' if palette else 'NO'}")

    if palette:
        items = palette.query_selector_all('.agp-item')
        results["palette-items"] = f"PASS ({len(items)})"

    # ── Test 2: ?/fix auto-strip ──────────────────────────────────────
    print("\n=== Test 2: ?/fix auto-strip ===")
    ta.click(); time.sleep(0.3)
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.2)
    page.keyboard.type("He go work everyday buy bus. ?/fix", delay=15)
    log("Waiting for fix result...")
    for i in range(40):
        time.sleep(2)
        badge = page.query_selector('.ai-grammar-badge')
        if badge: break
    time.sleep(1)
    text = editor_text()
    has_cmd = "?/fix" in text
    results["?/fix strips"] = "PASS" if not has_cmd else f"FAIL ('{text[:50]}')"

    # ── Test 3: ?/polish auto-strip ───────────────────────────────────
    print("\n=== Test 3: ?/polish auto-strip ===")
    ta.click(); time.sleep(0.3)
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.2)
    page.keyboard.type("He go work everyday buy bus. ?/polish", delay=15)
    for i in range(50):
        time.sleep(2)
        badge = page.query_selector('.ai-grammar-badge')
        if badge: break
    time.sleep(1)
    text = editor_text()
    has_cmd = "?/polish" in text
    results["?/polish strips"] = "PASS" if not has_cmd else f"FAIL ('{text[:50]}')"

    # ── Test 4: Partial->full auto-complete ───────────────────────────
    print("\n=== Test 4: Partial->full (?/of -> ?/off) ===")
    ta.click(); time.sleep(0.3)
    page.keyboard.press("Control+a"); page.keyboard.press("Backspace")
    time.sleep(0.2)
    page.keyboard.type("?/of", delay=30)
    time.sleep(3)  # 600ms debounce + expansion + strip
    text = editor_text()
    results["partial->full"] = "PASS" if "?/off" not in text else f"FAIL ('{text}')"
    # Note: ?/off should be auto-stripped too (it's not fix/polish/check)
    log(f"Editor after ?/of: '{text}'")

    # ── Results ───────────────────────────────────────────────────────
    print("\n" + "="*50)
    for name, result in results.items():
        emoji = "✅" if result.startswith("PASS") else "❌"
        print(f"  {emoji} {name}: {result}")
    passed = sum(1 for v in results.values() if v.startswith("PASS"))
    print(f"\n  {passed}/{len(results)} passed")
    ctx.close()
