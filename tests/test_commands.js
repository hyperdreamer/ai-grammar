/**
 * A1: Real applyPaletteCommand regression test.
 *
 * Loads the actual commands.js source (via source transform + vm) and verifies
 * that applyPaletteCommand('fix') passes the captured paletteTarget to
 * COMMANDS.fix.run as the second argument (ta).
 *
 * Uses Node built-ins only — no new dependencies.
 */
'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ── Read and transform commands.js source ─────────────────────────────
const srcPath = path.resolve(__dirname, '..', 'extension', 'src', 'commands.js');
let src = fs.readFileSync(srcPath, 'utf8');

// Remove all import statements (including multi-line)
src = src.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '// import stripped');

// Remove top-level export keywords
src = src.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
// Convert top-level let/const to var so they become context properties
src = src.replace(/^export\s+(let|const)\s/gm, 'var ');
src = src.replace(/^export\s+var\s/gm, 'var ');
src = src.replace(/^(let|const)\s/gm, 'var ');
src = src.replace(/^export\s+\{/gm, '// export stripped {');

// Append a VM-accessible export assignment so tests can read the real
// declarations without polluting the production source.
src += '\nglobalThis.__test = { applyPaletteCommand, COMMANDS, handleCommand };\n';

// ── Create sandbox with required globals ──────────────────────────────
function createSandbox() {
  return {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    chrome: {
      storage: {
        sync: { get() {}, set() {} },
        onChanged: { addListener() {}, removeListener() {} },
      },
      runtime: {
        getURL() { return ''; },
        onMessage: { addListener() {}, removeListener() {} },
      },
    },
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement() { return { style: {}, appendChild() {}, addEventListener() {} }; },
      querySelector() { return null; },
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return {}; },
    },
    AbortController: function AbortController() { this.signal = { aborted: false }; this.abort = function() { this.signal.aborted = true; }; },
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    Event: function Event(type) { this.type = type; },
    // These are overridden after creation
    showPendingBadge() {},
    removePendingBadge() {},
    showGreenCheck() {},
    state: { minChars: 10, commandInFlight: false },
  };
}

// ── Run the transformed source ────────────────────────────────────────
const sandbox = createSandbox();
let _badgeCapture = null;
// Override showResultBadge after sandbox creation so closure captures _badgeCapture
sandbox.showResultBadge = function(text) { _badgeCapture = text; };
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'commands.js' });

// Access the real functions via the VM-exported test hook
const applyPaletteCommand = ctx.__test.applyPaletteCommand;
const COMMANDS = ctx.__test.COMMANDS;
const handleCommand = ctx.__test.handleCommand;

assert.ok(typeof applyPaletteCommand === 'function', 'applyPaletteCommand should be a function');
assert.ok(COMMANDS, 'COMMANDS should be defined');

// ── Async main — ensures async failures don't escape assertions ───────
(async function main() {

// ── Test: applyPaletteCommand('fix') passes ta to COMMANDS.fix.run ────
{
  let capturedTa = null;
  let capturedArgs = null;

  COMMANDS.fix = {
    help: 'Fix grammar',
    async run(args, ta) {
      capturedArgs = args;
      capturedTa = ta;
    },
  };

  const ta = {
    tagName: 'TEXTAREA',
    value: 'Hello world ?/fix',
    textContent: '',
    focus() {},
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 50, right: 350 }; },
    dispatchEvent() {},
  };
  // paletteTarget is now var-scoped, so it's a context property
  ctx.paletteTarget = ta;

  await applyPaletteCommand('fix');

  assert.strictEqual(capturedTa, ta, 'COMMANDS.fix.run should receive ta as second argument');
  assert.strictEqual(capturedArgs, '', 'First arg should be empty string');

  console.log('  PASS: applyPaletteCommand passes captured target to COMMANDS.fix.run');
}

