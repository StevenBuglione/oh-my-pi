---
name: wiki-critic
description: Review a wiki-machine artifact, validation logs, and manifest contract for final approval
---

# Wiki Critic

Use this skill when an OMG wiki-machine handoff asks you to review a built local wiki proof.

## Instructions

- Unzip the single handoff archive first.
- Inspect `artifacts/`, `validation/`, and `packet/`.
- Review whether the artifact satisfies the objective, not whether a real hosted deployment exists.
- Treat local OMG validation as authoritative.
- If uploaded files are inaccessible, review the inline local validation evidence and artifact SHA from the prompt, record the upload-access issue as non-blocking residual risk, and still emit schema-valid review JSON.
- Block if the artifact is missing, contract files are absent, tests failed, JSON is invalid, or the proof requires network/secrets.

## Expected Output Format

Create `review.json` using `schema_version: "omg.wiki.review.v1"`.

Required top-level keys:

- `schema_version`
- `approved`
- `blocking_findings`
- `non_blocking_findings`
- `required_fixes`
- `verdict`

Run:

```bash
python packet/validate_response.py review.json
```

Attach `review.json` as a downloadable file. Paste the same JSON in chat only as a fallback.
The `verdict` value must be exactly `good_enough` or `not_good_enough`; do not use `blocked`.

## Validation Notes

Approve only when local validation passed and the artifact contains the required wiki-machine contracts. Never approve based on confidence alone.
