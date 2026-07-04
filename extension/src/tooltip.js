import { state, escapeHtml } from './state.js';

// -----------------------------------------------------------------------
// Tooltip
// -----------------------------------------------------------------------

export function createTooltip() {
  if (state.tooltipEl) return state.tooltipEl;
  state.tooltipEl = document.createElement('div');
  state.tooltipEl.className = 'ai-grammar-tooltip';
  state.tooltipEl.style.display = 'none';
  state.tooltipEl.innerHTML = '<div class="ag-arrow"></div>';
  document.body.appendChild(state.tooltipEl);
  return state.tooltipEl;
}

export function showTooltip(errorEl) {
  if (state.currentErrorEl === errorEl && state.tooltipEl?.style.display === 'block') return;

  if (state.tooltipTimeout) {
    clearTimeout(state.tooltipTimeout);
    state.tooltipTimeout = null;
  }

  state.currentErrorEl = errorEl;
  const tip = createTooltip();
  const correction = errorEl.getAttribute('data-correction') || '';
  const explanation = errorEl.getAttribute('data-explanation') || '';
  const original = errorEl.getAttribute('data-error') || '';
  const type = errorEl.getAttribute('data-type') || 'error';

  const typeLabel = { error: '🔴 Error', improvement: '🟢 Improvement', idiom: '🔵 Idiom' };
  const typeColor = { error: '#f87171', improvement: '#4ade80', idiom: '#60a5fa' };

  tip.innerHTML = `
    <div class="ag-arrow"></div>
    <div style="font-size:11px;color:${typeColor[type]};margin-bottom:4px;font-weight:600;">${typeLabel[type] || 'Error'}</div>
    <div><span style="text-decoration:line-through;color:#f87171;">${escapeHtml(original)}</span> → <span class="ag-correction">${escapeHtml(correction)}</span></div>
    ${explanation ? `<div class="ag-explanation">${escapeHtml(explanation)}</div>` : ''}
    <div class="ag-actions">
      ${errorEl.hasAttribute('data-live-draft') ? '<button class="ag-apply" data-action="apply">Apply fix</button>' : ''}
      <button class="ag-dismiss" data-action="dismiss">Dismiss</button>
    </div>
  `;

  tip.style.left = '-9999px';
  tip.style.top = '-9999px';
  tip.style.display = 'block';
  tip.getBoundingClientRect();

  // Position the tooltip near the error element
  const rect = errorEl.getBoundingClientRect();
  const arrow = tip.querySelector('.ag-arrow');
  const viewportGap = 10;
  const sentenceGap = 12;
  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;

  let left = rect.left + rect.width / 2 - tipWidth / 2;
  left = Math.min(left, window.innerWidth - tipWidth - viewportGap);
  left = Math.max(viewportGap, left);

  const aboveTop = rect.top - tipHeight - sentenceGap;
  const belowTop = rect.bottom + sentenceGap;
  let top = aboveTop;

  // Prefer above, but flip below if there is not enough room or clearance.
  if (
    aboveTop < viewportGap ||
    tooltipOverlapsTextAbove(errorEl, {
      top: aboveTop,
      right: left + tipWidth,
      bottom: aboveTop + tipHeight,
      left,
    }, rect)
  ) {
    top = belowTop;
  }

  if (top + tipHeight > window.innerHeight - viewportGap) {
    top = Math.max(viewportGap, window.innerHeight - tipHeight - viewportGap);
  }
  top = Math.max(viewportGap, top);

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';

  if (arrow) {
    const isAbove = top + tipHeight <= rect.top;
    const arrowCenter = rect.left + rect.width / 2 - left;
    const clampedArrowCenter = Math.min(Math.max(arrowCenter, 14), tipWidth - 14);
    const arrowColor = getComputedStyle(tip).backgroundColor || '#1e293b';
    arrow.style.left = (clampedArrowCenter - 6) + 'px';
    arrow.style.top = isAbove ? 'auto' : '-6px';
    arrow.style.bottom = isAbove ? '-6px' : 'auto';
    arrow.style.borderTop = isAbove ? `6px solid ${arrowColor}` : 'none';
    arrow.style.borderBottom = isAbove ? 'none' : `6px solid ${arrowColor}`;
  }
}

export function tooltipOverlapsTextAbove(errorEl, tooltipRect, errorRect) {
  const container = errorEl.closest('p, li, blockquote, td, th, div, article, section') || errorEl.parentElement;
  if (!container) return false;

  const intersects = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (errorEl.contains(node.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    const rects = range.getClientRects();
    range.detach();

    for (const textRect of rects) {
      if (textRect.bottom <= errorRect.top - 1 && intersects(textRect, tooltipRect)) {
        return true;
      }
    }
  }

  return false;
}

export function hideTooltip() {
  if (state.tooltipTimeout) {
    clearTimeout(state.tooltipTimeout);
    state.tooltipTimeout = null;
  }
  if (state.tooltipEl) {
    state.tooltipEl.style.display = 'none';
  }
  state.currentErrorEl = null;
}
