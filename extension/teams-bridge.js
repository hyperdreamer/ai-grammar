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

  // Shared API wrappers from src/api.js (loaded by content.js).  See Block 2.4.
  const { checkGrammar, polishGrammar, translateText } = window.__aiGrammar;

  // ── Configuration ─────────────────────────────────────────────────────
  const CHECK_DELAY_DEFAULT = 5000; // ms idle before grammar check fires
  const MIN_CHARS_DEFAULT = 30;
  const POLL_INTERVAL_MS = 500; // how often the idle timer polls
  const AUTO_DISMISS_MS = 30_000; // auto-hide the float panel after
  const PANEL_ID = 'ag-teams-float';

  // ── State ─────────────────────────────────────────────────────────────
  const log = (...args) => console.debug('[AI Grammar Teams]', ...args);
  let editorElement = null; // the .ck-editor__editable DOM element
  let lastEditTime = 0;
  let liveTarget = null;
  let lastKnownText = ''; // polling fallback — compare text to detect changes
  let checkDelay = CHECK_DELAY_DEFAULT;
  let minChars = MIN_CHARS_DEFAULT;
  let abortController = null;
  let checkGeneration = 0; // monotonic counter — only latest check wins
  let floatEl = null;
  let floatDismissTimer = null;
  let polishAbortController = null; // abort in-flight polish on user edit
  let commandBarEl = null;          // floating command bar
  let fixAbortController = null;    // abort in-flight fix on user edit
  let grammarEnabled = true;       // cached on/off state — read from storage on init
  let translateAbortController = null; // abort in-flight translate on user edit
  let translatePickerEl = null;    // floating language picker
  let editorFocusHandler = null;   // focus/blur listeners on editorElement

  // Inline language list (subset of src/languages.js — teams-bridge is IIFE)
  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'zh', name: 'Chinese (中文)' },
    { code: 'ja', name: 'Japanese (日本語)' },
    { code: 'ko', name: 'Korean (한국어)' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'es', name: 'Spanish' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ru', name: 'Russian' },
    { code: 'it', name: 'Italian' },
    { code: 'ar', name: 'Arabic' },
    { code: 'nl', name: 'Dutch' },
    { code: 'hi', name: 'Hindi' },
    { code: 'th', name: 'Thai' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'pl', name: 'Polish' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'fi', name: 'Finnish' },
    { code: 'no', name: 'Norwegian' },
    { code: 'da', name: 'Danish' },
    { code: 'cs', name: 'Czech' },
    { code: 'el', name: 'Greek' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'ro', name: 'Romanian' },
    { code: 'id', name: 'Indonesian' },
    { code: 'ms', name: 'Malay' },
    { code: 'tl', name: 'Filipino' },
    { code: 'bn', name: 'Bengali' },
    { code: 'fa', name: 'Persian' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'ur', name: 'Urdu' },
    { code: 'sw', name: 'Swahili' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'lv', name: 'Latvian' },
    { code: 'et', name: 'Estonian' },
  ];
  const COMMON_LANGS = ['en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt'];

  // Detect Teams actual theme (not OS — Teams has its own theme setting)
  function isTeamsLightTheme() {
    try {
      // Teams body is often transparent — try multiple elements
      const els = [
        document.querySelector('.ts-left-rail, .ts-left-rail-header, .app-header'),
        document.querySelector('[data-tid="app-bar"]'),
        document.querySelector('header, nav, .left-rail'),
        document.documentElement,
        document.body,
      ].filter(Boolean);
      for (const el of els) {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/[\d.]+/g);
        if (!m || m.length < 3) continue;
        const [r, g, b, a] = [parseFloat(m[0]), parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3] || '1')];
        if (a < 0.1) continue; // skip transparent/near-transparent
        const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        return L > 0.5;
      }
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
    } catch { return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false; }
  }

  // MutationObserver for SPA navigation (editor appears / disappears)
  let domObserver = null;
  let ckeWatchInterval = null;
  let changeDataUnbind = null;
  let ckeBridgeMsgHandler = null; // postMessage handler from main-world CKEditor bridge

  // ── Progress badges (vertical stack, bottom-right) ────────────────────
  // Badge state + helpers now live in extension/src/indicators.js and
  // extension/src/state.js, exposed on window.__aiGrammar.  All call
  // sites below reference them through that namespace.
  // Teams call sites pass (text, type, durationMs); the shared function
  // takes (text, durationMs, type) — this shim reorders the args.
  function showResultBadge(text, type, durationMs) {
    return window.__aiGrammar.showResultBadge(text, durationMs, type);
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

  // ── Attach / detach editor ────────────────────────────────────────────
  let editorMo = null;  // MutationObserver for CKEditor DOM changes

  function attachEditor(element) {
    if (editorElement === element) return; // already attached
    detachEditor();

    editorElement = element;
    log('CKEditor attached');

    // ── Layer 1: MutationObserver (fast path for some CKEditor configs) ──
    // CKEditor 5 prevents beforeinput, so the native 'input' event never
    // fires.  DOM mutations are one possible signal, but CKEditor's own
    // internal MutationObserver rapidly reverts ViewRenderer-external DOM
    // changes (https://ckeditor.com/docs/ckeditor5/latest/api/module_engine_view_observer_mutationobserver-MutationObserver.html),
    // so this observer may not fire reliably in all CKEditor configurations.
    // Layer 2 (polling fallback) handles the general case.
    editorMo = new MutationObserver(() => {
      onEditorChange();
    });
    editorMo.observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    log('CKEditor MutationObserver active');

    // ── Layer 2: Main-world CKEditor event bridge ───────────────────────
    // Injects a tiny script into the MAIN world that listens for CKEditor's
    // internal model change event and forwards it to the content script via
    // window.postMessage.  This is more responsive than polling and doesn't
    // depend on DOM mutation observability.
    setupCKEditorBridge();

    // ── Initialize polling fallback state ───────────────────────────────
    lastKnownText = editorGetPlainText() || '';
    liveTarget = element;
    lastEditTime = Date.now();

    // ── Focus/blur — show command bar on focus, hide on blur ──────────
    if (editorFocusHandler) {
      element.removeEventListener('focus', editorFocusHandler.onFocus);
      element.removeEventListener('blur', editorFocusHandler.onBlur);
    }
    const onFocus = () => {
      const text = editorGetPlainText();
      if (text && text.length >= minChars) {
        showCommandBar();
      }
    };
    const onBlur = () => {
      // Delay so click events on command bar buttons fire before dismiss
      setTimeout(() => {
        if (document.activeElement !== element) {
          dismissCommandBar();
        }
      }, 150);
    };
    element.addEventListener('focus', onFocus);
    element.addEventListener('blur', onBlur);
    editorFocusHandler = { onFocus, onBlur };
  }

  function detachEditor() {
    dismissErrors();
    dismissCommandBar();
    dismissTranslatePicker();
    if (editorFocusHandler && editorElement) {
      editorElement.removeEventListener('focus', editorFocusHandler.onFocus);
      editorElement.removeEventListener('blur', editorFocusHandler.onBlur);
      editorFocusHandler = null;
    }
    if (editorMo) {
      editorMo.disconnect();
      editorMo = null;
    }
    if (changeDataUnbind) {
      try { changeDataUnbind(); } catch { /* ignore */ }
      changeDataUnbind = null;
    }
    teardownCKEditorBridge();
    // Abort in-flight check
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    checkGeneration++;
    editorElement = null;
    liveTarget = null;
    lastEditTime = 0;
    lastKnownText = '';
    log('CKEditor detached');
  }

  // ── Main-world CKEditor event bridge ──────────────────────────────────
  //
  // CKEditor 5's editable element and its ckeditorInstance live in the
  // MAIN world.  Content scripts run in an ISOLATED world and cannot
  // access window.ckeditorInstance directly.  We inject a tiny <script>
  // into the page (which executes in the MAIN world) that listens for
  // CKEditor's internal model `change:data` event and forwards it to
  // the content script via window.postMessage — the standard Chrome
  // extension cross-world communication channel.

  function injectMainWorldBridge() {
    if (window.__agCKEBridgeInjected) return;
    window.__agCKEBridgeInjected = true;

    // Use chrome.scripting.executeScript from the background worker
    // to inject code into the MAIN world.  This bypasses page CSP
    // (Teams blocks inline scripts and blob URLs).
    chrome.runtime.sendMessage(
      { type: 'ag-inject-cke-bridge' },
      (response) => {
        if (response?.ok) {
          log('Main-world CKEditor bridge injected (via background SW)');
        } else {
          log('Main-world bridge injection failed:', response?.error || 'unknown');
          // Fall back to blob URL approach as last resort
          fallbackBlobInjection();
        }
      }
    );
  }

  function fallbackBlobInjection() {
    const scriptId = 'ag-cke-bridge-script-fallback';
    if (document.getElementById(scriptId)) return;
    const bridgeCode = (
      '(function(){' +
      'if(window.__agCKEBridge)return;window.__agCKEBridge=true;' +
      'var POLL_MS=500;(function poll(){' +
      'var el=document.querySelector(\'.ck-editor__editable[contenteditable="true"]\');' +
      'var instance=el&&el.ckeditorInstance;' +
      'if(!instance){setTimeout(poll,POLL_MS);return;}' +
      'try{instance.model.document.on(\'change:data\',function(){' +
      'try{window.postMessage({source:"ag-cke-bridge",type:"change"},"*");}catch(e){}' +
      '});}catch(e){setTimeout(poll,POLL_MS);}' +
      '})();})()'
    );
    const blob = new Blob([bridgeCode], { type: 'application/javascript' });
    const script = document.createElement('script');
    script.id = scriptId;
    script.src = URL.createObjectURL(blob);
    script.onload = () => log('Fallback blob bridge injected');
    (document.head || document.documentElement).appendChild(script);
  }

  function setupCKEditorBridge() {
    teardownCKEditorBridge();
    ckeBridgeMsgHandler = (event) => {
      // Only accept messages from our own window (not iframes)
      if (event.source !== window) return;
      if (event.data && event.data.source === 'ag-cke-bridge' && event.data.type === 'change') {
        onEditorChange();
      }
    };
    window.addEventListener('message', ckeBridgeMsgHandler);
    injectMainWorldBridge();
  }

  function teardownCKEditorBridge() {
    if (ckeBridgeMsgHandler) {
      window.removeEventListener('message', ckeBridgeMsgHandler);
      ckeBridgeMsgHandler = null;
    }
    // Remove the injected bridge script from the page DOM
    const scriptEl = document.getElementById('ag-cke-bridge-script');
    if (scriptEl) scriptEl.remove();
  }

  // ── Editor change handler ─────────────────────────────────────────────
  function onEditorChange() {
    if (!editorElement) return;
    lastEditTime = Date.now();
    liveTarget = editorElement;
    // Keep polling-fallback state in sync so the idle-poll loop
    // doesn't redundantly re-detect this same change on the next tick.
    lastKnownText = editorGetPlainText() || '';
    if (lastEditTime % 5000 < 100) log('onEditorChange: idle timer reset');

    // Dismiss any floating panel (error or clean) on user edit
    dismissErrors();

    // Abort in-flight polish / fix / translate
    abortPolish();
    abortTranslate();
    if (fixAbortController) {
      fixAbortController.abort();
      fixAbortController = null;
      window.__aiGrammar.removePendingBadge('fixing');
    }
  }

  // ── Grammar check pipeline ────────────────────────────────────────────
  /**
   * Fire-and-forget grammar check.  Uses a generation counter so results
   * from superseded checks are silently discarded — only the latest check
   * is allowed to update the UI.
   */
  async function runGrammarCheck(text) {
    if (!editorElement || !document.contains(editorElement)) return;

    // Don't start a grammar check while a polish is in flight —
    // only user editing should terminate the polish.
    if (polishAbortController) {
      log('Skipping grammar check — polish in progress');
      return;
    }

    // Abort any previous in-flight check
    if (abortController) {
      abortController.abort();
    }

    const myGen = ++checkGeneration;
    abortController = new AbortController();

    window.__aiGrammar.showPendingBadge('checking', 'Checking grammar…');

    try {
      log('Checking grammar:', text.length, 'chars');
      const resp = await callGrammarCheck(text, abortController.signal);

      // Superseded by a newer check or editor detached?
      if (myGen !== checkGeneration) {
        window.__aiGrammar.removePendingBadge('checking');
        return;
      }
      abortController = null;

      // Editor still present?
      if (!document.contains(editorElement)) { window.__aiGrammar.removePendingBadge('checking'); return; }

      if (!resp.ok) {
        window.__aiGrammar.removePendingBadge('checking');
        showResultBadge('✗ Check failed', 'error', 4000);
        log('Check failed:', resp.error);
        return;
      }

      window.__aiGrammar.removePendingBadge('checking');

      if (resp.errors?.length > 0) {
        log('Check complete:', resp.errors.length, 'errors found');
        showResultBadge(resp.errors.length + ' error' + (resp.errors.length > 1 ? 's' : '') + ' found', 'done', 3000);
        showErrors(resp.errors);
      } else {
        log('Check complete: 0 errors');
        showResultBadge('✓ No errors', 'done', 3000);
        showCleanPanel();
      }
    } catch (err) {
      // Superseded — ignore all errors (including AbortError)
      if (myGen !== checkGeneration) {
        window.__aiGrammar.removePendingBadge('checking');
        return;
      }
      abortController = null;
      if (err.name !== 'AbortError') {
        window.__aiGrammar.removePendingBadge('checking');
        showResultBadge('✗ ' + (err.message || 'Check failed'), 'error', 4000);
        log('Grammar check error:', err);
      }
    }
  }

  async function callPolish(text, signal) {
    return await polishGrammar(text, { signal, language: 'auto' });
  }

  /** Call the grammar backend directly via fetch (avoids SW round-trip). */
  async function callGrammarCheck(text, signal) {
    return await checkGrammar(text, { signal, language: 'auto' });
  }

  // ── Idle-timer poll ───────────────────────────────────────────────────
  let pollIntervalId = null;

  let pollTickCount = 0;
  function startPolling() {
    if (pollIntervalId) return;
    pollIntervalId = setInterval(() => {
      pollTickCount++;
      if (!editorElement || !document.contains(editorElement)) {
        if (pollTickCount <= 3) log('poll tick #' + pollTickCount + ': no editorElement, skipping');
        liveTarget = null;
        return;
      }

      const currentText = editorGetPlainText();

      // Log first few ticks for debugging
      if (pollTickCount <= 5 || pollTickCount % 20 === 0) {
        log('poll #' + pollTickCount + ': text="' + currentText.substring(0, 40) + '" len=' + currentText.length + ' lastLen=' + lastKnownText.length);
      }

      // Detect text changes by comparing content
      if (currentText !== lastKnownText) {
        if (currentText.length > 0 || lastKnownText.length > 0) {
          log('poll #' + pollTickCount + ': TEXT CHANGED! old="' + lastKnownText.substring(0, 30) + '" new="' + currentText.substring(0, 30) + '"');
        }
        lastKnownText = currentText;
        liveTarget = editorElement;
        lastEditTime = Date.now();

        // Dismiss panel + abort polish on any edit (safety net)
        dismissErrors();
        abortPolish();
        abortTranslate();
        if (fixAbortController) {
          fixAbortController.abort();
          fixAbortController = null;
          window.__aiGrammar.removePendingBadge('fixing');
        }
      }

      // Clear state if editor text was emptied externally
      if (liveTarget === editorElement && !currentText) {
        dismissErrors();
        dismissCommandBar();
        dismissTranslatePicker();
        liveTarget = null;
      }

      // Show/hide command bar based on text state
      // Note: showing is now handled by the focus event on the editor.
      // The poll loop only dismisses when text is too short or editor unfocused.
      if (!currentText || currentText.length < minChars) {
        dismissCommandBar();
      }

      if (!liveTarget || liveTarget !== editorElement) return;

      const elapsed = Date.now() - lastEditTime;
      if (elapsed < checkDelay) {
        if (pollTickCount % 10 === 0) log('poll #' + pollTickCount + ': idle=' + Math.round(elapsed/1000) + 's/' + Math.round(checkDelay/1000) + 's');
        return;
      }

      // Capture what we need before resetting state
      const text = currentText;
      liveTarget = null; // prevent re-triggering while check is in flight
      log('poll #' + pollTickCount + ': FIRING GRAMMAR CHECK for ' + text.length + ' chars');

      if (text.length < minChars) {
        log('poll #' + pollTickCount + ': text too short (' + text.length + ' < ' + minChars + '), dismissing');
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
    const s = await window.__aiGrammar.safeGetStorage({
      grammarLiveDelay: 5,
      grammarLiveMinChars: 30,
      grammarEnabled: true,
    });
    checkDelay = (s.grammarLiveDelay || 5) * 1000;
    minChars = s.grammarLiveMinChars || 30;
    grammarEnabled = s.grammarEnabled !== false;
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
        if (changes.grammarEnabled) {
          grammarEnabled = changes.grammarEnabled.newValue !== false;
          // Update command-bar toggle button styling if visible
          if (commandBarEl) {
            const toggleBtn = commandBarEl.querySelector('.ag-cmd-toggle');
            if (toggleBtn) {
              toggleBtn.textContent = grammarEnabled ? '🟢 On' : '🔴 Off';
              toggleBtn.className = 'ag-cmd-btn ag-cmd-toggle ' + (grammarEnabled ? 'ag-cmd-on' : 'ag-cmd-off');
            }
          }
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
    dismissCommandBar();

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

  /** Abort any in-flight polish operation. */
  function abortPolish() {
    if (polishAbortController) {
      polishAbortController.abort();
      polishAbortController = null;
      window.__aiGrammar.removePendingBadge('polishing');
    }
  }

  // ── Clean panel — shown when no errors found ──────────────────────────
  function showCleanPanel() {
    dismissErrors();
    dismissCommandBar();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    setPanelStyles(panel);

    // Shared panel CSS (header, items, footer, clean body)
    const styleEl = document.createElement('style');
    styleEl.textContent = getPanelCSS();
    panel.appendChild(styleEl);

    // Header — same structure as error panel
    const header = document.createElement('div');
    header.className = 'agf-header';

    const headerSpan = document.createElement('span');
    headerSpan.textContent = '✅ No errors found';
    header.appendChild(headerSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'agf-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', dismissErrors);
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Position and lifecycle
    floatEl = panel;
    document.body.appendChild(panel);

    if (editorElement && document.contains(editorElement)) {
      positionPanel(panel, editorElement);
    }

    const reposition = () => {
      if (!floatEl || !document.contains(floatEl)) return;
      if (editorElement && document.contains(editorElement)) {
        positionPanel(floatEl, editorElement);
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    panel._agReposition = reposition;

    floatDismissTimer = setTimeout(dismissErrors, AUTO_DISMISS_MS);
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

  // ── Floating command bar (Toggle / Polish / Fix / Check / Translate) ──
  const COMMAND_BAR_ID = 'ag-teams-cmds';

  function showCommandBar() {
    dismissCommandBar();

    const bar = document.createElement('div');
    bar.id = COMMAND_BAR_ID;

    // Inline positioning
    const s = bar.style;
    s.position = 'fixed';
    s.zIndex = '2147483645';
    s.display = 'flex';
    s.gap = '6px';
    s.padding = '6px 10px';
    s.borderRadius = '10px';
    s.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    s.fontSize = '12px';
    s.animation = 'agfadein 0.15s ease';

    // Color — CSS rules via style element
    const styleEl = document.createElement('style');
    styleEl.textContent = [
      '#' + COMMAND_BAR_ID + ' {',
      '  background: rgba(30,41,59,0.65); backdrop-filter: blur(12px);',
      '  -webkit-backdrop-filter: blur(12px);',
      '  color: #e2e8f0; box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
      '}',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-btn {',
      '  background: #334155; color: #e2e8f0; border: none;',
      '  border-radius: 6px; padding: 5px 12px;',
      '  font-size: 12px; font-weight: 500; cursor: pointer;',
      '  font-family: inherit; white-space: nowrap;',
      '  transition: background 0.15s;',
      '}',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-btn:hover { background: #475569; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-polish:hover { background: #6d28d9; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-fix:hover { background: #2563eb; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-on { background: #166534; color: #bbf7d0; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-on:hover { background: #15803d; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-off { background: #7f1d1d; color: #fecaca; }',
      '#' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-off:hover { background: #991b1b; }',
      '@media (prefers-color-scheme: light) {',
      '  #' + COMMAND_BAR_ID + ' {',
      '    background: rgba(255,255,255,0.65); backdrop-filter: blur(12px);',
      '    -webkit-backdrop-filter: blur(12px);',
      '    color: #334155; box-shadow: 0 4px 16px rgba(0,0,0,0.1);',
      '  }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-btn {',
      '    background: #e2e8f0; color: #334155;',
      '  }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-btn:hover { background: #cbd5e1; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-polish {',
      '    background: #7c3aed; color: #fff !important;',
      '  }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-polish:hover { background: #6d28d9 !important; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-fix {',
      '    background: #2563eb; color: #fff !important;',
      '  }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-fix:hover { background: #1d4ed8 !important; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-on { background: #dcfce7; color: #166534; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-on:hover { background: #bbf7d0 !important; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-off { background: #fee2e2; color: #991b1b; }',
      '  #' + COMMAND_BAR_ID + ' .ag-cmd-toggle.ag-cmd-off:hover { background: #fecaca !important; }',
      '}',
    ].join('\n');
    bar.appendChild(styleEl);

    // Grammar toggle — on/off with color indication (master switch, first)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ag-cmd-btn ag-cmd-toggle ' + (grammarEnabled ? 'ag-cmd-on' : 'ag-cmd-off');
    toggleBtn.textContent = grammarEnabled ? '🟢 On' : '🔴 Off';
    toggleBtn.addEventListener('click', async () => {
      const newState = !grammarEnabled;
      grammarEnabled = newState;
      toggleBtn.textContent = newState ? '🟢 On' : '🔴 Off';
      toggleBtn.className = 'ag-cmd-btn ag-cmd-toggle ' + (newState ? 'ag-cmd-on' : 'ag-cmd-off');
      try {
        await chrome.storage.sync.set({ grammarEnabled: newState });
        showResultBadge(newState ? '✓ Grammar ON' : 'Grammar OFF', newState ? 'done' : 'error', 2000);
      } catch {
        // Extension context invalidated — state already updated visually
      }
    });
    bar.appendChild(toggleBtn);

    // Polish button
    const polishBtn = document.createElement('button');
    polishBtn.className = 'ag-cmd-btn ag-cmd-polish';
    polishBtn.textContent = '✨ Polish';
    polishBtn.addEventListener('click', () => {
      dismissCommandBar();
      polishAndApply();
    });
    bar.appendChild(polishBtn);

    // Fix button
    const fixBtn = document.createElement('button');
    fixBtn.className = 'ag-cmd-btn ag-cmd-fix';
    fixBtn.textContent = '🔧 Fix';
    fixBtn.addEventListener('click', () => {
      dismissCommandBar();
      fixAndApply();
    });
    bar.appendChild(fixBtn);

    // Check Now button
    const checkBtn = document.createElement('button');
    checkBtn.className = 'ag-cmd-btn';
    checkBtn.textContent = '🔍 Check';
    checkBtn.addEventListener('click', () => {
      dismissCommandBar();
      const text = editorGetPlainText();
      if (text && text.length >= minChars) {
        runGrammarCheck(text);
      }
    });
    bar.appendChild(checkBtn);

    // Translate button
    const translateBtn = document.createElement('button');
    translateBtn.className = 'ag-cmd-btn ag-cmd-translate';
    translateBtn.textContent = '🌐 Translate';
    translateBtn.addEventListener('click', () => {
      showTranslatePicker();
    });
    bar.appendChild(translateBtn);

    document.body.appendChild(bar);
    commandBarEl = bar;

    // Position near the editor
    if (editorElement && document.contains(editorElement)) {
      const rect = editorElement.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      bar.style.top = Math.max(4, rect.top - barRect.height - 6) + 'px';
      bar.style.left = Math.max(4, Math.min(rect.right - barRect.width, rect.left)) + 'px';
    }
  }

  function dismissCommandBar() {
    if (commandBarEl) {
      if (document.contains(commandBarEl)) commandBarEl.remove();
      commandBarEl = null;
    }
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
  }

  // ── Panel CSS (class-based rules injected via <style> element) ────────
  function getPanelCSS() {
    return (
      [
        '@keyframes agfadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }',
        // Dark default color scheme
        '#' + PANEL_ID + ' {',
        '  background: #1e293b; color: #f1f5f9;',
        '}',
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
  /** Apply ALL corrections at once (uses the shared pure-text helper). */
  function applyAllCorrections(errors) {
    if (!editorElement) return;
    const text = editorGetPlainText();
    const fixed = window.__aiGrammar.applyCorrectionsToText(text, errors);
    applyTextToEditor(fixed);
  }

  /** Polish the editor text and apply the result. */
  async function polishAndApply() {
    if (!editorElement) return;
    const text = editorGetPlainText();
    if (!text || text.length < 5) {
      showResultBadge('Text too short to polish', 'error', 3000);
      return;
    }

    // Abort any previous polish
    abortPolish();
    polishAbortController = new AbortController();

    window.__aiGrammar.showPendingBadge('polishing', 'Polishing…');
    try {
      const resp = await callPolish(text, polishAbortController.signal);
      window.__aiGrammar.removePendingBadge('polishing');
      polishAbortController = null;

      if (!resp.ok) {
        showResultBadge('✗ Polish failed: ' + (resp.error || 'unknown'), 'error', 4000);
        return;
      }
      if (resp.aborted) return;

      const polished = resp.polished;
      if (!polished || polished === text) {
        showResultBadge('✓ Text already polished');
        return;
      }

      applyTextToEditor(polished);
      dismissErrors();
    } catch (err) {
      polishAbortController = null;
      window.__aiGrammar.removePendingBadge('polishing');
      if (err.name === 'AbortError') return;
      showResultBadge('✗ Polish failed: ' + (err.message || 'error'), 'error', 4000);
    }
  }

  /** Run grammar check and auto-apply all corrections. */
  async function fixAndApply() {
    if (!editorElement) return;
    const text = editorGetPlainText();
    if (!text || text.length < minChars) {
      showResultBadge('Text too short to fix', 'error', 3000);
      return;
    }

    // Abort any previous fix
    if (fixAbortController) fixAbortController.abort();
    fixAbortController = new AbortController();

    window.__aiGrammar.showPendingBadge('fixing', 'Fixing…');
    try {
      const resp = await callGrammarCheck(text, fixAbortController.signal);
      window.__aiGrammar.removePendingBadge('fixing');
      fixAbortController = null;

      if (!resp.ok) {
        showResultBadge('✗ Fix failed: ' + (resp.error || 'unknown'), 'error', 4000);
        return;
      }
      if (resp.aborted) return;

      const errors = resp.errors || [];
      if (!errors.length) {
        showResultBadge('✓ No errors to fix');
        return;
      }

      // Apply corrections bottom-up (uses the shared pure-text helper)
      const fixed = window.__aiGrammar.applyCorrectionsToText(text, errors);
      applyTextToEditor(fixed);
      dismissErrors();
      dismissCommandBar();
    } catch (err) {
      fixAbortController = null;
      window.__aiGrammar.removePendingBadge('fixing');
      if (err.name === 'AbortError') return;
      showResultBadge('✗ Fix failed: ' + (err.message || 'error'), 'error', 4000);
    }
  }

  // ── Translate — call backend and replace editor text ────────────────

  /** Call the /translate backend. */
  async function callTranslate(text, targetLang, signal) {
    return await translateText(text, targetLang, { signal });
  }

  function abortTranslate() {
    if (translateAbortController) {
      translateAbortController.abort();
      translateAbortController = null;
      window.__aiGrammar.removePendingBadge('translating');
    }
    dismissTranslatePicker();
  }

  async function translateAndApply(targetLang) {
    if (!editorElement) return;
    const text = editorGetPlainText();
    if (!text || text.length < 5) {
      showResultBadge('Text too short to translate', 'error', 3000);
      return;
    }

    abortTranslate();
    translateAbortController = new AbortController();

    window.__aiGrammar.showPendingBadge('translating', 'Translating…');
    try {
      const resp = await callTranslate(text, targetLang, translateAbortController.signal);
      window.__aiGrammar.removePendingBadge('translating');
      translateAbortController = null;

      if (!resp.ok) {
        showResultBadge('✗ Translate failed: ' + (resp.error || 'unknown'), 'error', 4000);
        return;
      }
      if (resp.aborted) return;

      const translated = resp.translated;
      if (!translated || translated === text) {
        showResultBadge('✓ Text already in that language');
        return;
      }

      applyTextToEditor(translated);
      dismissErrors();
    } catch (err) {
      translateAbortController = null;
      window.__aiGrammar.removePendingBadge('translating');
      if (err.name === 'AbortError') return;
      showResultBadge('✗ Translate failed: ' + (err.message || 'error'), 'error', 4000);
    }
  }

  // ── Language picker (compact floating popup) ─────────────────────────
  const TRANSLATE_PICKER_ID = 'ag-teams-translate';

  function showTranslatePicker() {
    dismissTranslatePicker();
    dismissCommandBar();

    const picker = document.createElement('div');
    picker.id = TRANSLATE_PICKER_ID;

    const s = picker.style;
    s.position = 'fixed';
    s.zIndex = '2147483646';
    s.minWidth = '220px';
    s.maxHeight = '320px';
    s.overflowY = 'auto';
    s.padding = '0';
    s.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    s.fontSize = '13px';
    s.lineHeight = '1.5';
    s.borderRadius = '12px';
    s.boxShadow = '0 8px 32px rgba(0,0,0,0.35)';
    s.animation = 'agfadein 0.2s ease';

    // CSP-safe: inline styles only — no <style> element (Teams blocks them)
    const light = isTeamsLightTheme();
    const colors = light
      ? { bg: '#fff', fg: '#0f172a', muted: '#64748b', border: '#f1f5f9',
          itemHover: '#f1f5f9', inputBg: '#f8fafc', inputBorder: '#cbd5e1',
          closeColor: '#64748b', closeHover: '#0f172a',
          searchBorder: '#e2e8f0', shadow: '0 8px 32px rgba(0,0,0,0.12)' }
      : { bg: '#1e293b', fg: '#f1f5f9', muted: '#64748b', border: '#1e293b',
          itemHover: '#0f172a', inputBg: '#0f172a', inputBorder: '#475569',
          closeColor: '#94a3b8', closeHover: '#f1f5f9',
          searchBorder: '#334155', shadow: '0 8px 32px rgba(0,0,0,0.35)' };

    s.background = colors.bg;
    s.color = colors.fg;
    s.boxShadow = colors.shadow;
    s.opacity = '1';
    s.backdropFilter = 'none';

    // Header with close button
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px 0 14px';
    const headerLabel = document.createElement('span');
    headerLabel.textContent = 'Translate to';
    headerLabel.style.cssText = 'font-size:11px;color:' + colors.muted + ';font-weight:600';
    header.appendChild(headerLabel);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:' + colors.closeColor
      + ';cursor:pointer;font-size:16px;line-height:1;padding:0';
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = colors.closeHover; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = colors.closeColor; });
    closeBtn.addEventListener('click', dismissTranslatePicker);
    header.appendChild(closeBtn);
    picker.appendChild(header);

    // Search input
    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'display:flex;padding:8px;border-bottom:1px solid ' + colors.searchBorder;
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter languages…';
    searchInput.style.cssText = 'width:100%;background:' + colors.inputBg + ';color:' + colors.fg
      + ';border:1px solid ' + colors.inputBorder + ';outline:none;border-radius:6px'
      + ';padding:6px 10px;font-size:13px;font-family:inherit;box-shadow:none';
    searchInput.addEventListener('focus', () => { searchInput.style.borderColor = '#4ade80'; });
    searchInput.addEventListener('blur', () => { searchInput.style.borderColor = colors.inputBorder; });
    searchWrap.appendChild(searchInput);
    picker.appendChild(searchWrap);

    // Common languages header + items
    const renderItems = (filter) => {
      // Remove old items (keep header + search)
      while (picker.children.length > 2) picker.lastChild.remove();

      const q = (filter || '').toLowerCase().trim();

      if (!q) {
        const commonHeader = document.createElement('div');
        commonHeader.textContent = 'COMMON';
        commonHeader.style.cssText = 'padding:8px 14px;font-size:11px;color:' + colors.muted
          + ';border-bottom:1px solid ' + colors.border;
        picker.appendChild(commonHeader);

        for (const code of COMMON_LANGS) {
          const lang = LANGUAGES.find(l => l.code === code);
          if (!lang) continue;
          const item = buildItem(lang);
          picker.appendChild(item);
        }

        const divider = document.createElement('div');
        divider.textContent = 'ALL LANGUAGES';
        divider.style.cssText = 'padding:8px 14px;font-size:11px;color:' + colors.muted
          + ';border-bottom:1px solid ' + colors.border;
        picker.appendChild(divider);

        for (const lang of LANGUAGES) {
          if (COMMON_LANGS.includes(lang.code)) continue;
          const item = buildItem(lang);
          picker.appendChild(item);
        }
      } else {
        const matches = LANGUAGES.filter(l =>
          l.code.startsWith(q) || l.name.toLowerCase().includes(q)
        );
        if (matches.length === 0) {
          const empty = document.createElement('div');
          empty.textContent = 'No matches';
          empty.style.cssText = 'padding:8px 14px;color:' + colors.muted
            + ';border-bottom:1px solid ' + colors.border;
          picker.appendChild(empty);
        } else {
          for (const lang of matches) {
            const item = buildItem(lang);
            item.textContent = lang.name + ' (' + lang.code + ')';
            picker.appendChild(item);
          }
        }
      }
    };

    function buildItem(lang) {
      const item = document.createElement('div');
      item.textContent = lang.name;
      item.style.cssText = 'padding:8px 14px;cursor:pointer;color:' + colors.fg
        + ';border-bottom:1px solid ' + colors.border;
      item.addEventListener('mouseenter', () => { item.style.background = colors.itemHover; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        dismissTranslatePicker();
        translateAndApply(lang.code);
      });
      return item;
    }

    searchInput.addEventListener('input', () => renderItems(searchInput.value));
    renderItems('');

    document.body.appendChild(picker);
    translatePickerEl = picker;

    // Position near the editor
    if (editorElement && document.contains(editorElement)) {
      const rect = editorElement.getBoundingClientRect();
      const pickerRect = picker.getBoundingClientRect();
      picker.style.top = Math.max(4, rect.top - pickerRect.height - 6) + 'px';
      picker.style.left = Math.max(4, Math.min(rect.right - pickerRect.width, rect.left)) + 'px';
    }

    // Focus search input after positioning
    setTimeout(() => searchInput.focus(), 50);

    // Escape key → dismiss
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        dismissTranslatePicker();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    picker._agKeyHandler = onKeyDown;

    // Click outside → dismiss (deferred so button clicks register)
    const onClickOutside = (e) => {
      if (!picker.contains(e.target)) {
        dismissTranslatePicker();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
    picker._agClickHandler = onClickOutside;
  }

  function dismissTranslatePicker() {
    if (translatePickerEl) {
      if (translatePickerEl._agKeyHandler) {
        document.removeEventListener('keydown', translatePickerEl._agKeyHandler, true);
      }
      if (translatePickerEl._agClickHandler) {
        document.removeEventListener('click', translatePickerEl._agClickHandler, true);
      }
      if (document.contains(translatePickerEl)) translatePickerEl.remove();
      translatePickerEl = null;
    }
  }

  /**
   * Push corrected plain text into CKEditor via beforeinput +
   * insertReplacementText.  CKEditor 5's Input plugin processes
   * beforeinput natively — this is the same approach content.js
   * uses for contentEditable live-draft fixes.
   */
  function applyTextToEditor(text) {
    if (!editorElement || !document.contains(editorElement)) return;

    window.__aiGrammar.showPendingBadge('fixing', 'Fixing…');

    // Use the background worker to apply text via CKEditor's API in the
    // MAIN world.  beforeinput and execCommand are unreliable with CKEditor 5
    // because it prevents programmatic DOM changes that bypass its model.
    chrome.runtime.sendMessage(
      { type: 'ag-cke-apply', text },
      (response) => {
        window.__aiGrammar.removePendingBadge('fixing');
        if (response?.ok && response?.applied) {
          showResultBadge('✓ Corrected!', 'done', 3000);
          dismissErrors();
        } else {
          // Fall back to clipboard copy if bridge not available
          showResultBadge('Copied to clipboard', 'done', 3000);
          fallbackClipboardCopy(text);
        }
      }
    );
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
      const found = findCKEditorElement();
      debugEl.textContent = JSON.stringify({
        scan: scanCount,
        time: Date.now(),
        editorElement: !!editorElement,
        editorInDoc: !!(editorElement && document.contains(editorElement)),
        editorId: editorElement?.id || null,
        ckFound: !!found,
        ckFoundId: found?.id || null,
        sameElement: !!(editorElement && found && editorElement === found),
      });
      if (scanCount <= 5 || scanCount % 10 === 0) {
        log('scan #' + scanCount + ' editorElement=' + !!editorElement + ' same=' + (editorElement === found) + ' eId=' + (editorElement?.id || 'null') + ' ckId=' + (found?.id || 'null'));
      }
      // Keep scanning even after attachment — React may reconcile the
      // CKEditor away and the DOM observer's return→break may miss
      // re-additions within the same mutation batch.
      // Also re-attach if editorElement is stale (not in doc or different from DOM).
      if (!editorElement || !document.contains(editorElement) || editorElement !== found) {
        if (found) {
          try {
            tryAttach(found);
          } catch(e) {
            log('scan error in tryAttach:', e.message);
          }
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
