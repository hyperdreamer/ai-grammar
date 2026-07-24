/**
 * Real showErrorFloat CSP-safety and timer-ownership tests.
 *
 * Loads the actual indicators.js source and verifies:
 *   1. replacing panel A with panel B clears A's timer;
 *   2. firing stale A callback cannot remove B;
 *   3. B remains until its own timer fires, then is removed;
 *   4. manual close/remove clears B's timer.
 *
 * Uses Node built-ins only — no new dependencies.
 */
'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ── Read and transform indicators.js source ──────────────────────────
const srcPath = path.resolve(__dirname, '..', 'extension', 'src', 'indicators.js');
let src = fs.readFileSync(srcPath, 'utf8');

// Remove all import statements
src = src.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '// import stripped');
// Remove top-level export keywords
src = src.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
src = src.replace(/^export\s+(let|const)\s/gm, 'var ');
src = src.replace(/^export\s+var\s/gm, 'var ');
src = src.replace(/^(let|const)\s/gm, 'var ');
src = src.replace(/^export\s+\{/gm, '// export stripped {');

// Append export hook
src += '\nglobalThis.__test = { showErrorFloat, removeErrorFloat, removeAllBadges, showGreenCheck, removeGreenCheck, removeLiveDraftGreenChecks, removeAllGreenChecks, _errorFloatTimer };\n';

// ── Fake timers (controlled by tests) ──────────────────────────────────
let _timerId = 0;
const _pendingTimers = []; // [{id, fn}]

function fakeSetTimeout(fn, ms) {
  const id = ++_timerId;
  _pendingTimers.push({ id, fn });
  return id;
}

function fakeClearTimeout(id) {
  const idx = _pendingTimers.findIndex(t => t.id === id);
  if (idx >= 0) _pendingTimers.splice(idx, 1);
}

function fireAllTimers() {
  while (_pendingTimers.length) {
    const t = _pendingTimers.shift();
    t.fn();
  }
}

function pendingTimerCount() {
  return _pendingTimers.length;
}

// ── Helpers for green-check tests ─────────────────────────────────────
function createMockContainer(tagName = 'DIV', overrides = {}) {
  return {
    tagName,
    contentEditable: 'inherit',
    isContentEditable: false,
    getBoundingClientRect() { return { top: 100, bottom: 200, left: 100, right: 300, width: 200, height: 100 }; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    ...overrides,
  };
}

// ── Create sandbox with mock DOM ──────────────────────────────────────
function createSandbox() {
  const _bodyChildren = [];
  const _listeners = {}; // id -> { type: fn }

  return {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    // Mock element factory
    _makeEl(tagName) {
      const el = {
        tagName,
        id: '',
        style: {},
        children: [],
        _removed: false,
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) {
          this._innerHTML = v;
          // Surface a close-button mock so querySelector('.agf-close') works
          if (v.includes('agf-close')) {
            this._closeBtn = {
              addEventListener(type, fn) {
                _listeners[this._id || 'agf-close'] = { type, fn };
              },
              click() {
                const l = _listeners[this._id || 'agf-close'];
                if (l) l.fn();
              },
              _id: this.id,
            };
          }
        },
        querySelector(sel) {
          if (sel === '.agf-close') return this._closeBtn || null;
          return null;
        },
        getBoundingClientRect() {
          return { top: 100, bottom: 200, left: 100, right: 300, width: 200, height: 100 };
        },
        addEventListener() {},
        setAttribute() {},
        remove() { this._removed = true; const i = _bodyChildren.indexOf(this); if (i >= 0) _bodyChildren.splice(i, 1); },
        appendChild(c) { this.children.push(c); },
        offsetHeight: 100,
      };
      return el;
    },
    document: {
      body: {
        appendChild(el) { _bodyChildren.push(el); },
      },
      createElement(tagName) { return this._makeEl(tagName); },
      getElementById(id) { return _bodyChildren.find(c => c.id === id) || null; },
      querySelector(sel) { return null; },
      contains(el) { return _bodyChildren.includes(el); },
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return {}; },
      innerWidth: 1200,
      innerHeight: 800,
    },
    navigator: {},
    Event: function Event(type) { this.type = type; },
    // Mock state used by indicators
    state: {
      badgeCounters: { checking: 0, fixing: 0, polishing: 0, translating: 0 },
      badgeLabels: {},
      activeBadges: new Map(),
      greenCheckTimers: new Map(),
      resultBadgeTimer: null,
    },
    escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)); },
    isIgnored() { return false; },
    isConnectedToDocument() { return true; },
  };
}

