import { state, GRAMMAR_CLASSES } from './state.js';
import { showTooltip, hideTooltip } from './tooltip.js';
import { applyCorrection } from './apply-correction.js';

// -----------------------------------------------------------------------
// Event delegation for tooltips and corrections
// -----------------------------------------------------------------------

document.addEventListener('mouseover', (e) => {
  const errorEl = e.target.closest(GRAMMAR_CLASSES);
  if (errorEl) {
    if (state.tooltipTimeout) clearTimeout(state.tooltipTimeout);
    state.tooltipTimeout = setTimeout(() => {
      state.tooltipTimeout = null;
      showTooltip(errorEl);
    }, 300);
  } else if (!e.target.closest('.ai-grammar-tooltip')) {
    hideTooltip();
  }
});

document.addEventListener('mouseout', (e) => {
  const fromError = e.target.closest?.(GRAMMAR_CLASSES);
  if (!fromError) return;
  const to = e.relatedTarget;
  if (to?.closest?.('.ai-grammar-tooltip') || to?.closest?.(GRAMMAR_CLASSES)) return;
  hideTooltip();
});

document.addEventListener('focusin', (e) => {
  const errorEl = e.target.closest(GRAMMAR_CLASSES);
  if (errorEl) {
    showTooltip(errorEl);
  }
});

document.addEventListener('click', (e) => {
  // Apply button inside tooltip
  const applyBtn = e.target.closest('.ag-apply');
  if (applyBtn && state.currentErrorEl) {
    applyCorrection(state.currentErrorEl);
    return;
  }

  // Dismiss button inside tooltip
  const dismissBtn = e.target.closest('.ag-dismiss');
  if (dismissBtn) {
    hideTooltip();
    return;
  }

  // Click on error span itself — apply on click (convenience)
  const errorEl = e.target.closest(GRAMMAR_CLASSES);
  if (errorEl && !e.target.closest('.ai-grammar-tooltip')) {
    applyCorrection(errorEl);
    return;
  }

  // Click elsewhere — hide
  if (!e.target.closest('.ai-grammar-tooltip') && !e.target.closest(GRAMMAR_CLASSES)) {
    hideTooltip();
  }
});

// Dismiss on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.tooltipEl?.style.display === 'block') {
    hideTooltip();
  }
});
