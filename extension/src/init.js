import { injectStyles } from './styles.js';
import {
  state,
  getConversationKey,
  isTeams,
} from './state.js';
import {
  handleConversationMaybeChanged,
  scheduleConversationCheck,
} from './conversation.js';
import { setupLiveDraftCheck } from './live-draft.js';
import {
  handleCommand,
  showCommandPalette,
  hideCommandPalette,
  updatePaletteSelection,
  selectPaletteCommand,
  buildPaletteCommands,
  paletteEl,
  COMMANDS,
} from './commands.js';
import { showResultBadge } from './indicators.js';

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------

export function init() {
  injectStyles();
  state.activeConversationKey = getConversationKey();
  window.addEventListener('hashchange', handleConversationMaybeChanged);
  window.addEventListener('popstate', handleConversationMaybeChanged);
  // WhatsApp bridge dispatches this on chat-list clicks (SPA navigation)
  window.addEventListener('ai-grammar:whatsapp-chat-switch', () => {
    handleConversationMaybeChanged();
  });
  document.addEventListener('click', scheduleConversationCheck, true);
  document.addEventListener('focusin', scheduleConversationCheck, true);
  document.addEventListener('input', scheduleConversationCheck, true);
  setInterval(handleConversationMaybeChanged, 1000);

  // Auto-check on submit is disabled — grammar checks are now
  // manual-only via keyboard shortcut (Ctrl+Shift+L) on selected text.
  // The MutationObserver is intentionally not started.

  // --- Track user-submitted text so we only check the user's content ---
  // Helper: process captured text — handle commands, otherwise store for matching
  async function processCapturedText(captured, textarea) {
    if (!captured || captured.length < state.minChars) return;
    // Check for ?/ prefix commands at the end
    if (/\?\/\w+(\s+\S+)?$/.test(captured)) {
      await handleCommand(captured);
      return;
    }
    const conversationKey = getConversationKey();
    state.activeConversationKey = conversationKey;
    state.lastUserText = captured;
    state.lastUserTextTime = Date.now();

    // Capture the message-list container via structural proximity.
    // This lets the MutationObserver match the user's message by
    // container membership instead of fragile text/CSS heuristics.
    if (textarea && document.contains(textarea)) {
      const messageList = findMessageList(textarea);
      if (messageList) {
        state.pendingSubmission = { text: captured, messageList, time: Date.now(), conversationKey };
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

    // Prevent WhatsApp/chat platforms from sending when a ?/fix, ?/polish, or ?/check
    // command is pending — the Enter triggers our handler, not the platform's send.
    if (/\?\/\b(fix|polish|check)\b\s*$/.test(text)) {
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

    // Skip command detection when the input event was dispatched by our own
    // partial→full command replacement — prevents double-fire (e.g., ?/c
    // replaced to ?/check then re-matched as a full command).
    if (state.replacingCommand) return;

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

            // Replace the partial prefix with the full command in the
            // textarea BEFORE calling the handler — so the user sees the
            // resolved command and commands that read the textarea (check,
            // fix, polish) can find the full command string.
            const idx = ta.value ? ta.value.lastIndexOf(cmdText) : (ta.textContent || '').lastIndexOf(cmdText);
            const val = ta.value || ta.textContent || '';
            if (idx >= 0) {
              // ?/lang appends a trailing space to invite parameter input.
              const suffix = matched.name === 'lang' ? ' ' : '';
              const replaced = val.slice(0, idx) + fullCmd + suffix + val.slice(idx + cmdText.length);
              state.skipLiveCheck = true;
              state.replacingCommand = true;
              if (ta.tagName === 'TEXTAREA') {
                ta.value = replaced;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                ta.textContent = replaced;
              }
              state.replacingCommand = false;
              state.skipLiveCheck = false;
            }

            // ?/lang is a two-step command — show language options and
            // wait for the user to type the parameter.
            if (matched.name === 'lang') {
              showResultBadge('Available: auto, en, zh, ja, ko, fr, de, es, ru, pt, it, ar', 8000);
              return;
            }

            try {
              if (matched.name === 'fix' || matched.name === 'polish' || matched.name === 'check') {
                await COMMANDS[matched.name].run('', ta);
              } else {
                await COMMANDS[matched.name].run('');
              }
            } catch (err) {
              showResultBadge(`Command failed: ${err.message}`);
            }

            // Strip the resolved full command afterward (skip for
            // fix/polish/check — they handle their own cleanup).
            if (matched.name !== 'fix' && matched.name !== 'polish' && matched.name !== 'check') {
              // Brief pause so the user sees the completed command before it's stripped
              await new Promise(r => setTimeout(r, 400));
              const idx2 = ta.value ? ta.value.lastIndexOf(fullCmd) : (ta.textContent || '').lastIndexOf(fullCmd);
              const val2 = ta.value || ta.textContent || '';
              const cleaned = (idx2 >= 0 ? val2.slice(0, idx2) + val2.slice(idx2 + fullCmd.length) : val2).trimEnd();
              state.skipLiveCheck = true;
              if (ta.tagName === 'TEXTAREA') {
                ta.value = cleaned;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                ta.textContent = cleaned;
              }
              state.skipLiveCheck = false;
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
        console.debug('[AI Grammar] Debounce fired', { cmdName, cmdText, currentValue: currentValue.slice(-20), includes: currentValue.includes(cmdText) });
        if (!currentValue.includes(cmdText)) return;

        // ?/lang without a parameter — show available languages and wait
        if (cmdName === 'lang' && !cmdArgs) {
          showResultBadge('Available: auto, en, zh, ja, ko, fr, de, es, ru, pt, it, ar', 8000);
          return;
        }

        try {
          if (cmdName === 'fix' || cmdName === 'polish' || cmdName === 'check') {
            await COMMANDS[cmdName].run(cmdArgs, ta);
          } else {
            await COMMANDS[cmdName].run(cmdArgs);
          }
        } catch (err) {
          showResultBadge(`Command failed: ${err.message}`);
        }

        // Strip the command portion, keep text before it
        // Skip for 'fix', 'polish', 'check', and lang-without-args (lang waits for parameter)
        if (cmdName !== 'fix' && cmdName !== 'polish' && cmdName !== 'check') {
          if (cmdName === 'lang' && !cmdArgs) {
            // lang without args — keep the command text, user still typing parameter
          } else {
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
        }
      }, 600);
      return;
    }

    // User typed something else → hide palette
    hideCommandPalette();
  }, true);

  // Start live draft checking (checks text as you type after 5s pause)
  // Skip on Teams — teams-bridge.js handles CKEditor live-draft independently
  if (!isTeams) {
    setupLiveDraftCheck();
  }

  console.debug('[AI Grammar] Content script initialized');
}
