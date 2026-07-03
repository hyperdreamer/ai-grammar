// =============================================================================
// teams-bridge.js — Teams live-draft support module for AI Grammar Checker
// =============================================================================
//
// Self-contained content script loaded on Teams URLs only.  Hooks into
// CKEditor 5's change:data event to drive live-draft grammar checks and
// displays a floating error panel built with Trusted-Types-safe DOM APIs.
//
// Does NOT modify content.js.  Does NOT share mutable state with it.
// =============================================================================

(function () {
  'use strict';

  // ── Guard: only run on Teams domains ──────────────────────────────────
  const isTeams = /^teams\.(cloud\.)?microsoft(\.com)?$/i.test(location.hostname);
  if (!isTeams) return;

  // ── Configuration ─────────────────────────────────────────────────────
  const CHECK_DELAY_DEFAULT = 5000; // ms idle before grammar check fires
  const MIN_CHARS_DEFAULT = 30;
  const POLL_INTERVAL_MS = 500; // how often the idle timer polls
  const AUTO_DISMISS_MS = 30_000; // auto-hide the float panel after
  const CKEDITOR_INSTANCE_WAIT_MS = 8000; // max wait for ckeditorInstance
  const PANEL_ID = 'ag-teams-float';

  // ── State ─────────────────────────────────────────────────────────────
  let editorElement = null; // the .ck-editor__editable DOM element
  let lastEditTime = 0;
  let liveTarget = null;
  let checkDelay = CHECK_DELAY_DEFAULT;
  let minChars = MIN_CHARS_DEFAULT;
  let abortController = null;
  let checkGeneration = 0; // monotonic counter — only latest check wins
  let floatEl = null;
  let floatDismissTimer = null;
  let contextInvalidated = false;

  // MutationObserver for SPA navigation (editor appears / disappears)
  let domObserver = null;
  let ckeWatchInterval = null;
  let changeDataUnbind = null;

  // ── Logging ───────────────────────────────────────────────────────────
  const log = (...args) => console.debug('[AI Grammar Teams]', ...args);

  // ── Storage helpers ───────────────────────────────────────────────────
  async function safeGetStorage(defaults) {
    if (contextInvalidated) return defaults;
    try {
      return await chrome.storage.sync.get(defaults);
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        contextInvalidated = true;
        log('Extension context invalidated, using defaults');
        return defaults;
      }
      throw e;
    }
  }

  // ── HTML entity decoding (no innerHTML — Trusted Types safe) ──────────
  function decodeHtmlEntities(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      );
  }

  // ── Strip CKEditor HTML → plain text ──────────────────────────────────
  function editorGetPlainText() {
    if (!editorElement) return '';
    return (editorElement.textContent || '').replace(/\u00A0/g, ' ').trim();
  }

  function stripHtml(html) {
    let text = html
      // Block-level elements → newline
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
      // <br> variants → newline
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove all remaining tags
      .replace(/<[^>]*>/g, '');
    text = decodeHtmlEntities(text);
    // Collapse runs of newlines, trim
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }

  // ── CKEditor detection ────────────────────────────────────────────────
  function findCKEditorElement() {
    const el = document.querySelector(
      '.ck-editor__editable[contenteditable="true"][role="textbox"]'
    );
    if (el) return el;
    // Broader search — any ck-editor__editable
    const all = document.querySelectorAll('.ck-editor__editable[contenteditable="true"]');
    for (const cand of all) {
      return cand;
    }
    return null;
  }

  /** Wait for ckeditorInstance to appear on an element (CKEditor boots async).
   *  CKEditor sets ckeditorInstance in the MAIN world, which is invisible
   *  to the content script's isolated world.  We use chrome.scripting to
   *  execute in the MAIN world and read the instance. */
  function waitForInstance(el, timeoutMs = CKEDITOR_INSTANCE_WAIT_MS) {
    return new Promise((resolve) => {
      // Fast path: check if instance is somehow available directly
      if (el.ckeditorInstance) return resolve(el.ckeditorInstance);

      // Poll from the MAIN world via chrome.scripting.executeScript
      let attempts = 0;
      const maxAttempts = Math.ceil(timeoutMs / 500);
      const iv = setInterval(() => {
        attempts++;
        try {
          chrome.scripting.executeScript({
            target: { tabId: chrome.devtools?.inspectedWindow?.tabId },
            world: 'MAIN',
            func: () => {
              const el = document.querySelector('.ck-editor__editable[contenteditable="true"]');
              return !!(el && el.ckeditorInstance);
            },
          }, (results) => {
            if (chrome.runtime.lastError) {
              // Fallback: try direct access
              if (attempts >= maxAttempts) {
                clearInterval(iv);
                resolve(null);
              }
              return;
            }
            if (results?.[0]?.result) {
              clearInterval(iv);
              // Now we know instance exists — try to access it
              resolve(el.ckeditorInstance || null);
            } else if (attempts >= maxAttempts) {
              clearInterval(iv);
              resolve(null);
            }
          });
        } catch (e) {
          if (attempts >= maxAttempts) {
            clearInterval(iv);
            resolve(null);
          }
        }
      }, 500);
    });
  }

  // ── Attach / detach editor ────────────────────────────────────────────
  let editorMo = null;  // MutationObserver for CKEditor DOM changes

  function attachEditor(element) {
    if (editorElement === element) return; // already attached
    detachEditor();

    editorElement = element;
    log('CKEditor attached (via DOM MutationObserver)');

    // Use MutationObserver to detect text changes in the CKEditor DOM.
    // This works across isolated worlds — DOM mutations are always visible.
    editorMo = new MutationObserver(() => {
      onEditorChange();
    });
    editorMo.observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    log('CKEditor MutationObserver active');
  }

  function detachEditor() {
    dismissErrors();
    if (editorMo) {
      editorMo.disconnect();
      editorMo = null;
    }
    if (changeDataUnbind) {
      try { changeDataUnbind(); } catch { /* ignore */ }
      changeDataUnbind = null;
    }
    // Abort in-flight check
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    checkGeneration++;
    editorElement = null;
    liveTarget = null;
    lastEditTime = 0;
    log('CKEditor detached');
  }

  // ── Editor change handler ─────────────────────────────────────────────
  function onEditorChange() {
    if (!editorElement) return;
    lastEditTime = Date.now();
    liveTarget = editorElement;
  }

  // ── Grammar check pipeline ────────────────────────────────────────────
  /**
   * Fire-and-forget grammar check.  Uses a generation counter so results
   * from superseded checks are silently discarded — only the latest check
   * is allowed to update the UI.
   */
  async function runGrammarCheck(text) {
    if (!editorElement || !document.contains(editorElement)) return;

    // Abort any previous in-flight check
    if (abortController) {
      abortController.abort();
    }

    const myGen = ++checkGeneration;
    abortController = new AbortController();

    try {
      log('Checking grammar:', text.length, 'chars');
      const resp = await callGrammarCheck(text, abortController.signal);

      // Superseded by a newer check or editor detached?
      if (myGen !== checkGeneration) return;
      abortController = null;

      // Editor still present?
      if (!document.contains(editorElement)) return;

      if (!resp.ok) {
        log('Check failed:', resp.error);
        return;
      }

      if (resp.errors?.length > 0) {
        showErrors(resp.errors);
      } else {
        dismissErrors();
      }
    } catch (err) {
      // Superseded — ignore all errors (including AbortError)
      if (myGen !== checkGeneration) return;
      abortController = null;
      if (err.name !== 'AbortError') {
        log('Grammar check error:', err);
      }
    }
  }

  /** Call the grammar backend directly via fetch (avoids SW round-trip). */
  async function callGrammarCheck(text, signal) {
    const settings = await safeGetStorage({
      grammarHost: '127.0.0.1',
      grammarPort: 8766,
      grammarLanguage: 'auto',
      grammarEnabled: true,
    });

    if (!settings.grammarEnabled) {
      return { ok: false, error: 'Grammar checker is disabled' };
    }

    const url = `http://${settings.grammarHost}:${settings.grammarPort}/check?_=${Date.now()}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: settings.grammarLanguage || 'auto' }),
        signal,
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        return { ok: false, error: `Backend error (${resp.status}): ${errBody.slice(0, 200)}` };
      }

      const data = await resp.json();
      return { ok: true, errors: data.errors || [], model: data.model || '' };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: true, aborted: true };
      return { ok: false, error: e.message };
    }
  }

  // ── Idle-timer poll ───────────────────────────────────────────────────
  let pollIntervalId = null;

  function startPolling() {
    if (pollIntervalId) return;
    pollIntervalId = setInterval(() => {
      // Clear state if editor text was emptied externally
      if (liveTarget === editorElement && editorElement && document.contains(editorElement)) {
        const text = editorGetPlainText();
        if (!text) {
          dismissErrors();
          liveTarget = null;
        }
      }

      if (!liveTarget || liveTarget !== editorElement) return;
      if (!document.contains(editorElement)) {
        liveTarget = null;
        return;
      }

      const elapsed = Date.now() - lastEditTime;
      if (elapsed < checkDelay) return;

      // Capture what we need before resetting state
      const text = editorGetPlainText();
      liveTarget = null; // prevent re-triggering while check is in flight

      if (text.length < minChars) {
        dismissErrors();
        return;
      }

      // Fire-and-forget — poll loop does not await
      runGrammarCheck(text);
    }, POLL_INTERVAL_MS);
    log('Polling started');
  }

  function stopPolling() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  }

  // ── Load settings from storage ────────────────────────────────────────
  async function loadSettings() {
    const s = await safeGetStorage({
      grammarLiveDelay: 5,
      grammarLiveMinChars: 30,
    });
    checkDelay = (s.grammarLiveDelay || 5) * 1000;
    minChars = s.grammarLiveMinChars || 30;
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.grammarLiveDelay) {
          checkDelay = (changes.grammarLiveDelay.newValue || 5) * 1000;
        }
        if (changes.grammarLiveMinChars) {
          minChars = changes.grammarLiveMinChars.newValue || 30;
        }
      });
    } catch {
      // Extension context invalidated
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Trusted-Types-safe floating error panel
  // ══════════════════════════════════════════════════════════════════════

  function showErrors(errors) {
    dismissErrors();

    if (!errors?.length) return;

    const panel = buildErrorPanel(errors);
    floatEl = panel;
    document.body.appendChild(panel);

    // Position near the editor
    if (editorElement && document.contains(editorElement)) {
      positionPanel(panel, editorElement);
    }

    // Reposition on resize / scroll
    const reposition = () => {
      if (!floatEl || !document.contains(floatEl)) return;
      if (editorElement && document.contains(editorElement)) {
        positionPanel(floatEl, editorElement);
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    panel._agReposition = reposition;

    // Auto-dismiss
    floatDismissTimer = setTimeout(dismissErrors, AUTO_DISMISS_MS);
  }

  function dismissErrors() {
    if (floatDismissTimer) {
      clearTimeout(floatDismissTimer);
      floatDismissTimer = null;
    }
    if (floatEl) {
      const reposition = floatEl._agReposition;
      if (reposition) {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
      }
      if (document.contains(floatEl)) floatEl.remove();
      floatEl = null;
    }
  }

  function positionPanel(panel, anchor) {
    const gap = 8;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    let top = anchorRect.bottom + gap;
    if (top + panelRect.height > window.innerHeight - gap) {
      top = Math.max(gap, anchorRect.top - panelRect.height - gap);
    }
    const left = Math.min(
      Math.max(gap, anchorRect.left),
      Math.max(gap, window.innerWidth - panelRect.width - gap)
    );

    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
  }

  // ── Build the error panel — Trusted-Types-safe (no innerHTML) ─────────

  function buildErrorPanel(errors) {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // -- Inline styles (same visual design as showErrorFloat in content.js) --
    setPanelStyles(panel);

    // -- <style> for CSS classes (via textContent, not innerHTML) --
    const styleEl = document.createElement('style');
    styleEl.textContent = getPanelCSS();
    panel.appendChild(styleEl);

    // -- Header --
    const header = document.createElement('div');
    header.className = 'agf-header';

    const headerSpan = document.createElement('span');
    headerSpan.textContent =
      '🔍 ' + errors.length + ' error' + (errors.length > 1 ? 's' : '') + ' found';
    header.appendChild(headerSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'agf-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', dismissErrors);
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // -- Error items --
    for (const e of errors) {
      const item = buildErrorItem(e);
      panel.appendChild(item);
    }

    // -- Apply-all footer --
    const footer = document.createElement('div');
    footer.className = 'agf-footer';
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'agf-apply-all';
    applyAllBtn.textContent = 'Apply all fixes';
    applyAllBtn.addEventListener('click', () => applyAllCorrections(errors));
    footer.appendChild(applyAllBtn);
    panel.appendChild(footer);

    return panel;
  }

  function buildErrorItem(err) {
    const item = document.createElement('div');
    item.className = 'agf-item';

    // Row: original strikethrough → correction
    const row = document.createElement('div');
    row.className = 'agf-row';

    const original = document.createElement('span');
    original.className = 'agf-original';
    original.textContent = err.error || '';

    const arrow = document.createElement('span');
    arrow.className = 'agf-arrow';
    arrow.textContent = ' → ';

    const correction = document.createElement('span');
    correction.className = 'agf-correction';
    correction.textContent = err.correction || '';

    row.appendChild(original);
    row.appendChild(arrow);
    row.appendChild(correction);

    // Apply button for this single error
    const applyBtn = document.createElement('button');
    applyBtn.className = 'agf-apply';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      applySingleCorrection(err);
    });
    row.appendChild(applyBtn);

    item.appendChild(row);

    // Explanation line
    if (err.explanation) {
      const explain = document.createElement('div');
      explain.className = 'agf-explain';
      explain.textContent = err.explanation;
      item.appendChild(explain);
    }

    return item;
  }

  // ── Panel inline styles (position & container properties) ─────────────
  function setPanelStyles(panel) {
    const s = panel.style;
    s.position = 'fixed';
    s.zIndex = '2147483646';
    s.maxWidth = '420px';
    s.maxHeight = '60vh';
    s.overflowY = 'auto';
    s.padding = '0';
    s.fontFamily =
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    s.fontSize = '13px';
    s.lineHeight = '1.5';
    s.borderRadius = '12px';
    s.boxShadow = '0 8px 32px rgba(0,0,0,0.35)';
    s.animation = 'agfadein 0.2s ease';
    // Default position — bottom-right
    s.bottom = '16px';
    s.right = '16px';

    // Color scheme (dark default)
    s.background = '#1e293b';
    s.color = '#f1f5f9';
  }

  // ── Panel CSS (class-based rules injected via <style> element) ────────
  function getPanelCSS() {
    return (
      [
        '@keyframes agfadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }',
        '#' + PANEL_ID + ' .agf-header {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  padding: 12px 16px; border-bottom: 1px solid #334155;',
        '  font-weight: 600; font-size: 14px; position: sticky; top: 0;',
        '  background: inherit; border-radius: 12px 12px 0 0; z-index: 1;',
        '}',
        '#' + PANEL_ID + ' .agf-close {',
        '  background: none; border: none; color: #94a3b8; cursor: pointer;',
        '  font-size: 18px; line-height: 1; padding: 0 0 0 12px;',
        '}',
        '#' + PANEL_ID + ' .agf-close:hover { color: #f1f5f9; }',
        '#' + PANEL_ID + ' .agf-item {',
        '  padding: 10px 16px; border-bottom: 1px solid #1e293b;',
        '}',
        '#' + PANEL_ID + ' .agf-item:last-child { border-bottom: none; }',
        '#' + PANEL_ID + ' .agf-item:hover { background: #0f172a; }',
        '#' + PANEL_ID + ' .agf-row {',
        '  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;',
        '}',
        '#' + PANEL_ID + ' .agf-original {',
        '  color: #f87171; text-decoration: line-through;',
        '}',
        '#' + PANEL_ID + ' .agf-arrow { color: #64748b; }',
        '#' + PANEL_ID + ' .agf-correction { color: #4ade80; font-weight: 600; }',
        '#' + PANEL_ID + ' .agf-explain {',
        '  color: #64748b; font-size: 11px; margin-top: 2px;',
        '}',
        '#' + PANEL_ID + ' .agf-apply {',
        '  margin-left: auto; background: #334155; color: #e2e8f0;',
        '  border: none; border-radius: 6px; padding: 2px 10px;',
        '  font-size: 12px; cursor: pointer; font-family: inherit;',
        '  white-space: nowrap;',
        '}',
        '#' + PANEL_ID + ' .agf-apply:hover { background: #475569; }',
        '#' + PANEL_ID + ' .agf-footer {',
        '  padding: 10px 16px; border-top: 1px solid #334155;',
        '  position: sticky; bottom: 0; background: inherit;',
        '  border-radius: 0 0 12px 12px;',
        '}',
        '#' + PANEL_ID + ' .agf-apply-all {',
        '  width: 100%; background: #2563eb; color: #fff;',
        '  border: none; border-radius: 8px; padding: 8px 16px;',
        '  font-size: 13px; font-weight: 600; cursor: pointer;',
        '  font-family: inherit;',
        '}',
        '#' + PANEL_ID + ' .agf-apply-all:hover { background: #1d4ed8; }',
        // Light mode overrides
        '@media (prefers-color-scheme: light) {',
        '  #' + PANEL_ID + ' {',
        '    background: #ffffff; color: #0f172a;',
        '    box-shadow: 0 8px 32px rgba(0,0,0,0.12);',
        '  }',
        '  #' + PANEL_ID + ' .agf-header {',
        '    border-bottom-color: #e2e8f0;',
        '  }',
        '  #' + PANEL_ID + ' .agf-close { color: #64748b; }',
        '  #' + PANEL_ID + ' .agf-close:hover { color: #0f172a; }',
        '  #' + PANEL_ID + ' .agf-item { border-bottom-color: #f1f5f9; }',
        '  #' + PANEL_ID + ' .agf-item:hover { background: #f8fafc; }',
        '  #' + PANEL_ID + ' .agf-original { color: #dc2626; }',
        '  #' + PANEL_ID + ' .agf-correction { color: #16a34a; }',
        '  #' + PANEL_ID + ' .agf-explain { color: #64748b; }',
        '  #' + PANEL_ID + ' .agf-apply {',
        '    background: #e2e8f0; color: #334155;',
        '  }',
        '  #' + PANEL_ID + ' .agf-apply:hover { background: #cbd5e1; }',
        '  #' + PANEL_ID + ' .agf-footer {',
        '    border-top-color: #e2e8f0;',
        '  }',
        '}',
      ].join('\n')
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // Apply correction — uses beforeinput event (processed by CKEditor)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Apply a single correction.  Fetches current text, applies the
   * character-offset-based replacement, then pushes the result back
   * into the CKEditor via beforeinput.
   */
  function applySingleCorrection(err) {
    if (!editorElement) return;
    const text = editorGetPlainText();
    const s = Math.max(0, Number(err.start) || 0);
    const e = Math.min(text.length, Number(err.end) || text.length);
    if (s >= e) return;
    const corrected = text.slice(0, s) + (err.correction || '') + text.slice(e);
    applyTextToEditor(corrected);
  }

  /** Apply ALL corrections at once (reverse-sorted by offset). */
  function applyAllCorrections(errors) {
    if (!editorElement) return;
    let text = editorGetPlainText();

    const fixes = errors
      .map((e) => ({
        start: Math.max(0, Number(e.start) || 0),
        end: Math.min(text.length, Number(e.end) || text.length),
        correction: e.correction || '',
      }))
      .filter((f) => f.start < f.end && f.correction)
      .sort((a, b) => b.start - a.start); // descending — safe in-place edits

    for (const f of fixes) {
      text = text.slice(0, f.start) + f.correction + text.slice(f.end);
    }

    applyTextToEditor(text);
  }

  /**
   * Push corrected plain text into CKEditor via beforeinput +
   * insertReplacementText.  CKEditor 5's Input plugin processes
   * beforeinput natively — this is the same approach content.js
   * uses for contentEditable live-draft fixes.
   */
  function applyTextToEditor(text) {
    if (!editorElement || !document.contains(editorElement)) return;

    try {
      const editable = editorElement;
      editable.focus();

      // Select all existing content
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editable);
      sel.removeAllRanges();
      sel.addRange(range);

      // Dispatch beforeinput — CKEditor's typing feature handles this
      editable.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: text,
        })
      );

      // Verify the fix was applied
      const currentText = editorGetPlainText();
      if (!currentText.includes(text.replace(/​/g, ''))) {
        // beforeinput didn't work — fall back to clipboard copy
        fallbackClipboardCopy(text);
      } else {
        dismissErrors();
      }
    } catch {
      fallbackClipboardCopy(text);
    }
  }

  function fallbackClipboardCopy(text) {
    try {
      navigator.clipboard.writeText(text).catch(() => {});
    } catch { /* ignore */ }
    if (editorElement) editorElement.focus();
    log('Copied corrected text to clipboard (fallback)');
  }

  // ══════════════════════════════════════════════════════════════════════
  // SPA navigation — detect editor appearance / disappearance
  // ══════════════════════════════════════════════════════════════════════

  /** Try to attach to a CKEditor element. */
  function tryAttach(el) {
    try {
      if (!el || editorElement === el) return;
      log('tryAttach: attaching to CKEditor');
      attachEditor(el);
    } catch(e) {
      log('tryAttach error:', e.message, e.stack?.substring(0, 200));
    }
  }

  function setupDOMObserver() {
    if (domObserver) return;

    domObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // Direct match — element itself is a CKEditor editable
          if (node.matches?.('.ck-editor__editable[contenteditable="true"]')) {
            tryAttach(node);
            break;
          }
          // Descendant match — CKEditor editable is nested inside added node
          const found = node.querySelector?.(
            '.ck-editor__editable[contenteditable="true"]'
          );
          if (found) {
            tryAttach(found);
            break;
          }
        }
        for (const node of m.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node === editorElement || node.contains(editorElement)) {
            detachEditor();
            break;
          }
        }
      }
    });

    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Initialization
  // ══════════════════════════════════════════════════════════════════════

  async function init() {
    log('Initializing Teams bridge');

    // Load settings
    await loadSettings();
    watchSettings();

    // Watch for CKEditor appearing/disappearing (SPA navigation)
    setupDOMObserver();

    // Start the idle-timer polling loop
    startPolling();

    // Teams is a heavy SPA — the CKEditor loads asynchronously.
    // Start scanning immediately and keep scanning until we find it.
    let scanCount = 0;
    // DOM debug channel (visible from main world via CDP)
    const debugEl = document.createElement('div');
    debugEl.id = 'ag-teams-debug';
    debugEl.style.cssText = 'display:none';
    document.documentElement.appendChild(debugEl);

    ckeWatchInterval = setInterval(() => {
      scanCount++;
      debugEl.textContent = JSON.stringify({
        scan: scanCount,
        time: Date.now(),
        editorElement: !!editorElement,
        ckFound: !!findCKEditorElement(),
      });
      if (scanCount <= 5 || scanCount % 10 === 0) {
        log('scan #' + scanCount + ' editorElement=' + !!editorElement + ' findCKEditorElement=' + !!findCKEditorElement());
      }
      if (editorElement) {
        clearInterval(ckeWatchInterval);
        ckeWatchInterval = null;
        return;
      }
      const found = findCKEditorElement();
      if (found) {
        try {
          tryAttach(found);
        } catch(e) {
          log('scan error in tryAttach:', e.message);
        }
      }
    }, 500);
  }

  // ── Cleanup (for extension reload / context invalidation) ─────────────
  function cleanup() {
    stopPolling();
    detachEditor();
    dismissErrors();
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (ckeWatchInterval) {
      clearInterval(ckeWatchInterval);
      ckeWatchInterval = null;
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Clean up on extension context invalidation
  try {
    if (chrome.runtime?.id) {
      // Extension is alive — nothing to do
    }
  } catch {
    cleanup();
  }
})();
