import {
  IGNORE_CLASSES,
  state,
  getWhatsAppBridge,
  escapeHtml,
} from './state.js';
import { isIgnored } from './dom-utils.js';

// -----------------------------------------------------------------------
// Highlighting
// -----------------------------------------------------------------------

/**
 * Wrap each error in a <span class="ai-grammar-error"> with data attributes.
 * Uses Range.surroundContents or manual extraction when surroundContents fails.
 */
export function highlightErrors(container, errors, checkedText = '') {
  if (!errors || errors.length === 0) return 0;

  // Build a flat list of text nodes with their global offsets.
  // Because surroundContents / extractContents detaches the original
  // text nodes, we must rebuild this list after each successful wrap.
  const makeWalker = () => document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  function walkTextNodes() {
    const nodes = [];
    const w = makeWalker();
    let n, off = 0;
    while ((n = w.nextNode())) {
      nodes.push({ node: n, start: off, end: off + n.textContent.length });
      off += n.textContent.length;
    }
    return { nodes, fullText: nodes.map(tn => tn.node.textContent).join('') };
  }

  let { nodes: textNodes, fullText } = walkTextNodes();
  if (!textNodes.length) return 0;

  function findRangeByOffsets(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > fullText.length) {
      return null;
    }

    const startNode = textNodes.find(tn => start >= tn.start && start <= tn.end);
    const endNode = textNodes.find(tn => end >= tn.start && end <= tn.end);
    if (!startNode || !endNode) return null;

    const range = document.createRange();
    range.setStart(startNode.node, start - startNode.start);
    range.setEnd(endNode.node, end - endNode.start);
    return range;
  }

  function findRangeByText(errText, fromIndex = 0) {
    if (!errText) return null;
    const idx = fullText.indexOf(errText, Math.max(0, fromIndex));
    if (idx === -1) return null;
    return findRangeByOffsets(idx, idx + errText.length);
  }

  let highlighted = 0;
  const sortedErrors = [...errors].sort((a, b) => {
    const aStart = Number.isFinite(Number(a.start)) ? Number(a.start) : -1;
    const bStart = Number.isFinite(Number(b.start)) ? Number(b.start) : -1;
    return bStart - aStart;
  });

  for (const err of sortedErrors) {
    const errText = err.error;
    if (!errText) continue;

    const cls = err.type === 'improvement' ? 'ai-grammar-improvement' : err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
    const start = Number(err.start);
    const end = Number(err.end);
    let range = null;

    if (Number.isFinite(start) && Number.isFinite(end)) {
      const candidate = fullText.slice(start, end);
      if (!errText || candidate === errText || candidate.trim() === errText.trim()) {
        range = findRangeByOffsets(start, end);
      }
    }
    if (!range) {
      const preferredStart = checkedText && checkedText === fullText && Number.isFinite(start) ? start : 0;
      range = findRangeByText(errText, preferredStart) || findRangeByText(errText, 0);
    }
    if (!range) continue;

    const span = document.createElement('span');
    span.className = cls;
    span.setAttribute('data-correction', err.correction || '');
    span.setAttribute('data-explanation', err.explanation || '');
    span.setAttribute('data-error', err.error || '');
    span.setAttribute('data-type', err.type || 'error');
    span.setAttribute('tabindex', '0');

    let wrapped = false;
    try {
      range.surroundContents(span);
      wrapped = true;
    } catch {
      try {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
        wrapped = true;
      } catch {
        // Skip ranges that cannot be wrapped safely.
      }
    }

    if (wrapped) {
      highlighted++;
      // Rebuild text node list — surroundContents/extractContents
      // detaches the original text nodes, so subsequent errors
      // need fresh references.
      if (highlighted < sortedErrors.length) {
        ({ nodes: textNodes, fullText } = walkTextNodes());
      }
    }
  }

  return highlighted;
}

/**
 * Overlay-based post-submit highlighting.
 *
 * Instead of injecting <span> elements into the container DOM (which React /
 * Vue re-rendering strips within seconds), create a fixed-position overlay
 * that mirrors the message text with error underlines.  Non-error text is
 * transparent; only the red/green/blue wavy underlines are visible, sitting
 * on top of the real message.
 */
