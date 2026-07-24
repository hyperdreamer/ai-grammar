import {
  state,
  getConversationKey,
  getWhatsAppBridge,
  safeGetStorage,
} from './state.js';
import { getTextContent } from './dom-utils.js';
import { highlightErrors, highlightOverlay } from './highlight.js';
import {
  showPendingBadge,
  removePendingBadge,
  showResultBadge,
  showGreenCheck,
  removeGreenCheck,
} from './indicators.js';

// -----------------------------------------------------------------------
// Check pipeline (post-submit grammar checking)
// -----------------------------------------------------------------------

export async function checkText(text, container, conversationKey = getConversationKey()) {
  if (conversationKey !== getConversationKey() || !document.contains(container)) return;

  // Delegate WhatsApp-specific text extraction to the bridge
  const wa = getWhatsAppBridge();
  if (wa) {
    const waContainer = wa.findMessageContainer(container) || container;
    const waText = wa.getMessageText(waContainer);
    if (waContainer && waText) {
      container = waContainer;
      text = waText;
    }
  }

  const id = ++state.checkIdCounter;
  removeGreenCheck(container);
  showPendingBadge('checking', 'Checking grammar...');

  // Each post-submit check gets its OWN controller so concurrent checks
  // can run independently. The shared activeCheckController is only for
  // live-draft checks that should be aborted when the user resumes typing.
  const checkController = new AbortController();

  try {
    // Read backend URL and settings from storage
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
      signal: checkController.signal,
    });
    const data = await resp.json();

    removePendingBadge('checking');

    if (conversationKey !== getConversationKey() || !document.contains(container)) {
      return;
    }

    if (!resp.ok) {
      showResultBadge('Grammar check failed: ' + (data?.detail || resp.status), 5000);
      return;
    }
    if (!data?.errors) return;
    const errors = data.errors;
    if (errors.length === 0) {
      showGreenCheck(container, text, { scope: 'static' });
      return;
    }

    // Highlight errors.  For non-WhatsApp pages, prefer inline DOM
    // injection — it gives browser-native underline positioning that is
    // independent of zoom, font rendering, and overlay-alignment quirks.
    // Overlay-based highlighting is the fallback for React / Vue pages
    // where injected spans are stripped by vdom reconciliation.
    state.isHighlighting = true;
    let count;
    // Delegate WhatsApp overlay rendering to the bridge.
    // The bridge handles bidi/zero-width character normalisation
    // that the generic overlay cannot.
    if (wa) {
      count = wa.renderOverlay(container, errors, text);
    } else {
      // Clear previous inline highlights in this container so
      // repeated checks don't accumulate stale spans that corrupt
      // offset calculations (IGNORE_CLASSES skips their text).
      for (const cls of ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom']) {
        container.querySelectorAll(`.${cls}:not([data-live-draft])`).forEach(span => {
          const parent = span.parentNode;
          if (parent) {
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            parent.removeChild(span);
          }
        });
      }
      // Adjust error offsets from the checked text to the container's
      // full text so highlightErrors can place spans at the right nodes.
      const containerText = getTextContent(container);
      const textOffset = containerText.indexOf(text);
      if (textOffset >= 0) {
        const adjustedErrors = errors.map(e => ({
          ...e,
          start: Number(e.start) + textOffset,
          end: Number(e.end) + textOffset,
        }));
        count = highlightErrors(container, adjustedErrors, containerText);
      } else {
        count = 0;
      }
      if (!count) count = highlightOverlay(container, errors, text);
    }
    state.isHighlighting = false;

    if (count > 0) {
      const breakdown = { error: 0, improvement: 0, idiom: 0 };
      for (const e of errors) { breakdown[e.type] = (breakdown[e.type] || 0) + 1; }
      const parts = [];
      if (breakdown.error) parts.push(`${breakdown.error} error${breakdown.error > 1 ? 's' : ''}`);
      if (breakdown.improvement) parts.push(`${breakdown.improvement} improvement${breakdown.improvement > 1 ? 's' : ''}`);
      if (breakdown.idiom) parts.push(`${breakdown.idiom} idiom${breakdown.idiom > 1 ? 's' : ''}`);
      showResultBadge(parts.join(', ') + ' found');
    }
  } catch (e) {
    removePendingBadge('checking');
    if (e.name !== 'AbortError') {
      console.debug('[AI Grammar] Check error:', e);
    }
  }
}
