import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import { Snowflake } from "@oh-my-gpt/gpt-utils/snowflake";
import { unzipSync } from "fflate";
import {
	buildChatGptCommand,
	buildEvidencePacket,
	bundleChatGptSkill,
	createHarnessRun,
	getHarnessRunDir,
	parseChatGptJsonEnvelope,
	validateChatGptSkill,
} from "../src/harness";

describe("harness core", () => {
	let tempRoot = "";
	let originalAgentDir = "";

	beforeEach(async () => {
		tempRoot = path.join(os.tmpdir(), "omg-harness-test", Snowflake.next());
		originalAgentDir = getAgentDir();
		await fs.mkdir(tempRoot, { recursive: true });
		setAgentDir(path.join(tempRoot, "agent"));
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("creates a run with state, todos, and report", async () => {
		const run = await createHarnessRun("test objective", { promptLimit: 3 });
		const runDir = getHarnessRunDir(run.runId);

		expect(await Bun.file(path.join(runDir, "run.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(runDir, "todo.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(runDir, "report.md")).exists()).toBe(true);
		expect(run.promptBudget.limit).toBe(3);
	});

	it("builds evidence packets with hashes and excludes blocked paths", async () => {
		const cwd = path.join(tempRoot, "repo");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "app.ts"), "export const ok = true;\n");
		await Bun.write(path.join(cwd, ".git", "config"), "secret-ish\n");
		const run = await createHarnessRun("packet objective");

		const packet = await buildEvidencePacket({
			runId: run.runId,
			objective: "packet objective",
			role: "critic",
			successCriteria: ["return valid JSON"],
			files: ["src/app.ts", ".git/config"],
			cwd,
		});

		expect(packet.files.map(f => f.path)).toEqual(["src/app.ts"]);
		expect(packet.omitted).toEqual([".git/config"]);
		const zipPath = path.join(packet.packetDir, "REPO_SLICE.zip");
		const unzipped = unzipSync(new Uint8Array(await Bun.file(zipPath).arrayBuffer()));
		expect(Object.keys(unzipped)).toEqual(["src/app.ts"]);
	});

	it("validates and bundles ChatGPT worker skills", async () => {
		const cwd = path.join(tempRoot, "repo");
		const skillDir = path.join(cwd, ".omg", "chatgpt-skills", "critic-review");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			[
				"---",
				"name: critic-review",
				"description: Review things",
				"---",
				"Return JSON in the expected output format.",
				"Validation notes: require local checks.",
			].join("\n"),
		);

		const validation = await validateChatGptSkill("critic-review", cwd);
		expect(validation.ok).toBe(true);
		const bundle = await bundleChatGptSkill("critic-review", { cwd });
		expect(bundle.zipPath.endsWith("critic-review.oai.zip")).toBe(true);
		expect(await Bun.file(bundle.zipPath).exists()).toBe(true);
	});

	it("builds ChatGPT CLI commands without running them", () => {
		expect(
			buildChatGptCommand({
				action: "send",
				worker: "critic-1",
				prompt: "Return JSON only",
				files: ["packet.zip"],
				skills: ["critic-review"],
				extraArgs: ["--json"],
			}),
		).toEqual([
			"chatgpt",
			"workers",
			"send",
			"--file",
			"packet.zip",
			"--skill",
			"critic-review",
			"--json",
			"critic-1",
			"Return JSON only",
		]);
		expect(
			buildChatGptCommand({
				action: "download_artifacts",
				conversationUrl: "https://chatgpt.com/c/abc",
				downloadDir: "artifacts",
			}),
		).toEqual([
			"chatgpt",
			"--headless",
			"--conversation",
			"https://chatgpt.com/c/abc",
			"--download-artifacts",
			"--download-dir",
			"artifacts",
		]);
	});

	it("validates structured ChatGPT JSON envelopes", () => {
		const valid = parseChatGptJsonEnvelope(
			JSON.stringify({
				schema_version: "omg.review.v1",
				approved: true,
				blocking_findings: [],
				non_blocking_findings: [],
				required_fixes: [],
				verdict: "good_enough",
			}),
		);
		expect(valid.ok).toBe(true);
		expect(parseChatGptJsonEnvelope("{nope").ok).toBe(false);
	});
});
