import {
  state,
  getConversationKey,
  safeGetStorage,
  getWhatsAppBridge,
  escapeHtml,
} from './state.js';
import {
  showErrorFloat,
  showGreenCheck,
  removeEditableGreenChecks,
  removeErrorFloat,
  showPendingBadge,
  removePendingBadge,
  showResultBadge,
} from './indicators.js';

// -----------------------------------------------------------------------
// Live draft highlights
// -----------------------------------------------------------------------

export function highlightLiveDraft(ta, errors) {
  removeErrorFloat();
  if (!errors?.length) return;

  if (ta.tagName === 'TEXTAREA') {
    highlightLiveDraftTextarea(ta, errors);
  } else if (ta.isContentEditable) {
    // WhatsApp's Lexical editor corrupts on DOM-span injection;
    // use the overlay approach only there.  Other contentEditable
    // inputs (test pages, plain sites) get the floating panel which
    // doesn't risk making real text invisible.
    if (getWhatsAppBridge()) {
      highlightLiveDraftContentEditable(ta, errors);
    } else {
      showErrorFloat(errors, ta);
    }
  }
}

function highlightLiveDraftTextarea(textarea, errors) {
  const text = textarea.value;
  const textColor = window.getComputedStyle(textarea).color || '#e2e8f0';
  const rect = textarea.getBoundingClientRect();

  // Create overlay — positioned exactly over the textarea.
  // Do NOT use ag-live-highlight-backdrop class — its !important
  // color rule overrides the inline opaque text color needed for
  // textareas (where the real text is hidden via transparent).
  const overlay = document.createElement('div');
  state.liveHighlightEl = overlay;
  Object.assign(overlay.style, {
    position: 'fixed', top: rect.top + 'px', left: rect.left + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    pointerEvents: 'none', zIndex: '2147483645',
    font: window.getComputedStyle(textarea).font,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden',
    padding: window.getComputedStyle(textarea).padding,
    color: textColor, background: 'transparent', boxSizing: 'border-box',
    letterSpacing: window.getComputedStyle(textarea).letterSpacing,
    textAlign: window.getComputedStyle(textarea).textAlign,
  });

  // Build HTML with error spans
  let html = '', pos = 0;
  const sorted = [...errors].sort((a, b) => a.start - b.start);
  for (const err of sorted) {
    const s = Math.max(0, Number(err.start)), e = Math.min(text.length, Number(err.end));
    if (s < pos || s >= e) continue;
    html += escapeHtml(text.slice(pos, s));
    const cls = err.type === 'improvement' ? 'ai-grammar-improvement' : err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
    html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;text-underline-offset:0" data-correction="${escapeHtml(err.correction||'')}" data-explanation="${escapeHtml(err.explanation||'')}" data-error="${escapeHtml(err.error||'')}" data-type="${err.type||'error'}" data-live-draft="1" data-start="${s}" data-end="${e}" tabindex="0">${escapeHtml(text.slice(s, e))}</span>`;
    pos = e;
  }
  html += escapeHtml(text.slice(pos));
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Hide textarea text so overlay shows through
  state.liveHighlightRestore = { color: textarea.style.color || '', caretColor: textarea.style.caretColor || '' };
  textarea.style.color = 'transparent';
  textarea.style.caretColor = textColor;

  // Sync scroll
  state.liveHighlightScrollHandler = () => { overlay.scrollTop = textarea.scrollTop; overlay.scrollLeft = textarea.scrollLeft; };
  overlay.scrollTop = textarea.scrollTop;
  overlay.scrollLeft = textarea.scrollLeft;
  textarea.addEventListener('scroll', state.liveHighlightScrollHandler);

  // Reposition on resize/scroll
  state.liveHighlightReposition = () => {
    if (!state.liveHighlightEl || !document.contains(textarea)) return;
    const r = textarea.getBoundingClientRect();
    state.liveHighlightEl.style.top = r.top + 'px';
    state.liveHighlightEl.style.left = r.left + 'px';
    state.liveHighlightEl.style.width = r.width + 'px';
    state.liveHighlightEl.style.height = r.height + 'px';
  };
  window.addEventListener('resize', state.liveHighlightReposition);
  window.addEventListener('scroll', state.liveHighlightReposition, true);
  startLiveHighlightPositionLoop();

  state.liveHighlightTarget = textarea;
}

