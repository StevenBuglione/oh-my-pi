import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-gpt/gpt-utils/dirs";
import { ensureRunDirs, getHarnessRunDir } from "./storage";
import type { EvidencePacketOptions, EvidencePacketSummary } from "./types";
import { REQUIRED_AI_WIKI_CONTRACTS, REQUIRED_AI_WIKI_PACKAGES } from "./wiki-manifest";

let fflateModulePromise: Promise<typeof import("fflate")> | undefined;
function loadFflate(): Promise<typeof import("fflate")> {
	if (!fflateModulePromise) fflateModulePromise = import("fflate");
	return fflateModulePromise;
}

const DEFAULT_CONSTRAINTS = [
	"Do not assume direct access to the user's filesystem.",
	"Return JSON only unless explicitly asked to produce a downloadable artifact.",
	"Never request or reveal secrets, tokens, cookies, browser profiles, or credential databases.",
	"Use local validation results as authoritative.",
];

const BLOCKED_PATH_PARTS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".omg",
	".omp",
	".env",
	"agent.db",
	"cookies",
	"browser",
]);

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function isBlockedRelativePath(relPath: string): boolean {
	const parts = toPosixPath(relPath).split("/");
	return parts.some(part => BLOCKED_PATH_PARTS.has(part) || part.endsWith(".db") || part.endsWith(".sqlite"));
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes);
	const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
	return `sha256:${Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

function responseSchemas(): Record<string, unknown> {
	const baseStringArray = { type: "array", items: { type: "string" }, default: [] };
	const unknownArray = { type: "array", items: {}, default: [] };
	return {
		"omg.handoff.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"role",
				"status",
				"summary",
				"confidence",
				"assumptions",
				"findings",
				"next_action",
				"artifacts",
				"patches",
				"requested_context",
			],
			properties: {
				schema_version: { const: "omg.handoff.v1" },
				role: { enum: ["critic", "researcher", "builder", "fixer", "planner"] },
				status: { enum: ["complete", "blocked", "needs_more_context", "invalid_artifact"] },
				summary: { type: "string" },
				confidence: { type: "number", minimum: 0, maximum: 1 },
				assumptions: baseStringArray,
				findings: unknownArray,
				next_action: { enum: ["validate_locally", "send_to_builder", "send_to_critic", "stop"] },
				artifacts: unknownArray,
				patches: unknownArray,
				requested_context: baseStringArray,
			},
		},
		"omg.artifact.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"status",
				"artifact_name",
				"expected_root_entries",
				"test_commands",
				"limitations",
			],
			properties: {
				schema_version: { const: "omg.artifact.v1" },
				status: { const: "complete" },
				artifact_name: { type: "string" },
				expected_root_entries: baseStringArray,
				test_commands: baseStringArray,
				limitations: baseStringArray,
			},
		},
		"omg.review.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"approved",
				"blocking_findings",
				"non_blocking_findings",
				"required_fixes",
				"verdict",
			],
			properties: {
				schema_version: { const: "omg.review.v1" },
				approved: { type: "boolean" },
				blocking_findings: unknownArray,
				non_blocking_findings: unknownArray,
				required_fixes: baseStringArray,
				verdict: { enum: ["good_enough", "not_good_enough"] },
			},
		},
		"omg.patch.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: ["schema_version", "status", "base_file_hashes", "patch_format", "patch", "test_commands", "risks"],
			properties: {
				schema_version: { const: "omg.patch.v1" },
				status: { const: "complete" },
				base_file_hashes: { type: "object", additionalProperties: { type: "string" } },
				patch_format: { const: "unified_diff" },
				patch: { type: "string" },
				test_commands: baseStringArray,
				risks: baseStringArray,
			},
		},
		"omg.wiki.blueprint.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"status",
				"summary",
				"architecture",
				"workspace_layout",
				"build_phases",
				"required_files",
				"validation_commands",
				"assumptions",
				"risks",
			],
			properties: {
				schema_version: { const: "omg.wiki.blueprint.v1" },
				status: { enum: ["complete", "blocked", "needs_more_context"] },
				summary: { type: "string" },
				architecture: { type: "string" },
				workspace_layout: baseStringArray,
				build_phases: baseStringArray,
				required_files: baseStringArray,
				validation_commands: baseStringArray,
				assumptions: baseStringArray,
				risks: baseStringArray,
			},
		},
		"omg.wiki.artifact.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"status",
				"artifact_name",
				"expected_workspace_root_entries",
				"required_wiki_contracts",
				"test_commands",
				"limitations",
			],
			properties: {
				schema_version: { const: "omg.wiki.artifact.v1" },
				status: { const: "complete" },
				artifact_name: { type: "string" },
				expected_workspace_root_entries: baseStringArray,
				required_wiki_contracts: baseStringArray,
				test_commands: baseStringArray,
				limitations: baseStringArray,
			},
		},
		"omg.wiki.review.v1": {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: [
				"schema_version",
				"approved",
				"blocking_findings",
				"non_blocking_findings",
				"required_fixes",
				"verdict",
			],
			properties: {
				schema_version: { const: "omg.wiki.review.v1" },
				approved: { type: "boolean" },
				blocking_findings: unknownArray,
				non_blocking_findings: unknownArray,
				required_fixes: baseStringArray,
				verdict: { enum: ["good_enough", "not_good_enough"] },
			},
		},
	};
}

function responseValidatorScript(): string {
	return `#!/usr/bin/env python3
