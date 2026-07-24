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
  removeLiveDraftGreenChecks,
  removeErrorFloat,
  showPendingBadge,
  removePendingBadge,
  showResultBadge,
} from './indicators.js';
import { getEditableText, getEventEditableTarget, isConnectedToDocument } from './dom-utils.js';
import {
  getCodeMirrorOverlayGeometry,
  getCodeMirrorScrollContainer,
  isCodeMirrorEditor,
} from './codemirror-bridge.js';

function getLiveDraftText(target) {
  return getEditableText(target);
}

// -----------------------------------------------------------------------
// Live draft highlights
// -----------------------------------------------------------------------

export function highlightLiveDraft(ta, errors) {
  removeErrorFloat();
  if (!errors?.length) return;

  if (ta.tagName === 'TEXTAREA') {
    highlightLiveDraftTextarea(ta, errors);
  } else if (ta.isContentEditable) {
    // Managed editors cannot safely receive span injection. CodeMirror gets a
    // scroll-viewport mirror; WhatsApp retains its established mirror path;
    // ordinary contenteditables retain the lightweight floating panel.
    if (isCodeMirrorEditor(ta)) {
      highlightLiveDraftCodeMirror(ta, errors);
    } else if (getWhatsAppBridge()) {
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
  state.liveHighlightScrollTarget = textarea;

  // Reposition on resize/scroll
  state.liveHighlightReposition = () => {
    if (!state.liveHighlightEl || !isConnectedToDocument(textarea)) return;
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

function codeMirrorErrorClass(type) {
  if (type === 'improvement') return 'ai-grammar-improvement';
  if (type === 'idiom') return 'ai-grammar-idiom';
  return 'ai-grammar-error';
}

function buildCodeMirrorErrorSpan(error, start, end, text) {
  const type = error.type || 'error';
  return '<span class="' + codeMirrorErrorClass(type) + ' ag-live-error"'
    + ' style="pointer-events:auto;cursor:pointer;text-underline-offset:0"'
    + ' data-correction="' + escapeHtml(error.correction || '') + '"'
    + ' data-explanation="' + escapeHtml(error.explanation || '') + '"'
    + ' data-error="' + escapeHtml(error.error || '') + '"'
    + ' data-type="' + escapeHtml(type) + '"'
    + ' data-live-draft="1"'
    + ' data-start="' + error.start + '"'
    + ' data-end="' + error.end + '"'
    + ' tabindex="0">' + escapeHtml(text.slice(start, end)) + '</span>';
}

function normaliseCodeMirrorErrors(errors, textLength) {
  return [...errors]
    .map(error => {
      const start = Number(error.start);
      const end = Number(error.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { ...error, start: Math.max(0, start), end: Math.min(textLength, end) };
    })
    .filter(error => error && error.start < error.end)
    .sort((a, b) => a.start - b.start);
}

function buildCodeMirrorLiveDraftHtml(text, errors) {
  const sorted = normaliseCodeMirrorErrors(errors, text.length);
  const lines = text.split('\n');
  let lineStart = 0;

  return lines.map(line => {
    const lineEnd = lineStart + line.length;
    let cursor = lineStart;
    let html = '';

    for (const error of sorted) {
      const start = Math.max(lineStart, error.start);
      const end = Math.min(lineEnd, error.end);
      if (start < cursor || start >= end) continue;
      html += escapeHtml(text.slice(cursor, start));
      html += buildCodeMirrorErrorSpan(error, start, end, text);
      cursor = end;
    }

    html += escapeHtml(text.slice(cursor, lineEnd));
    lineStart = lineEnd + 1;
    return '<div class="ag-cm-live-line">' + (html || '<br>') + '</div>';
  }).join('');
}

function copyCodeMirrorLineMetrics(mirror, content) {
  const sourceLine = content.querySelector?.(':scope > .cm-line');
  if (!sourceLine) return;

  const lineStyle = window.getComputedStyle(sourceLine);
  for (const line of mirror.querySelectorAll('.ag-cm-live-line')) {
    Object.assign(line.style, {
      display: lineStyle.display,
      boxSizing: lineStyle.boxSizing,
      font: lineStyle.font,
      fontSize: lineStyle.fontSize,
      fontFamily: lineStyle.fontFamily,
      fontWeight: lineStyle.fontWeight,
      fontStyle: lineStyle.fontStyle,
      fontVariant: lineStyle.fontVariant,
      fontStretch: lineStyle.fontStretch,
      lineHeight: lineStyle.lineHeight,
      letterSpacing: lineStyle.letterSpacing,
      wordSpacing: lineStyle.wordSpacing,
      textAlign: lineStyle.textAlign,
      textIndent: lineStyle.textIndent,
      whiteSpace: lineStyle.whiteSpace,
      overflowWrap: lineStyle.overflowWrap,
      wordBreak: lineStyle.wordBreak,
      wordWrap: lineStyle.wordWrap,
      tabSize: lineStyle.tabSize,
      direction: lineStyle.direction,
      padding: lineStyle.padding,
      margin: lineStyle.margin,
    });
  }
}

function highlightLiveDraftCodeMirror(content, errors) {
  const geometry = getCodeMirrorOverlayGeometry(content);
  const scrollTarget = getCodeMirrorScrollContainer(content);
  if (!geometry || !scrollTarget) return;

  const text = getLiveDraftText(content);
  const contentStyle = window.getComputedStyle(content);
  const overlay = document.createElement('div');
  const mirror = document.createElement('div');
  state.liveHighlightEl = overlay;

  Object.assign(overlay.style, {
    position: 'fixed',
    top: geometry.viewport.top + 'px',
    left: geometry.viewport.left + 'px',
    width: geometry.viewport.width + 'px',
    height: geometry.viewport.height + 'px',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '2147483645',
    background: 'transparent',
  });

  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: geometry.content.width + 'px',
    minHeight: geometry.content.height + 'px',
    pointerEvents: 'none',
    font: contentStyle.font,
    fontSize: contentStyle.fontSize,
    fontFamily: contentStyle.fontFamily,
    fontWeight: contentStyle.fontWeight,
    fontStyle: contentStyle.fontStyle,
    fontVariant: contentStyle.fontVariant,
    fontStretch: contentStyle.fontStretch,
    fontKerning: contentStyle.fontKerning,
    fontFeatureSettings: contentStyle.fontFeatureSettings,
    fontVariationSettings: contentStyle.fontVariationSettings,
    textRendering: contentStyle.textRendering,
    textTransform: contentStyle.textTransform,
    direction: contentStyle.direction,
    lineHeight: contentStyle.lineHeight,
    letterSpacing: contentStyle.letterSpacing,
    wordSpacing: contentStyle.wordSpacing,
    textAlign: contentStyle.textAlign,
    textIndent: contentStyle.textIndent,
    whiteSpace: contentStyle.whiteSpace || 'pre-wrap',
    overflowWrap: contentStyle.overflowWrap || 'break-word',
    wordBreak: contentStyle.wordBreak || 'break-word',
    wordWrap: contentStyle.wordWrap,
    tabSize: contentStyle.tabSize,
    color: 'rgba(0, 0, 0, 0.02)',
    WebkitTextFillColor: 'rgba(0, 0, 0, 0.02)',
    background: 'transparent',
    padding: contentStyle.padding,
    boxSizing: contentStyle.boxSizing,
    transform: `translate(${geometry.content.left}px, ${geometry.content.top}px)`,
  });

  mirror.innerHTML = buildCodeMirrorLiveDraftHtml(text, errors);
  copyCodeMirrorLineMetrics(mirror, content);
  overlay.appendChild(mirror);
  document.body.appendChild(overlay);

  state.liveHighlightReposition = () => {
    if (!state.liveHighlightEl || !isConnectedToDocument(content)) return;
    const next = getCodeMirrorOverlayGeometry(content);
    if (!next) return;
    Object.assign(overlay.style, {
      top: next.viewport.top + 'px',
      left: next.viewport.left + 'px',
      width: next.viewport.width + 'px',
      height: next.viewport.height + 'px',
    });
    mirror.style.width = next.content.width + 'px';
    mirror.style.minHeight = next.content.height + 'px';
    mirror.style.transform = `translate(${next.content.left}px, ${next.content.top}px)`;
  };
  state.liveHighlightScrollHandler = state.liveHighlightReposition;
  scrollTarget.addEventListener('scroll', state.liveHighlightScrollHandler);
  state.liveHighlightScrollTarget = scrollTarget;
  state.liveHighlightReposition();
  window.addEventListener('resize', state.liveHighlightReposition);
  window.addEventListener('scroll', state.liveHighlightReposition, true);
  startLiveHighlightPositionLoop();

  state.liveHighlightTarget = content;
}

function highlightLiveDraftContentEditable(ce, errors) {
  const text = getLiveDraftText(ce);
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

  state.liveHighlightReposition = () => {
    if (!state.liveHighlightEl || !isConnectedToDocument(ce)) return;
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
      state.liveHighlightScrollTarget?.removeEventListener('scroll', state.liveHighlightScrollHandler);
      state.liveHighlightScrollHandler = null;
      state.liveHighlightScrollTarget = null;
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
  let draftRevision = 0;      // monotonically increasing; invalidates stale responses

  function abortLiveDraftCheck({ removeBadge = true } = {}) {
    if (!liveCheckInFlight) return;
    state.activeCheckController?.abort();
    state.activeCheckController = null;
    liveCheckInFlight = false;
    if (removeBadge && !state.commandInFlight) removePendingBadge('checking');
  }

  // Expose cancel so ?/fix can abort pending live checks
  state.cancelLiveDraft = () => {
    draftRevision++;
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
    if (liveCheckTarget && isConnectedToDocument(liveCheckTarget)) {
      const val = getLiveDraftText(liveCheckTarget).trim();
      if (!val) {
        removeErrorFloat();
        liveCheckTarget = null;
      }
    }

    if (!liveCheckTarget || !isConnectedToDocument(liveCheckTarget)) return;

    const elapsed = Date.now() - lastInputTime;
    if (elapsed < liveDelay) return;

    // Delay elapsed since last input — trigger the check
    const ta = liveCheckTarget;
    liveCheckTarget = null;

    const text = getLiveDraftText(ta).trim();
    if (text.length < state.minChars) return;

    checkLiveDraft(ta, text, getConversationKey());
  }, 500);

  async function checkLiveDraft(ta, text, conversationKey = getConversationKey()) {
    // Don't start a grammar check while a command (fix/polish) is running
    if (state.commandInFlight) return;

    // Capture the revision at check time.  Only this revision's check
    // may update UI — newer edits increment draftRevision and invalidate
    // any in-flight response from a previous revision.
    const checkedRevision = draftRevision;

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

      // Guard: newer edit or check has invalidated this revision.
      if (checkedRevision !== draftRevision) {
        return;
      }

      if (liveCheckInFlight) {
        liveCheckInFlight = false;
        state.activeCheckController = null;
        removePendingBadge('checking');
      } else {
        // Aborted by user editing — don't apply stale results
        return;
      }
      if (conversationKey !== getConversationKey() || !isConnectedToDocument(ta)) {
        return;
      }
      if (!resp.ok) {
        showResultBadge('Grammar check failed: ' + (data?.detail || resp.status), 5000);
        return;
      }
      if (data?.errors?.length > 0) {
        highlightLiveDraft(ta, data.errors);
      } else {
        showGreenCheck(ta, text, { scope: 'live-draft' });
      }
    } catch (err) {
      // A superseded request must not clear the newer request's controller,
      // pending badge, or in-flight state when its abort settles late.
      if (checkedRevision !== draftRevision) return;

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
    const ta = getEventEditableTarget(e);
    if (!ta) return;

    // Invalidate live-draft indicators and revision first — must happen
    // even when skipLiveCheck suppresses automatic rechecking (the flag
    // only prevents re-triggering caused by extension-generated edits;
    // it must not preserve stale visual status).
    removeLiveDraftGreenChecks();
    draftRevision++;

    // Skip if a fix/polish command is in flight — don't clear its overlay.
    if (state.skipLiveCheck) return;

    // Clear live draft highlights and abort any in-flight live-draft check.
    clearLiveDraftHighlights();
    removeErrorFloat();
    abortLiveDraftCheck();

    // Skip placeholder-only text or empty value — and clear highlights
    const raw = getLiveDraftText(ta);
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
    const ta = getEventEditableTarget(e);
    if (!ta) return;
    liveCheckTarget = null;
    removeLiveDraftGreenChecks();
    draftRevision++;
    clearLiveDraftHighlights();
    removeErrorFloat();
    abortLiveDraftCheck();
  }, true);

  document.addEventListener('submit', () => {
    liveCheckTarget = null;
    removeLiveDraftGreenChecks();
    draftRevision++;
    clearLiveDraftHighlights();
    removeErrorFloat();
    abortLiveDraftCheck();
  }, true);
}
