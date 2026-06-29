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
  const IGNORE_CLASSES = ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom', 'ai-grammar-tooltip', 'ai-grammar-badge', 'ai-grammar-ok'];
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
  let liveHighlightReposition = null;

  // AbortController for in-flight grammar checks — aborted when user resumes typing
  let activeCheckController = null;

  // Function to cancel pending live draft check — set by setupLiveDraftCheck
  let cancelLiveDraft = null;
  let commandInFlight = false;
  let skipLiveCheck = false;   // set during fix/polish to prevent re-triggering live draft

  // Track whether the extension context has been invalidated (MV3 service worker
  // termination / extension reload). Once invalidated, chrome.* APIs throw
  // "Extension context invalidated" — we fall back to hardcoded defaults.
  let contextInvalidated = false;

  /**
   * Wrapper around chrome.storage.sync.get() that catches
   * "Extension context invalidated" and returns the caller's defaults.
   * Content scripts can outlive the service worker; storage should work
   * independently, but Chrome sometimes throws this error after an
   * extension reload or aggressive SW termination.
   */
  async function safeGetStorage(defaults) {
    if (contextInvalidated) return defaults;
    try {
      return await chrome.storage.sync.get(defaults);
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        contextInvalidated = true;
        console.debug('[AI Grammar] Extension context invalidated, using defaults');
        return defaults;
      }
      throw e;
    }
  }

  // Track the last text the user submitted so we only check their content,
  // not AI replies or other page text that happens to appear in the DOM.
  let lastUserText = '';
  let lastUserTextTime = 0;
  const USER_TEXT_TTL_MS = 8000;       // how long we remember user text
  const USER_TEXT_MIN_MATCH = 0.6;     // fraction of user text that must appear in rendered block
  const USER_MESSAGE_SELECTOR = [
    '.user-msg',
    '.user-message',
    '.message.user',
    '[data-testid*="user"]',
    '[class*="user"][class*="msg"]',
    '[class*="user"][class*="message"]',
  ].join(', ');

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
      @media (prefers-color-scheme: light) {
        .ai-grammar-tooltip {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        }
        .ai-grammar-tooltip .ag-correction {
          color: #16a34a;
        }
        .ai-grammar-tooltip .ag-explanation {
          color: #64748b;
        }
        .ai-grammar-tooltip .ag-apply {
          background: #16a34a;
          color: #ffffff;
        }
        .ai-grammar-tooltip .ag-apply:hover { background: #15803d; }
        .ai-grammar-tooltip .ag-dismiss {
          background: #f1f5f9;
          color: #475569;
        }
        .ai-grammar-tooltip .ag-dismiss:hover { background: #e2e8f0; }
        .ai-grammar-tooltip .ag-arrow {
          border-bottom-color: #ffffff;
        }
        .ai-grammar-badge {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .ai-grammar-badge .ag-spinner {
          border-color: #e2e8f0;
          border-top-color: #16a34a;
        }
      }
      .ai-grammar-ok {
        display: inline-block;
        color: #4ade80;
        font-size: 0.75em;
        font-weight: 700;
        margin-left: 4px;
        vertical-align: super;
        line-height: 1;
        animation: ai-gfadein 0.3s ease;
      }
      .ai-grammar-ok-ta {
        position: fixed;
        z-index: 2147483645;
        color: #4ade80;
        font-size: 14px;
        font-weight: 700;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        pointer-events: none;
        animation: ai-gfadein 0.3s ease;
        opacity: 1;
        transition: opacity 0.5s ease 4s;
        background: rgba(22, 101, 52, 0.85);
        border-radius: 4px;
        padding: 2px 6px;
        line-height: 1.3;
      }
      .ai-grammar-ok-ta.fading {
        opacity: 0;
      }
      @media (prefers-color-scheme: light) {
        .ai-grammar-ok {
          color: #16a34a;
        }
        .ai-grammar-ok-ta {
          color: #16a34a;
          background: rgba(220, 252, 231, 0.9);
        }
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

  function isLikelyUserMessage(el) {
    return !!el?.matches?.(USER_MESSAGE_SELECTOR);
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
  // Highlighting
  // -----------------------------------------------------------------------

  /**
   * Wrap each error in a <span class="ai-grammar-error"> with data attributes.
   * Uses Range.surroundContents or manual extraction when surroundContents fails.
   */
  function highlightErrors(container, errors, checkedText = '') {
    if (!errors || errors.length === 0) return 0;

    // Build a flat list of text nodes with their global offsets
    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node, offset = 0;
    while ((node = walker.nextNode())) {
      textNodes.push({ node, start: offset, end: offset + node.textContent.length });
      offset += node.textContent.length;
    }
    if (!textNodes.length) return 0;

    const fullText = textNodes.map(tn => tn.node.textContent).join('');

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

      try {
        range.surroundContents(span);
        highlighted++;
      } catch {
        try {
          const frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
          highlighted++;
        } catch {
          // Skip ranges that cannot be wrapped safely.
        }
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
      removeErrorFloat();
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
  // Clear all inline highlights from the page
  // -----------------------------------------------------------------------

  function clearPostSubmitHighlights() {
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

  document.addEventListener('mouseout', (e) => {
    const fromError = e.target.closest?.(GRAMMAR_CLASSES);
    if (!fromError) return;
    const to = e.relatedTarget;
    if (to?.closest?.('.ai-grammar-tooltip') || to?.closest?.(GRAMMAR_CLASSES)) return;
    hideTooltip();
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
  // Green checkmark — shown at end of checked text when no errors found
  // -----------------------------------------------------------------------

  let greenCheckTimers = new Map();  // container → timer (for cleanup)

  function showGreenCheck(container) {
    if (!container || !document.contains(container)) return;
    removeGreenCheck(container);

    const tag = container.tagName;
    if (tag === 'TEXTAREA' || container.isContentEditable) {
      // Position a fixed check near the top-right of the textarea
      const check = document.createElement('div');
      check.className = 'ai-grammar-ok-ta';
      check.textContent = '✓';
      check.setAttribute('data-ag-ok-for', '');
      const rect = container.getBoundingClientRect();
      check.style.top = (rect.top + 4) + 'px';
      check.style.left = (rect.right - 28) + 'px';
      document.body.appendChild(check);

      // Reposition on scroll/resize
      const reposition = () => {
        if (!document.contains(check)) return;
        const r = container.getBoundingClientRect();
        check.style.top = (r.top + 4) + 'px';
        check.style.left = (r.right - 28) + 'px';
      };
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
      check._agReposition = reposition;

      // Auto-fade + remove after 5s
      const fadeTimer = setTimeout(() => {
        if (document.contains(check)) check.classList.add('fading');
      }, 4500);
      const removeTimer = setTimeout(() => {
        removeGreenCheck(container);
      }, 5500);
      check._agTimers = { fade: fadeTimer, remove: removeTimer };
      greenCheckTimers.set(container, { el: check, timers: [fadeTimer, removeTimer], cleanup: () => {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
      }});
    } else {
      // Inline checkmark at end of text for block-level containers — permanent
      const check = document.createElement('span');
      check.className = 'ai-grammar-ok';
      check.textContent = '✓';
      container.appendChild(check);
      greenCheckTimers.set(container, { el: check, timers: [] });
    }
  }

  function removeGreenCheck(container) {
    if (container && greenCheckTimers.has(container)) {
      const entry = greenCheckTimers.get(container);
      entry.timers.forEach(clearTimeout);
      if (entry.cleanup) entry.cleanup();
      if (entry.el && document.contains(entry.el)) entry.el.remove();
      greenCheckTimers.delete(container);
    }
  }

  function removeAllGreenChecks() {
    for (const [container] of greenCheckTimers) {
      removeGreenCheck(container);
    }
  }

  /** Only clear green checks on editable elements (textareas, contentEditable).
   *  Leaves post-submit paragraph checks untouched — those auto-dismiss. */
  function removeEditableGreenChecks() {
    for (const [container] of greenCheckTimers) {
      if (container.tagName === 'TEXTAREA' || container.isContentEditable) {
        removeGreenCheck(container);
      }
    }
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
    removeErrorFloat();
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
    const textColor = window.getComputedStyle(textarea).color || '#e2e8f0';
    const rect = textarea.getBoundingClientRect();

    // Create overlay — positioned exactly over the textarea
    const overlay = document.createElement('div');
    liveHighlightEl = overlay;
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
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer" data-correction="${escapeHtml(err.correction||'')}" data-explanation="${escapeHtml(err.explanation||'')}" data-error="${escapeHtml(err.error||'')}" data-type="${err.type||'error'}" tabindex="0">${escapeHtml(text.slice(s, e))}</span>`;
      pos = e;
    }
    html += escapeHtml(text.slice(pos));
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    // Hide textarea text so overlay shows through
    liveHighlightRestore = { color: textarea.style.color || '', caretColor: textarea.style.caretColor || '' };
    textarea.style.color = 'transparent';
    textarea.style.caretColor = textColor;

    // Sync scroll
    liveHighlightScrollHandler = () => { overlay.scrollTop = textarea.scrollTop; overlay.scrollLeft = textarea.scrollLeft; };
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
    textarea.addEventListener('scroll', liveHighlightScrollHandler);

    // Reposition on resize/scroll
    liveHighlightReposition = () => {
      if (!liveHighlightEl || !document.contains(textarea)) return;
      const r = textarea.getBoundingClientRect();
      liveHighlightEl.style.top = r.top + 'px';
      liveHighlightEl.style.left = r.left + 'px';
      liveHighlightEl.style.width = r.width + 'px';
      liveHighlightEl.style.height = r.height + 'px';
    };
    window.addEventListener('resize', liveHighlightReposition);
    window.addEventListener('scroll', liveHighlightReposition, true);

    liveHighlightTarget = textarea;
  }

  function clearLiveDraftHighlights() {
    if (liveHighlightEl) {
      if (liveHighlightScrollHandler) {
        liveHighlightTarget?.removeEventListener('scroll', liveHighlightScrollHandler);
        liveHighlightScrollHandler = null;
      }
      if (liveHighlightReposition) {
        window.removeEventListener('resize', liveHighlightReposition);
        window.removeEventListener('scroll', liveHighlightReposition, true);
        liveHighlightReposition = null;
      }
      liveHighlightEl.remove();
      liveHighlightEl = null;
    }
    if (liveHighlightTarget && liveHighlightRestore) {
      liveHighlightTarget.style.color = liveHighlightRestore.color;
      liveHighlightTarget.style.caretColor = liveHighlightRestore.caretColor;
      liveHighlightRestore = null;
    }
    liveHighlightTarget = null;
  }

  // -----------------------------------------------------------------------
  // Live draft checking (checks text as you type after configurable pause)
  // -----------------------------------------------------------------------

  function setupLiveDraftCheck() {
    let lastInputTime = 0;
    let liveCheckTarget = null;
    let liveDelay = 5000;       // ms, read from storage

    // Expose cancel so ?/fix can abort pending live checks
    cancelLiveDraft = () => {
      liveCheckTarget = null;
      removeErrorFloat();
    };

    // Load settings from storage
    safeGetStorage({
      grammarLiveDelay: 5,
      grammarLiveMinChars: 30,
    }).then(s => {
      liveDelay = (s.grammarLiveDelay || 5) * 1000;
      minChars = s.grammarLiveMinChars || 30;
    });

    // Also listen for storage changes to update live
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.grammarLiveDelay) {
          liveDelay = (changes.grammarLiveDelay.newValue || 5) * 1000;
        }
        if (changes.grammarLiveMinChars) {
          minChars = changes.grammarLiveMinChars.newValue || 30;
        }
      });
    } catch {
      // Extension context invalidated — events won't fire, use defaults
    }

    // Poll every 500ms to check if delay has elapsed since last input
    setInterval(() => {
      // Clear highlights if textarea was cleared externally (no input event)
      if (liveCheckTarget && document.contains(liveCheckTarget)) {
        const val = (liveCheckTarget.value || liveCheckTarget.textContent || '').trim();
        if (!val) {
          removeErrorFloat();
          liveCheckTarget = null;
        }
      }

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
        // Create fresh controller, abort any previous in-flight check
        activeCheckController?.abort();
        activeCheckController = new AbortController();

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
          signal: activeCheckController.signal,
        });
        const data = await resp.json();
        removeBadge();
        if (!resp.ok) {
          showBadge('Grammar check failed: ' + (data?.detail || resp.status), false, 5000);
          return;
        }
        if (data?.errors?.length > 0) {
          highlightLiveDraft(ta, data.errors);
        } else {
          showGreenCheck(ta);
        }
      } catch (err) {
        console.debug('[AI Grammar] Live check error:', err);
      }
    }

    document.addEventListener('input', (e) => {
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable) return;

      // Clear live draft highlights and abort in-flight checks
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
      activeCheckController?.abort();
      if (!commandInFlight) removeBadge();

      // Skip placeholder-only text or empty value — and clear highlights
      const raw = ta.value || ta.textContent || '';
      if (!raw || raw === ta.placeholder) {
        liveCheckTarget = null;
        return;
      }
      const text = raw.trim();
      if (text.length < minChars) return;

      if (skipLiveCheck) return;   // fix/polish dispatched this input — don't re-schedule
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
      removeErrorFloat();
      removeEditableGreenChecks();
    }, true);

    document.addEventListener('submit', () => {
      liveCheckTarget = null;
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
    }, true);
  }

  // -----------------------------------------------------------------------
  // Check pipeline (post-submit grammar checking)
  // -----------------------------------------------------------------------

  async function checkText(text, container) {
    const id = ++checkIdCounter;
    removeGreenCheck(container);
    showBadge('Checking grammar...', true);

    // Create fresh controller, abort any previous in-flight check
    activeCheckController?.abort();
    activeCheckController = new AbortController();

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
        signal: activeCheckController.signal,
      });
      const data = await resp.json();

      removeBadge();

      if (!resp.ok) {
        showBadge('Grammar check failed: ' + (data?.detail || resp.status), false, 5000);
        return;
      }

      if (!data?.errors) return;
      const errors = data.errors;
      if (errors.length === 0) {
        showGreenCheck(container);
        return;
      }

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
    let matchedByText = false;
    for (const block of newBlocks) {
      const text = getTextContent(block);
      if (text.length >= minChars && (isLikelyUserMessage(block) || isUserText(text))) {
        pendingChecks.set(block, text);
        checkedElements.add(block);
        block.setAttribute(CHECKED_ATTR, '');
        if (isUserText(text)) matchedByText = true;
      }
    }

    // Clear stored user text only when we actually matched by content
    // (isLikelyUserMessage matches on CSS only, which can fire on quick replies)
    if (pendingChecks.size > 0 && matchedByText) {
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
      if (!document.contains(container)) continue;
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
        commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const fixController = new AbortController();
          const timeoutId = setTimeout(() => fixController.abort(), 30000);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
            signal: fixController.signal,
          });
          clearTimeout(timeoutId);
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
          skipLiveCheck = true;
          if (ta.tagName === 'TEXTAREA') {
            ta.value = fixed;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            ta.textContent = fixed;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          skipLiveCheck = false;
          // Cancel pending live draft check — text is already corrected
          cancelLiveDraft?.();
          activeCheckController?.abort();
          ta.focus();
          showBadge(`✓ Fixed ${sorted.length} issue${sorted.length > 1 ? 's' : ''}`);
        } catch (e) {
          removeBadge();
          let reason;
          if (e.name === 'AbortError') {
            reason = 'Request timed out or was cancelled';
          } else if (e.message?.includes('Extension context invalidated')) {
            reason = 'Extension reloaded — please reload this page';
          } else {
            reason = e.message;
          }
          showBadge(`Fix failed: ${reason}`);
        } finally {
          commandInFlight = false;
        }
      },
    },
    polish: {
      help: 'Polish the text you typed (everything before ?/polish)',
      async run(_args, ta) {
        const value = ta.value || ta.textContent || '';
        const cmdIdx = value.lastIndexOf('?/polish');
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < minChars) {
          showBadge('No text to polish (need at least ' + minChars + ' characters)');
          return;
        }
        showBadge('Polishing...', true);
        commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const polishController = new AbortController();
          const timeoutId = setTimeout(() => polishController.abort(), 60000);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/polish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
            signal: polishController.signal,
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removeBadge();
          if (!resp.ok) {
            showBadge(`Polish failed: ${data?.detail || resp.status}`, false, 5000);
            return;
          }
          const polished = data.polished;
          if (!polished || polished === draft) {
            showBadge('✓ Text already polished');
            return;
          }
          // Replace textarea content with polished text
          skipLiveCheck = true;
          if (ta.tagName === 'TEXTAREA') {
            ta.value = polished;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            ta.textContent = polished;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          skipLiveCheck = false;
          // Cancel pending live draft check — text is already polished
          cancelLiveDraft?.();
          activeCheckController?.abort();
          ta.focus();
          showBadge('✓ Polished');
        } catch (e) {
          removeBadge();
          let reason;
          if (e.name === 'AbortError') {
            reason = 'Request timed out or was cancelled';
          } else if (e.message?.includes('Extension context invalidated')) {
            reason = 'Extension reloaded — please reload this page';
          } else {
            reason = e.message;
          }
          showBadge(`Polish failed: ${reason}`);
        } finally {
          commandInFlight = false;
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
      if ((cmdName === 'fix' || cmdName === 'polish') && ta) {
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
        commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const fixController = new AbortController();
          const timeoutId = setTimeout(() => fixController.abort(), 30000);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
            signal: fixController.signal,
          });
          clearTimeout(timeoutId);
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
          let reason;
          if (e.name === 'AbortError') {
            reason = 'Request timed out or was cancelled';
          } else if (e.message?.includes('Extension context invalidated')) {
            reason = 'Extension reloaded — please reload this page';
          } else {
            reason = e.message;
          }
          showBadge(`Fix failed: ${reason}`);
        } finally {
          commandInFlight = false;
        }
      } else if (cmdName === 'polish') {
        // Called from submit handler — extract text before ?/polish and polish
        const cmdIdx = text.lastIndexOf('?/polish');
        const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
        if (!draft || draft.length < minChars) {
          showBadge('No text to polish (need at least ' + minChars + ' characters)');
          return true;
        }
        showBadge('Polishing...', true);
        commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: '127.0.0.1',
            grammarPort: 8766,
          });
          const polishController = new AbortController();
          const timeoutId = setTimeout(() => polishController.abort(), 60000);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/polish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: draft, language: 'auto' }),
            signal: polishController.signal,
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removeBadge();
          if (!resp.ok) {
            showBadge(`Polish failed: ${data?.detail || resp.status}`, false, 5000);
            return true;
          }
          const polished = data.polished;
          if (!polished || polished === draft) {
            showBadge('✓ Text already polished');
            return true;
          }
          showBadge(`Polished: "${polished.slice(0, 80)}${polished.length > 80 ? '...' : ''}"`, false, 10000);
        } catch (e) {
          removeBadge();
          let reason;
          if (e.name === 'AbortError') {
            reason = 'Request timed out or was cancelled';
          } else if (e.message?.includes('Extension context invalidated')) {
            reason = 'Extension reloaded — please reload this page';
          } else {
            reason = e.message;
          }
          showBadge(`Polish failed: ${reason}`);
        } finally {
          commandInFlight = false;
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

  function showCommandPalette(ta, filter = '') {
    hideCommandPalette();
    paletteTarget = ta;
    paletteSelectedIdx = 0;

    let items = buildPaletteCommands();
    if (filter) {
      items = items.filter(item => item.name.startsWith(filter));
      if (items.length === 0) return;  // no match, don't show
    }
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
        @media (prefers-color-scheme: light) {
          #ai-grammar-palette {
            background: #ffffff;
            color: #0f172a;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
          }
          #ai-grammar-palette .agp-item { border-bottom-color: #f1f5f9; }
          #ai-grammar-palette .agp-item.active { background: #f1f5f9; }
          #ai-grammar-palette .agp-item:hover { background: #f1f5f9; }
          #ai-grammar-palette .agp-cmd { color: #16a34a; }
          #ai-grammar-palette .agp-help { color: #64748b; }
        }
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
      clearTimeout(commandDebounce);
      commandDebounce = null;
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
      clearTimeout(commandDebounce);
      commandDebounce = null;
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
      clearTimeout(commandDebounce);
      commandDebounce = null;
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

        if (!COMMANDS[cmdName]) {
          // Partial prefix — check if it uniquely matches one command
          const matches = buildPaletteCommands().filter(item => item.name.startsWith(cmdName));
          if (matches.length === 1) {
            // Single match — auto-execute (e.g., ?/pol → ?/polish)
            hideCommandPalette();
            const matched = matches[0];
            commandDebounce = setTimeout(async () => {
              const currentValue = ta.value || ta.textContent || '';
              const fullCmd = matched.full;  // e.g., "?/polish"
              if (!currentValue.includes(cmdText)) return;
              try {
                if (matched.name === 'fix' || matched.name === 'polish') {
                  await COMMANDS[matched.name].run('', ta);
                } else {
                  await COMMANDS[matched.name].run('');
                }
              } catch (err) {
                showBadge(`Command failed: ${err.message}`);
              }
              // Replace the partial prefix with the full command in text (so user sees it resolved)
              // and strip command afterward (skip for fix/polish — they replace content)
              if (matched.name !== 'fix' && matched.name !== 'polish') {
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
          // Multiple matches — show filtered palette (e.g., "?/o" → only ?/off, ?/on)
          showCommandPalette(ta, cmdName);
          return;
        }

        commandDebounce = setTimeout(async () => {
          const currentValue = ta.value || ta.textContent || '';
          if (!currentValue.includes(cmdText)) return;

          try {
            if (cmdName === 'fix' || cmdName === 'polish') {
              await COMMANDS[cmdName].run(cmdArgs, ta);
            } else {
              await COMMANDS[cmdName].run(cmdArgs);
            }
          } catch (err) {
            showBadge(`Command failed: ${err.message}`);
          }

          // Strip the command portion, keep text before it
          // Skip for 'fix' and 'polish' — they already replaced the textarea content
          if (cmdName !== 'fix' && cmdName !== 'polish') {
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
