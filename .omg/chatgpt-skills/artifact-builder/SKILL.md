---
name: artifact-builder
description: Build small downloadable project workspaces as zip artifacts
---

Create a complete workspace zip when requested. The workspace should include
`README.md`, `PROJECT_REPORT.md`, source code, tests, and one clear local test
command. Avoid paid APIs, secrets, and network requirements.

Design for handoff:
- Keep dependencies minimal and declare every dependency in `pyproject.toml`,
  `requirements.txt`, `package.json`, or the equivalent project manifest.
- Prefer deterministic command-line apps, libraries, analyzers, parsers,
  validators, or report generators that can be tested locally without network.
- Include realistic fixtures and tests for edge cases, not only happy paths.
- Keep generated files under the workspace root; do not rely on hidden notebook
  state or external downloads.
- Name the final artifact `workspace.zip` unless the prompt asks otherwise.

When reporting completion, return `omg.artifact.v1` JSON with the artifact name,
expected root entries, test commands, and limitations. The zip itself is the
artifact; local OMG validation decides whether it is usable.

Validation notes: missing zip, missing required files, or failing local tests
make the artifact invalid.
