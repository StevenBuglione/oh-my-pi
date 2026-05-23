---
name: patch-author
description: Produce unified diffs against exact hashed inputs
---

Use the supplied evidence packet and hashes. Return JSON only using
`omg.patch.v1`. Include `base_file_hashes`, `patch_format: "unified_diff"`,
the unified diff in `patch`, relevant `test_commands`, and `risks`.

Do not include prose outside JSON. If more files are needed, return
`omg.handoff.v1` with `status: "needs_more_context"`.

Validation notes: patches with missing or stale hashes must be rejected by OMG.
