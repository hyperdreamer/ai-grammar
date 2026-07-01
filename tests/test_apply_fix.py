"""Test two-event apply-fix on contentEditable with Lexical-like beforeinput handler."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=True,
        args=[f"--load-extension={EXT}"],
        viewport={"width": 800, "height": 600},
    )
    page = ctx.new_page()
    
    # Simulate a Lexical-like editor: contentEditable that hooks beforeinput
    # and manages content changes internally (preventing direct DOM writes)
    page.set_content("""
    <div id="editor" contenteditable="true" style="border:2px solid red; padding:10px; min-height:50px; font:16px sans-serif">
        He go work everyday buy bus.
    </div>
    <pre id="log" style="font-size:11px; max-height:200px; overflow:auto"></pre>
    <script>
    const log = document.getElementById('log');
    const editor = document.getElementById('editor');
    
    // Simulate Lexical: intercept beforeinput and manage content internally
    let lexState = 'He go work everyday buy bus.';
    
    editor.addEventListener('beforeinput', (e) => {
        log.textContent += 'beforeinput: ' + e.inputType + ' data=' + (e.data||'null') + '\\n';
        
        if (e.inputType === 'deleteContentBackward') {
            // Lexical would clear its state
            lexState = '';
            log.textContent += '  → Lexical cleared state\\n';
        } else if (e.inputType === 'insertText') {
            // Lexical would insert the text
            lexState = e.data || '';
            log.textContent += '  → Lexical set state: ' + lexState + '\\n';
        }
    });
    
    editor.addEventListener('input', (e) => {
        log.textContent += 'input: ' + e.inputType + ' data=' + (e.data||'null') + '\\n';
    });
    </script>
    """)
    page.wait_for_timeout(500)
    
    # Simulate apply-fix: select all, dispatch delete+insert events, write textContent
    result = page.evaluate("""
    (() => {
        const ta = document.getElementById('editor');
        ta.focus();
        
        // Select all
        const range = document.createRange();
        range.selectNodeContents(ta);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        
        // Delete
        ta.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true,
            inputType: 'deleteContentBackward', data: null,
        }));
        ta.textContent = '';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward', data: null,
        }));
        
        // Insert
        ta.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true,
            inputType: 'insertText', data: 'He goes to work every day by bus.',
        }));
        ta.textContent = 'He goes to work every day by bus.';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText', data: 'He goes to work every day by bus.',
        }));
        
        return ta.textContent || ta.innerText || '';
    })()
    """)
    
    log = page.text_content("#log")
    print("Event log:")
    print(log)
    print(f"Final text: '{result}'")
    
    if result == 'He goes to work every day by bus.' and result.count('He goes') == 1:
        print("✓ Clean replacement — no duplication!")
    else:
        print(f"✗ Failed — got: '{result}'")
    
    ctx.close()
