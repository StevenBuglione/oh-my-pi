---
name: web-research
description: Perform online research with citations and structured handoff output
---

Research the assigned question using web access outside the sandbox. Prefer
primary sources and include citation URLs in `findings`.

Return JSON only using `omg.handoff.v1`. Use `confidence` conservatively and
list stale, conflicting, or weakly sourced claims in `assumptions` or
`findings`.

Validation notes: unsupported claims should be marked as assumptions, not facts.
