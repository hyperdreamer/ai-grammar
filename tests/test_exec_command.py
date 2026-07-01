"""Test execCommand on a contentEditable div — simulate WhatsApp apply-fix."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=False,
        args=[f"--load-extension={EXT}"],
        viewport={"width": 800, "height": 600},
    )
    page = ctx.new_page()
    
    # Create a simple test page with contentEditable
    page.set_content("""
    <div id="editor" contenteditable="true" style="border:2px solid #333; padding:10px; min-height:50px; font:16px sans-serif">
        He go work everyday buy bus.
    </div>
    <button id="fix">Apply Fix</button>
    <pre id="log"></pre>
    <script>
    document.getElementById('fix').onclick = () => {
        const ta = document.getElementById('editor');
        const log = document.getElementById('log');
        
        // Approach 1: execCommand selectAll + delete + insertText
        ta.focus();
        const r1 = document.execCommand('selectAll', false, null);
        log.textContent += 'selectAll: ' + r1 + '\\n';
        
        const r2 = document.execCommand('delete', false, null);
        log.textContent += 'delete: ' + r2 + '\\n';
        
        const r3 = document.execCommand('insertText', false, 'He goes to work everyday by bus.');
        log.textContent += 'insertText: ' + r3 + '\\n';
        
        log.textContent += 'Result: ' + (ta.textContent || ta.innerText) + '\\n';
    };
    </script>
    """)
    page.wait_for_timeout(1000)
    
    # Click the fix button
    page.click("#fix")
    page.wait_for_timeout(500)
    
    log = page.text_content("#log")
    editor = page.text_content("#editor")
    print("Log:", log.strip())
    print("Editor:", editor.strip())
    
    if "He goes to work" in editor:
        print("✓ execCommand works on contentEditable!")
    else:
        print("✗ execCommand failed")
    
    # Now test: does it work WITHOUT the delete step?
    page.set_content("""
    <div id="editor" contenteditable="true" style="border:2px solid #333; padding:10px; min-height:50px; font:16px sans-serif">
        He go work everyday buy bus.
    </div>
    <button id="fix2">Apply Fix 2</button>
    <pre id="log2"></pre>
    <script>
    document.getElementById('fix2').onclick = () => {
        const ta = document.getElementById('editor');
        const log = document.getElementById('log2');
        ta.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, 'He goes to work everyday by bus.');
        log.textContent += 'Result: ' + (ta.textContent || ta.innerText) + '\\n';
    };
    </script>
    """)
    page.wait_for_timeout(500)
    page.click("#fix2")
    page.wait_for_timeout(500)
    editor2 = page.text_content("#editor")
    print("Without delete, Editor:", editor2.strip())
    
    input("Press Enter to close...")
    ctx.close()
