import {
  state,
  getConversationKey,
  getWhatsAppBridge,
  USER_MESSAGE_SELECTOR,
} from './state.js';
import { checkText } from './check-text.js';
import { showResultBadge } from './indicators.js';

// -----------------------------------------------------------------------
// Manual selection check (keyboard shortcut)
// -----------------------------------------------------------------------

export function receiveSelectionCheckMessage(message, _sender, sendResponse) {
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
    state.contextInvalidated = true;
  } else {
    console.debug('[AI Grammar] Failed to register selection listener:', e);
  }
}

window.addEventListener('grammar:check-selection', () => {
  handleSelectionCheck();
});

export function handleSelectionCheck() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const text = range.toString().trim();
  if (text.length < state.minChars) {
    showResultBadge('Selection too short to check');
    return;
  }

  // Delegate WhatsApp-specific message detection to the bridge
  const selWhatsApp = getWhatsAppBridge();
  if (selWhatsApp) {
    const waContainer = selWhatsApp.findMessageContainer(range.commonAncestorContainer);
    if (waContainer) {
      const waText = selWhatsApp.getMessageText(waContainer);
      if (waText.length >= state.minChars) {
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
    if (selWhatsApp) {
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
