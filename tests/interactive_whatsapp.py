"""Interactive test: open WhatsApp Web with saved session + extension loaded.
User types manually, screenshots problems."""
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

    # Wait for chat list to load
    page.wait_for_selector("#pane-side", timeout=30000)
    print("WhatsApp loaded — chat list visible.")
    print("Browser is open. Close it when done testing.")
    
    # Keep alive until user closes the browser
    def on_close(_ctx):
        print("Browser closed.")
    ctx.on("close", on_close)
    page.wait_for_timeout(3600_000)  # 1 hour max
