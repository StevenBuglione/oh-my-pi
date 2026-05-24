import { type WikiBlueprintEnvelope, WikiBlueprintEnvelopeSchema } from "./types";

export interface WikiBlueprintParseResult {
	ok: boolean;
	value?: WikiBlueprintEnvelope;
	text?: string;
	normalized: boolean;
	warnings: string[];
	error?: string;
}

function stripMarkdownFence(raw: string): string {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonObject(raw: string): string {
	const stripped = stripMarkdownFence(raw);
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start >= 0 && end > start) return stripped.slice(start, end + 1);
	return stripped;
}

function parseJsonCandidate(raw: string): { value?: unknown; error?: string } {
	const candidate = extractJsonObject(raw);
	try {
		return { value: JSON.parse(candidate) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function dropMalformedValidationCommands(raw: string): string {
	return extractJsonObject(raw).replace(
		/"validation_commands"\s*:\s*\[[\s\S]*?\]\s*,\s*"assumptions"/,
		'"validation_commands":[],"assumptions"',
	);
}

function asString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.overview === "string") return record.overview;
		if (typeof record.description === "string") return record.description;
	}
	if (value === undefined || value === null) return fallback;
	return JSON.stringify(value);
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => asString(item))
		.map(item => item.trim())
		.filter(Boolean);
}

function normalizeBlueprintObject(value: unknown): {
	value?: WikiBlueprintEnvelope;
	warnings: string[];
	error?: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { warnings: [], error: "blueprint response was not a JSON object" };
	}
	const input = value as Record<string, unknown>;
	const status = ["complete", "blocked", "needs_more_context"].includes(String(input.status))
		? String(input.status)
		: "complete";
	const buildPhases = asStringArray(input.build_phases).length
		? asStringArray(input.build_phases)
		: asStringArray(input.implementation_plan);
	const normalized = {
		schema_version: input.schema_version,
		status,
		summary: asString(input.summary),
		architecture: asString(input.architecture),
		workspace_layout: asStringArray(input.workspace_layout),
		build_phases: buildPhases,
		required_files: asStringArray(input.required_files),
		validation_commands: asStringArray(input.validation_commands),
		assumptions: asStringArray(input.assumptions),
		risks: asStringArray(input.risks),
	};
	const result = WikiBlueprintEnvelopeSchema.safeParse(normalized);
	if (!result.success) return { warnings: [], error: result.error.message };

	const warnings: string[] = [];
	if (typeof input.architecture !== "string") warnings.push("architecture was normalized to a string");
	if (!Array.isArray(input.build_phases) && Array.isArray(input.implementation_plan)) {
		warnings.push("implementation_plan was normalized to build_phases");
	}
	for (const forbidden of [
		"role",
		"confidence",
		"findings",
		"next_action",
		"artifacts",
		"patches",
		"requested_context",
	]) {
		if (forbidden in input) warnings.push(`ignored non-blueprint field ${forbidden}`);
	}
	if (!Array.isArray(input.validation_commands)) warnings.push("validation_commands defaulted to an empty array");
	return { value: result.data, warnings };
}

export function parseWikiBlueprintEnvelope(raw: string): WikiBlueprintParseResult {
	const direct = parseJsonCandidate(raw);
	if (direct.value !== undefined) {
		const exact = WikiBlueprintEnvelopeSchema.safeParse(direct.value);
		if (exact.success) {
			return {
				ok: true,
				value: exact.data,
				text: `${JSON.stringify(exact.data, null, 2)}\n`,
				normalized: false,
				warnings: [],
			};
		}
		const normalized = normalizeBlueprintObject(direct.value);
		if (normalized.value) {
			return {
				ok: true,
				value: normalized.value,
				text: `${JSON.stringify(normalized.value, null, 2)}\n`,
				normalized: true,
				warnings: normalized.warnings,
			};
		}
		return { ok: false, normalized: false, warnings: [], error: normalized.error ?? exact.error.message };
	}

	const withoutCommands = parseJsonCandidate(dropMalformedValidationCommands(raw));
	if (withoutCommands.value !== undefined) {
		const normalized = normalizeBlueprintObject(withoutCommands.value);
		if (normalized.value) {
			return {
				ok: true,
				value: normalized.value,
				text: `${JSON.stringify(normalized.value, null, 2)}\n`,
				normalized: true,
				warnings: ["malformed validation_commands were removed from copied worker JSON", ...normalized.warnings],
			};
		}
		return { ok: false, normalized: false, warnings: [], error: normalized.error };
	}

	return { ok: false, normalized: false, warnings: [], error: direct.error };
}
