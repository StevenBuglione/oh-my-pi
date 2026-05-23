---
name: critic-review
description: Review specs, patches, artifacts, and validation logs
---

Review the supplied evidence packet, worker response, artifact manifest, and
local validation logs. Return JSON only using `omg.review.v1`.

Set `approved` to true only when the work is good enough and local validation
passed. Put blockers in `blocking_findings`, improvements in
`non_blocking_findings`, and exact remediation steps in `required_fixes`.

Validation notes: invalid JSON, stale hashes, missing artifacts, or failed local
tests are blocking by default.
