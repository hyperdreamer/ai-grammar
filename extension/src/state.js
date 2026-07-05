// AI Grammar Checker — Content script
//
// Runs on every page. Watches for newly submitted text content,
// sends it to the backend for grammar checking, and highlights errors
// with tooltips showing corrections.

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

export const DEBOUNCE_MS = 2000;
export const IGNORE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
  'SVG', 'MATH', 'NOSCRIPT', 'IFRAME', 'CANVAS',
]);
export const IGNORE_CLASSES = ['ai-grammar-error', 'ai-grammar-improvement', 'ai-grammar-idiom', 'ai-grammar-tooltip', 'ai-grammar-badge', 'ai-grammar-ok', 'ag-message-overlay', 'ag-live-error'];
export const CHECKED_ATTR = 'data-ai-grammar-checked';
export const isTeams = /^teams\.(cloud\.)?microsoft(\.com)?$/i.test(location.hostname) || location.hostname === 'teams.live.com';
// Check if WhatsApp bridge is loaded on this page.
// When present, WhatsApp-specific logic (text normalisation, overlay rendering,
// chat-switch detection) is delegated to window.__aiWhatsApp.
export function getWhatsAppBridge() { return window.__aiWhatsApp || null; }

export const LIVE_HIGHLIGHT_CLASS = 'ag-live-highlight';
export const USER_TEXT_TTL_MS = 8000;       // how long we remember user text
export const USER_TEXT_MIN_MATCH = 0.6;     // fraction of user text that must appear in rendered block
export const SUBMISSION_TTL_MS = 60000;

export const USER_MESSAGE_SELECTOR = [
  '.user-msg',
  '.user-message',
  '.message.user',
  '[data-testid*="user"]',
  '[class*="user"][class*="msg"]',
  '[class*="user"][class*="message"]',
  // Microsoft Teams self/sent messages
  '[class*="self"]',
  '[class*="outgoing"]',
  '[class*="sent"]',
  '[data-tid*="self"]',
].join(', ');

export const GRAMMAR_CLASSES = '.ai-grammar-error, .ai-grammar-improvement, .ai-grammar-idiom';

// -----------------------------------------------------------------------
// Mutable state — exported as a single object so importing modules can
// mutate properties (ESM import bindings are read-only, but object
// property assignment is always allowed).
// -----------------------------------------------------------------------

export const state = {
  minChars: 30,  // read from storage (grammarMinChars)

  // Persistent port to background — keeps the service worker alive so
  // apply-fix messages are delivered even after the 30s idle timeout.
  fixPort: null,

  checkIdCounter: 0,
  pendingChecks: new Map(),       // container → { text, conversationKey }
  checkedElements: new WeakSet(), // elements already checked
  debounceTimer: null,
  isHighlighting: false,
  tooltipEl: null,
  tooltipTimeout: null,
  currentErrorEl: null,
  liveHighlightEl: null,
  liveHighlightTarget: null,
  liveHighlightRestore: null,
  liveHighlightScrollHandler: null,
  liveHighlightMouseMoveHandler: null,
  liveHighlightMouseLeaveHandler: null,
  liveHighlightReposition: null,
  liveHighlightAnimationFrame: null,

  // Overlay-based post-submit highlights (survives React re-renders on
  // WhatsApp Web, Teams, etc. — DOM injection gets stripped by vdom reconcilation)
  messageOverlays: new Map(), // container → { overlay, cleanup }

  // AbortController for in-flight grammar checks — aborted when user resumes typing
  activeCheckController: null,

  // Function to cancel pending live draft check — set by setupLiveDraftCheck
  cancelLiveDraft: null,
  commandInFlight: false,
  skipLiveCheck: false,   // set during fix/polish to prevent re-triggering live draft
  replacingCommand: false, // set during partial → full command replacement

  // Track whether the extension context has been invalidated (MV3 service worker
  // termination / extension reload). Once invalidated, chrome.* APIs throw
  // "Extension context invalidated" — we fall back to hardcoded defaults.
  contextInvalidated: false,

  // Track the last text the user submitted so we only check their content,
  // not AI replies or other page text that happens to appear in the DOM.
  lastUserText: '',
  lastUserTextTime: 0,

  activeConversationKey: '',
  pendingSubmission: null,        // { text, messageList, time, conversationKey }

  // Reference counters: one counter per pending category
  badgeCounters: { checking: 0, fixing: 0, polishing: 0 },

  // Current label text for each category
  badgeLabels: {
    checking: 'Checking grammar...',
    fixing: 'Fixing...',
    polishing: 'Polishing...'
  },

  // Active badge DOM elements, keyed by category or 'result-N' for result badges
  activeBadges: new Map(),  // key → { el, category, counter? }

  // Timer handle for auto-dismissing result badges
  resultBadgeTimer: null,

  // Green checkmark state
  greenCheckTimers: new Map(),  // container → timer (for cleanup)
};

// Persistent port initialization
try {
  state.fixPort = chrome.runtime.connect({ name: 'grammar-fix' });
  state.fixPort.onDisconnect.addListener(() => {
    // Reconnect on disconnect (worker restarted)
    setTimeout(() => {
      try { state.fixPort = chrome.runtime.connect({ name: 'grammar-fix' }); } catch {}
    }, 1000);
  });
} catch {}

// -----------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------

/**
 * Wrapper around chrome.storage.sync.get() that catches
 * "Extension context invalidated" and returns the caller's defaults.
 * Content scripts can outlive the service worker; storage should work
 * independently, but Chrome sometimes throws this error after an
 * extension reload or aggressive SW termination.
 *
 * chrome.storage.sync.get() can hang indefinitely in fresh Chromium
 * profiles (the sync backend never initializes).  We race it against
 * a 2-second timeout and return the caller's defaults on timeout.
 */
export async function safeGetStorage(defaults) {
  if (state.contextInvalidated) return defaults;
  try {
    return await Promise.race([
      chrome.storage.sync.get(defaults),
      new Promise(resolve => setTimeout(() => {
        console.debug('[AI Grammar] chrome.storage.sync.get() timed out, using defaults');
        resolve(defaults);
      }, 2000)),
    ]);
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) {
      state.contextInvalidated = true;
      console.debug('[AI Grammar] Extension context invalidated, using defaults');
      return defaults;
    }
    throw e;
  }
}

// -----------------------------------------------------------------------
// Conversation tracking
// -----------------------------------------------------------------------

export function getConversationKey() {
  try {
    const urlKey = `${location.origin}${location.pathname}${location.search}${location.hash}`;

    // Delegate to WhatsApp bridge for WhatsApp-specific key generation
    const wa = getWhatsAppBridge();
    if (wa) {
      return wa.getConversationKey();
    }

    return `generic:${urlKey}`;
  } catch {
    return `${location.origin}${location.pathname}${location.search}${location.hash}`;
  }
}

// -----------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
