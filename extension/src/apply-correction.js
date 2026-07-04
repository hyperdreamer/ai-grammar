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

      let text = ta.value || ta.textContent || '';
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
        if (tryBeforeInput(text, ta)) {
          clearLiveDraftHighlights();
          showResultBadge('✓ Fixed!', 3000);
        } else {
          // beforeinput didn't work — fall back to CDP keyboard simulation
          state.skipLiveCheck = true;
          applyFixCDP(text).then(success => {
            if (success) {
              clearLiveDraftHighlights();
              hideTooltip();
              showResultBadge('✓ Fixed!', 3000);
            } else {
              navigator.clipboard.writeText(text).catch(() => {});
              ta.focus();
              const range = document.createRange();
              range.selectNodeContents(ta);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              showResultBadge('Copied to clipboard — paste (Ctrl+V) to apply', 4000);
            }
            state.skipLiveCheck = false;
          });
        }
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
  try {
    ta.focus();
    // Set selection to cover all existing content
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ta);
    sel.removeAllRanges();
    sel.addRange(range);

    ta.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertReplacementText',
      data: text,
    }));

    // Verify text was inserted
    const current = (ta.textContent || ta.innerText || '').replace(/​/g, '');
    return current.includes(text.replace(/​/g, ''));
  } catch {
    return false;
  }
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
