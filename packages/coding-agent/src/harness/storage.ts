import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import { Snowflake } from "@oh-my-gpt/gpt-utils/snowflake";
import {
	HARNESS_SCHEMA_VERSION,
	type HarnessGateId,
	type HarnessGateState,
	type HarnessRunState,
	type HarnessTodoItem,
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

export function getHarnessRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "harness");
}

export function getHarnessRunsDir(agentDir?: string): string {
	return path.join(getHarnessRoot(agentDir), "runs");
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

export function ensureHarnessGates(state: HarnessRunState): HarnessGateState[] {
	if (!state.gates) state.gates = defaultArtifactProjectGates();
	const existing = new Set(state.gates.map(gate => gate.id));
	for (const gate of defaultArtifactProjectGates()) {
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
	await ensureRunDirs(runId, options.agentDir);
	const createdAt = nowIso();
	const state: HarnessRunState = {
		schemaVersion: HARNESS_SCHEMA_VERSION,
		runId,
		objective,
		template: options.template,
		status: "active",
		createdAt,
		updatedAt: createdAt,
		promptBudget: { used: 0, limit: options.promptLimit ?? 10 },
		gates: options.template === "artifact-project" ? defaultArtifactProjectGates() : undefined,
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

export async function writeReport(state: HarnessRunState, agentDir?: string): Promise<string> {
	const runDir = await ensureRunDirs(state.runId, agentDir);
	const lines = [
		`# Harness Run ${state.runId}`,
		"",
		`- Objective: ${state.objective}`,
		`- Status: ${state.status}`,
		`- Created: ${state.createdAt}`,
		`- Updated: ${state.updatedAt}`,
		`- Prompt budget: ${state.promptBudget.used}/${state.promptBudget.limit}`,
		`- Evidence packets: ${state.evidencePackets.length}`,
		`- Artifacts: ${state.artifacts.length}`,
		`- Validation entries: ${state.validation.length}`,
		`- Verdict: ${state.verdict ?? "(pending)"}`,
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
		"## Validation",
		"",
		...(state.validation.length
			? state.validation.map(v => `- ${v.status}: ${v.summary}${v.command ? ` (${v.command})` : ""}`)
			: ["- No validation recorded yet"]),
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
