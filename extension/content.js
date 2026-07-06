(() => {
  // src/state.js
  var IGNORE_TAGS = /* @__PURE__ */ new Set([
    "SCRIPT",
    "STYLE",
    "CODE",
    "PRE",
    "TEXTAREA",
    "INPUT",
    "SVG",
    "MATH",
    "NOSCRIPT",
    "IFRAME",
    "CANVAS"
  ]);
  var IGNORE_CLASSES = ["ai-grammar-error", "ai-grammar-improvement", "ai-grammar-idiom", "ai-grammar-tooltip", "ai-grammar-badge", "ai-grammar-ok", "ag-message-overlay", "ag-live-error"];
  var isTeams = /^teams\.(cloud\.)?microsoft(\.com)?$/i.test(location.hostname) || location.hostname === "teams.live.com";
  function getWhatsAppBridge() {
    return window.__aiWhatsApp || null;
  }
  var USER_MESSAGE_SELECTOR = [
    ".user-msg",
    ".user-message",
    ".message.user",
    '[data-testid*="user"]',
    '[class*="user"][class*="msg"]',
    '[class*="user"][class*="message"]',
    // Microsoft Teams self/sent messages
    '[class*="self"]',
    '[class*="outgoing"]',
    '[class*="sent"]',
    '[data-tid*="self"]'
  ].join(", ");
  var GRAMMAR_CLASSES = ".ai-grammar-error, .ai-grammar-improvement, .ai-grammar-idiom";
  var state = {
    minChars: 30,
    // read from storage (grammarMinChars)
    // Persistent port to background — keeps the service worker alive so
    // apply-fix messages are delivered even after the 30s idle timeout.
    fixPort: null,
    checkIdCounter: 0,
    pendingChecks: /* @__PURE__ */ new Map(),
    // container → { text, conversationKey }
    checkedElements: /* @__PURE__ */ new WeakSet(),
    // elements already checked
    debounceTimer: null,
    isHighlighting: false,
    tooltipEl: null,
    tooltipTimeout: null,
    currentErrorEl: null,
    liveHighlightEl: null,
    liveHighlightTarget: null,
    liveHighlightRestore: null,
    liveHighlightScrollHandler: null,
    liveHighlightMouseMoveHandler: null,
    liveHighlightMouseLeaveHandler: null,
    liveHighlightReposition: null,
    liveHighlightAnimationFrame: null,
    // Overlay-based post-submit highlights (survives React re-renders on
    // WhatsApp Web, Teams, etc. — DOM injection gets stripped by vdom reconcilation)
    messageOverlays: /* @__PURE__ */ new Map(),
    // container → { overlay, cleanup }
    // AbortController for in-flight grammar checks — aborted when user resumes typing
    activeCheckController: null,
    // Function to cancel pending live draft check — set by setupLiveDraftCheck
    cancelLiveDraft: null,
    commandInFlight: false,
    skipLiveCheck: false,
    // set during fix/polish to prevent re-triggering live draft
    replacingCommand: false,
    // set during partial → full command replacement
    // Track whether the extension context has been invalidated (MV3 service worker
    // termination / extension reload). Once invalidated, chrome.* APIs throw
    // "Extension context invalidated" — we fall back to hardcoded defaults.
    contextInvalidated: false,
    // Track the last text the user submitted so we only check their content,
    // not AI replies or other page text that happens to appear in the DOM.
    lastUserText: "",
    lastUserTextTime: 0,
    activeConversationKey: "",
    pendingSubmission: null,
    // { text, messageList, time, conversationKey }
    // Reference counters: one counter per pending category
    badgeCounters: { checking: 0, fixing: 0, polishing: 0, translating: 0 },
    // Current label text for each category
    badgeLabels: {
      checking: "Checking grammar...",
      fixing: "Fixing...",
      polishing: "Polishing...",
      translating: "Translating..."
    },
    // Active badge DOM elements, keyed by category or 'result-N' for result badges
    activeBadges: /* @__PURE__ */ new Map(),
    // key → { el, category, counter? }
    // Timer handle for auto-dismissing result badges
    resultBadgeTimer: null,
    // Green checkmark state
    greenCheckTimers: /* @__PURE__ */ new Map()
    // container → timer (for cleanup)
  };
  try {
    state.fixPort = chrome.runtime.connect({ name: "grammar-fix" });
    state.fixPort.onDisconnect.addListener(() => {
      setTimeout(() => {
        try {
          state.fixPort = chrome.runtime.connect({ name: "grammar-fix" });
        } catch {
        }
      }, 1e3);
    });
  } catch {
  }
  async function safeGetStorage(defaults) {
    if (state.contextInvalidated) return defaults;
    try {
      return await Promise.race([
        chrome.storage.sync.get(defaults),
        new Promise((resolve) => setTimeout(() => {
          console.debug("[AI Grammar] chrome.storage.sync.get() timed out, using defaults");
          resolve(defaults);
        }, 2e3))
      ]);
    } catch (e) {
      if (e.message?.includes("Extension context invalidated")) {
        state.contextInvalidated = true;
        console.debug("[AI Grammar] Extension context invalidated, using defaults");
        return defaults;
      }
      throw e;
    }
  }
  function getConversationKey() {
    try {
      const urlKey = `${location.origin}${location.pathname}${location.search}${location.hash}`;
      const wa = getWhatsAppBridge();
      if (wa) {
        return wa.getConversationKey();
      }
      return `generic:${urlKey}`;
    } catch {
      return `${location.origin}${location.pathname}${location.search}${location.hash}`;
    }
  }
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // src/tooltip.js
  function createTooltip() {
    if (state.tooltipEl) return state.tooltipEl;
    state.tooltipEl = document.createElement("div");
    state.tooltipEl.className = "ai-grammar-tooltip";
    state.tooltipEl.style.display = "none";
    state.tooltipEl.innerHTML = '<div class="ag-arrow"></div>';
    document.body.appendChild(state.tooltipEl);
    return state.tooltipEl;
  }
  function showTooltip(errorEl) {
    if (state.currentErrorEl === errorEl && state.tooltipEl?.style.display === "block") return;
    if (state.tooltipTimeout) {
      clearTimeout(state.tooltipTimeout);
      state.tooltipTimeout = null;
    }
    state.currentErrorEl = errorEl;
    const tip = createTooltip();
    const correction = errorEl.getAttribute("data-correction") || "";
    const explanation = errorEl.getAttribute("data-explanation") || "";
    const original = errorEl.getAttribute("data-error") || "";
    const type = errorEl.getAttribute("data-type") || "error";
    const typeLabel = { error: "\u{1F534} Error", improvement: "\u{1F7E2} Improvement", idiom: "\u{1F535} Idiom" };
    const typeColor = { error: "#f87171", improvement: "#4ade80", idiom: "#60a5fa" };
    tip.innerHTML = `
    <div class="ag-arrow"></div>
    <div style="font-size:11px;color:${typeColor[type]};margin-bottom:4px;font-weight:600;">${typeLabel[type] || "Error"}</div>
    <div><span style="text-decoration:line-through;color:#f87171;">${escapeHtml(original)}</span> \u2192 <span class="ag-correction">${escapeHtml(correction)}</span></div>
    ${explanation ? `<div class="ag-explanation">${escapeHtml(explanation)}</div>` : ""}
    <div class="ag-actions">
      ${errorEl.hasAttribute("data-live-draft") ? '<button class="ag-apply" data-action="apply">Apply fix</button>' : ""}
      <button class="ag-dismiss" data-action="dismiss">Dismiss</button>
    </div>
  `;
    tip.style.left = "-9999px";
    tip.style.top = "-9999px";
    tip.style.display = "block";
    tip.getBoundingClientRect();
    const rect = errorEl.getBoundingClientRect();
    const arrow = tip.querySelector(".ag-arrow");
    const viewportGap = 10;
    const sentenceGap = 12;
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tipWidth / 2;
    left = Math.min(left, window.innerWidth - tipWidth - viewportGap);
    left = Math.max(viewportGap, left);
    const aboveTop = rect.top - tipHeight - sentenceGap;
    const belowTop = rect.bottom + sentenceGap;
    let top = aboveTop;
    if (aboveTop < viewportGap || tooltipOverlapsTextAbove(errorEl, {
      top: aboveTop,
      right: left + tipWidth,
      bottom: aboveTop + tipHeight,
      left
    }, rect)) {
      top = belowTop;
    }
    if (top + tipHeight > window.innerHeight - viewportGap) {
      top = Math.max(viewportGap, window.innerHeight - tipHeight - viewportGap);
    }
    top = Math.max(viewportGap, top);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    if (arrow) {
      const isAbove = top + tipHeight <= rect.top;
      const arrowCenter = rect.left + rect.width / 2 - left;
      const clampedArrowCenter = Math.min(Math.max(arrowCenter, 14), tipWidth - 14);
      const arrowColor = getComputedStyle(tip).backgroundColor || "#1e293b";
      arrow.style.left = clampedArrowCenter - 6 + "px";
      arrow.style.top = isAbove ? "auto" : "-6px";
      arrow.style.bottom = isAbove ? "-6px" : "auto";
      arrow.style.borderTop = isAbove ? `6px solid ${arrowColor}` : "none";
      arrow.style.borderBottom = isAbove ? "none" : `6px solid ${arrowColor}`;
    }
  }
  function tooltipOverlapsTextAbove(errorEl, tooltipRect, errorRect) {
    const container = errorEl.closest("p, li, blockquote, td, th, div, article, section") || errorEl.parentElement;
    if (!container) return false;
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (errorEl.contains(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      const rects = range.getClientRects();
      range.detach();
      for (const textRect of rects) {
        if (textRect.bottom <= errorRect.top - 1 && intersects(textRect, tooltipRect)) {
          return true;
        }
      }
    }
    return false;
  }
  function hideTooltip() {
    if (state.tooltipTimeout) {
      clearTimeout(state.tooltipTimeout);
      state.tooltipTimeout = null;
    }
    if (state.tooltipEl) {
      state.tooltipEl.style.display = "none";
    }
    state.currentErrorEl = null;
  }

  // src/dom-utils.js
  function isIgnored(el) {
    if (!el || !el.tagName) return true;
    if (IGNORE_TAGS.has(el.tagName)) return true;
    if (el.contentEditable === "true") return true;
    for (const cls of IGNORE_CLASSES) {
      if (el.classList?.contains(cls)) return true;
    }
    return false;
  }
  function getTextContent(el) {
    if (isIgnored(el)) return "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node2) {
        if (isIgnored(node2.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let text = "";
    let node;
    while (node = walker.nextNode()) {
      text += node.textContent;
    }
    return text.trim();
  }

  // src/indicators.js
  function ensureBadgeStack() {
    let stack = document.querySelector(".ag-badge-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "ag-badge-stack";
      document.body.appendChild(stack);
    }
    return stack;
  }
  function removeBadgeStackIfEmpty() {
    const stack = document.querySelector(".ag-badge-stack");
    if (stack && stack.children.length === 0) {
      stack.remove();
    }
  }
  function buildBadgeHTML(category) {
    const label = state.badgeLabels[category];
    const count = state.badgeCounters[category];
    const countHtml = count > 1 ? `<span class="ag-count">&times; ${count}</span>` : "";
    return `<div class="ag-spinner"></div>${label}${countHtml}`;
  }
  function showPendingBadge(category, label) {
    state.badgeCounters[category]++;
    state.badgeLabels[category] = label;
    const stack = ensureBadgeStack();
    const key = `pending:${category}`;
    if (state.activeBadges.has(key)) {
      const entry = state.activeBadges.get(key);
      entry.el.innerHTML = buildBadgeHTML(category);
    } else {
      const badge = document.createElement("div");
      badge.className = "ai-grammar-badge";
      badge.setAttribute("data-ag-category", category);
      badge.innerHTML = buildBadgeHTML(category);
      stack.appendChild(badge);
      state.activeBadges.set(key, { el: badge, category });
    }
  }
  function removePendingBadge(category) {
    state.badgeCounters[category] = Math.max(0, state.badgeCounters[category] - 1);
    if (state.badgeCounters[category] <= 0) {
      const key = `pending:${category}`;
      const entry = state.activeBadges.get(key);
      if (entry) {
        entry.el.remove();
        state.activeBadges.delete(key);
      }
      removeBadgeStackIfEmpty();
    } else {
      const key = `pending:${category}`;
      const entry = state.activeBadges.get(key);
      if (entry) {
        entry.el.innerHTML = buildBadgeHTML(category);
      }
    }
  }
  function showResultBadge(text, durationMs = 4e3) {
    if (state.resultBadgeTimer) {
      clearTimeout(state.resultBadgeTimer);
      state.resultBadgeTimer = null;
    }
    for (const [key, entry] of state.activeBadges) {
      if (key.startsWith("result:")) {
        entry.el.remove();
        state.activeBadges.delete(key);
      }
    }
    const stack = ensureBadgeStack();
    const resultId = `result:${Date.now()}`;
    const badge = document.createElement("div");
    badge.className = "ai-grammar-badge ag-badge-result";
    badge.setAttribute("data-ag-result", "");
    badge.innerHTML = text;
    stack.appendChild(badge);
    state.activeBadges.set(resultId, { el: badge });
    state.resultBadgeTimer = setTimeout(() => {
      state.resultBadgeTimer = null;
      const entry = state.activeBadges.get(resultId);
      if (entry) {
        entry.el.remove();
        state.activeBadges.delete(resultId);
      }
      removeBadgeStackIfEmpty();
    }, durationMs);
  }
  function removeAllBadges() {
    for (const [key, entry] of state.activeBadges) {
      entry.el.remove();
    }
    state.activeBadges.clear();
    state.badgeCounters.checking = 0;
    state.badgeCounters.fixing = 0;
    state.badgeCounters.polishing = 0;
    state.badgeCounters.translating = 0;
    const stack = document.querySelector(".ag-badge-stack");
    if (stack) stack.remove();
  }
  function getLastCharRect(container, text) {
    const containerRect = container.getBoundingClientRect();
    const fallback = {
      right: containerRect.right - 4,
      top: containerRect.bottom - 24,
      height: 20
    };
    try {
      const textNodes = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node2) {
          if (node2.parentElement && isIgnored(node2.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }
      if (!textNodes.length) return fallback;
      let targetEnd = null;
      let targetNode = null;
      if (text) {
        const rawText = textNodes.map((tn) => tn.textContent).join("");
        const idx = rawText.indexOf(text);
        if (idx === -1) return fallback;
        const endOffset = idx + text.length;
        let offset = 0;
        for (const tn of textNodes) {
          const nodeEnd = offset + tn.textContent.length;
          if (endOffset > offset && endOffset <= nodeEnd) {
            targetNode = tn;
            targetEnd = endOffset - offset;
            break;
          }
          offset = nodeEnd;
        }
        if (!targetNode || targetEnd == null) return fallback;
      }
      if (targetNode) {
        const charIdx = Math.max(0, targetEnd - 1);
        const range2 = document.createRange();
        range2.setStart(targetNode, charIdx);
        range2.setEnd(targetNode, targetEnd);
        const rect2 = range2.getClientRects()[0];
        range2.detach();
        if (rect2 && (rect2.width > 0 || rect2.height > 0)) {
          return { right: rect2.right, top: rect2.top, height: rect2.height };
        }
        return fallback;
      }
      let lastNode = null;
      for (let i = textNodes.length - 1; i >= 0; i--) {
        if (textNodes[i].textContent.trim()) {
          lastNode = textNodes[i];
          break;
        }
      }
      if (!lastNode) return fallback;
      const nodeText = lastNode.textContent;
      let lastCharIdx = nodeText.length - 1;
      while (lastCharIdx >= 0 && /\s/.test(nodeText[lastCharIdx])) {
        lastCharIdx--;
      }
      if (lastCharIdx < 0) return fallback;
      const range = document.createRange();
      range.setStart(lastNode, lastCharIdx);
      range.setEnd(lastNode, lastCharIdx + 1);
      const rect = range.getClientRects()[0];
      range.detach();
      if (!rect || !rect.width && !rect.height) return fallback;
      return { right: rect.right, top: rect.top, height: rect.height };
    } catch (_) {
      return fallback;
    }
  }
  function showGreenCheck(container, checkedText) {
    if (!container) return;
    if (!document.contains(container)) return;
    removeGreenCheck(container);
    const isEditable = container.tagName === "TEXTAREA" || container.contentEditable === "true";
    const check = document.createElement("div");
    check.className = "ai-grammar-ok-ta";
    check.textContent = "\u2713";
    check.setAttribute("data-ag-ok-for", "");
    const rect = container.getBoundingClientRect();
    if (isEditable) {
      check.style.top = rect.top + 4 + "px";
      check.style.left = rect.right - 28 + "px";
    } else {
      const endRect = getLastCharRect(container, checkedText);
      check.style.top = endRect.top + "px";
      check.style.left = endRect.right + 6 + "px";
    }
    document.body.appendChild(check);
    const reposition = () => {
      if (!document.contains(check)) return;
      const r = container.getBoundingClientRect();
      if (isEditable) {
        check.style.top = r.top + 4 + "px";
        check.style.left = r.right - 28 + "px";
      } else {
        const endR = getLastCharRect(container, checkedText);
        check.style.top = endR.top + "px";
        check.style.left = endR.right + 6 + "px";
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    check._agReposition = reposition;
    state.greenCheckTimers.set(container, { el: check, timers: [], cleanup: () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    } });
  }
  function removeGreenCheck(container) {
    if (container && state.greenCheckTimers.has(container)) {
      const entry = state.greenCheckTimers.get(container);
      entry.timers.forEach(clearTimeout);
      if (entry.cleanup) entry.cleanup();
      if (entry.el && document.contains(entry.el)) entry.el.remove();
      state.greenCheckTimers.delete(container);
    }
  }
  function removeEditableGreenChecks() {
    for (const [container] of state.greenCheckTimers) {
      if (container.tagName === "TEXTAREA" || container.contentEditable === "true") {
        removeGreenCheck(container);
      }
    }
  }
  function showErrorFloat(errors, anchorEl = null) {
    removeErrorFloat();
    const panel = document.createElement("div");
    panel.id = "ai-grammar-float";
    let posStyle = "";
    if (anchorEl && document.contains(anchorEl)) {
      const rect = anchorEl.getBoundingClientRect();
      posStyle = `top: ${Math.min(window.innerHeight - 8, rect.bottom + 8)}px; left: ${Math.max(8, rect.left)}px;`;
    }
    panel.innerHTML = `
    <style>
      #ai-grammar-float {
        position: fixed; ${posStyle || "bottom: 16px; right: 16px;"} z-index: 2147483646;
        background: #1e293b; color: #f1f5f9; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.35);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; line-height: 1.5; max-width: 420px; max-height: 60vh;
        overflow-y: auto; padding: 0; animation: ai-gfadein 0.2s ease;
      }
      #ai-grammar-float .agf-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; border-bottom: 1px solid #334155;
        font-weight: 600; font-size: 14px; position: sticky; top: 0;
        background: #1e293b; border-radius: 12px 12px 0 0; z-index: 1;
      }
      #ai-grammar-float .agf-close {
        background: none; border: none; color: #94a3b8; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 0 0 0 12px;
      }
      #ai-grammar-float .agf-close:hover { color: #f1f5f9; }
      #ai-grammar-float .agf-item {
        padding: 10px 16px; border-bottom: 1px solid #1e293b;
      }
      #ai-grammar-float .agf-item:last-child { border-bottom: none; }
      #ai-grammar-float .agf-item:hover { background: #0f172a; }
      #ai-grammar-float .agf-original {
        color: #f87171; text-decoration: line-through; margin-right: 8px;
      }
      #ai-grammar-float .agf-correction { color: #4ade80; font-weight: 600; }
      #ai-grammar-float .agf-explain { color: #64748b; font-size: 11px; margin-top: 2px; }
      @media (prefers-color-scheme: light) {
        #ai-grammar-float {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
        }
        #ai-grammar-float .agf-header {
          border-bottom-color: #e2e8f0;
          background: #ffffff;
        }
        #ai-grammar-float .agf-close { color: #64748b; }
        #ai-grammar-float .agf-close:hover { color: #0f172a; }
        #ai-grammar-float .agf-item { border-bottom-color: #f1f5f9; }
        #ai-grammar-float .agf-item:hover { background: #f8fafc; }
        #ai-grammar-float .agf-original { color: #dc2626; }
        #ai-grammar-float .agf-correction { color: #16a34a; }
        #ai-grammar-float .agf-explain { color: #64748b; }
      }
    </style>
    <div class="agf-header">
      <span>\u{1F50D} ${errors.length} error${errors.length > 1 ? "s" : ""} found</span>
      <button class="agf-close" onclick="document.getElementById('ai-grammar-float').remove()">\u2715</button>
    </div>
    ${errors.map((e) => `
      <div class="agf-item">
        <div>
          <span class="agf-original">${escapeHtml(e.error)}</span>
          <span class="agf-correction">${escapeHtml(e.correction)}</span>
        </div>
        ${e.explanation ? `<div class="agf-explain">${escapeHtml(e.explanation)}</div>` : ""}
      </div>
    `).join("")}
  `;
    document.body.appendChild(panel);
    if (anchorEl && document.contains(anchorEl)) {
      const anchorRect = anchorEl.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const gap = 8;
      let top = anchorRect.bottom + gap;
      if (top + panelRect.height > window.innerHeight - gap) {
        top = Math.max(gap, anchorRect.top - panelRect.height - gap);
      }
      const left = Math.min(
        Math.max(gap, anchorRect.left),
        Math.max(gap, window.innerWidth - panelRect.width - gap)
      );
      panel.style.top = top + "px";
      panel.style.left = left + "px";
      panel.style.bottom = "auto";
      panel.style.right = "auto";
    }
    setTimeout(removeErrorFloat, 3e4);
  }
  function removeErrorFloat() {
    const panel = document.getElementById("ai-grammar-float");
    if (panel) panel.remove();
  }

  // src/live-draft.js
  function highlightLiveDraft(ta, errors) {
    removeErrorFloat();
    if (!errors?.length) return;
    if (ta.tagName === "TEXTAREA") {
      highlightLiveDraftTextarea(ta, errors);
    } else if (ta.isContentEditable) {
      if (getWhatsAppBridge()) {
        highlightLiveDraftContentEditable(ta, errors);
      } else {
        showErrorFloat(errors, ta);
      }
    }
  }
  function highlightLiveDraftTextarea(textarea, errors) {
    const text = textarea.value;
    const textColor = window.getComputedStyle(textarea).color || "#e2e8f0";
    const rect = textarea.getBoundingClientRect();
    const overlay = document.createElement("div");
    state.liveHighlightEl = overlay;
    Object.assign(overlay.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483645",
      font: window.getComputedStyle(textarea).font,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      overflow: "hidden",
      padding: window.getComputedStyle(textarea).padding,
      color: textColor,
      background: "transparent",
      boxSizing: "border-box",
      letterSpacing: window.getComputedStyle(textarea).letterSpacing,
      textAlign: window.getComputedStyle(textarea).textAlign
    });
    let html = "", pos = 0;
    const sorted = [...errors].sort((a, b) => a.start - b.start);
    for (const err of sorted) {
      const s = Math.max(0, Number(err.start)), e = Math.min(text.length, Number(err.end));
      if (s < pos || s >= e) continue;
      html += escapeHtml(text.slice(pos, s));
      const cls = err.type === "improvement" ? "ai-grammar-improvement" : err.type === "idiom" ? "ai-grammar-idiom" : "ai-grammar-error";
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;text-underline-offset:0" data-correction="${escapeHtml(err.correction || "")}" data-explanation="${escapeHtml(err.explanation || "")}" data-error="${escapeHtml(err.error || "")}" data-type="${err.type || "error"}" data-live-draft="1" data-start="${s}" data-end="${e}" tabindex="0">${escapeHtml(text.slice(s, e))}</span>`;
      pos = e;
    }
    html += escapeHtml(text.slice(pos));
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    state.liveHighlightRestore = { color: textarea.style.color || "", caretColor: textarea.style.caretColor || "" };
    textarea.style.color = "transparent";
    textarea.style.caretColor = textColor;
    state.liveHighlightScrollHandler = () => {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
    };
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
    textarea.addEventListener("scroll", state.liveHighlightScrollHandler);
    state.liveHighlightReposition = () => {
      if (!state.liveHighlightEl || !document.contains(textarea)) return;
      const r = textarea.getBoundingClientRect();
      state.liveHighlightEl.style.top = r.top + "px";
      state.liveHighlightEl.style.left = r.left + "px";
      state.liveHighlightEl.style.width = r.width + "px";
      state.liveHighlightEl.style.height = r.height + "px";
    };
    window.addEventListener("resize", state.liveHighlightReposition);
    window.addEventListener("scroll", state.liveHighlightReposition, true);
    startLiveHighlightPositionLoop();
    state.liveHighlightTarget = textarea;
  }
  function highlightLiveDraftContentEditable(ce, errors) {
    const text = ce.textContent || ce.innerText || "";
    const cs = window.getComputedStyle(ce);
    const rect = ce.getBoundingClientRect();
    const overlay = document.createElement("div");
    state.liveHighlightEl = overlay;
    Object.assign(overlay.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483645",
      font: cs.font,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontVariant: cs.fontVariant,
      fontStretch: cs.fontStretch,
      fontKerning: cs.fontKerning,
      fontFeatureSettings: cs.fontFeatureSettings,
      fontVariationSettings: cs.fontVariationSettings,
      textRendering: cs.textRendering,
      textTransform: cs.textTransform,
      direction: cs.direction,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      wordSpacing: cs.wordSpacing,
      textAlign: cs.textAlign,
      textIndent: cs.textIndent,
      whiteSpace: cs.whiteSpace || "pre-wrap",
      overflowWrap: cs.overflowWrap || "break-word",
      wordBreak: cs.wordBreak || "break-word",
      wordWrap: cs.wordWrap,
      color: "rgba(0, 0, 0, 0.02)",
      WebkitTextFillColor: "rgba(0, 0, 0, 0.02)",
      background: "transparent",
      overflow: "hidden",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      boxSizing: "content-box"
    });
    let html = "", pos = 0;
    const sorted = [...errors].sort((a, b) => a.start - b.start);
    for (const err of sorted) {
      const s = Math.max(0, Number(err.start)), e = Math.min(text.length, Number(err.end));
      if (s < pos || s >= e) continue;
      html += escapeHtml(text.slice(pos, s));
      const cls = err.type === "improvement" ? "ai-grammar-improvement" : err.type === "idiom" ? "ai-grammar-idiom" : "ai-grammar-error";
      html += '<span class="' + cls + ' ag-live-error" style="pointer-events:auto;cursor:pointer;text-underline-offset:0" data-correction="' + escapeHtml(err.correction || "") + '" data-explanation="' + escapeHtml(err.explanation || "") + '" data-error="' + escapeHtml(err.error || "") + '" data-type="' + (err.type || "error") + '" data-live-draft="1" data-start="' + s + '" data-end="' + e + '" tabindex="0">' + escapeHtml(text.slice(s, e)) + "</span>";
      pos = e;
    }
    html += escapeHtml(text.slice(pos));
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    state.liveHighlightReposition = () => {
      if (!state.liveHighlightEl || !document.contains(ce)) return;
      const r = ce.getBoundingClientRect();
      state.liveHighlightEl.style.top = r.top + "px";
      state.liveHighlightEl.style.left = r.left + "px";
      state.liveHighlightEl.style.width = r.width + "px";
      state.liveHighlightEl.style.height = r.height + "px";
    };
    window.addEventListener("resize", state.liveHighlightReposition);
    window.addEventListener("scroll", state.liveHighlightReposition, true);
    startLiveHighlightPositionLoop();
    state.liveHighlightTarget = ce;
  }
  function startLiveHighlightPositionLoop() {
    if (state.liveHighlightAnimationFrame) return;
    const tick = () => {
      state.liveHighlightAnimationFrame = null;
      if (!state.liveHighlightEl || !state.liveHighlightReposition) return;
      state.liveHighlightReposition();
      state.liveHighlightAnimationFrame = requestAnimationFrame(tick);
    };
    state.liveHighlightAnimationFrame = requestAnimationFrame(tick);
  }
  function clearLiveDraftHighlights() {
    if (state.liveHighlightEl) {
      if (state.liveHighlightAnimationFrame) {
        cancelAnimationFrame(state.liveHighlightAnimationFrame);
        state.liveHighlightAnimationFrame = null;
      }
      if (state.liveHighlightScrollHandler) {
        state.liveHighlightTarget?.removeEventListener("scroll", state.liveHighlightScrollHandler);
        state.liveHighlightScrollHandler = null;
      }
      if (state.liveHighlightReposition) {
        window.removeEventListener("resize", state.liveHighlightReposition);
        window.removeEventListener("scroll", state.liveHighlightReposition, true);
        state.liveHighlightReposition = null;
      }
      state.liveHighlightEl.remove();
      state.liveHighlightEl = null;
    }
    if (state.liveHighlightTarget && state.liveHighlightRestore) {
      state.liveHighlightTarget.style.color = state.liveHighlightRestore.color;
      state.liveHighlightTarget.style.caretColor = state.liveHighlightRestore.caretColor;
      state.liveHighlightRestore = null;
    }
    state.liveHighlightTarget = null;
  }
  function setupLiveDraftCheck() {
    let lastInputTime = 0;
    let liveCheckTarget = null;
    let liveDelay = 5e3;
    let liveCheckInFlight = false;
    function abortLiveDraftCheck({ removeBadge = true } = {}) {
      if (!liveCheckInFlight) return;
      state.activeCheckController?.abort();
      state.activeCheckController = null;
      liveCheckInFlight = false;
      if (removeBadge && !state.commandInFlight) removePendingBadge("checking");
    }
    state.cancelLiveDraft = () => {
      liveCheckTarget = null;
      abortLiveDraftCheck();
      removeErrorFloat();
    };
    safeGetStorage({
      grammarLiveDelay: 5,
      grammarLiveMinChars: 30
    }).then((s) => {
      liveDelay = (s.grammarLiveDelay || 5) * 1e3;
      state.minChars = s.grammarLiveMinChars || 30;
    });
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.grammarLiveDelay) {
          liveDelay = (changes.grammarLiveDelay.newValue || 5) * 1e3;
        }
        if (changes.grammarLiveMinChars) {
          state.minChars = changes.grammarLiveMinChars.newValue || 30;
        }
      });
    } catch {
    }
    setInterval(() => {
      if (liveCheckTarget && document.contains(liveCheckTarget)) {
        const val = (liveCheckTarget.value || liveCheckTarget.textContent || "").trim();
        if (!val) {
          removeErrorFloat();
          liveCheckTarget = null;
        }
      }
      if (!liveCheckTarget || !document.contains(liveCheckTarget)) return;
      const elapsed = Date.now() - lastInputTime;
      if (elapsed < liveDelay) return;
      const ta = liveCheckTarget;
      liveCheckTarget = null;
      const text = (ta.value || ta.textContent || "").trim();
      if (text.length < state.minChars) return;
      checkLiveDraft(ta, text, getConversationKey());
    }, 500);
    async function checkLiveDraft(ta, text, conversationKey = getConversationKey()) {
      if (state.commandInFlight) return;
      try {
        abortLiveDraftCheck();
        showPendingBadge("checking", "Checking grammar...");
        liveCheckInFlight = true;
        state.activeCheckController?.abort();
        state.activeCheckController = new AbortController();
        const settings = await safeGetStorage({
          grammarHost: "127.0.0.1",
          grammarPort: 8766,
          grammarMaxTokens: 4096
        });
        const body = { text, language: "auto" };
        if (settings.grammarMaxTokens > 0) body.max_tokens = settings.grammarMaxTokens;
        const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: state.activeCheckController.signal
        });
        const data = await resp.json();
        if (liveCheckInFlight) {
          liveCheckInFlight = false;
          state.activeCheckController = null;
          removePendingBadge("checking");
        } else {
          return;
        }
        if (conversationKey !== getConversationKey() || !document.contains(ta)) {
          return;
        }
        if (!resp.ok) {
          showResultBadge("Grammar check failed: " + (data?.detail || resp.status), 5e3);
          return;
        }
        if (data?.errors?.length > 0) {
          highlightLiveDraft(ta, data.errors);
        } else {
          showGreenCheck(ta, text);
        }
      } catch (err) {
        if (err.name === "AbortError") {
          console.debug("[AI Grammar] Live check aborted");
          if (liveCheckInFlight) {
            liveCheckInFlight = false;
            state.activeCheckController = null;
            removePendingBadge("checking");
          }
        } else {
          abortLiveDraftCheck();
          console.debug("[AI Grammar] Live check error:", err);
        }
      }
    }
    document.addEventListener("input", (e) => {
      const ta = e.target;
      if (ta.tagName !== "TEXTAREA" && !ta.isContentEditable) return;
      if (state.skipLiveCheck) return;
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
      abortLiveDraftCheck();
      const raw = ta.value || ta.textContent || "";
      if (!raw || raw === ta.placeholder) {
        liveCheckTarget = null;
        return;
      }
      const text = raw.trim();
      if (text.length < state.minChars) return;
      liveCheckTarget = ta;
      lastInputTime = Date.now();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const ta = e.target;
      if (ta.tagName !== "TEXTAREA" && !ta.isContentEditable) return;
      liveCheckTarget = null;
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
      abortLiveDraftCheck();
    }, true);
    document.addEventListener("submit", () => {
      liveCheckTarget = null;
      clearLiveDraftHighlights();
      removeErrorFloat();
      removeEditableGreenChecks();
      abortLiveDraftCheck();
    }, true);
  }

  // src/apply-correction.js
  function applyCorrection(errorEl) {
    const correction = errorEl.getAttribute("data-correction");
    if (!correction) return;
    if (errorEl.hasAttribute("data-live-draft")) {
      let ta = state.liveHighlightTarget;
      if (!ta) {
        ta = document.querySelector('footer div[contenteditable="true"][role="textbox"]') || document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector('[contenteditable="true"]');
      }
      if (!ta || !document.contains(ta)) {
        hideTooltip();
        return;
      }
      const spans = (state.liveHighlightEl || document).querySelectorAll(
        ".ai-grammar-error[data-live-draft], .ai-grammar-improvement[data-live-draft], .ai-grammar-idiom[data-live-draft]"
      );
      if (spans?.length) {
        const fixes = Array.from(spans).map((s) => ({
          start: Number(s.getAttribute("data-start")),
          end: Number(s.getAttribute("data-end")),
          correction: s.getAttribute("data-correction") || ""
        })).filter((f) => Number.isInteger(f.start) && Number.isInteger(f.end) && f.correction).sort((a, b) => b.start - a.start);
        let text = (ta.value || ta.textContent || "").replace(/\u200B/g, "");
        for (const f of fixes) {
          text = text.slice(0, f.start) + f.correction + text.slice(f.end);
        }
        if (ta.tagName === "TEXTAREA") {
          ta.value = text;
          ta.selectionStart = ta.selectionEnd = text.length;
          ta.focus();
          ta.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertReplacementText",
            data: text
          }));
        } else if (ta.isContentEditable) {
          hideTooltip();
          clearLiveDraftHighlights();
          state.skipLiveCheck = true;
          state.cancelLiveDraft?.();
          ta.focus();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = document.querySelector(
                'footer div[contenteditable="true"][role="textbox"]'
              ) || document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector('[contenteditable="true"]');
              if (el && document.contains(el)) {
                const before = (el.textContent || el.innerText || "").replace(/\u200B/g, "");
                el.focus();
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(range);
                el.dispatchEvent(new InputEvent("beforeinput", {
                  bubbles: true,
                  cancelable: true,
                  inputType: "insertReplacementText",
                  data: text
                }));
                requestAnimationFrame(() => {
                  const after = (el.textContent || el.innerText || "").replace(/\u200B/g, "");
                  if (after !== before) {
                    showResultBadge("\u2713 Fixed!", 3e3);
                  } else {
                    console.debug(
                      "[AI Grammar] beforeinput had no effect, falling back to CDP",
                      { before, after, text: text.replace(/\u200B/g, "") }
                    );
                    applyFixCDP(text).then((success) => {
                      if (success) {
                        showResultBadge("\u2713 Fixed!", 3e3);
                      } else {
                        navigator.clipboard.writeText(text).catch(() => {
                        });
                        showResultBadge("Copied to clipboard \u2014 paste (Ctrl+V) to apply", 4e3);
                      }
                      state.skipLiveCheck = false;
                    });
                    return;
                  }
                  state.skipLiveCheck = false;
                });
              } else {
                console.debug("[AI Grammar] contentEditable not found, falling back to CDP");
                applyFixCDP(text).then((success) => {
                  if (success) {
                    showResultBadge("\u2713 Fixed!", 3e3);
                  } else {
                    navigator.clipboard.writeText(text).catch(() => {
                    });
                    showResultBadge("Copied to clipboard \u2014 paste (Ctrl+V) to apply", 4e3);
                  }
                  state.skipLiveCheck = false;
                });
                return;
              }
              state.skipLiveCheck = false;
            });
          });
        }
      }
      hideTooltip();
      return;
    }
    errorEl.textContent = correction;
    errorEl.classList.remove("ai-grammar-error", "ai-grammar-improvement", "ai-grammar-idiom");
    errorEl.removeAttribute("data-correction");
    errorEl.removeAttribute("data-explanation");
    errorEl.removeAttribute("data-error");
    errorEl.removeAttribute("data-type");
    errorEl.removeAttribute("tabindex");
    hideTooltip();
  }
  function tryBeforeInput(text, ta) {
    return new Promise((resolve) => {
      try {
        const before = (ta.textContent || ta.innerText || "").replace(/​/g, "");
        ta.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ta);
        sel.removeAllRanges();
        sel.addRange(range);
        ta.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertReplacementText",
          data: text
        }));
        requestAnimationFrame(() => {
          const after = (ta.textContent || ta.innerText || "").replace(/​/g, "");
          resolve(after !== before);
        });
      } catch {
        resolve(false);
      }
    });
  }
  function applyFixCDP(text) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "grammar:apply-fix", text },
          (resp) => resolve(resp && resp.ok === true)
        );
      } catch {
        resolve(false);
      }
    });
  }

  // src/events.js
  document.addEventListener("mouseover", (e) => {
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
    if (errorEl) {
      if (state.tooltipTimeout) clearTimeout(state.tooltipTimeout);
      state.tooltipTimeout = setTimeout(() => {
        state.tooltipTimeout = null;
        showTooltip(errorEl);
      }, 300);
    } else if (!e.target.closest(".ai-grammar-tooltip")) {
      hideTooltip();
    }
  });
  document.addEventListener("mouseout", (e) => {
    const fromError = e.target.closest?.(GRAMMAR_CLASSES);
    if (!fromError) return;
    const to = e.relatedTarget;
    if (to?.closest?.(".ai-grammar-tooltip") || to?.closest?.(GRAMMAR_CLASSES)) return;
    hideTooltip();
  });
  document.addEventListener("focusin", (e) => {
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
    if (errorEl) {
      showTooltip(errorEl);
    }
  });
  document.addEventListener("click", (e) => {
    const applyBtn = e.target.closest(".ag-apply");
    if (applyBtn && state.currentErrorEl) {
      applyCorrection(state.currentErrorEl);
      return;
    }
    const dismissBtn = e.target.closest(".ag-dismiss");
    if (dismissBtn) {
      hideTooltip();
      return;
    }
    const errorEl = e.target.closest(GRAMMAR_CLASSES);
    if (errorEl && !e.target.closest(".ai-grammar-tooltip")) {
      applyCorrection(errorEl);
      return;
    }
    if (!e.target.closest(".ai-grammar-tooltip") && !e.target.closest(GRAMMAR_CLASSES)) {
      hideTooltip();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.tooltipEl?.style.display === "block") {
      hideTooltip();
    }
  });

  // src/highlight.js
  function highlightErrors(container, errors, checkedText = "") {
    if (!errors || errors.length === 0) return 0;
    const makeWalker = () => document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isIgnored(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    function walkTextNodes() {
      const nodes = [];
      const w = makeWalker();
      let n, off = 0;
      while (n = w.nextNode()) {
        nodes.push({ node: n, start: off, end: off + n.textContent.length });
        off += n.textContent.length;
      }
      return { nodes, fullText: nodes.map((tn) => tn.node.textContent).join("") };
    }
    let { nodes: textNodes, fullText } = walkTextNodes();
    if (!textNodes.length) return 0;
    function findRangeByOffsets(start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > fullText.length) {
        return null;
      }
      const startNode = textNodes.find((tn) => start >= tn.start && start <= tn.end);
      const endNode = textNodes.find((tn) => end >= tn.start && end <= tn.end);
      if (!startNode || !endNode) return null;
      const range = document.createRange();
      range.setStart(startNode.node, start - startNode.start);
      range.setEnd(endNode.node, end - endNode.start);
      return range;
    }
    function findRangeByText(errText, fromIndex = 0) {
      if (!errText) return null;
      const idx = fullText.indexOf(errText, Math.max(0, fromIndex));
      if (idx === -1) return null;
      return findRangeByOffsets(idx, idx + errText.length);
    }
    let highlighted = 0;
    const sortedErrors = [...errors].sort((a, b) => {
      const aStart = Number.isFinite(Number(a.start)) ? Number(a.start) : -1;
      const bStart = Number.isFinite(Number(b.start)) ? Number(b.start) : -1;
      return bStart - aStart;
    });
    for (const err of sortedErrors) {
      const errText = err.error;
      if (!errText) continue;
      const cls = err.type === "improvement" ? "ai-grammar-improvement" : err.type === "idiom" ? "ai-grammar-idiom" : "ai-grammar-error";
      const start = Number(err.start);
      const end = Number(err.end);
      let range = null;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const candidate = fullText.slice(start, end);
        if (!errText || candidate === errText || candidate.trim() === errText.trim()) {
          range = findRangeByOffsets(start, end);
        }
      }
      if (!range) {
        const preferredStart = checkedText && checkedText === fullText && Number.isFinite(start) ? start : 0;
        range = findRangeByText(errText, preferredStart) || findRangeByText(errText, 0);
      }
      if (!range) continue;
      const span = document.createElement("span");
      span.className = cls;
      span.setAttribute("data-correction", err.correction || "");
      span.setAttribute("data-explanation", err.explanation || "");
      span.setAttribute("data-error", err.error || "");
      span.setAttribute("data-type", err.type || "error");
      span.setAttribute("tabindex", "0");
      let wrapped = false;
      try {
        range.surroundContents(span);
        wrapped = true;
      } catch {
        try {
          const frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
          wrapped = true;
        } catch {
        }
      }
      if (wrapped) {
        highlighted++;
        if (highlighted < sortedErrors.length) {
          ({ nodes: textNodes, fullText } = walkTextNodes());
        }
      }
    }
    return highlighted;
  }
  function highlightOverlay(container, errors, fullText) {
    if (!errors?.length) return 0;
    removeMessageOverlay(container);
    let html = "";
    let pos = 0;
    const sorted = [...errors].sort((a, b) => Number(a.start) - Number(b.start));
    for (const err of sorted) {
      const s = Math.max(0, Number(err.start));
      const e = Math.min(fullText.length, Number(err.end));
      if (s < pos || s >= e) continue;
      html += escapeHtml(fullText.slice(pos, s));
      const cls = err.type === "improvement" ? "ai-grammar-improvement" : err.type === "idiom" ? "ai-grammar-idiom" : "ai-grammar-error";
      html += `<span class="${cls}" style="pointer-events:auto;cursor:pointer;text-underline-offset:0"
        data-correction="${escapeHtml(err.correction || "")}"
        data-explanation="${escapeHtml(err.explanation || "")}"
        data-error="${escapeHtml(err.error || "")}"
        data-type="${err.type || "error"}" tabindex="0">${escapeHtml(fullText.slice(s, e))}</span>`;
      pos = e;
    }
    html += escapeHtml(fullText.slice(pos));
    const overlay = document.createElement("div");
    overlay.className = "ag-message-overlay";
    overlay.setAttribute("data-ag-overlay", "");
    overlay.innerHTML = html;
    const cs = window.getComputedStyle(container);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const borderRight = parseFloat(cs.borderRightWidth) || 0;
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "2147483644",
      pointerEvents: "none",
      // --- Text rendering properties (complete set) ---
      font: cs.font,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontVariant: cs.fontVariant,
      fontStretch: cs.fontStretch,
      fontKerning: cs.fontKerning,
      fontFeatureSettings: cs.fontFeatureSettings,
      fontVariationSettings: cs.fontVariationSettings,
      fontOpticalSizing: cs.fontOpticalSizing,
      textRendering: cs.textRendering,
      textTransform: cs.textTransform,
      direction: cs.direction,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      wordSpacing: cs.wordSpacing,
      textAlign: cs.textAlign,
      textIndent: cs.textIndent,
      whiteSpace: cs.whiteSpace,
      overflowWrap: cs.overflowWrap,
      wordBreak: cs.wordBreak,
      wordWrap: cs.wordWrap,
      tabSize: cs.tabSize,
      hyphens: cs.hyphens,
      textWrapMode: cs.textWrapMode,
      textWrapStyle: cs.textWrapStyle,
      writingMode: cs.writingMode,
      unicodeBidi: cs.unicodeBidi,
      color: "rgba(0, 0, 0, 0.02)",
      WebkitTextFillColor: "rgba(0, 0, 0, 0.02)",
      background: "transparent",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      boxSizing: "content-box",
      overflow: "hidden"
    });
    document.body.appendChild(overlay);
    function getMappedTextBounds(containerRect) {
      const fallback = {
        left: containerRect.left + borderLeft + (parseFloat(cs.paddingLeft) || 0),
        top: containerRect.top + borderTop + (parseFloat(cs.paddingTop) || 0),
        width: Math.max(0, containerRect.width - borderLeft - borderRight - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
      };
      const textNodes = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node2) {
          if (node2.parentElement && isIgnored(node2.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node, offset = 0;
      while (node = walker.nextNode()) {
        textNodes.push({ node, start: offset, end: offset + node.textContent.length });
        offset += node.textContent.length;
      }
      if (!textNodes.length || !fullText) return fallback;
      const rawText = textNodes.map((tn) => tn.node.textContent).join("");
      const mappedStart = rawText.indexOf(fullText);
      if (mappedStart === -1) return fallback;
      const mappedEnd = mappedStart + fullText.length;
      const startTextNode = textNodes.find((tn) => mappedStart >= tn.start && mappedStart < tn.end);
      const endTextNode = textNodes.find((tn) => mappedEnd > tn.start && mappedEnd <= tn.end);
      if (!startTextNode || !endTextNode) return fallback;
      const range = document.createRange();
      try {
        const startOffset = mappedStart - startTextNode.start;
        range.setStart(startTextNode.node, startOffset);
        range.setEnd(startTextNode.node, startOffset + 1);
        const startRect = range.getClientRects()[0];
        if (!startRect || !startRect.width && !startRect.height) return fallback;
        const endOffset = mappedEnd - endTextNode.start;
        range.setStart(endTextNode.node, endOffset - 1);
        range.setEnd(endTextNode.node, endOffset);
        const endRects = range.getClientRects();
        const endRect = endRects[endRects.length - 1];
        if (!endRect || !endRect.width && !endRect.height) {
          return { left: startRect.left, top: startRect.top, width: fallback.width };
        }
        return {
          left: startRect.left,
          top: startRect.top,
          width: Math.max(0, endRect.right - startRect.left)
        };
      } finally {
        range.detach();
      }
    }
    function reposition() {
      if (!document.contains(container)) {
        removeMessageOverlay(container);
        return;
      }
      const r = container.getBoundingClientRect();
      const textBounds = getMappedTextBounds(r);
      overlay.style.transform = `translate(${textBounds.left}px, ${textBounds.top}px)`;
      overlay.style.width = textBounds.width + "px";
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const poll = setInterval(() => {
      if (!document.contains(container)) removeMessageOverlay(container);
    }, 2e3);
    const cleanup = () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      clearInterval(poll);
      if (document.contains(overlay)) overlay.remove();
    };
    state.messageOverlays.set(container, { overlay, cleanup });
    return errors.length;
  }
  function removeMessageOverlay(container) {
    const entry = state.messageOverlays.get(container);
    if (entry) {
      entry.cleanup();
      state.messageOverlays.delete(container);
    }
  }

  // src/check-text.js
  async function checkText(text, container, conversationKey = getConversationKey()) {
    if (conversationKey !== getConversationKey() || !document.contains(container)) return;
    const wa = getWhatsAppBridge();
    if (wa) {
      const waContainer = wa.findMessageContainer(container) || container;
      const waText = wa.getMessageText(waContainer);
      if (waContainer && waText) {
        container = waContainer;
        text = waText;
      }
    }
    const id = ++state.checkIdCounter;
    removeGreenCheck(container);
    showPendingBadge("checking", "Checking grammar...");
    const checkController = new AbortController();
    try {
      const settings = await safeGetStorage({
        grammarHost: "127.0.0.1",
        grammarPort: 8766,
        grammarMaxTokens: 4096
      });
      const body = { text, language: "auto" };
      if (settings.grammarMaxTokens > 0) body.max_tokens = settings.grammarMaxTokens;
      const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: checkController.signal
      });
      const data = await resp.json();
      removePendingBadge("checking");
      if (conversationKey !== getConversationKey() || !document.contains(container)) {
        return;
      }
      if (!resp.ok) {
        showResultBadge("Grammar check failed: " + (data?.detail || resp.status), 5e3);
        return;
      }
      if (!data?.errors) return;
      const errors = data.errors;
      if (errors.length === 0) {
        showGreenCheck(container, text);
        return;
      }
      state.isHighlighting = true;
      let count;
      if (wa) {
        count = wa.renderOverlay(container, errors, text);
      } else {
        for (const cls of ["ai-grammar-error", "ai-grammar-improvement", "ai-grammar-idiom"]) {
          container.querySelectorAll(`.${cls}:not([data-live-draft])`).forEach((span) => {
            const parent = span.parentNode;
            if (parent) {
              while (span.firstChild) parent.insertBefore(span.firstChild, span);
              parent.removeChild(span);
            }
          });
        }
        const containerText = getTextContent(container);
        const textOffset = containerText.indexOf(text);
        if (textOffset >= 0) {
          const adjustedErrors = errors.map((e) => ({
            ...e,
            start: Number(e.start) + textOffset,
            end: Number(e.end) + textOffset
          }));
          count = highlightErrors(container, adjustedErrors, containerText);
        } else {
          count = 0;
        }
        if (!count) count = highlightOverlay(container, errors, text);
      }
      state.isHighlighting = false;
      if (count > 0) {
        const breakdown = { error: 0, improvement: 0, idiom: 0 };
        for (const e of errors) {
          breakdown[e.type] = (breakdown[e.type] || 0) + 1;
        }
        const parts = [];
        if (breakdown.error) parts.push(`${breakdown.error} error${breakdown.error > 1 ? "s" : ""}`);
        if (breakdown.improvement) parts.push(`${breakdown.improvement} improvement${breakdown.improvement > 1 ? "s" : ""}`);
        if (breakdown.idiom) parts.push(`${breakdown.idiom} idiom${breakdown.idiom > 1 ? "s" : ""}`);
        showResultBadge(parts.join(", ") + " found");
      }
    } catch (e) {
      removePendingBadge("checking");
      if (e.name !== "AbortError") {
        console.debug("[AI Grammar] Check error:", e);
      }
    }
  }

  // src/selection-check.js
  function receiveSelectionCheckMessage(message, _sender, sendResponse) {
    if (message?.type === "grammar:check-selection") {
      handleSelectionCheck();
      sendResponse?.({ ok: true });
      return false;
    }
  }
  try {
    chrome.runtime.onMessage.addListener(receiveSelectionCheckMessage);
  } catch (e) {
    if (e.message?.includes("Extension context invalidated")) {
      state.contextInvalidated = true;
    } else {
      console.debug("[AI Grammar] Failed to register selection listener:", e);
    }
  }
  window.addEventListener("grammar:check-selection", () => {
    handleSelectionCheck();
  });
  function handleSelectionCheck() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = range.toString().trim();
    if (text.length < state.minChars) {
      showResultBadge("Selection too short to check");
      return;
    }
    const selWhatsApp = getWhatsAppBridge();
    if (selWhatsApp) {
      const waContainer = selWhatsApp.findMessageContainer(range.commonAncestorContainer);
      if (waContainer) {
        const waText = selWhatsApp.getMessageText(waContainer);
        if (waText.length >= state.minChars) {
          checkText(waText, waContainer);
          return;
        }
      }
    }
    let container = range.commonAncestorContainer;
    while (container && container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    if (!container) {
      if (selWhatsApp) {
        checkText(text, document.body);
        return;
      }
      return;
    }
    let el = container;
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display;
      if (display !== "inline" && display !== "contents") break;
      el = el.parentElement;
    }
    container = el || container;
    let found = null;
    let candidate = container;
    while (candidate && candidate !== document.body && candidate !== document.documentElement) {
      if (candidate.nodeType === Node.ELEMENT_NODE && candidate.matches(USER_MESSAGE_SELECTOR)) {
        found = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }
    if (!found) {
      candidate = container.parentElement;
      while (candidate && candidate !== document.body && candidate !== document.documentElement) {
        const parent = candidate.parentElement;
        if (parent && parent !== document.body && parent !== document.documentElement) {
          const parentCls = (parent.className || "").toLowerCase();
          const parentId = (parent.id || "").toLowerCase();
          const role = parent.getAttribute("role");
          if (parentCls.includes("msg") || parentCls.includes("message") || parentCls.includes("chat") || parentCls.includes("conversation") || parentId.includes("msg") || parentId.includes("message") || parentId.includes("chat") || parentId.includes("conversation") || role === "list" || role === "log" || role === "feed") {
            found = candidate;
            break;
          }
        }
        const cls = (candidate.className || "").toLowerCase();
        if (cls.includes("msg") || cls.includes("message") || cls.includes("bubble") || cls.includes("row") || cls.includes("item")) {
          found = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
    }
    if (found) container = found;
    checkText(text, container);
  }

  // src/styles.js
  function injectStyles() {
    if (document.getElementById("ai-grammar-styles")) return;
    const style = document.createElement("style");
    style.id = "ai-grammar-styles";
    style.textContent = `
      /* text-decoration wavy underlines \u2014 positioned by the browser from
         the real mirrored text baseline, independent of platform font/line-height.  The
         old SVG background-image approach required manual offsets that
         varied by platform (iMessage vs Hermes WebUI vs test page).
         Overlay spans use rgba(0,0,0,0.02) to defeat Chromium's
         text-decoration paint skip: 0.02 * 255 = 5.1 \u2192 never quantises
         to 0 at any zoom/DPI combo (0.01 could floor to 0 at extreme
         subpixel configurations).  text-decoration-skip-ink: none
         prevents the browser from omitting decorations that intersect
         glyph descenders, so the underline needs extra offset to clear
         descenders like g/y/p. */
      .ai-grammar-error {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #dc2626 !important;
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-error:hover {
        background-color: rgba(220, 38, 38, 0.08);
      }
      .ai-grammar-improvement {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #4ade80 !important;
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-improvement:hover {
        background-color: rgba(74, 222, 128, 0.08);
      }
      .ai-grammar-idiom {
        text-decoration-line: underline !important;
        text-decoration-style: wavy !important;
        text-decoration-color: #60a5fa !important;
        text-decoration-thickness: from-font !important;
        text-underline-offset: 0;
        text-decoration-skip-ink: none;
        -webkit-text-decoration-skip: none;
        cursor: pointer;
        border-radius: 2px;
      }
      .ai-grammar-idiom:hover {
        background-color: rgba(96, 165, 250, 0.08);
      }
      .ai-grammar-error:focus-visible {
        outline: 2px solid #dc2626;
        outline-offset: 1px;
        border-radius: 2px;
      }
      .ag-live-highlight {
        isolation: isolate;
      }
      .ag-live-highlight-backdrop {
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
        scrollbar-width: none;
      }
      .ag-live-highlight-backdrop::-webkit-scrollbar {
        display: none;
      }
      .ag-live-highlight-backdrop .ai-grammar-error,
      .ag-live-highlight-backdrop .ai-grammar-improvement,
      .ag-live-highlight-backdrop .ai-grammar-idiom {
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
        text-underline-offset: 0.45em;
      }
      .ai-grammar-tooltip {
        position: fixed;
        z-index: 2147483647;
        background: #1e293b;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        padding: 10px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        max-width: 360px;
        pointer-events: auto;
        animation: ai-gfadein 0.15s ease;
      }
      .ai-grammar-tooltip .ag-correction {
        color: #4ade80;
        font-weight: 600;
      }
      .ai-grammar-tooltip .ag-explanation {
        color: #94a3b8;
        font-size: 12px;
        margin-top: 4px;
      }
      .ai-grammar-tooltip .ag-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .ai-grammar-tooltip button {
        border: none;
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 500;
        font-family: inherit;
      }
      .ai-grammar-tooltip .ag-apply {
        background: #4ade80;
        color: #0f172a;
      }
      .ai-grammar-tooltip .ag-apply:hover { background: #22c55e; }
      .ai-grammar-tooltip .ag-dismiss {
        background: #334155;
        color: #cbd5e1;
      }
      .ai-grammar-tooltip .ag-dismiss:hover { background: #475569; }
      .ai-grammar-tooltip .ag-arrow {
        position: absolute;
        top: -6px;
        left: 20px;
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-bottom: 6px solid #1e293b;
      }
      @keyframes ai-gfadein {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .ag-badge-stack {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483646;
        display: flex;
        flex-direction: column-reverse;
        gap: 8px;
        pointer-events: none;
        max-width: 320px;
      }
      .ai-grammar-badge {
        background: #1e293b;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        padding: 6px 12px;
        border-radius: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        gap: 6px;
        animation: ai-gfadein 0.2s ease;
        pointer-events: auto;
        white-space: nowrap;
        width: fit-content;
        align-self: flex-end;
      }
      .ai-grammar-badge.ag-badge-result {
        border: 1px solid #4ade80;
      }
      .ai-grammar-badge .ag-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #475569;
        border-top-color: #4ade80;
        border-radius: 50%;
        animation: ai-gspin 0.8s linear infinite;
      }
      .ai-grammar-badge .ag-count {
        background: rgba(255,255,255,0.15);
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 600;
        margin-left: 2px;
      }
      @keyframes ai-gspin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-color-scheme: light) {
        .ai-grammar-tooltip {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        }
        .ai-grammar-tooltip .ag-correction {
          color: #16a34a;
        }
        .ai-grammar-tooltip .ag-explanation {
          color: #64748b;
        }
        .ai-grammar-tooltip .ag-apply {
          background: #16a34a;
          color: #ffffff;
        }
        .ai-grammar-tooltip .ag-apply:hover { background: #15803d; }
        .ai-grammar-tooltip .ag-dismiss {
          background: #f1f5f9;
          color: #475569;
        }
        .ai-grammar-tooltip .ag-dismiss:hover { background: #e2e8f0; }
        .ai-grammar-tooltip .ag-arrow {
          border-bottom-color: #ffffff;
        }
        .ai-grammar-badge {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .ai-grammar-badge.ag-badge-result {
          border-color: #16a34a;
        }
        .ai-grammar-badge .ag-spinner {
          border-color: #e2e8f0;
          border-top-color: #16a34a;
        }
        .ai-grammar-badge .ag-count {
          background: rgba(0,0,0,0.08);
        }
      }
      .ai-grammar-ok {
        display: inline-block;
        color: #4ade80;
        font-size: 0.75em;
        font-weight: 700;
        margin-left: 4px;
        vertical-align: super;
        line-height: 1;
        animation: ai-gfadein 0.3s ease;
      }
      .ai-grammar-ok-ta {
        position: fixed;
        z-index: 2147483645;
        color: #4ade80;
        font-size: 14px;
        font-weight: 700;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        pointer-events: none;
        animation: ai-gfadein 0.3s ease;
        opacity: 1;
        background: rgba(22, 101, 52, 0.85);
        border-radius: 4px;
        padding: 2px 6px;
        line-height: 1.3;
      }
      @media (prefers-color-scheme: light) {
        .ai-grammar-ok {
          color: #16a34a;
        }
        .ai-grammar-ok-ta {
          color: #16a34a;
          background: rgba(220, 252, 231, 0.9);
        }
      }
      .ag-message-overlay {
        color: rgba(0, 0, 0, 0.02) !important;
        -webkit-text-fill-color: rgba(0, 0, 0, 0.02) !important;
      }
      .ag-message-overlay .ai-grammar-error,
      .ag-message-overlay .ai-grammar-improvement,
      .ag-message-overlay .ai-grammar-idiom {
        text-underline-offset: 0.45em;
      }
    `;
    document.head.appendChild(style);
  }

  // src/conversation.js
  function clearConversationScopedState({ updateKey = true } = {}) {
    if (updateKey) state.activeConversationKey = getConversationKey();
    clearLiveDraftHighlights();
    hideTooltip();
    removeErrorFloat();
    removeEditableGreenChecks();
    removeAllBadges();
    for (const container of [...state.messageOverlays.keys()]) {
      removeMessageOverlay(container);
    }
    state.activeCheckController?.abort();
    state.activeCheckController = null;
    state.cancelLiveDraft?.();
    state.lastUserText = "";
    state.pendingSubmission = null;
    state.pendingChecks.clear();
  }
  function handleConversationMaybeChanged() {
    const nextKey = getConversationKey();
    if (!state.activeConversationKey) {
      state.activeConversationKey = nextKey;
      return;
    }
    if (nextKey === state.activeConversationKey) return;
    clearConversationScopedState();
  }
  function scheduleConversationCheck(event) {
    const wa = getWhatsAppBridge();
    if (event?.type === "click" && wa?.isChatListClick(event.target)) {
      clearConversationScopedState({ updateKey: false });
    }
    setTimeout(handleConversationMaybeChanged, 100);
    setTimeout(handleConversationMaybeChanged, 500);
  }

  // src/languages.js
  var LANGUAGES = [
    { code: "auto", name: "Auto-detect", aliases: ["automatic", "detect"] },
    { code: "en", name: "English", aliases: ["eng", "english"] },
    { code: "zh", name: "Chinese", aliases: ["ch", "chinese", "\u4E2D\u6587", "mandarin", "cn"] },
    { code: "ja", name: "Japanese", aliases: ["jp", "japanese", "\u65E5\u672C\u8A9E"] },
    { code: "ko", name: "Korean", aliases: ["kr", "korean", "\uD55C\uAD6D\uC5B4"] },
    { code: "fr", name: "French", aliases: ["french", "fran\xE7ais"] },
    { code: "de", name: "German", aliases: ["german", "deutsch"] },
    { code: "es", name: "Spanish", aliases: ["spanish", "espa\xF1ol"] },
    { code: "ru", name: "Russian", aliases: ["russian", "\u0440\u0443\u0441\u0441\u043A\u0438\u0439"] },
    { code: "pt", name: "Portuguese", aliases: ["portuguese", "portugu\xEAs"] },
    { code: "it", name: "Italian", aliases: ["italian", "italiano"] },
    { code: "ar", name: "Arabic", aliases: ["arabic", "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"] },
    { code: "nl", name: "Dutch", aliases: ["dutch", "nederlands"] },
    { code: "hi", name: "Hindi", aliases: ["hindi", "\u0939\u093F\u0928\u094D\u0926\u0940"] },
    { code: "th", name: "Thai", aliases: ["thai", "\u0E44\u0E17\u0E22"] },
    { code: "vi", name: "Vietnamese", aliases: ["vietnamese", "ti\u1EBFng vi\u1EC7t", "tieng viet"] },
    { code: "sv", name: "Swedish", aliases: ["swedish", "svenska"] },
    { code: "tr", name: "Turkish", aliases: ["turkish", "t\xFCrk\xE7e"] },
    { code: "pl", name: "Polish", aliases: ["polish", "polski"] },
    { code: "uk", name: "Ukrainian", aliases: ["ukrainian", "\u0443\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430"] },
    { code: "fi", name: "Finnish", aliases: ["finnish", "suomi"] },
    { code: "no", name: "Norwegian", aliases: ["norwegian", "norsk"] },
    { code: "da", name: "Danish", aliases: ["danish", "dansk"] },
    { code: "cs", name: "Czech", aliases: ["czech", "\u010De\u0161tina"] },
    { code: "el", name: "Greek", aliases: ["greek", "\u03B5\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC"] },
    { code: "he", name: "Hebrew", aliases: ["hebrew", "\u05E2\u05D1\u05E8\u05D9\u05EA"] },
    { code: "hu", name: "Hungarian", aliases: ["hungarian", "magyar"] },
    { code: "ro", name: "Romanian", aliases: ["romanian", "rom\xE2n\u0103"] },
    { code: "id", name: "Indonesian", aliases: ["indonesian", "bahasa", "bahasa indonesia"] },
    { code: "ms", name: "Malay", aliases: ["malay", "malaysian", "bahasa melayu", "bahasa malaysia"] },
    { code: "tl", name: "Filipino", aliases: ["filipino", "tagalog"] },
    { code: "bn", name: "Bengali", aliases: ["bengali", "\u09AC\u09BE\u0982\u09B2\u09BE"] },
    { code: "fa", name: "Persian", aliases: ["persian", "farsi", "\u0641\u0627\u0631\u0633\u06CC"] },
    { code: "ta", name: "Tamil", aliases: ["tamil", "\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD"] },
    { code: "te", name: "Telugu", aliases: ["telugu", "\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41"] },
    { code: "ur", name: "Urdu", aliases: ["urdu", "\u0627\u0631\u062F\u0648"] },
    { code: "sw", name: "Swahili", aliases: ["swahili", "kiswahili"] },
    { code: "bg", name: "Bulgarian", aliases: ["bulgarian", "\u0431\u044A\u043B\u0433\u0430\u0440\u0441\u043A\u0438"] },
    { code: "sk", name: "Slovak", aliases: ["slovak", "sloven\u010Dina"] },
    { code: "lt", name: "Lithuanian", aliases: ["lithuanian", "lietuvi\u0173"] },
    { code: "lv", name: "Latvian", aliases: ["latvian", "latvie\u0161u"] },
    { code: "et", name: "Estonian", aliases: ["estonian", "eesti"] }
  ];
  function searchLanguages(query) {
    if (!query) return [...LANGUAGES];
    const q = query.toLowerCase();
    const scored = [];
    for (const lang of LANGUAGES) {
      let score = 99;
      if (lang.code === q) score = 0;
      else if (lang.code.startsWith(q)) score = 1;
      else if (lang.name.toLowerCase().startsWith(q)) score = 2;
      else if (lang.aliases.some((a) => a.toLowerCase().startsWith(q))) score = 3;
      else if (lang.name.toLowerCase().includes(q)) score = 4;
      else if (lang.aliases.some((a) => a.toLowerCase().includes(q))) score = 5;
      else continue;
      scored.push({ ...lang, _score: score });
    }
    scored.sort((a, b) => a._score - b._score || a.code.localeCompare(b.code));
    return scored.map(({ _score, ...lang }) => lang);
  }
  function findUniqueMatch(query) {
    const results = searchLanguages(query);
    return results.length === 1 ? results[0] : null;
  }

  // src/commands.js
  async function stripCommand(cmd, ta) {
    const val = ta.value || ta.textContent || "";
    const idx = val.lastIndexOf(cmd);
    if (idx < 0) return;
    const cleaned = val.slice(0, idx) + val.slice(idx + cmd.length);
    state.skipLiveCheck = true;
    state.cancelLiveDraft?.();
    if (ta.tagName === "TEXTAREA") {
      ta.value = cleaned;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (await tryBeforeInput(cleaned, ta)) {
        // Success
      } else {
        applyFixCDP(cleaned);
      }
    }
    state.skipLiveCheck = false;
  }
  var COMMANDS = {
    off: {
      help: "Disable grammar checking",
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: false });
        showResultBadge("Grammar checker disabled");
      }
    },
    on: {
      help: "Enable grammar checking",
      async run() {
        await chrome.storage.sync.set({ grammarEnabled: true });
        showResultBadge("Grammar checker enabled");
      }
    },
    lang: {
      help: "Translate text (e.g., ?/lang fr). Pick a language or type any code.",
      async run(args, ta) {
        const targetLang = (args || "").toLowerCase().trim();
        if (!targetLang) {
          showResultBadge("Type a language code (e.g., ?/lang fr, ?/lang ja)");
          return;
        }
        const value = ta.value || ta.textContent || "";
        const cmdStr = "?/lang " + args;
        const cmdIdx = value.lastIndexOf(cmdStr);
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge(`No text to translate (need at least ${state.minChars} characters)`);
          await stripCommand(cmdStr, ta);
          return;
        }
        showPendingBadge("translating", "Translating...");
        state.commandInFlight = true;
        state.cancelLiveDraft?.();
        state.activeCheckController?.abort();
        try {
          const settings = await safeGetStorage({ grammarHost: "127.0.0.1", grammarPort: 8766 });
          const translateController = new AbortController();
          const timeoutId = setTimeout(() => translateController.abort(), 6e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, target_lang: targetLang }),
            signal: translateController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removePendingBadge("translating");
          if (!resp.ok) {
            showResultBadge(`Translation failed: ${data?.detail || resp.status}`, 5e3);
            return;
          }
          const translated = data.translated;
          if (!translated || translated === draft) {
            showResultBadge("\u2713 Text is already in that language or could not be translated");
            await stripCommand(cmdStr, ta);
            return;
          }
          state.skipLiveCheck = true;
          if (ta.tagName === "TEXTAREA") {
            ta.value = translated;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            if (await tryBeforeInput(translated, ta)) {
            } else {
              applyFixCDP(translated).then((success) => {
                if (success) {
                  showResultBadge(`\u2713 Translated to ${targetLang.toUpperCase()}`, 3e3);
                } else {
                  navigator.clipboard.writeText(translated).catch(() => {
                  });
                  showResultBadge("Copied translation to clipboard \u2014 paste (Ctrl+V) to apply", 4e3);
                }
                state.skipLiveCheck = false;
              });
              state.cancelLiveDraft?.();
              state.activeCheckController?.abort();
              return;
            }
          }
          state.skipLiveCheck = false;
          state.cancelLiveDraft?.();
          state.activeCheckController?.abort();
          ta.focus();
          showResultBadge(`\u2713 Translated to ${targetLang.toUpperCase()}`);
        } catch (e) {
          removePendingBadge("translating");
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out or was cancelled";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge(`Translation failed: ${reason}`);
        } finally {
          state.commandInFlight = false;
        }
      }
    },
    help: {
      help: "Show available commands",
      run() {
        const lines = Object.entries(COMMANDS).map(([name, cmd]) => `?/${name} \u2014 ${cmd.help}`);
        showResultBadge(lines.join("<br>"), 12e3);
      }
    },
    check: {
      help: "Manual grammar check for live-draft text",
      async run(_args, ta) {
        console.debug("[AI Grammar] ?/check command fired", { value: (ta?.value || ta?.textContent || "").slice(0, 30), minChars: state.minChars });
        async function stripCheck(input) {
          const val = input.value || input.textContent || "";
          const idx = val.lastIndexOf("?/check");
          const cleaned = (idx >= 0 ? val.slice(0, idx) + val.slice(idx + 7) : val).trimEnd();
          if (input.tagName === "TEXTAREA") {
            input.value = cleaned;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            if (await tryBeforeInput(cleaned, input)) {
            } else {
              applyFixCDP(cleaned);
            }
          }
        }

        const value = ta.value || ta.textContent || "";
        const cmdIdx = value.lastIndexOf("?/check");
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge("Too short (min " + state.minChars + " chars)");
          await stripCheck(ta);
          return;
        }
        state.cancelLiveDraft?.();
        state.activeCheckController?.abort();
        showPendingBadge("checking", "Checking grammar...");
        state.commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: "127.0.0.1",
            grammarPort: 8766
          });
          state.activeCheckController?.abort();
          state.activeCheckController = new AbortController();
          const timeoutId = setTimeout(() => state.activeCheckController.abort(), 3e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, language: "auto" }),
            signal: state.activeCheckController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          if (!resp.ok) {
            showResultBadge("Grammar check failed: " + (data?.detail || resp.status), 5e3);
            return;
          }
          if (data?.errors?.length > 0) {
            state.skipLiveCheck = true;
            await stripCheck(ta);
            state.skipLiveCheck = false;
            highlightLiveDraft(ta, data.errors);
          } else {
            state.skipLiveCheck = true;
            await stripCheck(ta);
            state.skipLiveCheck = false;
            showGreenCheck(ta, draft);
          }
        } catch (e) {
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge("Check failed: " + reason);
        } finally {
          removePendingBadge("checking");
          state.commandInFlight = false;
          state.activeCheckController = null;
        }
      }
    },
    fix: {
      help: "Auto-correct the text you typed (everything before ?/fix)",
      async run(_args, ta) {
        const value = ta.value || ta.textContent || "";
        const cmdIdx = value.lastIndexOf("?/fix");
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge("No text to fix (need at least " + state.minChars + " characters)");
          await stripCommand("?/fix", ta);
          return;
        }
        showPendingBadge("fixing", "Fixing...");
        state.commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: "127.0.0.1",
            grammarPort: 8766
          });
          const fixController = new AbortController();
          const timeoutId = setTimeout(() => fixController.abort(), 3e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, language: "auto" }),
            signal: fixController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removePendingBadge("fixing");
          if (!data?.errors?.length) {
            showResultBadge("\u2713 No corrections needed");
            await stripCommand("?/fix", ta);
            return;
          }
          const sorted = [...data.errors].sort((a, b) => b.start - a.start);
          let fixed = draft;
          for (const err of sorted) {
            fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
          }
          state.skipLiveCheck = true;
          if (ta.tagName === "TEXTAREA") {
            ta.value = fixed;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            if (await tryBeforeInput(fixed, ta)) {
            } else {
              applyFixCDP(fixed).then((success) => {
                if (success) {
                  showResultBadge(`\u2713 Fixed ${sorted.length} issue${sorted.length > 1 ? "s" : ""}`, 3e3);
                } else {
                  navigator.clipboard.writeText(fixed).catch(() => {
                  });
                  showResultBadge(`Copied fixed text to clipboard \u2014 paste (Ctrl+V) to apply`, 4e3);
                }
                state.skipLiveCheck = false;
              });
              state.cancelLiveDraft?.();
              state.activeCheckController?.abort();
              return;
            }
          }
          state.skipLiveCheck = false;
          state.cancelLiveDraft?.();
          state.activeCheckController?.abort();
          ta.focus();
          showResultBadge(`\u2713 Fixed ${sorted.length} issue${sorted.length > 1 ? "s" : ""}`);
        } catch (e) {
          removePendingBadge("fixing");
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out or was cancelled";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge(`Fix failed: ${reason}`);
        } finally {
          state.commandInFlight = false;
        }
      }
    },
    polish: {
      help: "Polish the text you typed (everything before ?/polish)",
      async run(_args, ta) {
        const value = ta.value || ta.textContent || "";
        const cmdIdx = value.lastIndexOf("?/polish");
        const draft = (cmdIdx >= 0 ? value.slice(0, cmdIdx) : value).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge("No text to polish (need at least " + state.minChars + " characters)");
          await stripCommand("?/polish", ta);
          return;
        }
        showPendingBadge("polishing", "Polishing...");
        state.commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: "127.0.0.1",
            grammarPort: 8766
          });
          const polishController = new AbortController();
          const timeoutId = setTimeout(() => polishController.abort(), 6e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/polish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, language: "auto" }),
            signal: polishController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removePendingBadge("polishing");
          if (!resp.ok) {
            showResultBadge(`Polish failed: ${data?.detail || resp.status}`, 5e3);
            return;
          }
          const polished = data.polished;
          if (!polished || polished === draft) {
            showResultBadge("\u2713 Text already polished");
            await stripCommand("?/polish", ta);
            return;
          }
          state.skipLiveCheck = true;
          if (ta.tagName === "TEXTAREA") {
            ta.value = polished;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            if (await tryBeforeInput(polished, ta)) {
            } else {
              applyFixCDP(polished).then((success) => {
                if (success) {
                  showResultBadge("\u2713 Polished", 3e3);
                } else {
                  navigator.clipboard.writeText(polished).catch(() => {
                  });
                  showResultBadge("Copied polished text to clipboard \u2014 paste (Ctrl+V) to apply", 4e3);
                }
                state.skipLiveCheck = false;
              });
              state.cancelLiveDraft?.();
              state.activeCheckController?.abort();
              return;
            }
          }
          state.skipLiveCheck = false;
          state.cancelLiveDraft?.();
          state.activeCheckController?.abort();
          ta.focus();
          showResultBadge("\u2713 Polished");
        } catch (e) {
          removePendingBadge("polishing");
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out or was cancelled";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge(`Polish failed: ${reason}`);
        } finally {
          state.commandInFlight = false;
        }
      }
    }
  };
  async function handleCommand(text, ta = null) {
    const match = text.match(/\?\/\w+(\s+\S+)?$/);
    if (!match) return false;
    const cmdText = match[0].trim();
    const parts = cmdText.slice(2).trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");
    const cmd = COMMANDS[cmdName];
    if (!cmd) {
      showResultBadge(`Unknown command: ?/${cmdName}. Try ?/help`);
      return true;
    }
    try {
      if ((cmdName === "fix" || cmdName === "polish" || cmdName === "check" || cmdName === "lang") && ta) {
        await cmd.run(args, ta);
      } else if (cmdName === "fix") {
        const cmdIdx = text.lastIndexOf("?/fix");
        const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge("No text to fix (need at least " + state.minChars + " characters)");
          return true;
        }
        showPendingBadge("fixing", "Fixing...");
        state.commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: "127.0.0.1",
            grammarPort: 8766
          });
          const fixController = new AbortController();
          const timeoutId = setTimeout(() => fixController.abort(), 3e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, language: "auto" }),
            signal: fixController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removePendingBadge("fixing");
          if (!data?.errors?.length) {
            showResultBadge("\u2713 No corrections needed");
            return true;
          }
          const sorted = [...data.errors].sort((a, b) => b.start - a.start);
          let fixed = draft;
          for (const err of sorted) {
            fixed = fixed.slice(0, err.start) + err.correction + fixed.slice(err.end);
          }
          showResultBadge(`Corrected: "${fixed.slice(0, 80)}${fixed.length > 80 ? "..." : ""}"`, 1e4);
        } catch (e) {
          removePendingBadge("fixing");
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out or was cancelled";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge(`Fix failed: ${reason}`);
        } finally {
          state.commandInFlight = false;
        }
      } else if (cmdName === "polish") {
        const cmdIdx = text.lastIndexOf("?/polish");
        const draft = (cmdIdx >= 0 ? text.slice(0, cmdIdx) : text).trim();
        if (!draft || draft.length < state.minChars) {
          showResultBadge("No text to polish (need at least " + state.minChars + " characters)");
          return true;
        }
        showPendingBadge("polishing", "Polishing...");
        state.commandInFlight = true;
        try {
          const settings = await safeGetStorage({
            grammarHost: "127.0.0.1",
            grammarPort: 8766
          });
          const polishController = new AbortController();
          const timeoutId = setTimeout(() => polishController.abort(), 6e4);
          const resp = await fetch(`http://${settings.grammarHost}:${settings.grammarPort}/polish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: draft, language: "auto" }),
            signal: polishController.signal
          });
          clearTimeout(timeoutId);
          const data = await resp.json();
          removePendingBadge("polishing");
          if (!resp.ok) {
            showResultBadge(`Polish failed: ${data?.detail || resp.status}`, 5e3);
            return true;
          }
          const polished = data.polished;
          if (!polished || polished === draft) {
            showResultBadge("\u2713 Text already polished");
            return true;
          }
          showResultBadge(`Polished: "${polished.slice(0, 80)}${polished.length > 80 ? "..." : ""}"`, 1e4);
        } catch (e) {
          removePendingBadge("polishing");
          let reason;
          if (e.name === "AbortError") {
            reason = "Request timed out or was cancelled";
          } else if (e.message?.includes("Extension context invalidated")) {
            reason = "Extension reloaded \u2014 please reload this page";
          } else {
            reason = e.message;
          }
          showResultBadge(`Polish failed: ${reason}`);
        } finally {
          state.commandInFlight = false;
        }
      } else {
        await cmd.run(args);
      }
    } catch (e) {
      showResultBadge(`Command failed: ${e.message}`);
    }
    return true;
  }
  var paletteEl = null;
  var paletteTarget = null;
  var paletteSelectedIdx = 0;
  var langPaletteEl = null;
  var langPaletteTarget = null;
  var langPaletteSelectedIdx = 0;
  var langPaletteFilter = "";
  var langPaletteUniqueTimer = null;
  function buildPaletteCommands() {
    return Object.entries(COMMANDS).map(([name, cmd]) => ({
      name,
      help: cmd.help,
      full: name === "lang" ? `?/lang` : `?/${name}`,
      needsArg: name === "lang"
    }));
  }
  function showCommandPalette(ta, filter = "") {
    hideLanguagePalette();
    hideCommandPalette();
    paletteTarget = ta;
    paletteSelectedIdx = 0;
    let items = buildPaletteCommands();
    if (filter) {
      items = items.filter((item) => item.name.startsWith(filter));
      if (items.length === 0) return;
    }
    const rect = ta.getBoundingClientRect();
    paletteEl = document.createElement("div");
    paletteEl.id = "ai-grammar-palette";
    paletteEl.innerHTML = `
    <style>
      #ai-grammar-palette {
        position: fixed; z-index: 2147483647;
        background: #1e293b; color: #f1f5f9; border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 280px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; overflow: hidden; animation: ai-gfadein 0.12s ease;
      }
      #ai-grammar-palette .agp-item {
        padding: 8px 14px; cursor: pointer; display: flex;
        justify-content: space-between; align-items: center;
        border-bottom: 1px solid #0f172a;
      }
      #ai-grammar-palette .agp-item:last-child { border-bottom: none; }
      #ai-grammar-palette .agp-item.active { background: #334155; }
      #ai-grammar-palette .agp-item:hover { background: #334155; }
      #ai-grammar-palette .agp-cmd { color: #4ade80; font-weight: 600; font-family: monospace; }
      #ai-grammar-palette .agp-help { color: #94a3b8; font-size: 11px; }
      @media (prefers-color-scheme: light) {
        #ai-grammar-palette {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
        }
        #ai-grammar-palette .agp-item { border-bottom-color: #f1f5f9; }
        #ai-grammar-palette .agp-item.active { background: #f1f5f9; }
        #ai-grammar-palette .agp-item:hover { background: #f1f5f9; }
        #ai-grammar-palette .agp-cmd { color: #16a34a; }
        #ai-grammar-palette .agp-help { color: #64748b; }
      }
    </style>
    ${items.map((item, i) => `
      <div class="agp-item${i === 0 ? " active" : ""}" data-idx="${i}" data-cmd="${item.name}">
        <span class="agp-cmd">${item.full}</span>
        <span class="agp-help">${item.help}</span>
      </div>
    `).join("")}
  `;
    document.body.appendChild(paletteEl);
    const pH = paletteEl.offsetHeight;
    let top = rect.bottom + 4;
    if (top + pH > window.innerHeight - 10) {
      top = rect.top - pH - 4;
    }
    paletteEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 296)) + "px";
    paletteEl.style.top = Math.max(8, top) + "px";
    paletteEl.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".agp-item");
      if (item) {
        e.preventDefault();
        const cmdName = item.dataset.cmd;
        selectPaletteCommand(cmdName).catch(() => {});
      }
    });
  }
  function hideCommandPalette() {
    if (paletteEl) {
      paletteEl.remove();
      paletteEl = null;
    }
    paletteTarget = null;
    paletteSelectedIdx = 0;
    hideLanguagePalette();
  }
  function updatePaletteSelection(delta) {
    if (!paletteEl) return;
    const items = paletteEl.querySelectorAll(".agp-item");
    if (items.length === 0) return;
    items[paletteSelectedIdx].classList.remove("active");
    paletteSelectedIdx = (paletteSelectedIdx + delta + items.length) % items.length;
    items[paletteSelectedIdx].classList.add("active");
    items[paletteSelectedIdx].scrollIntoView({ block: "nearest" });
  }
  async function selectPaletteCommand(cmdName) {
    if (cmdName === "lang") {
      await insertPaletteText("lang ");
      return;
    }
    await applyPaletteCommand(cmdName);
  }
  async function insertPaletteText(text) {
    if (!paletteTarget) return;
    hideCommandPalette();
    const ta = paletteTarget;
    const value = ta.value || ta.textContent || "";
    const idx = value.lastIndexOf("?/");
    const prefix = idx >= 0 ? value.slice(0, idx) : "";
    const newValue = prefix + text;
    if (ta.tagName === "TEXTAREA") {
      ta.value = newValue;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (await tryBeforeInput(newValue, ta)) {
      } else {
        applyFixCDP(newValue);
      }
    }
    ta.focus();
  }
  async function applyPaletteCommand(cmdName) {
    if (!paletteTarget) return;
    const ta = paletteTarget;
    hideCommandPalette();
    const value = ta.value || ta.textContent || "";
    const fullCmd = cmdName === "lang" ? "?/lang en" : `?/${cmdName}`;
    const idx = value.lastIndexOf("?/");
    const prefix = idx >= 0 ? value.slice(0, idx) : "";
    const newValue = prefix + fullCmd;
    if (ta.tagName === "TEXTAREA") {
      ta.value = newValue;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (await tryBeforeInput(newValue, ta)) {
        // Success
      } else {
        applyFixCDP(newValue);
      }
    }
    try {
      await COMMANDS[cmdName].run("");
    } catch (err) {
      showResultBadge(`Command failed: ${err.message}`);
    }
    setTimeout(async () => {
      const v = ta.value || ta.textContent || "";
      const cleaned = v.replace(fullCmd, "").trimEnd();
      if (ta.tagName === "TEXTAREA") {
        ta.value = cleaned;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        if (await tryBeforeInput(cleaned, ta)) {
          // Success
        } else {
          applyFixCDP(cleaned);
        }
      }
      ta.focus();
    }, 100);
  }
  function showLanguagePalette(ta, filter = "") {
    hideCommandPalette();
    langPaletteTarget = ta;
    langPaletteFilter = filter || "";
    langPaletteSelectedIdx = 0;
    if (langPaletteUniqueTimer) {
      clearTimeout(langPaletteUniqueTimer);
      langPaletteUniqueTimer = null;
    }
    const items = searchLanguages(langPaletteFilter);
    if (items.length === 0) return;
    const rect = ta.getBoundingClientRect();
    langPaletteEl = document.createElement("div");
    langPaletteEl.id = "ai-grammar-lang-palette";
    langPaletteEl.innerHTML = `
    <style>
      #ai-grammar-lang-palette {
        position: fixed; z-index: 2147483647;
        background: #1e293b; color: #f1f5f9; border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 280px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; overflow: hidden; animation: ai-gfadein 0.12s ease;
        max-height: 320px; overflow-y: auto;
      }
      #ai-grammar-lang-palette .agl-item {
        padding: 8px 14px; cursor: pointer; display: flex;
        justify-content: space-between; align-items: center;
        border-bottom: 1px solid #0f172a;
      }
      #ai-grammar-lang-palette .agl-item:last-child { border-bottom: none; }
      #ai-grammar-lang-palette .agl-item.active { background: #334155; }
      #ai-grammar-lang-palette .agl-item:hover { background: #334155; }
      #ai-grammar-lang-palette .agl-name { color: #f1f5f9; }
      #ai-grammar-lang-palette .agl-code {
        color: #4ade80; font-weight: 600; font-family: monospace;
      }
      @media (prefers-color-scheme: light) {
        #ai-grammar-lang-palette {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
        }
        #ai-grammar-lang-palette .agl-item { border-bottom-color: #f1f5f9; }
        #ai-grammar-lang-palette .agl-item.active { background: #f1f5f9; }
        #ai-grammar-lang-palette .agl-item:hover { background: #f1f5f9; }
        #ai-grammar-lang-palette .agl-name { color: #0f172a; }
        #ai-grammar-lang-palette .agl-code { color: #16a34a; }
      }
    </style>
    ${items.map((item, i) => `
      <div class="agl-item${i === 0 ? " active" : ""}" data-idx="${i}" data-code="${item.code}">
        <span class="agl-name">${item.name}</span>
        <span class="agl-code">${item.code}</span>
      </div>
    `).join("")}
  `;
    document.body.appendChild(langPaletteEl);
    const pH = langPaletteEl.offsetHeight;
    let top = rect.bottom + 4;
    if (top + pH > window.innerHeight - 10) {
      top = rect.top - pH - 4;
    }
    langPaletteEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 296)) + "px";
    langPaletteEl.style.top = Math.max(8, top) + "px";
    langPaletteEl.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".agl-item");
      if (item) {
        e.preventDefault();
        const code = item.dataset.code;
        commitLanguageSelection(code).catch(() => {});
      }
    });
    if (langPaletteFilter) {
      const unique = findUniqueMatch(langPaletteFilter);
      if (unique) {
        langPaletteUniqueTimer = setTimeout(async () => {
          langPaletteUniqueTimer = null;
          if (!langPaletteEl || !langPaletteTarget) return;
          const code = unique.code;
          const ta2 = langPaletteTarget;
          const val = ta2.value || ta2.textContent || "";
          const escaped = langPaletteFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp("\\?/lang\\s+" + escaped + "$");
          const m = val.match(re);
          if (m) {
            const newVal = val.slice(0, m.index) + "?/lang " + code;
            state.skipLiveCheck = true;
            if (ta2.tagName === "TEXTAREA") {
              ta2.value = newVal;
              ta2.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              if (await tryBeforeInput(newVal, ta2)) {
                // Success
              } else {
                applyFixCDP(newVal);
              }
            }
            state.skipLiveCheck = false;
          }
          hideLanguagePalette();
          try {
            COMMANDS.lang.run(code, ta2);
          } catch (err) {
            showResultBadge(`Command failed: ${err.message}`);
          }
        }, 600);
      }
    }
  }
  function hideLanguagePalette() {
    if (langPaletteUniqueTimer) {
      clearTimeout(langPaletteUniqueTimer);
      langPaletteUniqueTimer = null;
    }
    if (langPaletteEl) {
      langPaletteEl.remove();
      langPaletteEl = null;
    }
    langPaletteTarget = null;
    langPaletteSelectedIdx = 0;
    langPaletteFilter = "";
  }
  function updateLanguagePaletteSelection(delta) {
    if (!langPaletteEl) return;
    const items = langPaletteEl.querySelectorAll(".agl-item");
    if (items.length === 0) return;
    items[langPaletteSelectedIdx].classList.remove("active");
    langPaletteSelectedIdx = (langPaletteSelectedIdx + delta + items.length) % items.length;
    items[langPaletteSelectedIdx].classList.add("active");
    items[langPaletteSelectedIdx].scrollIntoView({ block: "nearest" });
  }
  async function selectLanguagePaletteItem() {
    if (!langPaletteEl || !langPaletteTarget) return;
    const active = langPaletteEl.querySelector(".agl-item.active");
    if (!active) return;
    const code = active.dataset.code;
    await commitLanguageSelection(code);
  }
  async function commitLanguageSelection(code) {
    if (!langPaletteTarget) return;
    const ta = langPaletteTarget;
    const val = ta.value || ta.textContent || "";
    const re = /\?\/lang(\s+[^\s]*)?$/;
    const m = val.match(re);
    if (m) {
      const newVal = val.slice(0, m.index) + "?/lang " + code;
      state.skipLiveCheck = true;
      if (ta.tagName === "TEXTAREA") {
        ta.value = newVal;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        if (await tryBeforeInput(newVal, ta)) {
          // Success
        } else {
          applyFixCDP(newVal);
        }
      }
      state.skipLiveCheck = false;
    }
    hideLanguagePalette();
    setTimeout(() => {
      try {
        COMMANDS.lang.run(code, ta);
      } catch (err) {
        showResultBadge(`Command failed: ${err.message}`);
      }
    }, 600);
  }

  // src/init.js
  function init() {
    injectStyles();
    state.activeConversationKey = getConversationKey();
    window.addEventListener("hashchange", handleConversationMaybeChanged);
    window.addEventListener("popstate", handleConversationMaybeChanged);
    window.addEventListener("ai-grammar:whatsapp-chat-switch", () => {
      handleConversationMaybeChanged();
    });
    document.addEventListener("click", scheduleConversationCheck, true);
    document.addEventListener("focusin", scheduleConversationCheck, true);
    document.addEventListener("input", scheduleConversationCheck, true);
    setInterval(handleConversationMaybeChanged, 1e3);
    async function processCapturedText(captured, textarea) {
      if (!captured || captured.length < state.minChars) return;
      if (/\?\/\w+(\s+\S+)?$/.test(captured)) {
        await handleCommand(captured, textarea);
        return;
      }
      const conversationKey = getConversationKey();
      state.activeConversationKey = conversationKey;
      state.lastUserText = captured;
      state.lastUserTextTime = Date.now();
      if (textarea && document.contains(textarea)) {
        const messageList = findMessageList(textarea);
        if (messageList) {
          state.pendingSubmission = { text: captured, messageList, time: Date.now(), conversationKey };
        }
      }
    }
    function getTextFromControls(scope) {
      if (!scope?.querySelectorAll) return "";
      const editables = scope.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"]');
      for (const ed of editables) {
        const captured = (ed.textContent || "").trim();
        if (captured) return captured;
      }
      const textareas = scope.querySelectorAll("textarea");
      const inputs = scope.querySelectorAll('input[type="text"], input:not([type])');
      for (const ta of textareas) {
        const captured = ta.value.trim();
        if (captured) return captured;
      }
      for (const inp of inputs) {
        const captured = inp.value.trim();
        if (captured) return captured;
      }
      return "";
    }
    function findMessageList(textarea) {
      if (!textarea || !document.contains(textarea)) return null;
      let el = textarea.parentElement;
      let depth = 0;
      const MAX_DEPTH = 12;
      while (el && el !== document.body && depth < MAX_DEPTH) {
        const children = Array.from(el.children);
        if (children.length >= 2) {
          const tagCounts = {};
          for (const child of children) {
            const tag = child.tagName;
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
          if (Object.values(tagCounts).some((c) => c >= 2)) {
            return el;
          }
        }
        el = el.parentElement;
        depth++;
      }
      return textarea.parentElement?.parentElement?.parentElement || null;
    }
    document.addEventListener("submit", (e) => {
      const form = e.target;
      const textareas = form.querySelectorAll("textarea");
      const inputs = form.querySelectorAll('input[type="text"]');
      const editables = form.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"]');
      let captured = "";
      let ta = null;
      for (const t of textareas) {
        captured = t.value.trim();
        if (captured) {
          ta = t;
          break;
        }
      }
      if (!captured) {
        for (const inp of inputs) {
          captured = inp.value.trim();
          if (captured) {
            ta = inp;
            break;
          }
        }
      }
      if (!captured) {
        for (const ed of editables) {
          captured = (ed.textContent || "").trim();
          if (captured) {
            ta = ed;
            break;
          }
        }
      }
      clearTimeout(commandDebounce);
      commandDebounce = null;
      processCapturedText(captured, ta);
    }, true);
    document.addEventListener("mousedown", (e) => {
      const control = e.target.closest?.('button, input[type="button"], input[type="submit"], [role="button"]');
      if (!control) return;
      const ariaLabel = (control.getAttribute?.("aria-label") || "").toLowerCase();
      const testId = (control.getAttribute?.("data-testid") || "").toLowerCase();
      const label = (control.innerText || control.value || ariaLabel || "").trim().toLowerCase();
      const looksLikeSend = /^(send|submit|post|reply|comment)$/.test(label) || control.type === "submit" || testId.includes("send");
      if (!looksLikeSend) return;
      const active = document.activeElement;
      if (active?.tagName === "TEXTAREA" || active?.isContentEditable) {
        const captured = (active.value || active.textContent || "").trim();
        if (captured) {
          clearTimeout(commandDebounce);
          commandDebounce = null;
          processCapturedText(captured, active);
        }
      }
    }, true);
    document.addEventListener("click", (e) => {
      let control = e.target.closest?.('button, input[type="button"], input[type="submit"]');
      if (!control) {
        const candidate = e.target.closest?.('[role="button"]') || e.target;
        const ariaLabel = (candidate.getAttribute?.("aria-label") || "").toLowerCase();
        const testId = (candidate.getAttribute?.("data-testid") || "").toLowerCase();
        if (/^(send|submit)$/.test(ariaLabel) || testId.includes("send")) {
          control = candidate;
        }
      }
      if (!control) return;
      const label = (control.innerText || control.value || control.getAttribute("aria-label") || "").trim().toLowerCase();
      const looksLikeSend = /^(send|submit|post|reply|comment)$/.test(label) || control.type === "submit" || control.getAttribute("data-testid")?.toLowerCase().includes("send");
      if (!looksLikeSend) return;
      const form = control.closest("form");
      const scope = form || control.closest('.input-row, [role="form"], [role="textbox"][contenteditable="true"], [contenteditable="true"]') || control.parentElement;
      let captured = getTextFromControls(scope);
      let active = document.activeElement;
      if (!captured) {
        if (active?.tagName === "TEXTAREA" || active?.isContentEditable) {
          captured = (active.value || active.textContent || "").trim();
        }
      }
      let ta = active;
      if (!ta || ta.tagName !== "TEXTAREA" && !ta.isContentEditable) {
        const t = scope?.querySelector?.('textarea, [role="textbox"][contenteditable="true"], [contenteditable="true"]');
        if (t) ta = t;
      }
      clearTimeout(commandDebounce);
      commandDebounce = null;
      processCapturedText(captured, ta);
    }, true);
    document.addEventListener("keydown", (e) => {
      const ta = e.target;
      if (ta.tagName !== "TEXTAREA" && !ta.isContentEditable) return;
      if (langPaletteEl) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          updateLanguagePaletteSelection(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          updateLanguagePaletteSelection(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hideLanguagePalette();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          selectLanguagePaletteItem();
          return;
        }
        return;
      }
      if (paletteEl) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          updatePaletteSelection(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          updatePaletteSelection(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hideCommandPalette();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const active = paletteEl.querySelector(".agp-item.active");
          if (active) selectPaletteCommand(active.dataset.cmd);
          return;
        }
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const text = (ta.value || ta.textContent || "").trim();
      clearTimeout(commandDebounce);
      commandDebounce = null;
      if (/\?\/\b(fix|polish|check|lang)\b\s*$/.test(text)) {
        e.preventDefault();
        e.stopPropagation();
      }
      processCapturedText(text, ta);
    }, true);
    let commandDebounce = null;
    document.addEventListener("input", (e) => {
      const ta = e.target;
      if (ta.tagName !== "TEXTAREA" && !ta.isContentEditable) return;
      if (state.replacingCommand) return;
      clearTimeout(commandDebounce);
      const value = ta.value || ta.textContent || "";
      if (/\/?\/lang\s+\S*$/.test(value) || /\/?\/lang\s*$/.test(value)) {
        const langMatch = value.match(/\/?\/lang\s*(.*)$/);
        const filter = (langMatch?.[1] || "").trim();
        hideCommandPalette();
        showLanguagePalette(ta, filter);
        return;
      }
      if (/\?\/\s*$/.test(value) && !/\w\?\/\s*$/.test(value)) {
        hideLanguagePalette();
        showCommandPalette(ta);
        return;
      }
      const match = value.match(/\?\/\w+(\s+\S+)?$/);
      if (match) {
        hideCommandPalette();
        const cmdText = match[0].trim();
        const parts = cmdText.slice(2).trim().split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const cmdArgs = parts.slice(1).join(" ");
        if (!COMMANDS[cmdName]) {
          const matches = buildPaletteCommands().filter((item) => item.name.startsWith(cmdName));
          if (matches.length === 1) {
            hideCommandPalette();
            const matched = matches[0];
            commandDebounce = setTimeout(async () => {
              const currentValue = ta.value || ta.textContent || "";
              const fullCmd = matched.full;
              if (!currentValue.includes(cmdText)) return;
              const idx = ta.value ? ta.value.lastIndexOf(cmdText) : (ta.textContent || "").lastIndexOf(cmdText);
              const val = ta.value || ta.textContent || "";
              if (idx >= 0) {
                const suffix = matched.name === "lang" ? " " : "";
                const replaced = val.slice(0, idx) + fullCmd + suffix + val.slice(idx + cmdText.length);
                state.skipLiveCheck = true;
                state.replacingCommand = true;
                if (ta.tagName === "TEXTAREA") {
                  ta.value = replaced;
                  ta.dispatchEvent(new Event("input", { bubbles: true }));
                } else {
                  if (await tryBeforeInput(replaced, ta)) {
                    // Success
                  } else {
                    applyFixCDP(replaced);
                  }
                }
                state.replacingCommand = false;
                state.skipLiveCheck = false;
              }
              if (matched.name === "lang") {
                showLanguagePalette(ta, "");
                return;
              }
              try {
                if (matched.name === "fix" || matched.name === "polish" || matched.name === "check") {
                  await COMMANDS[matched.name].run("", ta);
                } else {
                  await COMMANDS[matched.name].run("");
                }
              } catch (err) {
                showResultBadge(`Command failed: ${err.message}`);
              }
              if (matched.name !== "fix" && matched.name !== "polish" && matched.name !== "check") {
                await new Promise((r) => setTimeout(r, 400));
                const idx2 = ta.value ? ta.value.lastIndexOf(fullCmd) : (ta.textContent || "").lastIndexOf(fullCmd);
                const val2 = ta.value || ta.textContent || "";
                const cleaned = (idx2 >= 0 ? val2.slice(0, idx2) + val2.slice(idx2 + fullCmd.length) : val2).trimEnd();
                state.skipLiveCheck = true;
                if (ta.tagName === "TEXTAREA") {
                  ta.value = cleaned;
                  ta.dispatchEvent(new Event("input", { bubbles: true }));
                } else {
                  if (await tryBeforeInput(cleaned, ta)) {
                    // Success
                  } else {
                    applyFixCDP(cleaned);
                  }
                }
                state.skipLiveCheck = false;
              }
            }, 600);
            return;
          }
          showCommandPalette(ta, cmdName);
          return;
        }
        commandDebounce = setTimeout(async () => {
          const currentValue = ta.value || ta.textContent || "";
          console.debug("[AI Grammar] Debounce fired", { cmdName, cmdText, currentValue: currentValue.slice(-20), includes: currentValue.includes(cmdText) });
          if (!currentValue.includes(cmdText)) return;
          if (cmdName === "lang" && !cmdArgs) {
            showLanguagePalette(ta, "");
            return;
          }
          try {
            if (cmdName === "fix" || cmdName === "polish" || cmdName === "check" || cmdName === "lang") {
              await COMMANDS[cmdName].run(cmdArgs, ta);
            } else {
              await COMMANDS[cmdName].run(cmdArgs);
            }
          } catch (err) {
            showResultBadge(`Command failed: ${err.message}`);
          }
          if (cmdName !== "fix" && cmdName !== "polish" && cmdName !== "check" && cmdName !== "lang") {
            if (cmdName === "lang" && !cmdArgs) {
            } else {
              const idx = ta.value ? ta.value.lastIndexOf(cmdText) : (ta.textContent || "").lastIndexOf(cmdText);
              const val = ta.value || ta.textContent || "";
              const cleaned = (idx >= 0 ? val.slice(0, idx) + val.slice(idx + cmdText.length) : val).trimEnd();
              if (ta.tagName === "TEXTAREA") {
                ta.value = cleaned;
                ta.dispatchEvent(new Event("input", { bubbles: true }));
              } else {
                if (await tryBeforeInput(cleaned, ta)) {
                  // Success
                } else {
                  applyFixCDP(cleaned);
                }
              }
            }
          }
        }, 600);
        return;
      }
      hideCommandPalette();
      hideLanguagePalette();
    }, true);
    if (!isTeams) {
      setupLiveDraftCheck();
    }
    console.debug("[AI Grammar] Content script initialized");
  }

  // src/content.js
  if (!window.__aiGrammarLoaded) {
    window.__aiGrammarLoaded = true;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
