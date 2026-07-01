"""Test apply-fix on WhatsApp contentEditable — debug why Lexical reverts changes."""
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
    
    # Instead of WhatsApp (requires auth), test on the test page contentEditable
    page.goto("http://127.0.0.1:8766/static/grammar-test.html", wait_until="domcontentloaded")
    page.wait_for_timeout(2000)
    
    # Check if there's a contentEditable or textarea
    ta = page.locator("textarea, [contenteditable='true']").first
    tag = ta.evaluate("el => el.tagName")
    is_ce = ta.evaluate("el => el.isContentEditable")
    print(f"Input tag: {tag}, isContentEditable: {is_ce}")
    
    # Type a test sentence
    ta.click()
    page.keyboard.type("He go work everyday buy bus.", delay=30)
    page.wait_for_timeout(7000)  # Wait for live draft check
    
    # Check if error float or overlay appeared
    float_el = page.evaluate("document.getElementById('ai-grammar-float') ? 1 : 0")
    overlay = page.evaluate("document.querySelector('.ag-live-error') ? 1 : 0")
    print(f"Float panel: {float_el}, Overlay errors: {overlay}")
    
    if float_el:
        # Click apply fix button in float panel
        apply_btn = page.locator("#ai-grammar-float .ag-apply, #ai-grammar-float button:has-text('Apply fix')")
        if apply_btn.count() > 0:
            apply_btn.first.click()
            page.wait_for_timeout(1000)
            new_text = ta.evaluate("el => el.value || el.textContent || ''")
            print(f"After apply-fix (float): '{new_text}'")
    
    if overlay:
        # Click on an error span to show tooltip, then click apply
        err_span = page.locator(".ag-live-error").first
        err_span.click()
        page.wait_for_timeout(500)
        apply_btn2 = page.locator(".ai-grammar-tooltip button:has-text('Apply')")
        if apply_btn2.count() > 0:
            apply_btn2.first.click()
            page.wait_for_timeout(1000)
            new_text2 = ta.evaluate("el => el.value || el.textContent || ''")
            print(f"After apply-fix (tooltip): '{new_text2}'")
        else:
            print("No apply button in tooltip")
    
    # Now test execCommand directly
    print("\n--- Direct execCommand test ---")
    ta.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.keyboard.type("I has went to the store.", delay=30)
    page.wait_for_timeout(7000)
    
    # Test different fix approaches
    approaches = [
        "ta.textContent = 'I went to the store.'",
        "document.execCommand('selectAll', false, null); document.execCommand('insertText', false, 'I went to the store.')",
        "ta.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'insertReplacementText', data:'I went to the store.'})); ta.textContent = 'I went to the store.'; ta.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:'I went to the store.'}))",
    ]
    
    for i, approach in enumerate(approaches):
        # Reset
        ta.click()
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        page.keyboard.type("I has went to the store.", delay=20)
        page.wait_for_timeout(1000)
        
        before = ta.evaluate("el => el.value || el.textContent || ''")
        ta.evaluate(f"el => {{ {approach} }}")
        page.wait_for_timeout(500)
        after = ta.evaluate("el => el.value || el.textContent || ''")
        print(f"Approach {i+1}: '{before}' -> '{after}' {'✓' if after != before else '✗'}")
    
    input("Press Enter to close browser...")
    ctx.close()
