// AI Grammar Checker — Content script
//
// Runs on every page. Watches for newly submitted text content,
// sends it to the backend for grammar checking, and highlights errors
// with tooltips showing corrections.

// -----------------------------------------------------------------------
// Module imports — side-effect modules wire themselves at import time
// -----------------------------------------------------------------------

// State must come first — all other modules import from it
import './state.js';

// Side-effect modules — register event listeners at import time
import './events.js';
import './selection-check.js';
import './api.js';

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------

import { init } from './init.js';

if (!window.__aiGrammarLoaded) {
  window.__aiGrammarLoaded = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
