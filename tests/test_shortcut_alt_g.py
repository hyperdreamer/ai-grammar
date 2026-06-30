#!/usr/bin/env python3
"""Check if Chrome actually registers Alt+G shortcut."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir="/tmp/playwright_shortcut_test_v2",
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
        ],
        viewport={"width": 1280, "height": 900},
    )
    page = context.new_page()

    # Navigate to shortcuts page
    page.goto("chrome://extensions/shortcuts", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)

    # Get full page content
    text = page.evaluate("document.body.innerText")
    print("=== chrome://extensions/shortcuts ===")
    print(text[:3000])
    
    page.screenshot(path="/tmp/shortcuts_debug.png")
    
    # Also check if extension even loaded
    page2 = context.new_page()
    page2.goto("chrome://extensions", wait_until="domcontentloaded")
    page2.wait_for_timeout(2000)
    ext_text = page2.evaluate("document.body.innerText")
    if "AI Grammar" in ext_text:
        print("\n✓ Extension found on chrome://extensions")
    else:
        print("\n✗ Extension NOT found on chrome://extensions")
    
    page2.screenshot(path="/tmp/extensions_debug.png")
    context.close()
