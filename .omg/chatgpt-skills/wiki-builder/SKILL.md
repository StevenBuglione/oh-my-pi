---
name: wiki-builder
description: Build a downloadable local AI wiki-machine workspace artifact for OMG validation
---

# Wiki Builder

Use this skill when an OMG wiki-machine handoff asks you to build a local multi-package wiki proof.

## Instructions

- Unzip the single handoff archive first.
- Read `HANDOFF_MANIFEST.json`, `packet/TASK.md`, `packet/CONSTRAINTS.md`, `packet/WIKI_ACCEPTANCE_CHECKLIST.md`, `packet/AI_WIKI_MANIFEST.schema.json`, and the locked blueprint JSON.
- Build a complete local workspace and attach a real downloadable archive named `workspace.zip`.
- If you cannot create and attach `workspace.zip`, return `status: "invalid_artifact"` or `status: "blocked"` with the exact blocker. Never return `status: "complete"` without the attached zip.
- Do not create real GitHub repositories, deploy hosting, call jsDelivr purge endpoints, use secrets, or require network access for tests.
- Include `README.md`, `PROJECT_REPORT.md`, and `AI_WIKI_MANIFEST.json` at the workspace root.
- Include `wiki-site`, `wiki-data-registry`, and `wiki-data-devops` directories.
- Include every exact path listed in `packet/WIKI_ACCEPTANCE_CHECKLIST.md`; alternative names are not substitutes.
- Include static contracts for registry, source config, wiki manifests, agent artifacts, and `llms.txt`/well-known discovery.

## Expected Output Format

Create `response.json` using `schema_version: "omg.wiki.artifact.v1"`.

Required top-level keys:

- `schema_version`
- `status`
- `artifact_name`
- `expected_workspace_root_entries`
- `required_wiki_contracts`
- `test_commands`
- `limitations`

Run:

```bash
python packet/validate_response.py response.json
```

Attach both `workspace.zip` and `response.json`. Paste `response.json` JSON in chat only as a fallback. If the zip is still processing, wait until it appears as a downloadable artifact before sending the final answer.

## Validation Notes

OMG will unzip `workspace.zip`, validate `AI_WIKI_MANIFEST.json`, verify required files, reject unsafe paths, and run the manifest `test_command` exactly.
