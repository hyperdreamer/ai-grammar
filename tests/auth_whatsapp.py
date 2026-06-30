#!/usr/bin/env python3
"""Open WhatsApp Web in a persistent Playwright browser for manual authentication.

The browser profile is saved under tests/whatsapp_profile/ so the auth state
(cookies, local storage, service workers) persists across runs.

The extension is loaded from ../extension/.
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PROFILE_DIR = Path(__file__).resolve().parent / "whatsapp_profile"
EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"

if not EXTENSION_DIR.is_dir():
    print(f"Extension directory not found: {EXTENSION_DIR}")
    sys.exit(1)

PROFILE_DIR.mkdir(parents=True, exist_ok=True)

print(f"Profile: {PROFILE_DIR}")
print(f"Extension: {EXTENSION_DIR}")
print()
print("Opening WhatsApp Web. Scan the QR code with your phone to log in.")
print("Once you see your chat list, close the browser window.")
print()

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR),
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
        ],
        # Don't restore localStorage so WhatsApp starts fresh QR scan
        viewport={"width": 1280, "height": 900},
    )

    page = context.new_page()

    # Collect console messages from our extension
    page.on("console", lambda msg: (
        print(f"[CONSOLE {msg.type}] {msg.text}")
        if "[AI Grammar]" in msg.text
        else None
    ))

    page.goto("https://web.whatsapp.com/", wait_until="domcontentloaded")

    print()
    print("Browser opened. Waiting for you to log in...")
    print("(Close the browser window when done)")
    print()

    # Wait for the user to close the browser
    try:
        # Keep alive until user closes
        page.wait_for_selector("div[data-testid='chat-list'], div[aria-label='Chat list'], .two, .app-wrapper-web", timeout=600_000)  # 10 min
        print("\n✓ Chat list detected — you're logged in!")
        print("  Keep the browser open if you want, or close it.")
        print("  Auth state is saved in the profile directory.")
        # Keep the browser open for 60 more seconds so user can verify
        page.wait_for_timeout(60_000)
    except Exception:
        print("\n! Timeout waiting for chat list. Did you scan the QR code?")
        print("  The browser profile may still be partially set up.")
        print("  Try running the script again.")

    context.close()