export function highlightOverlay(container, errors, fullText) {
  if (!errors?.length) return 0;

  // Remove any existing overlay for this container
  removeMessageOverlay(container);

  // Build HTML with invisible non-error text and visible error spans
  let html = '';
  let pos = 0;
  const sorted = [...errors].sort((a, b) => Number(a.start) - Number(b.start));

  for (const err of sorted) {
    const s = Math.max(0, Number(err.start));
    const e = Math.min(fullText.length, Number(err.end));
    if (s < pos || s >= e) continue;

    html += escapeHtml(fullText.slice(pos, s));

    const cls = err.type === 'improvement' ? 'ai-grammar-improvement' :
                err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
    html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;text-underline-offset:0"
        data-correction="${escapeHtml(err.correction || '')}"
        data-explanation="${escapeHtml(err.explanation || '')}"
        data-error="${escapeHtml(err.error || '')}"
        data-type="${err.type || 'error'}" tabindex="0">${escapeHtml(fullText.slice(s, e))}</span>`;
    pos = e;
  }
  html += escapeHtml(fullText.slice(pos));

  // Create the overlay
  const overlay = document.createElement('div');
  overlay.className = 'ag-message-overlay';
  overlay.setAttribute('data-ag-overlay', '');
  overlay.innerHTML = html;

  // Copy font / layout metrics from container so text lines up exactly.
  // Must copy every property that affects text rendering — even a 0.5px
  // mismatch makes underlines look misaligned, and the mismatch is far
  // more visible at non-100% zoom levels.
  const cs = window.getComputedStyle(container);
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderTop = parseFloat(cs.borderTopWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '2147483644',
    pointerEvents: 'none',
    // --- Text rendering properties (complete set) ---
    font: cs.font,
    fontSize: cs.fontSize,
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant,
    fontStretch: cs.fontStretch,
    fontKerning: cs.fontKerning,
    fontFeatureSettings: cs.fontFeatureSettings,
    fontVariationSettings: cs.fontVariationSettings,
    fontOpticalSizing: cs.fontOpticalSizing,
    textRendering: cs.textRendering,
    textTransform: cs.textTransform,
    direction: cs.direction,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    wordSpacing: cs.wordSpacing,
    textAlign: cs.textAlign,
    textIndent: cs.textIndent,
    whiteSpace: cs.whiteSpace,
    overflowWrap: cs.overflowWrap,
    wordBreak: cs.wordBreak,
    wordWrap: cs.wordWrap,
    tabSize: cs.tabSize,
    hyphens: cs.hyphens,
    textWrapMode: cs.textWrapMode,
    textWrapStyle: cs.textWrapStyle,
    writingMode: cs.writingMode,
    unicodeBidi: cs.unicodeBidi,
    color: 'rgba(0, 0, 0, 0.02)',
    WebkitTextFillColor: 'rgba(0, 0, 0, 0.02)',
    background: 'transparent',
    paddingTop: '0',
    paddingRight: '0',
    paddingBottom: '0',
    paddingLeft: '0',
    boxSizing: 'content-box',
    overflow: 'hidden',
  });

  document.body.appendChild(overlay);

  // --- Position & track ---
  function getMappedTextBounds(containerRect) {
    // Fallback to the old container-content origin for empty containers or
    // text nodes that do not produce a measurable client rect.
    const fallback = {
      left: containerRect.left + borderLeft + (parseFloat(cs.paddingLeft) || 0),
      top: containerRect.top + borderTop + (parseFloat(cs.paddingTop) || 0),
      width: Math.max(0, containerRect.width - borderLeft - borderRight - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)),
    };

    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && isIgnored(node.parentElement)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node, offset = 0;
    while ((node = walker.nextNode())) {
      textNodes.push({ node, start: offset, end: offset + node.textContent.length });
      offset += node.textContent.length;
    }
    if (!textNodes.length || !fullText) return fallback;

    const rawText = textNodes.map(tn => tn.node.textContent).join('');
    const mappedStart = rawText.indexOf(fullText);
    if (mappedStart === -1) return fallback;

    const mappedEnd = mappedStart + fullText.length;
    const startTextNode = textNodes.find(tn => mappedStart >= tn.start && mappedStart < tn.end);
    const endTextNode = textNodes.find(tn => mappedEnd > tn.start && mappedEnd <= tn.end);
    if (!startTextNode || !endTextNode) return fallback;

    const range = document.createRange();
    try {
      const startOffset = mappedStart - startTextNode.start;
      range.setStart(startTextNode.node, startOffset);
      range.setEnd(startTextNode.node, startOffset + 1);
      const startRect = range.getClientRects()[0];
      if (!startRect || (!startRect.width && !startRect.height)) return fallback;

      const endOffset = mappedEnd - endTextNode.start;
      range.setStart(endTextNode.node, endOffset - 1);
      range.setEnd(endTextNode.node, endOffset);
      const endRects = range.getClientRects();
      const endRect = endRects[endRects.length - 1];
      if (!endRect || (!endRect.width && !endRect.height)) {
        return { left: startRect.left, top: startRect.top, width: fallback.width };
      }

      return {
        left: startRect.left,
        top: startRect.top,
        width: Math.max(0, endRect.right - startRect.left),
      };
    } finally {
      range.detach();
    }
  }

  function reposition() {
    if (!document.contains(container)) {
      removeMessageOverlay(container);
      return;
    }
    const r = container.getBoundingClientRect();
    const textBounds = getMappedTextBounds(r);
    // transform:translate uses subpixel positioning — critical for
    // alignment at non-100% zoom where integer-pixel top/left can
    // drift 0.5-1 px off the real text.
    overlay.style.transform = `translate(${textBounds.left}px, ${textBounds.top}px)`;
    overlay.style.width = textBounds.width + 'px';
  }

  reposition();

  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  // Polling fallback — container may be removed without a mutation
  // we can observe (e.g. React recycles the parent).
  const poll = setInterval(() => {
    if (!document.contains(container)) removeMessageOverlay(container);
  }, 2000);

  const cleanup = () => {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    clearInterval(poll);
    if (document.contains(overlay)) overlay.remove();
  };

  state.messageOverlays.set(container, { overlay, cleanup });
  return errors.length;
}

export function removeMessageOverlay(container) {
  const entry = state.messageOverlays.get(container);
  if (entry) {
    entry.cleanup();
    state.messageOverlays.delete(container);
  }
}

// -----------------------------------------------------------------------
// Clear all inline highlights from the page
// -----------------------------------------------------------------------

export function clearPostSubmitHighlights() {
  // Unwrap all grammar spans, restoring plain text
  for (const cls of ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom']) {
    document.querySelectorAll(`.${cls}:not([data-live-draft])`).forEach(span => {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
      }
    });
  }
}
