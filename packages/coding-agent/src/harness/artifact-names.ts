import { randomUUID } from "node:crypto";
import type { HarnessGateState, HarnessRunState } from "./types";

export interface HarnessArtifactRequest {
	id: string;
	role: string;
	responseFilename: string;
	artifactFilename?: string;
}

function shortRunId(runId: string): string {
	return runId.split("-").at(-1)?.slice(0, 8) ?? runId.slice(0, 8);
}

function sanitizeToken(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function createHarnessArtifactRequest(
	runId: string,
	role: string,
	options: { artifactKind?: "workspace" | "artifact"; artifactExt?: "zip" } = {},
): HarnessArtifactRequest {
	const id = randomUUID();
	const safeRole = sanitizeToken(role) || "worker";
	const prefix = `omg-${shortRunId(runId)}-${safeRole}`;
	return {
		id,
		role,
		responseFilename: `${prefix}-response-${id}.json`,
		artifactFilename: options.artifactExt
			? `${prefix}-${options.artifactKind ?? "artifact"}-${id}.${options.artifactExt}`
			: undefined,
	};
}

export function getOrCreateGateArtifactRequest(
	state: HarnessRunState,
	gateId: string,
	role: string,
	options: { artifactKind?: "workspace" | "artifact"; artifactExt?: "zip" } = {},
): HarnessArtifactRequest {
	const gate = state.gates?.find(item => item.id === gateId);
	if (gate?.artifactRequest) return gate.artifactRequest;
	const request = createHarnessArtifactRequest(state.runId, role, options);
	if (gate) gate.artifactRequest = request;
	return request;
}

export function recordGateDownloadAttempt(
	gate: HarnessGateState | undefined,
	attempt: NonNullable<HarnessGateState["downloadAttempts"]>[number],
): void {
	if (!gate) return;
	gate.downloadAttempts = [...(gate.downloadAttempts ?? []), attempt];
}
