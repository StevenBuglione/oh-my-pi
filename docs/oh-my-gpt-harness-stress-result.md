# Oh-My-GPT Harness Stress Result

Date: 2026-05-23

This run pushed the OMG harness beyond a JSON-only critic proof by asking a live
ChatGPT worker to build a moderately complex, testable project artifact.

## Scenario

Worker `omg-stress-1` received an evidence packet and `artifact-builder.oai.zip`
with this task:

- Build a Python 3.13 compatible project named `import-graph-lab`.
- Use standard library only.
- Parse Python files with `ast`.
- Build an internal import dependency graph.
- Resolve relative imports.
- Detect cycles.
- Ignore and report syntax-error files.
- Emit JSON and readable text reports.
- Include README, project report, source, fixtures, and unittest coverage.
- Provide a downloadable `workspace.zip`.

## Evidence

- Harness run id: `20260523T154706Z-14ecae86a527d505`
- Packet id: `1779551226526-builder`
- Worker id: `omg-stress-1`
- Request id: `dbf634bd18fe4f6e99adbb1dba9b5581`
- Conversation URL: `https://chatgpt.com/c/6a11cc09-f3ec-832e-af23-0efdf847510d`
- Local run directory: `C:\Users\steve\.omg\agent\harness\runs\20260523T154706Z-14ecae86a527d505`
- Downloaded artifact: `C:\Users\steve\.omg\agent\harness\runs\20260523T154706Z-14ecae86a527d505\artifacts\workspace.zip`
- Artifact hash: `sha256:c4d93ae63b09c91cb62d34958e0880c47e340eb922982085d3a58d576f17dd2a`

## Result

The fixed `workers watch --json` path returned a complete `omg.artifact.v1`
envelope, including the declared test command:

```text
python -m unittest discover -s tests
```

Codex downloaded `workspace.zip`, unpacked it under the run workspace, and ran
the declared command locally. The result:

```text
Ran 7 tests in 0.234s

OK
```

## What This Proves

- ChatGPT can build a non-trivial local-only coding artifact as a zip.
- The CLI can download that artifact from the ChatGPT conversation.
- OMG can unpack and validate the artifact locally.
- The harness ledger can capture worker metadata, artifact hash, validation log,
  and final verdict.
- The workflow is useful for bounded project generation, fixture creation,
  independent prototypes, and external critique where local validation remains
  the source of truth.

## Limits Observed

- Worker chat rename still failed intermittently after completion; this did not
  affect artifact download or validation.
- ChatGPT's own claim that tests passed was treated only as a hint. The result
  became `good_enough` only after local unittest validation.
- Artifact links may appear as sandbox paths in the assistant JSON, so the
  harness must use CLI artifact download and hash the local file instead of
  trusting the message text.
