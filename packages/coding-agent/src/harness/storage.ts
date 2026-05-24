import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import { Snowflake } from "@oh-my-gpt/gpt-utils/snowflake";
import {
	HARNESS_SCHEMA_VERSION,
	type HarnessGateId,
	type HarnessGateState,
	type HarnessRunState,
	type HarnessTemplate,
	type HarnessTodoItem,
	normalizeHarnessTemplate,
} from "./types";

const DEFAULT_TODOS = [
	"define task",
	"build evidence packet",
	"select skills/workers",
	"send worker prompts",
	"download/parse outputs",
	"validate locally",
	"review",
	"report",
];

const ARTIFACT_PROJECT_GATES: HarnessGateId[] = [
	"doctor",
	"packet",
	"planner",
	"builder",
	"download",
	"manifest",
	"validate",
	"fixer",
	"critic",
	"report",
];

const WIKI_MACHINE_GATES: HarnessGateId[] = [
	"doctor",
	"blueprint_packet",
	"architect",
	"contract",
	"builder",
	"download",
	"wiki_manifest",
	"smoke_validate",
	"critic",
	"report",
];

const WIKI_SOURCE_GATES: HarnessGateId[] = [
	"doctor",
	"registry_snapshot",
	"decision_packet",
	"source_classifier",
	"decision_contract",
	"provision_plan",
	"github_preflight",
	"repo_create",
	"repo_seed",
	"registry_update",
	"validate",
	"critic",
	"report",
];

const WIKI_RESEARCH_GATES: HarnessGateId[] = [
	"doctor",
	"steering_load",
	"issue_fetch",
	"registry_snapshot",
	"source_decision",
	"issue_route",
	"research_packet",
	"researcher",
	"content_plan",
	"draft_builder",
	"validate_content",
	"branch_create",
	"pr_create",
	"issue_update",
	"critic",
	"report",
];

export function getHarnessRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "harness");
}

export function getHarnessRunsDir(agentDir?: string): string {
	return path.join(getHarnessRoot(agentDir), "runs");
}

export function getHarnessBenchmarksDir(agentDir?: string): string {
	return path.join(getHarnessRoot(agentDir), "benchmarks");
}

export function getHarnessRunDir(runId: string, agentDir?: string): string {
	return path.join(getHarnessRunsDir(agentDir), runId);
}

