export const HARNESS_PROMPT_TEMPLATE_VERSION = "omg.artifact-project.prompts.v1";
export const WIKI_MACHINE_PROMPT_TEMPLATE_VERSION = "omg.wiki.prompts.v1";

export function plannerPrompt(objective: string): string {
	return [
		`Template: ${HARNESS_PROMPT_TEMPLATE_VERSION}`,
		"You are the planner for an OMG artifact-project harness run.",
		"You received one handoff zip. Unzip it first, then read HANDOFF_MANIFEST.json and packet/TASK.md.",
		'Create a file named response.json using schema_version "omg.handoff.v1".',
		"Before sending your final answer, run: python packet/validate_response.py response.json",
		"Attach response.json as a downloadable file. Do not paste JSON in the chat message.",
		"Your final chat message should only name the attached response.json file and say it is ready for download.",
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
		"Do not paste JSON or source code in the chat message. The final chat message should only name the attached response.json and workspace.zip files.",
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
		"Attach review.json as a downloadable file. Do not paste JSON in the chat message.",
		"Your final chat message should only name the attached review.json file and say it is ready for download.",
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

export function wikiArchitectPrompt(objective: string, responseFilename = "response.json"): string {
	return [
		`Template: ${WIKI_MACHINE_PROMPT_TEMPLATE_VERSION}`,
		"You are the architect for an OMG wiki harness run.",
		"You received one handoff zip. Unzip it first, then read HANDOFF_MANIFEST.json, packet/TASK.md, packet/CONSTRAINTS.md, packet/EXPECTED_OUTPUT.schema.json, and packet/AI_WIKI_MANIFEST.schema.json.",
		`Create a file named ${responseFilename} using schema_version "omg.wiki.blueprint.v1".`,
		`Before sending your final answer, run: python packet/validate_response.py ${responseFilename}`,
		`Attach ${responseFilename} as a downloadable file. Do not paste JSON in the chat message.`,
		`Your final chat message should only name the attached ${responseFilename} file and say it is ready for download.`,
		"Forbidden: Markdown fences, prose outside JSON, real repo creation, secrets, network-only validation, or asking the local model to choose the workflow.",
		"Required architecture: a local multi-package workspace with wiki-site, wiki-data-registry, and wiki-data-devops.",
		"Required design points: Docusaurus-style shell, jsDelivr-compatible registry/data contracts, generated wiki manifests, agent artifacts, Pagefind-ready structure, and local smoke validation.",
		"Important schema rule: this is not omg.handoff.v1. Do not include role, confidence, findings, next_action, artifacts, patches, or requested_context.",
		"The architecture field must be a short string, not an object. Put details into workspace_layout and build_phases arrays.",
		"Set status to complete unless a precise blocker exists.",
		"",
		"Objective:",
		objective,
	].join("\n");
}

export function wikiJsonRepairPrompt(
	role: "architect" | "builder" | "critic",
	validationError: string,
	responseFilename = "response.json",
): string {
	if (role === "architect") {
		return [
			`Your previous response failed OMG JSON validation: ${validationError}`,
			"",
			`Create a corrected JSON file named ${responseFilename} and attach it as a downloadable file.`,
			`Before sending your final answer, run: python packet/validate_response.py ${responseFilename}`,
			"Do not paste JSON in the chat message. The final chat message should only name the attached file.",
			'Use exactly schema_version "omg.wiki.blueprint.v1".',
			"Allowed top-level keys only: schema_version, status, summary, architecture, workspace_layout, build_phases, required_files, validation_commands, assumptions, risks.",
			"Required field types: status string; summary string; architecture string; workspace_layout string[]; build_phases string[]; required_files string[]; validation_commands string[]; assumptions string[]; risks string[].",
			"Forbidden keys: role, confidence, findings, next_action, artifacts, patches, requested_context, implementation_plan.",
			"Do not make architecture an object. Compress architecture into one string.",
			"Do not include commands with nested double quotes. Prefer simple commands like npm test, npm run smoke, or node scripts/validate-local.js.",
		].join("\n");
	}
	if (role === "builder") {
		return [
			`Your previous response failed OMG JSON validation: ${validationError}`,
			"",
			`Create a corrected JSON file named ${responseFilename} and attach it as a downloadable file.`,
			`Before sending your final answer, run: python packet/validate_response.py ${responseFilename}`,
			"Do not paste JSON in the chat message. The final chat message should only name the attached file.",
			'Use exactly schema_version "omg.wiki.artifact.v1".',
			"Allowed top-level keys only: schema_version, status, artifact_name, expected_workspace_root_entries, required_wiki_contracts, test_commands, limitations.",
			'Required field types: status must be "complete"; artifact_name string; expected_workspace_root_entries string[]; required_wiki_contracts string[]; test_commands string[]; limitations string[].',
		].join("\n");
	}
	return [
		`Your previous response failed OMG JSON validation: ${validationError}`,
		"",
		`Create a corrected JSON file named ${responseFilename} and attach it as a downloadable file.`,
		`Before sending your final answer, run: python packet/validate_response.py ${responseFilename}`,
		"Do not paste JSON in the chat message. The final chat message should only name the attached file.",
		'Use exactly schema_version "omg.wiki.review.v1".',
		"Allowed top-level keys only: schema_version, approved, blocking_findings, non_blocking_findings, required_fixes, verdict.",
		'Required field types: approved boolean; blocking_findings array; non_blocking_findings array; required_fixes string[]; verdict "good_enough" or "not_good_enough".',
	].join("\n");
}

export function wikiBuilderPrompt(
	objective: string,
	blueprintJson: string,
	artifactNames: { responseFilename?: string; workspaceFilename?: string } = {},
): string {
	const responseFilename = artifactNames.responseFilename ?? "response.json";
	const workspaceFilename = artifactNames.workspaceFilename ?? "workspace.zip";
	return [
		`Template: ${WIKI_MACHINE_PROMPT_TEMPLATE_VERSION}`,
		"You are the builder for an OMG wiki harness run.",
		"You received one handoff zip. Unzip it first, then read HANDOFF_MANIFEST.json, packet/TASK.md, packet/CONSTRAINTS.md, packet/WIKI_ACCEPTANCE_CHECKLIST.md, packet/AI_WIKI_MANIFEST.schema.json, and the attached wiki-builder skill.",
		`Build the complete local wiki proof workspace in your ChatGPT sandbox and attach a downloadable file named ${workspaceFilename}. Use a real archive file, not pasted code or a description.`,
		`If you cannot create and attach ${workspaceFilename}, set status to blocked or invalid_artifact and explain the exact blocker; never return status complete without the attached zip.`,
		`Also create ${responseFilename} using schema_version "omg.wiki.artifact.v1", run python packet/validate_response.py ${responseFilename}, and attach ${responseFilename}.`,
		`Local OMG validation is authoritative; ${responseFilename} only tells OMG what to validate and is not success by itself.`,
		"Forbidden: paid APIs, secrets, network-required tests, real GitHub repo creation, Pages deployment, jsDelivr purge calls, or Cloudflare deployment.",
		"Artifact requirements: AI_WIKI_MANIFEST.json at workspace root, wiki-site/, wiki-data-registry/, wiki-data-devops/, README.md, PROJECT_REPORT.md, and runnable local tests.",
		"Use the exact required package and contract paths from packet/WIKI_ACCEPTANCE_CHECKLIST.md. Alternative names such as wiki-package.json, registry/index.json, or site-only llms.txt are not substitutes.",
		"AI_WIKI_MANIFEST.json must match AI_WIKI_MANIFEST.schema.json.",
		"AI_WIKI_MANIFEST.json test_command is the only field that should contain a command, and OMG will run it exactly.",
		"Strict local contract fields that must exist:",
		'- wiki-data-registry/sources.json: routeMode must be "query" if present, and sources must be an array.',
		"- wiki-data-devops/published/latest.json: manifestUrl, catalogUrl, pagefindBundleUrl, agentManifestUrl, contentBaseUrl.",
		"- wiki-data-devops/published/dist/local/wiki-manifest.json: contentBaseUrl and at least one page.",
		"- first wiki-manifest page: id, sourceId, title, slug, file.",
		"- agent chunks JSONL: each line has chunkId, pageId, url, text, checksum.",
		`${responseFilename} must use artifact_name "${workspaceFilename}" and test_commands containing the exact manifest test_command.`,
		`Do not paste JSON or source code in the chat message. The final chat message should only name the attached ${responseFilename} and ${workspaceFilename} files.`,
		"If the zip upload is still processing, wait until it is visible before sending the final answer.",
		"",
		"Objective:",
		objective,
		"",
		"Locked blueprint JSON:",
		blueprintJson,
	].join("\n");
}

export function wikiBuilderArtifactRepairPrompt(
	objective: string,
	downloadError: string,
	artifactNames: { responseFilename?: string; workspaceFilename?: string } = {},
): string {
	const responseFilename = artifactNames.responseFilename ?? "response.json";
	const workspaceFilename = artifactNames.workspaceFilename ?? "workspace.zip";
	return [
		`Template: ${WIKI_MACHINE_PROMPT_TEMPLATE_VERSION}`,
		"You are the builder for an OMG wiki harness run.",
		"OMG received your previous response, but local artifact download failed.",
		`Download error: ${downloadError}`,
		`Use the same handoff zip attached to this message. Rebuild or locate the complete local wiki proof workspace and attach a real downloadable file named ${workspaceFilename}.`,
		`Also attach ${responseFilename} using schema_version "omg.wiki.artifact.v1" after running: python packet/validate_response.py ${responseFilename}`,
		`${responseFilename} must use artifact_name "${workspaceFilename}".`,
		`Do not return status complete unless ${workspaceFilename} is attached and visible as a downloadable artifact.`,
		"Do not paste JSON or source files in chat. Do not ask OMG to create the zip locally. Local OMG validation is authoritative.",
		"",
		"Objective:",
		objective,
	].join("\n");
}

export function wikiBuilderValidationRepairPrompt(
	objective: string,
	validationError: string,
	artifactNames: { responseFilename?: string; workspaceFilename?: string } = {},
): string {
	const responseFilename = artifactNames.responseFilename ?? "response.json";
	const workspaceFilename = artifactNames.workspaceFilename ?? "workspace.zip";
	return [
		`Template: ${WIKI_MACHINE_PROMPT_TEMPLATE_VERSION}`,
		"You are the builder/fixer for an OMG wiki harness run.",
		"OMG downloaded your workspace.zip, but local AI wiki contract validation failed.",
		`Validation error: ${validationError}`,
		"You received one handoff zip containing the previous workspace.zip, validation logs, the wiki-builder skill, and packet/WIKI_ACCEPTANCE_CHECKLIST.md.",
		`Unzip the handoff, inspect the failed artifact and validation log, then produce one replacement downloadable file named ${workspaceFilename}.`,
		"Fix the artifact so every exact path in packet/WIKI_ACCEPTANCE_CHECKLIST.md exists at the workspace root and every required JSON file parses.",
		"Do not only fix missing paths. Also fix every strict field named in the validation error, including latest.json URL fields, wiki-manifest contentBaseUrl/page fields, and agent chunk citation/checksum fields.",
		`Also attach ${responseFilename} using schema_version "omg.wiki.artifact.v1" after running: python packet/validate_response.py ${responseFilename}`,
		`${responseFilename} must use artifact_name "${workspaceFilename}".`,
		`Do not return status complete unless the replacement ${workspaceFilename} is attached and visible as a downloadable artifact.`,
		"Do not paste JSON or source files in chat. Local OMG validation is authoritative.",
		"",
		"Objective:",
		objective,
	].join("\n");
}

export function wikiCriticPrompt(
	objective: string,
	validation: string,
	artifactSha: string,
	responseFilename = "review.json",
): string {
	return [
		`Template: ${WIKI_MACHINE_PROMPT_TEMPLATE_VERSION}`,
		"You are the final critic for an OMG wiki harness run.",
		"You received one handoff zip. Unzip it first, then inspect artifacts/, validation/, and packet/ before deciding.",
		`Create a file named ${responseFilename} using schema_version "omg.wiki.review.v1".`,
		`Before sending your final answer, run: python packet/validate_response.py ${responseFilename}`,
		`Attach ${responseFilename} as a downloadable file. Do not paste JSON in the chat message.`,
		`Your final chat message should only name the attached ${responseFilename} file and say it is ready for download.`,
		"Local OMG validation is authoritative. Approve when the artifact satisfies the wiki objective and local validation passed.",
		"If the uploaded handoff is inaccessible, use the inline local validation evidence and artifact SHA below, note the upload-access issue as non-blocking residual risk, and still return schema-valid review JSON.",
		'The verdict field must be exactly "good_enough" or "not_good_enough"; never use "blocked".',
		"Forbidden: approving based on confidence alone, ignoring validation failures, or requiring real hosting/deployment for this local proof.",
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
