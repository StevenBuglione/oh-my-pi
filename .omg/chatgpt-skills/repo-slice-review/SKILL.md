---
name: repo-slice-review
description: Review uploaded repo slices and return structured findings only
---

Inspect `TASK.md`, `CONSTRAINTS.md`, `SUMMARY.json`, optional `REPO_SLICE.zip`,
and `VALIDATION.md`. Do not assume access to files not included in the packet.

Return JSON only using `omg.handoff.v1`. Put actionable issues in `findings`,
list missing files in `requested_context`, and set `next_action` to
`validate_locally`, `send_to_builder`, `send_to_critic`, or `stop`.

Validation notes: mark the response blocked if the repo slice is insufficient,
contains stale or missing hashes, or asks you to inspect secrets.
