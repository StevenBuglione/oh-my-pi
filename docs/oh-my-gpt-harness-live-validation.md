# Oh-My-GPT Harness Live Validation

Date: 2026-05-23

This document records the first live ChatGPT worker validation of the OMG harness protocol.

## Scenario

Codex created an OMG harness run and evidence packet, then sent that packet to a live ChatGPT worker through the existing `chatgpt` CLI. The worker received:

- `TASK.md`
- `CONSTRAINTS.md`
- `SUMMARY.json`
- `VALIDATION.md`
- `EXPECTED_OUTPUT.schema.json`
- `REPO_SLICE.zip`
- `critic-review.oai.zip`

The worker was asked to return only the `omg.review.v1` JSON review envelope.

## Evidence

- Harness run id: `20260523T153313Z-14ecab59628fd660`
- Packet id: `1779550393771-critic`
- Worker id: `omg-live-1`
- ChatGPT request id: `333dba79f1984dcdbbf10a17a84e973c`
- Conversation URL: `https://chatgpt.com/c/6a11c8f5-1fe8-832e-99c1-76f21e7a6990`
- Local run directory: `C:\Users\steve\.omg\agent\harness\runs\20260523T153313Z-14ecab59628fd660`
- Parsed response path: `C:\Users\steve\.omg\agent\harness\runs\20260523T153313Z-14ecab59628fd660\responses\live-critic-copy-message-wide.json`

## Result

The live worker returned valid JSON:

```json
{
  "schema_version": "omg.review.v1",
  "approved": true,
  "blocking_findings": [],
  "non_blocking_findings": [],
  "required_fixes": [],
  "verdict": "good_enough"
}
```

Codex validated the response locally with `parseChatGptJsonEnvelope(...)`, which returned `ok: true`.

## CLI Findings

The run also exposed important ChatGPT CLI behavior that the harness must handle defensively:

- `workers watch --until-complete --json` completed, but surfaced a truncated assistant text prefix in `assistant_text`.
- `--copy-message` recovered the full response.
- Narrow terminal output wrapped JSON across a field name, so the harness worker wrapper now forces a wide non-color terminal when invoking the CLI.
- One artifact download attempt failed while reopening the conversation with `Page.goto: net::ERR_ABORTED`; this confirms artifact success must be validated locally and download failures must remain non-success states.

## Verdict

The live handoff proved the core harness shape:

- Evidence packets can be built locally and attached to ChatGPT.
- A ChatGPT skill bundle can be attached as `.oai.zip`.
- ChatGPT can return the expected structured review envelope.
- OMG can validate the returned JSON locally.
- CLI extraction and artifact issues are observable and must be handled as validation gates rather than trusted success.
