import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { type ChatGptWorkerCommand, type ChatGptWorkerCommandResult, runChatGptWorkerCommand } from "./chatgpt-cli";
import { type HarnessCommandRunner, runHarnessDoctor } from "./doctor";
import { buildEvidencePacket, writeWikiAcceptanceChecklist } from "./evidence-packet";
import { parseChatGptJsonEnvelope } from "./json-contracts";
import {
	wikiArchitectPrompt,
	wikiBuilderArtifactRepairPrompt,
	wikiBuilderPrompt,
	wikiBuilderValidationRepairPrompt,
	wikiCriticPrompt,
} from "./prompt-templates";
import { bundleChatGptSkill } from "./skills";
import {
	bindWorkerRole,
	createHarnessRun,
	ensureHarnessGates,
	getHarnessRunDir,
	readRunState,
	setGateStatus,
	setTodoStatus,
	writeReport,
	writeRunFile,
	writeRunState,
} from "./storage";
import type { HarnessRunState, WikiReviewEnvelope } from "./types";
import { type AiWikiManifestValidation, validateAiWikiManifest } from "./wiki-manifest";

export type WikiMachineWorkerRunner = (input: ChatGptWorkerCommand) => Promise<ChatGptWorkerCommandResult>;

interface WikiMachineOptions {
	cwd?: string;
	promptLimit?: number;
	files?: string[];
	checkDoctor?: boolean;
	doctorRunner?: HarnessCommandRunner;
	workerRunner?: WikiMachineWorkerRunner;
	artifactDownloadRetryDelaysMs?: number[];
	testCommand?: string[];
	onEvent?: (message: string) => void;
}

interface WorkerExchange {
	workerId: string;
	requestId?: string;
	conversationUrl?: string;
	copiedText: string;
	responsePath?: string;
}

const DEFAULT_CHATGPT_MODEL_OPTION = "Thinking";
const DEFAULT_CHATGPT_THINKING_OPTION = "Standard";
const FALLBACK_CHATGPT_MODEL_OPTION = "Pro";
const DEFAULT_ARTIFACT_DOWNLOAD_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];

function emit(options: WikiMachineOptions, message: string): void {
	options.onEvent?.(message);
}

function shortRunId(runId: string): string {
	return runId.split("-").at(-1)?.slice(0, 8) ?? runId.slice(0, 8);
}

function safeJson(raw: string): any {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function firstWorkerId(raw: string): string | undefined {
	const parsed = safeJson(raw);
	if (Array.isArray(parsed)) return parsed.find(item => typeof item?.worker_id === "string")?.worker_id;
	if (typeof parsed?.worker_id === "string") return parsed.worker_id;
	return undefined;
}

function responseMeta(raw: string): { requestId?: string; conversationUrl?: string } {
	const parsed = safeJson(raw);
	return {
		requestId: typeof parsed?.request_id === "string" ? parsed.request_id : parsed?.last_request_id,
		conversationUrl: typeof parsed?.conversation_url === "string" ? parsed.conversation_url : undefined,
	};
}

function modelSelectionFailed(result: ChatGptWorkerCommandResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
	return (
		text.includes("model") ||
		text.includes("thinking") ||
		text.includes("option") ||
		text.includes("not available") ||
		text.includes("unable to select")
	);
}

function gatePassed(state: HarnessRunState, id: string): boolean {
	return ensureHarnessGates(state).find(gate => gate.id === id)?.status === "passed";
}

async function startGate(state: HarnessRunState, id: string, options: WikiMachineOptions): Promise<void> {
	emit(options, `running ${id}`);
	await setGateStatus(state, id, "running");
}

async function passGate(
	state: HarnessRunState,
	id: string,
	options: WikiMachineOptions,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `passed ${id}`);
	await setGateStatus(state, id, "passed", fields);
}

async function failGate(
	state: HarnessRunState,
	id: string,
	options: WikiMachineOptions,
	error: string,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `failed ${id}: ${error}`);
	await setGateStatus(state, id, "failed", { ...fields, error });
}

async function skipGate(
	state: HarnessRunState,
	id: string,
	options: WikiMachineOptions,
	summary: string,
): Promise<void> {
	emit(options, `skipped ${id}: ${summary}`);
	await setGateStatus(state, id, "skipped", { summary });
}

async function consumePromptBudget(state: HarnessRunState, role: string): Promise<void> {
	if (state.promptBudget.used >= state.promptBudget.limit)
		throw new Error(`prompt budget exhausted before ${role} prompt`);
	state.promptBudget.used += 1;
	await writeRunState(state);
}

async function sha256File(filePath: string): Promise<string> {
	const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sleep(ms: number): Promise<void> {
	if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function listFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) out.push(absolute);
		}
	}
	await walk(root);
	return out.sort();
}

