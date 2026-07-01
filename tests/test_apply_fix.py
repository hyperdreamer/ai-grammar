"""Test Codex ClipboardEvent approach."""
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    ctx = p.chromium.launch(headless=True)
    page = ctx.new_page()
    
    page.set_content("""
    <div id="editor" contenteditable="true" style="border:2px solid red; padding:10px; min-height:50px; font:16px sans-serif">
        He go work everyday buy bus.
    </div>
    <pre id="log" style="font-size:11px; max-height:200px; overflow:auto"></pre>
    <script>
    const log = document.getElementById('log');
    const editor = document.getElementById('editor');
    let lexState = 'He go work everyday buy bus.';
    editor.addEventListener('paste', (e) => {
        log.textContent += 'paste event fired\\n';
        const text = e.clipboardData?.getData('text/plain') || '';
        log.textContent += '  text: ' + text.substring(0,50) + '\\n';
        lexState = text;
        document.execCommand('insertText', false, text);
        e.preventDefault();
    });
    editor.addEventListener('input', (e) => {
        log.textContent += 'input: ' + e.inputType + '\\n';
    });
    </script>
    """)
    page.wait_for_timeout(500)
    
    # Load the actual replaceContentEditableText function from the file
    with open('/data/home/guest/Development/ai/ai-grammar/extension/content.js') as f:
        content_js = f.read()
    
    # Extract the three functions (selectEditableContents, createTextClipboardData, replaceContentEditableText)
    import re
    fn_code = ""
    for fn_name in ['selectEditableContents', 'createTextClipboardData', 'replaceContentEditableText']:
        # Find function definition and extract until matching brace
        match = re.search(r'function ' + fn_name + r'\(.*?\) \{', content_js)
        if match:
            start = match.start()
            depth = 0
            i = start
            in_func = False
            while i < len(content_js):
                if content_js[i] == '{':
                    depth += 1
                    in_func = True
                elif content_js[i] == '}':
                    depth -= 1
                    if in_func and depth == 0:
                        fn_code += content_js[start:i+1] + '\n\n'
                        break
                i += 1
    
    # Run the replace function
    result = page.evaluate("""({code}) => {
        eval(code);
        const ta = document.getElementById('editor');
        replaceContentEditableText(ta, 'He goes to work every day by bus.');
        return ta.textContent || ta.innerText || '';
    }""", {"code": fn_code})
    
    log = page.text_content("#log")
    print("Event log:")
    print(log)
    print(f"Final text: '{result}'")
    
    if result == 'He goes to work every day by bus.':
        print("✓ Clean replacement!")
    else:
        print(f"✗ Failed — {result.count('He goes')} copies")
    
    ctx.close()
