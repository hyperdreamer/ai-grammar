"""Force live draft via direct dispatch+wait."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=True,
        args=[f"--load-extension={EXT}"],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()
    page.goto("http://127.0.0.1:8766/static/grammar-test.html", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)

    # Use evaluate to set value AND dispatch input event
    page.evaluate("""
        const ta = document.querySelector('textarea#msg');
        ta.focus();
        ta.value = 'He go work everyday buy bus.';
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    """)
    print("Dispatched input event, waiting 12s...")
    page.wait_for_timeout(12000)
    
    state = page.evaluate("""() => ({
        badge: document.getElementById('ai-grammar-badge')?.textContent || null,
        float: document.getElementById('ai-grammar-float')?.textContent?.slice(0,200) || null,
        errors: document.querySelectorAll('.ag-live-error, .ai-grammar-error').length,
    })""")
    print(f"Badge: {state['badge']}, Float: {state['float']}, Errors: {state['errors']}")
    
    ctx.close()
