import { state, safeGetStorage, isTeams } from './state.js';
import {
  showPendingBadge,
  removePendingBadge,
  showResultBadge,
  showGreenCheck,
} from './indicators.js';
import { tryBeforeInput, applyFixCDP } from './apply-correction.js';
import { highlightLiveDraft } from './live-draft.js';

// -----------------------------------------------------------------------
// Command system (?/ prefix)
// -----------------------------------------------------------------------

/**
 * Strip a command tag (e.g., "?/fix", "?/polish") from the textarea.
 * Dispatches an input event with skipLiveCheck so the live draft checker
 * won't fire on the cleaned text.  Also cancels any pending live draft
 * so the poller doesn't re-check the stripped text later.
 */
function stripCommand(cmd, ta) {
  const val = ta.value || ta.textContent || '';
  const idx = val.lastIndexOf(cmd);
  if (idx < 0) return;
  const cleaned = val.slice(0, idx) + val.slice(idx + cmd.length);
  state.skipLiveCheck = true;
  state.cancelLiveDraft?.();
  if (ta.tagName === 'TEXTAREA') {
    ta.value = cleaned;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    ta.textContent = cleaned;
  }
  state.skipLiveCheck = false;
}

export const COMMAND_PREFIX = '?/';
export const COMMANDS = {
  off: {
    help: 'Disable grammar checking',
    async run() {
      await chrome.storage.sync.set({ grammarEnabled: false });
      showResultBadge('Grammar checker disabled');
    },
  },
  on: {
    help: 'Enable grammar checking',
    async run() {
      await chrome.storage.sync.set({ grammarEnabled: true });
      showResultBadge('Grammar checker enabled');
    },
  },
  lang: {
    help: 'Set language (e.g., ?/lang en, ?/lang zh, ?/lang auto)',
    async run(args) {
      const valid = ['auto', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar'];
      const lang = (args || '').toLowerCase();
      if (!valid.includes(lang)) {
        showResultBadge(`Unknown language: "${args}". Use: ${valid.join(', ')}`);
        return;
      }
      const label = lang === 'auto' ? 'Auto-detect' : lang.toUpperCase();
      await chrome.storage.sync.set({ grammarLanguage: lang });
      showResultBadge(`Language set to ${label}`);
    },
  },
  help: {
    help: 'Show available commands',
    run() {
      const lines = Object.entries(COMMANDS).map(([name, cmd]) => `?/${name} — ${cmd.help}`);
      showResultBadge(lines.join('<br>'), 12000);
    },
  },
  check: {
    help: 'Manual grammar check for live-draft text',
    async run(_args, ta) {
      console.debug('[AI Grammar] ?/check command fired', { value: (ta?.value || ta?.textContent || '').slice(0, 30), minChars: state.minChars });
      /** Strip the ?/check command from the input field */
      function stripCheck(input) {
        const val = input.value || input.textContent || '';
        const idx = val.lastIndexOf('?/check');  // '?/check'.length === 7
        const cleaned = (idx >= 0 ? val.slice(0, idx) + val.slice(idx + 7) : val).trimEnd();
        if (input.tagName === 'TEXTAREA') {
          input.value = cleaned;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          input.textContent = cleaned;
        }
      }

      // GUARD: disabled on WhatsApp and Teams
      const isWhatsApp = location.hostname === 'web.whatsapp.com';
      if (isWhatsApp || isTeams) {
        showResultBadge('?/check is not available on this site');
        stripCheck(ta);
        return;
      }

      const value = ta.value || ta.textContent || '';
      const cmdIdx = value.lastIndexOf('?/check');
      const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();

      if (!draft || draft.length < state.minChars) {
        showResultBadge('Too short (min ' + state.minChars + ' chars)');
        stripCheck(ta);
        return;
      }

      // Cancel any pending live-draft auto-check BEFORE setting commandInFlight,
      // so abortLiveDraftCheck() can remove the live draft's pending badge.
      // If commandInFlight is true, abortLiveDraftCheck skips badge removal.
      state.cancelLiveDraft?.();
      state.activeCheckController?.abort();

      showPendingBadge('checking', 'Checking grammar...');
      state.commandInFlight = true;

      try {
        const settings = await safeGetStorage({
          grammarHost: '127.0.0.1',
          grammarPort: 8766,
        });
        // Store on state so editing cancels this in-flight check
        state.activeCheckController?.abort();
        state.activeCheckController = new AbortController();
        const timeoutId = setTimeout(() => state.activeCheckController.abort(), 30000);
        const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: draft, language: 'auto' }),
          signal: state.activeCheckController.signal,
        });
        clearTimeout(timeoutId);
        const data = await resp.json();

        if (!resp.ok) {
          showResultBadge('Grammar check failed: ' + (data?.detail || resp.status), 5000);
          return;
        }

        if (data?.errors?.length > 0) {
          // Strip command text only when results are actually shown.
          // On failure, the user should still see their ?/check command.
          state.skipLiveCheck = true;
          stripCheck(ta);
          state.skipLiveCheck = false;
          highlightLiveDraft(ta, data.errors);
        } else {
          state.skipLiveCheck = true;
          stripCheck(ta);
          state.skipLiveCheck = false;
          showGreenCheck(ta, draft);
        }
      } catch (e) {
        let reason;
        if (e.name === 'AbortError') {
          reason = 'Request timed out';
        } else if (e.message?.includes('Extension context invalidated')) {
          reason = 'Extension reloaded — please reload this page';
        } else {
          reason = e.message;
        }
        showResultBadge('Check failed: ' + reason);
      } finally {
        removePendingBadge('checking');
        state.commandInFlight = false;
        state.activeCheckController = null;
      }
    },
  },
  fix: {
    help: 'Auto-correct the text you typed (everything before ?/fix)',
    async run(_args, ta) {
      const value = ta.value || ta.textContent || '';
      const cmdIdx = value.lastIndexOf('?/fix');
      const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
      if (!draft || draft.length < state.minChars) {
        showResultBadge('No text to fix (need at least ' + state.minChars + ' characters)');
        stripCommand('?/fix', ta);
        return;
      }
      showPendingBadge('fixing', 'Fixing...');
      state.commandInFlight = true;
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
        removePendingBadge('fixing');
        if (!data?.errors?.length) {
          showResultBadge('✓ No corrections needed');
          stripCommand('?/fix', ta);
          return;
        }
        // Apply corrections bottom-up to preserve offsets
        const sorted = [...data.errors].sort((a, b) => b.start - a.start);
        let fixed = draft;
        for (const err of sorted) {
          fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
        }
        // Replace textarea content with fixed text
        state.skipLiveCheck = true;
        if (ta.tagName === 'TEXTAREA') {
          ta.value = fixed;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // contentEditable — use beforeinput for all editors.
          // Lexical (WhatsApp), CKEditor (Teams), and other rich-text
          // editors all process beforeinput natively.  Falls back to
          // CDP keyboard simulation when beforeinput is not handled.
          if (tryBeforeInput(fixed, ta)) {
            // Success — fall through to common code below
          } else {
            // Fall back to CDP keyboard simulation
            applyFixCDP(fixed).then(success => {
              if (success) {
                showResultBadge(`✓ Fixed ${sorted.length} issue${sorted.length > 1 ? 's' : ''}`, 3000);
              } else {
                navigator.clipboard.writeText(fixed).catch(() => {});
                showResultBadge(`Copied fixed text to clipboard — paste (Ctrl+V) to apply`, 4000);
              }
              state.skipLiveCheck = false;
            });
            state.cancelLiveDraft?.();
            state.activeCheckController?.abort();
            return;  // badge handled above
          }
        }
        state.skipLiveCheck = false;
        // Cancel pending live draft check — text is already corrected
        state.cancelLiveDraft?.();
        state.activeCheckController?.abort();
        ta.focus();
        showResultBadge(`✓ Fixed ${sorted.length} issue${sorted.length > 1 ? 's' : ''}`);
      } catch (e) {
        removePendingBadge('fixing');
        let reason;
        if (e.name === 'AbortError') {
          reason = 'Request timed out or was cancelled';
        } else if (e.message?.includes('Extension context invalidated')) {
          reason = 'Extension reloaded — please reload this page';
        } else {
          reason = e.message;
        }
        showResultBadge(`Fix failed: ${reason}`);
      } finally {
        state.commandInFlight = false;
      }
    },
  },
  polish: {
    help: 'Polish the text you typed (everything before ?/polish)',
    async run(_args, ta) {
      const value = ta.value || ta.textContent || '';
      const cmdIdx = value.lastIndexOf('?/polish');
      const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
      if (!draft || draft.length < state.minChars) {
        showResultBadge('No text to polish (need at least ' + state.minChars + ' characters)');
        stripCommand('?/polish', ta);
        return;
      }
      showPendingBadge('polishing', 'Polishing...');
      state.commandInFlight = true;
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
        removePendingBadge('polishing');
        if (!resp.ok) {
          showResultBadge(`Polish failed: ${data?.detail || resp.status}`, 5000);
          return;
        }
        const polished = data.polished;
        if (!polished || polished === draft) {
          showResultBadge('✓ Text already polished');
          stripCommand('?/polish', ta);
          return;
        }
        // Replace textarea content with polished text
        state.skipLiveCheck = true;
        if (ta.tagName === 'TEXTAREA') {
          ta.value = polished;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // contentEditable — use beforeinput for all editors.
          // Lexical (WhatsApp), CKEditor (Teams), and other rich-text
          // editors all process beforeinput natively.  Falls back to
          // CDP keyboard simulation when beforeinput is not handled.
          if (tryBeforeInput(polished, ta)) {
            // Success — fall through to common code below
          } else {
            // Fall back to CDP keyboard simulation
            applyFixCDP(polished).then(success => {
              if (success) {
                showResultBadge('✓ Polished', 3000);
              } else {
                navigator.clipboard.writeText(polished).catch(() => {});
                showResultBadge('Copied polished text to clipboard — paste (Ctrl+V) to apply', 4000);
              }
              state.skipLiveCheck = false;
            });
            state.cancelLiveDraft?.();
            state.activeCheckController?.abort();
            return;  // badge handled above
          }
        }
        state.skipLiveCheck = false;
        // Cancel pending live draft check — text is already polished
        state.cancelLiveDraft?.();
        state.activeCheckController?.abort();
        ta.focus();
        showResultBadge('✓ Polished');
      } catch (e) {
        removePendingBadge('polishing');
        let reason;
        if (e.name === 'AbortError') {
          reason = 'Request timed out or was cancelled';
        } else if (e.message?.includes('Extension context invalidated')) {
          reason = 'Extension reloaded — please reload this page';
        } else {
          reason = e.message;
        }
        showResultBadge(`Polish failed: ${reason}`);
      } finally {
        state.commandInFlight = false;
      }
    },
  },
};

