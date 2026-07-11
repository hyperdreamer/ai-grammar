// AI Grammar Checker — Popup script

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8766;
const DEFAULT_LIVE_DELAY = 5;
const DEFAULT_LIVE_MIN_CHARS = 30;
const DEFAULT_MAX_TOKENS = 4096;

const enabledToggle = document.getElementById('enabled');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const liveDelayInput = document.getElementById('live-delay');
const liveMinCharsInput = document.getElementById('live-min-chars');
const maxTokensInput = document.getElementById('max-tokens');
const statusEl = document.getElementById('status');
const testBtn = document.getElementById('test-page');
const backendStatus = document.getElementById('backend-status');
const settingsGear = document.getElementById('settings-gear');
const settingsPanel = document.getElementById('backend-settings-panel');

// ---------------------------------------------------------------------------
// Settings gear toggle
// ---------------------------------------------------------------------------

settingsGear.addEventListener('click', () => {
  const isOpen = !settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', isOpen);
  settingsGear.classList.toggle('active', !isOpen);
});

// ---------------------------------------------------------------------------
// Load settings on open
// ---------------------------------------------------------------------------

async function init() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: 'grammar:get-settings' });
    enabledToggle.checked = settings.grammarEnabled !== false;
    hostInput.value = settings.grammarHost || DEFAULT_HOST;
    portInput.value = settings.grammarPort || DEFAULT_PORT;
    liveDelayInput.value = settings.grammarLiveDelay || DEFAULT_LIVE_DELAY;
    liveMinCharsInput.value = settings.grammarLiveMinChars || DEFAULT_LIVE_MIN_CHARS;
    maxTokensInput.value = settings.grammarMaxTokens ?? DEFAULT_MAX_TOKENS;
  } catch {
    const stored = await chrome.storage.sync.get({
      grammarEnabled: true,
      grammarHost: DEFAULT_HOST,
      grammarPort: DEFAULT_PORT,
      grammarLiveDelay: DEFAULT_LIVE_DELAY,
      grammarLiveMinChars: DEFAULT_LIVE_MIN_CHARS,
      grammarMaxTokens: DEFAULT_MAX_TOKENS,
    });
    enabledToggle.checked = stored.grammarEnabled;
    hostInput.value = stored.grammarHost;
    portInput.value = stored.grammarPort;
    liveDelayInput.value = stored.grammarLiveDelay;
    liveMinCharsInput.value = stored.grammarLiveMinChars;
    maxTokensInput.value = stored.grammarMaxTokens;
  }

  checkBackend();
}

// ---------------------------------------------------------------------------
// Backend health check
// ---------------------------------------------------------------------------

async function checkBackend() {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  const url = `http://${host}:${port}/health`;

  try {
    const resp = await fetch(url);
    if (resp.ok) {
      backendStatus.innerHTML = '<span class="dot online"></span> Backend connected';
    } else {
      backendStatus.innerHTML = '<span class="dot offline"></span> Backend offline';
    }
  } catch {
    backendStatus.innerHTML = '<span class="dot offline"></span> Backend offline';
  }
}

// ---------------------------------------------------------------------------
// Open test page
// ---------------------------------------------------------------------------

testBtn.addEventListener('click', async () => {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  const url = `http://${host}:${port}/static/grammar-test.html`;
  await chrome.tabs.create({ url });
});

// ---------------------------------------------------------------------------
// Save on change
// ---------------------------------------------------------------------------

function showStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

enabledToggle.addEventListener('change', async () => {
  await chrome.storage.sync.set({ grammarEnabled: enabledToggle.checked });
  showStatus(enabledToggle.checked ? 'Enabled ✓' : 'Disabled');
});

hostInput.addEventListener('change', saveHostPort);
portInput.addEventListener('change', saveHostPort);

async function saveHostPort() {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  await chrome.storage.sync.set({ grammarHost: host, grammarPort: port });
  showStatus('Host/port saved ✓');
  checkBackend();
}

let liveDelayDebounce = null;
liveDelayInput.addEventListener('input', () => {
  clearTimeout(liveDelayDebounce);
  liveDelayDebounce = setTimeout(async () => {
    const val = Math.max(1, Math.min(30, parseInt(liveDelayInput.value, 10) || DEFAULT_LIVE_DELAY));
    liveDelayInput.value = val;
    await chrome.storage.sync.set({ grammarLiveDelay: val });
    showStatus('Live delay saved ✓');
  }, 400);
});

let minCharsDebounce = null;
liveMinCharsInput.addEventListener('input', () => {
  clearTimeout(minCharsDebounce);
  minCharsDebounce = setTimeout(async () => {
    const val = Math.max(5, Math.min(500, parseInt(liveMinCharsInput.value, 10) || DEFAULT_LIVE_MIN_CHARS));
    liveMinCharsInput.value = val;
    await chrome.storage.sync.set({ grammarLiveMinChars: val });
    showStatus('Min chars saved ✓');
  }, 400);
});

let maxTokensDebounce = null;
maxTokensInput.addEventListener('input', () => {
  clearTimeout(maxTokensDebounce);
  maxTokensDebounce = setTimeout(async () => {
    const val = Math.max(0, Math.min(16384, parseInt(maxTokensInput.value, 10) || 0));
    maxTokensInput.value = val;
    await chrome.storage.sync.set({ grammarMaxTokens: val });
    showStatus('Max tokens saved ✓');
  }, 400);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

init();
