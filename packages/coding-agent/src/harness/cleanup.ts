import { type ChatGptWorkerCommand, type ChatGptWorkerCommandResult, runChatGptWorkerCommand } from "./chatgpt-cli";
import { listHarnessRuns, readRunState, writeReport, writeRunState } from "./storage";
import type { HarnessRunState } from "./types";

export interface HarnessCleanupOptions {
	runId?: string;
	stale?: boolean;
	staleMs?: number;
	now?: number;
	runner?: ChatGptWorkerRunner;
}

export interface HarnessCleanupResult {
	cleaned: string[];
	abandonedRunIds: string[];
}

type ChatGptWorkerRunner = (input: ChatGptWorkerCommand) => Promise<ChatGptWorkerCommandResult>;

function isRecordedRunWorker(_run: HarnessRunState, workerId: string | undefined): workerId is string {
	return Boolean(workerId);
}

export async function cleanupHarnessRuns(options: HarnessCleanupOptions = {}): Promise<HarnessCleanupResult> {
	const runner = options.runner ?? runChatGptWorkerCommand;
	const staleMs = options.staleMs ?? 60 * 60 * 1000;
	const now = options.now ?? Date.now();
	const runs = options.runId ? [await readRunState(options.runId)] : await listHarnessRuns();
	const cleaned: string[] = [];
	const abandonedRunIds: string[] = [];

	for (const run of runs) {
		if (options.stale && now - Date.parse(run.updatedAt) < staleMs) continue;
		let runCleaned = 0;
		for (const worker of run.workers) {
			if (!isRecordedRunWorker(run, worker.workerId)) continue;
			await runner({ action: "stop", worker: worker.workerId, timeoutMs: 30_000 });
			cleaned.push(worker.workerId);
			runCleaned += 1;
		}
		if ((run.status === "active" || run.status === "blocked") && runCleaned > 0) {
			run.status = "abandoned";
			run.verdict = "abandoned";
			run.abandonedAt = new Date(now).toISOString();
			abandonedRunIds.push(run.runId);
			await writeRunState(run);
			await writeReport(run);
		}
	}

	return { cleaned, abandonedRunIds };
}
