import type { ChatGptWorkerAction } from "./chatgpt-cli";

export interface HarnessReplayFixture {
	schemaVersion: "omg.harness.replay.v1";
	id: string;
	template: "wiki";
	description: string;
	objective: string;
	workspace: "valid-wiki";
	expectedMaxPrompts: number;
	events: Array<
		| { action: "create"; role: "architect" | "builder" | "critic"; workerId: string }
		| { action: "rename"; workerId: string }
		| { action: "send"; workerId: string; conversationRole: "architect" | "builder" | "critic" }
		| { action: "watch"; workerId: string; conversationRole: "architect" | "builder" | "critic" }
		| { action: "download_artifacts"; kind: "json"; downloadedFiles: string[] }
		| { action: "download_artifacts"; kind: "zip"; downloadedFiles: string[] }
	>;
}

export const HARNESS_REPLAY_FIXTURES: HarnessReplayFixture[] = [
	{
		schemaVersion: "omg.harness.replay.v1",
		id: "wiki-replay-json-and-delayed-zip",
		template: "wiki",
		description:
			"Sanitized live-shape replay: downloadable JSON artifacts are recovered, first zip download is empty, second zip download succeeds.",
		objective: "Replay a tiny AI wiki worker flow with delayed artifact availability",
		workspace: "valid-wiki",
		expectedMaxPrompts: 3,
		events: [
			{ action: "create", role: "architect", workerId: "architect-replay" },
			{ action: "rename", workerId: "architect-replay" },
			{ action: "send", workerId: "architect-replay", conversationRole: "architect" },
			{ action: "watch", workerId: "architect-replay", conversationRole: "architect" },
			{ action: "download_artifacts", kind: "json", downloadedFiles: ["response.json"] },
			{ action: "create", role: "builder", workerId: "builder-replay" },
			{ action: "rename", workerId: "builder-replay" },
			{ action: "send", workerId: "builder-replay", conversationRole: "builder" },
			{ action: "watch", workerId: "builder-replay", conversationRole: "builder" },
			{ action: "download_artifacts", kind: "json", downloadedFiles: ["response.json"] },
			{ action: "download_artifacts", kind: "zip", downloadedFiles: [] },
			{ action: "download_artifacts", kind: "zip", downloadedFiles: ["workspace.zip"] },
			{ action: "create", role: "critic", workerId: "critic-replay" },
			{ action: "rename", workerId: "critic-replay" },
			{ action: "send", workerId: "critic-replay", conversationRole: "critic" },
			{ action: "watch", workerId: "critic-replay", conversationRole: "critic" },
			{ action: "download_artifacts", kind: "json", downloadedFiles: ["response.json"] },
		],
	},
];

export function actionMatchesReplayEvent(
	action: ChatGptWorkerAction,
	eventAction: HarnessReplayFixture["events"][number]["action"],
): boolean {
	return action === eventAction;
}
