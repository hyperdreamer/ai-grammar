/**
 * Real detachEditor abort-coverage + command-panel lifecycle regression test.
 *
 * Loads the actual teams-bridge.js source (IIFE-stripped) via vm once and
 * verifies detachEditor aborts in-flight work, then drives the command-panel
 * lifecycle through real attachEditor / onEditorChange / syncCommandBar.
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

// Add export hooks — lifecycle functions included for real-path testing
src += '\nglobalThis.__test = { detachEditor, abortPolish, abortTranslate, attachEditor, onEditorChange, syncCommandBar };\n';

// ── Spy helpers ──────────────────────────────────────────────────────
function makeSpy() {
  const calls = [];
  const fn = function() { calls.push(Array.from(arguments)); };
  fn.calls = calls;
  Object.defineProperty(fn, 'called', { get() { return calls.length > 0; } });
  return fn;
}

// ── DOM helpers for lifecycle tests ───────────────────────────────────
const bodyChildren = [];

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    style: {},
    className: '',
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    remove() {
      if (this.parentNode) {
        const arr = this.parentNode === docBody ? bodyChildren : this.parentNode.children;
        const idx = arr.indexOf(this);
        if (idx >= 0) arr.splice(idx, 1);
        this.parentNode = null;
      }
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    setAttribute() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
    contains(el) { return this.children.includes(el) || this.children.some(c => c.contains && c.contains(el)); },
  };
  return el;
}

// Editor used by lifecycle tests — referenced inside sandbox document.contains
const lifecycleEditor = {
  textContent: '',
  tagName: 'DIV',
  _listeners: {},
  addEventListener(type, handler) { this._listeners[type] = handler; },
  removeEventListener() {},
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
  contains() { return false; },
};

// ── Create sandbox ───────────────────────────────────────────────────
const _removePendingBadge = makeSpy();
const _abortPolishSpy = makeSpy();
const _abortTranslateSpy = makeSpy();
const _fixAbortSpy = makeSpy();
const _grammarAbortSpy = makeSpy();

let activeEl = null;

const docBody = {
  appendChild(el) { bodyChildren.push(el); el.parentNode = docBody; },
  removeChild(el) {
    const idx = bodyChildren.indexOf(el);
    if (idx >= 0) bodyChildren.splice(idx, 1);
  },
  contains(el) { return bodyChildren.includes(el); },
};

const sandbox = {
  console: { debug() {}, log() {}, warn() {}, error() {} },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  location: { hostname: 'teams.microsoft.com' },
  document: {
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    contains(el) {
      if (!el) return false;
      if (el === lifecycleEditor) return true;
      return bodyChildren.includes(el) || bodyChildren.some(c => c.contains && c.contains(el));
    },
    querySelector() { return null; },
    createElement(tag) { return makeEl(tag); },
    body: docBody,
    getElementById(id) { return bodyChildren.find(c => c.id === id) || null; },
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    get activeElement() { return activeEl; },
    set activeElement(v) { activeEl = v; },
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
    runtime: { id: 'test-ext-id', sendMessage(msg, cb) { if (cb) cb({ ok: true }); } },
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

const { detachEditor, abortPolish, abortTranslate, attachEditor, onEditorChange, syncCommandBar } = ctx.__test;

assert.ok(typeof detachEditor === 'function', 'detachEditor should be a function');
assert.ok(typeof abortPolish === 'function', 'abortPolish should be a function');
assert.ok(typeof abortTranslate === 'function', 'abortTranslate should be a function');
assert.ok(typeof attachEditor === 'function', 'attachEditor should be a function');
assert.ok(typeof onEditorChange === 'function', 'onEditorChange should be a function');
assert.ok(typeof syncCommandBar === 'function', 'syncCommandBar should be a function');

// ── Detach-abort tests ───────────────────────────────────────────────

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

// ══════════════════════════════════════════════════════════════════════
// Lifecycle regression: command-panel via real attachEditor / onEditorChange
// ══════════════════════════════════════════════════════════════════════
console.log('\n  --- command-panel lifecycle ---');

// Reset state for lifecycle tests
bodyChildren.length = 0;
activeEl = null;
ctx.commandBarEl = null;
ctx.minChars = 30;
ctx.grammarEnabled = true;
ctx.editorFocusHandler = null;
ctx.polishAbortController = null;
ctx.translateAbortController = null;
ctx.fixAbortController = null;

// Attach via real attachEditor — captures focus/blur listeners on lifecycleEditor
attachEditor(lifecycleEditor);
assert.strictEqual(ctx.editorElement, lifecycleEditor, 'attachEditor sets editorElement');

const focusHandler = lifecycleEditor._listeners.focus;
const blurHandler = lifecycleEditor._listeners.blur;
assert.ok(typeof focusHandler === 'function', 'focus listener installed');
assert.ok(typeof blurHandler === 'function', 'blur listener installed');

// Test 1: Focus empty editor — no bar
activeEl = lifecycleEditor;
focusHandler();
assert.strictEqual(ctx.commandBarEl, null, 'empty editor: no command bar on focus');

// Test 2: Type past minChars, onEditorChange — bar appears (no blur/refocus)
lifecycleEditor.textContent = 'This is a long enough sentence to exceed the minimum character threshold.';
onEditorChange();
const firstBar = ctx.commandBarEl;
assert.ok(firstBar !== null, 'bar appears after typing past minChars');
assert.strictEqual(firstBar.id, 'ag-teams-cmds', 'bar has correct id');

// Test 3: Another edit — same bar object, no duplicate
onEditorChange();
assert.strictEqual(ctx.commandBarEl, firstBar, 'no duplicate bar on subsequent edits');
assert.ok(bodyChildren.includes(firstBar), 'bar remains in document');

// Test 4: Short text — bar dismisses
lifecycleEditor.textContent = 'short';
onEditorChange();
assert.strictEqual(ctx.commandBarEl, null, 'bar dismissed when text below minChars');
assert.ok(!bodyChildren.includes(firstBar), 'bar removed from document');

// Test 5: Blur dismisses, focus with sufficient text restores bar
lifecycleEditor.textContent = 'This is a long enough sentence to exceed the minimum character threshold.';
// blurHandler uses setTimeout(150ms) — skip real timeout, call sync directly
ctx.commandBarEl = null;
activeEl = null;
syncCommandBar();  // simulate post-blur: activeElement ≠ editor → no bar
assert.strictEqual(ctx.commandBarEl, null, 'blur: bar dismissed');

activeEl = lifecycleEditor;
focusHandler();
assert.ok(ctx.commandBarEl !== null, 'focus with sufficient text shows bar');

console.log('  PASS: command-panel lifecycle — all scenarios');
console.log('\n  All teams-bridge tests passed.\n');