import json
import sys

HANDOFF_REQUIRED = {
    "schema_version", "role", "status", "summary", "confidence", "assumptions",
    "findings", "next_action", "artifacts", "patches", "requested_context",
}
ARTIFACT_REQUIRED = {
    "schema_version", "status", "artifact_name", "expected_root_entries",
    "test_commands", "limitations",
}
REVIEW_REQUIRED = {
    "schema_version", "approved", "blocking_findings", "non_blocking_findings",
    "required_fixes", "verdict",
}
PATCH_REQUIRED = {
    "schema_version", "status", "base_file_hashes", "patch_format", "patch",
    "test_commands", "risks",
}
WIKI_BLUEPRINT_REQUIRED = {
    "schema_version", "status", "summary", "architecture", "workspace_layout",
    "build_phases", "required_files", "validation_commands", "assumptions", "risks",
}
WIKI_ARTIFACT_REQUIRED = {
    "schema_version", "status", "artifact_name", "expected_workspace_root_entries",
    "required_wiki_contracts", "test_commands", "limitations",
}
WIKI_REVIEW_REQUIRED = {
    "schema_version", "approved", "blocking_findings", "non_blocking_findings",
    "required_fixes", "verdict",
}

def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1

def require_keys(data: dict, required: set[str]) -> int:
    missing = sorted(required - set(data))
    if missing:
        return fail("missing required keys: " + ", ".join(missing))
    return 0

def require_list(data: dict, key: str) -> int:
    if not isinstance(data.get(key), list):
        return fail(f"{key} must be an array")
    return 0

