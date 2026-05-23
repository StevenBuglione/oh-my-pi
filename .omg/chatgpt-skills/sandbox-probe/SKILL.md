---
name: sandbox-probe
description: Empirically inspect the ChatGPT sandbox and report structured capabilities
---

Run safe local probes only. Inspect runtime versions, available packages,
filesystem behavior, artifact creation, zip handling, and network constraints.

Return JSON only using `omg.handoff.v1`. Include exact commands or snippets in
`findings` and keep conclusions evidence-backed.

Validation notes: do not request secrets, bypass limits, or infer capabilities
without a probe result.
