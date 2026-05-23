import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AiWikiManifest, AiWikiManifestSchema } from "./types";

export interface AiWikiManifestValidation {
	ok: boolean;
	manifestPath: string;
	manifest?: AiWikiManifest;
	errors: string[];
}

export const REQUIRED_AI_WIKI_PACKAGES = ["wiki-site", "wiki-data-registry", "wiki-data-devops"];
export const REQUIRED_AI_WIKI_CONTRACTS = [
	"README.md",
	"PROJECT_REPORT.md",
	"wiki-site/package.json",
	"wiki-site/src/wiki-core/types.ts",
	"wiki-site/static/llms.txt",
	"wiki-site/static/.well-known/wiki-agent.json",
	"wiki-data-registry/sources.json",
	"wiki-data-registry/agent-sources.json",
	"wiki-data-devops/wiki.source.json",
	"wiki-data-devops/docs/index.md",
	"wiki-data-devops/published/latest.json",
	"wiki-data-devops/published/latest-agent.json",
	"wiki-data-devops/published/dist/local/wiki-manifest.json",
	"wiki-data-devops/published/dist/local/wiki-catalog.json",
	"wiki-data-devops/published/dist/local/wiki-tags.json",
	"wiki-data-devops/published/dist/local/wiki-health.json",
	"wiki-data-devops/published/dist/local/agent/agent-manifest.json",
	"wiki-data-devops/published/dist/local/agent/chunks/chunks-0001.jsonl",
];

function pathIsSafe(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(root, candidate);
	return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

async function requireExistingFile(workspaceDir: string, relPath: string, errors: string[]): Promise<void> {
	if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath) || !pathIsSafe(workspaceDir, relPath)) {
		errors.push(`unsafe required file path: ${relPath}`);
		return;
	}
	if (!(await Bun.file(path.join(workspaceDir, relPath)).exists())) {
		errors.push(`required file is missing: ${relPath}`);
	}
}

async function requireJsonFile(workspaceDir: string, relPath: string, errors: string[]): Promise<void> {
	await requireExistingFile(workspaceDir, relPath, errors);
	const filePath = path.join(workspaceDir, relPath);
	if (!(await Bun.file(filePath).exists())) return;
	try {
		JSON.parse(await Bun.file(filePath).text());
	} catch (error) {
		errors.push(
			`required JSON file is malformed: ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function validateAiWikiManifest(workspaceDir: string): Promise<AiWikiManifestValidation> {
	const manifestPath = path.join(workspaceDir, "AI_WIKI_MANIFEST.json");
	const errors: string[] = [];
	if (!(await Bun.file(manifestPath).exists())) {
		return { ok: false, manifestPath, errors: ["AI_WIKI_MANIFEST.json is missing from the artifact workspace root"] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.file(manifestPath).text());
	} catch (error) {
		return {
			ok: false,
			manifestPath,
			errors: [`AI_WIKI_MANIFEST.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const result = AiWikiManifestSchema.safeParse(parsed);
	if (!result.success) return { ok: false, manifestPath, errors: [result.error.message] };

	const manifest = result.data;
	for (const packageName of REQUIRED_AI_WIKI_PACKAGES) {
		if (!manifest.packages.includes(packageName)) errors.push(`manifest packages is missing: ${packageName}`);
		const packageDir = path.join(workspaceDir, packageName);
		const packageStat = await fs.stat(packageDir).catch(() => undefined);
		if (!packageStat?.isDirectory()) errors.push(`required package directory is missing: ${packageName}`);
	}

	for (const relPath of [...new Set([...REQUIRED_AI_WIKI_CONTRACTS, ...manifest.required_contracts])]) {
		if (relPath.endsWith(".json")) await requireJsonFile(workspaceDir, relPath, errors);
		else await requireExistingFile(workspaceDir, relPath, errors);
	}

	return { ok: errors.length === 0, manifestPath, manifest, errors };
}
