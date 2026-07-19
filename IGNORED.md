# Ignored Audit Findings

These findings were intentionally left unfixed because changing them could alter working behavior or requires browser-level evidence that the replacement is regression-free.

## `tryBeforeInput` target selection

`extension/src/apply-correction.js` focuses the supplied editor, then re-queries the document for a content-editable target after animation-frame delays. Using the original element directly could prevent selecting the wrong field on pages with multiple editors, but the re-query is also a recovery mechanism for React/Lexical DOM replacement. Do not change this without browser tests covering multiple editors and reconciled/replaced editor nodes.

## Teams bridge `changeDataUnbind`

`extension/teams-bridge.js` retains a `changeDataUnbind` declaration and guarded cleanup path that currently appears unassigned. Removing it is cleanup rather than a demonstrated defect and could conflict with future or platform-specific synchronous CKEditor binding. Leave it until the bridge lifecycle is deliberately refactored with complete Teams tests.

## Teams error-panel dismiss timer

The Teams bridge uses clear-before-set timer management rather than the generation-ownership guard used by the shared indicator panel. Its current synchronous `dismissErrors()` before replacement prevents stale timers in the observed flow. Changing it is consistency-only churn unless a reproducible stale-callback path is found.
