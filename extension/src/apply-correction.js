import { state, getWhatsAppBridge } from './state.js';
import { hideTooltip } from './tooltip.js';
import { showResultBadge } from './indicators.js';
import { clearLiveDraftHighlights } from './live-draft.js';
import { getDeepActiveElement, getEditableText, isConnectedToDocument } from './dom-utils.js';
import { isCodeMirrorEditor, replaceCodeMirrorText } from './codemirror-bridge.js';

// -----------------------------------------------------------------------
// Apply correction
// -----------------------------------------------------------------------

export function applyCorrection(errorEl) {
  const correction = errorEl.getAttribute('data-correction');
  if (!correction) return;

  if (errorEl.hasAttribute('data-live-draft')) {
    // Prefer the target recorded by the live-draft checker. The fallback also
    // follows focus through open shadow roots for component-based editors.
    const ta = findEditableTarget(state.liveHighlightTarget);
    if (!ta) { hideTooltip(); return; }

    // Collect all error spans from the live-draft overlay and apply
    // every correction at once.  Sort by start offset descending so
    // replacements don't shift earlier positions.
    const spans = (state.liveHighlightEl || document).querySelectorAll(
      '.ai-grammar-error[data-live-draft], .ai-grammar-improvement[data-live-draft], .ai-grammar-idiom[data-live-draft]'
    );
    if (spans?.length) {
      const fixes = Array.from(spans)
        .map(s => ({
          start: Number(s.getAttribute('data-start')),
          end: Number(s.getAttribute('data-end')),
          correction: s.getAttribute('data-correction') || '',
        }))
        .filter(f => Number.isInteger(f.start) && Number.isInteger(f.end) && f.correction)
        .sort((a, b) => b.start - a.start); // descending for safe in-place edits

      const originalText = ta.tagName === 'TEXTAREA'
        ? ta.value.replace(/\u200B/g, '')
        : editableText(ta);
      const text = applyCorrectionsToText(originalText, fixes);
      if (ta.tagName === 'TEXTAREA') {
        ta.value = text;
        ta.selectionStart = ta.selectionEnd = text.length;
        ta.focus();
        ta.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertReplacementText',
          data: text,
        }));
      } else if (ta.isContentEditable) {
        // Remove the interactive overlay immediately, then use the same
        // editor-native replacement path as ?/fix. CodeMirror observes the
        // browser-native edit while Lexical retains its CDP fallback.
        hideTooltip();
        clearLiveDraftHighlights();
        state.skipLiveCheck = true;
        state.cancelLiveDraft?.();
        void applyLiveDraftContentEditableText(text, ta);
      }
    }
    hideTooltip();
    return;
  }

  errorEl.textContent = correction;
  errorEl.classList.remove('ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom');
  errorEl.removeAttribute('data-correction');
  errorEl.removeAttribute('data-explanation');
  errorEl.removeAttribute('data-error');
  errorEl.removeAttribute('data-type');
  errorEl.removeAttribute('tabindex');
  hideTooltip();
}

// -----------------------------------------------------------------------
// Apply fix — editor-native replacement before the CDP fallback
// -----------------------------------------------------------------------

function isEditableTarget(el) {
  return !!el
    && (el.tagName === 'TEXTAREA' || el.isContentEditable)
    && isConnectedToDocument(el);
}

function findEditableTarget(preferred) {
  if (isEditableTarget(preferred)) return preferred;

  const active = getDeepActiveElement();
  if (isEditableTarget(active)) return active;

  // Preserve the existing light-DOM fallback for pages that replace their
  // editor during a React render.
  const fallback = document.querySelector('footer div[contenteditable="true"][role="textbox"]')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('[contenteditable="true"]');
  return isEditableTarget(fallback) ? fallback : null;
}

function editableText(el) {
  return getEditableText(el).replace(/\u200B/g, '');
}

