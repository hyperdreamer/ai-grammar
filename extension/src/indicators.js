import { state, escapeHtml } from './state.js';
import { isIgnored } from './dom-utils.js';

// -----------------------------------------------------------------------
// Status badge — stacked vertically like desktop notifications
// -----------------------------------------------------------------------

// --- Stack container ---

function ensureBadgeStack() {
  let stack = document.querySelector('.ag-badge-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'ag-badge-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

function removeBadgeStackIfEmpty() {
  const stack = document.querySelector('.ag-badge-stack');
  if (stack && stack.children.length === 0) {
    stack.remove();
  }
}

// --- Badge management ---

function buildBadgeHTML(category) {
  const label = state.badgeLabels[category];
  const count = state.badgeCounters[category];
  const countHtml = count > 1 ? `<span class="ag-count">&times; ${count}</span>` : '';
  return `<div class="ag-spinner"></div>${label}${countHtml}`;
}

// Show a pending badge (with spinner). Each category gets its own badge
// in the vertical stack — newer badges appear above older ones.
export function showPendingBadge(category, label) {
  state.badgeCounters[category]++;
  state.badgeLabels[category] = label;

  const stack = ensureBadgeStack();
  const key = `pending:${category}`;

  if (state.activeBadges.has(key)) {
    // Update existing badge in place
    const entry = state.activeBadges.get(key);
    entry.el.innerHTML = buildBadgeHTML(category);
  } else {
    // Create new badge — appendChild pushes it to the top of the column-reverse stack
    const badge = document.createElement('div');
    badge.className = 'ai-grammar-badge';
    badge.setAttribute('data-ag-category', category);
    badge.innerHTML = buildBadgeHTML(category);
    stack.appendChild(badge);
    state.activeBadges.set(key, { el: badge, category });
  }
}

// Update label without changing the counter (used by batch progress)
export function updatePendingBadgeLabel(category, label) {
  state.badgeLabels[category] = label;
  const key = `pending:${category}`;
  const entry = state.activeBadges.get(key);
  if (!entry) return;
  entry.el.innerHTML = buildBadgeHTML(category);
}

// Remove one pending operation. Removes the badge element when counter hits 0.
export function removePendingBadge(category) {
  state.badgeCounters[category] = Math.max(0, state.badgeCounters[category] - 1);

  if (state.badgeCounters[category] <= 0) {
    const key = `pending:${category}`;
    const entry = state.activeBadges.get(key);
    if (entry) {
      entry.el.remove();
      state.activeBadges.delete(key);
    }
    removeBadgeStackIfEmpty();
  } else {
    // Update count display
    const key = `pending:${category}`;
    const entry = state.activeBadges.get(key);
    if (entry) {
      entry.el.innerHTML = buildBadgeHTML(category);
    }
  }
}

// Show a transient result badge (no spinner). Appears at the top of the stack
// alongside any pending badges. Auto-dismisses after durationMs.
export function showResultBadge(text, durationMs = 4000, type) {
  if (state.resultBadgeTimer) { clearTimeout(state.resultBadgeTimer); state.resultBadgeTimer = null; }

  // Remove any existing result badges
  for (const [key, entry] of state.activeBadges) {
    if (key.startsWith('result:')) {
      entry.el.remove();
      state.activeBadges.delete(key);
    }
  }

  const stack = ensureBadgeStack();
  const resultId = `result:${Date.now()}`;

  const badge = document.createElement('div');
  let cls = 'ai-grammar-badge ag-badge-result';
  if (type === 'done') cls += ' ag-badge-done';
  else if (type === 'error') cls += ' ag-badge-error';
  badge.className = cls;
  badge.setAttribute('data-ag-result', '');
  badge.innerHTML = text;
  stack.appendChild(badge);
  state.activeBadges.set(resultId, { el: badge });

  state.resultBadgeTimer = setTimeout(() => {
    state.resultBadgeTimer = null;
    const entry = state.activeBadges.get(resultId);
    if (entry) {
      entry.el.remove();
      state.activeBadges.delete(resultId);
    }
    removeBadgeStackIfEmpty();
  }, durationMs);
}

// Remove all badges (for conversation switch / cleanup)
export function removeAllBadges() {
  for (const [key, entry] of state.activeBadges) {
    entry.el.remove();
  }
  state.activeBadges.clear();
  state.badgeCounters.checking = 0;
  state.badgeCounters.fixing = 0;
  state.badgeCounters.polishing = 0;
  state.badgeCounters.translating = 0;
  const stack = document.querySelector('.ag-badge-stack');
  if (stack) stack.remove();
}

// Batch check progress — participates in the "checking" counter
export function updateBatchBadge(completed, total) {
  const label = `Checking ${completed}/${total} text blocks...`;
  if (state.badgeCounters.checking > 0) {
    updatePendingBadgeLabel('checking', label);
  } else {
    showPendingBadge('checking', label);
  }
}

// -----------------------------------------------------------------------
// Green checkmark — shown at end of checked text when no errors found
// -----------------------------------------------------------------------

/**
 * Find the bounding rect of the last visible text character in a container,
 * skipping ignored elements (timestamps, edit indicators, etc.).
 * When `text` is provided, finds the end of that specific text within the
 * container — critical when the container holds more than just the checked
 * text (e.g. timestamps, decorations, broader wrappers).
 * Falls back to container bottom-right corner if anything fails.
 */
function getLastCharRect(container, text) {
  const containerRect = container.getBoundingClientRect();
  const fallback = {
    right: containerRect.right - 4,
    top: containerRect.bottom - 24,
    height: 20,
  };

  try {
    // Walk text nodes, collecting those not inside ignored elements.
    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && isIgnored(node.parentElement)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    if (!textNodes.length) return fallback;

    // When a specific text is provided, find its end position in the
    // concatenated node text — same approach as getMappedTextBounds.
    let targetEnd = null;
    let targetNode = null;

    if (text) {
      const rawText = textNodes.map(tn => tn.textContent).join('');
      const idx = rawText.indexOf(text);
      if (idx === -1) return fallback;

      const endOffset = idx + text.length;
      // Find which node contains the end of the target text
      let offset = 0;
      for (const tn of textNodes) {
        const nodeEnd = offset + tn.textContent.length;
        if (endOffset > offset && endOffset <= nodeEnd) {
          targetNode = tn;
          targetEnd = endOffset - offset;
          break;
        }
        offset = nodeEnd;
      }
      if (!targetNode || targetEnd == null) return fallback;
    }

    if (targetNode) {
      // Position at the last character of the target text
      const charIdx = Math.max(0, targetEnd - 1);
      const range = document.createRange();
      range.setStart(targetNode, charIdx);
      range.setEnd(targetNode, targetEnd);
      const rect = range.getClientRects()[0];
      range.detach();

      if (rect && (rect.width > 0 || rect.height > 0)) {
        return { right: rect.right, top: rect.top, height: rect.height };
      }
      return fallback;
    }

    // No specific text — find the last text node with non-whitespace content.
    let lastNode = null;
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (textNodes[i].textContent.trim()) {
        lastNode = textNodes[i];
        break;
      }
    }
    if (!lastNode) return fallback;

    const nodeText = lastNode.textContent;
    // Find last non-whitespace character position.
    let lastCharIdx = nodeText.length - 1;
    while (lastCharIdx >= 0 && /\s/.test(nodeText[lastCharIdx])) {
      lastCharIdx--;
    }
    if (lastCharIdx < 0) return fallback;

    const range = document.createRange();
    range.setStart(lastNode, lastCharIdx);
    range.setEnd(lastNode, lastCharIdx + 1);
    const rect = range.getClientRects()[0];
    range.detach();

    if (!rect || (!rect.width && !rect.height)) return fallback;

    return { right: rect.right, top: rect.top, height: rect.height };
  } catch (_) {
    return fallback;
  }
}

export function showGreenCheck(container, checkedText) {
  if (!container) return;
  if (!document.contains(container)) return;
  removeGreenCheck(container);

  // Always use fixed-position — inline appendChild gets stripped by React re-renders
  // contentEditable is inherited — descendants of a contentEditable element
  // return true for .isContentEditable even though they're not directly editable.
  // Use .contentEditable === 'true' to only match elements with the attribute set.
  const isEditable = container.tagName === 'TEXTAREA' || container.contentEditable === 'true';
  const check = document.createElement('div');
  check.className = 'ai-grammar-ok-ta';
  check.textContent = '✓';
  check.setAttribute('data-ag-ok-for', '');

  const rect = container.getBoundingClientRect();
  if (isEditable) {
    // Textareas: anchor to top-right of the container (can't walk text nodes).
    check.style.top = (rect.top + 4) + 'px';
    check.style.left = (rect.right - 28) + 'px';
  } else {
    // Post-submit messages: position right after the last character of the
    // checked text (not the entire container which may hold timestamps etc.).
    const endRect = getLastCharRect(container, checkedText);
    check.style.top = endRect.top + 'px';
    check.style.left = (endRect.right + 6) + 'px';  // 6px gap after last char
  }
  document.body.appendChild(check);

  // Reposition on scroll/resize
  const reposition = () => {
    if (!document.contains(check)) return;
    const r = container.getBoundingClientRect();
    if (isEditable) {
      check.style.top = (r.top + 4) + 'px';
      check.style.left = (r.right - 28) + 'px';
    } else {
      const endR = getLastCharRect(container, checkedText);
      check.style.top = endR.top + 'px';
      check.style.left = (endR.right + 6) + 'px';
    }
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  check._agReposition = reposition;

  // Permanent until explicit cleanup (editable checks are removed on input)
  state.greenCheckTimers.set(container, { el: check, timers: [], cleanup: () => {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  }});
}

export function removeGreenCheck(container) {
  if (container && state.greenCheckTimers.has(container)) {
    const entry = state.greenCheckTimers.get(container);
    entry.timers.forEach(clearTimeout);
    if (entry.cleanup) entry.cleanup();
    if (entry.el && document.contains(entry.el)) entry.el.remove();
    state.greenCheckTimers.delete(container);
  }
}

export function removeAllGreenChecks() {
  for (const [container] of state.greenCheckTimers) {
    removeGreenCheck(container);
  }
}

/** Only clear green checks on editable elements (textareas, contentEditable).
 *  Leaves post-submit paragraph checks untouched — those are permanent.
 *  Uses .contentEditable === 'true' (not inherited .isContentEditable). */
export function removeEditableGreenChecks() {
  for (const [container] of state.greenCheckTimers) {
    if (container.tagName === 'TEXTAREA' || container.contentEditable === 'true') {
      removeGreenCheck(container);
    }
  }
}

// -----------------------------------------------------------------------
// Floating error notification (replaces inline underlines)
// -----------------------------------------------------------------------

export function showErrorFloat(errors, anchorEl = null) {
  removeErrorFloat();

  const panel = document.createElement('div');
  panel.id = 'ai-grammar-float';
  // Position below anchor if provided, otherwise bottom-right
  let posStyle = '';
  if (anchorEl && document.contains(anchorEl)) {
    const rect = anchorEl.getBoundingClientRect();
    posStyle = `top: ${Math.min(window.innerHeight - 8, rect.bottom + 8)}px; left: ${Math.max(8, rect.left)}px;`;
  }
  panel.innerHTML = `
    <style>
      #ai-grammar-float {
        position: fixed; ${posStyle || 'bottom: 16px; right: 16px;'} z-index: 2147483646;
        background: #1e293b; color: #f1f5f9; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.35);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; line-height: 1.5; max-width: 420px; max-height: 60vh;
        overflow-y: auto; padding: 0; animation: ai-gfadein 0.2s ease;
      }
      #ai-grammar-float .agf-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; border-bottom: 1px solid #334155;
        font-weight: 600; font-size: 14px; position: sticky; top: 0;
        background: #1e293b; border-radius: 12px 12px 0 0; z-index: 1;
      }
      #ai-grammar-float .agf-close {
        background: none; border: none; color: #94a3b8; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 0 0 0 12px;
      }
      #ai-grammar-float .agf-close:hover { color: #f1f5f9; }
      #ai-grammar-float .agf-item {
        padding: 10px 16px; border-bottom: 1px solid #1e293b;
      }
      #ai-grammar-float .agf-item:last-child { border-bottom: none; }
      #ai-grammar-float .agf-item:hover { background: #0f172a; }
      #ai-grammar-float .agf-original {
        color: #f87171; text-decoration: line-through; margin-right: 8px;
      }
      #ai-grammar-float .agf-correction { color: #4ade80; font-weight: 600; }
      #ai-grammar-float .agf-explain { color: #64748b; font-size: 11px; margin-top: 2px; }
      @media (prefers-color-scheme: light) {
        #ai-grammar-float {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
        }
        #ai-grammar-float .agf-header {
          border-bottom-color: #e2e8f0;
          background: #ffffff;
        }
        #ai-grammar-float .agf-close { color: #64748b; }
        #ai-grammar-float .agf-close:hover { color: #0f172a; }
        #ai-grammar-float .agf-item { border-bottom-color: #f1f5f9; }
        #ai-grammar-float .agf-item:hover { background: #f8fafc; }
        #ai-grammar-float .agf-original { color: #dc2626; }
        #ai-grammar-float .agf-correction { color: #16a34a; }
        #ai-grammar-float .agf-explain { color: #64748b; }
      }
    </style>
    <div class="agf-header">
      <span>🔍 ${errors.length} error${errors.length > 1 ? 's' : ''} found</span>
      <button class="agf-close" onclick="document.getElementById('ai-grammar-float').remove()">✕</button>
    </div>
    ${errors.map(e => `
      <div class="agf-item">
        <div>
          <span class="agf-original">${escapeHtml(e.error)}</span>
          <span class="agf-correction">${escapeHtml(e.correction)}</span>
        </div>
        ${e.explanation ? `<div class="agf-explain">${escapeHtml(e.explanation)}</div>` : ''}
      </div>
    `).join('')}
  `;
  document.body.appendChild(panel);

  if (anchorEl && document.contains(anchorEl)) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const gap = 8;
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

  // Auto-dismiss after 30 seconds
  setTimeout(removeErrorFloat, 30_000);
}

export function removeErrorFloat() {
  const panel = document.getElementById('ai-grammar-float');
  if (panel) panel.remove();
}


// -----------------------------------------------------------------------
// Bridge: expose shared functions/state on window.__aiGrammar so that
// thin content-script adapters (e.g. teams-bridge.js) can call them
// without re-implementing identical logic.  Content scripts share an
// isolated world, so the namespace is accessible across scripts.
// -----------------------------------------------------------------------

window.__aiGrammar = window.__aiGrammar || {};
window.__aiGrammar.showPendingBadge = showPendingBadge;
window.__aiGrammar.removePendingBadge = removePendingBadge;
window.__aiGrammar.updatePendingBadgeLabel = updatePendingBadgeLabel;
window.__aiGrammar.showResultBadge = showResultBadge;
window.__aiGrammar.removeAllBadges = removeAllBadges;
window.__aiGrammar.updateBatchBadge = updateBatchBadge;
window.__aiGrammar.ensureBadgeStack = ensureBadgeStack;
window.__aiGrammar.removeBadgeStackIfEmpty = removeBadgeStackIfEmpty;
