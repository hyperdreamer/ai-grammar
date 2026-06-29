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

  const DEBOUNCE_MS = 2000;
  let minChars = 30;  // read from storage (grammarMinChars)
  const IGNORE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
    'SVG', 'MATH', 'NOSCRIPT', 'IFRAME', 'CANVAS',
  ]);
  const IGNORE_CLASSES = ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom', 'ai-grammar-tooltip', 'ai-grammar-badge'];
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
  const LIVE_HIGHLIGHT_CLASS = 'ag-live-highlight';
  let liveHighlightEl = null;
  let liveHighlightTarget = null;
  let liveHighlightRestore = null;
  let liveHighlightScrollHandler = null;
  let liveHighlightMouseMoveHandler = null;
  let liveHighlightMouseLeaveHandler = null;

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
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #dc2626 !important;
        text-decoration-thickness: 1.5px !important;
        text-underline-offset: 3px;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-error:hover {
        background-color: rgba(220, 38, 38, 0.08);
      }
      .ai-grammar-improvement {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #4ade80 !important;
        text-decoration-thickness: 1.5px !important;
        text-underline-offset: 3px;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-improvement:hover {
        background-color: rgba(74, 222, 128, 0.08);
      }
      .ai-grammar-idiom {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #60a5fa !important;
        text-decoration-thickness: 1.5px !important;
        text-underline-offset: 3px;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-idiom:hover {
        background-color: rgba(96, 165, 250, 0.08);
      }
      .ai-grammar-error:focus-visible {
        outline: 2px solid #dc2626;
        outline-offset: 1px;
        border-radius: 2px;
      }
      .ag-live-highlight {
        isolation: isolate;
      }
      .ag-live-highlight-backdrop {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        scrollbar-width: none;
      }
      .ag-live-highlight-backdrop::-webkit-scrollbar {
        display: none;
      }
      .ag-live-highlight-backdrop .ai-grammar-error,
      .ag-live-highlight-backdrop .ai-grammar-improvement,
      .ag-live-highlight-backdrop .ai-grammar-idiom {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
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
    if (text.length < minChars) return false;

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
  function buildTextNodeMap(container, checkedText = '') {
    const map = [];
    // Walk ALL text nodes and compute absolute offsets from the raw DOM text
    let offset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    // First pass: collect raw full text to find where checkedText starts
    const allNodes = [];
    let fullRawText = '';
    while ((node = walker.nextNode())) {
      allNodes.push(node);
      fullRawText += node.textContent;
    }
    // Find where the checked text starts in the raw DOM text
    const rawStart = checkedText ? fullRawText.indexOf(checkedText) : 0;
    const baseOffset = rawStart >= 0 ? rawStart : 0;

    // Second pass: build the map with corrected offsets
    for (const n of allNodes) {
      const len = n.textContent.length;
      if (len > 0) {
        const nodeStart = offset - baseOffset;
        map.push({ textNode: n, start: nodeStart, end: nodeStart + len });
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
  function highlightErrors(container, errors, checkedText = '') {
    if (!errors || errors.length === 0) return 0;

    // Build text node map for the container
    const map = buildTextNodeMap(container, checkedText || getTextContent(container));
    if (map.length === 0) return 0;

    // Sort errors by start position (descending — insert from end to start
    // to preserve offsets of earlier errors)
    const sorted = [...errors].sort((a, b) => b.start - a.start);

    let highlighted = 0;
    for (const err of sorted) {
      const range = createRange(map, err.start, err.end);
      if (!range) continue;

      try {
        // Map type to CSS class
        const typeMap = {
          error: 'ai-grammar-error',
          improvement: 'ai-grammar-improvement',
          idiom: 'ai-grammar-idiom',
        };
        const cls = typeMap[err.type] || 'ai-grammar-error';

        // Create wrapper span
        const span = document.createElement('span');
        span.className = cls;
        span.setAttribute('data-correction', err.correction || '');
        span.setAttribute('data-explanation', err.explanation || '');
        span.setAttribute('data-error', err.error || '');
        span.setAttribute('data-type', err.type || 'error');
        span.setAttribute('tabindex', '0');

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
    const type = errorEl.getAttribute('data-type') || 'error';

    const typeLabel = { error: '🔴 Error', improvement: '🟢 Improvement', idiom: '🔵 Idiom' };
    const typeColor = { error: '#f87171', improvement: '#4ade80', idiom: '#60a5fa' };

    tip.innerHTML = `
      <div class="ag-arrow"></div>
      <div style="font-size:11px;color:${typeColor[type]};margin-bottom:4px;font-weight:600;">${typeLabel[type] || 'Error'}</div>
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

    if (errorEl.hasAttribute('data-live-draft')) {
      const wrapper = errorEl.closest(`.${LIVE_HIGHLIGHT_CLASS}`);
      const textarea = wrapper?.querySelector('textarea');
      const start = Number(errorEl.getAttribute('data-start'));
      const end = Number(errorEl.getAttribute('data-end'));
      if (textarea && Number.isInteger(start) && Number.isInteger(end)) {
        const value = textarea.value;
        textarea.value = value.slice(0, start) + correction + value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + correction.length;
        textarea.focus();
        textarea.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertReplacementText',
          data: correction,
        }));
      }
      clearLiveDraftHighlights();
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
  // Event delegation for tooltips and corrections
  // -----------------------------------------------------------------------

  const GRAMMAR_CLASSES = '.ai-grammar-error, .ai-grammar-improvement, .ai-grammar-idiom';

  document.addEventListener('mouseover', (e) => {
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
    if (errorEl) {
      showTooltip(errorEl);
    } else if (!e.target.closest('.ai-grammar-tooltip')) {
      hideTooltip();
    }
  });

  document.addEventListener('focusin', (e) => {
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
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
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
    if (errorEl && !e.target.closest('.ai-grammar-tooltip')) {
      applyCorrection(errorEl);
      return;
    }

    // Click elsewhere — hide
    if (!e.target.closest('.ai-grammar-tooltip') && !e.target.closest(GRAMMAR_CLASSES)) {
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

  function showBadge(text, isPending = false, durationMs = 4000) {
    removeBadge();
    const badge = document.createElement('div');
    badge.className = 'ai-grammar-badge';
    badge.innerHTML = isPending
      ? `<div class="ag-spinner"></div>${text}`
      : text;
    document.body.appendChild(badge);
    if (!isPending) {
      setTimeout(removeBadge, durationMs);
    }
  }

  function removeBadge() {
    const existing = document.querySelector('.ai-grammar-badge');
    if (existing) existing.remove();
  }

  // -----------------------------------------------------------------------
  // Floating error notification (replaces inline underlines)
  // -----------------------------------------------------------------------

  function showErrorFloat(errors, anchorEl = null) {
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

    // Auto-dismiss after 30 seconds
    setTimeout(removeErrorFloat, 30_000);
  }

  function removeErrorFloat() {
    const panel = document.getElementById('ai-grammar-float');
    if (panel) panel.remove();
  }

  // -----------------------------------------------------------------------
  // Check pipeline (post-submit grammar checking)
  // -----------------------------------------------------------------------

  function highlightLiveDraft(ta, errors) {
    clearLiveDraftHighlights();
    if (!errors?.length) return;

    if (ta.tagName === 'TEXTAREA') {
      highlightLiveDraftTextarea(ta, errors);
    } else if (ta.isContentEditable) {
      highlightErrors(ta, errors);
      liveHighlightTarget = ta;
    }
  }

  function highlightLiveDraftTextarea(textarea, errors) {
    const text = textarea.value;
    const styles = window.getComputedStyle(textarea);
    const textColor = styles.color || '#e2e8f0';
    const parent = textarea.parentNode;
    if (!parent) return;

    // Create a wrapper around the textarea
    const wrapper = document.createElement('div');
    wrapper.className = LIVE_HIGHLIGHT_CLASS;
    wrapper.style.position = 'relative';
    wrapper.style.display = styles.display === 'block' ? 'block' : 'inline-block';
    wrapper.style.width = `${textarea.offsetWidth}px`;
    wrapper.style.height = `${textarea.offsetHeight}px`;
    wrapper.style.margin = styles.margin;
    wrapper.style.verticalAlign = styles.verticalAlign;
    if (styles.flexGrow !== '0') wrapper.style.flex = styles.flex;

    // Create the highlight backdrop (mirrors textarea rendering)
    const backdrop = document.createElement('div');
    backdrop.className = 'ag-live-highlight-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.style.position = 'absolute';
    backdrop.style.inset = '0';
    backdrop.style.pointerEvents = 'none';
    backdrop.style.zIndex = '2147483645';
    backdrop.style.fontFamily = styles.fontFamily;
    backdrop.style.fontSize = styles.fontSize;
    backdrop.style.fontWeight = styles.fontWeight;
    backdrop.style.fontStyle = styles.fontStyle;
    backdrop.style.letterSpacing = styles.letterSpacing;
    backdrop.style.textTransform = styles.textTransform;
    backdrop.style.textAlign = styles.textAlign;
    backdrop.style.lineHeight = styles.lineHeight;
    backdrop.style.whiteSpace = 'pre-wrap';
    backdrop.style.overflowWrap = styles.overflowWrap || styles.wordWrap || 'break-word';
    backdrop.style.wordBreak = styles.wordBreak;
    backdrop.style.tabSize = styles.tabSize;
    backdrop.style.overflow = 'hidden';
    backdrop.style.padding = `${styles.paddingTop} ${styles.paddingRight} ${styles.paddingBottom} ${styles.paddingLeft}`;
    backdrop.style.borderStyle = styles.borderStyle;
    backdrop.style.borderWidth = `${styles.borderTopWidth} ${styles.borderRightWidth} ${styles.borderBottomWidth} ${styles.borderLeftWidth}`;
    backdrop.style.borderColor = 'transparent';
    backdrop.style.borderRadius = styles.borderRadius;
    backdrop.style.boxSizing = 'border-box';
    backdrop.style.color = 'transparent';
    backdrop.style.background = 'transparent';

    // Build highlighted HTML
    let html = '';
    let pos = 0;
    const sorted = [...errors].sort((a, b) => a.start - b.start);
    for (const err of sorted) {
      const start = Math.max(0, Math.min(text.length, Number(err.start)));
      const end = Math.max(start, Math.min(text.length, Number(err.end)));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < pos || start === end) continue;
      html += escapeHtml(text.slice(pos, start));
      const cls = err.type === 'improvement' ? 'ai-grammar-improvement' : err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
      const type = err.type || 'error';
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;" data-live-draft="true" data-start="${start}" data-end="${end}" data-correction="${escapeHtml(err.correction || '')}" data-explanation="${escapeHtml(err.explanation || '')}" data-error="${escapeHtml(err.error || text.slice(start, end))}" data-type="${escapeHtml(type)}" tabindex="0">${escapeHtml(text.slice(start, end))}</span>`;
      pos = end;
    }
    html += escapeHtml(text.slice(pos));
    backdrop.innerHTML = html;

    // Insert wrapper before textarea, move textarea inside
    parent.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);
    wrapper.appendChild(backdrop);

    liveHighlightScrollHandler = () => {
      backdrop.scrollTop = textarea.scrollTop;
      backdrop.scrollLeft = textarea.scrollLeft;
    };
    liveHighlightScrollHandler();
    textarea.addEventListener('scroll', liveHighlightScrollHandler);

    liveHighlightMouseMoveHandler = (event) => {
      backdrop.style.pointerEvents = 'auto';
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      backdrop.style.pointerEvents = 'none';
      const errorEl = hit?.closest?.(GRAMMAR_CLASSES);
      if (errorEl && backdrop.contains(errorEl)) {
        showTooltip(errorEl);
      } else if (!event.target.closest?.('.ai-grammar-tooltip')) {
        hideTooltip();
      }
    };
    liveHighlightMouseLeaveHandler = (event) => {
      if (!event.relatedTarget?.closest?.('.ai-grammar-tooltip')) {
        hideTooltip();
      }
    };
    wrapper.addEventListener('mousemove', liveHighlightMouseMoveHandler);
    wrapper.addEventListener('mouseleave', liveHighlightMouseLeaveHandler);

    liveHighlightRestore = {
      color: textarea.style.color,
      caretColor: textarea.style.caretColor,
      margin: textarea.style.margin,
      position: textarea.style.position,
      zIndex: textarea.style.zIndex,
      width: textarea.style.width,
      height: textarea.style.height,
      boxSizing: textarea.style.boxSizing,
    };

    // Keep textarea text readable; the overlay contributes only underlines.
    textarea.style.color = textColor;
    textarea.style.caretColor = textColor;
    textarea.style.margin = '0';
    textarea.style.position = 'relative';
    textarea.style.zIndex = '1';
    textarea.style.boxSizing = 'border-box';
    textarea.style.width = '100%';
    textarea.style.height = '100%';

    liveHighlightEl = wrapper;
    liveHighlightTarget = textarea;
  }

  function clearLiveDraftHighlights() {
    if (liveHighlightEl && liveHighlightTarget) {
      // Restore textarea to its original position
      const parent = liveHighlightEl.parentNode;
      if (parent) {
        parent.insertBefore(liveHighlightTarget, liveHighlightEl);
      }
      liveHighlightEl.remove();

      // Restore textarea appearance
      if (liveHighlightScrollHandler) {
        liveHighlightTarget.removeEventListener('scroll', liveHighlightScrollHandler);
      }
      if (liveHighlightMouseMoveHandler) {
        liveHighlightEl.removeEventListener('mousemove', liveHighlightMouseMoveHandler);
      }
      if (liveHighlightMouseLeaveHandler) {
        liveHighlightEl.removeEventListener('mouseleave', liveHighlightMouseLeaveHandler);
      }
      if (liveHighlightRestore) {
        liveHighlightTarget.style.color = liveHighlightRestore.color;
        liveHighlightTarget.style.caretColor = liveHighlightRestore.caretColor;
        liveHighlightTarget.style.margin = liveHighlightRestore.margin;
        liveHighlightTarget.style.position = liveHighlightRestore.position;
        liveHighlightTarget.style.zIndex = liveHighlightRestore.zIndex;
        liveHighlightTarget.style.width = liveHighlightRestore.width;
        liveHighlightTarget.style.height = liveHighlightRestore.height;
        liveHighlightTarget.style.boxSizing = liveHighlightRestore.boxSizing;
      }
    }
    liveHighlightEl = null;
    liveHighlightTarget = null;
    liveHighlightRestore = null;
    liveHighlightScrollHandler = null;
    liveHighlightMouseMoveHandler = null;
    liveHighlightMouseLeaveHandler = null;
  }

  // -----------------------------------------------------------------------
  // Live draft checking (checks text as you type after configurable pause)
  // -----------------------------------------------------------------------

  function setupLiveDraftCheck() {
    let lastInputTime = 0;
    let liveCheckTarget = null;
    let liveDelay = 5000;       // ms, read from storage

    // Load settings from storage
    chrome.storage.sync.get({
      grammarLiveDelay: 5,
      grammarLiveMinChars: 30,
    }).then(s => {
      liveDelay = (s.grammarLiveDelay || 5) * 1000;
      minChars = s.grammarLiveMinChars || 30;
    });

    // Also listen for storage changes to update live
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.grammarLiveDelay) {
        liveDelay = (changes.grammarLiveDelay.newValue || 5) * 1000;
      }
      if (changes.grammarLiveMinChars) {
        minChars = changes.grammarLiveMinChars.newValue || 30;
      }
    });

    // Poll every 500ms to check if delay has elapsed since last input
    setInterval(() => {
      if (!liveCheckTarget || !document.contains(liveCheckTarget)) return;

      const elapsed = Date.now() - lastInputTime;
      if (elapsed < liveDelay) return;

      // Delay elapsed since last input — trigger the check
      const ta = liveCheckTarget;
      liveCheckTarget = null;

      const text = (ta.value || ta.textContent || '').trim();
      if (text.length < minChars) return;

      checkLiveDraft(ta, text);
    }, 500);

    async function checkLiveDraft(ta, text) {
      try {
        showBadge('Checking grammar...', true);
        const settings = await chrome.storage.sync.get({
          grammarHost: '127.0.0.1',
          grammarPort: 8766,
        });
        const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language: 'auto' }),
        });
        const data = await resp.json();
        removeBadge();
        if (data?.errors?.length > 0) {
          highlightLiveDraft(ta, data.errors);
        }
      } catch (err) {
        console.debug('[AI Grammar] Live check error:', err);
      }
    }

    document.addEventListener('input', (e) => {
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;

      const text = (ta.value || ta.textContent || '').trim();
      if (text.length < minChars) return;

      clearLiveDraftHighlights();
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
    }, true);

    document.addEventListener('submit', () => {
      liveCheckTarget = null;
      clearLiveDraftHighlights();
    }, true);
  }

  // -----------------------------------------------------------------------
  // Check pipeline (post-submit grammar checking)
  // -----------------------------------------------------------------------

  async function checkText(text, container) {
    const id = ++checkIdCounter;
    showBadge('Checking grammar...', true);

    try {
      // Read backend URL from storage, then fetch via page-world bridge
      const settings = await chrome.storage.sync.get({
        grammarHost: '127.0.0.1',
        grammarPort: 8766,
      });
      const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: 'auto' }),
      });
      const data = await resp.json();

      removeBadge();

      if (!data?.errors) return;
      const errors = data.errors;
      if (errors.length === 0) return;

      // Highlight errors inline with colored underlines
      isHighlighting = true;
      const count = highlightErrors(container, errors, text);
      isHighlighting = false;

      if (count > 0) {
        const breakdown = { error: 0, improvement: 0, idiom: 0 };
        for (const e of errors) { breakdown[e.type] = (breakdown[e.type] || 0) + 1; }
        const parts = [];
        if (breakdown.error) parts.push(`${breakdown.error} error${breakdown.error > 1 ? 's' : ''}`);
        if (breakdown.improvement) parts.push(`${breakdown.improvement} improvement${breakdown.improvement > 1 ? 's' : ''}`);
        if (breakdown.idiom) parts.push(`${breakdown.idiom} idiom${breakdown.idiom > 1 ? 's' : ''}`);
        showBadge(parts.join(', ') + ' found');
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
      if (text.length >= minChars && isUserText(text)) {
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
    if (text.length < minChars) {
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
  // Command system (?/ prefix)
  // -----------------------------------------------------------------------

  const COMMAND_PREFIX = '?/';
  const COMMANDS = {
    off: {
      help: 'Disable auto grammar checking',
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: false });
        showBadge('Grammar checker disabled');
      },
    },
    on: {
      help: 'Enable auto grammar checking',
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: true });
        showBadge('Grammar checker enabled');
      },
    },
    check: {
      help: 'Force grammar check of the page',
      async run() {
        const candidates = document.querySelectorAll('p, div, article, section, li, blockquote, td, th, dd, h1, h2, h3, h4, h5, h6');
        let checked = 0;
        for (const el of candidates) {
          if (isIgnored(el) || checkedElements.has(el) || el.hasAttribute(CHECKED_ATTR)) continue;
          const text = getTextContent(el);
          if (text.length >= minChars) {
            checkedElements.add(el);
            el.setAttribute(CHECKED_ATTR, '');
            checkText(text, el);
            checked++;
          }
        }
        showBadge(checked > 0 ? `Checking ${checked} text block${checked > 1 ? 's' : ''}...` : 'No new text to check');
      },
    },
    lang: {
      help: 'Set language (e.g., ?/lang en, ?/lang zh, ?/lang auto)',
      async run(args) {
        const valid = ['auto', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar'];
        const lang = (args || '').toLowerCase();
        if (!valid.includes(lang)) {
          showBadge(`Unknown language: "${args}". Use: ${valid.join(', ')}`);
          return;
        }
        const label = lang === 'auto' ? 'Auto-detect' : lang.toUpperCase();
        await chrome.storage.sync.set({ grammarLanguage: lang });
        showBadge(`Language set to ${label}`);
      },
    },
    help: {
      help: 'Show available commands',
      run() {
        const lines = Object.entries(COMMANDS).map(([name, cmd]) => `?/${name} — ${cmd.help}`);
        showBadge(lines.join(' | '), false, 8000);
      },
    },
    fix: {
      help: 'Auto-correct the text you typed (everything before ?/fix)',
      async run(_args, ta) {
        const value = ta.value || ta.textContent || '';
        const cmdIdx = value.lastIndexOf('?/fix');
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < minChars) {
          showBadge('No text to fix (need at least ' + minChars + ' characters)');
          return;
        }
        showBadge('Fixing...', true);
        try {
          const settings = await chrome.storage.sync.get({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
          });
          const data = await resp.json();
          removeBadge();
          if (!data?.errors?.length) {
            showBadge('✓ No corrections needed');
            return;
          }
          // Apply corrections bottom-up to preserve offsets
          const sorted = [...data.errors].sort((a, b) => b.start - a.start);
          let fixed = draft;
          for (const err of sorted) {
            fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
          }
          // Replace textarea content with fixed text
          if (ta.tagName === 'TEXTAREA') {
            ta.value = fixed;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            ta.textContent = fixed;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          ta.focus();
          showBadge(`✓ Fixed ${sorted.length} issue${sorted.length > 1 ? 's' : ''}`);
        } catch (e) {
          removeBadge();
          showBadge(`Fix failed: ${e.message}`);
        }
      },
    },
  };

  /**
   * Check if text contains a ?/ command and execute it. Returns true if handled.
   */
  async function handleCommand(text, ta = null) {
    // Find ?/command at the end of the text
    const match = text.match(/\?\/\w+(\s+\S+)?$/);
    if (!match) return false;

    const cmdText = match[0].trim();
    const parts = cmdText.slice(2).trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const cmd = COMMANDS[cmdName];
    if (!cmd) {
      showBadge(`Unknown command: ?/${cmdName}. Try ?/help`);
      return true;
    }

    try {
      if (cmdName === 'fix' && ta) {
        await cmd.run(args, ta);
      } else if (cmdName === 'fix') {
        // Called from submit handler — extract text before ?/fix and apply
        const cmdIdx = text.lastIndexOf('?/fix');
        const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
        if (!draft || draft.length < minChars) {
          showBadge('No text to fix (need at least ' + minChars + ' characters)');
          return true;
        }
        showBadge('Fixing...', true);
        try {
          const settings = await chrome.storage.sync.get({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
          });
          const data = await resp.json();
          removeBadge();
          if (!data?.errors?.length) {
            showBadge('✓ No corrections needed');
            return true;
          }
          const sorted = [...data.errors].sort((a, b) => b.start - a.start);
          let fixed = draft;
          for (const err of sorted) {
            fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
          }
          // Show corrected text as a float notification
          showBadge(`Corrected: "${fixed.slice(0, 80)}${fixed.length > 80 ? '...' : ''}"`, false, 10000);
        } catch (e) {
          removeBadge();
          showBadge(`Fix failed: ${e.message}`);
        }
      } else {
        await cmd.run(args);
      }
    } catch (e) {
      showBadge(`Command failed: ${e.message}`);
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Command palette (shown when user types ?/ in a text input)
  // -----------------------------------------------------------------------

  let paletteEl = null;
  let paletteTarget = null;
  let paletteSelectedIdx = 0;

  function buildPaletteCommands() {
    return Object.entries(COMMANDS).map(([name, cmd]) => ({
      name,
      help: cmd.help,
      full: name === 'lang' ? `?/lang en` : `?/${name}`,
      needsArg: name === 'lang',
    }));
  }

  function showCommandPalette(ta) {
    hideCommandPalette();
    paletteTarget = ta;
    paletteSelectedIdx = 0;

    const items = buildPaletteCommands();
    const rect = ta.getBoundingClientRect();

    paletteEl = document.createElement('div');
    paletteEl.id = 'ai-grammar-palette';
    paletteEl.innerHTML = `
      <style>
        #ai-grammar-palette {
          position: fixed; z-index: 2147483647;
          background: #1e293b; color: #f1f5f9; border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 280px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px; overflow: hidden; animation: ai-gfadein 0.12s ease;
        }
        #ai-grammar-palette .agp-item {
          padding: 8px 14px; cursor: pointer; display: flex;
          justify-content: space-between; align-items: center;
          border-bottom: 1px solid #0f172a;
        }
        #ai-grammar-palette .agp-item:last-child { border-bottom: none; }
        #ai-grammar-palette .agp-item.active { background: #334155; }
        #ai-grammar-palette .agp-item:hover { background: #334155; }
        #ai-grammar-palette .agp-cmd { color: #4ade80; font-weight: 600; font-family: monospace; }
        #ai-grammar-palette .agp-help { color: #94a3b8; font-size: 11px; }
      </style>
      ${items.map((item, i) => `
        <div class="agp-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-cmd="${item.name}">
          <span class="agp-cmd">${item.full}</span>
          <span class="agp-help">${item.help}</span>
        </div>
      `).join('')}
    `;
    document.body.appendChild(paletteEl);

    // Position below or above the textarea
    const pH = paletteEl.offsetHeight;
    let top = rect.bottom + 4;
    if (top + pH > window.innerHeight - 10) {
      top = rect.top - pH - 4;
    }
    paletteEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 296)) + 'px';
    paletteEl.style.top = Math.max(8, top) + 'px';

    // Click handler
    paletteEl.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.agp-item');
      if (item) {
        e.preventDefault();
        const cmdName = item.dataset.cmd;
        selectPaletteCommand(cmdName);

        // If it's the 'lang' command, insert "lang " and let user type the code
        if (cmdName === 'lang') {
          insertPaletteText('lang ');
        } else {
          applyPaletteCommand(cmdName);
        }
      }
    });
  }

  function hideCommandPalette() {
    if (paletteEl) { paletteEl.remove(); paletteEl = null; }
    paletteTarget = null;
    paletteSelectedIdx = 0;
  }

  function updatePaletteSelection(delta) {
    if (!paletteEl) return;
    const items = paletteEl.querySelectorAll('.agp-item');
    if (items.length === 0) return;
    items[paletteSelectedIdx].classList.remove('active');
    paletteSelectedIdx = (paletteSelectedIdx + delta + items.length) % items.length;
    items[paletteSelectedIdx].classList.add('active');
    items[paletteSelectedIdx].scrollIntoView({ block: 'nearest' });
  }

  function selectPaletteCommand(cmdName) {
    if (cmdName === 'lang') {
      // Insert "lang " for the user to complete with a language code
      insertPaletteText('lang ');
      return;
    }
    applyPaletteCommand(cmdName);
  }

  function insertPaletteText(text) {
    if (!paletteTarget) return;
    hideCommandPalette();
    const ta = paletteTarget;
    const value = ta.value || ta.textContent || '';
    // Replace the last ?/ with the new text, keeping everything before it
    const idx = value.lastIndexOf('?/');
    const prefix = idx >= 0 ? value.slice(0, idx) : '';
    const newValue = prefix + text;
    if (ta.tagName === 'TEXTAREA') {
      ta.value = newValue;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ta.textContent = newValue;
    }
    ta.focus();
  }

  async function applyPaletteCommand(cmdName) {
    if (!paletteTarget) return;
    const ta = paletteTarget;
    hideCommandPalette();

    // Replace the last ?/ with the full command, keeping text before it
    const value = ta.value || ta.textContent || '';
    const fullCmd = cmdName === 'lang' ? '?/lang en' : `?/${cmdName}`;
    const idx = value.lastIndexOf('?/');
    const prefix = idx >= 0 ? value.slice(0, idx) : '';
    const newValue = prefix + fullCmd;
    if (ta.tagName === 'TEXTAREA') {
      ta.value = newValue;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ta.textContent = newValue;
    }

    // Execute the command
    try {
      await COMMANDS[cmdName].run('');
    } catch (err) {
      showBadge(`Command failed: ${err.message}`);
    }

    // Clear the command text from the input
    setTimeout(() => {
      const v = ta.value || ta.textContent || '';
      const cleaned = v.replace(fullCmd, '').trimEnd();
      if (ta.tagName === 'TEXTAREA') {
        ta.value = cleaned;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        ta.textContent = cleaned;
      }
      ta.focus();
    }, 100);
  }

  function init() {
    injectStyles();

    // Start observing mutations
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // --- Track user-submitted text so we only check the user's content ---
    // Helper: process captured text — handle commands, otherwise store for matching
    async function processCapturedText(captured) {
      if (!captured || captured.length < minChars) return;
      // Check for ?/ prefix commands at the end
      if (/\?\/\w+(\s+\S+)?$/.test(captured)) {
        await handleCommand(captured);
        return;
      }
      lastUserText = captured;
      lastUserTextTime = Date.now();
    }

    function getTextFromControls(scope) {
      if (!scope?.querySelectorAll) return '';
      const textareas = scope.querySelectorAll('textarea');
      const inputs = scope.querySelectorAll('input[type="text"], input:not([type])');
      for (const ta of textareas) {
        const captured = ta.value.trim();
        if (captured) return captured;
      }
      for (const inp of inputs) {
        const captured = inp.value.trim();
        if (captured) return captured;
      }
      return '';
    }

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
      processCapturedText(captured);
    }, true);

    document.addEventListener('click', (e) => {
      const control = e.target.closest?.('button, input[type="button"], input[type="submit"]');
      if (!control) return;

      const label = (control.innerText || control.value || control.getAttribute('aria-label') || '').trim().toLowerCase();
      const looksLikeSend = /^(send|submit|post|reply|comment)$/.test(label) ||
                            control.type === 'submit' ||
                            control.getAttribute('data-testid')?.toLowerCase().includes('send');
      if (!looksLikeSend) return;

      const form = control.closest('form');
      const scope = form || control.closest('.input-row, [role="form"], [contenteditable="true"]') || control.parentElement;
      let captured = getTextFromControls(scope);
      if (!captured) {
        const active = document.activeElement;
        if (active?.tagName === 'TEXTAREA' || active?.isContentEditable) {
          captured = (active.value || active.textContent || '').trim();
        }
      }
      processCapturedText(captured);
    }, true);

    // Capture text on Enter + palette keyboard navigation
    document.addEventListener('keydown', (e) => {
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;

      // Palette keyboard navigation
      if (paletteEl) {
        if (e.key === 'ArrowDown') { e.preventDefault(); updatePaletteSelection(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); updatePaletteSelection(-1); return; }
        if (e.key === 'Escape')    { e.preventDefault(); hideCommandPalette(); return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const active = paletteEl.querySelector('.agp-item.active');
          if (active) selectPaletteCommand(active.dataset.cmd);
          return;
        }
        return; // Block other keys while palette is open
      }

      // Normal Enter → capture text for grammar checking
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const text = (ta.value || ta.textContent || '').trim();
      processCapturedText(text);
    }, true);

    // Detect ?/ commands inline as the user types — no submit needed
    let commandDebounce = null;
    document.addEventListener('input', (e) => {
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;

      clearTimeout(commandDebounce);
      const value = ta.value || ta.textContent || '';

      // Bare ?/ at end → show command palette
      if (/\?\/\s*$/.test(value) && !/\w\?\/\s*$/.test(value)) {
        showCommandPalette(ta);
        return;
      }

      // Full command at end (e.g., "?/off", "hello ?/off", "?/lang en")
      const match = value.match(/\?\/\w+(\s+\S+)?$/);
      if (match) {
        hideCommandPalette();
        const cmdText = match[0].trim();
        const parts = cmdText.slice(2).trim().split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const cmdArgs = parts.slice(1).join(' ');

        if (!COMMANDS[cmdName]) return;

        commandDebounce = setTimeout(async () => {
          const currentValue = ta.value || ta.textContent || '';
          if (!currentValue.includes(cmdText)) return;

          try {
            if (cmdName === 'fix') {
              await COMMANDS.fix.run(cmdArgs, ta);
            } else {
              await COMMANDS[cmdName].run(cmdArgs);
            }
          } catch (err) {
            showBadge(`Command failed: ${err.message}`);
          }

          // Strip the command portion, keep text before it
          // Skip for 'fix' — it already replaced the textarea content
          if (cmdName !== 'fix') {
            const idx = ta.value ? ta.value.lastIndexOf(cmdText) : (ta.textContent || '').lastIndexOf(cmdText);
            const val = ta.value || ta.textContent || '';
            const cleaned = (idx >= 0 ? val.slice(0, idx) + val.slice(idx + cmdText.length) : val).trimEnd();
            if (ta.tagName === 'TEXTAREA') {
              ta.value = cleaned;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              ta.textContent = cleaned;
            }
          }
        }, 600);
        return;
      }

      // User typed something else → hide palette
      hideCommandPalette();
    }, true);

    // Start live draft checking (checks text as you type after 5s pause)
    setupLiveDraftCheck();

    console.debug('[AI Grammar] Content script initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