async function applyLiveDraftContentEditableText(text, target) {
  try {
    const applied = await tryBeforeInput(text, target);
    if (applied) {
      showResultBadge('✓ Fixed!', 3000);
      return;
    }

    const appliedByCDP = await applyFixCDP(text);
    if (appliedByCDP) {
      showResultBadge('✓ Fixed!', 3000);
    } else {
      navigator.clipboard.writeText(text).catch(() => {});
      showResultBadge('Copied to clipboard — paste (Ctrl+V) to apply', 4000);
    }
  } finally {
    state.skipLiveCheck = false;
  }
}

function selectEditableContents(el) {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function tryExecCommandReplacement(el, text) {
  if (typeof document.execCommand !== 'function' || !selectEditableContents(el)) return false;
  return document.execCommand('insertText', false, text) === true;
}

/**
 * Use the CodeMirror adapter for its native contenteditable transaction.
 * Other editors receive beforeinput first, then a scoped native edit before
 * the existing CDP fallback.
 */
export function tryBeforeInput(text, ta) {
  return new Promise((resolve) => {
    try {
      const target = findEditableTarget(ta);
      if (!target) {
        resolve(false);
        return;
      }
      target.focus();

      // Double rAF: let React/Lexical re-establish internal focus after a
      // floating palette may have temporarily taken it.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = findEditableTarget(target);
          if (!el) {
            resolve(false);
            return;
          }
          const before = editableText(el);

          if (isCodeMirrorEditor(el)) {
            // CodeMirror ignores synthetic beforeinput events. Its public
            // contenteditable surface accepts a native insertText command,
            // which updates the real document without touching internals.
            const inserted = replaceCodeMirrorText(el, text);
            requestAnimationFrame(() => {
              const afterCodeMirrorEdit = editableText(el);
              resolve((inserted && afterCodeMirrorEdit !== before) || afterCodeMirrorEdit === text);
            });
            return;
          }

          el.focus();
          selectEditableContents(el);
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertReplacementText',
            data: text,
          }));

          // Lexical processes beforeinput asynchronously. Editors that do
          // not handle that event can still accept a native DOM edit.
          requestAnimationFrame(() => {
            const afterBeforeInput = editableText(el);
            if (afterBeforeInput !== before || afterBeforeInput === text) {
              resolve(true);
              return;
            }

            const inserted = tryExecCommandReplacement(el, text);
            requestAnimationFrame(() => {
              const afterExecCommand = editableText(el);
              resolve((inserted && afterExecCommand !== before) || afterExecCommand === text);
            });
          });
        });
      });
    } catch {
      resolve(false);
    }
  });
}

export function applyFixCDP(text) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'grammar:apply-fix', text },
        (resp) => resolve(resp && resp.ok === true)
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Pure text helper — apply a list of {start, end, correction} edits to
 * a string.  Replacements are sorted descending by start offset so
 * earlier offsets remain valid as later ones are spliced in.
 * Returns the corrected text.  Does not touch the DOM.
 */
export function applyCorrectionsToText(text, errors) {
  if (!Array.isArray(errors) || !errors.length) return text;
  const seenFixes = new Set();
  const fixes = errors
    .map((e) => ({
      start: Math.max(0, Number(e.start) || 0),
      end: Math.min(text.length, Number(e.end) || text.length),
      correction: e.correction || '',
    }))
    .filter((f) => f.start < f.end && f.correction)
    .sort((a, b) => b.start - a.start) // descending — safe in-place edits
    .filter((fix) => {
      const key = `${fix.start}:${fix.end}:${fix.correction}`;
      if (seenFixes.has(key)) return false;
      seenFixes.add(key);
      return true;
    });

  let out = text;
  for (const f of fixes) {
    out = out.slice(0, f.start) + f.correction + out.slice(f.end);
  }
  return out;
}


// -----------------------------------------------------------------------
// Bridge: expose shared correction helpers on window.__aiGrammar so
// thin content-script adapters (e.g. teams-bridge.js) can reuse them.
// -----------------------------------------------------------------------

window.__aiGrammar = window.__aiGrammar || {};
window.__aiGrammar.applyCorrectionsToText = applyCorrectionsToText;
window.__aiGrammar.applyFixCDP = applyFixCDP;
window.__aiGrammar.tryBeforeInput = tryBeforeInput;
