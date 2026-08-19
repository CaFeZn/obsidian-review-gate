# Changelog

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
