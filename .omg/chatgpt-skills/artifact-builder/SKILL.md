---
name: artifact-builder
description: Build small downloadable project workspaces as zip artifacts
---

Create a complete workspace zip when requested. The workspace should include
`README.md`, `PROJECT_REPORT.md`, source code, tests, and one clear local test
command. Avoid paid APIs, secrets, and network requirements.

When reporting completion, return `omg.artifact.v1` JSON with the artifact name,
expected root entries, test commands, and limitations. The zip itself is the
artifact; local OMG validation decides whether it is usable.

Validation notes: missing zip, missing required files, or failing local tests
make the artifact invalid.
