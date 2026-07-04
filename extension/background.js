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

// Accept persistent port connections from content scripts — keeps worker alive
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'grammar-fix') {
    // Port accepted — worker stays alive while connected
  }
});

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

    // Focus the contentEditable via JS
    const focusResult = await new Promise(resolve => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('div[contenteditable="true"][role="textbox"]')
                  || document.querySelector('footer div[contenteditable="true"]');
          if (el) { el.focus(); return true; }
          return false;
        })()`,
        returnByValue: true,
      }, resolve);
    });

    if (!focusResult?.result?.value) {
      await detachDebugger(tabId);
      return { ok: false, error: 'Could not focus WhatsApp input' };
    }

    // Ctrl+A — select all text so Input.insertText replaces it
    await sendKey(tabId, 'keyDown', 'a', 'KeyA', 2, 65, '');
    await sleep(10);
    await sendKey(tabId, 'keyUp', 'a', 'KeyA', 2, 65, '');
    await sleep(10);

    // Input.insertText dispatches keyDown/keyUp for each character
    // internally — a single CDP call instead of the old N*2 loop
    await new Promise(resolve => {
      chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text }, resolve);
    });

    await detachDebugger(tabId);
    return { ok: true };

  } catch (e) {
    await detachDebugger(tabId).catch(() => {});
    return { ok: false, error: e.message };
  }
}

function sendKey(tabId, type, key, code, mod, vk, text) {
  return new Promise(resolve => {
    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers: mod || 0,
      windowsVirtualKeyCode: vk || 0,
      text: text || '',
    }, resolve);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function detachDebugger(tabId) {
  return new Promise(resolve => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

// ── CKEditor main-world bridge injection ──────────────────────────────
// teams-bridge.js requests injection so the bridge code runs in the MAIN
// world (where ckeditorInstance lives) without being blocked by page CSP.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ag-inject-cke-bridge' && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
        if (window.__agCKEBridge) return;
        window.__agCKEBridge = true;
        const POLL_MS = 500;
        (function poll() {
          const el = document.querySelector('.ck-editor__editable[contenteditable="true"]');
          const instance = el && el.ckeditorInstance;
          if (!instance) { setTimeout(poll, POLL_MS); return; }
          try {
            instance.model.document.on('change:data', function() {
              try {
                window.postMessage({source:'ag-cke-bridge', type:'change'}, '*');
              } catch(e) {}
            });
          } catch(e) {
            setTimeout(poll, POLL_MS);
          }
        })();
      }
    }).then(() => sendResponse({ok: true})).catch(e => sendResponse({ok: false, error: e.message}));
    return true; // keep channel open for async response
  }
});