function highlightLiveDraftContentEditable(ce, errors) {
  const text = ce.textContent || ce.innerText || '';
  const cs = window.getComputedStyle(ce);
  const rect = ce.getBoundingClientRect();

  // Create overlay — positioned exactly over the contentEditable.
  // Do NOT use ag-live-highlight-backdrop CSS class — its !important
  // color rule on error spans blocks Chromium's text-decoration paint.
  // Inline styles only, matching the post-submit highlightOverlay().
  const overlay = document.createElement('div');
  state.liveHighlightEl = overlay;
  Object.assign(overlay.style, {
    position: 'fixed', top: rect.top + 'px', left: rect.left + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    pointerEvents: 'none', zIndex: '2147483645',
    font: cs.font, fontSize: cs.fontSize, fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant, fontStretch: cs.fontStretch,
    fontKerning: cs.fontKerning, fontFeatureSettings: cs.fontFeatureSettings,
    fontVariationSettings: cs.fontVariationSettings,
    textRendering: cs.textRendering, textTransform: cs.textTransform,
    direction: cs.direction, lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing,
    textAlign: cs.textAlign, textIndent: cs.textIndent,
    whiteSpace: cs.whiteSpace || 'pre-wrap',
    overflowWrap: cs.overflowWrap || 'break-word',
    wordBreak: cs.wordBreak || 'break-word', wordWrap: cs.wordWrap,
    color: 'rgba(0, 0, 0, 0.02)',
    WebkitTextFillColor: 'rgba(0, 0, 0, 0.02)',
    background: 'transparent', overflow: 'hidden',
    paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0',
    boxSizing: 'content-box',
  });

  let html = '', pos = 0;
  const sorted = [...errors].sort((a, b) => a.start - b.start);
  for (const err of sorted) {
    const s = Math.max(0, Number(err.start)), e = Math.min(text.length, Number(err.end));
    if (s < pos || s >= e) continue;
    html += escapeHtml(text.slice(pos, s));
    const cls = err.type === 'improvement' ? 'ai-grammar-improvement' : err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
    html += '<span class="' + cls + ' ag-live-error" style="pointer-events:auto;cursor:pointer;text-underline-offset:0" data-correction="' + escapeHtml(err.correction||'') + '" data-explanation="' + escapeHtml(err.explanation||'') + '" data-error="' + escapeHtml(err.error||'') + '" data-type="' + (err.type||'error') + '" data-live-draft="1" data-start="' + s + '" data-end="' + e + '" tabindex="0">' + escapeHtml(text.slice(s, e)) + '</span>';
    pos = e;
  }
  html += escapeHtml(text.slice(pos));
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Live-draft (manual check) underlines for contentEditable: use
  // CSS text-decoration (from .ai-grammar-error etc.) with the same
  // rgba(0,0,0,0.02) near-transparent-text trick as the inline
  // post-submit overlays.  This positions underlines relative to the
  // text baseline — the SVG background-image approach positioned
  // from the span bottom (driven by line-height, not baseline) and
  // produced underlines that sat too low in the input field.
  //
  // All underlines at baseline (offset 0).

  state.liveHighlightReposition = () => {
    if (!state.liveHighlightEl || !document.contains(ce)) return;
    const r = ce.getBoundingClientRect();
    state.liveHighlightEl.style.top = r.top + 'px';
    state.liveHighlightEl.style.left = r.left + 'px';
    state.liveHighlightEl.style.width = r.width + 'px';
    state.liveHighlightEl.style.height = r.height + 'px';
  };
  window.addEventListener('resize', state.liveHighlightReposition);
  window.addEventListener('scroll', state.liveHighlightReposition, true);
  startLiveHighlightPositionLoop();

  state.liveHighlightTarget = ce;
}

function startLiveHighlightPositionLoop() {
  if (state.liveHighlightAnimationFrame) return;
  const tick = () => {
    state.liveHighlightAnimationFrame = null;
    if (!state.liveHighlightEl || !state.liveHighlightReposition) return;
    state.liveHighlightReposition();
    state.liveHighlightAnimationFrame = requestAnimationFrame(tick);
  };
  state.liveHighlightAnimationFrame = requestAnimationFrame(tick);
}

export function clearLiveDraftHighlights() {
  if (state.liveHighlightEl) {
    if (state.liveHighlightAnimationFrame) {
      cancelAnimationFrame(state.liveHighlightAnimationFrame);
      state.liveHighlightAnimationFrame = null;
    }
    if (state.liveHighlightScrollHandler) {
      state.liveHighlightTarget?.removeEventListener('scroll', state.liveHighlightScrollHandler);
      state.liveHighlightScrollHandler = null;
    }
    if (state.liveHighlightReposition) {
      window.removeEventListener('resize', state.liveHighlightReposition);
      window.removeEventListener('scroll', state.liveHighlightReposition, true);
      state.liveHighlightReposition = null;
    }
    state.liveHighlightEl.remove();
    state.liveHighlightEl = null;
  }
  if (state.liveHighlightTarget && state.liveHighlightRestore) {
    state.liveHighlightTarget.style.color = state.liveHighlightRestore.color;
    state.liveHighlightTarget.style.caretColor = state.liveHighlightRestore.caretColor;
    state.liveHighlightRestore = null;
  }
  state.liveHighlightTarget = null;
}

// -----------------------------------------------------------------------
// Live draft checking (checks text as you type after configurable pause)
// -----------------------------------------------------------------------

