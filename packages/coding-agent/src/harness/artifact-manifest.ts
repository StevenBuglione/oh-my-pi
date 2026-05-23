import * as path from "node:path";
import { type ProjectManifest, ProjectManifestSchema } from "./types";

export interface ProjectManifestValidation {
	ok: boolean;
	manifestPath: string;
	manifest?: ProjectManifest;
	errors: string[];
}

function pathIsSafe(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(root, candidate);
	return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

export async function validateProjectManifest(workspaceDir: string): Promise<ProjectManifestValidation> {
	const manifestPath = path.join(workspaceDir, "PROJECT_MANIFEST.json");
	const errors: string[] = [];
	if (!(await Bun.file(manifestPath).exists())) {
		return { ok: false, manifestPath, errors: ["PROJECT_MANIFEST.json is missing from the artifact workspace root"] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.file(manifestPath).text());
	} catch (error) {
		return {
			ok: false,
			manifestPath,
			errors: [`PROJECT_MANIFEST.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const result = ProjectManifestSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, manifestPath, errors: [result.error.message] };
	}

	const manifest = result.data;
	for (const file of manifest.expected_files) {
		if (!file || file.includes("\0") || path.isAbsolute(file) || !pathIsSafe(workspaceDir, file)) {
			errors.push(`expected_files contains an unsafe path: ${file}`);
			continue;
		}
		if (!(await Bun.file(path.join(workspaceDir, file)).exists())) {
			errors.push(`expected file is missing: ${file}`);
		}
	}

	for (const entrypoint of manifest.entrypoints) {
		if (
			!entrypoint ||
			entrypoint.includes("\0") ||
			path.isAbsolute(entrypoint) ||
			!pathIsSafe(workspaceDir, entrypoint)
		) {
			errors.push(`entrypoints contains an unsafe path: ${entrypoint}`);
			continue;
		}
		if (!(await Bun.file(path.join(workspaceDir, entrypoint)).exists())) {
			errors.push(`entrypoint is missing: ${entrypoint}`);
		}
	}

	return { ok: errors.length === 0, manifestPath, manifest, errors };
}
