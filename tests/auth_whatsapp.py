"""One-time auth: open WhatsApp Web, user scans QR code, session saved."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=False,
        args=[
            f"--disable-extensions-except={EXT}",
            f"--load-extension={EXT}",
        ],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()
    page.goto("https://web.whatsapp.com/", wait_until="domcontentloaded")

    print("Waiting for QR scan (10 min timeout)...")
    page.wait_for_selector("#pane-side, div[aria-label='Chat list']", timeout=600_000)
    print("✓ Logged in — auth saved in profile")
    ctx.close()