// ── Run the transformed source ────────────────────────────────────────
const sandbox = createSandbox();
// Make sandbox reference itself for _makeEl
sandbox.document._makeEl = sandbox._makeEl.bind(sandbox);
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'indicators.js' });

const showErrorFloat = ctx.__test.showErrorFloat;
const removeErrorFloat = ctx.__test.removeErrorFloat;

const removeAllBadges = ctx.__test.removeAllBadges;
assert.ok(typeof removeAllBadges === 'function', 'removeAllBadges should be a function');
assert.ok(typeof showErrorFloat === 'function', 'showErrorFloat should be a function');
assert.ok(typeof removeErrorFloat === 'function', 'removeErrorFloat should be a function');

// ── Tests ──────────────────────────────────────────────────────────────

// Test 1: Replacing panel A with panel B clears A's timer
{
  while (_pendingTimers.length) _pendingTimers.pop();

  showErrorFloat([{ error: 'helo', correction: 'hello' }]);
  assert.strictEqual(_pendingTimers.length, 1, 'Test1: A should have 1 pending timer');

  showErrorFloat([{ error: 'wrld', correction: 'world' }]);
  // showErrorFloat internally calls removeErrorFloat which clears A's timer
  assert.strictEqual(_pendingTimers.length, 1, "Test1: only B's timer remains after replace");

  console.log("  PASS: replacing panel A with panel B clears A's timer");
}

// Test 2: Firing stale A callback cannot remove B
{
  while (_pendingTimers.length) _pendingTimers.pop();

  showErrorFloat([{ error: 'helo', correction: 'hello' }]);
  assert.strictEqual(_pendingTimers.length, 1, 'Test2: A has 1 timer');

  // Save A's callback before showErrorFloat(B) clears it
  const timerA = _pendingTimers[0].fn;

  showErrorFloat([{ error: 'wrld', correction: 'world' }]);
  assert.strictEqual(_pendingTimers.length, 1, 'Test2: B has 1 timer after clearing A');

  // Manually fire A's stale callback — it must be a no-op
  timerA();

  const panelAfterStale = sandbox.document.getElementById('ai-grammar-float');
  assert.ok(panelAfterStale, 'Test2: B panel should still be in DOM after stale A callback');

  console.log('  PASS: firing stale A callback cannot remove B');
}

// Test 3: B remains until its own timer fires, then is removed
{
  while (_pendingTimers.length) _pendingTimers.pop();

  showErrorFloat([{ error: 'wrld', correction: 'world' }]);
  assert.strictEqual(_pendingTimers.length, 1, 'Test3: B has 1 pending timer');

  fireAllTimers();

  const panelAfter = sandbox.document.getElementById('ai-grammar-float');
  assert.strictEqual(panelAfter, null, 'Test3: B should be removed after its own timer fires');

  console.log('  PASS: B remains until its own timer fires, then is removed');
}

// Test 4: Manual close/remove clears B's timer
{
  while (_pendingTimers.length) _pendingTimers.pop();

  showErrorFloat([{ error: 'wrld', correction: 'world' }]);
  assert.strictEqual(_pendingTimers.length, 1, 'Test4: B has 1 pending timer');

  const panel = sandbox.document.getElementById('ai-grammar-float');
  const closeBtn = panel.querySelector('.agf-close');
  closeBtn.click();

  assert.strictEqual(sandbox.document.getElementById('ai-grammar-float'), null, 'Test4: panel removed');
  assert.strictEqual(_pendingTimers.length, 0, "Test4: B's timer cleared after manual close");

  console.log("  PASS: manual close/remove clears B's timer");
}

// Test 5: removeAllBadges cancels resultBadgeTimer and sets it null
{
  while (_pendingTimers.length) _pendingTimers.pop();

  var badgeEl = sandbox._makeEl('div');
  sandbox.state.activeBadges.set('result:test', { el: badgeEl });
  sandbox.state.resultBadgeTimer = fakeSetTimeout(function() {}, 5000);
  sandbox.state.badgeCounters.checking = 1;
  assert.strictEqual(pendingTimerCount(), 1, 'Test5: resultBadgeTimer should be pending');
  assert.ok(sandbox.state.resultBadgeTimer !== null, 'Test5: resultBadgeTimer should be set');

  removeAllBadges();

  assert.strictEqual(sandbox.state.resultBadgeTimer, null, 'Test5: resultBadgeTimer should be null after removeAllBadges');
  assert.strictEqual(pendingTimerCount(), 0, 'Test5: timer should be cancelled');
  assert.strictEqual(sandbox.state.activeBadges.size, 0, 'Test5: all badges removed');
  assert.strictEqual(sandbox.state.badgeCounters.checking, 0, 'Test5: counters reset');

  console.log('  PASS: removeAllBadges cancels resultBadgeTimer and sets it null');
}

