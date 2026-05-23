---
name: critic-review
description: Review specs, patches, artifacts, and validation logs
---

Review the supplied evidence packet, worker response, artifact manifest, and
local validation logs. Return JSON only using `omg.review.v1`.

Set `approved` to true only when the work is good enough and local validation
passed. Put blockers in `blocking_findings`, improvements in
`non_blocking_findings`, and exact remediation steps in `required_fixes`.

Review checklist:
- Is the task scoped tightly enough for the supplied packet?
- Are omitted files explained and safe?
- Are file hashes present when patches are involved?
- Are artifacts downloadable, unpackable, and locally testable?
- Did OMG validate the result locally instead of trusting the worker?
- Did the ledger preserve prompts, responses, request ids, conversation URLs,
  artifacts, and test logs?
- Are remaining risks explicit and acceptable?

Validation notes: invalid JSON, truncated worker output without copy fallback,
stale hashes, missing artifacts, or failed local tests are blocking by default.
