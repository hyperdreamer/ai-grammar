/**
 * CodeMirror replacement regression coverage.
 *
 * The shared correction path must use the CodeMirror adapter rather than
 * mutating its DOM or falling through to the generic contenteditable route.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '..', 'extension', 'src', 'apply-correction.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '// import stripped');
source = source.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
source = source.replace(/^export\s+(let|const)\s/gm, 'var ');
source += '\nglobalThis.__test = { applyCorrection, tryBeforeInput, applyCorrectionsToText };\n';

const adapterCalls = [];
const context = vm.createContext({
  console: { debug() {} },
  window: { getSelection() { return { removeAllRanges() {}, addRange() {} }; } },
  state: {},
  navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
  requestAnimationFrame(callback) { callback(); return 1; },
  isConnectedToDocument(element) { return element?.isConnected === true; },
  getDeepActiveElement() { return null; },
  getEditableText(element) { return element?.logicalText || ''; },
  isCodeMirrorEditor(element) { return element?.isCodeMirror === true; },
  replaceCodeMirrorText(element, text) {
    adapterCalls.push({ element, text });
    element.logicalText = text;
    return true;
  },
  document: {
    querySelector() { return null; },
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
    createRange() { return { selectNodeContents() {} }; },
    execCommand() { throw new Error('generic replacement should not run for CodeMirror'); },
  },
  InputEvent: function InputEvent(type, options) { this.type = type; Object.assign(this, options); },
  chrome: { runtime: { sendMessage() {} } },
  hideTooltip() {},
  showResultBadge() {},
  clearLiveDraftHighlights() {},
});
vm.runInContext(source, context, { filename: 'apply-correction.js' });

const { applyCorrection, tryBeforeInput, applyCorrectionsToText } = context.__test;

(async () => {
  {
    const editor = {
      isCodeMirror: true,
      isContentEditable: true,
      isConnected: true,
      logicalText: 'first line\nsecond line',
      focus() {},
      dispatchEvent() { throw new Error('CodeMirror should use its adapter, not a synthetic event'); },
    };

    adapterCalls.length = 0;
    assert.strictEqual(await tryBeforeInput('first line\nsecond corrected line', editor), true);
    assert.deepStrictEqual(
      adapterCalls.map(call => call.text),
      ['first line\nsecond corrected line'],
      'passes multiline replacements to the CodeMirror adapter intact',
    );
    assert.strictEqual(editor.logicalText, 'first line\nsecond corrected line');
    console.log('  PASS: routes multiline CodeMirror replacement through the adapter');
  }

  {
    const textarea = {
      tagName: 'TEXTAREA',
      isConnected: true,
      value: 'This sentence have a correction.',
      focus() {},
      dispatchEvent(event) { this.inputEvent = event; },
    };
    const error = {
      getAttribute(name) {
        return {
          'data-correction': 'has',
          'data-start': '14',
          'data-end': '18',
        }[name] || '';
      },
      hasAttribute(name) { return name === 'data-live-draft'; },
    };
    context.state.liveHighlightTarget = textarea;
    context.state.liveHighlightEl = { querySelectorAll() { return [error]; } };

    applyCorrection(error);

    assert.strictEqual(textarea.value, 'This sentence has a correction.');
    assert.strictEqual(textarea.inputEvent.type, 'input');
    console.log('  PASS: preserves live textarea correction behavior');
  }

  {
    const editor = {
      isCodeMirror: false,
      isContentEditable: true,
      isConnected: true,
      logicalText: 'old text',
      focus() {},
      dispatchEvent(event) {
        if (event.type === 'beforeinput') this.logicalText = event.data;
      },
    };

    adapterCalls.length = 0;
    assert.strictEqual(await tryBeforeInput('new text', editor), true);
    assert.strictEqual(editor.logicalText, 'new text', 'keeps generic contenteditable beforeinput behavior');
    assert.strictEqual(adapterCalls.length, 0, 'does not route non-CodeMirror editors through the adapter');
    console.log('  PASS: preserves generic contenteditable replacement');
  }

  {
    const text = 'first line\nhave a correction';
    const repeatedFragment = { start: 11, end: 15, correction: 'has' };
    assert.strictEqual(
      applyCorrectionsToText(text, [repeatedFragment, repeatedFragment]),
      'first line\nhas a correction',
      'applies a multiline correction once when an underline is split into visual fragments',
    );
    console.log('  PASS: deduplicates multiline underline fragments before applying fixes');
  }

  console.log('\n  All correction adapter tests passed.\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
