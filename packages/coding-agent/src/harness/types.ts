import * as z from "zod/v4";

export const HARNESS_SCHEMA_VERSION = "omg.harness.v1" as const;

export const HandoffEnvelopeSchema = z.object({
	schema_version: z.literal("omg.handoff.v1"),
	role: z.enum(["critic", "researcher", "builder", "fixer", "planner"]),
	status: z.enum(["complete", "blocked", "needs_more_context", "invalid_artifact"]),
	summary: z.string(),
	confidence: z.number().min(0).max(1),
	assumptions: z.array(z.string()).default([]),
	findings: z.array(z.unknown()).default([]),
	next_action: z.enum(["validate_locally", "send_to_builder", "send_to_critic", "stop"]),
	artifacts: z.array(z.unknown()).default([]),
	patches: z.array(z.unknown()).default([]),
	requested_context: z.array(z.string()).default([]),
});

export const PatchEnvelopeSchema = z.object({
	schema_version: z.literal("omg.patch.v1"),
	status: z.literal("complete"),
	base_file_hashes: z.record(z.string(), z.string()),
	patch_format: z.literal("unified_diff"),
	patch: z.string(),
	test_commands: z.array(z.string()).default([]),
	risks: z.array(z.string()).default([]),
});

export const ArtifactEnvelopeSchema = z.object({
	schema_version: z.literal("omg.artifact.v1"),
	status: z.literal("complete"),
	artifact_name: z.string(),
	expected_root_entries: z.array(z.string()).default([]),
	test_commands: z.array(z.string()).default([]),
	limitations: z.array(z.string()).default([]),
});

export const CriticEnvelopeSchema = z.object({
	schema_version: z.literal("omg.review.v1"),
	approved: z.boolean(),
	blocking_findings: z.array(z.unknown()).default([]),
	non_blocking_findings: z.array(z.unknown()).default([]),
	required_fixes: z.array(z.string()).default([]),
	verdict: z.enum(["good_enough", "not_good_enough"]),
});

export const ChatGptJsonEnvelopeSchema = z.union([
	HandoffEnvelopeSchema,
	PatchEnvelopeSchema,
	ArtifactEnvelopeSchema,
	CriticEnvelopeSchema,
]);

export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>;
export type PatchEnvelope = z.infer<typeof PatchEnvelopeSchema>;
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;
export type CriticEnvelope = z.infer<typeof CriticEnvelopeSchema>;
export type ChatGptJsonEnvelope = z.infer<typeof ChatGptJsonEnvelopeSchema>;

export type HarnessTodoStatus = "pending" | "in_progress" | "completed" | "blocked";
export type HarnessRunStatus = "active" | "blocked" | "good_enough" | "not_good_enough" | "abandoned";
export type HarnessGateStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export type HarnessGateId =
	| "doctor"
	| "packet"
	| "planner"
	| "builder"
	| "download"
	| "manifest"
	| "validate"
	| "fixer"
	| "critic"
	| "report";

export const ProjectManifestSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	language: z.string().min(1),
	entrypoints: z.array(z.string()).default([]),
	test_command: z.string().min(1),
	expected_files: z.array(z.string()).default([]),
	limitations: z.array(z.string()).default([]),
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export interface HarnessTodoItem {
	id: string;
	title: string;
	status: HarnessTodoStatus;
	updatedAt: string;
}

export interface HarnessGateState {
	id: HarnessGateId;
	status: HarnessGateStatus;
	startedAt?: string;
	completedAt?: string;
	inputPaths?: string[];
	outputPaths?: string[];
	workerRole?: "planner" | "builder" | "critic" | "fixer";
	workerId?: string;
	requestId?: string;
	conversationUrl?: string;
	summary?: string;
	error?: string;
}

export interface HarnessRunState {
	schemaVersion: typeof HARNESS_SCHEMA_VERSION;
	runId: string;
	objective: string;
	template?: "artifact-project";
	status: HarnessRunStatus;
	createdAt: string;
	updatedAt: string;
	promptBudget: {
		used: number;
		limit: number;
	};
	gates?: HarnessGateState[];
	workers: Array<{
		role: "planner" | "builder" | "critic" | "fixer" | string;
		workerId?: string;
		requestId?: string;
		conversationUrl?: string;
		title?: string;
		modelOption?: string;
		thinkingOption?: string;
		skillBundles?: string[];
	}>;
	evidencePackets: string[];
	artifacts: Array<{
		source: string;
		path: string;
		sha256?: string;
		validationStatus?: string;
	}>;
	validation: Array<{
		command?: string;
		exitCode?: number;
		logPath?: string;
		status: "passed" | "failed" | "skipped";
		summary: string;
	}>;
	reviewerFindings?: string[];
	verdict?: string;
	abandonedAt?: string;
}

export interface HarnessDoctorCheck {
	id: string;
	label: string;
	ok: boolean;
	blocking: boolean;
	summary: string;
	details?: unknown;
}

export interface HarnessDoctorResult {
	ok: boolean;
	checks: HarnessDoctorCheck[];
}

export interface EvidencePacketOptions {
	runId: string;
	packetId?: string;
	objective: string;
	role: string;
	successCriteria: string[];
	constraints?: string[];
	files?: string[];
	validation?: string;
	cwd?: string;
}

export interface EvidencePacketSummary {
	packetId: string;
	packetDir: string;
	files: Array<{
		path: string;
		bytes: number;
		sha256: string;
	}>;
	omitted: string[];
}
