# Changelog

## 0.1.10 — 2026-09-17

- Made human edits authoritative on conflict: when the document changed after submission, the current content becomes the new baseline instead of leaving the review conflicted.
- Merged disjoint agent edits back on top of that new baseline, and dropped only the overlapping edits that cannot be represented safely.
- Applied the same reconciliation on approve, on the target watcher, and on proposal or hunk writes, so a stale review resolves against the current document rather than refusing to proceed.
- Kept the CLI target-drift guard: an update or hunk write against a changed target is still refused, because refusing a stale write never overwrites human content.
- Marked changed table cells instead of whole rows: a reformatted table changes every source line while most cell text stays identical, so row-level marking painted the entire table, and only the edited cells are marked now.
- Scheduled rendered-diff refreshes on a timer instead of an animation frame, because a review pane often renders while its window is backgrounded, where animation frames are throttled and the second pane stayed undecorated until the reader clicked it.
- Resolved a rendered table widget to its table by line containment, because a widget does not always report the table's first row.

## 0.1.9 — 2026-09-17

- Restored the single-page native review view: the editable proposal can now open as one unified page instead of only a two-pane split, and it reuses the same review session, save, and close handling.
- Added a layout toggle to the native proposal header so the split pair can switch to the single page in place.
- Gave the sidebar review page and the native editor page independent layout controls, so changing one no longer implies the other.
- Auto-selected the single-page layout when the sidebar review page is narrower than 520px, where two diff columns cannot stay readable, while keeping an explicit choice sticky.
- Carried these additions onto 0.1.8 so rendered per-row diffs, scroll stability, Ctrl+S saving, and file history stay intact.

## 0.1.8 — 2026-09-17

- Marked the exact changed rows and paragraphs inside rendered Markdown blocks instead of tinting a whole table or Callout, so a single edited table row no longer paints every sibling row.
- Recognized Obsidian-style aligned tables such as `| --: | ---- |` when expanding a changed row to its rendered widget, which previously left those tables entirely unmarked.
- Kept red and green fills visible on changed fenced code-block and blockquote lines, which Obsidian's own code-block and quote backgrounds previously covered.
- Stopped the two native review panes from pushing each other while scrolling a full-page diff, which previously jumped the view back to the top or snapped it to the bottom.
- Saved the proposal with `Ctrl+S` on the editable proposal pane; the shortcut previously did nothing because Obsidian's `editor:save-file` calls `view.save()`.
- Made the read-only review id and other review text copyable, since Obsidian's app chrome disables text selection on the whole window.

## 0.1.7 — 2026-08-27

- Aligned unchanged native Markdown rows, including headings after hidden Properties, by adding stable equal-line anchors and measured before-row spacing.

## 0.1.6 — 2026-08-27

- Aligned native review hunk rows by measured pixel height after soft wrapping, resizing, font layout changes, and proposal edits.
- Synchronized native review scrolling between corresponding hunk anchors while preserving exact document endpoints.

## 0.1.5 — 2026-08-26

- Added per-file Review history from the Obsidian file menu, including approved rename chains and deleted or renamed historical paths.
- Opened review base and proposal as new tabs inside existing left and right tab groups, preserving the original pages and restoring their editable state when review tabs close.
- Refused duplicate mutable targets and target drift in Agent CLI `submit`, `update`, `append`, and `hunk` writes while preserving conflict review, rebase, and force-apply interactions.
- Treated target paths case-insensitively for duplicate Review prevention on Windows.

## 0.1.4 — 2026-08-26

- Opened native Markdown review panes as adjacent tab groups in the current Obsidian window instead of a separate operating-system window.
- Added compact proposal-header controls for save, hunk navigation, accept/reject, approve, and reject; aligned unequal diff blocks with blank rows and improved CJK wrapping.
- Recovered same-process lock residue and reported lock acquisition stages without weakening cross-process exclusion.
- Fixed CLI approval when the Vault and external Review storage are on different Windows volumes by safely falling back from file rename to copy, sync, and source removal.
- Added `obsreview append`, which merges non-overlapping Agent edits into the unique existing mutable Review and refuses ambiguous or overlapping updates without creating a duplicate Review.

## 0.1.3 — 2026-08-20

- Moved Review protocol state outside the Vault while keeping formal target writes inside Obsidian's `DataAdapter` boundary.
- Switched protocol payloads to opaque `.rgdata` files so TSafe does not transform them as Vault documents.
- Preserved pending Review visibility and approval behavior across the CLI and Obsidian plugin in TSafe-enabled Vaults.

## 0.1.2 — 2026-08-19

- Routed Obsidian plugin review and target I/O through the Vault `DataAdapter` for TSafe compatibility.
- Restored the Vault-local `.obsreview` as the shared source of truth for CLI and plugin.
- Replaced Node filesystem watching in the plugin with active-filesystem content fingerprint polling.
- Added virtual-filesystem lifecycle and watcher regressions for DataAdapter-only access.

## 0.1.1 — 2026-08-19

- Moved review protocol state to a per-vault directory under the operating system user-data root.
- Fixed pending reviews being hidden as corrupted when TSafe transforms Vault files inside Obsidian.
- Kept formal targets inside the Vault and unchanged until explicit approval.
- Removed the obsolete action that tried to open an external proposal as a Vault note.

## 0.1.0 — 2026-08-19

- Initial local Review Gate release.
- Added persistent multi-file Review model and `.obsreview` storage.
- Added `obsreview` CLI with stable JSON, exit codes, wait, revision control, and manifests.
- Added Obsidian Pending/Conflicted/History UI with unified/split/inline diff.
- Added proposal editing and hunk accept/reject without pre-approval target writes.
- Added SHA-256 conflict gate, conservative rebase, and explicit force apply.
- Added staged transaction apply, history/trash, rollback, and crash recovery.
- Added watcher debounce, path containment, directory locks, and concurrency tests.
- Fixed an owner-file acquisition-window race in the review lock.
