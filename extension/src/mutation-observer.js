import {
  DEBOUNCE_MS,
  state,
  CHECKED_ATTR,
  SUBMISSION_TTL_MS,
  getConversationKey,
  getWhatsAppBridge,
} from './state.js';
import {
  findNewTextBlocks,
  cleanMessageText,
  getTextContent,
  isLikelyUserMessage,
  isUserText,
} from './dom-utils.js';
import { checkText } from './check-text.js';

// -----------------------------------------------------------------------
// MutationObserver — detect newly submitted text
// -----------------------------------------------------------------------

export const observer = new MutationObserver((mutations) => {
  if (state.isHighlighting) return; // Ignore our own DOM changes

  // Expire stale pendingSubmission
  if (state.pendingSubmission && Date.now() - state.pendingSubmission.time > SUBMISSION_TTL_MS) {
    state.pendingSubmission = null;
  }
  if (state.pendingSubmission && state.pendingSubmission.conversationKey !== getConversationKey()) {
    state.pendingSubmission = null;
  }

  const newBlocks = findNewTextBlocks(mutations);
  if (newBlocks.length === 0) return;

  // Add to pending and debounce — only user-authored content.
  // Priority chain: structural proximity > CSS selector > text matching.
  let matchedByText = false;
  for (const block of newBlocks) {
    const text = cleanMessageText(getTextContent(block));
    if (text.length < state.minChars) continue;

    let matched = false;

    // 1) STRUCTURAL PROXIMITY (most reliable — v1.3.10+)
    if (state.pendingSubmission && state.pendingSubmission.messageList &&
        state.pendingSubmission.messageList.contains(block)) {
      matched = true;
    }

    // 2) CSS SELECTOR (platform-specific fallback)
    if (!matched && isLikelyUserMessage(block)) {
      matched = true;
    }

    // 2b) WhatsApp-specific message detection (delegated to bridge)
    const wa = getWhatsAppBridge();
    if (!matched && wa?.isWhatsAppUserMessage(block)) {
      matched = true;
    }

    // 3) TEXT MATCHING (last resort — TTL-limited)
    if (!matched && isUserText(text)) {
      matched = true;
      matchedByText = true;
    }

    if (matched) {
      const conversationKey = state.pendingSubmission?.conversationKey || getConversationKey();
      state.pendingChecks.set(block, { text, conversationKey });
      state.checkedElements.add(block);
      block.setAttribute(CHECKED_ATTR, '');
    }
  }

  // Clear stored user text only when we actually matched by content
  // (isLikelyUserMessage matches on CSS only, which can fire on quick replies)
  if (state.pendingChecks.size > 0 && matchedByText) {
    state.lastUserText = '';
  }

  // Reset debounce timer
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(processPendingChecks, DEBOUNCE_MS);
});

export function processPendingChecks() {
  const entries = [...state.pendingChecks.entries()];
  state.pendingChecks.clear();

  // Clear pendingSubmission after consuming matched blocks.
  // This prevents AI replies in the same container from matching
  // on subsequent mutation batches (they'd appear without .user-msg
  // CSS class and with different text, but proximity alone would
  // match them if we left the submission open).
  state.pendingSubmission = null;

  for (const [container, item] of entries) {
    const text = typeof item === 'string' ? item : item.text;
    const conversationKey = typeof item === 'string' ? getConversationKey() : item.conversationKey;
    if (!document.contains(container)) continue;
    if (conversationKey !== getConversationKey()) continue;
    checkText(text, container, conversationKey);
  }
}
