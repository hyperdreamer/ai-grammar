// -----------------------------------------------------------------------
// CSS injection
// -----------------------------------------------------------------------

export function injectStyles() {
  if (document.getElementById('ai-grammar-styles')) return;
  const style = document.createElement('style');
  style.id = 'ai-grammar-styles';
  style.textContent = `
      /* text-decoration wavy underlines — positioned by the browser from
         the real mirrored text baseline, independent of platform font/line-height.  The
         old SVG background-image approach required manual offsets that
         varied by platform (iMessage vs Hermes WebUI vs test page).
         Overlay spans use rgba(0,0,0,0.02) to defeat Chromium's
         text-decoration paint skip: 0.02 * 255 = 5.1 → never quantises
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
      .ag-badge-stack .ag-badge-done .ag-spinner { display: none; }
      .ag-badge-stack .ag-badge-done {
        background: #166534;
        border: 1px solid #4ade80;
      }
      .ag-badge-stack .ag-badge-error {
        background: #7f1d1d;
        border: 1px solid #f87171;
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
        .ag-badge-stack .ag-badge-done {
          background: #dcfce7;
          border-color: #4ade80;
        }
        .ag-badge-stack .ag-badge-error {
          background: #fee2e2;
          border-color: #f87171;
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
