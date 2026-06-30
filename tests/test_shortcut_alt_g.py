#!/usr/bin/env python3
"""Ctrl+Shift+L shortcut test — full pipeline via SW CDP trigger."""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"
manifest = json.loads((EXTENSION_DIR / "manifest.json").read_text())
sk = manifest["commands"]["check-selection"]["suggested_key"]["default"]
assert sk == "Ctrl+Shift+L", f"Expected Ctrl+Shift+L, got {sk}"
print(f"✓ Manifest: {sk}")

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir="/tmp/pw_ctrl_shift_l",
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
        ],
        viewport={"width": 1280, "height": 900},
    )
    page = context.new_page()
    msgs = []
    page.on("console", lambda m: msgs.append(m.text))

    page.goto("http://127.0.0.1:8766/static/selection-test.html", wait_until="domcontentloaded")
    page.wait_for_timeout(4000)

    cs_ok = any("Content script initialized" in m for m in msgs)
    print(f"{'✓' if cs_ok else '✗'} Content script loaded")

    # Select text
    page.evaluate("""() => {
        const p = document.getElementById('test-paragraph');
        const r = document.createRange(); r.selectNodeContents(p);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    }""")

    # Trigger via SW CDP
    cdp = context.new_cdp_session(page)
    targets = cdp.send("Target.getTargets")
    sw_id = next((t["targetId"] for t in targets.get("targetInfos", [])
                  if "service_worker" in t.get("type", "") and "background.js" in t.get("url", "")), None)

    if sw_id and cs_ok:
        attach = cdp.send("Target.attachToTarget", {"targetId": sw_id})
        msg = json.dumps({
            "id": 1, "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    (async () => {
                        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
                        if (tab?.id) {
                            await chrome.tabs.sendMessage(tab.id, {type: 'grammar:check-selection'});
                            return JSON.stringify({ok: true});
                        }
                        return JSON.stringify({ok: false});
                    })()
                """,
                "awaitPromise": True, "returnByValue": True,
            }
        })
        cdp.send("Target.sendMessageToTarget", {"message": msg, "sessionId": attach["sessionId"]})
        print("✓ SW → CS trigger sent")

        # Poll for results
        for i in range(8):
            page.wait_for_timeout(5000)
            badge = page.evaluate("document.querySelector('.ai-grammar-badge')?.textContent || 'none'")
            overlay = page.evaluate("document.querySelectorAll('.ag-message-overlay').length")
            errs = page.evaluate("""() => Array.from(
                document.querySelectorAll('.ai-grammar-error,.ai-grammar-improvement,.ai-grammar-idiom')
            ).map(s => s.textContent)""")
            print(f"  t+{(i+1)*5}s: badge={badge!r} overlay={overlay} errs={errs[:3]}")
            if overlay > 0 or errs:
                print("  ✓ Overlay rendered!")
                break

    # Baseline backend check
    bl = page.evaluate("""async () => {
        const text = window.getSelection().toString();
        const resp = await fetch('http://127.0.0.1:8766/check', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text, language: 'auto'})
        });
        const data = await resp.json();
        return {status: resp.status, count: data.errors?.length || 0};
    }""")
    print(f"\nBaseline backend: {bl['status']} → {bl['count']} errors")

    page.screenshot(path="/tmp/ctrl_shift_l_result.png")

    # Final check (before closing context)
    overlay = page.evaluate("document.querySelectorAll('.ag-message-overlay').length")
    errs = page.evaluate("""() => Array.from(
        document.querySelectorAll('.ai-grammar-error,.ai-grammar-improvement,.ai-grammar-idiom')
    ).map(s => s.textContent)""")

    context.close()

    success = overlay > 0 or errs
    print(f"\n{'✓ PASS' if success else '✗ Not rendered in time'} — Ctrl+Shift+L pipeline: ok")
    sys.exit(0 if success else 1)
