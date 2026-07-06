"""Test ?/check command on WhatsApp Web — verify no CDP triggered."""
import os, sys, time, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).resolve().parent / "whatsapp_profile"
EXT = Path(__file__).resolve().parent.parent / "extension"
KILL_FILE = "/tmp/close_whatsapp_check_test"

# ── Pre-launch cleanup ────────────────────────────────────────────────
print("=== Cleaning up stale Chrome ===")
subprocess.run(["pkill", "-9", "-f", f"chrome.*whatsapp_profile"], capture_output=True)
time.sleep(1)
singleton = PROFILE / "SingletonLock"
if singleton.exists():
    singleton.unlink()
    print(f"Removed {singleton}")

if os.path.exists(KILL_FILE):
    os.remove(KILL_FILE)

# ── Check backend is alive ────────────────────────────────────────────
print("=== Checking backend ===")
try:
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "http://127.0.0.1:8766/check", "-X", "POST",
         "-H", "Content-Type: application/json",
         "-d", '{"text":"ping test","language":"auto"}'],
        capture_output=True, text=True, timeout=10
    )
    print(f"Backend status: {r.stdout.strip()}")
except Exception as e:
    print(f"Backend unreachable: {e}")
    sys.exit(1)

# ── Launch browser with extension ─────────────────────────────────────
print("=== Launching browser ===")
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=False,
        args=[
            f"--disable-extensions-except={EXT}",
            f"--load-extension={EXT}",
            "--no-sandbox",
        ],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()

    # ── Navigate to WhatsApp Web ──────────────────────────────────────
    print("=== Navigating to WhatsApp Web ===")
    page.goto("https://web.whatsapp.com/")

    INPUT_SELS = [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]',
        'footer div[contenteditable="true"]',
    ]
    ta = None
    for sel in INPUT_SELS:
        try:
            page.wait_for_selector(sel, timeout=30000)
            ta = page.query_selector(sel)
            if ta:
                print(f"Found editor: {sel}")
                break
        except:
            continue

    if not ta:
        print("FAIL: Could not find WhatsApp editor — not logged in?")
        ctx.close()
        sys.exit(1)

    time.sleep(2)

    # ── Test 1: Auto-check (live draft) baseline ──────────────────────
    print("\n=== Test 1: Auto-check baseline ===")
    ta.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    time.sleep(0.5)
    
    TEST_TEXT = "He go work everyday buy bus."
    page.keyboard.type(TEST_TEXT, delay=30)
    print(f"Typed: '{TEST_TEXT}'")

    # Wait for auto-check (5s delay + backend time)
    OVERLAY_SEL = '.ai-grammar-error[data-live-draft]'
    found_auto = False
    for i in range(24):  # up to 120s
        time.sleep(5)
        spans = page.query_selector_all(OVERLAY_SEL)
        if spans:
            found_auto = True
            print(f"  Auto-check underlines appeared after {(i+1)*5}s ({len(spans)} spans)")
            break
        green = page.query_selector('.ai-grammar-ok-ta')
        if green:
            print("  Auto-check returned green check (no errors)")
            break

    if not found_auto:
        print("  WARNING: Auto-check didn't show underlines (backend may be slow)")

    # ── Test 2: ?/check command ───────────────────────────────────────
    print("\n=== Test 2: ?/check command ===")
    # Clear and type fresh text + command
    ta.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    time.sleep(0.5)

    page.keyboard.type(TEST_TEXT, delay=30)
    page.keyboard.type(" ?/check", delay=30)
    print(f"Typed: '{TEST_TEXT} ?/check'")

    # Wait for check results
    found_check = False
    editor_after = ""
    for i in range(24):
        time.sleep(5)
        # Check if overlay appeared
        spans = page.query_selector_all(OVERLAY_SEL)
        green = page.query_selector('.ai-grammar-ok-ta')

        if spans or green:
            found_check = True
            editor_after = page.evaluate("""
                () => {
                    const ta = document.querySelector('[contenteditable="true"][role="textbox"]');
                    if (!ta) return 'NO_EDITOR';
                    return (ta.textContent || ta.innerText || '').replace(/\u200B/g, '');
                }
            """)
            if spans:
                print(f"  ?/check: {len(spans)} error underlines after {(i+1)*5}s")
            if green:
                print(f"  ?/check: green check after {(i+1)*5}s")
            break

    if not found_check:
        # Check editor state anyway
        editor_after = page.evaluate("""
            () => {
                const ta = document.querySelector('[contenteditable="true"][role="textbox"]');
                if (!ta) return 'NO_EDITOR';
                return (ta.textContent || ta.innerText || '').replace(/\u200B/g, '');
            }
        """)
        badge = page.query_selector('.ai-grammar-badge')
        badge_text = badge.text_content() if badge else "none"
        print(f"  FAIL: No ?/check results after 120s")
        print(f"  Editor text: '{editor_after}'")
        print(f"  Badge: '{badge_text}'")
    else:
        # Verify ?/check was stripped from editor
        has_check_cmd = "?/check" in editor_after
        has_cdp = "?/check" not in editor_after and editor_after == TEST_TEXT
        
        print(f"\n=== Results ===")
        print(f"  Editor text after: '{editor_after}'")
        print(f"  Has '?/check' leftover: {has_check_cmd}")
        
        if not has_check_cmd:
            print("  ✓ ?/check command was stripped from editor")
        else:
            print("  ✗ ?/check command still in editor — stripCheck failed")

        if found_check and not has_check_cmd:
            print("  PASS: ?/check works on WhatsApp!")
        elif found_check and has_check_cmd:
            print("  PARTIAL: check fired but command text remains")
        else:
            print("  FAIL: ?/check did not produce results")

    # ── Keep browser open for inspection ──────────────────────────────
    print(f"\n=== Browser stays open ===")
    print(f"Run: touch {KILL_FILE}  to close")
    while not os.path.exists(KILL_FILE):
        time.sleep(2)

    ctx.close()
    print("Done.")
