---
name: wiki-architect
description: Convert a broad AI wiki objective into a deterministic OMG wiki-machine blueprint
---

# Wiki Architect

Use this skill when an OMG wiki-machine handoff asks you to design a local AI-native static wiki proof.

## Instructions

- Unzip the single handoff archive first.
- Read `HANDOFF_MANIFEST.json`, `packet/TASK.md`, `packet/CONSTRAINTS.md`, and `packet/EXPECTED_OUTPUT.schema.json`.
- Produce a local proof blueprint only. Do not create GitHub repos, deploy GitHub Pages, purge jsDelivr, or create Cloudflare resources.
- Preserve the required shape: `wiki-site`, `wiki-data-registry`, and `wiki-data-devops`.
- Include deterministic validation commands that do not need network access, paid APIs, or secrets.

## Expected Output Format

Create `response.json` using `schema_version: "omg.wiki.blueprint.v1"`.

Required top-level keys:

- `schema_version`
- `status`
- `summary`
- `architecture`
- `workspace_layout`
- `build_phases`
- `required_files`
- `validation_commands`
- `assumptions`
- `risks`

Run:

```bash
python packet/validate_response.py response.json
```

Attach `response.json` as a downloadable file. Paste the same JSON in chat only as a fallback.

## Validation Notes

Local OMG validation is authoritative. Do not claim the final wiki works; the architect only locks the blueprint for a builder.
