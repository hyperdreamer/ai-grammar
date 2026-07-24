/**
 * Regression coverage for editable controls rendered in open shadow roots.
 *
 * The Pi WebUI prompt is a CodeMirror contentEditable nested below
 * pi-webui-app → prompt-editor shadow roots. Document-level listeners see the
 * host as event.target, while document.contains(prompt) is false. These tests
 * exercise the real DOM helper source with representative shadow-DOM objects.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '..', 'extension', 'src', 'dom-utils.js');
let source = fs.readFileSync(sourcePath, 'utf8');

source = source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '// import stripped');
source = source.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
source = source.replace(/^export\s+(let|const)\s/gm, 'var ');
source = source.replace(/^export\s+var\s/gm, 'var ');
source += '\nglobalThis.__test = { getEditableText, getEventEditableTarget, isConnectedToDocument, getDeepActiveElement };\n';

const context = vm.createContext({
  document: { contains() { return false; } },
  NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
  state: { checkedElements: new WeakSet() },
  IGNORE_TAGS: new Set(),
  IGNORE_CLASSES: [],
  CHECKED_ATTR: 'data-ai-grammar-checked',
  USER_MESSAGE_SELECTOR: '',
  USER_TEXT_TTL_MS: 0,
  USER_TEXT_MIN_MATCH: 0,
  isCodeMirrorEditor(el) { return el?.isCodeMirror === true; },
  getCodeMirrorText(el) { return el.logicalText; },
});
vm.runInContext(source, context, { filename: 'dom-utils.js' });

const {
  getEditableText,
  getEventEditableTarget,
  isConnectedToDocument,
  getDeepActiveElement,
} = context.__test;

assert.strictEqual(typeof getEditableText, 'function', 'getEditableText should be exported');
assert.strictEqual(typeof getEventEditableTarget, 'function', 'getEventEditableTarget should be exported');
assert.strictEqual(typeof isConnectedToDocument, 'function', 'isConnectedToDocument should be exported');
assert.strictEqual(typeof getDeepActiveElement, 'function', 'getDeepActiveElement should be exported');

function element(properties = {}) {
  return {
    nodeType: 1,
    tagName: 'DIV',
    isContentEditable: false,
    contentEditable: 'inherit',
    isConnected: false,
    closest() { return null; },
    ...properties,
  };
}

// CodeMirror renders logical lines as sibling elements, so textContent loses
// line breaks. The shared reader delegates to the CodeMirror adapter while
// preserving ordinary control values.
{
  const codeMirror = element({ isCodeMirror: true, logicalText: 'first line\nsecond line' });
  const textarea = element({ tagName: 'TEXTAREA', value: 'ordinary textarea' });
  const genericContentEditable = element({
    isContentEditable: true,
    contentEditable: 'true',
    textContent: 'ordinary contenteditable',
  });

  assert.strictEqual(getEditableText(codeMirror), 'first line\nsecond line');
  assert.strictEqual(getEditableText(textarea), 'ordinary textarea');
  assert.strictEqual(getEditableText(genericContentEditable), 'ordinary contenteditable');
  console.log('  PASS: preserves CodeMirror logical text without changing ordinary editor reads');
}

// A composed event from the Pi WebUI CodeMirror editor is retargeted to the
// outer app host at document level. The actual editable must come from the
// composed path, not event.target.
{
  const editor = element({
    tagName: 'DIV',
    contentEditable: 'true',
    isContentEditable: true,
  });
  const host = element({ tagName: 'PI-WEBUI-APP' });
  const event = {
    target: host,
    composedPath() { return [editor, host]; },
  };

  assert.strictEqual(
    getEventEditableTarget(event),
    editor,
    'uses the real CodeMirror contentEditable from the composed path',
  );
  console.log('  PASS: resolves an editable through a retargeted shadow-DOM event');
}

// Events can originate in a child of a contentEditable. The helper must return
// the editable owner so callers read and replace the whole draft, not a span.
{
  const editor = element({
    contentEditable: 'true',
    isContentEditable: true,
  });
  const child = element({
    tagName: 'SPAN',
    isContentEditable: true,
    closest(selector) {
      return selector === '[contenteditable]' ? editor : null;
    },
  });

  assert.strictEqual(
    getEventEditableTarget({ target: child, composedPath() { return [child]; } }),
    editor,
    'normalizes a contentEditable descendant to its editable owner',
  );
  console.log('  PASS: resolves the owner of a contentEditable descendant');
}

// Existing light-DOM textareas remain supported.
{
  const textarea = element({ tagName: 'TEXTAREA' });
  assert.strictEqual(
    getEventEditableTarget({ target: textarea, composedPath() { return [textarea]; } }),
    textarea,
    'preserves textarea handling outside shadow DOM',
  );
  console.log('  PASS: preserves light-DOM textarea targeting');
}

// document.contains() is false for shadow descendants in Chromium even while
// they are mounted. isConnected is the correct lifecycle check.
{
  const mountedShadowEditor = element({ isConnected: true });
  const detachedEditor = element({ isConnected: false });

  assert.strictEqual(isConnectedToDocument(mountedShadowEditor), true, 'accepts a mounted shadow descendant');
  assert.strictEqual(isConnectedToDocument(detachedEditor), false, 'rejects a detached editable');
  console.log('  PASS: uses shadow-inclusive connection state');
}

// document.activeElement stops at each shadow host. Follow activeElement down
// through open roots to recover the focused CodeMirror editor.
{
  const editor = element({ tagName: 'DIV', isContentEditable: true, contentEditable: 'true' });
  const promptEditor = element({ tagName: 'PROMPT-EDITOR', shadowRoot: { activeElement: editor } });
  const app = element({ tagName: 'PI-WEBUI-APP', shadowRoot: { activeElement: promptEditor } });
  const fakeDocument = { activeElement: app };

  assert.strictEqual(getDeepActiveElement(fakeDocument), editor, 'follows active elements through open roots');
  console.log('  PASS: finds the deeply focused editable');
}

console.log('\n  All shadow-DOM compatibility tests passed.\n');
