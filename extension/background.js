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