async function createHandoffBundle(
	state: HarnessRunState,
	role: "architect" | "builder" | "critic",
	files: string[],
): Promise<string> {
	const runDir = getHarnessRunDir(state.runId);
	const outDir = path.join(runDir, "artifacts", "handoffs");
	await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
	const entries: Record<string, Uint8Array> = {};
	const seen = new Set<string>();
	const packetRoot = state.evidencePackets[0] ? path.resolve(state.evidencePackets[0]) : undefined;
	for (const filePath of files) {
		const absolute = path.resolve(filePath);
		const stat = await fs.stat(absolute).catch(() => null);
		if (!stat?.isFile()) continue;
		let entryName = `files/${path.basename(absolute)}`;
		if (packetRoot && (absolute === packetRoot || absolute.startsWith(`${packetRoot}${path.sep}`))) {
			entryName = `packet/${path.relative(packetRoot, absolute).replace(/\\/g, "/")}`;
		} else if (absolute.endsWith(".oai.zip")) {
			entryName = `skills/${path.basename(absolute)}`;
		} else if (absolute.endsWith(".zip")) {
			entryName = `artifacts/${path.basename(absolute)}`;
		} else if (absolute.includes(`${path.sep}validation${path.sep}`)) {
			entryName = `validation/${path.basename(absolute)}`;
		}
		let uniqueName = entryName;
		let suffix = 2;
		while (seen.has(uniqueName)) {
			const parsed = path.posix.parse(entryName);
			uniqueName = `${parsed.dir}/${parsed.name}-${suffix}${parsed.ext}`;
			suffix += 1;
		}
		seen.add(uniqueName);
		entries[uniqueName] = new Uint8Array(await Bun.file(absolute).arrayBuffer());
	}
	entries["HANDOFF_MANIFEST.json"] = new TextEncoder().encode(
		`${JSON.stringify(
			{
				role,
				created_at: new Date().toISOString(),
				instructions: [
					"Unzip this handoff archive before working.",
					"Read packet/TASK.md, packet/CONSTRAINTS.md, packet/EXPECTED_OUTPUT.schema.json, and packet/AI_WIKI_MANIFEST.schema.json.",
					"Validate response JSON with: python packet/validate_response.py response.json",
					"Attach the required response JSON file and any requested artifact after validation.",
				],
				entries: Object.keys(entries).sort(),
			},
			null,
			2,
		)}\n`,
	);
	const bundlePath = path.join(outDir, `${role}-handoff.zip`);
	await Bun.write(bundlePath, zipSync(entries));
	return bundlePath;
}

