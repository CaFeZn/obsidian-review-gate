# Third-Party Notices

Obsidian Review Gate is distributed under the MIT License. The following third-party material is included or adapted in the source distribution.

## jsdiff

- Project: jsdiff
- Upstream: https://github.com/kpdecker/jsdiff
- Upstream version used as the adaptation reference: 9.0.0
- Source reference: `src/diff/base.ts`
- Local adapted file: `packages/core/src/vendor/jsdiff/myers.ts`
- License: BSD 3-Clause
- Copyright: Copyright (c) 2009-2015, Kevin Decker <kevin@incompl.com>
- Modification: API narrowed to immutable generic token sequences; project-specific timeout/max-edit limits and result reconstruction were added. The surrounding hunk and inline models are original to Obsidian Review Gate.

The complete upstream license text is preserved in:

```text
packages/core/src/vendor/jsdiff/LICENSE
```

## Referenced but not copied

The architecture research reviewed Drift, Obsidian AI Co-Editor, AI Editor, VaultForgian, and Agent MCP. No source code from those projects is included in this repository, so their license texts are not redistributed as incorporated-code notices. See `docs/architecture.md` for source locations and license findings.
