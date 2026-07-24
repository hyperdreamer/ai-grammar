"""Browser regression test for the Pi WebUI shadow-DOM prompt.

Run directly after the Pi WebUI development server is available:
    python tests/test_pi_webui_shadow_dom.py

The test loads the unpacked extension, opens the user-reported local URL, and
verifies that commands, interactive underlines, and correction application all
work in its CodeMirror contentEditable. It intentionally uses an isolated
Chrome profile, so test commands cannot change a developer's extension settings.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
TARGET_URL = os.environ.get(
    "AI_GRAMMAR_TARGET_URL",
    "http://localhost:8809/?project=a53250ab-d6a5-4ca3-9df5-e1f410814dc0"
    "&workspace=dfd9217d5730&tool=core%3Aworkspace.git&view=core%3Aworkspace.git",
)


def main() -> None:
    subprocess.run(["npm", "run", "build"], cwd=EXTENSION, check=True)
    profile = Path(tempfile.mkdtemp(prefix="ai-grammar-pi-webui-"))

    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                headless=True,
                executable_path="/usr/bin/chromium",
                args=[
                    f"--disable-extensions-except={EXTENSION}",
                    f"--load-extension={EXTENSION}",
                    "--no-sandbox",
                ],
                viewport={"width": 1440, "height": 1000},
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30_000)

            editor = page.locator(".cm-content")
            editor.wait_for(timeout=10_000)
            page.wait_for_timeout(1_000)  # document_idle content script

            connection = editor.evaluate(
                "element => ({ connected: element.isConnected, documentContains: document.contains(element) })"
            )
            assert connection == {"connected": True, "documentContains": False}, (
                "Expected the Pi WebUI CodeMirror editor to be mounted inside shadow DOM"
            )

            editor.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            page.keyboard.type("Shadow DOM grammar command ?/", delay=5)
            page.locator("#ai-grammar-palette").wait_for(timeout=3_000)
            print("  PASS: command palette opens from the Pi WebUI CodeMirror editor")

            page.keyboard.press("Escape")
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            page.keyboard.type("?/help", delay=5)
            page.wait_for_timeout(1_500)  # command debounce + replacement
            assert "?/help" not in editor.text_content(), "The command was detected but not replaced in CodeMirror"
            print("  PASS: command replacement updates the Pi WebUI CodeMirror editor")

            # Force the composer to scroll, then compare the real CodeMirror
            # text range with the extension's interactive underline. This
            # catches overlays that mirror scrollTop twice or anchor to the
            # moving .cm-content rather than the fixed .cm-scroller viewport.
            editor.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            for line_number in range(14):
                page.keyboard.type(f"Context line {line_number} is complete and grammatical.", delay=1)
                page.keyboard.press("Shift+Enter")
            page.keyboard.type("This sentence have a grammar mistake that should be corrected.", delay=5)
            live_error = page.locator(".ag-live-error[data-live-draft]")
            live_error.wait_for(timeout=30_000)
            alignment = editor.evaluate(
                """element => {
                  const scroller = element.closest('.cm-scroller');
                  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
                  scroller.dispatchEvent(new Event('scroll'));

                  const error = document.querySelector('.ag-live-error[data-live-draft]');
                  const start = Number(error?.dataset.start);
                  const end = Number(error?.dataset.end);
                  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;

                  const lines = Array.from(element.querySelectorAll(':scope > .cm-line'));
                  const positionForOffset = (targetOffset, isEnd) => {
                    let lineStart = 0;
                    for (let index = 0; index < lines.length; index += 1) {
                      const line = lines[index];
                      const lineLength = line.textContent.length;
                      const lineEnd = lineStart + lineLength;
                      const belongsToLine = targetOffset < lineEnd
                        || (isEnd && targetOffset === lineEnd)
                        || (index === lines.length - 1 && targetOffset === lineEnd);
                      if (belongsToLine) {
                        const localOffset = targetOffset - lineStart;
                        const nodes = [];
                        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
                        while (walker.nextNode()) nodes.push(walker.currentNode);
                        let nodeStart = 0;
                        for (const node of nodes) {
                          const nodeEnd = nodeStart + node.nodeValue.length;
                          if (localOffset >= nodeStart && localOffset <= nodeEnd) {
                            return { node, offset: localOffset - nodeStart };
                          }
                          nodeStart = nodeEnd;
                        }
                      }
                      lineStart = lineEnd + 1;
                    }
                    return null;
                  };
                  const startPosition = positionForOffset(start, false);
                  const endPosition = positionForOffset(end, true);
                  if (!startPosition || !endPosition) return null;

                  const range = document.createRange();
                  range.setStart(startPosition.node, startPosition.offset);
                  range.setEnd(endPosition.node, endPosition.offset);
                  const sourceRect = Array.from(range.getClientRects()).find(rect => rect.width && rect.height);
                  const underlineRect = Array.from(error.getClientRects()).find(rect => rect.width && rect.height);
                  return sourceRect && underlineRect ? {
                    scrollTop: scroller.scrollTop,
                    source: sourceRect.toJSON(),
                    underline: underlineRect.toJSON(),
                  } : null;
                }"""
            )
            assert alignment and alignment["scrollTop"] > 0, "Expected enough CodeMirror text to exercise its scroll container"
            for edge in ("left", "top", "bottom"):
                assert abs(alignment["source"][edge] - alignment["underline"][edge]) <= 2, (
                    f"CodeMirror underline drifted at scroll offset {alignment['scrollTop']}: {alignment}"
                )
            assert page.locator("#ai-grammar-float").count() == 0, "CodeMirror results should be interactive inline underlines, not a detached panel"
            print("  PASS: CodeMirror inline underline stays aligned while scrolling")

            editor.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            page.keyboard.type("This sentence have a grammar mistake that should be corrected.", delay=5)
            live_error = page.locator(".ag-live-error[data-live-draft]")
            live_error.wait_for(timeout=30_000)
            live_error.hover()
            page.locator(".ai-grammar-tooltip .ag-apply").wait_for(timeout=3_000)
            page.locator(".ai-grammar-tooltip .ag-apply").click()
            page.wait_for_function(
                """() => document.querySelector('pi-webui-app')?.shadowRoot
                  ?.querySelector('prompt-editor')?.shadowRoot
                  ?.querySelector('.cm-content')?.textContent ===
                    'This sentence has a grammar mistake that should be corrected.'""",
                timeout=10_000,
            )
            print("  PASS: inline CodeMirror grammar error can apply its correction")

            editor.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Backspace")
            page.keyboard.type("Intro line.", delay=5)
            page.keyboard.press("Shift+Enter")
            page.keyboard.type("This sentence have a grammar mistake that should be corrected.", delay=5)
            page.keyboard.press("Shift+Enter")
            page.keyboard.type("?/fix", delay=5)
            page.wait_for_function(
                """() => document.querySelector('pi-webui-app')?.shadowRoot
                  ?.querySelector('prompt-editor')?.shadowRoot
                  ?.querySelector('.cm-content')?.innerText ===
                    'Intro line.\\nThis sentence has a grammar mistake that should be corrected.'""",
                timeout=60_000,
            )
            print("  PASS: multiline CodeMirror ?/fix preserves line breaks")

            context.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
