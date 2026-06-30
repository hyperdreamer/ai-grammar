#!/usr/bin/env python3
"""Test that the Alt+G keyboard shortcut triggers grammar checking.

Loads the extension via Playwright, navigates to a selection test page
(served by the backend), selects text containing errors, presses Alt+G,
and verifies overlay elements appear in the DOM.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"
TEST_PAGE_URL = "http://127.0.0.1:8766/static/selection-test.html"

print(f"Test page: {TEST_PAGE_URL}")
print(f"Extension: {EXTENSION_DIR}")
print()

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir="/tmp/playwright_shortcut_test",
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
        ],
        viewport={"width": 1280, "height": 900},
    )

    page = context.new_page()

    # Collect console messages
    console_msgs = []
    page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))

    # Navigate to test page
    page.goto(TEST_PAGE_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)  # Let extension content script inject

    print("Page loaded. Testing shortcut...")

    # Select text in the paragraph
    page.evaluate("""() => {
        const p = document.getElementById('test-paragraph');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }""")

    # Verify selection
    selected = page.evaluate("window.getSelection().toString()")
    print(f"Selected text: {selected!r}")

    # Press Alt+G using keyDown/keyUp for physical key simulation
    page.keyboard.down("Alt")
    page.keyboard.press("KeyG")
    page.keyboard.up("Alt")
    print("Pressed Alt+G")

    # Wait for grammar check to complete
    page.wait_for_timeout(10000)  # 10s for AI response

    # Check for overlay elements
    overlay_count = page.evaluate("document.querySelectorAll('.ag-message-overlay').length")
    error_spans = page.evaluate("""() => {
        const spans = document.querySelectorAll('.ai-grammar-error, .ai-grammar-improvement, .ai-grammar-idiom');
        return Array.from(spans).map(s => s.textContent);
    }""")
    badge_visible = page.evaluate("""() => {
        const b = document.querySelector('.ai-grammar-badge');
        return b ? b.textContent : null;
    }""")

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"  Overlay divs: {overlay_count}")
    print(f"  Error spans: {error_spans}")
    print(f"  Badge text: {badge_visible!r}")

    # Print relevant console messages
    grammar_msgs = [m for m in console_msgs if any(kw in m.lower() for kw in ['grammar', 'error', 'check', 'overlay'])]
    if grammar_msgs:
        print(f"\n  Console ({len(grammar_msgs)} msgs):")
        for m in grammar_msgs[-20:]:
            print(f"    {m}")

    print()
    success = overlay_count > 0 or len(error_spans) > 0
    if success:
        print("✓ Shortcut test PASSED — overlay elements found in DOM")
    else:
        print("✗ Shortcut test FAILED — no overlay elements found")
        print("  (Extension may not have loaded, or shortcut not triggered)")

    # Take a screenshot for visual confirmation
    page.screenshot(path="/tmp/shortcut_test_result.png")
    print("\nScreenshot saved: /tmp/shortcut_test_result.png")

    context.close()

sys.exit(0 if success else 1)
