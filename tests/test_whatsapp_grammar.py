#!/usr/bin/env python3
"""Test the AI Grammar Checker extension on WhatsApp Web.

Uses the persistent browser profile from auth_whatsapp.py.
Sends a message with a deliberate grammar error to the first chat
in the list and verifies overlay highlighting via DOM inspection.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PROFILE_DIR = Path(__file__).resolve().parent / "whatsapp_profile"
EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"

if not PROFILE_DIR.is_dir():
    print("Profile not found. Run auth_whatsapp.py first to log into WhatsApp.")
    sys.exit(1)

TEST_MESSAGE = "I has went to the store yesterday and buyed some apple."

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

    # Check DOM for overlay elements (not console logs — those were removed in v1.3.0)
    overlay_count = page.evaluate('document.querySelectorAll(".ag-message-overlay").length')
    error_spans = page.evaluate('''() => {
        const spans = document.querySelectorAll('.ag-message-overlay .ai-grammar-error, .ag-message-overlay .ai-grammar-improvement, .ag-message-overlay .ai-grammar-idiom');
        return Array.from(spans).map(s => s.textContent);
    }''')
    green_checks = page.evaluate('document.querySelectorAll(".ai-grammar-ok-ta").length')
    badge_visible = page.evaluate('''() => {
        const b = document.querySelector('.ai-grammar-badge');
        return b ? b.textContent : null;
    }''')

    print(f"  Overlay divs in DOM: {overlay_count}")
    if error_spans:
        print(f"  Error spans: {error_spans}")
    else:
        print(f"  Error spans: 0")
    print(f"  Green checks: {green_checks}")
    print(f"  Badge text: {badge_visible}")

    print("\nDIAGNOSIS SUMMARY:")
    print(f"  Overlay created: {'✓' if overlay_count > 0 else '✗'}")
    print(f"  Errors highlighted: {'✓' if len(error_spans) > 0 else '✗'}")
    print(f"  Badge visible: {'✓' if badge_visible else '✗'}")
    print(f"  Green check: {'✓' if green_checks > 0 else '— (errors found, no check expected)'}" if error_spans else f"  Green check: {'✓' if green_checks > 0 else '✗'}")
