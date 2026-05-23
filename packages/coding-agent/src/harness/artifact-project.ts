import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { type ProjectManifestValidation, validateProjectManifest } from "./artifact-manifest";
import { type ChatGptWorkerCommand, type ChatGptWorkerCommandResult, runChatGptWorkerCommand } from "./chatgpt-cli";
import { type HarnessCommandRunner, runHarnessDoctor } from "./doctor";
import { buildEvidencePacket } from "./evidence-packet";
import { parseChatGptJsonEnvelope } from "./json-contracts";
import { builderPrompt, criticPrompt, fixerPrompt, plannerPrompt } from "./prompt-templates";
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
import type { ArtifactEnvelope, CriticEnvelope, HarnessGateId, HarnessRunState } from "./types";

export type ChatGptWorkerRunner = (input: ChatGptWorkerCommand) => Promise<ChatGptWorkerCommandResult>;

interface ArtifactProjectOptions {
	cwd?: string;
	promptLimit?: number;
	files?: string[];
	checkDoctor?: boolean;
	doctorRunner?: HarnessCommandRunner;
	workerRunner?: ChatGptWorkerRunner;
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

const DEFAULT_TEST_COMMAND = "python -m unittest discover -s tests";
const DEFAULT_CHATGPT_MODEL_OPTION = "Thinking";
const DEFAULT_CHATGPT_THINKING_OPTION = "Standard";
const FALLBACK_CHATGPT_MODEL_OPTION = "Pro";

function shortRunId(runId: string): string {
	return runId.split("-").at(-1)?.slice(0, 8) ?? runId.slice(0, 8);
}

function emit(options: ArtifactProjectOptions, message: string): void {
	options.onEvent?.(message);
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

function workerIsGenerating(raw: string): boolean | undefined {
	const parsed = safeJson(raw);
	return typeof parsed?.is_generating === "boolean" ? parsed.is_generating : undefined;
}

async function sleep(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256File(filePath: string): Promise<string> {
	const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function listPacketFiles(packetDir: string): Promise<string[]> {
	const names = [
		"TASK.md",
		"CONSTRAINTS.md",
		"VALIDATION.md",
		"EXPECTED_OUTPUT.schema.json",
		"PROJECT_MANIFEST.schema.json",
		"validate_response.py",
		"SUMMARY.json",
		"REPO_SLICE.zip",
	];
	const files: string[] = [];
	for (const name of names) {
		const filePath = path.join(packetDir, name);
		if (await Bun.file(filePath).exists()) files.push(filePath);
	}
	const schemaDir = path.join(packetDir, "schemas");
	const schemaNames = await fs.readdir(schemaDir).catch(() => []);
	for (const schemaName of schemaNames.sort()) {
		const filePath = path.join(schemaDir, schemaName);
		if ((await fs.stat(filePath).catch(() => null))?.isFile()) files.push(filePath);
	}
	return files;
}

async function createHandoffBundle(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
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
		let entryName: string;
		if (packetRoot && (absolute === packetRoot || absolute.startsWith(`${packetRoot}${path.sep}`))) {
			entryName = `packet/${path.relative(packetRoot, absolute).replace(/\\/g, "/")}`;
		} else if (absolute.endsWith(".oai.zip")) {
			entryName = `skills/${path.basename(absolute)}`;
		} else if (absolute.endsWith(".zip")) {
			entryName = `artifacts/${path.basename(absolute)}`;
		} else if (absolute.includes(`${path.sep}validation${path.sep}`)) {
			entryName = `validation/${path.basename(absolute)}`;
		} else {
			entryName = `files/${path.basename(absolute)}`;
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

	const manifest = {
		role,
		created_at: new Date().toISOString(),
		instructions: [
			"Unzip this handoff archive before working.",
			"Read packet/TASK.md, packet/CONSTRAINTS.md, packet/EXPECTED_OUTPUT.schema.json, and packet/PROJECT_MANIFEST.schema.json.",
			"Validate response JSON with: python packet/validate_response.py response.json",
			"Attach the required response JSON file and any requested artifact after validation.",
		],
		entries: Object.keys(entries).sort(),
	};
	entries["HANDOFF_MANIFEST.json"] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
	const bundlePath = path.join(outDir, `${role}-handoff.zip`);
	await Bun.write(bundlePath, zipSync(entries));
	return bundlePath;
}

async function createWorker(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
	runner: ChatGptWorkerRunner,
	skillBundles: string[] = [],
): Promise<string> {
	const existing = state.workers.find(worker => worker.role === role)?.workerId;
	if (existing) return existing;
	const result = await runner({
		action: "create",
		extraArgs: ["--count", "1", "--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-create.json`, result.stdout || result.stderr);
	if (!result.ok) throw new Error(`failed to create ${role} worker: ${result.stderr || result.stdout}`);
	const workerId = firstWorkerId(result.stdout);
	if (!workerId) throw new Error(`failed to parse ${role} worker id from ChatGPT create output`);
	const title = `OMG ${shortRunId(state.runId)} ${role} ${workerId}`;
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

async function consumePromptBudget(state: HarnessRunState, role: string): Promise<void> {
	if (state.promptBudget.used >= state.promptBudget.limit) {
		throw new Error(`prompt budget exhausted before ${role} prompt`);
	}
	state.promptBudget.used += 1;
	await writeRunState(state);
}

function gatePassed(state: HarnessRunState, id: HarnessGateId): boolean {
	return ensureHarnessGates(state).find(gate => gate.id === id)?.status === "passed";
}

function gateStatus(state: HarnessRunState, id: HarnessGateId): string | undefined {
	return ensureHarnessGates(state).find(gate => gate.id === id)?.status;
}

async function startGate(state: HarnessRunState, id: HarnessGateId, options: ArtifactProjectOptions): Promise<void> {
	emit(options, `running ${id}`);
	await setGateStatus(state, id, "running");
}

async function passGate(
	state: HarnessRunState,
	id: HarnessGateId,
	options: ArtifactProjectOptions,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `passed ${id}`);
	await setGateStatus(state, id, "passed", fields);
}

async function failGate(
	state: HarnessRunState,
	id: HarnessGateId,
	options: ArtifactProjectOptions,
	error: string,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `failed ${id}: ${error}`);
	await setGateStatus(state, id, "failed", { ...fields, error });
}

async function skipGate(
	state: HarnessRunState,
	id: HarnessGateId,
	options: ArtifactProjectOptions,
	summary: string,
): Promise<void> {
	emit(options, `skipped ${id}: ${summary}`);
	await setGateStatus(state, id, "skipped", { summary });
}

async function sendAndCopy(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
	workerId: string,
	prompt: string,
	runner: ChatGptWorkerRunner,
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
	const watched = await waitForWorkerReady(state, role, workerId, sent, runner);
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
	const copied = await runner({
		action: "copy_message",
		conversationUrl,
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-copy.txt`, copied.stdout || copied.stderr);
	if (!copied.ok) throw new Error(`failed to copy ${role} worker response: ${copied.stderr || copied.stdout}`);
	const jsonValidation = parseChatGptJsonEnvelope(copied.stdout.trim());
	if (options.expectJson && !jsonValidation.ok) {
		return await repairJsonResponse(
			state,
			role,
			workerId,
			conversationUrl,
			watched.requestId ?? sent.requestId,
			runner,
			options,
		);
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

async function downloadJsonResponse(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
	conversationUrl: string | undefined,
	runner: ChatGptWorkerRunner,
): Promise<{ path: string; text: string } | undefined> {
	if (!conversationUrl) return undefined;
	const runDir = getHarnessRunDir(state.runId);
	const downloadDir = path.join(runDir, "responses", `${role}-json-artifacts`);
	await fs.rm(downloadDir, { recursive: true, force: true });
	await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
	const download = await runner({
		action: "download_artifacts",
		conversationUrl,
		downloadDir,
		timeoutMs: 180_000,
	});
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
		if (absolute !== path.resolve(downloadDir) && !absolute.startsWith(`${path.resolve(downloadDir)}${path.sep}`)) {
			continue;
		}
		const text = (await Bun.file(absolute).text()).trim();
		const parsed = parseChatGptJsonEnvelope(text);
		if (!parsed.ok) {
			await writeRunFile(
				state.runId,
				"responses",
				`${role}-json-artifact-invalid.txt`,
				`${relPath}: ${parsed.error ?? "invalid JSON envelope"}\n`,
			);
			continue;
		}
		const copiedPath = await writeRunFile(state.runId, "responses", `${role}-copy.json`, `${text}\n`);
		return { path: copiedPath, text };
	}
	return undefined;
}

async function waitForWorkerReady(
	state: HarnessRunState,
	role: string,
	workerId: string,
	sent: { requestId?: string; conversationUrl?: string },
	runner: ChatGptWorkerRunner,
): Promise<{ requestId?: string; conversationUrl?: string }> {
	const deadline = Date.now() + 600_000;
	let lastMeta = sent;
	while (Date.now() < deadline) {
		const status = await runner({
			action: "status",
			worker: workerId,
			extraArgs: ["--json"],
			timeoutMs: 120_000,
		});
		await writeRunFile(state.runId, "responses", `${role}-status.json`, status.stdout || status.stderr);
		if (status.ok) {
			lastMeta = { ...lastMeta, ...responseMeta(status.stdout) };
			if (workerIsGenerating(status.stdout) !== true) return lastMeta;
		}
		await sleep(5_000);
	}

	const watch = await runner({
		action: "watch",
		worker: workerId,
		extraArgs: ["--until-complete", "--json", "--timeout", "120"],
		timeoutMs: 150_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-watch.json`, watch.stdout || watch.stderr);
	if (!watch.ok) throw new Error(`failed to watch ${role} worker: ${watch.stderr || watch.stdout}`);
	return { ...lastMeta, ...responseMeta(watch.stdout) };
}

async function workerStatusMeta(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
	workerId: string,
	runner: ChatGptWorkerRunner,
): Promise<{ ready: boolean; requestId?: string; conversationUrl?: string }> {
	const status = await runner({
		action: "status",
		worker: workerId,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-status.json`, status.stdout || status.stderr);
	if (!status.ok) return { ready: false };
	return {
		ready: workerIsGenerating(status.stdout) === false,
		...responseMeta(status.stdout),
	};
}

async function recoverCompletedBuilder(
	state: HarnessRunState,
	runner: ChatGptWorkerRunner,
	options: ArtifactProjectOptions,
): Promise<WorkerExchange | undefined> {
	if (gateStatus(state, "builder") !== "running") return undefined;
	const builder = state.workers.find(worker => worker.role === "builder" && worker.workerId);
	if (!builder?.workerId) return undefined;
	const meta = await workerStatusMeta(state, "builder", builder.workerId, runner);
	if (!meta.ready || !meta.conversationUrl) return undefined;
	const artifactJson = await downloadJsonResponse(state, "builder", meta.conversationUrl, runner);
	const copiedText =
		artifactJson?.text ??
		((await Bun.file(path.join(getHarnessRunDir(state.runId), "responses", "builder-copy.txt")).exists())
			? (await Bun.file(path.join(getHarnessRunDir(state.runId), "responses", "builder-copy.txt")).text()).trim()
			: "");
	if (!artifactJson && !copiedText) return undefined;
	await bindWorkerRole(state, "builder", {
		workerId: builder.workerId,
		requestId: meta.requestId ?? builder.requestId,
		conversationUrl: meta.conversationUrl,
		skillBundles: builder.skillBundles,
	});
	await passGate(state, "builder", options, {
		workerRole: "builder",
		workerId: builder.workerId,
		requestId: meta.requestId ?? builder.requestId,
		conversationUrl: meta.conversationUrl,
		outputPaths: artifactJson?.path ? [artifactJson.path] : undefined,
		summary: "Recovered completed builder worker during resume",
	});
	return {
		workerId: builder.workerId,
		requestId: meta.requestId ?? builder.requestId,
		conversationUrl: meta.conversationUrl,
		copiedText,
		responsePath: artifactJson?.path,
	};
}

async function repairJsonResponse(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
	workerId: string,
	conversationUrl: string | undefined,
	requestId: string | undefined,
	runner: ChatGptWorkerRunner,
	options: { skills?: string[] },
): Promise<WorkerExchange> {
	const invalid = await runner({
		action: "copy_message",
		conversationUrl,
		timeoutMs: 120_000,
	});
	const validation = parseChatGptJsonEnvelope(invalid.stdout.trim());
	const repairPrompt =
		`Your previous response failed OMG JSON validation: ${validation.error ?? "unknown schema error"}\n\n` +
		"Re-emit the same answer as JSON only, with no Markdown fence, commentary, or surrounding text.\n" +
		"For omg.handoff.v1 include exactly these top-level keys: schema_version, role, status, summary, confidence, assumptions, findings, next_action, artifacts, patches, requested_context.\n" +
		"For omg.review.v1 include exactly these top-level keys: schema_version, approved, blocking_findings, non_blocking_findings, required_fixes, verdict.";
	await writeRunFile(state.runId, "prompts", `${role}-repair.md`, repairPrompt);
	await consumePromptBudget(state, `${role} repair`);
	let modelOption = DEFAULT_CHATGPT_MODEL_OPTION;
	let thinkingOption = DEFAULT_CHATGPT_THINKING_OPTION;
	let repairSend = await runner({
		action: "send",
		worker: workerId,
		prompt: repairPrompt,
		modelOption,
		thinkingOption,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", `${role}-repair-send.json`, repairSend.stdout || repairSend.stderr);
	if (!repairSend.ok && modelSelectionFailed(repairSend)) {
		modelOption = FALLBACK_CHATGPT_MODEL_OPTION;
		thinkingOption = DEFAULT_CHATGPT_THINKING_OPTION;
		repairSend = await runner({
			action: "send",
			worker: workerId,
			prompt: repairPrompt,
			modelOption,
			thinkingOption,
			extraArgs: ["--json"],
			timeoutMs: 120_000,
		});
		await writeRunFile(
			state.runId,
			"responses",
			`${role}-repair-send-fallback.json`,
			repairSend.stdout || repairSend.stderr,
		);
	}
	if (!repairSend.ok)
		throw new Error(`failed to send ${role} JSON repair prompt: ${repairSend.stderr || repairSend.stdout}`);
	const repairMeta = await waitForWorkerReady(
		state,
		`${role}-repair`,
		workerId,
		responseMeta(repairSend.stdout),
		runner,
	);
	const repairedArtifact = await downloadJsonResponse(
		state,
		role,
		repairMeta.conversationUrl ?? conversationUrl,
		runner,
	);
	if (repairedArtifact) {
		await bindWorkerRole(state, role, {
			workerId,
			requestId: repairMeta.requestId ?? requestId,
			conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
			modelOption,
			thinkingOption,
			skillBundles: options.skills,
		});
		return {
			workerId,
			requestId: repairMeta.requestId ?? requestId,
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
	await writeRunFile(state.runId, "responses", `${role}-repair-copy.txt`, repairCopied.stdout || repairCopied.stderr);
	if (!repairCopied.ok)
		throw new Error(`failed to copy ${role} JSON repair: ${repairCopied.stderr || repairCopied.stdout}`);
	if (!parseChatGptJsonEnvelope(repairCopied.stdout.trim()).ok) {
		throw new Error(`${role} worker did not return a valid OMG JSON envelope after one repair attempt`);
	}
	await bindWorkerRole(state, role, {
		workerId,
		requestId: repairMeta.requestId ?? requestId,
		conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
		modelOption,
		thinkingOption,
		skillBundles: options.skills,
	});
	return {
		workerId,
		requestId: repairMeta.requestId ?? requestId,
		conversationUrl: repairMeta.conversationUrl ?? conversationUrl,
		copiedText: repairCopied.stdout.trim(),
	};
}

async function downloadAndUnpackArtifact(
	state: HarnessRunState,
	conversationUrl: string | undefined,
	runner: ChatGptWorkerRunner,
	source: "builder" | "fixer" = "builder",
): Promise<{ zipPath: string; workspaceDir: string; sha256: string }> {
	const runDir = getHarnessRunDir(state.runId);
	const downloadDir = path.join(runDir, "artifacts", "downloads");
	await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
	const download = await runner({
		action: "download_artifacts",
		conversationUrl,
		downloadDir,
		timeoutMs: 300_000,
	});
	await writeRunFile(state.runId, "responses", `${source}-download.json`, download.stdout || download.stderr);
	if (!download.ok) throw new Error(`artifact download failed: ${download.stderr || download.stdout}`);
	const zipRel = download.downloadedFiles?.find(file => file.toLowerCase().endsWith(".zip"));
	if (!zipRel) throw new Error("ChatGPT builder did not provide a downloadable .zip artifact");

	const zipPath = path.join(downloadDir, zipRel);
	const sha256 = await sha256File(zipPath);
	const entries = unzipSync(new Uint8Array(await Bun.file(zipPath).arrayBuffer()));
	const workspaceDir = path.join(runDir, "artifacts", "workspace");
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

	state.artifacts.push({ source, path: zipPath, sha256, validationStatus: "downloaded" });
	await writeRunState(state);
	return { zipPath, workspaceDir: await detectWorkspaceRoot(workspaceDir), sha256 };
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
	const proc = Bun.spawn(commandArgs, {
		cwd: workspaceDir,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...Bun.env, PYTHONPATH: path.join(workspaceDir, "src") },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${stdout}${stderr ? `\n${stderr}` : ""}`;
	const logPath = await writeRunFile(state.runId, "validation", "test-output.txt", output);
	state.validation.push({
		command: commandLabel,
		exitCode,
		logPath,
		status: exitCode === 0 ? "passed" : "failed",
		summary: exitCode === 0 ? "Declared artifact-project tests passed" : "Declared artifact-project tests failed",
	});
	await writeRunState(state);
	return { ok: exitCode === 0, logPath, output, exitCode };
}

async function validateManifestForRun(
	state: HarnessRunState,
	workspaceDir: string,
): Promise<ProjectManifestValidation & { logPath: string }> {
	const result = await validateProjectManifest(workspaceDir);
	const logPath = await writeRunFile(
		state.runId,
		"validation",
		"manifest.json",
		`${JSON.stringify(result, null, 2)}\n`,
	);
	state.validation.push({
		status: result.ok ? "passed" : "failed",
		logPath,
		summary: result.ok
			? "PROJECT_MANIFEST.json passed validation"
			: `PROJECT_MANIFEST.json failed validation: ${result.errors.join("; ")}`,
	});
	await writeRunState(state);
	return { ...result, logPath };
}

function selectValidationCommand(
	builderText: string,
	manifest: ProjectManifestValidation | undefined,
	override?: string[],
): string | string[] {
	if (override) return override;
	if (manifest?.ok && manifest.manifest?.test_command) return manifest.manifest.test_command;
	const parsed = parseChatGptJsonEnvelope(builderText);
	if (parsed.ok && parsed.value?.schema_version === "omg.artifact.v1") {
		const artifact = parsed.value as ArtifactEnvelope;
		const command = artifact.test_commands.find(item => item.trim().length > 0);
		if (command) return command;
	}
	return DEFAULT_TEST_COMMAND;
}

export async function runArtifactProjectHarness(
	objective: string,
	options: ArtifactProjectOptions = {},
): Promise<HarnessRunState> {
	const state = await createHarnessRun(objective, {
		promptLimit: options.promptLimit ?? 10,
		template: "artifact-project",
	});
	return await continueArtifactProjectHarness(state, options);
}

export async function resumeArtifactProjectHarness(
	runId: string,
	options: ArtifactProjectOptions = {},
): Promise<HarnessRunState> {
	const state = await readRunState(runId);
	if (state.template !== "artifact-project") {
		throw new Error(`run ${runId} is not an artifact-project harness run`);
	}
	if (state.status === "good_enough" || state.status === "abandoned") return state;
	if (options.promptLimit) state.promptBudget.limit = options.promptLimit;
	state.status = "active";
	await writeRunState(state);
	return await continueArtifactProjectHarness(state, options);
}

async function ensureDownloadedArtifact(
	state: HarnessRunState,
	conversationUrl: string | undefined,
	runner: ChatGptWorkerRunner,
	options: ArtifactProjectOptions,
	source: "builder" | "fixer" = "builder",
): Promise<{ zipPath: string; workspaceDir: string; sha256: string }> {
	if (gatePassed(state, "download")) {
		const artifact = state.artifacts.at(-1);
		if (artifact?.path && (await Bun.file(artifact.path).exists())) {
			return {
				zipPath: artifact.path,
				workspaceDir: await detectWorkspaceRoot(path.join(getHarnessRunDir(state.runId), "artifacts", "workspace")),
				sha256: artifact.sha256 ?? "",
			};
		}
	}
	await startGate(state, "download", options);
	const artifact = await downloadAndUnpackArtifact(state, conversationUrl, runner, source);
	await passGate(state, "download", options, {
		outputPaths: [artifact.zipPath],
		summary: `${source} artifact downloaded`,
	});
	return artifact;
}

async function ensureValidManifest(
	state: HarnessRunState,
	workspaceDir: string,
	options: ArtifactProjectOptions,
): Promise<ProjectManifestValidation & { logPath: string }> {
	if (gatePassed(state, "manifest")) {
		const logPath = path.join(getHarnessRunDir(state.runId), "validation", "manifest.json");
		if (await Bun.file(logPath).exists()) {
			const saved = JSON.parse(await Bun.file(logPath).text()) as ProjectManifestValidation;
			return { ...saved, logPath };
		}
	}
	await startGate(state, "manifest", options);
	const manifest = await validateManifestForRun(state, workspaceDir);
	if (manifest.ok) await passGate(state, "manifest", options, { outputPaths: [manifest.logPath] });
	else await failGate(state, "manifest", options, manifest.errors.join("; "), { outputPaths: [manifest.logPath] });
	return manifest;
}

async function runFixerOnce(
	state: HarnessRunState,
	artifact: { zipPath: string; workspaceDir: string; sha256: string },
	failureSummary: string,
	builderSkillPath: string,
	runner: ChatGptWorkerRunner,
	options: ArtifactProjectOptions,
): Promise<{ zipPath: string; workspaceDir: string; sha256: string }> {
	if (gatePassed(state, "fixer")) {
		return await ensureDownloadedArtifact(
			state,
			state.workers.find(worker => worker.role === "fixer")?.conversationUrl,
			runner,
			options,
			"fixer",
		);
	}
	await startGate(state, "fixer", options);
	const fixerId = await createWorker(state, "fixer", runner, [builderSkillPath]);
	const failurePath = await writeRunFile(state.runId, "validation", "fixer-input.txt", failureSummary);
	const fixerHandoff = await createHandoffBundle(state, "fixer", [
		artifact.zipPath,
		failurePath,
		builderSkillPath,
		...(await listPacketFiles(state.evidencePackets[0])),
	]);
	const fixer = await sendAndCopy(state, "fixer", fixerId, fixerPrompt(state.objective, failureSummary), runner, {
		files: [fixerHandoff],
		preferJson: true,
	});
	await passGate(state, "fixer", options, {
		workerRole: "fixer",
		workerId: fixer.workerId,
		requestId: fixer.requestId,
		conversationUrl: fixer.conversationUrl,
	});
	await setGateStatus(state, "download", "pending", { summary: "replacement artifact required after fixer" });
	await setGateStatus(state, "manifest", "pending", { summary: "replacement manifest required after fixer" });
	await setGateStatus(state, "validate", "pending", { summary: "replacement validation required after fixer" });
	return await ensureDownloadedArtifact(state, fixer.conversationUrl, runner, options, "fixer");
}

async function readRoleResponse(
	state: HarnessRunState,
	role: "planner" | "builder" | "critic" | "fixer",
): Promise<string> {
	const runDir = getHarnessRunDir(state.runId);
	for (const name of [`${role}-copy.json`, `${role}-repair-copy.txt`, `${role}-copy.txt`]) {
		const filePath = path.join(runDir, "responses", name);
		if (await Bun.file(filePath).exists()) return (await Bun.file(filePath).text()).trim();
	}
	throw new Error(`missing saved ${role} response for resume`);
}

async function continueArtifactProjectHarness(
	state: HarnessRunState,
	options: ArtifactProjectOptions = {},
): Promise<HarnessRunState> {
	ensureHarnessGates(state);
	const cwd = options.cwd ?? process.cwd();
	const runner = options.workerRunner ?? runChatGptWorkerCommand;
	try {
		if (!gatePassed(state, "doctor") && options.checkDoctor !== false) {
			await startGate(state, "doctor", options);
			const doctor = await runHarnessDoctor({ cwd, runner: options.doctorRunner, requireLive: true });
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
		if (!gatePassed(state, "packet")) {
			await startGate(state, "packet", options);
			const packet = await buildEvidencePacket({
				runId: state.runId,
				objective: state.objective,
				role: "planner",
				successCriteria: [
					"Planner returns omg.handoff.v1 JSON.",
					"Builder returns a downloadable workspace.zip with PROJECT_MANIFEST.json.",
					"Critic returns omg.review.v1 JSON.",
					"Local validation passes before good_enough.",
				],
				files: options.files ?? [],
				cwd,
			});
			packetDir = packet.packetDir;
			state.evidencePackets = [packet.packetDir, ...state.evidencePackets.filter(item => item !== packet.packetDir)];
			await writeRunState(state);
			await passGate(state, "packet", options, { outputPaths: [packet.packetDir] });
		}
		await setTodoStatus(state.runId, "build evidence packet", "completed");

		let plannerText = "";
		if (gatePassed(state, "planner")) {
			plannerText = await readRoleResponse(state, "planner");
		} else {
			await startGate(state, "planner", options);
			const plannerId = await createWorker(state, "planner", runner);
			const plannerHandoff = await createHandoffBundle(state, "planner", await listPacketFiles(packetDir));
			const planner = await sendAndCopy(state, "planner", plannerId, plannerPrompt(state.objective), runner, {
				files: [plannerHandoff],
				expectJson: true,
			});
			plannerText = planner.copiedText;
			await passGate(state, "planner", options, {
				workerRole: "planner",
				workerId: planner.workerId,
				requestId: planner.requestId,
				conversationUrl: planner.conversationUrl,
				outputPaths: [
					planner.responsePath ?? path.join(getHarnessRunDir(state.runId), "responses", "planner-copy.txt"),
				],
			});
		}
		await setTodoStatus(state.runId, "select skills/workers", "completed");
		await setTodoStatus(state.runId, "send worker prompts", "in_progress");

		const builderSkill = await bundleChatGptSkill("artifact-builder", {
			cwd,
			outDir: path.join(getHarnessRunDir(state.runId), "artifacts", "skills"),
		});

		let builderText = "";
		let builderConversationUrl: string | undefined;
		if (gatePassed(state, "builder")) {
			builderText = await readRoleResponse(state, "builder");
			builderConversationUrl = state.workers.find(worker => worker.role === "builder")?.conversationUrl;
		} else {
			const recovered = await recoverCompletedBuilder(state, runner, options);
			if (recovered) {
				builderText = recovered.copiedText;
				builderConversationUrl = recovered.conversationUrl;
			} else {
				await startGate(state, "builder", options);
				const builderId = await createWorker(state, "builder", runner, [builderSkill.zipPath]);
				const builderHandoff = await createHandoffBundle(state, "builder", [
					...(await listPacketFiles(packetDir)),
					builderSkill.zipPath,
				]);
				const builder = await sendAndCopy(
					state,
					"builder",
					builderId,
					builderPrompt(state.objective, plannerText),
					runner,
					{
						files: [builderHandoff],
						preferJson: true,
					},
				);
				builderText = builder.copiedText;
				builderConversationUrl = builder.conversationUrl;
				await passGate(state, "builder", options, {
					workerRole: "builder",
					workerId: builder.workerId,
					requestId: builder.requestId,
					conversationUrl: builder.conversationUrl,
					outputPaths: builder.responsePath ? [builder.responsePath] : undefined,
				});
			}
		}

		let artifact = await ensureDownloadedArtifact(state, builderConversationUrl, runner, options);
		let manifest = await ensureValidManifest(state, artifact.workspaceDir, options);
		let validation:
			| {
					ok: boolean;
					logPath: string;
					output: string;
					exitCode: number | null;
			  }
			| undefined;

		if (!manifest.ok) {
			artifact = await runFixerOnce(
				state,
				artifact,
				manifest.errors.join("; "),
				builderSkill.zipPath,
				runner,
				options,
			);
			builderText = await readRoleResponse(state, "fixer");
			manifest = await ensureValidManifest(state, artifact.workspaceDir, options);
		}

		if (manifest.ok) {
			if (!gatePassed(state, "validate")) {
				await startGate(state, "validate", options);
				const validationCommand = selectValidationCommand(builderText, manifest, options.testCommand);
				validation = await runValidation(state, artifact.workspaceDir, validationCommand);
				if (validation.ok) await passGate(state, "validate", options, { outputPaths: [validation.logPath] });
				else
					await failGate(state, "validate", options, "Declared artifact-project tests failed", {
						outputPaths: [validation.logPath],
					});
			} else {
				const last = state.validation.findLast(item => item.command && item.logPath);
				validation = {
					ok: last?.status === "passed",
					logPath: last?.logPath ?? "",
					output:
						last?.logPath && (await Bun.file(last.logPath).exists()) ? await Bun.file(last.logPath).text() : "",
					exitCode: last?.exitCode ?? null,
				};
			}
		}

		if (manifest.ok && validation && !validation.ok) {
			artifact = await runFixerOnce(state, artifact, validation.output, builderSkill.zipPath, runner, options);
			builderText = await readRoleResponse(state, "fixer");
			manifest = await ensureValidManifest(state, artifact.workspaceDir, options);
			if (manifest.ok) {
				await startGate(state, "validate", options);
				const fixerValidationCommand = selectValidationCommand(builderText, manifest, options.testCommand);
				validation = await runValidation(state, artifact.workspaceDir, fixerValidationCommand);
				if (validation.ok) await passGate(state, "validate", options, { outputPaths: [validation.logPath] });
				else
					await failGate(state, "validate", options, "Declared artifact-project tests failed after fixer", {
						outputPaths: [validation.logPath],
					});
			}
		}

		await setTodoStatus(state.runId, "validate locally", validation?.ok ? "completed" : "blocked");

		const criticSkill = await bundleChatGptSkill("critic-review", {
			cwd,
			outDir: path.join(getHarnessRunDir(state.runId), "artifacts", "skills"),
		});
		let criticText = "";
		if (gatePassed(state, "critic")) {
			criticText = await readRoleResponse(state, "critic");
		} else {
			await startGate(state, "critic", options);
			const criticId = await createWorker(state, "critic", runner, [criticSkill.zipPath]);
			const criticHandoff = await createHandoffBundle(state, "critic", [
				artifact.zipPath,
				validation?.logPath ?? manifest.logPath,
				criticSkill.zipPath,
				...(await listPacketFiles(packetDir)),
			]);
			const critic = await sendAndCopy(
				state,
				"critic",
				criticId,
				criticPrompt(state.objective, validation?.output ?? manifest.errors.join("; "), artifact.sha256),
				runner,
				{
					files: [criticHandoff],
					expectJson: true,
				},
			);
			criticText = critic.copiedText;
			await passGate(state, "critic", options, {
				workerRole: "critic",
				workerId: critic.workerId,
				requestId: critic.requestId,
				conversationUrl: critic.conversationUrl,
				outputPaths: [
					critic.responsePath ?? path.join(getHarnessRunDir(state.runId), "responses", "critic-copy.txt"),
				],
			});
		}

		const review = parseChatGptJsonEnvelope(criticText);
		const approved =
			review.ok &&
			review.value?.schema_version === "omg.review.v1" &&
			(review.value as CriticEnvelope).approved === true &&
			validation?.ok === true &&
			manifest.ok;
		if (review.ok && review.value?.schema_version === "omg.review.v1") {
			const criticReview = review.value as CriticEnvelope;
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
		await writeReport(state);
		await passGate(state, "report", options, {
			outputPaths: [path.join(getHarnessRunDir(state.runId), "report.md")],
		});
		return state;
	} catch (error) {
		state.status = "blocked";
		state.verdict = "blocked";
		state.validation.push({
			status: "failed",
			summary: error instanceof Error ? error.message : String(error),
		});
		await writeRunState(state);
		await writeReport(state);
		throw error;
	}
}
