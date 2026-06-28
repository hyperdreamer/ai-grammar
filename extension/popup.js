// AI Grammar Checker — Popup script

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8766;

const enabledToggle = document.getElementById('enabled');
const languageSelect = document.getElementById('language');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const statusEl = document.getElementById('status');

// ---------------------------------------------------------------------------
// Load settings on open
// ---------------------------------------------------------------------------

async function init() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: 'grammar:get-settings' });
    enabledToggle.checked = settings.grammarEnabled !== false;
    languageSelect.value = settings.grammarLanguage || 'auto';
    hostInput.value = settings.grammarHost || DEFAULT_HOST;
    portInput.value = settings.grammarPort || DEFAULT_PORT;
  } catch {
    // Background may not be ready; use defaults
    const stored = await chrome.storage.sync.get({
      grammarEnabled: true,
      grammarLanguage: 'auto',
      grammarHost: DEFAULT_HOST,
      grammarPort: DEFAULT_PORT,
    });
    enabledToggle.checked = stored.grammarEnabled;
    languageSelect.value = stored.grammarLanguage;
    hostInput.value = stored.grammarHost;
    portInput.value = stored.grammarPort;
  }
}

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

languageSelect.addEventListener('change', async () => {
  await chrome.storage.sync.set({ grammarLanguage: languageSelect.value });
  showStatus('Language saved ✓');
});

hostInput.addEventListener('change', saveHostPort);
portInput.addEventListener('change', saveHostPort);

async function saveHostPort() {
  const host = hostInput.value.trim() || DEFAULT_HOST;
  const port = parseInt(portInput.value, 10) || DEFAULT_PORT;
  await chrome.storage.sync.set({ grammarHost: host, grammarPort: port });
  showStatus('Host/port saved ✓');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

init();
