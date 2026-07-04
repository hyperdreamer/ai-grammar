// =============================================================================
// whatsapp-bridge.js — WhatsApp Web support module for AI Grammar Checker
// =============================================================================
//
// Self-contained content script loaded on WhatsApp Web only.  Handles
// WhatsApp-specific text normalisation (bidi markers, variation selectors,
// timestamps), message-container detection, overlay-based error highlighting,
// and chat-switch detection for SPA navigation.
//
// Does NOT import from content.js.  Exposes a clean API on window.__aiWhatsApp
// so the shared content script can delegate WhatsApp-specific logic without
// knowing WhatsApp's DOM internals.
//
// Uses Trusted-Types-safe DOM APIs throughout.
// =============================================================================

(function () {
  'use strict';

  // ── Guard: only run on WhatsApp Web ────────────────────────────────────
  const isWhatsApp = window.location.hostname === 'web.whatsapp.com';
  if (!isWhatsApp) return;

  // ── Logging ─────────────────────────────────────────────────────────────
  const log = (...args) => console.debug('[AI Grammar WhatsApp]', ...args);

  // ── State ───────────────────────────────────────────────────────────────
  let contextInvalidated = false;

  // ══════════════════════════════════════════════════════════════════════════
  // Storage helpers (mirrors content.js safeGetStorage)
  // ══════════════════════════════════════════════════════════════════════════

  async function safeGetStorage(defaults) {
    if (contextInvalidated) return defaults;
    try {
      return await chrome.storage.sync.get(defaults);
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        contextInvalidated = true;
        log('Extension context invalidated, using defaults');
        return defaults;
      }
      throw e;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WhatsApp text normalisation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Normalise WhatsApp message text by stripping bidi/zero-width markers,
   * variation selectors, and soft hyphens.  Returns both the normalised text
   * and a character-index map so backend byte offsets can be mapped back to
   * visible characters for overlay rendering.
   */
  function normalizeTextWithMap(raw) {
    const text = raw || '';
    let normalized = '';
    const normalizedToRaw = [];

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      // Drop bidi/zero-width markers and variation selectors WhatsApp can
      // place in message text.  Keep a map so backend offsets still locate
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

    normalized = normalized.replace(/ /g, ' ');
    const first = normalized.search(/\S/);
    if (first === -1) return { text: '', normalizedToRaw: [] };
    const lastMatch = normalized.match(/\S\s*$/);
    const last = lastMatch ? lastMatch.index + 1 : normalized.length;

    return {
      text: normalized.slice(first, last),
      normalizedToRaw: normalizedToRaw.slice(first, last),
    };
  }

  /**
   * Strip WhatsApp text artifacts without building a character map.
   * Used for visible-slice rendering in overlays.
   */
  function stripTextArtifacts(raw) {
    return (raw || '')
      .replace(/[­͏؜​-‏‪-‮⁠-⁯︀-️﻿]/g, '')
      .replace(/ /g, ' ');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WhatsApp message DOM access
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Find the text-bearing element inside a WhatsApp message container.
   * WhatsApp wraps message text in .copyable-text > span.selectable-text.
   */
  function getTextElement(container) {
    if (!container?.querySelector) return null;
    const copyable = container.matches?.('.copyable-text')
      ? container
      : container.querySelector('.copyable-text');
    if (!copyable) return null;
    return copyable.querySelector('span.selectable-text') || copyable;
  }

  /**
   * Extract the full message info from a WhatsApp message container:
   *  - textEl: the DOM element holding the message text
   *  - rawText: the raw textContent (may include bidi markers)
   *  - text: normalised text (what the AI backend sees)
   *  - normalizedToRaw: offset map from normalised → raw
   */
  function getMessageInfo(container) {
    const textEl = getTextElement(container);
    if (!textEl) return { textEl: null, text: '', rawText: '', normalizedToRaw: [] };

    const rawText = textEl.textContent || '';
    const normalized = normalizeTextWithMap(rawText);
    return { textEl, rawText, ...normalized };
  }

  /**
   * Get just the normalised text from a WhatsApp message container.
   */
  function getMessageText(container) {
    return getMessageInfo(container).text;
  }

  /**
   * Walk up from an element to find the enclosing WhatsApp message container
   * (div.message-out or div.message-in).
   */
  function findMessageContainer(el) {
    let node = el;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node?.closest) return null;
    return node.closest('div.message-out, div.message-in');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Conversation tracking
  // ══════════════════════════════════════════════════════════════════════════

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        const value = compactText(el?.getAttribute?.('title') || el?.getAttribute?.('aria-label') || el?.textContent);
        if (value) return value;
      } catch {
        // Ignore unsupported selectors on unusual pages.
      }
    }
    return '';
  }

  /**
   * Build a WhatsApp-specific conversation key that includes the chat header
   * title and the selected chat name.  This is more precise than the generic
   * URL-based key because WhatsApp's SPA router doesn't reliably change the
   * URL on chat switches.
   */
  function getConversationKey() {
    try {
      const urlKey = `${location.origin}${location.pathname}${location.search}${location.hash}`;
      const headerTitle = firstText([
        'header [title]',
        'header [aria-label]',
        'header span[dir="auto"]',
        '[data-testid="conversation-info-header"] [title]',
      ]);
      const selectedChat = firstText([
        '[aria-selected="true"] [title]',
        '[aria-current="true"] [title]',
        '[data-testid="cell-frame-container"][aria-selected="true"] [title]',
      ]);
      return `whatsapp:${urlKey}:${headerTitle || selectedChat || 'unknown'}`;
    } catch {
      return `${location.origin}${location.pathname}${location.search}${location.hash}`;
    }
  }

  /**
   * Detect clicks on the WhatsApp chat list (left sidebar) that switch
   * conversations without a route/hash change.
   */
  function isChatListClick(target) {
    if (!target?.closest) return false;
    const row = target.closest('[role="listitem"], [aria-selected], [aria-current], [data-testid="cell-frame-container"]');
    if (!row) return false;
    // The left chat list lives outside the active conversation pane; clicking
    // one of its rows switches chats without a reliable route/hash change.
    return !row.closest('footer') && !row.closest('main') && !row.closest('header');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WhatsApp overlay-based error highlighting (post-submit)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * HTML entity escaping — Trusted-Types-safe (no innerHTML for untrusted data).
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Map of container → { overlay, cleanup } for active overlays. */
  const messageOverlays = new Map();

  /**
   * Render a post-submit grammar-check overlay for a WhatsApp message.
   *
   * Unlike the generic highlightOverlay(), this version handles WhatsApp's
   * bidi/zero-width character normalisation: error offsets from the backend
   * correspond to the NORMALISED text, but the overlay must show the VISIBLE
   * (raw) text.  The normalizedToRaw map bridges the two.
   */
  function renderOverlay(container, errors, fullText) {
    if (!errors?.length) return 0;

    const waContainer = findMessageContainer(container) || container;
    const info = getMessageInfo(waContainer);
    if (!info.textEl || !info.text) return 0;

    removeOverlay(waContainer);

    // The normalised text matches what the backend saw; use it for all
    // transparent (non-error) positions so offsets are always correct.
    // For error spans, map through visibleSlice to show WhatsApp-visible
    // text.  This avoids the trailing-edge bug where normalizedToRaw is
    // short because the normalised text trimmed trailing whitespace/timestamp.
    const overlayText = fullText || info.text;
    const useRawMap = overlayText === info.text && info.normalizedToRaw.length === info.text.length;

    function visibleSlice(start, end) {
      if (!useRawMap) return overlayText.slice(start, end);
      const rawStart = info.normalizedToRaw[start] ?? info.rawText.length;
      const rawEnd = end >= info.text.length
        ? ((info.normalizedToRaw[info.normalizedToRaw.length - 1] ?? info.rawText.length - 1) + 1)
        : (info.normalizedToRaw[end] ?? info.rawText.length);
      return stripTextArtifacts(info.rawText.slice(rawStart, rawEnd));
    }

    let html = '';
    let pos = 0;
    let rendered = 0;
    const sorted = [...errors].sort((a, b) => Number(a.start) - Number(b.start));

    for (const err of sorted) {
      const s = Math.max(0, Number(err.start));
      const e = Math.min(overlayText.length, Number(err.end));
      if (s < pos || s >= e) continue;

      // Transparent text between errors: use overlayText directly.
      html += escapeHtml(overlayText.slice(pos, s));

      // Error span: use visibleSlice for WhatsApp-visible rendering.
      const cls = err.type === 'improvement' ? 'ai-grammar-improvement' :
                  err.type === 'idiom' ? 'ai-grammar-idiom' : 'ai-grammar-error';
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;text-underline-offset:0"
          data-correction="${escapeHtml(err.correction || '')}"
          data-explanation="${escapeHtml(err.explanation || '')}"
          data-error="${escapeHtml(err.error || '')}"
          data-type="${err.type || 'error'}" tabindex="0">${escapeHtml(visibleSlice(s, e))}</span>`;
      pos = e;
      rendered++;
    }
    // Trailing transparent text: use overlayText directly.
    html += escapeHtml(overlayText.slice(pos));

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
        removeOverlay(waContainer);
        return;
      }

      const textRect = info.textEl.getBoundingClientRect();
      // Position at the text element's origin but do NOT set an explicit
      // width — inline elements return single-line rects, and forcing that
      // width onto a block element causes premature line-wrapping which
      // shifts underline positions.
      const bubbleRect = waContainer.getBoundingClientRect();
      overlay.style.transform = `translate(${textRect.left}px, ${textRect.top}px)`;
      overlay.style.maxWidth = bubbleRect.width + 'px';
    }

    reposition();

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    const poll = setInterval(() => {
      if (!document.contains(waContainer) || !document.contains(info.textEl)) {
        removeOverlay(waContainer);
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

  /**
   * Remove the overlay for a specific WhatsApp message container.
   */
  function removeOverlay(container) {
    const entry = messageOverlays.get(container);
    if (entry) {
      entry.cleanup();
      messageOverlays.delete(container);
    }
  }

  /**
   * Remove all WhatsApp overlays. Called on conversation switch.
   */
  function removeAllOverlays() {
    for (const [container] of messageOverlays) {
      removeOverlay(container);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WhatsApp user message selectors
  // ══════════════════════════════════════════════════════════════════════════

  const WHATSAPP_USER_SELECTORS = [
    '.message-out',
    '[data-pre-plain-text]',
  ];

  /**
   * Check if a DOM element matches a WhatsApp user-message selector.
   * Used by content.js's CSS-selector matching fallback in the priority chain.
   */
  function isWhatsAppUserMessage(el) {
    if (!el?.matches) return false;
    return WHATSAPP_USER_SELECTORS.some(sel => {
      try { return el.matches(sel); } catch { return false; }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPA navigation — chat-switch detection
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Set up listeners for WhatsApp chat-list clicks that switch conversations
   * without a full URL change.  Dispatches a custom event that content.js
   * and other modules can listen for.
   */
  function setupChatSwitchDetection() {
    // Click on chat list items → conversation changed
    document.addEventListener('click', (e) => {
      if (isChatListClick(e.target)) {
        log('Chat list click detected — conversation switch');
        removeAllOverlays();
        // Signal content.js that conversation state should be cleared.
        // This is the same mechanism as the URL/hash change listeners.
        window.dispatchEvent(new CustomEvent('ai-grammar:whatsapp-chat-switch'));
      }
    }, true);

    log('Chat-switch detection active');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API — exposed on window.__aiWhatsApp
  // ══════════════════════════════════════════════════════════════════════════

  window.__aiWhatsApp = {
    // Text normalisation
    normalizeTextWithMap,
    stripTextArtifacts,

    // Message DOM
    getTextElement,
    getMessageInfo,
    getMessageText,
    findMessageContainer,

    // Overlay management
    renderOverlay,
    removeOverlay,
    removeAllOverlays,

    // Conversation tracking
    getConversationKey,
    isChatListClick,

    // User message detection
    isWhatsAppUserMessage,
    userMessageSelectors: WHATSAPP_USER_SELECTORS,

    // Platform info
    isWhatsApp: true,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Initialization
  // ══════════════════════════════════════════════════════════════════════════

  function init() {
    log('Initializing WhatsApp bridge');

    // Set up chat-switch detection for SPA navigation
    setupChatSwitchDetection();

    log('WhatsApp bridge ready');
  }

  // ── Start ───────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Clean up on extension context invalidation
  try {
    if (chrome.runtime?.id) {
      // Extension is alive — nothing to do
    }
  } catch {
    removeAllOverlays();
  }
})();
