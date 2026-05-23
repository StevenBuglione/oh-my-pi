export const HARNESS_PROMPT_TEMPLATE_VERSION = "omg.artifact-project.prompts.v1";

export function plannerPrompt(objective: string): string {
	return [
		`Template: ${HARNESS_PROMPT_TEMPLATE_VERSION}`,
		"You are the planner for an OMG artifact-project harness run.",
		"You received one handoff zip. Unzip it first, then read HANDOFF_MANIFEST.json and packet/TASK.md.",
		'Create a file named response.json using schema_version "omg.handoff.v1".',
		"Before sending your final answer, run: python packet/validate_response.py response.json",
		"Attach response.json as a downloadable file. In the chat message, paste the same JSON only as a fallback.",
		"Forbidden: Markdown fences, prose outside JSON, claiming local tests passed, requesting broad repo access, or embedding source-file contents in patches.",
		"Required keys: schema_version, role, status, summary, confidence, assumptions, findings, next_action, artifacts, patches, requested_context.",
		"Set patches to [] for planner output; describe implementation guidance in findings instead of embedding code.",
		"Set role to planner, status to complete unless blocked, next_action to send_to_builder, and requested_context to [] unless a specific missing file is essential.",
		"",
		"Objective:",
		objective,
	].join("\n");
}

export function builderPrompt(objective: string, plannerJson: string): string {
	return [
		`Template: ${HARNESS_PROMPT_TEMPLATE_VERSION}`,
		"You are the builder for an OMG artifact-project harness run.",
		"You received one handoff zip. Unzip it first, then read HANDOFF_MANIFEST.json, packet/TASK.md, packet/CONSTRAINTS.md, and packet/PROJECT_MANIFEST.schema.json.",
		"Build the complete project in your ChatGPT sandbox and attach a downloadable file named workspace.zip.",
		'Also create response.json using schema_version "omg.artifact.v1", run python packet/validate_response.py response.json, and attach response.json.',
		"Local OMG validation is authoritative; do not claim success without attaching the zip.",
		"Forbidden: paid APIs, network requirements, secrets, undeclared dependencies, Markdown-only deliverables, or missing tests.",
		"Artifact requirements: README.md, PROJECT_REPORT.md, source code, tests, and PROJECT_MANIFEST.json at the artifact workspace root.",
		"PROJECT_MANIFEST.json must match PROJECT_MANIFEST.schema.json.",
		"PROJECT_MANIFEST.json entrypoints and expected_files must be existing relative file paths inside workspace.zip, never shell commands or module invocation strings.",
		"PROJECT_MANIFEST.json test_command is the only field that should contain a command, and OMG will run it exactly.",
		'response.json must use artifact_name "workspace.zip" and test_commands containing the exact manifest test_command.',
		"In the chat message, paste response.json JSON only as a fallback after attaching both files.",
		"",
		"Objective:",
		objective,
		"",
		"Planner JSON:",
		plannerJson,
	].join("\n");
}

export function fixerPrompt(objective: string, failureSummary: string): string {
	return [
		`Template: ${HARNESS_PROMPT_TEMPLATE_VERSION}`,
		"You are the fixer for an OMG artifact-project harness run.",
		"You received one handoff zip. Unzip it first, then inspect the prior artifact under artifacts/ and validation logs under validation/.",
		"The previous workspace.zip failed local OMG validation. Inspect only the uploaded artifact, validation log, and/or manifest error.",
		"Produce one replacement downloadable file named workspace.zip.",
		'Also create response.json using schema_version "omg.artifact.v1", run python packet/validate_response.py response.json, and attach response.json.',
		"Local OMG validation is authoritative; do not claim success without attaching the replacement zip.",
		"Required: README.md, PROJECT_REPORT.md, source code, tests, and valid PROJECT_MANIFEST.json at the artifact workspace root.",
		"PROJECT_MANIFEST.json entrypoints and expected_files must be existing relative file paths, never shell commands; only test_command contains a command.",
		"",
		"Objective:",
		objective,
		"",
		"Failure summary:",
		failureSummary,
	].join("\n");
}

export function criticPrompt(objective: string, validation: string, artifactSha: string): string {
	return [
		`Template: ${HARNESS_PROMPT_TEMPLATE_VERSION}`,
		"You are the final critic for an OMG artifact-project harness run.",
		"You received one handoff zip. Unzip it first, then inspect artifacts/, validation/, and packet/ before deciding.",
		'Create a file named review.json using schema_version "omg.review.v1".',
		"Before sending your final answer, run: python packet/validate_response.py review.json",
		"Attach review.json as a downloadable file. In the chat message, paste the same JSON only as a fallback.",
		"Local OMG validation is authoritative. Approve only when the uploaded artifact satisfies the objective and local validation passed.",
		"Forbidden: approving based on confidence alone, approving without inspecting the artifact, or ignoring validation failures.",
		"",
		"Objective:",
		objective,
		"",
		`Artifact SHA256: ${artifactSha}`,
		"",
		"Local validation evidence:",
		validation,
	].join("\n");
}
