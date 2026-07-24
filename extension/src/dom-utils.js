import {
  IGNORE_TAGS,
  IGNORE_CLASSES,
  CHECKED_ATTR,
  state,
  USER_MESSAGE_SELECTOR,
  USER_TEXT_TTL_MS,
  USER_TEXT_MIN_MATCH,
} from './state.js';
import { getCodeMirrorText, isCodeMirrorEditor } from './codemirror-bridge.js';

// -----------------------------------------------------------------------
// DOM compatibility helpers
// -----------------------------------------------------------------------

/**
 * Return whether an element is mounted, including when it lives in a shadow
 * tree. `document.contains()` excludes shadow descendants in Chromium.
 */
export function isConnectedToDocument(el) {
  return !!el && (el.isConnected === true || document.contains(el));
}

/**
 * Read a control's logical draft text. CodeMirror renders each logical line in
 * a separate element, so its textContent would silently remove newlines.
 */
export function getEditableText(el) {
  if (!el) return '';
  if (isCodeMirrorEditor(el)) return getCodeMirrorText(el);
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
  return el.textContent || '';
}

/**
 * Resolve the editable element that originated a document-level event.
 * Composed events from an open shadow tree are retargeted to its host, so
 * `event.target` alone cannot identify a nested textarea/contentEditable.
 */
export function getEventEditableTarget(event) {
  const path = typeof event?.composedPath === 'function'
    ? event.composedPath()
    : [event?.target];

  for (const node of path) {
    if (!node || node.nodeType !== 1) continue;
    if (node.tagName === 'TEXTAREA') return node;
    if (!node.isContentEditable) continue;

    // Events can originate in a formatting child of an editor. Use the
    // contenteditable owner so callers operate on the full draft.
    const owner = node.closest?.('[contenteditable]');
    return owner?.isContentEditable ? owner : node;
  }

  return null;
}

/**
 * Follow focus through open shadow roots. At document level, activeElement is
 * only the outer host (for example, <pi-webui-app>), not its focused editor.
 */
export function getDeepActiveElement(root = document) {
  let active = root?.activeElement || null;
  const visited = new Set();

  while (active?.shadowRoot?.activeElement && !visited.has(active)) {
    visited.add(active);
    active = active.shadowRoot.activeElement;
  }

  return active;
}

// -----------------------------------------------------------------------
// Text block detection
// -----------------------------------------------------------------------

export function isIgnored(el) {
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

export function getTextContent(el) {
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
export function cleanMessageText(raw) {
  // Strip trailing time pattern: "11:39", "11:39 PM", "11:39 AM"
  return raw.replace(/[\s.]*\d{1,2}:\d{2}(\s*[APap][Mm])?\s*$/, '').trim();
}

export function isTextBlock(el) {
  if (isIgnored(el)) return false;
  if (state.checkedElements.has(el)) return false;
  if (el.hasAttribute(CHECKED_ATTR)) return false;

  // Skip inline elements that are just small formatting
  const text = getTextContent(el);
  if (text.length < state.minChars) return false;

  // Skip elements that are mostly links/navigation
  const links = el.querySelectorAll('a');
  const linkText = Array.from(links).map(a => a.textContent).join('').length;
  if (linkText > text.length * 0.5) return false;

  return true;
}

export function isLikelyUserMessage(el) {
  return !!el?.matches?.(USER_MESSAGE_SELECTOR);
}

/**
 * Check whether a DOM text block matches the user's last submitted text.
 * Only blocks that plausibly contain the user's own content pass this filter
 * — AI replies and unrelated page mutations are silently ignored.
 */
export function isUserText(blockText) {
  if (!state.lastUserText) return false;

  const now = Date.now();
  if (now - state.lastUserTextTime > USER_TEXT_TTL_MS) {
    state.lastUserText = '';
    return false;
  }

  // Normalize both strings for comparison
  const normUser = state.lastUserText.replace(/\s+/g, ' ').trim().toLowerCase();
  const normBlock = blockText.replace(/\s+/g, ' ').trim().toLowerCase();

  if (!normUser || !normBlock) return false;

  // The rendered block should contain most of the submitted text
  return normBlock.includes(normUser) ||
         (normUser.length > 0 && normBlock.length > 0 &&
          longestCommonSubstring(normUser, normBlock) >= normUser.length * USER_TEXT_MIN_MATCH);
}

export function longestCommonSubstring(a, b) {
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

export function findNewTextBlocks(mutations) {
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
