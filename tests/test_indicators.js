/**
 * Real showErrorFloat CSP-safety test.
 *
 * Loads the actual indicators.js source and verifies that clicking the
 * .agf-close button calls removeErrorFloat to remove the panel; no
 * inline onclick remains in the source.
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
src += '\nglobalThis.__test = { showErrorFloat, removeErrorFloat };\n';

// ── Create sandbox with mock DOM ──────────────────────────────────────
function createSandbox() {
  const _bodyChildren = [];
  const _listeners = {}; // id -> { type: fn }

  return {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
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

assert.ok(typeof showErrorFloat === 'function', 'showErrorFloat should be a function');
assert.ok(typeof removeErrorFloat === 'function', 'removeErrorFloat should be a function');

// ── Test: showErrorFloat + close button removes panel ─────────────────
{
  const errors = [{ error: 'helo', correction: 'hello', explanation: 'Spelling' }];
  showErrorFloat(errors);

  const panel = sandbox.document.getElementById('ai-grammar-float');
  assert.ok(panel, 'Panel should be in the DOM after showErrorFloat');

  // Verify no inline onclick in the innerHTML (CSP-safe)
  assert.ok(!panel._innerHTML.includes('onclick="'),
    'innerHTML must not contain inline onclick attribute');

  // Simulate close button click
  const closeBtn = panel.querySelector('.agf-close');
  assert.ok(closeBtn, 'Close button should exist in the panel');
  closeBtn.click();

  // Panel should be removed
  const panelAfter = sandbox.document.getElementById('ai-grammar-float');
  assert.strictEqual(panelAfter, null, 'Panel should be removed after close button click');

  console.log('  PASS: showErrorFloat close button removes panel via event listener');
}

console.log('\n  All indicators tests passed.\n');