async function createWorker(
	state: HarnessRunState,
	role: "architect" | "builder" | "critic",
	runner: WikiMachineWorkerRunner,
	skillBundles: string[] = [],
): Promise<string> {
	const existing = state.workers.find(worker => worker.role === role)?.workerId;
	if (existing) return existing;
	const result = await runner({ action: "create", extraArgs: ["--count", "1", "--json"], timeoutMs: 120_000 });
	await writeRunFile(state.runId, "responses", `${role}-create.json`, result.stdout || result.stderr);
	if (!result.ok) throw new Error(`failed to create ${role} worker: ${result.stderr || result.stdout}`);
	const workerId = firstWorkerId(result.stdout);
	if (!workerId) throw new Error(`failed to parse ${role} worker id from ChatGPT create output`);
	const title = `OMG ${shortRunId(state.runId)} wiki ${role} ${workerId}`;
	const rename = await runner({
		action: "rename",
		worker: workerId,
		title,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-rename.json`, rename.stdout || rename.stderr);
	await bindWorkerRole(state, role, { workerId, skillBundles, title });
	return workerId;
}

async function waitForWorker(
	state: HarnessRunState,
	role: string,
	workerId: string,
	sent: { requestId?: string; conversationUrl?: string },
	runner: WikiMachineWorkerRunner,
): Promise<{ requestId?: string; conversationUrl?: string }> {
	const watch = await runner({
		action: "watch",
		worker: workerId,
		extraArgs: ["--until-complete", "--json", "--timeout", "420"],
		timeoutMs: 450_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-watch.json`, watch.stdout || watch.stderr);
	if (!watch.ok) throw new Error(`failed to watch ${role} worker: ${watch.stderr || watch.stdout}`);
	return { ...sent, ...responseMeta(watch.stdout) };
}

async function downloadJsonResponse(
	state: HarnessRunState,
	role: "architect" | "builder" | "critic",
	conversationUrl: string | undefined,
	runner: WikiMachineWorkerRunner,
): Promise<{ path: string; text: string } | undefined> {
	if (!conversationUrl) return undefined;
	const runDir = getHarnessRunDir(state.runId);
	const downloadDir = path.join(runDir, "responses", `${role}-json-artifacts`);
	await fs.rm(downloadDir, { recursive: true, force: true });
	await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
	const download = await runner({ action: "download_artifacts", conversationUrl, downloadDir, timeoutMs: 180_000 });
	await writeRunFile(state.runId, "responses", `${role}-json-download.json`, download.stdout || download.stderr);
	if (!download.ok || !download.downloadedFiles?.length) return undefined;
	const preferred = role === "critic" ? ["review.json", "response.json"] : ["response.json", `${role}.json`];
	const candidates = download.downloadedFiles
		.filter(file => file.toLowerCase().endsWith(".json"))
		.sort((a, b) => {
			const aRank = preferred.findIndex(name => a.toLowerCase().endsWith(name));
			const bRank = preferred.findIndex(name => b.toLowerCase().endsWith(name));
			return (aRank === -1 ? 99 : aRank) - (bRank === -1 ? 99 : bRank) || a.localeCompare(b);
		});
	for (const relPath of candidates) {
		const absolute = path.resolve(downloadDir, relPath);
		if (absolute !== path.resolve(downloadDir) && !absolute.startsWith(`${path.resolve(downloadDir)}${path.sep}`))
			continue;
		const text = (await Bun.file(absolute).text()).trim();
		const parsed = parseChatGptJsonEnvelope(text);
		if (!parsed.ok) continue;
		const copiedPath = await writeRunFile(state.runId, "responses", `${role}-copy.json`, `${text}\n`);
		return { path: copiedPath, text };
	}
	return undefined;
}

async function sendAndCopy(
	state: HarnessRunState,
	role: "architect" | "builder" | "critic",
	workerId: string,
	prompt: string,
	runner: WikiMachineWorkerRunner,
	options: { files?: string[]; skills?: string[]; expectJson?: boolean; preferJson?: boolean } = {},
): Promise<WorkerExchange> {
	await writeRunFile(state.runId, "prompts", `${role}.md`, prompt);
	await consumePromptBudget(state, role);
	let modelOption = DEFAULT_CHATGPT_MODEL_OPTION;
	let thinkingOption = DEFAULT_CHATGPT_THINKING_OPTION;
	let send = await runner({
		action: "send",
		worker: workerId,
		prompt,
		files: options.files,
		skills: options.skills,
		modelOption,
		thinkingOption,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-send.json`, send.stdout || send.stderr);
	if (!send.ok && modelSelectionFailed(send)) {
		modelOption = FALLBACK_CHATGPT_MODEL_OPTION;
		thinkingOption = DEFAULT_CHATGPT_THINKING_OPTION;
		send = await runner({
			action: "send",
			worker: workerId,
			prompt,
			files: options.files,
			skills: options.skills,
			modelOption,
			thinkingOption,
			extraArgs: ["--json"],
			timeoutMs: 120_000,
		});
		await writeRunFile(state.runId, "responses", `${role}-send-fallback.json`, send.stdout || send.stderr);
	}
	if (!send.ok) throw new Error(`failed to send ${role} prompt: ${send.stderr || send.stdout}`);
	const sent = responseMeta(send.stdout);
	const watched = await waitForWorker(state, role, workerId, sent, runner);
	const conversationUrl = watched.conversationUrl ?? sent.conversationUrl;
	if (options.expectJson || options.preferJson) {
		const artifactJson = await downloadJsonResponse(state, role, conversationUrl, runner);
		if (artifactJson) {
			await bindWorkerRole(state, role, {
				workerId,
				requestId: watched.requestId ?? sent.requestId,
				conversationUrl,
				modelOption,
				thinkingOption,
				skillBundles: options.skills,
			});
			return {
				workerId,
				requestId: watched.requestId ?? sent.requestId,
				conversationUrl,
				copiedText: artifactJson.text,
				responsePath: artifactJson.path,
			};
		}
	}
	const copied = await runner({ action: "copy_message", conversationUrl, timeoutMs: 120_000 });
	await writeRunFile(state.runId, "responses", `${role}-copy.txt`, copied.stdout || copied.stderr);
	if (!copied.ok) throw new Error(`failed to copy ${role} worker response: ${copied.stderr || copied.stdout}`);
	const validation = parseChatGptJsonEnvelope(copied.stdout.trim());
	if (options.expectJson && !validation.ok) {
		const repairPrompt =
			`Your previous response failed OMG JSON validation: ${validation.error ?? "unknown schema error"}\n\n` +
			"Re-emit the same answer as JSON only, with no Markdown fence, commentary, or surrounding text. Use the schema requested in the original prompt.";
		await writeRunFile(state.runId, "prompts", `${role}-repair.md`, repairPrompt);
		await consumePromptBudget(state, `${role} repair`);
		const repair = await runner({
			action: "send",
			worker: workerId,
			prompt: repairPrompt,
			modelOption,
			thinkingOption,
			extraArgs: ["--json"],
			timeoutMs: 120_000,
		});
		await writeRunFile(state.runId, "responses", `${role}-repair-send.json`, repair.stdout || repair.stderr);
		if (!repair.ok) throw new Error(`failed to send ${role} JSON repair prompt: ${repair.stderr || repair.stdout}`);
		const repairMeta = await waitForWorker(state, `${role}-repair`, workerId, responseMeta(repair.stdout), runner);
		const repairedArtifact = await downloadJsonResponse(
			state,
			role,
			repairMeta.conversationUrl ?? conversationUrl,
			runner,
		);
		if (repairedArtifact) {
			await bindWorkerRole(state, role, {
				workerId,
				requestId: repairMeta.requestId ?? watched.requestId ?? sent.requestId,
				conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
				modelOption,
				thinkingOption,
				skillBundles: options.skills,
			});
			return {
				workerId,
				requestId: repairMeta.requestId ?? watched.requestId ?? sent.requestId,
				conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
				copiedText: repairedArtifact.text,
				responsePath: repairedArtifact.path,
			};
		}
		const repairCopied = await runner({
			action: "copy_message",
			conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
			timeoutMs: 120_000,
		});
		await writeRunFile(
			state.runId,
			"responses",
			`${role}-repair-copy.txt`,
			repairCopied.stdout || repairCopied.stderr,
		);
		if (!parseChatGptJsonEnvelope(repairCopied.stdout.trim()).ok) {
			throw new Error(`${role} worker did not return a valid wiki-machine JSON envelope after one repair attempt`);
		}
		return {
			workerId,
			requestId: repairMeta.requestId ?? watched.requestId ?? sent.requestId,
			conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
			copiedText: repairCopied.stdout.trim(),
		};
	}
	await bindWorkerRole(state, role, {
		workerId,
		requestId: watched.requestId ?? sent.requestId,
		conversationUrl,
		modelOption,
		thinkingOption,
		skillBundles: options.skills,
	});
	return {
		workerId,
		requestId: watched.requestId ?? sent.requestId,
		conversationUrl,
		copiedText: copied.stdout.trim(),
	};
}

async function downloadAndUnpackArtifact(
	state: HarnessRunState,
	conversationUrl: string | undefined,
	runner: WikiMachineWorkerRunner,
	options: WikiMachineOptions,
): Promise<{ zipPath: string; workspaceDir: string; sha256: string }> {
	const runDir = getHarnessRunDir(state.runId);
	const downloadDir = path.join(runDir, "artifacts", "downloads");
	await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
	const retryDelays = options.artifactDownloadRetryDelaysMs ?? DEFAULT_ARTIFACT_DOWNLOAD_RETRY_DELAYS_MS;
	let download: ChatGptWorkerCommandResult | undefined;
	let zipPath: string | undefined;
	for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
		if (attempt > 0) {
			const delay = retryDelays[attempt - 1] ?? 0;
			emit(options, `waiting ${Math.ceil(delay / 1000)}s for builder artifact before retry ${attempt + 1}`);
			await sleep(delay);
		}
		download = await runner({ action: "download_artifacts", conversationUrl, downloadDir, timeoutMs: 300_000 });
		await writeRunFile(
			state.runId,
			"responses",
			attempt === 0 ? "builder-download.json" : `builder-download-attempt-${attempt + 1}.json`,
			download.stdout || download.stderr,
		);
		if (!download.ok) throw new Error(`artifact download failed: ${download.stderr || download.stdout}`);
		zipPath = await selectNewestDownloadedZip(downloadDir, download.downloadedFiles ?? []);
		if (zipPath) break;
	}
	if (!zipPath) {
		const attempts = retryDelays.length + 1;
		throw new Error(
			`ChatGPT builder did not provide a downloadable .zip artifact after ${attempts} download attempt${
				attempts === 1 ? "" : "s"
			}`,
		);
	}
	const sha256 = await sha256File(zipPath);
	const entries = unzipSync(new Uint8Array(await Bun.file(zipPath).arrayBuffer()));
	const workspaceDir = path.join(runDir, "artifacts", "wiki-workspace");
	await fs.rm(workspaceDir, { recursive: true, force: true });
	await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
	const resolvedWorkspace = path.resolve(workspaceDir);
	for (const [entryName, bytes] of Object.entries(entries)) {
		if (entryName.endsWith("/")) continue;
		const target = path.resolve(workspaceDir, entryName);
		if (target !== resolvedWorkspace && !target.startsWith(`${resolvedWorkspace}${path.sep}`)) {
			throw new Error(`artifact zip contains unsafe path: ${entryName}`);
		}
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await Bun.write(target, bytes);
	}
	state.artifacts.push({ source: "builder", path: zipPath, sha256, validationStatus: "downloaded" });
	await writeRunState(state);
	return { zipPath, workspaceDir: await detectWorkspaceRoot(workspaceDir), sha256 };
}

async function selectNewestDownloadedZip(downloadDir: string, downloadedFiles: string[]): Promise<string | undefined> {
	const resolvedDownloadDir = path.resolve(downloadDir);
	const candidates: Array<{ path: string; mtimeMs: number }> = [];
	for (const relPath of downloadedFiles.filter(file => file.toLowerCase().endsWith(".zip"))) {
		const absolute = path.resolve(downloadDir, relPath);
		if (absolute !== resolvedDownloadDir && !absolute.startsWith(`${resolvedDownloadDir}${path.sep}`)) continue;
		const stat = await fs.stat(absolute).catch(() => undefined);
		if (stat?.isFile()) candidates.push({ path: absolute, mtimeMs: stat.mtimeMs });
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
	return candidates[0]?.path;
}

function missingZipArtifact(error: unknown): boolean {
	return error instanceof Error && error.message.includes("downloadable .zip artifact");
}

async function requestBuilderArtifactRepair(
	state: HarnessRunState,
	builderId: string | undefined,
	runner: WikiMachineWorkerRunner,
	error: string,
): Promise<string | undefined> {
	if (!builderId) throw new Error("cannot request builder artifact repair without a bound builder worker");
	await consumePromptBudget(state, "builder artifact repair");
	const prompt = wikiBuilderArtifactRepairPrompt(state.objective, error);
	await writeRunFile(state.runId, "prompts", "builder-artifact-repair.md", prompt);
	const handoffPath = path.join(getHarnessRunDir(state.runId), "artifacts", "handoffs", "builder-handoff.zip");
	const files = (await Bun.file(handoffPath).exists()) ? [handoffPath] : undefined;
	const send = await runner({
		action: "send",
		worker: builderId,
		prompt,
		files,
		modelOption: DEFAULT_CHATGPT_MODEL_OPTION,
		thinkingOption: DEFAULT_CHATGPT_THINKING_OPTION,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", "builder-artifact-repair-send.json", send.stdout || send.stderr);
	if (!send.ok) throw new Error(`failed to send builder artifact repair prompt: ${send.stderr || send.stdout}`);
	const repairMeta = await waitForWorker(
		state,
		"builder-artifact-repair",
		builderId,
		responseMeta(send.stdout),
		runner,
	);
	const conversationUrl = repairMeta.conversationUrl ?? responseMeta(send.stdout).conversationUrl;
	const copied = await runner({ action: "copy_message", conversationUrl, timeoutMs: 120_000 });
	await writeRunFile(state.runId, "responses", "builder-artifact-repair-copy.txt", copied.stdout || copied.stderr);
	await bindWorkerRole(state, "builder", {
		workerId: builderId,
		requestId: repairMeta.requestId ?? responseMeta(send.stdout).requestId,
		conversationUrl,
		modelOption: DEFAULT_CHATGPT_MODEL_OPTION,
		thinkingOption: DEFAULT_CHATGPT_THINKING_OPTION,
	});
	return conversationUrl;
}

async function requestBuilderValidationRepair(
	state: HarnessRunState,
	builderId: string | undefined,
	runner: WikiMachineWorkerRunner,
	error: string,
	files: string[],
): Promise<string | undefined> {
	if (!builderId) throw new Error("cannot request builder validation repair without a bound builder worker");
	await consumePromptBudget(state, "builder validation repair");
	const prompt = wikiBuilderValidationRepairPrompt(state.objective, error);
	await writeRunFile(state.runId, "prompts", "builder-validation-repair.md", prompt);
	const handoff = await createHandoffBundle(state, "builder", files);
	const send = await runner({
		action: "send",
		worker: builderId,
		prompt,
		files: [handoff],
		modelOption: DEFAULT_CHATGPT_MODEL_OPTION,
		thinkingOption: DEFAULT_CHATGPT_THINKING_OPTION,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", "builder-validation-repair-send.json", send.stdout || send.stderr);
	if (!send.ok) throw new Error(`failed to send builder validation repair prompt: ${send.stderr || send.stdout}`);
	const repairMeta = await waitForWorker(
		state,
		"builder-validation-repair",
		builderId,
		responseMeta(send.stdout),
		runner,
	);
	const conversationUrl = repairMeta.conversationUrl ?? responseMeta(send.stdout).conversationUrl;
	const copied = await runner({ action: "copy_message", conversationUrl, timeoutMs: 120_000 });
	await writeRunFile(state.runId, "responses", "builder-validation-repair-copy.txt", copied.stdout || copied.stderr);
	await bindWorkerRole(state, "builder", {
		workerId: builderId,
		requestId: repairMeta.requestId ?? responseMeta(send.stdout).requestId,
		conversationUrl,
		modelOption: DEFAULT_CHATGPT_MODEL_OPTION,
		thinkingOption: DEFAULT_CHATGPT_THINKING_OPTION,
	});
	return conversationUrl;
}

async function detectWorkspaceRoot(root: string): Promise<string> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	if (files.length === 0 && dirs.length === 1) return path.join(root, dirs[0].name);
	return root;
}

async function runValidation(
	state: HarnessRunState,
	workspaceDir: string,
	command: string | string[],
): Promise<{ ok: boolean; logPath: string; output: string; exitCode: number | null }> {
	const commandArgs =
		typeof command === "string"
			? process.platform === "win32"
				? ["powershell", "-NoProfile", "-Command", command]
				: ["sh", "-lc", command]
			: command;
	const commandLabel = typeof command === "string" ? command : command.join(" ");
	const proc = Bun.spawn(commandArgs, { cwd: workspaceDir, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${stdout}${stderr ? `\n${stderr}` : ""}`;
	const logPath = await writeRunFile(state.runId, "validation", "wiki-smoke-output.txt", output);
	state.validation.push({
		command: commandLabel,
		exitCode,
		logPath,
		status: exitCode === 0 ? "passed" : "failed",
		summary:
			exitCode === 0
				? "Declared wiki-machine smoke validation passed"
				: "Declared wiki-machine smoke validation failed",
	});
	await writeRunState(state);
	return { ok: exitCode === 0, logPath, output, exitCode };
}

async function validateWikiForRun(
	state: HarnessRunState,
	workspaceDir: string,
): Promise<AiWikiManifestValidation & { logPath: string }> {
	const result = await validateAiWikiManifest(workspaceDir);
	const logPath = await writeRunFile(
		state.runId,
		"validation",
		"ai-wiki-manifest.json",
		`${JSON.stringify(result, null, 2)}\n`,
	);
	state.validation.push({
		status: result.ok ? "passed" : "failed",
		logPath,
		summary: result.ok
			? "AI_WIKI_MANIFEST.json passed validation"
			: `AI_WIKI_MANIFEST.json failed validation: ${result.errors.join("; ")}`,
	});
	await writeRunState(state);
	return { ...result, logPath };
}

function selectValidationCommand(
	manifest: AiWikiManifestValidation | undefined,
	override?: string[],
): string | string[] {
	if (override) return override;
	if (manifest?.ok && manifest.manifest?.test_command) return manifest.manifest.test_command;
	return "npm test";
}

async function readRoleResponse(state: HarnessRunState, role: "architect" | "builder" | "critic"): Promise<string> {
	const runDir = getHarnessRunDir(state.runId);
	for (const name of [`${role}-copy.json`, `${role}-repair-copy.txt`, `${role}-copy.txt`]) {
		const filePath = path.join(runDir, "responses", name);
		if (await Bun.file(filePath).exists()) return (await Bun.file(filePath).text()).trim();
	}
	throw new Error(`missing saved ${role} response for resume`);
}

export async function runWikiMachineHarness(
	objective: string,
	options: WikiMachineOptions = {},
): Promise<HarnessRunState> {
	const state = await createHarnessRun(objective, {
		promptLimit: options.promptLimit ?? 10,
		template: "wiki-machine",
	});
	return await continueWikiMachineHarness(state, options);
}

export async function resumeWikiMachineHarness(
	runId: string,
	options: WikiMachineOptions = {},
): Promise<HarnessRunState> {
	const state = await readRunState(runId);
	if (state.template !== "wiki-machine") throw new Error(`run ${runId} is not a wiki-machine harness run`);
	if (state.status === "good_enough" || state.status === "abandoned") return state;
	if (options.promptLimit) state.promptBudget.limit = options.promptLimit;
	state.status = "active";
	await writeRunState(state);
	return await continueWikiMachineHarness(state, options);
}

async function continueWikiMachineHarness(
	state: HarnessRunState,
	options: WikiMachineOptions = {},
): Promise<HarnessRunState> {
	ensureHarnessGates(state);
	const cwd = options.cwd ?? process.cwd();
	const runner = options.workerRunner ?? runChatGptWorkerCommand;
	try {
		if (!gatePassed(state, "doctor") && options.checkDoctor !== false) {
			await startGate(state, "doctor", options);
			const doctor = await runHarnessDoctor({
				cwd,
				runner: options.doctorRunner,
				requireLive: true,
				requiredSkills: ["wiki-architect", "wiki-builder", "wiki-critic"],
			});
			const doctorPath = await writeRunFile(
				state.runId,
				"validation",
				"doctor.json",
				`${JSON.stringify(doctor, null, 2)}\n`,
			);
			if (!doctor.ok) {
				await failGate(state, "doctor", options, "harness doctor failed; fix blocking checks before live run", {
					outputPaths: [doctorPath],
				});
				throw new Error("harness doctor failed; fix blocking checks before live run");
			}
			await passGate(state, "doctor", options, { outputPaths: [doctorPath] });
		} else if (options.checkDoctor === false) {
			await skipGate(state, "doctor", options, "doctor disabled by test/options");
		}

		await setTodoStatus(state.runId, "define task", "completed");
		let packetDir = state.evidencePackets[0];
		if (!gatePassed(state, "blueprint_packet")) {
			await startGate(state, "blueprint_packet", options);
			const packet = await buildEvidencePacket({
				runId: state.runId,
				objective: state.objective,
				role: "wiki-architect",
				successCriteria: [
					"Architect returns omg.wiki.blueprint.v1 JSON.",
					"Builder returns workspace.zip plus omg.wiki.artifact.v1 JSON.",
					"Artifact contains AI_WIKI_MANIFEST.json and required wiki workspace contracts.",
					"Local smoke validation passes before good_enough.",
					"Critic returns omg.wiki.review.v1 JSON.",
				],
				constraints: [
					"Build a local proof workspace only; do not create real GitHub repositories.",
					"Do not require network access, paid APIs, secrets, Pages deployment, jsDelivr purge, or Cloudflare deployment.",
					"Use one handoff zip per ChatGPT prompt.",
				],
				files: options.files ?? [],
				cwd,
			});
			packetDir = packet.packetDir;
			state.evidencePackets = [packet.packetDir, ...state.evidencePackets.filter(item => item !== packet.packetDir)];
			await writeRunState(state);
			await passGate(state, "blueprint_packet", options, { outputPaths: [packet.packetDir] });
		}
		await setTodoStatus(state.runId, "build evidence packet", "completed");
		await writeWikiAcceptanceChecklist(packetDir);

		const architectSkill = await bundleChatGptSkill("wiki-architect", {
			cwd,
			outDir: path.join(getHarnessRunDir(state.runId), "artifacts", "skills"),
		});
		let blueprintText = "";
		if (gatePassed(state, "architect")) {
			blueprintText = await readRoleResponse(state, "architect");
		} else {
			await startGate(state, "architect", options);
			const architectId = await createWorker(state, "architect", runner, [architectSkill.zipPath]);
			const handoff = await createHandoffBundle(state, "architect", [
				architectSkill.zipPath,
				...(await listFiles(packetDir)),
			]);
			const architect = await sendAndCopy(
				state,
				"architect",
				architectId,
				wikiArchitectPrompt(state.objective),
				runner,
				{ files: [handoff], expectJson: true },
			);
			blueprintText = architect.copiedText;
			await passGate(state, "architect", options, {
				workerRole: "architect",
				workerId: architect.workerId,
				requestId: architect.requestId,
				conversationUrl: architect.conversationUrl,
				outputPaths: architect.responsePath ? [architect.responsePath] : undefined,
			});
		}

		await startGate(state, "contract", options);
		const blueprint = parseChatGptJsonEnvelope(blueprintText);
		if (!blueprint.ok || blueprint.value?.schema_version !== "omg.wiki.blueprint.v1") {
			await failGate(state, "contract", options, blueprint.error ?? "architect did not return wiki blueprint JSON");
			throw new Error("architect did not return valid omg.wiki.blueprint.v1 JSON");
		}
		await passGate(state, "contract", options, { summary: "wiki blueprint contract accepted" });
		await setTodoStatus(state.runId, "select skills/workers", "completed");
		await setTodoStatus(state.runId, "send worker prompts", "in_progress");

		const builderSkill = await bundleChatGptSkill("wiki-builder", {
			cwd,
			outDir: path.join(getHarnessRunDir(state.runId), "artifacts", "skills"),
		});
		let builderConversationUrl: string | undefined;
		if (gatePassed(state, "builder")) {
			builderConversationUrl = state.workers.find(worker => worker.role === "builder")?.conversationUrl;
		} else {
			await startGate(state, "builder", options);
			const builderId = await createWorker(state, "builder", runner, [builderSkill.zipPath]);
			const handoff = await createHandoffBundle(state, "builder", [
				builderSkill.zipPath,
				...(await listFiles(packetDir)),
				path.join(getHarnessRunDir(state.runId), "responses", "architect-copy.json"),
			]);
			const builder = await sendAndCopy(
				state,
				"builder",
				builderId,
				wikiBuilderPrompt(state.objective, blueprintText),
				runner,
				{ files: [handoff], preferJson: true },
			);
			builderConversationUrl = builder.conversationUrl;
			await passGate(state, "builder", options, {
				workerRole: "builder",
				workerId: builder.workerId,
				requestId: builder.requestId,
				conversationUrl: builder.conversationUrl,
				outputPaths: builder.responsePath ? [builder.responsePath] : undefined,
			});
		}

		await startGate(state, "download", options);
		let artifact: Awaited<ReturnType<typeof downloadAndUnpackArtifact>>;
		try {
			artifact = await downloadAndUnpackArtifact(state, builderConversationUrl, runner, options);
		} catch (error) {
			if (!missingZipArtifact(error) || state.promptBudget.used >= state.promptBudget.limit) throw error;
			emit(options, "builder artifact missing; requesting one controlled repair prompt");
			const builderId = state.workers.find(worker => worker.role === "builder")?.workerId;
			builderConversationUrl = await requestBuilderArtifactRepair(
				state,
				builderId,
				runner,
				error instanceof Error ? error.message : String(error),
			);
			artifact = await downloadAndUnpackArtifact(state, builderConversationUrl, runner, options);
		}
		await passGate(state, "download", options, {
			outputPaths: [artifact.zipPath],
			summary: "wiki workspace artifact downloaded",
		});

		await startGate(state, "wiki_manifest", options);
		let manifest = await validateWikiForRun(state, artifact.workspaceDir);
		if (!manifest.ok && state.promptBudget.used < state.promptBudget.limit) {
			await failGate(state, "wiki_manifest", options, manifest.errors.join("; "), {
				outputPaths: [manifest.logPath],
			});
			emit(options, "wiki manifest failed; requesting one controlled builder validation repair prompt");
			const builderId = state.workers.find(worker => worker.role === "builder")?.workerId;
			builderConversationUrl = await requestBuilderValidationRepair(
				state,
				builderId,
				runner,
				manifest.errors.join("; "),
				[builderSkill.zipPath, artifact.zipPath, manifest.logPath, ...(await listFiles(packetDir))],
			);
			await startGate(state, "download", options);
			artifact = await downloadAndUnpackArtifact(state, builderConversationUrl, runner, options);
			await passGate(state, "download", options, {
				outputPaths: [artifact.zipPath],
				summary: "replacement wiki workspace artifact downloaded",
			});
			await startGate(state, "wiki_manifest", options);
			manifest = await validateWikiForRun(state, artifact.workspaceDir);
		}
		if (manifest.ok) await passGate(state, "wiki_manifest", options, { outputPaths: [manifest.logPath] });
		else {
			await failGate(state, "wiki_manifest", options, manifest.errors.join("; "), {
				outputPaths: [manifest.logPath],
			});
			throw new Error(`AI wiki manifest validation failed: ${manifest.errors.join("; ")}`);
		}

		await startGate(state, "smoke_validate", options);
		const validationCommand = selectValidationCommand(manifest, options.testCommand);
		const validation = await runValidation(state, artifact.workspaceDir, validationCommand);
		if (validation.ok) await passGate(state, "smoke_validate", options, { outputPaths: [validation.logPath] });
		else {
			await failGate(state, "smoke_validate", options, "Declared wiki-machine smoke validation failed", {
				outputPaths: [validation.logPath],
			});
		}
		await setTodoStatus(state.runId, "validate locally", validation.ok ? "completed" : "blocked");

		const criticSkill = await bundleChatGptSkill("wiki-critic", {
			cwd,
			outDir: path.join(getHarnessRunDir(state.runId), "artifacts", "skills"),
		});
		let criticText = "";
		if (gatePassed(state, "critic")) {
			criticText = await readRoleResponse(state, "critic");
		} else {
			await startGate(state, "critic", options);
			const criticId = await createWorker(state, "critic", runner, [criticSkill.zipPath]);
			const handoff = await createHandoffBundle(state, "critic", [
				artifact.zipPath,
				validation.logPath,
				manifest.logPath,
				criticSkill.zipPath,
				...(await listFiles(packetDir)),
			]);
			const critic = await sendAndCopy(
				state,
				"critic",
				criticId,
				wikiCriticPrompt(state.objective, validation.output, artifact.sha256),
				runner,
				{ files: [handoff], expectJson: true },
			);
			criticText = critic.copiedText;
			await passGate(state, "critic", options, {
				workerRole: "critic",
				workerId: critic.workerId,
				requestId: critic.requestId,
				conversationUrl: critic.conversationUrl,
				outputPaths: critic.responsePath ? [critic.responsePath] : undefined,
			});
		}

		const review = parseChatGptJsonEnvelope(criticText);
		const approved =
			review.ok &&
			review.value?.schema_version === "omg.wiki.review.v1" &&
			(review.value as WikiReviewEnvelope).approved === true &&
			validation.ok &&
			manifest.ok;
		if (review.ok && review.value?.schema_version === "omg.wiki.review.v1") {
			const criticReview = review.value as WikiReviewEnvelope;
			state.reviewerFindings = [
				...criticReview.blocking_findings.map(item => String(item)),
				...criticReview.non_blocking_findings.map(item => String(item)),
			];
		}
		state.status = approved ? "good_enough" : "not_good_enough";
		state.verdict = approved ? "good_enough" : "not_good_enough";
		await setTodoStatus(state.runId, "review", "completed");
		await startGate(state, "report", options);
		await setTodoStatus(state.runId, "report", "completed");
		await writeRunState(state);
		await passGate(state, "report", options, {
			outputPaths: [path.join(getHarnessRunDir(state.runId), "report.md")],
		});
		await writeReport(state);
		return state;
	} catch (error) {
		state.status = "blocked";
		state.verdict = "blocked";
		state.validation.push({ status: "failed", summary: error instanceof Error ? error.message : String(error) });
		await writeRunState(state);
		await writeReport(state);
		throw error;
	}
}
