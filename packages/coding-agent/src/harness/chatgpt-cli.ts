import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ChatGptWorkerAction =
	| "create"
	| "rename"
	| "send"
	| "watch"
	| "status"
	| "stop"
	| "upload"
	| "download_artifacts"
	| "copy_message";

export interface ChatGptWorkerCommand {
	action: ChatGptWorkerAction;
	worker?: string;
	profile?: string;
	title?: string;
	prompt?: string;
	conversationUrl?: string;
	files?: string[];
	skills?: string[];
	modelOption?: string;
	thinkingOption?: string;
	downloadDir?: string;
	extraArgs?: string[];
	timeoutMs?: number;
}

export interface ChatGptWorkerCommandResult {
	ok: boolean;
	action: ChatGptWorkerAction;
	command: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	downloadedFiles?: string[];
}

function normalizeAction(action: ChatGptWorkerAction): string {
	return action === "download_artifacts" ? "download-artifacts" : action === "copy_message" ? "copy-message" : action;
}

export function buildChatGptCommand(input: ChatGptWorkerCommand): string[] {
	const args = ["chatgpt"];
	if (input.action === "download_artifacts") {
		args.push("--headless");
		if (input.conversationUrl) args.push("--conversation", input.conversationUrl);
		args.push("--download-artifacts");
		if (input.downloadDir) args.push("--download-dir", input.downloadDir);
		return args.concat(input.extraArgs ?? []);
	}

	args.push("workers", normalizeAction(input.action));
	if (input.action === "create") {
		if (input.profile) args.push("--prefix", input.profile);
		return args.concat(input.extraArgs ?? []);
	}
	if (input.action !== "copy_message" && !input.worker) {
		throw new Error(`chatgpt workers ${normalizeAction(input.action)} requires a worker id`);
	}
	if (input.action === "send") {
		if (!input.prompt) throw new Error("chatgpt workers send requires a prompt");
		if (input.modelOption) args.push("--model-option", input.modelOption);
		if (input.thinkingOption) args.push("--thinking-option", input.thinkingOption);
		for (const file of input.files ?? []) args.push("--file", file);
		for (const skill of input.skills ?? []) args.push("--skill", skill);
		args.push(...(input.extraArgs ?? []));
		args.push(input.worker!, input.prompt);
		return args;
	}
	if (input.action === "upload") {
		for (const file of input.files ?? []) args.push("--file", file);
		args.push(...(input.extraArgs ?? []));
		args.push(input.worker!);
		return args;
	}
	if (input.action === "rename") {
		args.push(...(input.extraArgs ?? []));
		args.push(input.worker!);
		if (input.title) args.push(input.title);
		return args;
	}
	if (input.action === "watch" || input.action === "status" || input.action === "stop") {
		args.push(...(input.extraArgs ?? []));
		args.push(input.worker!);
		return args;
	}
	if (input.action === "copy_message") {
		args.length = 1;
		args.push("--headless");
		if (input.conversationUrl) args.push("--conversation", input.conversationUrl);
		args.push("--copy-message");
		if (input.prompt) args.push(input.prompt);
		return args.concat(input.extraArgs ?? []);
	}
	return args.concat(input.extraArgs ?? []);
}

export function buildChatGptWorkerEnv(env: NodeJS.ProcessEnv = Bun.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") out[key] = value;
	}
	return {
		...out,
		COLUMNS: out.COLUMNS ?? "10000",
		FORCE_COLOR: "0",
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
	};
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}

export async function runChatGptWorkerCommand(input: ChatGptWorkerCommand): Promise<ChatGptWorkerCommandResult> {
	const command = buildChatGptCommand(input);
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: buildChatGptWorkerEnv(),
	});
	const timeout = input.timeoutMs
		? setTimeout(() => {
				proc.kill();
			}, input.timeoutMs)
		: undefined;
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout),
			readStream(proc.stderr),
			proc.exited,
		]);
		const downloadedFiles =
			input.action === "download_artifacts" && input.downloadDir
				? await listDownloadedFiles(input.downloadDir)
				: undefined;
		return { ok: exitCode === 0, action: input.action, command, exitCode, stdout, stderr, downloadedFiles };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function listDownloadedFiles(downloadDir: string): Promise<string[]> {
	const root = path.resolve(downloadDir);
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) out.push(path.relative(root, absolute).replace(/\\/g, "/"));
		}
	}
	await walk(root);
	return out.sort();
}
