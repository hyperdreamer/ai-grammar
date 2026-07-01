// AI Grammar Checker — Background service worker
//
// Responsibilities:
// - Route grammar check requests to the backend
// - Manage per-tab check state
// - Handle keyboard shortcut (check selected text)

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8766;

// Per-tab controllers for aborting in-flight checks
const checkControllers = new Map();

// ---------------------------------------------------------------------------
// Backend communication
// ---------------------------------------------------------------------------

async function getBackendUrl() {
  const items = await chrome.storage.sync.get({
    grammarHost: DEFAULT_HOST,
    grammarPort: DEFAULT_PORT,
  });
  return `http://${items.grammarHost}:${items.grammarPort}`;
}

async function getLanguage() {
  const items = await chrome.storage.sync.get({ grammarLanguage: 'auto' });
  return items.grammarLanguage;
}

async function getEnabled() {
  const items = await chrome.storage.sync.get({ grammarEnabled: true });
  return items.grammarEnabled;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'grammar:check') {
    handleCheck(message, sender.tab?.id)
      .then(sendResponse)
      .catch(err => {
        console.error('[AI Grammar BG] handleCheck failed:', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true; // async
  }

  if (message?.type === 'grammar:check-stop') {
    handleStop(message.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'grammar:get-settings') {
    getSettings()
      .then(sendResponse)
      .catch(err => {
        console.error('[AI Grammar BG] getSettings failed:', err);
        sendResponse({});
      });
    return true;
  }

  if (message?.type === 'grammar:apply-fix') {
    handleApplyFix(message.text, sender.tab?.id)
      .then(sendResponse)
      .catch(err => {
        console.error('[AI Grammar BG] apply fix failed:', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true; // async
  }
});

async function handleCheck(msg, tabId) {
  const { text, id } = msg;
  if (!text || !text.trim()) {
    return { ok: false, error: 'No text to check' };
  }

  const enabled = await getEnabled();
  if (!enabled) {
    return { ok: false, error: 'Grammar checker is disabled' };
  }

  // Abort any previous check for this tab
  handleStop(tabId);

  const controller = new AbortController();
  checkControllers.set(tabId, controller);

  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const baseUrl = await getBackendUrl();
    const language = await getLanguage();
    const url = `${baseUrl}/check?_=${Date.now()}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      return { ok: false, error: `Backend error (${resp.status}): ${errBody.slice(0, 200)}`, id };
    }

    const data = await resp.json();
    return { ok: true, errors: data.errors || [], model: data.model || '', id };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: true, aborted: true, id };
    return { ok: false, error: e.message, id };
  } finally {
    clearTimeout(timeoutId);
    checkControllers.delete(tabId);
  }
}

function handleStop(tabId) {
  const c = checkControllers.get(tabId);
  if (c) {
    c.abort();
    checkControllers.delete(tabId);
  }
}

async function getSettings() {
  const items = await chrome.storage.sync.get({
    grammarHost: DEFAULT_HOST,
    grammarPort: DEFAULT_PORT,
    grammarEnabled: true,
    grammarLanguage: 'auto',
    grammarLiveDelay: 5,
    grammarLiveMinChars: 30,
    grammarMaxTokens: 4096,
  });
  return items;
}

// ---------------------------------------------------------------------------
// Keyboard shortcut: check selected text
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'check-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Inject a script to extract selection + trigger check
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'grammar:check-selection' });
  } catch {
    // Content script may not be ready
  }
});

// ---------------------------------------------------------------------------
// Tab cleanup
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  handleStop(tabId);
});

// ---------------------------------------------------------------------------
// Apply fix via CDP — keyboard simulation for Lexical editors (WhatsApp)
// ---------------------------------------------------------------------------

// Character → CDP key event mapping
const CHAR_KEY_MAP = {
  ' ':  { key: ' ', code: 'Space', vk: 32, mod: 0 },
  '.':  { key: '.', code: 'Period', vk: 190, mod: 0 },
  ',':  { key: ',', code: 'Comma', vk: 188, mod: 0 },
  '!':  { key: '!', code: 'Digit1', vk: 49, mod: 1 },
  '?':  { key: '?', code: 'Slash', vk: 191, mod: 1 },
  "'":  { key: "'", code: 'Quote', vk: 222, mod: 0 },
  '"':  { key: '"', code: 'Quote', vk: 222, mod: 1 },
  '-':  { key: '-', code: 'Minus', vk: 189, mod: 0 },
  ':':  { key: ':', code: 'Semicolon', vk: 186, mod: 1 },
  ';':  { key: ';', code: 'Semicolon', vk: 186, mod: 0 },
  '(':  { key: '(', code: 'Digit9', vk: 57, mod: 1 },
  ')':  { key: ')', code: 'Digit0', vk: 48, mod: 1 },
  '\n': { key: 'Enter', code: 'Enter', vk: 13, mod: 0 },
};

function charToKeyInfo(c) {
  if (CHAR_KEY_MAP[c]) return CHAR_KEY_MAP[c];
  if (c >= 'A' && c <= 'Z') return { key: c.toLowerCase(), code: 'Key' + c, vk: c.charCodeAt(0), mod: 1 };
  if (c >= 'a' && c <= 'z') return { key: c, code: 'Key' + c.toUpperCase(), vk: c.toUpperCase().charCodeAt(0), mod: 0 };
  if (c >= '0' && c <= '9') return { key: c, code: 'Digit' + c, vk: c.charCodeAt(0), mod: 0 };
  return { key: c, code: 'Key' + c.toUpperCase(), vk: c.charCodeAt(0) || 0, mod: 0 };
}

function dispatchKey(params) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId: params._tabId }, 'Input.dispatchKeyEvent', {
      type: params.type,
      key: params.key,
      code: params.code,
      modifiers: params.modifiers || 0,
      windowsVirtualKeyCode: params.windowsVirtualKeyCode || 0,
      text: params.text,
    }, resolve);
  });
}

async function handleApplyFix(text, tabId) {
  if (!text || !tabId) return { ok: false, error: 'Missing text or tabId' };

  try {
    // Attach debugger
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Enable Runtime for JS evaluation
    await new Promise(resolve => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}, resolve);
    });

    // Focus the contentEditable via JS
    const focusResult = await new Promise(resolve => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector('div[contenteditable="true"][role="textbox"]');
            if (el) { el.focus(); return true; }
            const el2 = document.querySelector('footer div[contenteditable="true"]');
            if (el2) { el2.focus(); return true; }
            return false;
          })()
        `,
        returnByValue: true,
      }, resolve);
    });

    const focused = focusResult?.result?.value;
    if (!focused) {
      await detachDebugger(tabId);
      return { ok: false, error: 'Could not focus WhatsApp input' };
    }

    // Helper to dispatch a keyDown+keyUp pair
    const _tabId = tabId;
    const pressKey = async (key, code, vk, mod, txt) => {
      const base = { _tabId, key, code, modifiers: mod || 0, windowsVirtualKeyCode: vk || 0, text: txt };
      await dispatchKey({ ...base, type: 'keyDown' });
      await sleep(10);
      await dispatchKey({ ...base, type: 'keyUp' });
    };

    // Ctrl+A (select all)
    await dispatchKey({ _tabId, type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await sleep(30);
    await dispatchKey({ _tabId, type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await sleep(50);

    // Backspace (delete)
    await pressKey('Backspace', 'Backspace', 8, 0, '');
    await sleep(80);

    // Type each character
    for (const c of text) {
      const info = charToKeyInfo(c);
      await pressKey(info.key, info.code, info.vk, info.mod, c);
      await sleep(15);  // small delay between chars
    }

    // Detach
    await detachDebugger(tabId);
    return { ok: true };

  } catch (e) {
    await detachDebugger(tabId).catch(() => {});
    return { ok: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function detachDebugger(tabId) {
  return new Promise(resolve => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}
