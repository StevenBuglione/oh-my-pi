Wraps the external `chatgpt` browser-control CLI for controlled worker handoffs.

Use this tool when ChatGPT should perform web research, artifact generation,
sandbox probing, independent critique, or structured JSON planning outside the
local OMG agent loop.

Rules:
- Never treat ChatGPT output as repo truth.
- Prefer evidence packets over broad raw context.
- Attach ChatGPT worker skills through `skills` when the handoff needs an uploaded `.oai.zip` contract.
- Require JSON-only responses unless the worker is producing a downloadable artifact.
- Record worker ids, conversation URLs, prompts, responses, and artifact paths in a harness run.
- Local validation gates decide success.
