/**
 * Real detachEditor abort-coverage test.
 *
 * Loads the actual teams-bridge.js source (IIFE-stripped) via vm and verifies
 * detachEditor calls abortPolish, abortTranslate, and fixAbortController.abort
 * with proper cleanup.
 *
 * Uses Node built-ins only — no new dependencies.
 */
'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ── Read and transform teams-bridge.js source ────────────────────────
const srcPath = path.resolve(__dirname, '..', 'extension', 'teams-bridge.js');
let src = fs.readFileSync(srcPath, 'utf8');

// Strip outer IIFE
const iifeOpen = src.indexOf('(function () {');
const iifeClose = src.lastIndexOf('})();');
if (iifeOpen < 0 || iifeClose < 0) throw new Error('Cannot find IIFE wrapper');
src = src.substring(iifeOpen);
src = src.replace(/^\(function\s*\(\)\s*\{/, '');
src = src.replace(/^\s*'use strict';\s*/, '');

// Remove the Teams-only guard
src = src.replace(/const isTeams = [^;]+;\s*if\s*\(!isTeams\)\s*return;?/, '// guard removed');

// Remove auto-init and cleanup at the end
const lastCleanup = src.lastIndexOf('cleanup();');
if (lastCleanup >= 0) {
  let cutPoint = src.lastIndexOf('// ── Start', lastCleanup);
  if (cutPoint < 0) cutPoint = src.lastIndexOf('if (document.readyState', lastCleanup);
  if (cutPoint < 0) cutPoint = lastCleanup - 30;
  src = src.substring(0, cutPoint);
}
src = src.replace(/\}\)\(\);?\s*$/, '');

// Convert let/const to var (including indented) so variables are ctx-accessible
src = src.replace(/^(\s*)(let|const)\s/gm, '$1var ');

// Add export hooks
src += '\nglobalThis.__test = { detachEditor, abortPolish, abortTranslate };\n';

// ── Spy helpers ──────────────────────────────────────────────────────
function makeSpy() {
  const calls = [];
  const fn = function() { calls.push(Array.from(arguments)); };
  fn.calls = calls;
  Object.defineProperty(fn, 'called', { get() { return calls.length > 0; } });
  return fn;
}

// ── Create sandbox ───────────────────────────────────────────────────
const _removePendingBadge = makeSpy();
const _abortPolishSpy = makeSpy();
const _abortTranslateSpy = makeSpy();
const _fixAbortSpy = makeSpy();
const _grammarAbortSpy = makeSpy();

const sandbox = {
  console: { debug() {}, log() {}, warn() {}, error() {} },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  location: { hostname: 'teams.microsoft.com' },
  document: {
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    contains() { return true; },
    querySelector() { return null; },
    createElement() { return { style: {}, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
  },
  window: {
    __aiGrammar: {
      removePendingBadge: _removePendingBadge,
      showPendingBadge() {},
      showResultBadge() {},
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return {}; },
    postMessage() {},
    innerWidth: 1200,
    innerHeight: 800,
  },
  chrome: {
    runtime: { id: 'test-ext-id' },
    storage: {
      sync: { get() {}, set() {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  },
  MutationObserver: function() {
    return { observe() {}, disconnect() {}, takeRecords() { return []; } };
  },
  Event: function Event(type) { this.type = type; },
  navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
  HTMLUnknownElement: function() {},
};

const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'teams-bridge.js' });

const detachEditor = ctx.__test.detachEditor;
const abortPolish = ctx.__test.abortPolish;
const abortTranslate = ctx.__test.abortTranslate;

assert.ok(typeof detachEditor === 'function', 'detachEditor should be a function');
assert.ok(typeof abortPolish === 'function', 'abortPolish should be a function');
assert.ok(typeof abortTranslate === 'function', 'abortTranslate should be a function');

// ── Tests ───────────────────────────────────────────────────────────

// Set up state so detachEditor aborts in-flight work
ctx.editorElement = { removeEventListener() {}, tagName: 'DIV' };
ctx.editorMo = { disconnect() {} };
ctx.changeDataUnbind = null;

ctx.polishAbortController = { abort: _abortPolishSpy };
ctx.translateAbortController = { abort: _abortTranslateSpy };
ctx.fixAbortController = { abort: _fixAbortSpy };
ctx.abortController = { abort: _grammarAbortSpy };

detachEditor();

assert.ok(_abortPolishSpy.called, 'abortPolish should be called by detachEditor');
assert.ok(_abortTranslateSpy.called, 'abortTranslate should be called by detachEditor');
assert.ok(_fixAbortSpy.called, 'fixAbortController.abort should be called by detachEditor');
assert.ok(_grammarAbortSpy.called, 'grammar abortController.abort should still be called');

assert.strictEqual(ctx.fixAbortController, null, 'fixAbortController should be null after detachEditor');
assert.strictEqual(ctx.polishAbortController, null, 'polishAbortController should be null after abortPolish');

const fixingCalls = _removePendingBadge.calls.filter(c => c[0] === 'fixing');
assert.ok(fixingCalls.length > 0, 'removePendingBadge("fixing") should be called');

console.log('  PASS: detachEditor aborts polish, translate, and fix');

// ── Test: detachEditor with null controllers is safe ────────────────
{
  _abortPolishSpy.calls.length = 0;
  _abortTranslateSpy.calls.length = 0;
  _fixAbortSpy.calls.length = 0;
  _grammarAbortSpy.calls.length = 0;
  _removePendingBadge.calls.length = 0;

  ctx.editorElement = { removeEventListener() {}, tagName: 'DIV' };
  ctx.editorMo = { disconnect() {} };
  ctx.polishAbortController = null;
  ctx.translateAbortController = null;
  ctx.fixAbortController = null;
  ctx.abortController = null;

  detachEditor();

  assert.ok(!_abortPolishSpy.called, 'null polish controller: no abort called');
  assert.ok(!_abortTranslateSpy.called, 'null translate controller: no abort called');
  assert.ok(!_fixAbortSpy.called, 'null fix controller: no abort called');

  console.log('  PASS: detachEditor handles null controllers safely');
}

console.log('\n  All teams-bridge tests passed.\n');
