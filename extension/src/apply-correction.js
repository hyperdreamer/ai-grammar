import { state, getWhatsAppBridge } from './state.js';
import { hideTooltip } from './tooltip.js';
import { showResultBadge } from './indicators.js';
import { clearLiveDraftHighlights } from './live-draft.js';

// -----------------------------------------------------------------------
// Apply correction
// -----------------------------------------------------------------------

export function applyCorrection(errorEl) {
  const correction = errorEl.getAttribute('data-correction');
  if (!correction) return;

  if (errorEl.hasAttribute('data-live-draft')) {
    let ta = state.liveHighlightTarget;
    // Fallback: if liveHighlightTarget wasn't set (overlay injected externally
    // e.g. by test scripts), find the contentEditable from the DOM.
    if (!ta) {
      ta = document.querySelector('footer div[contenteditable="true"][role="textbox"]')
        || document.querySelector('[contenteditable="true"][role="textbox"]')
        || document.querySelector('[contenteditable="true"]');
    }
    if (!ta || !document.contains(ta)) { hideTooltip(); return; }

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

      let text = (ta.value || ta.textContent || '').replace(/\u200B/g, '');
      for (const f of fixes) {
        text = text.slice(0, f.start) + f.correction + text.slice(f.end);
      }
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
        // Dismiss tooltip and remove overlay immediately so the user
        // sees instant feedback; the text replacement follows after
        // a double rAF to let Lexical reinitialize after focus.
        // Suppress live-draft checks while we apply the fix so the
        // text replacement doesn't trigger a new auto-check.
        hideTooltip();
        clearLiveDraftHighlights();
        state.skipLiveCheck = true;
        state.cancelLiveDraft?.();
        ta.focus();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Re-query: ta may have been detached by React re-render
            const el = document.querySelector(
              'footer div[contenteditable="true"][role="textbox"]'
            ) || document.querySelector('[contenteditable="true"][role="textbox"]')
              || document.querySelector('[contenteditable="true"]');
            if (el && document.contains(el)) {
              const before = (el.textContent || el.innerText || '').replace(/\u200B/g, '');
              el.focus();
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
              el.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, cancelable: true,
                inputType: 'insertReplacementText', data: text,
              }));
              // Lexical processes beforeinput asynchronously (React batch).
              // Check after one more frame to see if the text actually changed.
              requestAnimationFrame(() => {
                const after = (el.textContent || el.innerText || '').replace(/\u200B/g, '');
                if (after !== before) {
                  showResultBadge('✓ Fixed!', 3000);
                } else {
                  console.debug('[AI Grammar] beforeinput had no effect, falling back to CDP',
                    { before, after, text: text.replace(/\u200B/g, '') });
                  applyFixCDP(text).then(success => {
                    if (success) {
                      showResultBadge('✓ Fixed!', 3000);
                    } else {
                      navigator.clipboard.writeText(text).catch(() => {});
                      showResultBadge('Copied to clipboard — paste (Ctrl+V) to apply', 4000);
                    }
                    state.skipLiveCheck = false;
                  });
                  return;
                }
                state.skipLiveCheck = false;
              });
            } else {
              console.debug('[AI Grammar] contentEditable not found, falling back to CDP');
              applyFixCDP(text).then(success => {
                if (success) {
                  showResultBadge('✓ Fixed!', 3000);
                } else {
                  navigator.clipboard.writeText(text).catch(() => {});
                  showResultBadge('Copied to clipboard — paste (Ctrl+V) to apply', 4000);
                }
                state.skipLiveCheck = false;
              });
              return;
            }
            state.skipLiveCheck = false;
          });
        });
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
// Apply fix — try beforeinput event first, CDP fallback for Lexical
// -----------------------------------------------------------------------

/**
 * Try dispatching a beforeinput event with insertReplacementText.
 * Lexical editors process this event type natively without checking
 * isTrusted, so this works without CDP or debugger on many editors.
 * Returns true if the text was successfully inserted.
 */
export function tryBeforeInput(text, ta) {
  return new Promise((resolve) => {
    try {
      ta.focus();
      // Double rAF: let Lexical's React batch re-establish internal focus
      // state after a floating palette may have stolen it.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Re-query — ta may have been detached by React re-render
          const el = document.querySelector(
            'footer div[contenteditable="true"][role="textbox"]'
          ) || document.querySelector('[contenteditable="true"][role="textbox"]')
            || document.querySelector('[contenteditable="true"]');
          if (!el || !document.contains(el)) {
            resolve(false);
            return;
          }
          const before = (el.textContent || el.innerText || '').replace(/\u200B/g, '');
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);

          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertReplacementText',
            data: text,
          }));

          // Lexical processes beforeinput asynchronously (React batch).
          // Check after one more frame to verify the text actually changed.
          requestAnimationFrame(() => {
            const after = (el.textContent || el.innerText || '').replace(/\u200B/g, '');
            resolve(after !== before);
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
