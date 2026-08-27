# Changelog

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
