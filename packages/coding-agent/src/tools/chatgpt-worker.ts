import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-gpt/gpt-agent-core";
import { prompt } from "@oh-my-gpt/gpt-utils";
import * as z from "zod/v4";
import { runChatGptWorkerCommand } from "../harness";
import chatgptWorkerDescription from "../prompts/tools/chatgpt-worker.md" with { type: "text" };

const chatgptWorkerSchema = z.object({
	action: z
		.enum(["create", "send", "watch", "status", "upload", "download_artifacts", "copy_message"])
		.describe("ChatGPT CLI worker operation"),
	worker: z.string().optional().describe("Worker id or name for worker subcommands"),
	profile: z.string().optional().describe("ChatGPT worker profile, if creating or selecting a worker"),
	prompt: z.string().optional().describe("Prompt text for send operations"),
	conversationUrl: z.string().optional().describe("Conversation URL for watch/download/copy operations"),
	files: z.array(z.string()).optional().describe("Files to upload or attach"),
	skills: z.array(z.string()).optional().describe("ChatGPT skill ids or bundle paths to attach on send operations"),
	downloadDir: z.string().optional().describe("Directory for downloaded artifacts"),
	extraArgs: z.array(z.string()).optional().describe("Additional explicit chatgpt CLI arguments"),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.max(30 * 60 * 1000)
		.optional()
		.describe("Timeout in milliseconds"),
});

export type ChatGptWorkerToolInput = z.infer<typeof chatgptWorkerSchema>;

export interface ChatGptWorkerToolDetails {
	ok: boolean;
	exitCode: number | null;
	command: string[];
	stdout: string;
	stderr: string;
	downloadedFiles?: string[];
}

export class ChatGptWorkerTool implements AgentTool<typeof chatgptWorkerSchema, ChatGptWorkerToolDetails> {
	readonly name = "chatgpt_worker";
	readonly label = "ChatGPT Worker";
	readonly summary = "Run controlled ChatGPT CLI worker handoffs";
	readonly description = prompt.render(chatgptWorkerDescription);
	readonly parameters = chatgptWorkerSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	async execute(
		_toolCallId: string,
		params: ChatGptWorkerToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ChatGptWorkerToolDetails>,
	): Promise<AgentToolResult<ChatGptWorkerToolDetails>> {
		const result = await runChatGptWorkerCommand(params);
		const details: ChatGptWorkerToolDetails = {
			ok: result.ok,
			exitCode: result.exitCode,
			command: result.command,
			stdout: result.stdout,
			stderr: result.stderr,
			downloadedFiles: result.downloadedFiles,
		};
		const summary = result.ok
			? `ChatGPT ${params.action} completed`
			: `ChatGPT ${params.action} failed with exit code ${result.exitCode ?? "unknown"}`;
		return {
			content: [
				{
					type: "text",
					text: [
						summary,
						result.downloadedFiles?.length ? `Downloaded files: ${result.downloadedFiles.join(", ")}` : "",
						result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
						result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
					]
						.filter(Boolean)
						.join("\n\n"),
				},
			],
			details,
		};
	}
}
