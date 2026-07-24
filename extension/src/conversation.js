import {
  state,
  getConversationKey,
  getWhatsAppBridge,
} from './state.js';
import { clearLiveDraftHighlights } from './live-draft.js';
import { hideTooltip } from './tooltip.js';
import { removeMessageOverlay } from './highlight.js';
import {
  removeErrorFloat,
  removeLiveDraftGreenChecks,
  removeAllBadges,
} from './indicators.js';

// -----------------------------------------------------------------------
// Conversation tracking
// -----------------------------------------------------------------------

export function clearConversationScopedState({ updateKey = true } = {}) {
  if (updateKey) state.activeConversationKey = getConversationKey();
  clearLiveDraftHighlights();
  hideTooltip();
  removeErrorFloat();
  removeLiveDraftGreenChecks();
  removeAllBadges();
  for (const container of [...state.messageOverlays.keys()]) {
    removeMessageOverlay(container);
  }
  state.activeCheckController?.abort();
  state.activeCheckController = null;
  state.cancelLiveDraft?.();
  state.lastUserText = '';
  state.pendingSubmission = null;
  state.pendingChecks.clear();
}

export function handleConversationMaybeChanged() {
  const nextKey = getConversationKey();
  if (!state.activeConversationKey) {
    state.activeConversationKey = nextKey;
    return;
  }
  if (nextKey === state.activeConversationKey) return;

  clearConversationScopedState();
}

export function scheduleConversationCheck(event) {
  // WhatsApp bridge handles chat-list click detection
  const wa = getWhatsAppBridge();
  if (event?.type === 'click' && wa?.isChatListClick(event.target)) {
    clearConversationScopedState({ updateKey: false });
  }
  setTimeout(handleConversationMaybeChanged, 100);
  setTimeout(handleConversationMaybeChanged, 500);
}