/**
 * Check if text contains a ?/ command and execute it. Returns true if handled.
 */
export async function handleCommand(text, ta = null) {
  // Find ?/command at the end of the text
  const match = text.match(/\?\/\w+(\s+\S+)?$/);
  if (!match) return false;

  const cmdText = match[0].trim();
  const parts = cmdText.slice(2).trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    showResultBadge(`Unknown command: ?/${cmdName}. Try ?/help`);
    return true;
  }

  try {
    if ((cmdName === 'fix' || cmdName === 'polish' || cmdName === 'check') && ta) {
      await cmd.run(args, ta);
    } else if (cmdName === 'fix') {
      // Called from submit handler — extract text before ?/fix and apply
      const cmdIdx = text.lastIndexOf('?/fix');
      const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
      if (!draft || draft.length < state.minChars) {
        showResultBadge('No text to fix (need at least ' + state.minChars + ' characters)');
        return true;
      }
      showPendingBadge('fixing', 'Fixing...');
      state.commandInFlight = true;
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
        removePendingBadge('fixing');
        if (!data?.errors?.length) {
          showResultBadge('✓ No corrections needed');
          return true;
        }
        const sorted = [...data.errors].sort((a, b) => b.start - a.start);
        let fixed = draft;
        for (const err of sorted) {
          fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
        }
        // Show corrected text as a float notification
        showResultBadge(`Corrected: "${fixed.slice(0, 80)}${fixed.length > 80 ? '...' : ''}"`, 10000);
      } catch (e) {
        removePendingBadge('fixing');
        let reason;
        if (e.name === 'AbortError') {
          reason = 'Request timed out or was cancelled';
        } else if (e.message?.includes('Extension context invalidated')) {
          reason = 'Extension reloaded — please reload this page';
        } else {
          reason = e.message;
        }
        showResultBadge(`Fix failed: ${reason}`);
      } finally {
        state.commandInFlight = false;
      }
    } else if (cmdName === 'polish') {
      // Called from submit handler — extract text before ?/polish and polish
      const cmdIdx = text.lastIndexOf('?/polish');
      const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
      if (!draft || draft.length < state.minChars) {
        showResultBadge('No text to polish (need at least ' + state.minChars + ' characters)');
        return true;
      }
      showPendingBadge('polishing', 'Polishing...');
      state.commandInFlight = true;
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
        removePendingBadge('polishing');
        if (!resp.ok) {
          showResultBadge(`Polish failed: ${data?.detail || resp.status}`, 5000);
          return true;
        }
        const polished = data.polished;
        if (!polished || polished === draft) {
          showResultBadge('✓ Text already polished');
          return true;
        }
        showResultBadge(`Polished: "${polished.slice(0, 80)}${polished.length > 80 ? '...' : ''}"`, 10000);
      } catch (e) {
        removePendingBadge('polishing');
        let reason;
        if (e.name === 'AbortError') {
          reason = 'Request timed out or was cancelled';
        } else if (e.message?.includes('Extension context invalidated')) {
          reason = 'Extension reloaded — please reload this page';
        } else {
          reason = e.message;
        }
        showResultBadge(`Polish failed: ${reason}`);
      } finally {
        state.commandInFlight = false;
      }
    } else {
      await cmd.run(args);
    }
  } catch (e) {
    showResultBadge(`Command failed: ${e.message}`);
  }
  return true;
}

