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
  const IGNORE_CLASSES = ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom', 'ai-grammar-tooltip', 'ai-grammar-badge', 'ai-grammar-ok', 'ag-message-overlay', 'ag-live-error'];
  const CHECKED_ATTR = 'data-ai-grammar-checked';
  const isWhatsApp = window.location.hostname === 'web.whatsapp.com';

  // Persistent port to background — keeps the service worker alive so
  // apply-fix messages are delivered even after the 30s idle timeout.
  let fixPort = null;
  try {
    fixPort = chrome.runtime.connect({ name: 'grammar-fix' });
    fixPort.onDisconnect.addListener(() => {
      // Reconnect on disconnect (worker restarted)
      setTimeout(() => {
        try { fixPort = chrome.runtime.connect({ name: 'grammar-fix' }); } catch {}
      }, 1000);
    });
  } catch {}

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let checkIdCounter = 0;
  let pendingChecks = new Map();       // id → { container, text }
  let checkedElements = new WeakSet(); // elements already checked
  let debounceTimer = null;
  let isHighlighting = false;
  let tooltipEl = null;
  let tooltipTimeout = null;
  let currentErrorEl = null;
  const LIVE_HIGHLIGHT_CLASS = 'ag-live-highlight';
  let liveHighlightEl = null;
  let liveHighlightTarget = null;
  let liveHighlightRestore = null;
  let liveHighlightScrollHandler = null;
  let liveHighlightMouseMoveHandler = null;
  let liveHighlightMouseLeaveHandler = null;
  let liveHighlightReposition = null;
  let liveHighlightAnimationFrame = null;

  // Overlay-based post-submit highlights (survives React re-renders on
  // WhatsApp Web, Teams, etc. — DOM injection gets stripped by vdom reconcilation)
  const messageOverlays = new Map(); // container → { overlay, cleanup }

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

  // Proximity-based message container tracking (v1.3.10+).
  // At submit time we walk up from the textarea to find the chat's
  // message-list container.  The MutationObserver then checks structural
  // proximity (block inside that container) before falling back to CSS
  // selectors or text matching.  60s TTL is safe because checks are
  // scoped to one container — false positives are structurally impossible.
  const SUBMISSION_TTL_MS = 60000;
  let pendingSubmission = null;        // { text, messageList, time }

  const USER_MESSAGE_SELECTOR = [
    '.user-msg',
    '.user-message',
    '.message.user',
    '[data-testid*="user"]',
    '[class*="user"][class*="msg"]',
    '[class*="user"][class*="message"]',
    // WhatsApp Web outgoing messages
    '.message-out',
    '[data-pre-plain-text]',
    // Microsoft Teams self/sent messages
    '[class*="self"]',
    '[class*="outgoing"]',
    '[class*="sent"]',
    '[data-tid*="self"]',
  ].join(', ');

  // -----------------------------------------------------------------------
  // CSS injection
  // -----------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('ai-grammar-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-grammar-styles';
    style.textContent = `
      /* text-decoration wavy underlines — positioned by the browser from
         the real mirrored text baseline, independent of platform font/line-height.  The
         old SVG background-image approach required manual offsets that
         varied by platform (iMessage vs Hermes WebUI vs test page).
         Overlay spans use rgba(0,0,0,0.02) to defeat Chromium's
         text-decoration paint skip: 0.02 * 255 = 5.1 → never quantises
         to 0 at any zoom/DPI combo (0.01 could floor to 0 at extreme
         subpixel configurations).  text-decoration-skip-ink: none
         prevents the browser from omitting decorations that intersect
         glyph descenders, so the underline needs extra offset to clear
         descenders like g/y/p. */
      .ai-grammar-error {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #dc2626 !important;
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0.12em;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
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
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0.12em;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
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
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0.12em;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
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
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
        scrollbar-width: none;
      }
      .ag-live-highlight-backdrop::-webkit-scrollbar {
        display: none;
      }
      .ag-live-highlight-backdrop .ai-grammar-error,
      .ag-live-highlight-backdrop .ai-grammar-improvement,
      .ag-live-highlight-backdrop .ai-grammar-idiom {
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
        text-underline-offset: 0.45em;
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
        background: rgba(22, 101, 52, 0.85);
        border-radius: 4px;
        padding: 2px 6px;
        line-height: 1.3;
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
      .ag-message-overlay {
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
      }
      .ag-message-overlay .ai-grammar-error,
      .ag-message-overlay .ai-grammar-improvement,
      .ag-message-overlay .ai-grammar-idiom {
        text-underline-offset: 0.45em;
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
    // Only skip elements that have contentEditable directly set (not inherited).
    // Descendants of contentEditable must pass through so live-draft highlighting
    // can find text nodes inside the input.
    if (el.contentEditable === 'true') return true;
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

  /**
   * Strip trailing timestamps / metadata that chat platforms append to
   * message text (WhatsApp: "11:39", "11:39 PM").  The AI sees this as
   * part of the sentence and returns wrong offsets or nonsensical errors
   * (e.g. flagging the period between "apple." and "11:39").
   */
  function cleanMessageText(raw) {
    // Strip trailing time pattern: "11:39", "11:39 PM", "11:39 AM"
    return raw.replace(/[\s.]*\d{1,2}:\d{2}(\s*[APap][Mm])?\s*$/, '').trim();
  }

  function normalizeWhatsAppTextWithMap(raw) {
    const text = raw || '';
    let normalized = '';
    const normalizedToRaw = [];

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      // Drop bidi/zero-width markers and variation selectors WhatsApp can
      // place in message text. Keep a map so backend offsets still locate
      // the corresponding visible overlay characters.
      if (
        code === 0x00ad ||
        code === 0x034f ||
        code === 0x061c ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2060 && code <= 0x206f) ||
        (code >= 0xfe00 && code <= 0xfe0f) ||
        code === 0xfeff
      ) {
        continue;
      }

      normalizedToRaw.push(i);
      normalized += text[i];
    }

    normalized = normalized.replace(/\u00a0/g, ' ');
    const first = normalized.search(/\S/);
    if (first === -1) return { text: '', normalizedToRaw: [] };
    const lastMatch = normalized.match(/\S\s*$/);
    const last = lastMatch ? lastMatch.index + 1 : normalized.length;

    return {
      text: normalized.slice(first, last),
      normalizedToRaw: normalizedToRaw.slice(first, last),
    };
  }

  function stripWhatsAppTextArtifacts(raw) {
    return (raw || '')
      .replace(/[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g, '')
      .replace(/\u00a0/g, ' ');
  }

  function getWhatsAppTextElement(container) {
    if (!container?.querySelector) return null;
    const copyable = container.matches?.('.copyable-text')
      ? container
      : container.querySelector('.copyable-text');
    if (!copyable) return null;
    return copyable.querySelector('span.selectable-text') || copyable;
  }

  function getWhatsAppMessageInfo(container) {
    const textEl = getWhatsAppTextElement(container);
    if (!textEl) return { textEl: null, text: '', rawText: '', normalizedToRaw: [] };

    const rawText = textEl.textContent || '';
    const normalized = normalizeWhatsAppTextWithMap(rawText);
    return { textEl, rawText, ...normalized };
  }

  function getWhatsAppMessageText(container) {
    return getWhatsAppMessageInfo(container).text;
  }

  function findWhatsAppMessageContainer(el) {
    let node = el;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node?.closest) return null;
    return node.closest('div.message-out, div.message-in');
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

  /**
   * Overlay-based post-submit highlighting.
   *
   * Instead of injecting <span> elements into the container DOM (which React /
   * Vue re-rendering strips within seconds), create a fixed-position overlay
   * that mirrors the message text with error underlines.  Non-error text is
   * transparent; only the red/green/blue wavy underlines are visible, sitting
   * on top of the real message.
   */
  function highlightOverlay(container, errors, fullText) {
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
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer"
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

    messageOverlays.set(container, { overlay, cleanup });
    return errors.length;
  }

  function highlightWhatsAppOverlay(container, errors, fullText) {
    if (!errors?.length) return 0;

    const waContainer = findWhatsAppMessageContainer(container) || container;
    const info = getWhatsAppMessageInfo(waContainer);
    if (!info.textEl || !info.text) return 0;

    removeMessageOverlay(waContainer);

    const overlayText = fullText || info.text;
    const useRawMap = overlayText === info.text && info.normalizedToRaw.length === info.text.length;

    function visibleSlice(start, end) {
      if (!useRawMap) return overlayText.slice(start, end);
      const rawStart = info.normalizedToRaw[start] ?? info.rawText.length;
      const rawEnd = end >= info.text.length
        ? ((info.normalizedToRaw[info.normalizedToRaw.length - 1] ?? info.rawText.length - 1) + 1)
        : (info.normalizedToRaw[end] ?? info.rawText.length);
      return stripWhatsAppTextArtifacts(info.rawText.slice(rawStart, rawEnd));
    }

    let html = '';
    let pos = 0;
    let rendered = 0;
    const sorted = [...errors].sort((a, b) => Number(a.start) - Number(b.start));

    for (const err of sorted) {
      const s = Math.max(0, Number(err.start));
      const e = Math.min(overlayText.length, Number(err.end));
      if (s < pos || s >= e) continue;

      html += escapeHtml(visibleSlice(pos, s));

      const cls = err.type === 'improvement' ? 'ai-grammar-improvement' :
                  err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer"
          data-correction="${escapeHtml(err.correction || '')}"
          data-explanation="${escapeHtml(err.explanation || '')}"
          data-error="${escapeHtml(err.error || '')}"
          data-type="${err.type || 'error'}" tabindex="0">${escapeHtml(visibleSlice(s, e))}</span>`;
      pos = e;
      rendered++;
    }
    html += escapeHtml(visibleSlice(pos, overlayText.length));

    if (!rendered) return 0;

    const overlay = document.createElement('div');
    overlay.className = 'ag-message-overlay';
    overlay.setAttribute('data-ag-overlay', '');
    overlay.setAttribute('data-ag-whatsapp-overlay', '');
    overlay.innerHTML = html;

    const styleSource = info.textEl.querySelector?.('span[dir]') || info.textEl;
    const cs = window.getComputedStyle(styleSource);
    const dirEl = styleSource.closest?.('[dir]');
    const explicitDir = dirEl?.getAttribute('dir');
    const direction = explicitDir === 'rtl' || explicitDir === 'ltr' ? explicitDir : cs.direction;

    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      zIndex: '2147483644',
      pointerEvents: 'none',
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
      direction,
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
      padding: '0',
      margin: '0',
      boxSizing: 'border-box',
      overflow: 'hidden',
    });

    document.body.appendChild(overlay);

    function reposition() {
      if (!document.contains(waContainer) || !document.contains(info.textEl)) {
        removeMessageOverlay(waContainer);
        return;
      }

      const textRect = info.textEl.getBoundingClientRect();
      overlay.style.transform = `translate(${textRect.left}px, ${textRect.top}px)`;
      overlay.style.width = textRect.width + 'px';
      overlay.style.minHeight = textRect.height + 'px';
    }

    reposition();

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    const poll = setInterval(() => {
      if (!document.contains(waContainer) || !document.contains(info.textEl)) {
        removeMessageOverlay(waContainer);
      }
    }, 2000);

    const cleanup = () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      clearInterval(poll);
      if (document.contains(overlay)) overlay.remove();
    };

    messageOverlays.set(waContainer, { overlay, cleanup });
    return rendered;
  }

  function removeMessageOverlay(container) {
    const entry = messageOverlays.get(container);
    if (entry) {
      entry.cleanup();
      messageOverlays.delete(container);
    }
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

    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }

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

  function tooltipOverlapsTextAbove(errorEl, tooltipRect, errorRect) {
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

  function hideTooltip() {
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
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
      let ta = liveHighlightTarget;
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
      const spans = (liveHighlightEl || document).querySelectorAll(
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
          // WhatsApp Lexical blocks all DOM writes.
          // Try CDP fixer first (keyboard simulation via DevTools Protocol),
          // fall back to clipboard copy if unavailable.
          skipLiveCheck = true;
          applyFixCDP(text).then(success => {
            if (success) {
              clearLiveDraftHighlights();
              hideTooltip();
              showBadge('✓ Fixed!', false, 3000);
            } else {
              // Fallback: copy to clipboard for manual paste
              navigator.clipboard.writeText(text).catch(() => {});
              ta.focus();
              const range = document.createRange();
              range.selectNodeContents(ta);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              showBadge('Copied to clipboard — paste (Ctrl+V) to apply', false, 4000);
            }
            skipLiveCheck = false;
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
  // CDP Fixer integration — automated clear+retype on WhatsApp Lexical
  // -----------------------------------------------------------------------

  function applyFixCDP(text) {
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
      if (tooltipTimeout) clearTimeout(tooltipTimeout);
      tooltipTimeout = setTimeout(() => {
        tooltipTimeout = null;
        showTooltip(errorEl);
      }, 300);
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

  let batchInFlight = 0;  // >0 when ?/check is running multiple checks; badge auto-suppressed

  function showBadge(text, isPending = false, durationMs = 4000) {
    if (batchInFlight > 0) return;  // badge managed by batch orchestrator
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
    if (batchInFlight > 0) return;  // badge managed by batch orchestrator
    const existing = document.querySelector('.ai-grammar-badge');
    if (existing) existing.remove();
  }

  function updateBatchBadge(completed, total) {
    // Only called from ?/check batch orchestrator
    const existing = document.querySelector('.ai-grammar-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.className = 'ai-grammar-badge';
    badge.innerHTML = `<div class="ag-spinner"></div>Checking ${completed}/${total} text blocks...`;
    document.body.appendChild(badge);
  }

  // -----------------------------------------------------------------------
  // Green checkmark — shown at end of checked text when no errors found
  // -----------------------------------------------------------------------

  let greenCheckTimers = new Map();  // container → timer (for cleanup)

  function showGreenCheck(container) {
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
    check.style.top = (isEditable ? rect.top + 4 : rect.bottom - 24) + 'px';
    check.style.left = (rect.right - 28) + 'px';
    document.body.appendChild(check);

    // Reposition on scroll/resize
    const reposition = () => {
      if (!document.contains(check)) return;
      const r = container.getBoundingClientRect();
      check.style.top = (isEditable ? r.top + 4 : r.bottom - 24) + 'px';
      check.style.left = (r.right - 28) + 'px';
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    check._agReposition = reposition;

    // Permanent until explicit cleanup (editable checks are removed on input)
    greenCheckTimers.set(container, { el: check, timers: [], cleanup: () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    }});
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
   *  Leaves post-submit paragraph checks untouched — those are permanent.
   *  Uses .contentEditable === 'true' (not inherited .isContentEditable). */
  function removeEditableGreenChecks() {
    for (const [container] of greenCheckTimers) {
      if (container.tagName === 'TEXTAREA' || container.contentEditable === 'true') {
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
      // WhatsApp's Lexical editor corrupts on DOM-span injection;
      // use the overlay approach only there.  Other contentEditable
      // inputs (test pages, plain sites) get the floating panel which
      // doesn't risk making real text invisible.
      if (isWhatsApp) {
        highlightLiveDraftContentEditable(ta, errors);
      } else {
        showErrorFloat(errors, ta);
      }
    }
  }

  function highlightLiveDraftTextarea(textarea, errors) {
    const text = textarea.value;
    const textColor = window.getComputedStyle(textarea).color || '#e2e8f0';
    const rect = textarea.getBoundingClientRect();

    // Create overlay — positioned exactly over the textarea.
    // Do NOT use ag-live-highlight-backdrop class — its !important
    // color rule overrides the inline opaque text color needed for
    // textareas (where the real text is hidden via transparent).
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
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer" data-correction="${escapeHtml(err.correction||'')}" data-explanation="${escapeHtml(err.explanation||'')}" data-error="${escapeHtml(err.error||'')}" data-type="${err.type||'error'}" data-live-draft="1" data-start="${s}" data-end="${e}" tabindex="0">${escapeHtml(text.slice(s, e))}</span>`;
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
    startLiveHighlightPositionLoop();

    liveHighlightTarget = textarea;
  }

  function highlightLiveDraftContentEditable(ce, errors) {
    const text = ce.textContent || ce.innerText || '';
    const cs = window.getComputedStyle(ce);
    const rect = ce.getBoundingClientRect();

    // Create overlay — positioned exactly over the contentEditable.
    // Do NOT use ag-live-highlight-backdrop CSS class — its !important
    // color rule on error spans blocks Chromium's text-decoration paint.
    // Inline styles only, matching the post-submit highlightOverlay().
    const overlay = document.createElement('div');
    liveHighlightEl = overlay;
    Object.assign(overlay.style, {
      position: 'fixed', top: rect.top + 'px', left: rect.left + 'px',
      width: rect.width + 'px', height: rect.height + 'px',
      pointerEvents: 'none', zIndex: '2147483645',
      font: cs.font, fontSize: cs.fontSize, fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
      fontVariant: cs.fontVariant, fontStretch: cs.fontStretch,
      fontKerning: cs.fontKerning, fontFeatureSettings: cs.fontFeatureSettings,
      fontVariationSettings: cs.fontVariationSettings,
      textRendering: cs.textRendering, textTransform: cs.textTransform,
      direction: cs.direction, lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing,
      textAlign: cs.textAlign, textIndent: cs.textIndent,
      whiteSpace: cs.whiteSpace || 'pre-wrap',
      overflowWrap: cs.overflowWrap || 'break-word',
      wordBreak: cs.wordBreak || 'break-word', wordWrap: cs.wordWrap,
      color: 'rgba(0, 0, 0, 0.02)',
      WebkitTextFillColor: 'rgba(0, 0, 0, 0.02)',
      background: 'transparent', overflow: 'hidden',
      paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0',
      boxSizing: 'content-box',
    });

    let html = '', pos = 0;
    const sorted = [...errors].sort((a, b) => a.start - b.start);
    for (const err of sorted) {
      const s = Math.max(0, Number(err.start)), e = Math.min(text.length, Number(err.end));
      if (s < pos || s >= e) continue;
      html += escapeHtml(text.slice(pos, s));
      const cls = err.type === 'improvement' ? 'ai-grammar-improvement' : err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
      html += '<span class="' + cls + ' ag-live-error" style="pointer-events:auto;cursor:pointer" data-correction="' + escapeHtml(err.correction||'') + '" data-explanation="' + escapeHtml(err.explanation||'') + '" data-error="' + escapeHtml(err.error||'') + '" data-type="' + (err.type||'error') + '" data-live-draft="1" data-start="' + s + '" data-end="' + e + '" tabindex="0">' + escapeHtml(text.slice(s, e)) + '</span>';
      pos = e;
    }
    html += escapeHtml(text.slice(pos));
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    // Replace text-decoration with SVG background-image underlines.
    // text-decoration is unreliable on near-transparent text (Chromium
    // may skip paint even with explicit text-decoration-color).
    // SVG backgrounds render independently of text color.
    const svgRed = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%224%22 viewBox=%220 0 10 4%22%3E%3Cpath d=%22M0,3 Q2.5,0 5,3 Q7.5,6 10,3%22 fill=%22none%22 stroke=%22%23dc2626%22 stroke-width=%221.3%22 stroke-linecap=%22round%22/%3E%3C/svg%3E')";
    const svgGreen = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%224%22 viewBox=%220 0 10 4%22%3E%3Cpath d=%22M0,3 Q2.5,0 5,3 Q7.5,6 10,3%22 fill=%22none%22 stroke=%22%234ade80%22 stroke-width=%221.3%22 stroke-linecap=%22round%22/%3E%3C/svg%3E')";
    const svgBlue = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%224%22 viewBox=%220 0 10 4%22%3E%3Cpath d=%22M0,3 Q2.5,0 5,3 Q7.5,6 10,3%22 fill=%22none%22 stroke=%22%2360a5fa%22 stroke-width=%221.3%22 stroke-linecap=%22round%22/%3E%3C/svg%3E')";
    overlay.querySelectorAll('.ag-live-error').forEach(span => {
      span.style.setProperty('text-decoration-line', 'none', 'important');
      const type = span.getAttribute('data-type') || 'error';
      span.style.backgroundImage = type === 'improvement' ? svgGreen : type === 'idiom' ? svgBlue : svgRed;
      span.style.backgroundRepeat = 'repeat-x';
      span.style.backgroundPositionY = 'bottom 2px';
      span.style.backgroundSize = '10px 5px';
    });

    liveHighlightReposition = () => {
      if (!liveHighlightEl || !document.contains(ce)) return;
      const r = ce.getBoundingClientRect();
      liveHighlightEl.style.top = r.top + 'px';
      liveHighlightEl.style.left = r.left + 'px';
      liveHighlightEl.style.width = r.width + 'px';
      liveHighlightEl.style.height = r.height + 'px';
    };
    window.addEventListener('resize', liveHighlightReposition);
    window.addEventListener('scroll', liveHighlightReposition, true);
    startLiveHighlightPositionLoop();

    liveHighlightTarget = ce;
  }

  function startLiveHighlightPositionLoop() {
    if (liveHighlightAnimationFrame) return;
    const tick = () => {
      liveHighlightAnimationFrame = null;
      if (!liveHighlightEl || !liveHighlightReposition) return;
      liveHighlightReposition();
      liveHighlightAnimationFrame = requestAnimationFrame(tick);
    };
    liveHighlightAnimationFrame = requestAnimationFrame(tick);
  }

  function clearLiveDraftHighlights() {
    if (liveHighlightEl) {
      if (liveHighlightAnimationFrame) {
        cancelAnimationFrame(liveHighlightAnimationFrame);
        liveHighlightAnimationFrame = null;
      }
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

      // Skip if a fix/polish command is in flight — don't clear its overlay.
      if (skipLiveCheck) return;

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
      activeCheckController?.abort();
    }, true);

    document.addEventListener('submit', () => {
      liveCheckTarget = null;
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
      activeCheckController?.abort();
    }, true);
  }

  // -----------------------------------------------------------------------
  // Check pipeline (post-submit grammar checking)
  // -----------------------------------------------------------------------

  async function checkText(text, container) {
    if (isWhatsApp) {
      const waContainer = findWhatsAppMessageContainer(container) || container;
      const waText = getWhatsAppMessageText(waContainer);
      if (waContainer && waText) {
        container = waContainer;
        text = waText;
      }
    }

    const id = ++checkIdCounter;
    removeGreenCheck(container);
    showBadge('Checking grammar...', true);

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

      // Use overlay-based highlighting — survives React/Vue re-renders
      // (DOM injection via highlightErrors gets stripped on WhatsApp, Teams, etc.)
      isHighlighting = true;
      const count = isWhatsApp
        ? highlightWhatsAppOverlay(container, errors, text)
        : highlightOverlay(container, errors, text);
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
      if (e.name !== 'AbortError') {
        console.debug('[AI Grammar] Check error:', e);
      }
    }
  }

  // -----------------------------------------------------------------------
  // MutationObserver — detect newly submitted text
  // -----------------------------------------------------------------------

  const observer = new MutationObserver((mutations) => {
    if (isHighlighting) return; // Ignore our own DOM changes

    // Expire stale pendingSubmission
    if (pendingSubmission && Date.now() - pendingSubmission.time > SUBMISSION_TTL_MS) {
      pendingSubmission = null;
    }

    const newBlocks = findNewTextBlocks(mutations);
    if (newBlocks.length === 0) return;

    // Add to pending and debounce — only user-authored content.
    // Priority chain: structural proximity > CSS selector > text matching.
    let matchedByText = false;
    for (const block of newBlocks) {
      const text = cleanMessageText(getTextContent(block));
      if (text.length < minChars) continue;

      let matched = false;

      // 1) STRUCTURAL PROXIMITY (most reliable — v1.3.10+)
      if (pendingSubmission && pendingSubmission.messageList &&
          pendingSubmission.messageList.contains(block)) {
        matched = true;
      }

      // 2) CSS SELECTOR (platform-specific fallback)
      if (!matched && isLikelyUserMessage(block)) {
        matched = true;
      }

      // 3) TEXT MATCHING (last resort — TTL-limited)
      if (!matched && isUserText(text)) {
        matched = true;
        matchedByText = true;
      }

      if (matched) {
        pendingChecks.set(block, text);
        checkedElements.add(block);
        block.setAttribute(CHECKED_ATTR, '');
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

    // Clear pendingSubmission after consuming matched blocks.
    // This prevents AI replies in the same container from matching
    // on subsequent mutation batches (they'd appear without .user-msg
    // CSS class and with different text, but proximity alone would
    // match them if we left the submission open).
    pendingSubmission = null;

    for (const [container, text] of entries) {
      if (!document.contains(container)) continue;
      checkText(text, container);
    }
  }

  // -----------------------------------------------------------------------
  // Manual selection check (keyboard shortcut)
  // -----------------------------------------------------------------------

  function receiveSelectionCheckMessage(message, _sender, sendResponse) {
    if (message?.type === 'grammar:check-selection') {
      handleSelectionCheck();
      sendResponse?.({ ok: true });
      return false;
    }
  }

  try {
    chrome.runtime.onMessage.addListener(receiveSelectionCheckMessage);
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) {
      contextInvalidated = true;
    } else {
      console.debug('[AI Grammar] Failed to register selection listener:', e);
    }
  }

  window.addEventListener('grammar:check-selection', () => {
    handleSelectionCheck();
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

    if (isWhatsApp) {
      const waContainer = findWhatsAppMessageContainer(range.commonAncestorContainer);
      if (waContainer) {
        const waText = getWhatsAppMessageText(waContainer);
        if (waText.length >= minChars) {
          checkText(waText, waContainer);
          return;
        }
        // If WhatsApp's current DOM no longer exposes the expected message
        // classes/text spans, fall through to the generic selected-text path.
        // Returning here makes the shortcut appear broken.
      }
    }

    // Find the nearest block-level ancestor to use as container
    let container = range.commonAncestorContainer;
    while (container && container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    if (!container) {
      if (isWhatsApp) {
        checkText(text, document.body);
        return;
      }
      return;
    }

    // Walk up past inline elements to the nearest block-level container.
    // The old text-length heuristic (getTextContent(el).length < text.length * 1.2)
    // overshot to document.body for short selections because no ancestor has
    // enough text — producing overlays at full viewport width with left-aligned
    // text, while the actual text sits in a right-aligned message bubble.
    let el = container;
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display;
      if (display !== 'inline' && display !== 'contents') break;
      el = el.parentElement;
    }
    container = el || container;

    // --- Walk up further to find the message-level container ---
    // The block-level element found above (e.g. <p>, inner <div>) may not
    // be the actual message-bubble container.  highlightOverlay() positions
    // the fixed overlay at container.getBoundingClientRect() and copies
    // getComputedStyle(container) — if the wrong element is used, underlines
    // appear offset from the visible text.
    let found = null;

    // 1. Try USER_MESSAGE_SELECTOR on current element and ancestors
    let candidate = container;
    while (candidate && candidate !== document.body && candidate !== document.documentElement) {
      if (candidate.nodeType === Node.ELEMENT_NODE && candidate.matches(USER_MESSAGE_SELECTOR)) {
        found = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }

    // 2. If no selector match, look for ancestors that are direct children
    //    of a message-list / chat container (role=list/log/feed, or class
    //    containing msg/message/chat/conversation).  Also accept ancestors
    //    whose own class name suggests a message bubble.
    if (!found) {
      candidate = container.parentElement;
      while (candidate && candidate !== document.body && candidate !== document.documentElement) {
        const parent = candidate.parentElement;
        if (parent && parent !== document.body && parent !== document.documentElement) {
          const parentCls = (parent.className || '').toLowerCase();
          const parentId = (parent.id || '').toLowerCase();
          const role = parent.getAttribute('role');
          if (parentCls.includes('msg') || parentCls.includes('message') ||
              parentCls.includes('chat') || parentCls.includes('conversation') ||
              parentId.includes('msg') || parentId.includes('message') ||
              parentId.includes('chat') || parentId.includes('conversation') ||
              role === 'list' || role === 'log' || role === 'feed') {
            found = candidate;
            break;
          }
        }
        // Also accept candidate if its own class looks message-like
        const cls = (candidate.className || '').toLowerCase();
        if (cls.includes('msg') || cls.includes('message') || cls.includes('bubble') ||
            cls.includes('row') || cls.includes('item')) {
          found = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
    }

    if (found) container = found;
    // 3. Fallback: use the existing block-level container (already set above)

    checkText(text, container);
  }

  // -----------------------------------------------------------------------
  // Command system (?/ prefix)
  // -----------------------------------------------------------------------

  const COMMAND_PREFIX = '?/';
  const COMMANDS = {
    off: {
      help: 'Disable grammar checking',
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: false });
        showBadge('Grammar checker disabled');
      },
    },
    on: {
      help: 'Enable grammar checking',
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: true });
        showBadge('Grammar checker enabled');
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
          } else if (isWhatsApp) {
            // WhatsApp Lexical blocks direct DOM writes — use CDP keyboard simulation
            applyFixCDP(fixed).then(success => {
              if (success) {
                showBadge(`✓ Fixed ${sorted.length} issue${sorted.length > 1 ? 's' : ''}`, false, 3000);
              } else {
                // Fallback: copy to clipboard
                navigator.clipboard.writeText(fixed).catch(() => {});
                showBadge(`Copied fixed text to clipboard — paste (Ctrl+V) to apply`, false, 4000);
              }
              skipLiveCheck = false;
            });
            cancelLiveDraft?.();
            activeCheckController?.abort();
            return;  // badge handled above
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
          } else if (isWhatsApp) {
            // WhatsApp Lexical blocks direct DOM writes — use CDP keyboard simulation
            applyFixCDP(polished).then(success => {
              if (success) {
                showBadge('✓ Polished', false, 3000);
              } else {
                // Fallback: copy to clipboard
                navigator.clipboard.writeText(polished).catch(() => {});
                showBadge('Copied polished text to clipboard — paste (Ctrl+V) to apply', false, 4000);
              }
              skipLiveCheck = false;
            });
            cancelLiveDraft?.();
            activeCheckController?.abort();
            return;  // badge handled above
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

    // Auto-check on submit is disabled — grammar checks are now
    // manual-only via keyboard shortcut (Ctrl+Shift+L) on selected text.
    // The MutationObserver is intentionally not started.

    // --- Track user-submitted text so we only check the user's content ---
    // Helper: process captured text — handle commands, otherwise store for matching
    async function processCapturedText(captured, textarea) {
      if (!captured || captured.length < minChars) return;
      // Check for ?/ prefix commands at the end
      if (/\?\/\w+(\s+\S+)?$/.test(captured)) {
        await handleCommand(captured);
        return;
      }
      lastUserText = captured;
      lastUserTextTime = Date.now();

      // Capture the message-list container via structural proximity.
      // This lets the MutationObserver match the user's message by
      // container membership instead of fragile text/CSS heuristics.
      if (textarea && document.contains(textarea)) {
        const messageList = findMessageList(textarea);
        if (messageList) {
          pendingSubmission = { text: captured, messageList, time: Date.now() };
        }
      }
    }

    function getTextFromControls(scope) {
      if (!scope?.querySelectorAll) return '';
      // Check contentEditable divs first (WhatsApp Web, Teams, etc.)
      const editables = scope.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"]');
      for (const ed of editables) {
        const captured = (ed.textContent || '').trim();
        if (captured) return captured;
      }
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

    /**
     * Walk up from the textarea to find the chat's message-list container.
     * Strategy: find an ancestor whose children include 2+ elements with the
     * same tag name — the hallmark of a chat message list (repeated message
     * blocks).  Falls back to the great-grandparent of the input.
     */
    function findMessageList(textarea) {
      if (!textarea || !document.contains(textarea)) return null;

      let el = textarea.parentElement;
      let depth = 0;
      const MAX_DEPTH = 12;

      while (el && el !== document.body && depth < MAX_DEPTH) {
        const children = Array.from(el.children);
        if (children.length >= 2) {
          // Count how many children share each tag name
          const tagCounts = {};
          for (const child of children) {
            const tag = child.tagName;
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
          // Repeated tag → this looks like a list (messages, posts, etc.)
          if (Object.values(tagCounts).some(c => c >= 2)) {
            return el;
          }
        }
        el = el.parentElement;
        depth++;
      }

      // Fallback: input → toolbar → form → main-message-area (common pattern)
      return textarea.parentElement?.parentElement?.parentElement || null;
    }

    // Capture text when the user submits a form (e.g., chat send)
    document.addEventListener('submit', (e) => {
      const form = e.target;
      const textareas = form.querySelectorAll('textarea');
      const inputs = form.querySelectorAll('input[type="text"]');
      const editables = form.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"]');
      let captured = '';
      let ta = null;
      for (const t of textareas) {
        captured = t.value.trim();
        if (captured) { ta = t; break; }
      }
      if (!captured) {
        for (const inp of inputs) {
          captured = inp.value.trim();
          if (captured) { ta = inp; break; }
        }
      }
      if (!captured) {
        for (const ed of editables) {
          captured = (ed.textContent || '').trim();
          if (captured) { ta = ed; break; }
        }
      }
      clearTimeout(commandDebounce);
      commandDebounce = null;
      processCapturedText(captured, ta);
    }, true);

    // Capture on mousedown BEFORE the platform clears the input
    // (WhatsApp Web clears contentEditable on mousedown, so by the time
    // 'click' fires the text is gone)
    document.addEventListener('mousedown', (e) => {
      const control = e.target.closest?.('button, input[type="button"], input[type="submit"], [role="button"]');
      if (!control) return;
      const ariaLabel = (control.getAttribute?.('aria-label') || '').toLowerCase();
      const testId = (control.getAttribute?.('data-testid') || '').toLowerCase();
      const label = (control.innerText || control.value || ariaLabel || '').trim().toLowerCase();
      const looksLikeSend = /^(send|submit|post|reply|comment)$/.test(label) ||
                            control.type === 'submit' ||
                            testId.includes('send');
      if (!looksLikeSend) return;

      // Grab text from the contentEditable input before the platform clears it
      const active = document.activeElement;
      if (active?.tagName === 'TEXTAREA' || active?.isContentEditable) {
        const captured = (active.value || active.textContent || '').trim();
        if (captured) {
          clearTimeout(commandDebounce);
          commandDebounce = null;
          processCapturedText(captured, active);
        }
      }
    }, true);

    document.addEventListener('click', (e) => {
      // Standard button elements
      let control = e.target.closest?.('button, input[type="button"], input[type="submit"]');

      // WhatsApp Web / Teams send buttons are often <span>/<div> with
      // aria-label="Send" or data-testid containing "send"
      if (!control) {
        const candidate = e.target.closest?.('[role="button"]') || e.target;
        const ariaLabel = (candidate.getAttribute?.('aria-label') || '').toLowerCase();
        const testId = (candidate.getAttribute?.('data-testid') || '').toLowerCase();
        if (/^(send|submit)$/.test(ariaLabel) || testId.includes('send')) {
          control = candidate;
        }
      }
      if (!control) return;

      const label = (control.innerText || control.value || control.getAttribute('aria-label') || '').trim().toLowerCase();
      const looksLikeSend = /^(send|submit|post|reply|comment)$/.test(label) ||
                            control.type === 'submit' ||
                            control.getAttribute('data-testid')?.toLowerCase().includes('send');
      if (!looksLikeSend) return;

      const form = control.closest('form');
      const scope = form || control.closest('.input-row, [role="form"], [role="textbox"][contenteditable="true"], [contenteditable="true"]') || control.parentElement;
      let captured = getTextFromControls(scope);
      let active = document.activeElement;
      if (!captured) {
        if (active?.tagName === 'TEXTAREA' || active?.isContentEditable) {
          captured = (active.value || active.textContent || '').trim();
        }
      }
      // active may be the button (not the textarea) — search scope for the input element
      let ta = active;
      if (!ta || (ta.tagName !== 'TEXTAREA' && !ta.isContentEditable)) {
        // Try to find the textarea in scope
        const t = scope?.querySelector?.('textarea, [role="textbox"][contenteditable="true"], [contenteditable="true"]');
        if (t) ta = t;
      }
      clearTimeout(commandDebounce);
      commandDebounce = null;
      processCapturedText(captured, ta);
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

      // Prevent WhatsApp/chat platforms from sending when a ?/fix or ?/polish
      // command is pending — the Enter triggers our handler, not the platform's send.
      if (/\?\/\b(fix|polish)\b/.test(text)) {
        e.preventDefault();
        e.stopPropagation();
      }

      processCapturedText(text, ta);
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