export function createRunId(date = new Date()): string {
	const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
	return `${stamp}-${Snowflake.next()}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

export function defaultTodos(): HarnessTodoItem[] {
	const updatedAt = nowIso();
	return DEFAULT_TODOS.map((title, index) => ({
		id: String(index + 1).padStart(2, "0"),
		title,
		status: index === 0 ? "in_progress" : "pending",
		updatedAt,
	}));
}

export function defaultArtifactProjectGates(): HarnessGateState[] {
	return ARTIFACT_PROJECT_GATES.map(id => ({ id, status: id === "fixer" ? "skipped" : "pending" }));
}

export function defaultHarnessGates(template?: HarnessTemplate): HarnessGateState[] | undefined {
	const normalized = normalizeHarnessTemplate(template);
	if (normalized === "artifact-project") return defaultArtifactProjectGates();
	if (normalized === "wiki") return WIKI_MACHINE_GATES.map(id => ({ id, status: "pending" }));
	if (normalized === "wiki-source") return WIKI_SOURCE_GATES.map(id => ({ id, status: "pending" }));
	if (normalized === "wiki-research") return WIKI_RESEARCH_GATES.map(id => ({ id, status: "pending" }));
	return undefined;
}

export function ensureHarnessGates(state: HarnessRunState): HarnessGateState[] {
	if (!state.gates) state.gates = defaultHarnessGates(state.template) ?? defaultArtifactProjectGates();
	const existing = new Set(state.gates.map(gate => gate.id));
	for (const gate of defaultHarnessGates(state.template) ?? defaultArtifactProjectGates()) {
		if (!existing.has(gate.id)) state.gates.push(gate);
	}
	return state.gates;
}

export async function ensureRunDirs(runId: string, agentDir?: string): Promise<string> {
	const runDir = getHarnessRunDir(runId, agentDir);
	await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
	for (const child of ["packets", "prompts", "responses", "artifacts", "validation"]) {
		await fs.mkdir(path.join(runDir, child), { recursive: true, mode: 0o700 });
	}
	return runDir;
}

export async function createHarnessRun(
	objective: string,
	options: { runId?: string; promptLimit?: number; agentDir?: string; template?: HarnessRunState["template"] } = {},
): Promise<HarnessRunState> {
	const runId = options.runId ?? createRunId();
	const template = normalizeHarnessTemplate(options.template);
	await ensureRunDirs(runId, options.agentDir);
	const createdAt = nowIso();
	const state: HarnessRunState = {
		schemaVersion: HARNESS_SCHEMA_VERSION,
		runId,
		objective,
		template,
		status: "active",
		createdAt,
		updatedAt: createdAt,
		promptBudget: { used: 0, limit: options.promptLimit ?? 10 },
		gates: defaultHarnessGates(template),
		workers: [],
		evidencePackets: [],
		artifacts: [],
		validation: [],
	};
	await writeRunState(state, options.agentDir);
	await writeTodos(runId, defaultTodos(), options.agentDir);
	await writeReport(state, options.agentDir);
	return state;
}

export async function readRunState(runId: string, agentDir?: string): Promise<HarnessRunState> {
	const file = path.join(getHarnessRunDir(runId, agentDir), "run.json");
	return JSON.parse(await fs.readFile(file, "utf8")) as HarnessRunState;
}

export async function writeRunState(state: HarnessRunState, agentDir?: string): Promise<void> {
	state.updatedAt = nowIso();
	const runDir = await ensureRunDirs(state.runId, agentDir);
	await Bun.write(path.join(runDir, "run.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function setGateStatus(
	state: HarnessRunState,
	id: HarnessGateId,
	status: HarnessGateState["status"],
	fields: Partial<Omit<HarnessGateState, "id" | "status">> = {},
	agentDir?: string,
): Promise<void> {
	const gates = ensureHarnessGates(state);
	const gate = gates.find(item => item.id === id);
	if (!gate) return;
	gate.status = status;
	Object.assign(gate, fields);
	if (status === "running") {
		gate.startedAt = gate.startedAt ?? nowIso();
		delete gate.completedAt;
		delete gate.error;
	}
	if (status === "passed" || status === "failed" || status === "skipped") {
		gate.completedAt = nowIso();
	}
	await writeRunState(state, agentDir);
}

export async function readTodos(runId: string, agentDir?: string): Promise<HarnessTodoItem[]> {
	const file = path.join(getHarnessRunDir(runId, agentDir), "todo.json");
	return JSON.parse(await fs.readFile(file, "utf8")) as HarnessTodoItem[];
}

export async function writeTodos(runId: string, todos: HarnessTodoItem[], agentDir?: string): Promise<void> {
	const runDir = await ensureRunDirs(runId, agentDir);
	await Bun.write(path.join(runDir, "todo.json"), `${JSON.stringify(todos, null, 2)}\n`);
}

export async function setTodoStatus(
	runId: string,
	title: string,
	status: HarnessTodoItem["status"],
	agentDir?: string,
): Promise<void> {
	const todos = await readTodos(runId, agentDir);
	const target = todos.find(todo => todo.title === title);
	if (!target) return;
	target.status = status;
	target.updatedAt = nowIso();
	await writeTodos(runId, todos, agentDir);
}

export async function writeRunFile(
	runId: string,
	kind: "prompts" | "responses" | "artifacts" | "validation" | "packets",
	name: string,
	content: string | Uint8Array,
	agentDir?: string,
): Promise<string> {
	const runDir = await ensureRunDirs(runId, agentDir);
	const filePath = path.join(runDir, kind, name);
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await Bun.write(filePath, content);
	return filePath;
}

export async function bindWorkerRole(
	state: HarnessRunState,
	role: string,
	worker: {
		workerId?: string;
		requestId?: string;
		conversationUrl?: string;
		title?: string;
		modelOption?: string;
		thinkingOption?: string;
		skillBundles?: string[];
	},
	agentDir?: string,
): Promise<void> {
	const existing = state.workers.find(item => item.role === role);
	if (existing) {
		Object.assign(existing, worker);
	} else {
		state.workers.push({ role, ...worker });
	}
	await writeRunState(state, agentDir);
}

export async function listHarnessRuns(agentDir?: string): Promise<HarnessRunState[]> {
	const runsDir = getHarnessRunsDir(agentDir);
	const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
	const states: HarnessRunState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			states.push(await readRunState(entry.name, agentDir));
		} catch {
			// Ignore partial or corrupt run directories in status listings.
		}
	}
	return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCurrentHarnessArtifacts(state: HarnessRunState): HarnessRunState["artifacts"] {
	const seen = new Set<string>();
	const current: HarnessRunState["artifacts"] = [];
	for (const artifact of [...state.artifacts].reverse()) {
		const key = artifact.sha256 || artifact.path;
		if (seen.has(key)) continue;
		seen.add(key);
		current.push(artifact);
	}
	return current.reverse().slice(-5);
}

export function getCurrentHarnessValidation(state: HarnessRunState): HarnessRunState["validation"] {
	const entries =
		state.status === "good_enough" ? state.validation.filter(entry => entry.status === "passed") : state.validation;
	const seen = new Set<string>();
	const current: HarnessRunState["validation"] = [];
	for (const entry of [...entries].reverse()) {
		const key = [entry.status, entry.command ?? "", entry.logPath ?? "", entry.summary].join("\0");
		if (seen.has(key)) continue;
		seen.add(key);
		current.push(entry);
	}
	return current.reverse().slice(-8);
}

export function summarizeHarnessValidation(state: HarnessRunState): string {
	const counts = state.validation.reduce(
		(acc, entry) => {
			acc[entry.status] += 1;
			return acc;
		},
		{ failed: 0, passed: 0, skipped: 0 },
	);
	return `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`;
}

export async function writeReport(state: HarnessRunState, agentDir?: string): Promise<string> {
	const runDir = await ensureRunDirs(state.runId, agentDir);
	const currentArtifacts = getCurrentHarnessArtifacts(state);
	const currentValidation = getCurrentHarnessValidation(state);
	const lines = [
		`# Harness Run ${state.runId}`,
		"",
		`- Objective: ${state.objective}`,
		`- Template: ${normalizeHarnessTemplate(state.template) ?? "(none)"}`,
		`- Status: ${state.status}`,
		`- Created: ${state.createdAt}`,
		`- Updated: ${state.updatedAt}`,
		`- Prompt budget: ${state.promptBudget.used}/${state.promptBudget.limit}`,
		`- Evidence packets: ${state.evidencePackets.length}`,
		`- Artifacts: ${currentArtifacts.length} current / ${state.artifacts.length} total`,
		`- Validation: ${summarizeHarnessValidation(state)} (${state.validation.length} total entries)`,
		`- Verdict: ${state.verdict ?? "(pending)"}`,
		`- Next command: ${state.status === "good_enough" || state.status === "abandoned" ? `omg harness export ${state.runId}` : `omg harness resume ${state.runId}`}`,
		"",
		"## Gates",
		"",
		...(state.gates?.length
			? state.gates.map(gate => `- ${gate.id}: ${gate.status}${gate.summary ? ` - ${gate.summary}` : ""}`)
			: ["- None recorded"]),
		"",
		"## Workers",
		"",
		...(state.workers.length
			? state.workers.map(w => `- ${w.role}: ${w.workerId ?? "(unassigned)"} ${w.conversationUrl ?? ""}`.trim())
			: ["- None recorded"]),
		"",
		"## Current Artifacts",
		"",
		...(currentArtifacts.length
			? currentArtifacts.map(a => `- ${a.source}: ${a.path}${a.sha256 ? ` ${a.sha256}` : ""}`.trim())
			: ["- None recorded"]),
		"",
		"## Current Validation",
		"",
		...(currentValidation.length
			? currentValidation.map(v => `- ${v.status}: ${v.summary}${v.command ? ` (${v.command})` : ""}`)
			: ["- No validation recorded yet"]),
		...(state.validation.length > currentValidation.length
			? [
					"",
					`Older validation history is retained in run.json (${state.validation.length - currentValidation.length} hidden entries).`,
				]
			: []),
		"",
		"## Reviewer Findings",
		"",
		...(state.reviewerFindings?.length ? state.reviewerFindings.map(finding => `- ${finding}`) : ["- None recorded"]),
		"",
	];
	const reportPath = path.join(runDir, "report.md");
	await Bun.write(reportPath, `${lines.join("\n")}\n`);
	return reportPath;
}
