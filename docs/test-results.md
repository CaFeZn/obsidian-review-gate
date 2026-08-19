# Test Results

Run date: 2026-08-19.

Command:

```text
npm run check
```

Result: PASS.

| Gate | Result |
| --- | --- |
| strict TypeScript (`tsc --noEmit`) | PASS |
| source policy: no suppression, no explicit `any`, no skipped tests, Core has no Obsidian dependency | PASS |
| Node test suite | 35 passed, 0 failed, 0 skipped |
| release build | PASS; single-file plugin and single-file portable CLI |
| compiled CLI submit → pending invariant → approve smoke | PASS |
| portable release CLI version/submit/approve smoke | PASS |
| built plugin single-file eval/load smoke with Obsidian API shim | PASS |
| external review storage while targets remain in the Vault | PASS |
| concurrent same-revision update regression, 10 repeated runs | PASS |
| ZIP integrity and extracted plugin eval | PASS |
| extracted portable CLI version/submit/pending invariant/approve | PASS |

The suite covers hashing, IDs, state transitions, unsafe paths, symlink escape, Myers diff fuzz, inline diff, hunk semantics, rebase, durable external review storage, external proposal edits, revision conflicts, base conflicts, multi-file preflight, apply/rollback, rename, recoverable delete, force-apply backup, wait, crash recovery, watcher debounce, manifest and CLI JSON/exit codes.

Not claimed: automated interaction inside a real Obsidian Electron process. The release has a single-file eval/load smoke and a post-extraction artifact smoke, but real UI/Electron E2E remains a separate validation step.
