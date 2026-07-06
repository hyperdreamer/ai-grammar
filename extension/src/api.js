// AI Grammar Checker — Shared backend API wrappers
//
// Thin fetch wrappers around the grammar backend's three POST endpoints
// (/check, /polish, /translate).  All callers (teams-bridge.js,
// commands.js) share these so URL construction, timeouts, abort handling
// and error formatting stay consistent.

import { safeGetStorage } from './state.js';

// -----------------------------------------------------------------------
// Internal: combine caller's signal with an internal timeout
// -----------------------------------------------------------------------

/**
 * Build a URL to the local grammar backend.  No cache-busting — the
 * server treats each request as stateless.
 */
function backendUrl(endpoint, settings) {
  return `http://${settings.grammarHost}:${settings.grammarPort}${endpoint}`;
}

/**
 * Run a POST request with caller signal + internal timeout.  Returns the
 * raw fetch Response on success, or an error/aborted envelope on failure.
 */
async function postJson(url, body, signal, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort());
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Convert a !resp.ok into a structured error envelope.
 */
async function errorEnvelope(resp) {
  const body = await resp.text().catch(() => '');
  return { ok: false, error: `Backend error (${resp.status}): ${body.slice(0, 200)}` };
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * POST /check — grammar check returning a list of errors.
 *
 * opts: { signal, language = 'auto', maxTokens }
 * Returns:
 *   { ok: true, errors: [...], model: '' }
 *   { ok: true, aborted: true }
 *   { ok: false, error: '...' }
 */
export async function checkGrammar(text, opts = {}) {
  const { signal, language = 'auto', maxTokens } = opts;
  const settings = await safeGetStorage({ grammarHost: '127.0.0.1', grammarPort: 8766 });
  const body = { text, language };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  try {
    const resp = await postJson(backendUrl('/check', settings), body, signal, 30000);
    if (!resp.ok) return errorEnvelope(resp);
    const data = await resp.json();
    return { ok: true, errors: data.errors || [], model: data.model || '' };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: true, aborted: true };
    return { ok: false, error: e.message };
  }
}

/**
 * POST /polish — rewrite text for grammar/style/clarity.
 *
 * opts: { signal, language = 'auto' }
 * Returns:
 *   { ok: true, polished: '', model: '' }
 *   { ok: true, aborted: true }
 *   { ok: false, error: '...' }
 */
export async function polishGrammar(text, opts = {}) {
  const { signal, language = 'auto' } = opts;
  const settings = await safeGetStorage({ grammarHost: '127.0.0.1', grammarPort: 8766 });
  try {
    const resp = await postJson(
      backendUrl('/polish', settings),
      { text, language },
      signal,
      60000,
    );
    if (!resp.ok) return errorEnvelope(resp);
    const data = await resp.json();
    return { ok: true, polished: data.polished || '', model: data.model || '' };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: true, aborted: true };
    return { ok: false, error: e.message };
  }
}

/**
 * POST /translate — translate text into the target language.
 *
 * opts: { signal }
 * Returns:
 *   { ok: true, translated: '', model: '' }
 *   { ok: true, aborted: true }
 *   { ok: false, error: '...' }
 */
export async function translateText(text, targetLang, opts = {}) {
  const { signal } = opts;
  const settings = await safeGetStorage({ grammarHost: '127.0.0.1', grammarPort: 8766 });
  try {
    const resp = await postJson(
      backendUrl('/translate', settings),
      { text, target_lang: targetLang },
      signal,
      60000,
    );
    if (!resp.ok) return errorEnvelope(resp);
    const data = await resp.json();
    return { ok: true, translated: data.translated || '', model: data.model || '' };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: true, aborted: true };
    return { ok: false, error: e.message };
  }
}

// -----------------------------------------------------------------------
// Bridge: expose shared functions on window.__aiGrammar alongside
// existing exports (state, safeGetStorage, showResultBadge, etc.)
// -----------------------------------------------------------------------

window.__aiGrammar = window.__aiGrammar || {};
window.__aiGrammar.checkGrammar = checkGrammar;
window.__aiGrammar.polishGrammar = polishGrammar;
window.__aiGrammar.translateText = translateText;