// -----------------------------------------------------------------------
// Command palette (shown when user types ?/ in a text input)
// -----------------------------------------------------------------------

export let paletteEl = null;
export let paletteTarget = null;
let paletteSelectedIdx = 0;

export function buildPaletteCommands() {
  return Object.entries(COMMANDS).map(([name, cmd]) => ({
    name,
    help: cmd.help,
    full: name === 'lang' ? `?/lang en` : `?/${name}`,
    needsArg: name === 'lang',
  }));
}

export function showCommandPalette(ta, filter = '') {
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

export function hideCommandPalette() {
  if (paletteEl) { paletteEl.remove(); paletteEl = null; }
  paletteTarget = null;
  paletteSelectedIdx = 0;
}

export function updatePaletteSelection(delta) {
  if (!paletteEl) return;
  const items = paletteEl.querySelectorAll('.agp-item');
  if (items.length === 0) return;
  items[paletteSelectedIdx].classList.remove('active');
  paletteSelectedIdx = (paletteSelectedIdx + delta + items.length) % items.length;
  items[paletteSelectedIdx].classList.add('active');
  items[paletteSelectedIdx].scrollIntoView({ block: 'nearest' });
}

export function selectPaletteCommand(cmdName) {
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
    showResultBadge(`Command failed: ${err.message}`);
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
