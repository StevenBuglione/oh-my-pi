import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import { Snowflake } from "@oh-my-gpt/gpt-utils/snowflake";
import { HARNESS_SCHEMA_VERSION, type HarnessRunState, type HarnessTodoItem } from "./types";

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
	options: { runId?: string; promptLimit?: number; agentDir?: string } = {},
): Promise<HarnessRunState> {
	const runId = options.runId ?? createRunId();
	await ensureRunDirs(runId, options.agentDir);
	const createdAt = nowIso();
	const state: HarnessRunState = {
		schemaVersion: HARNESS_SCHEMA_VERSION,
		runId,
		objective,
		status: "active",
		createdAt,
		updatedAt: createdAt,
		promptBudget: { used: 0, limit: options.promptLimit ?? 10 },
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

export async function readTodos(runId: string, agentDir?: string): Promise<HarnessTodoItem[]> {
	const file = path.join(getHarnessRunDir(runId, agentDir), "todo.json");
	return JSON.parse(await fs.readFile(file, "utf8")) as HarnessTodoItem[];
}

export async function writeTodos(runId: string, todos: HarnessTodoItem[], agentDir?: string): Promise<void> {
	const runDir = await ensureRunDirs(runId, agentDir);
	await Bun.write(path.join(runDir, "todo.json"), `${JSON.stringify(todos, null, 2)}\n`);
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
	];
	const reportPath = path.join(runDir, "report.md");
	await Bun.write(reportPath, `${lines.join("\n")}\n`);
	return reportPath;
}
