#!/usr/bin/env python3
"""Test the AI Grammar Checker extension on WhatsApp Web.

Uses the persistent browser profile from auth_whatsapp.py.
Sends a message with a deliberate grammar error to the first chat
in the list and captures extension console logs to diagnose rendering issues.
"""

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PROFILE_DIR = Path(__file__).resolve().parent / "whatsapp_profile"
EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"

if not PROFILE_DIR.is_dir():
    print("Profile not found. Run auth_whatsapp.py first to log into WhatsApp.")
    sys.exit(1)

TEST_MESSAGE = "I has went to the store yesterday and buyed some apple."

# --- Collect extension console logs ---
logs: list[dict] = []


def on_console(msg):
    if "[AI Grammar]" in msg.text:
        logs.append({"type": msg.type, "text": msg.text, "ts": time.time()})
        print(f"  [EXT] {msg.text}")


print("Launching WhatsApp Web with extension...")
print(f"Test message: {TEST_MESSAGE!r}")
print()

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR),
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
        ],
        viewport={"width": 1280, "height": 900},
    )

    page = context.new_page()
    page.on("console", on_console)

    # --- Navigate to WhatsApp Web ---
    page.goto("https://web.whatsapp.com/", wait_until="domcontentloaded")

    # Wait for chat list
    try:
        page.wait_for_selector(
            "div[data-testid='chat-list'], div[aria-label='Chat list'], #pane-side, .two",
            timeout=30_000,
        )
        print("✓ Chat list loaded")
    except Exception:
        print("✗ Chat list not found. Are you logged in? Run auth_whatsapp.py first.")
        context.close()
        sys.exit(1)

    # Give WhatsApp time to fully render
    page.wait_for_timeout(3_000)

    # --- Open first chat ---
    try:
        page.locator("#pane-side div[role='row']").first.click(timeout=10_000)
        page.wait_for_timeout(2_000)
        print("✓ Opened first chat in list")
    except Exception as e:
        print(f"✗ Could not open any chat: {e}")
        context.close()
        sys.exit(1)

    # --- Type and send the test message ---
    print(f"\nSending test message: {TEST_MESSAGE!r}")
    logs.clear()  # clear logs collected during navigation

    # Find the input box
    input_box = page.locator(
        'div[contenteditable="true"][role="textbox"]'
    ).or_(page.locator('div[contenteditable="true"][data-testid="conversation-compose-box-input"]')).or_(
        page.locator('div[contenteditable="true"]').last
    )

    try:
        input_box.first.click(timeout=5_000)
        input_box.first.fill(TEST_MESSAGE)
        page.wait_for_timeout(500)
    except Exception as e:
        print(f"✗ Could not find/type in input: {e}")
        context.close()
        sys.exit(1)

    # Click send button (look for aria-label="Send" or the send icon)
    try:
        send_btn = page.locator('button[aria-label="Send"]').or_(
            page.locator('span[data-testid="send"]')
        ).or_(page.locator('span[data-icon="send"]'))
        send_btn.first.click(timeout=3_000)
        print("✓ Message sent via send button")
    except Exception:
        # Try pressing Enter
        print("! Send button not found, pressing Enter...")
        page.keyboard.press("Enter")
        print("✓ Message sent via Enter")

    # --- Wait for grammar check results ---
    print("\nWaiting for grammar check results (up to 15s)...")
    page.wait_for_timeout(15_000)

    # --- Report ---
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    grammar_logs = [l for l in logs if "[AI Grammar]" in l["text"]]
    if not grammar_logs:
        print("✗ No [AI Grammar] console logs found.")
        print("  The extension may not be running. Check:")
        print("  1. Is the extension loaded? Check chrome://extensions")
        print("  2. Is the backend running on port 8766?")
        print("  3. Open DevTools in the launched browser and check manually.")
    else:
        print(f"Found {len(grammar_logs)} grammar-related log entries:\n")
        for log in grammar_logs:
            print(f"  [{log['type']}] {log['text']}")

    print()
    print("All console logs for manual review:")
    for log in logs:
        print(f"  [{log['type']}] {log['text']}")

    print("\nBrowser will close in 10s. Review the WhatsApp window if needed.")
    page.wait_for_timeout(10_000)
    context.close()

    # --- Summary ---
    print("\nDIAGNOSIS SUMMARY:")
    block_queued = any("Block queued" in l["text"] for l in logs)
    check_result = any("checkText result" in l["text"] for l in logs)
    green_check = any("showGreenCheck" in l["text"] for l in logs)
    highlight = any("highlightErrors" in l["text"] for l in logs)

    print(f"  Block queued by MutationObserver: {'✓' if block_queued else '✗'}")
    if block_queued:
        for l in logs:
            if "Block queued" in l["text"]:
                print(f"    → {l['text']}")

    print(f"  checkText API result: {'✓' if check_result else '✗'}")
    if check_result:
        for l in logs:
            if "checkText result" in l["text"]:
                print(f"    → {l['text']}")

    print(f"  showGreenCheck / highlightErrors: {'✓' if (green_check or highlight) else '✗'}")
    if green_check:
        for l in logs:
            if "showGreenCheck" in l["text"]:
                print(f"    → {l['text']}")
    if highlight:
        for l in logs:
            if "highlightErrors" in l["text"]:
                print(f"    → {l['text']}")