// ── Scope-based green-check lifecycle tests ───────────────────────────
const showGreenCheck = ctx.__test.showGreenCheck;
const removeGreenCheck = ctx.__test.removeGreenCheck;
const removeLiveDraftGreenChecks = ctx.__test.removeLiveDraftGreenChecks;
const removeAllGreenChecks = ctx.__test.removeAllGreenChecks;

// Test 6: live-draft green check is removed by removeLiveDraftGreenChecks
{
  removeAllGreenChecks();

  const textarea = createMockContainer('TEXTAREA');
  showGreenCheck(textarea, 'hello', { scope: 'live-draft' });
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test6: should have 1 green check');
  const entry = sandbox.state.greenCheckTimers.get(textarea);
  assert.strictEqual(entry.scope, 'live-draft', 'Test6: scope should be live-draft');

  removeLiveDraftGreenChecks();
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 0, 'Test6: live-draft check should be removed');

  console.log('  PASS: live-draft green check removed by removeLiveDraftGreenChecks');
}

// Test 7: static green check survives removeLiveDraftGreenChecks
{
  removeAllGreenChecks();

  const div = createMockContainer('DIV');
  showGreenCheck(div, 'world', { scope: 'static' });
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test7: should have 1 green check');

  removeLiveDraftGreenChecks();
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test7: static check should survive live-draft cleanup');

  removeAllGreenChecks();
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 0, 'Test7: removeAllGreenChecks clears static too');

  console.log('  PASS: static green check survives removeLiveDraftGreenChecks');
}

// Test 8: live-draft entry removed by scope, not DOM attribute
// Regression: contenteditable="plaintext-only" should also be cleaned up.
{
  removeAllGreenChecks();

  // Simulate a plaintext-only contentEditable — isContentEditable = true but
  // contentEditable is 'plaintext-only', not 'true'.
  const plaintextDiv = createMockContainer('DIV', {
    contentEditable: 'plaintext-only',
    isContentEditable: true,
  });
  showGreenCheck(plaintextDiv, 'hello', { scope: 'live-draft' });
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test8: should have 1 green check');

  // Old removeEditableGreenChecks would miss this because contentEditable !== 'true'.
  // New removeLiveDraftGreenChecks must catch it via scope.
  removeLiveDraftGreenChecks();
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 0,
    'Test8: plaintext-only live-draft must be removed via scope, not DOM attr');

  console.log('  PASS: plaintext-only contentEditable green check removed by scope');
}

// Test 9: mixed live-draft + static — only live-draft removed
{
  removeAllGreenChecks();

  const ta = createMockContainer('TEXTAREA');
  const div = createMockContainer('DIV');

  showGreenCheck(ta, 'draft', { scope: 'live-draft' });
  showGreenCheck(div, 'static', { scope: 'static' });
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 2, 'Test9: should have 2 green checks');

  removeLiveDraftGreenChecks();
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test9: only live-draft removed');
  assert.ok(sandbox.state.greenCheckTimers.has(div), 'Test9: static check should remain');

  removeAllGreenChecks();

  console.log('  PASS: mixed scope — only live-draft removed by removeLiveDraftGreenChecks');
}

// Test 10: cleanup removes reposition listeners and deletes map entry
{
  removeAllGreenChecks();

  let resizeRemoved = false;
  let scrollRemoved = false;
  const originalAdd = sandbox.window.addEventListener;
  const originalRemove = sandbox.window.removeEventListener;

  sandbox.window.addEventListener = function(type) {
    // no-op during add
  };
  sandbox.window.removeEventListener = function(type) {
    if (type === 'resize') resizeRemoved = true;
    if (type === 'scroll') scrollRemoved = true;
  };

  const ta = createMockContainer('TEXTAREA');
  showGreenCheck(ta, 'test', { scope: 'live-draft' });

  // Reset mock for remove assertions
  sandbox.window.addEventListener = originalAdd;

  assert.strictEqual(sandbox.state.greenCheckTimers.size, 1, 'Test10: should have 1 check');

  removeGreenCheck(ta);
  assert.strictEqual(sandbox.state.greenCheckTimers.size, 0, 'Test10: entry deleted from map');
  assert.ok(resizeRemoved, 'Test10: resize listener removed');
  assert.ok(scrollRemoved, 'Test10: scroll listener removed');

  sandbox.window.removeEventListener = originalRemove;

  console.log('  PASS: removeGreenCheck cleans up listeners and deletes map entry');
}

console.log('\n  All indicators tests passed.\n');
