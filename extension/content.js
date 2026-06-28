// AI Grammar Checker — Content script
//
// Runs on every page. Watches for newly submitted text content,
// sends it to the backend for grammar checking, and highlights errors
// with tooltips showing corrections.

(() => {
  if (window.__aiGrammarLoaded) return;
  window.__aiGrammarLoaded = true;

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  const MIN_TEXT_LENGTH = 30;
  const DEBOUNCE_MS = 2000;
  const IGNORE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
    'SVG', 'MATH', 'NOSCRIPT', 'IFRAME', 'CANVAS',
  ]);
  const IGNORE_CLASSES = ['ai-grammar-error', 'ai-grammar-tooltip', 'ai-grammar-badge'];
  const CHECKED_ATTR = 'data-ai-grammar-checked';

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let checkIdCounter = 0;
  let pendingChecks = new Map();       // id → { container, text }
  let checkedElements = new WeakSet(); // elements already checked
  let debounceTimer = null;
  let isHighlighting = false;
  let tooltipEl = null;
  let currentErrorEl = null;

  // Track the last text the user submitted so we only check their content,
  // not AI replies or other page text that happens to appear in the DOM.
  let lastUserText = '';
  let lastUserTextTime = 0;
  const USER_TEXT_TTL_MS = 8000;       // how long we remember user text
  const USER_TEXT_MIN_MATCH = 0.6;     // fraction of user text that must appear in rendered block

  // -----------------------------------------------------------------------
  // CSS injection
  // -----------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('ai-grammar-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-grammar-styles';
    style.textContent = `
      .ai-grammar-error {
        text-decoration: underline wavy #dc2626;
        text-underline-offset: 3px;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-error:hover {
        background-color: rgba(220, 38, 38, 0.1);
      }
      .ai-grammar-error:focus-visible {
        outline: 2px solid #dc2626;
        outline-offset: 1px;
        border-radius: 2px;
      }
      .ai-grammar-tooltip {
        position: fixed;
        z-index: 2147483647;
        background: #1e293b;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        padding: 10px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        max-width: 360px;
        pointer-events: auto;
        animation: ai-gfadein 0.15s ease;
      }
      .ai-grammar-tooltip .ag-correction {
        color: #4ade80;
        font-weight: 600;
      }
      .ai-grammar-tooltip .ag-explanation {
        color: #94a3b8;
        font-size: 12px;
        margin-top: 4px;
      }
      .ai-grammar-tooltip .ag-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .ai-grammar-tooltip button {
        border: none;
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 500;
        font-family: inherit;
      }
      .ai-grammar-tooltip .ag-apply {
        background: #4ade80;
        color: #0f172a;
      }
      .ai-grammar-tooltip .ag-apply:hover { background: #22c55e; }
      .ai-grammar-tooltip .ag-dismiss {
        background: #334155;
        color: #cbd5e1;
      }
      .ai-grammar-tooltip .ag-dismiss:hover { background: #475569; }
      .ai-grammar-tooltip .ag-arrow {
        position: absolute;
        top: -6px;
        left: 20px;
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-bottom: 6px solid #1e293b;
      }
      @keyframes ai-gfadein {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .ai-grammar-badge {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483646;
        background: #1e293b;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        padding: 6px 12px;
        border-radius: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        gap: 6px;
        animation: ai-gfadein 0.2s ease;
      }
      .ai-grammar-badge .ag-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #475569;
        border-top-color: #4ade80;
        border-radius: 50%;
        animation: ai-gspin 0.8s linear infinite;
      }
      @keyframes ai-gspin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  // -----------------------------------------------------------------------
  // Text block detection
  // -----------------------------------------------------------------------

  function isIgnored(el) {
    if (!el || !el.tagName) return true;
    if (IGNORE_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    // Check for our own classes
    for (const cls of IGNORE_CLASSES) {
      if (el.classList?.contains(cls)) return true;
    }
    return false;
  }

  function getTextContent(el) {
    // Get visible text from an element, excluding ignored descendants
    if (isIgnored(el)) return '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      text += node.textContent;
    }
    return text.trim();
  }

  function isTextBlock(el) {
    if (isIgnored(el)) return false;
    if (checkedElements.has(el)) return false;
    if (el.hasAttribute(CHECKED_ATTR)) return false;

    // Skip inline elements that are just small formatting
    const text = getTextContent(el);
    if (text.length < MIN_TEXT_LENGTH) return false;

    // Skip elements that are mostly links/navigation
    const links = el.querySelectorAll('a');
    const linkText = Array.from(links).map(a => a.textContent).join('').length;
    if (linkText > text.length * 0.5) return false;

    return true;
  }

  /**
   * Check whether a DOM text block matches the user's last submitted text.
   * Only blocks that plausibly contain the user's own content pass this filter
   * — AI replies and unrelated page mutations are silently ignored.
   */
  function isUserText(blockText) {
    if (!lastUserText) return false;

    const now = Date.now();
    if (now - lastUserTextTime > USER_TEXT_TTL_MS) {
      lastUserText = '';
      return false;
    }

    // Normalize both strings for comparison
    const normUser = lastUserText.replace(/\s+/g, ' ').trim().toLowerCase();
    const normBlock = blockText.replace(/\s+/g, ' ').trim().toLowerCase();

    if (!normUser || !normBlock) return false;

    // The rendered block should contain most of the submitted text
    return normBlock.includes(normUser) ||
           (normUser.length > 0 && normBlock.length > 0 &&
            longestCommonSubstring(normUser, normBlock) >= normUser.length * USER_TEXT_MIN_MATCH);
  }

  function longestCommonSubstring(a, b) {
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    let maxLen = 0;
    for (let i = 0; i < shorter.length; i++) {
      for (let j = shorter.length - i; j > maxLen; j--) {
        if (longer.includes(shorter.slice(i, i + j))) {
          maxLen = j;
          break;
        }
      }
    }
    return maxLen;
  }

  function findNewTextBlocks(mutations) {
    const blocks = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Check the added element itself
        if (isTextBlock(node)) {
          blocks.push(node);
        }
        // Check descendants (up to a reasonable depth)
        const descendants = node.querySelectorAll?.('p, div, article, section, li, blockquote, td, th, dd, figcaption, h1, h2, h3, h4, h5, h6, span');
        if (descendants) {
          for (const desc of descendants) {
            if (isTextBlock(desc)) {
              blocks.push(desc);
            }
          }
        }
      }
    }
    return blocks;
  }

  // -----------------------------------------------------------------------
  // Text node position mapping
  // -----------------------------------------------------------------------

  /**
   * Walk text nodes inside `container` and build a flat list of
   * { textNode, start: global_offset, end: global_offset }.
   */
  function buildTextNodeMap(container) {
    const map = [];
    let offset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (len > 0) {
        map.push({ textNode: node, start: offset, end: offset + len });
        offset += len;
      }
    }
    return map;
  }

  /**
   * Given a text node map and character offsets [start, end), return a Range.
   */
  function createRange(map, start, end) {
    // Find start node
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;

    for (const entry of map) {
      if (!startNode && start >= entry.start && start < entry.end) {
        startNode = entry.textNode;
        startOffset = start - entry.start;
      }
      if (end > entry.start && end <= entry.end) {
        endNode = entry.textNode;
        endOffset = end - entry.start;
        break;
      }
    }

    if (!startNode || !endNode) return null;

    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch {
      return null; // invalid offsets
    }
    return range;
  }

  // -----------------------------------------------------------------------
  // Highlighting
  // -----------------------------------------------------------------------

  /**
   * Wrap each error in a <span class="ai-grammar-error"> with data attributes.
   * Uses Range.surroundContents or manual extraction when surroundContents fails.
   */
  function highlightErrors(container, errors) {
    if (!errors || errors.length === 0) return 0;

    // Build text node map for the container
    const map = buildTextNodeMap(container);
    if (map.length === 0) return 0;

    // Sort errors by start position (descending — insert from end to start
    // to preserve offsets of earlier errors)
    const sorted = [...errors].sort((a, b) => b.start - a.start);

    let highlighted = 0;
    for (const err of sorted) {
      const range = createRange(map, err.start, err.end);
      if (!range) continue;

      try {
        // Create wrapper span
        const span = document.createElement('span');
        span.className = 'ai-grammar-error';
        span.setAttribute('data-correction', err.correction || '');
        span.setAttribute('data-explanation', err.explanation || '');
        span.setAttribute('data-error', err.error || '');
        span.setAttribute('tabindex', '0'); // focusable for keyboard access

        try {
          range.surroundContents(span);
        } catch {
          // surroundContents fails if range spans partial nodes
          // Fallback: extract contents, wrap, reinsert
          const frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
        }
        highlighted++;
      } catch {
        // Skip errors that can't be highlighted
      }
    }

    return highlighted;
  }

  // -----------------------------------------------------------------------
  // Tooltip
  // -----------------------------------------------------------------------

  function createTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'ai-grammar-tooltip';
    tooltipEl.style.display = 'none';
    tooltipEl.innerHTML = '<div class="ag-arrow"></div>';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltip(errorEl) {
    if (currentErrorEl === errorEl && tooltipEl?.style.display === 'block') return;

    currentErrorEl = errorEl;
    const tip = createTooltip();
    const correction = errorEl.getAttribute('data-correction') || '';
    const explanation = errorEl.getAttribute('data-explanation') || '';
    const original = errorEl.getAttribute('data-error') || '';

    tip.innerHTML = `
      <div class="ag-arrow"></div>
      <div><span style="text-decoration:line-through;color:#f87171;">${escapeHtml(original)}</span> → <span class="ag-correction">${escapeHtml(correction)}</span></div>
      ${explanation ? `<div class="ag-explanation">${escapeHtml(explanation)}</div>` : ''}
      <div class="ag-actions">
        <button class="ag-apply" data-action="apply">Apply fix</button>
        <button class="ag-dismiss" data-action="dismiss">Dismiss</button>
      </div>
    `;

    // Position the tooltip near the error element
    const rect = errorEl.getBoundingClientRect();
    const tipWidth = 360;
    let left = Math.min(rect.left + rect.width / 2, window.innerWidth - tipWidth - 10);
    left = Math.max(10, left);
    let top = rect.top - tip.offsetHeight - 8;

    // If tooltip would go above viewport, show below instead
    if (top < 10) {
      top = rect.bottom + 8;
    }

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.display = 'block';
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.style.display = 'none';
    }
    currentErrorEl = null;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Apply correction
  // -----------------------------------------------------------------------

  function applyCorrection(errorEl) {
    const correction = errorEl.getAttribute('data-correction');
    if (!correction) return;
    errorEl.textContent = correction;
    errorEl.classList.remove('ai-grammar-error');
    errorEl.removeAttribute('data-correction');
    errorEl.removeAttribute('data-explanation');
    errorEl.removeAttribute('data-error');
    errorEl.removeAttribute('tabindex');
    hideTooltip();
  }

  // -----------------------------------------------------------------------
  // Event delegation for tooltips and corrections
  // -----------------------------------------------------------------------

  document.addEventListener('mouseover', (e) => {
    const errorEl = e.target.closest('.ai-grammar-error');
    if (errorEl) {
      showTooltip(errorEl);
    } else if (!e.target.closest('.ai-grammar-tooltip')) {
      hideTooltip();
    }
  });

  document.addEventListener('focusin', (e) => {
    const errorEl = e.target.closest('.ai-grammar-error');
    if (errorEl) {
      showTooltip(errorEl);
    }
  });

  document.addEventListener('click', (e) => {
    // Apply button inside tooltip
    const applyBtn = e.target.closest('.ag-apply');
    if (applyBtn && currentErrorEl) {
      applyCorrection(currentErrorEl);
      return;
    }

    // Dismiss button inside tooltip
    const dismissBtn = e.target.closest('.ag-dismiss');
    if (dismissBtn) {
      hideTooltip();
      return;
    }

    // Click on error span itself — apply on click (convenience)
    const errorEl = e.target.closest('.ai-grammar-error');
    if (errorEl && !e.target.closest('.ai-grammar-tooltip')) {
      applyCorrection(errorEl);
      return;
    }

    // Click elsewhere — hide
    if (!e.target.closest('.ai-grammar-tooltip') && !e.target.closest('.ai-grammar-error')) {
      hideTooltip();
    }
  });

  // Dismiss on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tooltipEl?.style.display === 'block') {
      hideTooltip();
    }
  });

  // -----------------------------------------------------------------------
  // Status badge
  // -----------------------------------------------------------------------

  function showBadge(text, isPending = false) {
    removeBadge();
    const badge = document.createElement('div');
    badge.className = 'ai-grammar-badge';
    badge.innerHTML = isPending
      ? `<div class="ag-spinner"></div>${text}`
      : text;
    document.body.appendChild(badge);
    if (!isPending) {
      setTimeout(removeBadge, 4000);
    }
  }

  function removeBadge() {
    const existing = document.querySelector('.ai-grammar-badge');
    if (existing) existing.remove();
  }

  // -----------------------------------------------------------------------
  // Check pipeline
  // -----------------------------------------------------------------------

  async function checkText(text, container) {
    const id = ++checkIdCounter;
    showBadge('Checking grammar...', true);

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'grammar:check',
        text,
        id,
      });

      removeBadge();

      if (!resp?.ok) {
        if (!resp?.aborted) {
          console.debug('[AI Grammar] Check failed:', resp?.error);
        }
        return;
      }

      const errors = resp.errors || [];
      if (errors.length === 0) return;

      // Highlight errors in the container
      isHighlighting = true;
      const count = highlightErrors(container, errors);
      isHighlighting = false;

      if (count > 0) {
        showBadge(`${count} error${count > 1 ? 's' : ''} found`);
      }
    } catch (e) {
      removeBadge();
      console.debug('[AI Grammar] Check error:', e);
    }
  }

  // -----------------------------------------------------------------------
  // MutationObserver — detect newly submitted text
  // -----------------------------------------------------------------------

  const observer = new MutationObserver((mutations) => {
    if (isHighlighting) return; // Ignore our own DOM changes

    const newBlocks = findNewTextBlocks(mutations);
    if (newBlocks.length === 0) return;

    // Add to pending and debounce — only user-authored content
    for (const block of newBlocks) {
      const text = getTextContent(block);
      if (text.length >= MIN_TEXT_LENGTH && isUserText(text)) {
        pendingChecks.set(block, text);
        checkedElements.add(block);
        block.setAttribute(CHECKED_ATTR, '');
      }
    }

    // Clear stored user text once consumed so it isn't reused
    if (pendingChecks.size > 0) {
      lastUserText = '';
    }

    // Reset debounce timer
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processPendingChecks, DEBOUNCE_MS);
  });

  function processPendingChecks() {
    const entries = [...pendingChecks.entries()];
    pendingChecks.clear();

    for (const [container, text] of entries) {
      checkText(text, container);
    }
  }

  // -----------------------------------------------------------------------
  // Manual selection check (keyboard shortcut)
  // -----------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'grammar:check-selection') {
      handleSelectionCheck();
      sendResponse({ ok: true });
      return false;
    }
  });

  function handleSelectionCheck() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    const text = range.toString().trim();
    if (text.length < MIN_TEXT_LENGTH) {
      showBadge('Selection too short to check');
      return;
    }

    // Find the nearest block-level ancestor to use as container
    let container = range.commonAncestorContainer;
    while (container && container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    if (!container) return;

    // If the container is tiny, walk up to a block-level element
    let el = container;
    while (el && el !== document.body && getTextContent(el).length < text.length * 1.2) {
      el = el.parentElement;
    }
    container = el || container;

    checkText(text, container);
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  function init() {
    injectStyles();

    // Start observing mutations
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // --- Track user-submitted text so we only check the user's content ---
    // Capture text when the user submits a form (e.g., chat send)
    document.addEventListener('submit', (e) => {
      const form = e.target;
      const textareas = form.querySelectorAll('textarea');
      const inputs = form.querySelectorAll('input[type="text"]');
      let captured = '';
      for (const ta of textareas) {
        captured = ta.value.trim();
        if (captured) break;
      }
      if (!captured) {
        for (const inp of inputs) {
          captured = inp.value.trim();
          if (captured) break;
        }
      }
      if (captured && captured.length >= MIN_TEXT_LENGTH) {
        lastUserText = captured;
        lastUserTextTime = Date.now();
      }
    }, true);

    // Capture text on Enter (without Shift) in textareas
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;
      const text = (ta.value || ta.textContent || '').trim();
      if (text.length >= MIN_TEXT_LENGTH) {
        lastUserText = text;
        lastUserTextTime = Date.now();
      }
    }, true);

    console.debug('[AI Grammar] Content script initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