def validate(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:
        return fail(f"invalid JSON: {exc}")
    if not isinstance(data, dict):
        return fail("top-level value must be an object")

    version = data.get("schema_version")
    if version == "omg.handoff.v1":
        code = require_keys(data, HANDOFF_REQUIRED)
        if code:
            return code
        if data.get("role") not in {"critic", "researcher", "builder", "fixer", "planner"}:
            return fail("role is invalid")
        if data.get("status") not in {"complete", "blocked", "needs_more_context", "invalid_artifact"}:
            return fail("status is invalid")
        if data.get("next_action") not in {"validate_locally", "send_to_builder", "send_to_critic", "stop"}:
            return fail("next_action is invalid")
        if not isinstance(data.get("confidence"), (int, float)) or not 0 <= data["confidence"] <= 1:
            return fail("confidence must be a number from 0 to 1")
        for key in ("assumptions", "findings", "artifacts", "patches", "requested_context"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.artifact.v1":
        code = require_keys(data, ARTIFACT_REQUIRED)
        if code:
            return code
        if data.get("status") != "complete":
            return fail("status must be complete")
        for key in ("expected_root_entries", "test_commands", "limitations"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.review.v1":
        code = require_keys(data, REVIEW_REQUIRED)
        if code:
            return code
        if not isinstance(data.get("approved"), bool):
            return fail("approved must be boolean")
        if data.get("verdict") not in {"good_enough", "not_good_enough"}:
            return fail("verdict is invalid")
        for key in ("blocking_findings", "non_blocking_findings", "required_fixes"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.patch.v1":
        code = require_keys(data, PATCH_REQUIRED)
        if code:
            return code
        if data.get("status") != "complete":
            return fail("status must be complete")
        if data.get("patch_format") != "unified_diff":
            return fail("patch_format must be unified_diff")
        if not isinstance(data.get("base_file_hashes"), dict):
            return fail("base_file_hashes must be object")
        for key in ("test_commands", "risks"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.wiki.blueprint.v1":
        code = require_keys(data, WIKI_BLUEPRINT_REQUIRED)
        if code:
            return code
        if data.get("status") not in {"complete", "blocked", "needs_more_context"}:
            return fail("status is invalid")
        for key in ("workspace_layout", "build_phases", "required_files", "validation_commands", "assumptions", "risks"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.wiki.artifact.v1":
        code = require_keys(data, WIKI_ARTIFACT_REQUIRED)
        if code:
            return code
        if data.get("status") != "complete":
            return fail("status must be complete")
        for key in ("expected_workspace_root_entries", "required_wiki_contracts", "test_commands", "limitations"):
            code = require_list(data, key)
            if code:
                return code
    elif version == "omg.wiki.review.v1":
        code = require_keys(data, WIKI_REVIEW_REQUIRED)
        if code:
            return code
        if not isinstance(data.get("approved"), bool):
            return fail("approved must be boolean")
        if data.get("verdict") not in {"good_enough", "not_good_enough"}:
            return fail("verdict is invalid")
        for key in ("blocking_findings", "non_blocking_findings", "required_fixes"):
            code = require_list(data, key)
            if code:
                return code
    else:
        return fail("unknown schema_version")

    print("valid")
    return 0

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} RESPONSE_JSON")
    raise SystemExit(validate(sys.argv[1]))
`;
}

async function writeResponseContractFiles(packetDir: string): Promise<void> {
	const schemas = responseSchemas();
	const schemaDir = path.join(packetDir, "schemas");
	await fs.mkdir(schemaDir, { recursive: true, mode: 0o700 });
	for (const [version, schema] of Object.entries(schemas)) {
		await Bun.write(path.join(schemaDir, `${version}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
	}
	await Bun.write(
		path.join(packetDir, "PROJECT_MANIFEST.schema.json"),
		`${JSON.stringify(
			{
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				additionalProperties: false,
				required: [
					"name",
					"description",
					"language",
					"entrypoints",
					"test_command",
					"expected_files",
					"limitations",
				],
				properties: {
					name: { type: "string", minLength: 1 },
					description: { type: "string", minLength: 1 },
					language: { type: "string", minLength: 1 },
					entrypoints: {
						type: "array",
						description: "Existing relative file paths only, never shell commands.",
						items: { type: "string", minLength: 1 },
					},
					test_command: {
						type: "string",
						minLength: 1,
						description: "The exact local command OMG should run after unpacking the artifact.",
					},
					expected_files: {
						type: "array",
						description: "Existing relative file paths that must be present in the artifact.",
						items: { type: "string", minLength: 1 },
					},
					limitations: { type: "array", items: { type: "string" } },
				},
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		path.join(packetDir, "EXPECTED_OUTPUT.schema.json"),
		`${JSON.stringify(
			{
				description:
					"Create response JSON as a file, validate it with validate_response.py, attach that file, and do not paste JSON in chat.",
				required_artifact_names: {
					planner: "response.json",
					builder: "response.json plus workspace.zip",
					fixer: "response.json plus replacement workspace.zip",
					critic: "review.json",
				},
				schemas,
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		path.join(packetDir, "AI_WIKI_MANIFEST.schema.json"),
		`${JSON.stringify(
			{
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				additionalProperties: false,
				required: [
					"schema_version",
					"name",
					"description",
					"packages",
					"test_command",
					"required_contracts",
					"limitations",
				],
				properties: {
					schema_version: { const: "omg.ai-wiki.workspace.v1" },
					name: { type: "string", minLength: 1 },
					description: { type: "string", minLength: 1 },
					packages: {
						type: "array",
						description:
							"Required workspace package directories, including wiki-site, wiki-data-registry, and wiki-data-devops.",
						items: { type: "string", minLength: 1 },
					},
					test_command: {
						type: "string",
						minLength: 1,
						description: "The exact local command OMG should run after unpacking the wiki artifact.",
					},
					required_contracts: {
						type: "array",
						description: "Relative files that prove the wiki data contract exists.",
						items: { type: "string", minLength: 1 },
					},
					limitations: { type: "array", items: { type: "string" } },
				},
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(path.join(packetDir, "validate_response.py"), responseValidatorScript());
}

export async function writeWikiAcceptanceChecklist(packetDir: string): Promise<void> {
	await Bun.write(
		path.join(packetDir, "WIKI_ACCEPTANCE_CHECKLIST.md"),
		[
			"# Wiki Acceptance Checklist",
			"",
			"OMG validates these exact paths before running tests. The builder artifact must include them at the workspace root.",
			"",
			"## Required Package Directories",
			"",
			...REQUIRED_AI_WIKI_PACKAGES.map(item => `- ${item}/`),
			"",
			"## Required Contract Files",
			"",
			...REQUIRED_AI_WIKI_CONTRACTS.map(item => `- ${item}`),
			"",
			"## Artifact Rules",
			"",
			"- `AI_WIKI_MANIFEST.json` must include all required package directories in `packages`.",
			"- `AI_WIKI_MANIFEST.json.required_contracts` may include more files, but it cannot replace the required paths above.",
			"- All required `.json` files must parse as valid JSON.",
			'- `wiki-data-registry/sources.json` must use `routeMode: "query"` when `routeMode` is present and must include a `sources` array.',
			"- `wiki-data-devops/published/latest.json` must include non-empty string fields: `manifestUrl`, `catalogUrl`, `pagefindBundleUrl`, `agentManifestUrl`, and `contentBaseUrl`.",
			"- `wiki-data-devops/published/dist/local/wiki-manifest.json` must include a non-empty string `contentBaseUrl` and at least one page object.",
			"- The first manifest page must include non-empty string fields: `id`, `sourceId`, `title`, `slug`, and `file`.",
			"- `wiki-data-devops/published/dist/local/agent/chunks/chunks-0001.jsonl` must contain at least one JSON line.",
			"- Every agent chunk line must include non-empty string fields: `chunkId`, `pageId`, `url`, `text`, and `checksum`.",
			"- Tests must run offline without secrets, paid APIs, deployments, or network access.",
			"",
		].join("\n"),
	);
}

async function maybeReadScopedFile(cwd: string, requestedPath: string) {
	const absolute = path.resolve(cwd, requestedPath);
	if (!pathIsWithin(cwd, absolute)) return { omitted: requestedPath };
	const relPath = toPosixPath(path.relative(cwd, absolute));
	if (!relPath || isBlockedRelativePath(relPath)) return { omitted: requestedPath };
	const stat = await fs.stat(absolute).catch(() => null);
	if (!stat?.isFile()) return { omitted: requestedPath };
	if (stat.size > 512_000) return { omitted: requestedPath };
	const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
	return {
		file: {
			path: relPath,
			bytes,
			size: stat.size,
			sha256: await sha256(bytes),
		},
	};
}

export async function buildEvidencePacket(options: EvidencePacketOptions): Promise<EvidencePacketSummary> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const packetId = options.packetId ?? `${Date.now()}-${options.role}`;
	await ensureRunDirs(options.runId);
	const packetDir = path.join(getHarnessRunDir(options.runId), "packets", packetId);
	await fs.mkdir(packetDir, { recursive: true, mode: 0o700 });

	const constraints = [...DEFAULT_CONSTRAINTS, ...(options.constraints ?? [])];
	await Bun.write(
		path.join(packetDir, "TASK.md"),
		[
			`# Task`,
			"",
			`Role: ${options.role}`,
			"",
			options.objective,
			"",
			"## Success Criteria",
			"",
			...options.successCriteria.map(item => `- ${item}`),
			"",
		].join("\n"),
	);
	await Bun.write(path.join(packetDir, "CONSTRAINTS.md"), `${constraints.map(item => `- ${item}`).join("\n")}\n`);
	await Bun.write(path.join(packetDir, "VALIDATION.md"), `${options.validation ?? "No prior validation."}\n`);
	await writeResponseContractFiles(packetDir);
	await writeWikiAcceptanceChecklist(packetDir);

	const files: EvidencePacketSummary["files"] = [];
	const omitted: string[] = [];
	const zipEntries: Record<string, Uint8Array> = {};
	for (const filePath of options.files ?? []) {
		const result = await maybeReadScopedFile(cwd, filePath);
		if ("omitted" in result) {
			if (result.omitted) omitted.push(result.omitted);
			continue;
		}
		const file = result.file;
		if (!file) continue;
		files.push({ path: file.path, bytes: file.size, sha256: file.sha256 });
		zipEntries[file.path] = file.bytes;
	}

	if (Object.keys(zipEntries).length > 0) {
		const { zipSync } = await loadFflate();
		await Bun.write(path.join(packetDir, "REPO_SLICE.zip"), zipSync(zipEntries));
	}

	const summary: EvidencePacketSummary = { packetId, packetDir, files, omitted };
	await Bun.write(path.join(packetDir, "SUMMARY.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}