// ── Test: applyPaletteCommand('lang') passes ta to COMMANDS.lang.run ──
{
  let capturedTa = null;
  let capturedArgs = null;

  COMMANDS.lang = {
    help: 'Translate',
    async run(args, ta) {
      capturedArgs = args;
      capturedTa = ta;
    },
  };

  const ta = {
    tagName: 'TEXTAREA',
    value: 'Bonjour le monde ?/lang en',
    textContent: '',
    focus() {},
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 50, right: 350 }; },
    dispatchEvent() {},
  };
  ctx.paletteTarget = ta;

  await applyPaletteCommand('lang');

  assert.strictEqual(capturedTa, ta, 'COMMANDS.lang.run should receive ta');
  assert.strictEqual(capturedArgs, '', 'First arg should be empty string');

  console.log('  PASS: applyPaletteCommand passes target for lang command');
}

// ── Test: applyPaletteCommand('polish') passes ta ─────────────────────
{
  let capturedTa = null;

  COMMANDS.polish = {
    help: 'Polish text',
    async run(args, ta) {
      capturedTa = ta;
    },
  };

  const ta = {
    tagName: 'TEXTAREA',
    value: 'He go work ?/polish',
    textContent: '',
    focus() {},
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 50, right: 350 }; },
    dispatchEvent() {},
  };
  ctx.paletteTarget = ta;

  await applyPaletteCommand('polish');

  assert.strictEqual(capturedTa, ta, 'COMMANDS.polish.run should receive ta');

  console.log('  PASS: applyPaletteCommand passes target for polish command');
}

// ── Test: handleCommand check with null target shows badge, no throw ──
{
  _badgeCapture = null;
  let handled = await handleCommand('Hello ?/check', null);

  assert.strictEqual(handled, true, 'handleCommand should return true');
  assert.strictEqual(_badgeCapture, 'Cannot check \u2014 no editable field found',
    'Should show correct badge for check with null target');

  console.log('  PASS: handleCommand check/null shows correct badge');
}

// ── Test: handleCommand lang with null target shows badge, no throw ──
{
  _badgeCapture = null;
  let handled = await handleCommand('Hello ?/lang en', null);

  assert.strictEqual(handled, true, 'handleCommand should return true');
  assert.strictEqual(_badgeCapture, 'Cannot translate \u2014 no editable field found',
    'Should show correct badge for lang with null target');

  console.log('  PASS: handleCommand lang/null shows correct badge');
}

// ── Test: COMMANDS.check.run contentEditable CDP await (skipLiveCheck fix) ──
{
  ctx.tryBeforeInput = async function() { return false; };

  let cdpResolve;
  const cdpPromise = new Promise(r => { cdpResolve = r; });
  let cdpCalledWith = null;
  ctx.applyFixCDP = function(text) {
    cdpCalledWith = text;
    return cdpPromise;
  };

  ctx.checkGrammar = async function() {
    return { ok: true, errors: [] };
  };

  ctx.highlightLiveDraft = function() {};
  ctx.showGreenCheck = function() {};
  ctx.showPendingBadge = function() {};
  ctx.removePendingBadge = function() {};
  ctx.showResultBadge = function() {};

  ctx.state.minChars = 1;
  ctx.state.commandInFlight = false;
  ctx.state.skipLiveCheck = false;
  ctx.state.cancelLiveDraft = null;
  ctx.state.activeCheckController = null;

  const ta = {
    tagName: 'DIV',
    value: '',
    textContent: 'Hello ?/check',
    focus() {},
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 50, right: 350 }; },
    dispatchEvent() {},
  };

  const runPromise = COMMANDS.check.run('', ta);

  await new Promise(r => setTimeout(r, 0));

  assert.strictEqual(ctx.state.skipLiveCheck, true,
    'skipLiveCheck should remain true while CDP is pending');

  cdpResolve();

  await runPromise;

  assert.strictEqual(ctx.state.skipLiveCheck, false,
    'skipLiveCheck should be false after CDP resolves and check completes');

  assert.ok(cdpCalledWith, 'applyFixCDP should have been called');
  assert.ok(!cdpCalledWith.includes('?/check'),
    'CDP should receive cleaned text without ?/check');

  console.log('  PASS: COMMANDS.check.run contentEditable awaits CDP before releasing skipLiveCheck');
}
console.log('\n  All A1 tests passed.\n');

})().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
