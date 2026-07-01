"""Test apply-fix on the grammar test page (textarea)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=False,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()
    page.goto("http://127.0.0.1:8766/static/grammar-test.html", wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    # Type and wait for live draft
    ta = page.locator("textarea#msg")
    ta.click()
    page.keyboard.type("He go work everyday buy bus.", delay=30)
    print("Waiting for live draft check (7s)...")
    page.wait_for_timeout(7000)

    # Check for tooltip or float
    tooltip = page.locator(".ai-grammar-tooltip")
    if tooltip.count() > 0:
        print("Tooltip visible — looking for Apply fix button")
        apply = page.locator(".ai-grammar-tooltip button:has-text('Apply')")
        if apply.count() > 0:
            print("Clicking Apply fix...")
            apply.first.click()
            page.wait_for_timeout(1500)
            new_text = ta.input_value()
            print(f"Text after apply-fix: '{new_text}'")
            if new_text != "He go work everyday buy bus.":
                print("✓ Apply-fix worked!")
            else:
                print("✗ Text unchanged")
        else:
            print("No Apply button found in tooltip")
    else:
        float_el = page.locator("#ai-grammar-float")
        if float_el.count() > 0:
            print("Float panel visible")
            page.screenshot(path="/tmp/apply_fix_test.png")
    page.wait_for_timeout(2000)
    ctx.close()
