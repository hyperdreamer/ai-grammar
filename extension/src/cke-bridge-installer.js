/**
 * CKEditor MAIN-world bridge installer.
 *
 * Self-contained function suitable for chrome.scripting.executeScript({func: ...}).
 * When injected into a page, polls for a CKEditor instance every 500ms and
 * wires change:data events to window.postMessage.
 *
 * Transition routine: obtain candidate; if different, detach old; clear state;
 * attach candidate; set tracked instance/handler only on success.
 */
function installCKEBridge() {
  if (window.__agCKEBridge) return;
  window.__agCKEBridge = true;

  var POLL_MS = 500;
  var currentInstance = null;
  var changeHandler = null;

  function onChangeData() {
    try {
      window.postMessage({ source: 'ag-cke-bridge', type: 'change' }, '*');
    } catch (e) { /* ignore */ }
  }

  (function poll() {
    var instance = null;
    try {
      var el = document.querySelector('.ck-editor__editable[contenteditable="true"]');
      instance = (el && el.ckeditorInstance) || null;
    } catch (e) { /* query failed — instance stays null */ }

    if (instance !== currentInstance) {
      // Detach previous listener before clearing state
      if (currentInstance && changeHandler) {
        try { currentInstance.model.document.off('change:data', changeHandler); } catch (e) {}
        changeHandler = null;
      }
      currentInstance = null;

      // Attempt attach — only set currentInstance on success
      if (instance) {
        changeHandler = onChangeData;
        try {
          instance.model.document.on('change:data', changeHandler);
          currentInstance = instance;
        } catch (e) {
          changeHandler = null;
          // leave currentInstance null so next poll retries
        }
      }
    }

    setTimeout(poll, POLL_MS);
  })();

  // Apply-fix helper for content script
  window.__agCKEApply = function (text) {
    var el = document.querySelector('.ck-editor__editable[contenteditable="true"]');
    var inst = el && el.ckeditorInstance;
    if (!inst) return false;
    inst.model.change(function (writer) {
      var root = inst.model.document.getRoot();
      writer.remove(writer.createRangeIn(root));
      var p = writer.createElement('paragraph');
      writer.append(p, root);
      writer.appendText(text, {}, p);
    });
    return true;
  };
}

// Test-only export hook — zero effect in extension bundles
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installCKEBridge };
}