export function setupLiveDraftCheck() {
  let lastInputTime = 0;
  let liveCheckTarget = null;
  let liveDelay = 5000;       // ms, read from storage
  let liveCheckInFlight = false;

  function abortLiveDraftCheck({ removeBadge = true } = {}) {
    if (!liveCheckInFlight) return;
    state.activeCheckController?.abort();
    state.activeCheckController = null;
    liveCheckInFlight = false;
    if (removeBadge && !state.commandInFlight) removePendingBadge('checking');
  }

  // Expose cancel so ?/fix can abort pending live checks
  state.cancelLiveDraft = () => {
    liveCheckTarget = null;
    abortLiveDraftCheck();
    removeErrorFloat();
  };

  // Load settings from storage
  safeGetStorage({
    grammarLiveDelay: 5,
    grammarLiveMinChars: 30,
  }).then(s => {
    liveDelay = (s.grammarLiveDelay || 5) * 1000;
    state.minChars = s.grammarLiveMinChars || 30;
  });

  // Also listen for storage changes to update live
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.grammarLiveDelay) {
        liveDelay = (changes.grammarLiveDelay.newValue || 5) * 1000;
      }
      if (changes.grammarLiveMinChars) {
        state.minChars = changes.grammarLiveMinChars.newValue || 30;
      }
    });
  } catch {
    // Extension context invalidated — events won't fire, use defaults
  }

  // Poll every 500ms to check if delay has elapsed since last input
  setInterval(() => {
    // Clear highlights if textarea was cleared externally (no input event)
    if (liveCheckTarget && document.contains(liveCheckTarget)) {
      const val = (liveCheckTarget.value || liveCheckTarget.textContent || '').trim();
      if (!val) {
        removeErrorFloat();
        liveCheckTarget = null;
      }
    }

    if (!liveCheckTarget || !document.contains(liveCheckTarget)) return;

    const elapsed = Date.now() - lastInputTime;
    if (elapsed < liveDelay) return;

    // Delay elapsed since last input — trigger the check
    const ta = liveCheckTarget;
    liveCheckTarget = null;

    const text = (ta.value || ta.textContent || '').trim();
    if (text.length < state.minChars) return;

    checkLiveDraft(ta, text, getConversationKey());
  }, 500);

  async function checkLiveDraft(ta, text, conversationKey = getConversationKey()) {
    // Don't start a grammar check while a command (fix/polish) is running
    if (state.commandInFlight) return;
    try {
      abortLiveDraftCheck();
      showPendingBadge('checking', 'Checking grammar...');
      liveCheckInFlight = true;
      // Create fresh controller, abort any previous in-flight live check.
      // Post-submit checks use their own local controllers and must not be
      // cancelled when the user resumes typing a new draft.
      state.activeCheckController?.abort();
      state.activeCheckController = new AbortController();

      const settings = await safeGetStorage({
        grammarHost: '127.0.0.1',
        grammarPort: 8766,
        grammarMaxTokens: 4096,
      });
      const body = { text, language: 'auto' };
      if (settings.grammarMaxTokens > 0) body.max_tokens = settings.grammarMaxTokens;
      const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: state.activeCheckController.signal,
      });
      const data = await resp.json();
      if (liveCheckInFlight) {
        liveCheckInFlight = false;
        state.activeCheckController = null;
        removePendingBadge('checking');
      }
      if (conversationKey !== getConversationKey() || !document.contains(ta)) {
        return;
      }
      if (!resp.ok) {
        showResultBadge('Grammar check failed: ' + (data?.detail || resp.status), 5000);
        return;
      }
      if (data?.errors?.length > 0) {
        highlightLiveDraft(ta, data.errors);
      } else {
        showGreenCheck(ta, text);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.debug('[AI Grammar] Live check aborted');
        // Clean up state that the normal success path would handle.
        // Always remove the badge — commands use different categories
        // ('fixing', 'polishing') so there's no conflict.
        if (liveCheckInFlight) {
          liveCheckInFlight = false;
          state.activeCheckController = null;
          removePendingBadge('checking');
        }
      } else {
        abortLiveDraftCheck();
        console.debug('[AI Grammar] Live check error:', err);
      }
    }
  }

  document.addEventListener('input', (e) => {
    const ta = e.target;
    if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;

    // Skip if a fix/polish command is in flight — don't clear its overlay.
    if (state.skipLiveCheck) return;

    // Clear live draft highlights and abort any in-flight live-draft check.
    clearLiveDraftHighlights();
    removeErrorFloat();
    removeEditableGreenChecks();
    abortLiveDraftCheck();

    // Skip placeholder-only text or empty value — and clear highlights
    const raw = ta.value || ta.textContent || '';
    if (!raw || raw === ta.placeholder) {
      liveCheckTarget = null;
      return;
    }
    const text = raw.trim();
    if (text.length < state.minChars) return;

    liveCheckTarget = ta;
    lastInputTime = Date.now();
  }, true);

  // Cancel on submit/Enter
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const ta = e.target;
    if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;
    liveCheckTarget = null;
    clearLiveDraftHighlights();
    removeErrorFloat();
    removeEditableGreenChecks();
    abortLiveDraftCheck();
  }, true);

  document.addEventListener('submit', () => {
    liveCheckTarget = null;
    clearLiveDraftHighlights();
    removeErrorFloat();
    removeEditableGreenChecks();
    abortLiveDraftCheck();
  }, true);
}
