/**
 * Regression coverage for the capability-based CodeMirror adapter.
 *
 * The adapter must identify CodeMirror without relying on a hostname, preserve
 * logical line breaks that textContent loses, and expose its scroll container
 * for an aligned live-error overlay.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '..', 'extension', 'src', 'codemirror-bridge.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
source = source.replace(/^export\s+(let|const)\s/gm, 'var ');
source += '\nglobalThis.__test = { isCodeMirrorEditor, getCodeMirrorText, getCodeMirrorScrollContainer, getCodeMirrorOverlayGeometry, replaceCodeMirrorText };\n';

let selectedNode = null;
const execCalls = [];
const selection = {
  removeAllRanges() {},
  addRange() {},
};
const context = vm.createContext({
  document: {
    createRange() {
      return { selectNodeContents(node) { selectedNode = node; } };
    },
    getSelection() { return selection; },
    execCommand(command, _showUi, text) {
      execCalls.push({ command, text });
      return true;
    },
  },
});
vm.runInContext(source, context, { filename: 'codemirror-bridge.js' });

const {
  isCodeMirrorEditor,
  getCodeMirrorText,
  getCodeMirrorScrollContainer,
  getCodeMirrorOverlayGeometry,
  replaceCodeMirrorText,
} = context.__test;

function classList(...names) {
  return { contains(name) { return names.includes(name); } };
}

function makeEditor({
  contentClass = 'cm-content',
  isContentEditable = true,
  contentEditable = isContentEditable ? 'true' : 'false',
  lines = ['first line', 'second line'],
  hasScroller = true,
} = {}) {
  const editorHost = { classList: classList('cm-editor') };
  const scroller = {
    classList: classList('cm-scroller'),
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect() { return { left: 50, top: 200, width: 300, height: 100 }; },
  };
  return {
    isContentEditable,
    contentEditable,
    classList: classList(contentClass),
    focus() {},
    getBoundingClientRect() { return { left: 40, top: 125, width: 300, height: 500 }; },
    closest(selector) {
      if (selector === '.cm-editor') return editorHost;
      if (selector === '.cm-scroller') return hasScroller ? scroller : null;
      return null;
    },
    querySelectorAll(selector) {
      assert.strictEqual(selector, ':scope > .cm-line');
      return lines.map(line => typeof line === 'string' ? { textContent: line } : line);
    },
  };
}

function textNode(value) {
  return { nodeType: 3, nodeValue: value };
}

function elementNode(classNames, children = [], contentEditable = null) {
  return {
    nodeType: 1,
    classList: classList(...classNames),
    childNodes: children,
    getAttribute(name) {
      return name === 'contenteditable' ? contentEditable : null;
    },
  };
}

function logicalLine(children) {
  return {
    textContent: children.map(child => child.nodeValue || '').join(''),
    childNodes: children,
  };
}

{
  const editor = makeEditor();
  const attributeEditableEditor = makeEditor({ isContentEditable: null, contentEditable: 'true' });
  assert.doesNotMatch(source, /localhost|location\.hostname|pi-webui/i, 'adapter must not special-case a host or product');
  assert.strictEqual(isCodeMirrorEditor(editor), true, 'recognizes a CodeMirror contentEditable by capability');
  assert.strictEqual(isCodeMirrorEditor(attributeEditableEditor), true, 'accepts the standard contenteditable attribute capability');
  assert.strictEqual(getCodeMirrorText(editor), 'first line\nsecond line', 'preserves logical CodeMirror line breaks');
  assert.ok(getCodeMirrorScrollContainer(editor), 'returns the CodeMirror scroll container');
  console.log('  PASS: recognizes CodeMirror and preserves multiline text');
}

{
  const nonCodeMirror = makeEditor({ contentClass: 'editor-content' });
  const nonEditable = makeEditor({ isContentEditable: false });
  const missingScroller = makeEditor({ hasScroller: false });
  assert.strictEqual(isCodeMirrorEditor(nonCodeMirror), false, 'does not claim arbitrary contentEditable elements');
  assert.strictEqual(isCodeMirrorEditor(nonEditable), false, 'does not claim a non-editable CodeMirror wrapper');
  assert.strictEqual(isCodeMirrorEditor(missingScroller), false, 'requires the CodeMirror scroll structure as a capability');
  assert.strictEqual(getCodeMirrorText(nonCodeMirror), '', 'does not read non-CodeMirror elements through the adapter');
  assert.strictEqual(getCodeMirrorScrollContainer(nonCodeMirror), null, 'does not expose a scroll container for non-CodeMirror elements');
  console.log('  PASS: keeps generic contentEditable handling separate');
}

{
  const editor = makeEditor({
    lines: [
      logicalLine([textNode('first '), elementNode(['cm-placeholder'], [textNode('placeholder')], 'false'), textNode('line')]),
      logicalLine([textNode('second line')]),
      logicalLine([]),
    ],
  });
  assert.strictEqual(
    getCodeMirrorText(editor),
    'first line\nsecond line\n',
    'excludes non-document placeholder widgets while preserving empty trailing lines',
  );
  console.log('  PASS: ignores CodeMirror decorations and preserves trailing newlines');
}

{
  const editor = makeEditor();
  const geometry = getCodeMirrorOverlayGeometry(editor);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(geometry)),
    {
      viewport: { left: 50, top: 200, width: 300, height: 100 },
      content: { left: -10, top: -75, width: 300, height: 500 },
    },
    'maps the moving CodeMirror content into its fixed scroll viewport',
  );
  console.log('  PASS: reports scroll-safe CodeMirror overlay geometry');
}

{
  const editor = makeEditor();
  execCalls.length = 0;
  selectedNode = null;
  assert.strictEqual(replaceCodeMirrorText(editor, 'first line\nsecond line'), true);
  assert.strictEqual(selectedNode, editor, 'selects only the CodeMirror content surface');
  assert.deepStrictEqual(
    execCalls,
    [{ command: 'insertText', text: 'first line\nsecond line' }],
    'uses the browser editing command so CodeMirror receives a native input transaction',
  );
  console.log('  PASS: replaces CodeMirror text through the editor-native DOM path');
}

console.log('\n  All CodeMirror bridge tests passed.\n');
