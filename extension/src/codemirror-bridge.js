// CodeMirror DOM adapter.
//
// CodeMirror 6 deliberately keeps its document model private. This module uses
// only its public DOM editing surface: a contenteditable `.cm-content` inside
// a `.cm-scroller` and `.cm-editor`. Those ancestors remain within the same
// open shadow root, so no document-wide or site-specific lookup is necessary.

function hasClass(element, className) {
  return element?.classList?.contains?.(className) === true;
}

function isEditable(element) {
  const contentEditable = element?.contentEditable;
  return element?.isContentEditable === true
    || (typeof contentEditable === 'string' && contentEditable.toLowerCase() === 'true');
}

function getCodeMirrorParts(element) {
  if (!element || !isEditable(element) || !hasClass(element, 'cm-content')) {
    return null;
  }

  const editor = element.closest?.('.cm-editor');
  const scroller = element.closest?.('.cm-scroller');
  if (!hasClass(editor, 'cm-editor') || !hasClass(scroller, 'cm-scroller')) {
    return null;
  }

  return { content: element, editor, scroller };
}

/** Return whether an editable has the standard CodeMirror DOM capabilities. */
export function isCodeMirrorEditor(element) {
  return getCodeMirrorParts(element) !== null;
}

function getLogicalLines(content) {
  const directChildren = Array.from(content.children || []);
  const directLines = directChildren.filter(child => hasClass(child, 'cm-line'));
  if (directLines.length) return directLines;

  return Array.from(content.querySelectorAll?.(':scope > .cm-line') || []);
}

function isNonDocumentNode(node) {
  if (node?.nodeType !== 1) return false;
  if (hasClass(node, 'cm-placeholder') || hasClass(node, 'cm-widgetBuffer')) return true;
  const contentEditable = node.getAttribute?.('contenteditable');
  return typeof contentEditable === 'string' && contentEditable.toLowerCase() === 'false';
}

function getLogicalLineText(line) {
  const children = Array.from(line.childNodes || []);
  if (!children.length) return line.textContent || '';

  const chunks = [];
  const visit = (node) => {
    if (node?.nodeType === 3) {
      chunks.push(node.nodeValue || '');
      return;
    }
    if (!node || node.nodeType !== 1 || isNonDocumentNode(node)) return;
    for (const child of Array.from(node.childNodes || [])) visit(child);
  };

  for (const child of children) visit(child);
  return chunks.join('');
}

/** Return CodeMirror's logical document text, including empty logical lines. */
export function getCodeMirrorText(element) {
  const parts = getCodeMirrorParts(element);
  if (!parts) return '';
  return getLogicalLines(parts.content).map(getLogicalLineText).join('\n');
}

/** Return the element that owns CodeMirror's vertical and horizontal scroll. */
export function getCodeMirrorScrollContainer(element) {
  return getCodeMirrorParts(element)?.scroller || null;
}

/**
 * Map the moving CodeMirror content into its fixed scroll viewport. Consumers
 * can position a clipped overlay at `viewport` and translate its text mirror
 * by `content.left` / `content.top`, keeping it aligned at every scroll offset.
 */
export function getCodeMirrorOverlayGeometry(element) {
  const parts = getCodeMirrorParts(element);
  if (!parts?.content?.getBoundingClientRect || !parts.scroller?.getBoundingClientRect) {
    return null;
  }

  const viewportRect = parts.scroller.getBoundingClientRect();
  const contentRect = parts.content.getBoundingClientRect();
  if (![viewportRect.left, viewportRect.top, viewportRect.width, viewportRect.height,
    contentRect.left, contentRect.top, contentRect.width, contentRect.height].every(Number.isFinite)) {
    return null;
  }

  return {
    viewport: {
      left: viewportRect.left,
      top: viewportRect.top,
      width: viewportRect.width,
      height: viewportRect.height,
    },
    content: {
      left: contentRect.left - viewportRect.left,
      top: contentRect.top - viewportRect.top,
      width: contentRect.width,
      height: contentRect.height,
    },
  };
}

function selectCodeMirrorContents(element) {
  if (typeof document === 'undefined' || typeof document.createRange !== 'function') return false;

  const rootSelection = element.getRootNode?.().getSelection?.();
  const selection = rootSelection || document.getSelection?.();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Replace a CodeMirror document through its public contenteditable surface.
 * `execCommand('insertText')` produces a browser-native input transaction that
 * CodeMirror observes and turns into a normal document update; no internal
 * view, state, or dispatch property is accessed.
 */
export function replaceCodeMirrorText(element, text) {
  if (!isCodeMirrorEditor(element) || typeof text !== 'string') return false;
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;

  element.focus?.();
  if (!selectCodeMirrorContents(element)) return false;

  try {
    const inserted = document.execCommand('insertText', false, text) === true;
    return inserted || getCodeMirrorText(element) === text.replace(/\r\n?/g, '\n');
  } catch {
    return false;
  }
}
