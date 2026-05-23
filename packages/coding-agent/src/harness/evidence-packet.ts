import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-gpt/gpt-utils/dirs";
import { ensureRunDirs, getHarnessRunDir } from "./storage";
import { ChatGptJsonEnvelopeSchema, type EvidencePacketOptions, type EvidencePacketSummary } from "./types";

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
	await Bun.write(
		path.join(packetDir, "EXPECTED_OUTPUT.schema.json"),
		`${JSON.stringify(zodSchemaAsPromptContract(), null, 2)}\n`,
	);

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

function zodSchemaAsPromptContract(): unknown {
	return {
		description: "Respond with one of the supported OMG JSON envelopes.",
		supported_schema_versions: ["omg.handoff.v1", "omg.patch.v1", "omg.artifact.v1", "omg.review.v1"],
		base_contract: ChatGptJsonEnvelopeSchema.toString(),
	};
}
