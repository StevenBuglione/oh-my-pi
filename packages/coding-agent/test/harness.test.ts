import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import { Snowflake } from "@oh-my-gpt/gpt-utils/snowflake";
import { unzipSync, zipSync } from "fflate";
import {
	bindWorkerRole,
	buildChatGptCommand,
	buildEvidencePacket,
	bundleChatGptSkill,
	cleanupHarnessRuns,
	createHarnessRun,
	getCurrentHarnessArtifacts,
	getCurrentHarnessValidation,
	getHarnessNextAction,
	getHarnessRunDir,
	getOrCreateGateArtifactRequest,
	listHarnessRuns,
	parseChatGptJsonEnvelope,
	parseWikiBlueprintEnvelope,
	parseWikiResearchIssueBody,
	readRunState,
	resumeArtifactProjectHarness,
	resumeWikiMachineHarness,
	runArtifactProjectHarness,
	runHarnessBenchmark,
	runHarnessDoctor,
	runWikiMachineHarness,
	runWikiResearchHarness,
	runWikiSourceHarness,
	syncWikiResearchIssueLabels,
	validateAiWikiManifest,
	validateChatGptSkill,
	validateProjectManifest,
	writeReport,
	writeRunState,
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

	it("lists and exports canonical run state from the .omg run directory", async () => {
		const run = await createHarnessRun("canonical objective");
		const runs = await listHarnessRuns();
		const exported = await readRunState(run.runId);

		expect(runs.some(item => item.runId === run.runId)).toBe(true);
		expect(exported.objective).toBe("canonical objective");
		expect(getHarnessRunDir(run.runId)).toContain(path.join("agent", "harness", "runs"));
	});

	it("keeps report and inspect summaries focused on current harness evidence", async () => {
		const run = await createHarnessRun("summary objective");
		run.status = "good_enough";
		run.verdict = "good_enough";
		run.artifacts.push(
			{ source: "builder", path: "old.zip", sha256: "sha-old", validationStatus: "downloaded" },
			{ source: "builder", path: "old-copy.zip", sha256: "sha-old", validationStatus: "downloaded" },
			{ source: "builder", path: "new.zip", sha256: "sha-new", validationStatus: "downloaded" },
		);
		run.validation.push(
			{ status: "failed", summary: "old manifest failure" },
			{ status: "passed", summary: "AI_WIKI_MANIFEST.json passed validation", logPath: "manifest.json" },
			{
				status: "passed",
				summary: "Declared wiki-machine smoke validation passed",
				command: "python scripts/smoke_validate.py",
				logPath: "smoke.txt",
				exitCode: 0,
			},
			{
				status: "passed",
				summary: "Declared wiki-machine smoke validation passed",
				command: "python scripts/smoke_validate.py",
				logPath: "smoke.txt",
				exitCode: 0,
			},
		);

		const report = await Bun.file(await writeReport(run)).text();

		expect(getCurrentHarnessArtifacts(run).map(artifact => artifact.path)).toEqual(["old-copy.zip", "new.zip"]);
		expect(getCurrentHarnessValidation(run).map(entry => entry.summary)).toEqual([
			"AI_WIKI_MANIFEST.json passed validation",
			"Declared wiki-machine smoke validation passed",
		]);
		expect(report).toContain("## Current Validation");
		expect(report).toContain("Older validation history is retained in run.json");
		expect(report).not.toContain("- failed: old manifest failure");
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
		expect(await Bun.file(path.join(packet.packetDir, "validate_response.py")).exists()).toBe(true);
		expect(await Bun.file(path.join(packet.packetDir, "PROJECT_MANIFEST.schema.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(packet.packetDir, "schemas", "omg.handoff.v1.schema.json")).exists()).toBe(true);
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

	it("validates PROJECT_MANIFEST.json contracts", async () => {
		const workspace = path.join(tempRoot, "manifest-workspace");
		await fs.mkdir(workspace, { recursive: true });

		expect((await validateProjectManifest(workspace)).ok).toBe(false);

		await Bun.write(path.join(workspace, "PROJECT_MANIFEST.json"), "{nope");
		expect((await validateProjectManifest(workspace)).ok).toBe(false);

		await Bun.write(
			path.join(workspace, "PROJECT_MANIFEST.json"),
			JSON.stringify({
				name: "bad",
				description: "bad manifest",
				language: "Python",
				entrypoints: ["../escape.py"],
				test_command: "",
				expected_files: ["missing.py"],
				limitations: [],
			}),
		);
		const invalid = await validateProjectManifest(workspace);
		expect(invalid.ok).toBe(false);
		expect(invalid.errors.join("\n")).toContain("test_command");

		await Bun.write(path.join(workspace, "app.py"), "print('ok')\n");
		await Bun.write(
			path.join(workspace, "PROJECT_MANIFEST.json"),
			JSON.stringify({
				name: "good",
				description: "good manifest",
				language: "Python",
				entrypoints: ["app.py"],
				test_command: "python app.py",
				expected_files: ["app.py"],
				limitations: [],
			}),
		);
		expect((await validateProjectManifest(workspace)).ok).toBe(true);
	});

	it("validates AI_WIKI_MANIFEST.json contracts", async () => {
		const workspace = path.join(tempRoot, "wiki-workspace");
		await fs.mkdir(workspace, { recursive: true });

		expect((await validateAiWikiManifest(workspace)).ok).toBe(false);

		await writeWikiWorkspace(workspace, {
			omit: ["wiki-data-devops/published/dist/local/wiki-health.json"],
		});
		const invalid = await validateAiWikiManifest(workspace);
		expect(invalid.ok).toBe(false);
		expect(invalid.errors.join("\n")).toContain("wiki-health.json");

		await fs.rm(workspace, { recursive: true, force: true });
		await writeWikiWorkspace(workspace);
		const valid = await validateAiWikiManifest(workspace);
		expect(valid.ok).toBe(true);
		expect(valid.manifest?.packages).toContain("wiki-site");
	});

	it("rejects weak wiki contracts before smoke tests", async () => {
		const workspace = path.join(tempRoot, "weak-wiki-contracts");
		await writeWikiWorkspace(workspace);

		await Bun.write(
			path.join(workspace, "wiki-data-registry", "sources.json"),
			JSON.stringify({ schemaVersion: "steve-wiki-registry/v1", routeMode: "hash", sources: [] }),
		);
		expect((await validateAiWikiManifest(workspace)).errors.join("\n")).toContain("routeMode must be query");

		await writeWikiWorkspace(workspace);
		await Bun.write(
			path.join(workspace, "wiki-data-devops", "published", "latest.json"),
			JSON.stringify({ schemaVersion: "steve-wiki-latest/v1" }),
		);
		expect((await validateAiWikiManifest(workspace)).errors.join("\n")).toContain("pagefindBundleUrl");

		await writeWikiWorkspace(workspace);
		await Bun.write(
			path.join(workspace, "wiki-data-devops", "published", "dist", "local", "agent", "chunks", "chunks-0001.jsonl"),
			`${JSON.stringify({ chunkId: "devops:index#top", pageId: "devops:index", text: "missing citation fields" })}\n`,
		);
		const citationErrors = (await validateAiWikiManifest(workspace)).errors.join("\n");
		expect(citationErrors).toContain("url");
		expect(citationErrors).toContain("checksum");
	});

	it("builds ChatGPT CLI commands without running them", () => {
		expect(
			buildChatGptCommand({
				action: "send",
				worker: "critic-1",
				prompt: "Return JSON only",
				files: ["packet.zip"],
				skills: ["critic-review"],
				modelOption: "Thinking",
				thinkingOption: "Standard",
				extraArgs: ["--json"],
			}),
		).toEqual([
			"chatgpt",
			"workers",
			"send",
			"--model-option",
			"Thinking",
			"--thinking-option",
			"Standard",
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
		expect(
			buildChatGptCommand({
				action: "rename",
				worker: "bob-burger",
				title: "OMG run planner bob-burger",
				extraArgs: ["--json"],
			}),
		).toEqual(["chatgpt", "workers", "rename", "--json", "bob-burger", "OMG run planner bob-burger"]);
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

	it("normalizes schema-drifted wiki blueprint responses", () => {
		const parsed = parseWikiBlueprintEnvelope(
			JSON.stringify({
				schema_version: "omg.wiki.blueprint.v1",
				role: "architect",
				status: "complete",
				summary: "Build the wiki proof.",
				confidence: 0.9,
				architecture: { overview: "Local wiki shell plus data contracts." },
				workspace_layout: ["wiki-site", "wiki-data-registry", "wiki-data-devops"],
				implementation_plan: ["write contracts", "build local artifact"],
				required_files: ["AI_WIKI_MANIFEST.json"],
				validation_commands: ["npm test"],
				assumptions: [],
				risks: [],
			}),
		);

		expect(parsed.ok).toBe(true);
		expect(parsed.normalized).toBe(true);
		expect(parsed.value?.architecture).toBe("Local wiki shell plus data contracts.");
		expect(parsed.value?.build_phases).toEqual(["write contracts", "build local artifact"]);
		expect(parsed.warnings).toContain("ignored non-blueprint field role");
	});

	it("recovers wiki blueprint JSON when copied validation commands contain unescaped quotes", () => {
		const raw =
			'{"schema_version":"omg.wiki.blueprint.v1","status":"complete","summary":"Build the wiki proof.","architecture":"Local wiki shell.","workspace_layout":["wiki-site"],"build_phases":["contracts"],"required_files":["AI_WIKI_MANIFEST.json"],"validation_commands":["node -e "JSON.parse(require(\'fs\').readFileSync(\'x.json\',\'utf8\'))""],"assumptions":[],"risks":[]}';
		const parsed = parseWikiBlueprintEnvelope(raw);

		expect(parsed.ok).toBe(true);
		expect(parsed.normalized).toBe(true);
		expect(parsed.value?.validation_commands).toEqual([]);
		expect(parsed.warnings).toContain("malformed validation_commands were removed from copied worker JSON");
	});

	it("reports blocking doctor failures with mocked commands", async () => {
		const result = await runHarnessDoctor({
			cwd: tempRoot,
			cdp: "http://127.0.0.1:1",
			requireLive: true,
			runner: async command => ({
				ok: command.includes("--help"),
				exitCode: command.includes("--help") ? 0 : 1,
				stdout: "",
				stderr: command.includes("--help") ? "" : "workers unavailable",
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.checks.some(check => check.id === "workers" && !check.ok)).toBe(true);
		expect(result.checks.some(check => check.id === "chrome_cdp" && !check.ok)).toBe(true);
		expect(result.checks.some(check => check.id === "artifact_download" && !check.ok)).toBe(true);
	});

	it("reports an OK doctor state with mocked commands and valid skills", async () => {
		await writeSkill(tempRoot, "artifact-builder");
		await writeSkill(tempRoot, "critic-review");
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ Browser: "mock" }),
		});
		try {
			const result = await runHarnessDoctor({
				cwd: tempRoot,
				cdp: server.url.origin,
				requireLive: true,
				runner: async command => {
					const text = command.join(" ");
					if (text === "omg --version") return commandOk("omg/15.2.4");
					if (text === "chatgpt --help") return commandOk("chatgpt help");
					if (text === "chatgpt --headless --help") return commandOk("usage --download-artifacts");
					if (text === "chatgpt workers list --json") return commandOk("[]");
					return { ok: false, exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			});

			expect(result.ok).toBe(true);
			expect(result.checks.some(check => check.id === "omg_bin" && check.ok)).toBe(true);
			expect(result.checks.some(check => check.id === "artifact_download" && check.ok)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("stores actual worker IDs by role without duplicating role bindings", async () => {
		const run = await createHarnessRun("role binding");
		await bindWorkerRole(run, "planner", { workerId: "planner-real-7" });
		await bindWorkerRole(run, "planner", {
			requestId: "req-1",
			conversationUrl: "https://chatgpt.com/c/real",
		});
		const state = await readRunState(run.runId);

		expect(state.workers).toHaveLength(1);
		expect(state.workers[0]).toMatchObject({
			role: "planner",
			workerId: "planner-real-7",
			requestId: "req-1",
			conversationUrl: "https://chatgpt.com/c/real",
		});
	});

	it("cleanup stops only run-scoped workers and marks that run abandoned", async () => {
		const run = await createHarnessRun("cleanup target", { template: "artifact-project" });
		const short = run.runId.split("-").at(-1)!.slice(0, 8);
		await bindWorkerRole(run, "planner", { workerId: `omg-${short}-planner-1` });
		await bindWorkerRole(run, "critic", { workerId: "random-critic" });
		const stopped: string[] = [];

		const result = await cleanupHarnessRuns({
			runId: run.runId,
			runner: async input => {
				if (input.action === "stop" && input.worker) stopped.push(input.worker);
				return { ...ok(input, "{}"), downloadedFiles: undefined };
			},
		});
		const state = await readRunState(run.runId);

		expect(result.cleaned).toEqual([`omg-${short}-planner-1`, "random-critic"]);
		expect(stopped).toEqual([`omg-${short}-planner-1`, "random-critic"]);
		expect(state.status).toBe("abandoned");
		expect(state.workers.map(worker => worker.workerId)).toContain("random-critic");
	});

	it("runs a mocked artifact-project workflow to good_enough", async () => {
		const cwd = path.join(tempRoot, "repo");
		await writeSkill(cwd, "artifact-builder");
		await writeSkill(cwd, "critic-review");

		let workerIndex = 0;
		let criticSendFiles: string[] | undefined;
		const sendFileCounts: number[] = [];
		const zipBytes = zipSync({
			"workspace/README.md": new TextEncoder().encode("ok\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("test command: bun --version\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "tiny",
				description: "Tiny test project",
				language: "JavaScript",
				entrypoints: ["README.md"],
				test_command: `${process.execPath} --version`,
				expected_files: ["README.md", "PROJECT_REPORT.md"],
				limitations: [],
			}),
		});

		const state = await runArtifactProjectHarness("build a tiny project", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "--version"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder", "critic"][workerIndex - 1] ?? "worker";
					const workerId = `${role}-random-${workerIndex}`;
					return ok(
						input,
						JSON.stringify([{ worker_id: workerId, conversation_url: `https://chatgpt.com/c/${workerId}` }]),
					);
				}
				if (input.action === "send") {
					sendFileCounts.push(input.files?.length ?? 0);
					if (input.worker?.includes("critic")) criticSendFiles = input.files;
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("planner")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.handoff.v1",
								role: "planner",
								status: "complete",
								summary: "plan",
								confidence: 0.9,
								assumptions: [],
								findings: [],
								next_action: "send_to_builder",
								artifacts: [],
								patches: [],
								requested_context: [],
							}),
						);
					}
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, "workspace.zip attached");
				}
				if (input.action === "download_artifacts") {
					await fs.mkdir(input.downloadDir!, { recursive: true });
					await Bun.write(path.join(input.downloadDir!, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("good_enough");
		const runDir = getHarnessRunDir(state.runId);
		expect(await Bun.file(path.join(runDir, "prompts", "planner.md")).exists()).toBe(true);
		expect(await Bun.file(path.join(runDir, "responses", "planner-copy.txt")).exists()).toBe(true);
		expect(state.workers.map(worker => worker.role)).toEqual(["planner", "builder", "critic"]);
		expect(sendFileCounts.every(count => count === 1)).toBe(true);
		expect(criticSendFiles).toHaveLength(1);
		expect(criticSendFiles?.[0]).toContain("critic-handoff.zip");
	});

	it("prefers downloaded worker JSON artifacts over copied chat text", async () => {
		const cwd = path.join(tempRoot, "repo");
		await writeSkill(cwd, "artifact-builder");
		await writeSkill(cwd, "critic-review");

		const zipBytes = zipSync({
			"workspace/README.md": new TextEncoder().encode("ok\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("test command: bun --version\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "json-artifact",
				description: "JSON artifact test project",
				language: "JavaScript",
				entrypoints: ["README.md"],
				test_command: `${process.execPath} --version`,
				expected_files: ["README.md", "PROJECT_REPORT.md"],
				limitations: [],
			}),
		});
		let copyMessageCount = 0;
		let workerIndex = 0;

		const state = await runArtifactProjectHarness("use json files", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "--version"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-json`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "status") {
					return ok(
						input,
						JSON.stringify({ conversation_url: `https://chatgpt.com/c/${input.worker}`, is_generating: false }),
					);
				}
				if (input.action === "copy_message") {
					copyMessageCount += 1;
					return ok(input, "not valid json");
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.conversationUrl?.includes("planner")) {
						await Bun.write(
							path.join(input.downloadDir, "response.json"),
							JSON.stringify(handoff("plan from file")),
						);
						return { ...ok(input, "{}"), downloadedFiles: ["response.json"] };
					}
					if (input.conversationUrl?.includes("critic")) {
						await Bun.write(
							path.join(input.downloadDir, "review.json"),
							JSON.stringify({
								schema_version: "omg.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
						return { ...ok(input, "{}"), downloadedFiles: ["review.json"] };
					}
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("good_enough");
		expect(copyMessageCount).toBe(1);
		expect(await Bun.file(path.join(getHarnessRunDir(state.runId), "responses", "planner-copy.json")).exists()).toBe(
			true,
		);
		expect(await Bun.file(path.join(getHarnessRunDir(state.runId), "responses", "critic-copy.json")).exists()).toBe(
			true,
		);
	});

	it("repairs invalid JSON once and then blocks cleanly", async () => {
		const statePromise = runArtifactProjectHarness("invalid planner JSON", {
			cwd: tempRoot,
			checkDoctor: false,
			workerRunner: async input => {
				if (input.action === "create") {
					return ok(
						input,
						JSON.stringify([
							{ worker_id: "planner-json", conversation_url: "https://chatgpt.com/c/planner-json" },
						]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "status") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
							is_generating: false,
						}),
					);
				}
				if (input.action === "copy_message") return ok(input, '{"schema_version":"omg.handoff.v1"}');
				return ok(input, "{}");
			},
		});

		await expect(statePromise).rejects.toThrow("valid OMG JSON envelope after one repair attempt");
		const [state] = await listHarnessRuns();
		expect(state.status).toBe("blocked");
		expect(state.promptBudget.used).toBe(2);
		expect(await Bun.file(path.join(getHarnessRunDir(state.runId), "prompts", "planner-repair.md")).exists()).toBe(
			true,
		);
	});

	it("blocks when the builder does not provide a zip artifact", async () => {
		await writeSkill(tempRoot, "artifact-builder");
		let workerIndex = 0;
		const statePromise = runArtifactProjectHarness("missing artifact", {
			cwd: tempRoot,
			checkDoctor: false,
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-missing`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "status") {
					return ok(
						input,
						JSON.stringify({ conversation_url: `https://chatgpt.com/c/${input.worker}`, is_generating: false }),
					);
				}
				if (input.action === "copy_message") {
					return ok(
						input,
						JSON.stringify({
							schema_version: input.conversationUrl?.includes("planner") ? "omg.handoff.v1" : "omg.artifact.v1",
							role: "planner",
							status: "complete",
							summary: "ok",
							confidence: 1,
							assumptions: [],
							findings: [],
							next_action: "send_to_builder",
							artifacts: [],
							patches: [],
							requested_context: [],
							artifact_name: "workspace.zip",
							expected_root_entries: [],
							test_commands: [],
							limitations: [],
						}),
					);
				}
				if (input.action === "download_artifacts") return { ...ok(input, "{}"), downloadedFiles: [] };
				return ok(input, "{}");
			},
		});

		await expect(statePromise).rejects.toThrow("downloadable .zip artifact");
		const [state] = await listHarnessRuns();
		expect(state.status).toBe("blocked");
		expect(state.verdict).toBe("blocked");
	});

	it("blocks unsafe artifact zip paths before validation", async () => {
		await writeSkill(tempRoot, "artifact-builder");
		let workerIndex = 0;
		const unsafeZip = zipSync({
			"../evil.txt": new TextEncoder().encode("bad\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "unsafe",
				description: "unsafe archive",
				language: "Text",
				entrypoints: [],
				test_command: "echo ok",
				expected_files: [],
				limitations: [],
			}),
		});

		const statePromise = runArtifactProjectHarness("unsafe artifact", {
			cwd: tempRoot,
			checkDoctor: false,
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-unsafe`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "status") {
					return ok(
						input,
						JSON.stringify({ conversation_url: `https://chatgpt.com/c/${input.worker}`, is_generating: false }),
					);
				}
				if (input.action === "copy_message") {
					return ok(
						input,
						JSON.stringify({
							schema_version: input.conversationUrl?.includes("planner") ? "omg.handoff.v1" : "omg.artifact.v1",
							role: "planner",
							status: "complete",
							summary: "ok",
							confidence: 1,
							assumptions: [],
							findings: [],
							next_action: "send_to_builder",
							artifacts: [],
							patches: [],
							requested_context: [],
							artifact_name: "workspace.zip",
							expected_root_entries: [],
							test_commands: ["echo ok"],
							limitations: [],
						}),
					);
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), unsafeZip);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		await expect(statePromise).rejects.toThrow("unsafe path");
		const [state] = await listHarnessRuns();
		expect(state.status).toBe("blocked");
	});

	it("invokes a fixer once when artifact validation fails", async () => {
		const cwd = path.join(tempRoot, "repo");
		await writeSkill(cwd, "artifact-builder");
		await writeSkill(cwd, "critic-review");

		let workerIndex = 0;
		let downloadCount = 0;
		const brokenZip = zipSync({
			"workspace/README.md": new TextEncoder().encode("broken\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("missing fixed marker\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "broken",
				description: "Broken test project",
				language: "JavaScript",
				entrypoints: ["README.md"],
				test_command: `${process.execPath} -e "process.exit(1)"`,
				expected_files: ["README.md", "PROJECT_REPORT.md"],
				limitations: [],
			}),
		});
		const fixedZip = zipSync({
			"workspace/README.md": new TextEncoder().encode("fixed\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("has fixed marker\n"),
			"workspace/fixed.txt": new TextEncoder().encode("ok\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "fixed",
				description: "Fixed test project",
				language: "JavaScript",
				entrypoints: ["fixed.txt"],
				test_command: `${process.execPath} -e "process.exit(0)"`,
				expected_files: ["README.md", "PROJECT_REPORT.md", "fixed.txt"],
				limitations: [],
			}),
		});

		const state = await runArtifactProjectHarness("build then fix a tiny project", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "-e", "process.exit((await Bun.file('fixed.txt').exists()) ? 0 : 1)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder", "fixer", "critic"][workerIndex - 1] ?? "worker";
					const workerId = `${role}-random-${workerIndex}`;
					return ok(
						input,
						JSON.stringify([{ worker_id: workerId, conversation_url: `https://chatgpt.com/c/${workerId}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(
						input,
						JSON.stringify({
							schema_version: "omg.handoff.v1",
							role: "planner",
							status: "complete",
							summary: "build it",
							confidence: 0.9,
							assumptions: [],
							findings: [],
							next_action: "send_to_builder",
							artifacts: [],
							patches: [],
							requested_context: [],
						}),
					);
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) {
						return { ...ok(input, "{}"), downloadedFiles: [] };
					}
					downloadCount += 1;
					await Bun.write(
						path.join(input.downloadDir, "workspace.zip"),
						downloadCount === 1 ? brokenZip : fixedZip,
					);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.verdict).toBe("good_enough");
		expect(downloadCount).toBe(2);
		expect(state.workers.map(worker => worker.role)).toEqual(["planner", "builder", "fixer", "critic"]);
		expect(state.validation.map(entry => entry.status)).toContain("failed");
		expect(state.validation.map(entry => entry.status)).toContain("passed");
	});

	it("resumes a failed validation run without duplicating planner and builder", async () => {
		const cwd = path.join(tempRoot, "repo");
		await writeSkill(cwd, "artifact-builder");
		await writeSkill(cwd, "critic-review");

		let createCount = 0;
		let plannerSendCount = 0;
		let builderSendCount = 0;
		let downloadCount = 0;
		const workerRoles = new Map<string, string>();
		const brokenZip = zipSync({
			"workspace/README.md": new TextEncoder().encode("broken\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("broken\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "resume-broken",
				description: "Broken before resume",
				language: "JavaScript",
				entrypoints: ["README.md"],
				test_command: `${process.execPath} -e "process.exit(1)"`,
				expected_files: ["README.md", "PROJECT_REPORT.md"],
				limitations: [],
			}),
		});
		const fixedZip = zipSync({
			"workspace/README.md": new TextEncoder().encode("fixed\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("fixed\n"),
			"workspace/fixed.txt": new TextEncoder().encode("ok\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "resume-fixed",
				description: "Fixed after resume",
				language: "JavaScript",
				entrypoints: ["fixed.txt"],
				test_command: `${process.execPath} -e "process.exit(0)"`,
				expected_files: ["README.md", "PROJECT_REPORT.md", "fixed.txt"],
				limitations: [],
			}),
		});

		const runner = async (input: any) => {
			if (input.action === "create") {
				createCount += 1;
				const role = ["planner", "builder", "fixer", "critic"][createCount - 1] ?? "worker";
				return ok(
					input,
					JSON.stringify([{ worker_id: `${role}-resume`, conversation_url: `https://chatgpt.com/c/${role}` }]),
				);
			}
			if (input.action === "rename") {
				const role = ["planner", "builder", "fixer", "critic"].find(item => input.title?.includes(` ${item} `));
				if (role && input.worker) workerRoles.set(input.worker, role);
				return ok(input, "{}");
			}
			if (input.action === "send") {
				const role = workerRoles.get(input.worker) ?? "";
				if (role === "planner") plannerSendCount += 1;
				if (role === "builder") builderSendCount += 1;
				return ok(
					input,
					JSON.stringify({
						request_id: `req-${input.worker}`,
						conversation_url: `https://chatgpt.com/c/${role || input.worker}`,
					}),
				);
			}
			if (input.action === "status") {
				const role = workerRoles.get(input.worker) ?? input.worker;
				return ok(
					input,
					JSON.stringify({ conversation_url: `https://chatgpt.com/c/${role}`, is_generating: false }),
				);
			}
			if (input.action === "copy_message") {
				if (input.conversationUrl?.includes("critic")) {
					return ok(
						input,
						JSON.stringify({
							schema_version: "omg.review.v1",
							approved: true,
							blocking_findings: [],
							non_blocking_findings: [],
							required_fixes: [],
							verdict: "good_enough",
						}),
					);
				}
				return ok(
					input,
					JSON.stringify({
						schema_version: input.conversationUrl?.includes("builder") ? "omg.artifact.v1" : "omg.handoff.v1",
						role: "planner",
						status: "complete",
						summary: "ok",
						confidence: 1,
						assumptions: [],
						findings: [],
						next_action: "send_to_builder",
						artifacts: [],
						patches: [],
						requested_context: [],
						artifact_name: "workspace.zip",
						expected_root_entries: [],
						test_commands: [],
						limitations: [],
					}),
				);
			}
			if (input.action === "download_artifacts" && input.downloadDir) {
				downloadCount += 1;
				await fs.mkdir(input.downloadDir, { recursive: true });
				await Bun.write(path.join(input.downloadDir, "workspace.zip"), downloadCount === 1 ? brokenZip : fixedZip);
				return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
			}
			return ok(input, "{}");
		};

		await expect(
			runArtifactProjectHarness("resume failed validation", {
				cwd,
				checkDoctor: false,
				promptLimit: 2,
				workerRunner: runner,
			}),
		).rejects.toThrow("prompt budget exhausted");
		const [blocked] = await listHarnessRuns();
		const resumed = await resumeArtifactProjectHarness(blocked.runId, {
			cwd,
			checkDoctor: false,
			promptLimit: 10,
			workerRunner: runner,
		});

		expect(resumed.status).toBe("good_enough");
		expect(plannerSendCount).toBe(1);
		expect(builderSendCount).toBe(1);
		expect(createCount).toBeGreaterThanOrEqual(3);
	});

	it("does not mark good_enough when builder and fixer artifacts both fail validation", async () => {
		const cwd = path.join(tempRoot, "repo");
		await writeSkill(cwd, "artifact-builder");
		await writeSkill(cwd, "critic-review");

		let workerIndex = 0;
		const brokenZip = zipSync({
			"workspace/README.md": new TextEncoder().encode("broken\n"),
			"workspace/PROJECT_REPORT.md": new TextEncoder().encode("missing fixed marker\n"),
			"workspace/PROJECT_MANIFEST.json": manifestBytes({
				name: "broken",
				description: "Still broken test project",
				language: "JavaScript",
				entrypoints: ["README.md"],
				test_command: `${process.execPath} -e "process.exit(1)"`,
				expected_files: ["README.md", "PROJECT_REPORT.md"],
				limitations: [],
			}),
		});

		const state = await runArtifactProjectHarness("keep failing", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "-e", "process.exit((await Bun.file('fixed.txt').exists()) ? 0 : 1)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["planner", "builder", "fixer", "critic"][workerIndex - 1] ?? "worker";
					const workerId = `${role}-random-${workerIndex}`;
					return ok(
						input,
						JSON.stringify([{ worker_id: workerId, conversation_url: `https://chatgpt.com/c/${workerId}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker}`,
						}),
					);
				}
				if (input.action === "status") {
					return ok(
						input,
						JSON.stringify({ conversation_url: `https://chatgpt.com/c/${input.worker}`, is_generating: false }),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: ["local validation still failed"],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(
						input,
						JSON.stringify({
							schema_version: "omg.handoff.v1",
							role: "planner",
							status: "complete",
							summary: "build it",
							confidence: 0.9,
							assumptions: [],
							findings: [],
							next_action: "send_to_builder",
							artifacts: [],
							patches: [],
							requested_context: [],
						}),
					);
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), brokenZip);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("not_good_enough");
		expect(state.validation.filter(entry => entry.status === "failed")).toHaveLength(2);
		expect(state.reviewerFindings).toContain("local validation still failed");
	});

	it("runs a mocked wiki workflow to good_enough", async () => {
		const cwd = path.join(tempRoot, "wiki-repo");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "valid-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;
		const sendFileCounts: number[] = [];

		const state = await runWikiMachineHarness("build an AI wiki machine local proof", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-wiki`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					sendFileCounts.push(input.files?.length ?? 0);
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify(wikiArtifact()));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("good_enough");
		expect(state.template).toBe("wiki");
		expect(state.gates?.map(gate => gate.id)).toContain("wiki_manifest");
		expect(state.workers.map(worker => worker.role)).toEqual(["architect", "builder", "critic"]);
		expect(sendFileCounts.every(count => count === 1)).toBe(true);
	});

	it("retries delayed wiki artifact downloads before blocking", async () => {
		const cwd = path.join(tempRoot, "wiki-retry");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "retry-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;
		let artifactDownloadCount = 0;

		const state = await runWikiMachineHarness("build a delayed AI wiki artifact", {
			cwd,
			checkDoctor: false,
			artifactDownloadRetryDelaysMs: [0],
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-retry`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify(wikiArtifact()));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					artifactDownloadCount += 1;
					if (artifactDownloadCount === 1) return { ...ok(input, "{}"), downloadedFiles: [] };
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("good_enough");
		expect(artifactDownloadCount).toBe(2);
		expect(
			await Bun.file(
				path.join(getHarnessRunDir(state.runId), "responses", "builder-download-attempt-2.json"),
			).exists(),
		).toBe(true);
	});

	it("asks the wiki builder for one artifact repair when JSON arrives without a zip", async () => {
		const cwd = path.join(tempRoot, "wiki-artifact-repair");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "artifact-repair-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;
		let repairSent = false;
		let artifactDownloadCount = 0;

		const state = await runWikiMachineHarness("repair missing wiki artifact", {
			cwd,
			checkDoctor: false,
			artifactDownloadRetryDelaysMs: [0],
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-repair`, conversation_url: `https://chatgpt.com/c/${role}` }]),
					);
				}
				if (input.action === "send") {
					if (String(input.prompt).includes("local artifact download failed")) repairSent = true;
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify(wikiArtifact()));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					artifactDownloadCount += 1;
					if (!repairSent) return { ...ok(input, "{}"), downloadedFiles: [] };
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(state.status).toBe("good_enough");
		expect(state.promptBudget.used).toBe(4);
		expect(artifactDownloadCount).toBe(3);
		expect(
			await Bun.file(path.join(getHarnessRunDir(state.runId), "prompts", "builder-artifact-repair.md")).exists(),
		).toBe(true);
	});

	it("repairs invalid wiki architect JSON once and then blocks cleanly", async () => {
		await writeSkill(tempRoot, "wiki-architect");
		const promise = runWikiMachineHarness("invalid wiki architect JSON", {
			cwd: tempRoot,
			checkDoctor: false,
			workerRunner: async input => {
				if (input.action === "create") {
					return ok(
						input,
						JSON.stringify([{ worker_id: "architect-bad", conversation_url: "https://chatgpt.com/c/architect" }]),
					);
				}
				if (input.action === "send") {
					return ok(
						input,
						JSON.stringify({ request_id: "req", conversation_url: "https://chatgpt.com/c/architect" }),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({ request_id: "req", conversation_url: "https://chatgpt.com/c/architect" }),
					);
				}
				if (input.action === "copy_message") return ok(input, '{"schema_version":"omg.wiki.blueprint.v1"}');
				return ok(input, "{}");
			},
		});

		await expect(promise).rejects.toThrow("did not attach downloadable JSON artifact");
		const [state] = await listHarnessRuns();
		expect(state.status).toBe("blocked");
		expect(state.promptBudget.used).toBe(2);
	});

	it("blocks a wiki artifact missing AI_WIKI_MANIFEST.json", async () => {
		await writeSkill(tempRoot, "wiki-architect");
		await writeSkill(tempRoot, "wiki-builder");
		let workerIndex = 0;
		const zipBytes = zipSync({
			"workspace/README.md": new TextEncoder().encode("missing manifest\n"),
		});

		await expect(
			runWikiMachineHarness("missing wiki manifest", {
				cwd: tempRoot,
				checkDoctor: false,
				workerRunner: async input => {
					if (input.action === "create") {
						workerIndex += 1;
						const role = ["architect", "builder"][workerIndex - 1] ?? "worker";
						return ok(
							input,
							JSON.stringify([
								{ worker_id: `${role}-missing`, conversation_url: `https://chatgpt.com/c/${role}` },
							]),
						);
					}
					if (input.action === "send") {
						return ok(
							input,
							JSON.stringify({
								request_id: "req",
								conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
							}),
						);
					}
					if (input.action === "watch") {
						return ok(
							input,
							JSON.stringify({
								request_id: "req",
								conversation_url: `https://chatgpt.com/c/${input.worker?.split("-")[0]}`,
							}),
						);
					}
					if (input.action === "copy_message") {
						return ok(
							input,
							JSON.stringify(input.conversationUrl?.includes("architect") ? wikiBlueprint() : wikiArtifact()),
						);
					}
					if (input.action === "download_artifacts" && input.downloadDir) {
						await fs.mkdir(input.downloadDir, { recursive: true });
						if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
						await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
						return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
					}
					return ok(input, "{}");
				},
			}),
		).rejects.toThrow("AI wiki manifest validation failed");
		const [state] = await listHarnessRuns();
		expect(state.status).toBe("blocked");
		expect(state.gates?.find(gate => gate.id === "wiki_manifest")?.status).toBe("failed");
	});

	it("resumes a wiki run after prompt budget blocks before critic", async () => {
		const cwd = path.join(tempRoot, "wiki-resume");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "resume-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let createCount = 0;
		let architectSends = 0;
		let builderSends = 0;

		const runner = async (input: any) => {
			if (input.action === "create") {
				createCount += 1;
				const role = ["architect", "builder", "critic"][createCount - 1] ?? "worker";
				return ok(
					input,
					JSON.stringify([{ worker_id: `${role}-resume`, conversation_url: `https://chatgpt.com/c/${role}` }]),
				);
			}
			if (input.action === "send") {
				if (String(input.worker).includes("architect")) architectSends += 1;
				if (String(input.worker).includes("builder")) builderSends += 1;
				return ok(
					input,
					JSON.stringify({
						request_id: `req-${input.worker}`,
						conversation_url: `https://chatgpt.com/c/${String(input.worker).split("-")[0]}`,
					}),
				);
			}
			if (input.action === "watch") {
				return ok(
					input,
					JSON.stringify({
						request_id: `req-${input.worker}`,
						conversation_url: `https://chatgpt.com/c/${String(input.worker).split("-")[0]}`,
					}),
				);
			}
			if (input.action === "copy_message") {
				if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
				if (input.conversationUrl?.includes("critic")) {
					return ok(
						input,
						JSON.stringify({
							schema_version: "omg.wiki.review.v1",
							approved: true,
							blocking_findings: [],
							non_blocking_findings: [],
							required_fixes: [],
							verdict: "good_enough",
						}),
					);
				}
				return ok(input, JSON.stringify(wikiArtifact()));
			}
			if (input.action === "download_artifacts" && input.downloadDir) {
				await fs.mkdir(input.downloadDir, { recursive: true });
				if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
				await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
				return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
			}
			return ok(input, "{}");
		};

		await expect(
			runWikiMachineHarness("resume wiki machine", {
				cwd,
				checkDoctor: false,
				promptLimit: 2,
				testCommand: [process.execPath, "-e", "process.exit(0)"],
				workerRunner: runner,
			}),
		).rejects.toThrow("prompt budget exhausted");
		const [blocked] = await listHarnessRuns();
		const resumed = await resumeWikiMachineHarness(blocked.runId, {
			cwd,
			checkDoctor: false,
			promptLimit: 10,
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: runner,
		});

		expect(resumed.status).toBe("good_enough");
		expect(architectSends).toBe(1);
		expect(builderSends).toBe(1);
	});

	it("canonicalizes legacy wiki-machine template input to wiki", async () => {
		const run = await createHarnessRun("legacy wiki spelling", { template: "wiki-machine" });

		expect(run.template).toBe("wiki");
		expect(run.gates?.map(gate => gate.id)).toContain("wiki_manifest");
	});

	it("persists UUID artifact requests across resume state reloads", async () => {
		const run = await createHarnessRun("uuid artifact names", { template: "wiki" });
		const first = getOrCreateGateArtifactRequest(run, "builder", "builder", {
			artifactKind: "workspace",
			artifactExt: "zip",
		});
		await writeRunState(run);
		const reloaded = await readRunState(run.runId);
		const second = getOrCreateGateArtifactRequest(reloaded, "builder", "builder", {
			artifactKind: "workspace",
			artifactExt: "zip",
		});

		expect(second).toEqual(first);
		expect(first.responseFilename).toMatch(/^omg-.+-builder-response-.+\.json$/);
		expect(first.artifactFilename).toMatch(/^omg-.+-builder-workspace-.+\.zip$/);
	});

	it("prefers exact UUID wiki artifact filenames over legacy duplicate zip names", async () => {
		const cwd = path.join(tempRoot, "wiki-uuid-exact");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "uuid-exact-wiki");
		await writeWikiWorkspace(workspace);
		const exactZipBytes = await zipDirectory(workspace, "workspace");
		const legacyZipBytes = zipSync({
			"workspace/README.md": new TextEncoder().encode("legacy wrong zip\n"),
		});
		let workerIndex = 0;
		let expectedZipName = "";

		const state = await runWikiMachineHarness("select exact uuid artifact", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-uuid`, conversation_url: `https://chatgpt.local/${role}` }]),
					);
				}
				if (input.action === "send") {
					if (String(input.worker).includes("builder")) {
						expectedZipName = String(input.prompt).match(/downloadable file named ([^\s.]+\.zip)/)?.[1] ?? "";
					}
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.local/${String(input.worker).split("-")[0]}`,
						}),
					);
				}
				if (input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.local/${String(input.worker).split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify({ ...wikiArtifact(), artifact_name: expectedZipName }));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), legacyZipBytes);
					await Bun.write(path.join(input.downloadDir, expectedZipName), exactZipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip", expectedZipName] };
				}
				return ok(input, "{}");
			},
		});

		const downloadGate = state.gates?.find(gate => gate.id === "download");
		const selected = downloadGate?.downloadAttempts?.find(attempt => attempt.selectedPath);
		expect(state.status).toBe("good_enough");
		expect(path.basename(selected?.selectedPath ?? "")).toBe(expectedZipName);
		expect(selected?.degraded).toBe(false);
	});

	it("records degraded selection when wiki artifact falls back to legacy workspace.zip", async () => {
		const cwd = path.join(tempRoot, "wiki-legacy-degraded");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		await writeSkill(cwd, "wiki-critic");
		const workspace = path.join(tempRoot, "legacy-degraded-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;

		const state = await runWikiMachineHarness("legacy zip fallback", {
			cwd,
			checkDoctor: false,
			testCommand: [process.execPath, "-e", "process.exit(0)"],
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-legacy`, conversation_url: `https://chatgpt.local/${role}` }]),
					);
				}
				if (input.action === "send" || input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.local/${String(input.worker).split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify(wikiArtifact()));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		const selected = state.gates
			?.find(gate => gate.id === "download")
			?.downloadAttempts?.find(attempt => attempt.selectedPath);
		expect(state.status).toBe("good_enough");
		expect(path.basename(selected?.selectedPath ?? "")).toBe("workspace.zip");
		expect(selected?.degraded).toBe(true);
	});

	it("rejects ambiguous wiki zip downloads without the expected UUID artifact", async () => {
		const cwd = path.join(tempRoot, "wiki-ambiguous-zips");
		await writeSkill(cwd, "wiki-architect");
		await writeSkill(cwd, "wiki-builder");
		const workspace = path.join(tempRoot, "ambiguous-wiki");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;

		await expect(
			runWikiMachineHarness("ambiguous zip fallback", {
				cwd,
				checkDoctor: false,
				artifactDownloadRetryDelaysMs: [],
				workerRunner: async input => {
					if (input.action === "create") {
						workerIndex += 1;
						const role = ["architect", "builder"][workerIndex - 1] ?? "worker";
						return ok(
							input,
							JSON.stringify([
								{ worker_id: `${role}-ambiguous`, conversation_url: `https://chatgpt.local/${role}` },
							]),
						);
					}
					if (input.action === "send" || input.action === "watch") {
						return ok(
							input,
							JSON.stringify({
								request_id: `req-${input.worker}`,
								conversation_url: `https://chatgpt.local/${String(input.worker).split("-")[0]}`,
							}),
						);
					}
					if (input.action === "copy_message") {
						return ok(
							input,
							JSON.stringify(input.conversationUrl?.includes("architect") ? wikiBlueprint() : wikiArtifact()),
						);
					}
					if (input.action === "download_artifacts" && input.downloadDir) {
						await fs.mkdir(input.downloadDir, { recursive: true });
						if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
						await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
						await Bun.write(path.join(input.downloadDir, "other.zip"), zipBytes);
						return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip", "other.zip"] };
					}
					return ok(input, "{}");
				},
			}),
		).rejects.toThrow("ambiguous");
	});

	it("runs the offline harness benchmark for all templates", async () => {
		const result = await runHarnessBenchmark({ template: "all" });

		expect(result.schemaVersion).toBe("omg.harness.benchmark.v1");
		expect(result.ok).toBe(true);
		expect(result.template).toBe("all");
		expect(result.scenarios.map(scenario => scenario.id)).toContain("artifact-project-happy");
		expect(result.scenarios.map(scenario => scenario.id)).toContain("wiki-happy");
		expect(result.scenarios.every(scenario => scenario.promptBudget.used <= scenario.promptBudget.expectedMax)).toBe(
			true,
		);
		expect(await Bun.file(result.benchmarkPath).exists()).toBe(true);
		expect(await Bun.file(result.reportPath).exists()).toBe(true);
	}, 10_000);

	it("runs replay benchmark fixtures for copied JSON and delayed zip recovery", async () => {
		const result = await runHarnessBenchmark({ template: "wiki" });
		const replay = result.scenarios.find(scenario => scenario.id === "wiki-replay-json-and-delayed-zip");

		expect(result.ok).toBe(true);
		expect(replay?.ok).toBe(true);
		expect(replay?.artifactDownloadAttempts).toBe(2);
		expect(replay?.promptBudget.used).toBeLessThanOrEqual(replay?.promptBudget.expectedMax ?? 0);
	}, 10_000);

	it("skips the live wiki canary benchmark cleanly when rate-limited", async () => {
		const result = await runHarnessBenchmark({
			template: "wiki",
			live: true,
			canary: true,
			commandRunner: async () => commandOk(JSON.stringify({ can_submit: false, remaining: 0 })),
		});

		expect(result.ok).toBe(true);
		expect(result.rateLimit?.skipped).toBe(true);
		expect(result.scenarios).toHaveLength(1);
		expect(result.scenarios[0].actualStatus).toBe("skipped");
	});

	it("passes the live wiki canary benchmark with mocked worker output", async () => {
		const workspace = path.join(tempRoot, "live-canary-workspace");
		await writeWikiWorkspace(workspace);
		const zipBytes = await zipDirectory(workspace, "workspace");
		let workerIndex = 0;

		const result = await runHarnessBenchmark({
			template: "wiki",
			live: true,
			canary: true,
			commandRunner: async () => commandOk(JSON.stringify({ can_submit: true, remaining: 5 })),
			workerRunner: async input => {
				if (input.action === "create") {
					workerIndex += 1;
					const role = ["architect", "builder", "critic"][workerIndex - 1] ?? "worker";
					return ok(
						input,
						JSON.stringify([{ worker_id: `${role}-canary`, conversation_url: `https://chatgpt.local/${role}` }]),
					);
				}
				if (input.action === "send" || input.action === "watch") {
					return ok(
						input,
						JSON.stringify({
							request_id: `req-${input.worker}`,
							conversation_url: `https://chatgpt.local/${String(input.worker).split("-")[0]}`,
						}),
					);
				}
				if (input.action === "copy_message") {
					if (input.conversationUrl?.includes("architect")) return ok(input, JSON.stringify(wikiBlueprint()));
					if (input.conversationUrl?.includes("critic")) {
						return ok(
							input,
							JSON.stringify({
								schema_version: "omg.wiki.review.v1",
								approved: true,
								blocking_findings: [],
								non_blocking_findings: [],
								required_fixes: [],
								verdict: "good_enough",
							}),
						);
					}
					return ok(input, JSON.stringify(wikiArtifact()));
				}
				if (input.action === "download_artifacts" && input.downloadDir) {
					await fs.mkdir(input.downloadDir, { recursive: true });
					if (input.downloadDir.includes("json-artifacts")) return await writeMockWikiJsonArtifact(input);
					await Bun.write(path.join(input.downloadDir, "workspace.zip"), zipBytes);
					return { ...ok(input, "{}"), downloadedFiles: ["workspace.zip"] };
				}
				return ok(input, "{}");
			},
		});

		expect(result.ok).toBe(true);
		expect(result.rateLimit?.skipped).toBe(false);
		expect(result.scenarios[0].id).toBe("wiki-live-canary");
		expect(result.scenarios[0].actualStatus).toBe("good_enough");
	});

	it("runs the offline harness benchmark with wiki alias and summarizes legacy live runs", async () => {
		const legacy = await createHarnessRun("old live run", { template: "wiki-machine" });
		legacy.status = "good_enough";
		legacy.verdict = "good_enough";
		await Bun.write(path.join(getHarnessRunDir(legacy.runId), "run.json"), `${JSON.stringify(legacy, null, 2)}\n`);

		const result = await runHarnessBenchmark({ template: "wiki-machine", includeLiveRuns: true });

		expect(result.ok).toBe(true);
		expect(result.template).toBe("wiki");
		expect(result.scenarios.every(scenario => scenario.template === "wiki")).toBe(true);
		expect(result.liveRuns?.byTemplate.wiki).toBeGreaterThanOrEqual(1);
		expect(result.liveRuns?.latestGoodEnoughByTemplate.wiki).toBeTruthy();
	}, 10_000);

	it("explains the next harness command for blocked, active, and good_enough runs", async () => {
		const blocked = await createHarnessRun("blocked wiki", { template: "wiki", promptLimit: 2 });
		blocked.status = "blocked";
		blocked.promptBudget.used = 2;
		blocked.gates = [{ id: "critic", status: "failed", error: "critic rejected artifact" }];

		const active = await createHarnessRun("active artifact", { template: "artifact-project" });
		active.status = "active";
		active.gates = [{ id: "builder", status: "running" }];

		const done = await createHarnessRun("done wiki", { template: "wiki" });
		done.status = "good_enough";
		done.verdict = "good_enough";

		const blockedNext = getHarnessNextAction(blocked);
		const activeNext = getHarnessNextAction(active);
		const doneNext = getHarnessNextAction(done);

		expect(blockedNext.command).toContain(`omg harness resume ${blocked.runId} --limit`);
		expect(blockedNext.currentGate).toBe("critic");
		expect(blockedNext.wikiLadder?.length).toBeGreaterThan(0);
		expect(activeNext.command).toBe(`omg harness resume ${active.runId}`);
		expect(activeNext.currentGate).toBe("builder");
		expect(doneNext.command).toBe(`omg harness export ${done.runId}`);
	});

	it("dry-runs wiki-source provisioning with seed files and registry patch", async () => {
		const registryPath = path.join(tempRoot, "sources.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Cloud and automation notes",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);

		const state = await runWikiSourceHarness("Create a sandbox notes data source", {
			owner: "acme",
			registryPath,
		});

		const runDir = getHarnessRunDir(state.runId);
		const plan = JSON.parse(await Bun.file(path.join(runDir, "artifacts", "provision-plan.json")).text());
		const patch = JSON.parse(await Bun.file(path.join(runDir, "artifacts", "registry-patch-sources.json")).text());
		expect(state.status).toBe("good_enough");
		expect(state.template).toBe("wiki-source");
		expect(plan.mode).toBe("dry-run");
		expect(plan.action).toBe("create_new_source");
		expect(await Bun.file(path.join(runDir, "artifacts", "seed", plan.repo_name, "wiki.source.json")).exists()).toBe(
			true,
		);
		expect(patch.sources.some((source: any) => source.id === plan.source_id)).toBe(true);
		expect(state.gates?.find(gate => gate.id === "repo_create")?.status).toBe("skipped");
	});

	it("routes wiki-source objectives to existing registry sources when policy matches", async () => {
		const registryPath = path.join(tempRoot, "existing-sources.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Kubernetes CI CD automation infrastructure",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);

		const state = await runWikiSourceHarness("Add Kubernetes automation notes", {
			owner: "acme",
			registryPath,
		});
		const plan = JSON.parse(
			await Bun.file(path.join(getHarnessRunDir(state.runId), "artifacts", "provision-plan.json")).text(),
		);

		expect(state.status).toBe("good_enough");
		expect(plan.action).toBe("use_existing_source");
		expect(plan.repo_name).toBe("wiki-data-devops");
		expect(state.gates?.find(gate => gate.id === "repo_seed")?.status).toBe("skipped");
	});

	it("blocks wiki-source apply when the GitHub token is missing", async () => {
		await expect(
			runWikiSourceHarness("Create a sandbox notes source", {
				owner: "acme",
				apply: true,
				githubToken: "",
			}),
		).rejects.toThrow("GITHUB_TOKEN or GITHUB_PAT");
		const [state] = await listHarnessRuns();
		const text = await Bun.file(path.join(getHarnessRunDir(state.runId), "run.json")).text();
		expect(text).not.toContain("ghp_");
		expect(state.gates?.find(gate => gate.id === "doctor")?.status).toBe("failed");
	});

	it("blocks wiki-source runs when the registry cannot be read", async () => {
		await expect(
			runWikiSourceHarness("Create a sandbox notes source", {
				owner: "acme",
				registryPath: path.join(tempRoot, "missing-sources.json"),
			}),
		).rejects.toThrow("registry snapshot unavailable");
		const [state] = await listHarnessRuns();
		expect(state.gates?.find(gate => gate.id === "registry_snapshot")?.status).toBe("failed");
	});

	it("applies wiki-source provisioning through the mocked GitHub client without leaking the PAT", async () => {
		const calls: string[] = [];
		const registryPath = path.join(tempRoot, "apply-sources.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Cloud and automation notes",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);
		const state = await runWikiSourceHarness("Create a sandbox notes data source", {
			owner: "acme",
			registryPath,
			apply: true,
			githubToken: "ghp_super_secret_token",
			githubClient: {
				async getAuthenticatedUser(token) {
					calls.push(`auth:${token === "ghp_super_secret_token"}`);
					return { login: "acme" };
				},
				async getRepo(_token, owner, repo) {
					calls.push(`get:${owner}/${repo}`);
					return { exists: false };
				},
				async createRepo(_token, input) {
					calls.push(`create:${input.owner}/${input.repo}:${input.private}`);
					return {
						htmlUrl: `https://github.com/${input.owner}/${input.repo}`,
						defaultBranch: "main",
						sha: "1".repeat(40),
					};
				},
				async putFile(_token, input) {
					calls.push(`put:${input.branch}:${input.path}`);
					return { commitSha: "2".repeat(40) };
				},
				async createBranch(_token, input) {
					calls.push(`branch:${input.branch}:${input.fromSha.length}`);
					return { ref: `refs/heads/${input.branch}` };
				},
			},
		});

		const runText = await Bun.file(path.join(getHarnessRunDir(state.runId), "run.json")).text();
		const reportText = await Bun.file(path.join(getHarnessRunDir(state.runId), "report.md")).text();
		expect(state.status).toBe("good_enough");
		expect(calls[0]).toBe("auth:true");
		expect(calls.some(call => call.startsWith("create:acme/wiki-data-"))).toBe(true);
		expect(calls).toContain("branch:published:40");
		expect(calls.some(call => call === "put:published:latest.json")).toBe(true);
		expect(runText).not.toContain("ghp_super_secret_token");
		expect(reportText).not.toContain("ghp_super_secret_token");
	});

	it("parses issue-backed wiki research bodies into deterministic fields", () => {
		const parsed = parseWikiResearchIssueBody({
			title: "Research Kubernetes backup patterns",
			body: [
				"## Objective",
				"Compare Velero and storage snapshots.",
				"",
				"## Expected output",
				"A wiki page with tradeoffs.",
				"",
				"## Constraints",
				"- Public sources only",
				"",
				"## Preferred source",
				"devops",
				"",
				"## Acceptance",
				"- Include restore testing notes",
				"",
				"https://velero.io/docs/",
			].join("\n"),
		});

		expect(parsed.objective).toBe("Compare Velero and storage snapshots.");
		expect(parsed.expectedOutput).toBe("A wiki page with tradeoffs.");
		expect(parsed.constraints).toContain("Public sources only");
		expect(parsed.preferredSource).toBe("devops");
		expect(parsed.citations).toContain("https://velero.io/docs/");
	});

	it("dry-runs issue-backed wiki research into an existing source without GitHub mutations", async () => {
		const registryPath = path.join(tempRoot, "research-sources.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Kubernetes CI CD automation infrastructure",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);
		const issue = wikiResearchIssue({
			title: "Kubernetes backup patterns",
			body: "## Objective\nResearch Kubernetes backup patterns.\n\n## Preferred source\ndevops\n\nhttps://kubernetes.io/docs/",
		});
		const state = await runWikiResearchHarness("issue backed research", {
			owner: "acme",
			repo: "wiki-data-registry",
			issue: "1",
			registryPath,
			githubClient: wikiResearchMockClient({ issue }),
		});
		const runDir = getHarnessRunDir(state.runId);
		const draft = JSON.parse(await Bun.file(path.join(runDir, "responses", "wiki-page-draft.json")).text());

		expect(state.status).toBe("good_enough");
		expect(state.template).toBe("wiki-research");
		expect(draft.source_id).toBe("devops");
		expect(await Bun.file(path.join(runDir, "artifacts", "draft", draft.path)).exists()).toBe(true);
		expect(state.gates?.find(gate => gate.id === "pr_create")?.status).toBe("skipped");
	});

	it("blocks mutating wiki-research when steering is missing", async () => {
		const registryPath = path.join(tempRoot, "research-sources.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Kubernetes CI CD automation infrastructure",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);
		await expect(
			runWikiResearchHarness("issue backed research", {
				owner: "acme",
				repo: "wiki-data-registry",
				issue: "1",
				registryPath,
				apply: true,
				githubToken: "ghp_super_secret_token",
				githubClient: wikiResearchMockClient({ issue: wikiResearchIssue() }),
			}),
		).rejects.toThrow("wiki.steering.json is required");
		const [state] = await listHarnessRuns();
		const runText = await Bun.file(path.join(getHarnessRunDir(state.runId), "run.json")).text();
		expect(runText).not.toContain("ghp_super_secret_token");
		expect(state.gates?.find(gate => gate.id === "steering_load")?.status).toBe("failed");
	});

	it("applies issue-backed wiki research through mocked branch and PR APIs without leaking PATs", async () => {
		const calls: string[] = [];
		const registryPath = path.join(tempRoot, "research-sources.json");
		const steeringPath = path.join(tempRoot, "wiki.steering.json");
		await writeWikiRegistry(registryPath, [
			{
				id: "devops",
				label: "DevOps",
				description: "Kubernetes CI CD automation infrastructure",
				enabled: true,
				order: 10,
				latestUrl: "https://cdn.jsdelivr.net/gh/acme/wiki-data-devops@published/latest.json",
			},
		]);
		await writeWikiSteering(steeringPath, { registryPath });
		const state = await runWikiResearchHarness("issue backed research", {
			owner: "acme",
			repo: "wiki-data-registry",
			issue: "1",
			steeringPath,
			registryPath,
			apply: true,
			githubToken: "ghp_super_secret_token",
			githubClient: wikiResearchMockClient({
				calls,
				issue: wikiResearchIssue({
					title: "Kubernetes backup patterns",
					body: "## Objective\nResearch Kubernetes backup patterns.\n\n## Preferred source\ndevops\n\nhttps://kubernetes.io/docs/",
				}),
			}),
		});
		const runText = await Bun.file(path.join(getHarnessRunDir(state.runId), "run.json")).text();
		const reportText = await Bun.file(path.join(getHarnessRunDir(state.runId), "report.md")).text();

		expect(state.status).toBe("good_enough");
		expect(calls.some(call => call.startsWith("branch:acme/wiki-data-devops:omg/wiki-research/"))).toBe(true);
		expect(calls.some(call => call === "put:wiki-data-devops:docs/kubernetes-backup-patterns.md")).toBe(true);
		expect(calls.some(call => call === "pr:wiki-data-devops")).toBe(true);
		expect(calls.some(call => call === "label:wiki-data-devops:wiki:research,wiki:pr-open")).toBe(true);
		expect(runText).not.toContain("ghp_super_secret_token");
		expect(reportText).not.toContain("ghp_super_secret_token");
	});

	it("plans wiki research label sync without mutating GitHub by default", async () => {
		const result = await syncWikiResearchIssueLabels({ owner: "acme", repo: "wiki-data-registry" });
		expect(result.applied).toBe(false);
		expect(result.labels).toContain("wiki:research");
		expect(result.labels).toContain("wiki:queued");
	});
});

function ok(input: { action: string }, stdout: string) {
	return {
		ok: true,
		action: input.action as any,
		command: ["mock"],
		exitCode: 0,
		stdout,
		stderr: "",
	};
}

function commandOk(stdout: string) {
	return { ok: true, exitCode: 0, stdout, stderr: "" };
}

async function writeWikiRegistry(pathOut: string, sources: any[]): Promise<void> {
	await Bun.write(
		pathOut,
		`${JSON.stringify(
			{
				schemaVersion: "steve-wiki-registry/v1",
				updatedAt: "2026-05-24T00:00:00Z",
				routeMode: "query",
				sources,
			},
			null,
			2,
		)}\n`,
	);
}

async function writeWikiSteering(pathOut: string, steering: Record<string, unknown>): Promise<void> {
	await Bun.write(pathOut, `${JSON.stringify(steering, null, 2)}\n`);
}

function wikiResearchIssue(overrides: Partial<any> = {}) {
	return {
		number: 1,
		title: "Kubernetes backup patterns",
		body: "## Objective\nResearch Kubernetes backup patterns.\n\n## Preferred source\ndevops\n\nhttps://kubernetes.io/docs/",
		labels: ["wiki:research", "wiki:queued", "source:devops"],
		htmlUrl: "https://github.com/acme/wiki-data-registry/issues/1",
		owner: "acme",
		repo: "wiki-data-registry",
		createdAt: "2026-05-24T00:00:00Z",
		...overrides,
	};
}

function wikiResearchMockClient(options: { issue: any; calls?: string[] }) {
	const calls = options.calls ?? [];
	return {
		async getAuthenticatedUser(token?: string) {
			calls.push(`auth:${token === "ghp_super_secret_token"}`);
			return { login: "acme" };
		},
		async getRepo(_token: string | undefined, owner: string, repo: string) {
			calls.push(`get:${owner}/${repo}`);
			return { exists: true, defaultBranch: "main", sha: "1".repeat(40) };
		},
		async getIssue(_token: string | undefined, owner: string, repo: string, issueNumber: number) {
			calls.push(`issue:${owner}/${repo}#${issueNumber}`);
			return { ...options.issue, owner, repo, number: issueNumber };
		},
		async listIssues(_token: string | undefined, owner: string, repo: string, labels: string[]) {
			calls.push(`list:${owner}/${repo}:${labels.join(",")}`);
			return [{ ...options.issue, owner, repo }];
		},
		async createIssue(_token: string, input: any) {
			calls.push(`create-issue:${input.repo}`);
			return wikiResearchIssue({
				number: 2,
				title: input.title,
				body: input.body,
				labels: input.labels,
				htmlUrl: `https://github.com/${input.owner}/${input.repo}/issues/2`,
				owner: input.owner,
				repo: input.repo,
			});
		},
		async commentIssue(_token: string, input: any) {
			calls.push(`comment:${input.repo}#${input.issueNumber}`);
			return { htmlUrl: `https://github.com/${input.owner}/${input.repo}/issues/${input.issueNumber}#comment` };
		},
		async addLabels(_token: string, input: any) {
			calls.push(`label:${input.repo}:${input.labels.join(",")}`);
		},
		async removeLabel(_token: string, input: any) {
			calls.push(`remove-label:${input.repo}:${input.label}`);
		},
		async ensureLabel(_token: string, input: any) {
			calls.push(`ensure-label:${input.repo}:${input.label}`);
		},
		async createBranch(_token: string, input: any) {
			calls.push(`branch:${input.owner}/${input.repo}:${input.branch}`);
			return { ref: `refs/heads/${input.branch}` };
		},
		async putFile(_token: string, input: any) {
			calls.push(`put:${input.repo}:${input.path}`);
			return { commitSha: "2".repeat(40) };
		},
		async createPullRequest(_token: string, input: any) {
			calls.push(`pr:${input.repo}`);
			return { number: 3, htmlUrl: `https://github.com/${input.owner}/${input.repo}/pull/3` };
		},
	};
}

function handoff(summary: string): Record<string, unknown> {
	return {
		schema_version: "omg.handoff.v1",
		role: "planner",
		status: "complete",
		summary,
		confidence: 0.9,
		assumptions: [],
		findings: [],
		next_action: "send_to_builder",
		artifacts: [],
		patches: [],
		requested_context: [],
	};
}

async function writeSkill(cwd: string, name: string): Promise<void> {
	const skillDir = path.join(cwd, ".omg", "chatgpt-skills", name);
	await fs.mkdir(skillDir, { recursive: true });
	await Bun.write(
		path.join(skillDir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			"description: Test skill",
			"---",
			"Return JSON in the expected output format.",
			"Validation notes: local checks are authoritative.",
		].join("\n"),
	);
}

function manifestBytes(manifest: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function wikiBlueprint(): Record<string, unknown> {
	return {
		schema_version: "omg.wiki.blueprint.v1",
		status: "complete",
		summary: "Build a local AI wiki proof workspace.",
		architecture: "Local Docusaurus-style shell plus registry and one data source.",
		workspace_layout: ["wiki-site", "wiki-data-registry", "wiki-data-devops"],
		build_phases: ["contracts", "site shell", "data artifacts", "agent artifacts", "smoke validation"],
		required_files: ["AI_WIKI_MANIFEST.json", "wiki-data-registry/sources.json"],
		validation_commands: [`${process.execPath} scripts/validate-wiki.mjs`],
		assumptions: [],
		risks: [],
	};
}

function wikiArtifact(): Record<string, unknown> {
	return {
		schema_version: "omg.wiki.artifact.v1",
		status: "complete",
		artifact_name: "workspace.zip",
		expected_workspace_root_entries: ["AI_WIKI_MANIFEST.json", "wiki-site", "wiki-data-registry", "wiki-data-devops"],
		required_wiki_contracts: [
			"wiki-data-registry/sources.json",
			"wiki-data-devops/published/dist/local/wiki-manifest.json",
		],
		test_commands: [`${process.execPath} scripts/validate-wiki.mjs`],
		limitations: [],
	};
}

async function writeMockWikiJsonArtifact(input: any, overrides: Record<string, unknown> = {}): Promise<any> {
	if (!input.downloadDir) return { ...ok(input, "{}"), downloadedFiles: [] };
	await fs.mkdir(input.downloadDir, { recursive: true });
	let payload: Record<string, unknown>;
	if (String(input.downloadDir).includes("architect-json-artifacts")) payload = wikiBlueprint();
	else if (String(input.downloadDir).includes("critic-json-artifacts")) {
		payload = {
			schema_version: "omg.wiki.review.v1",
			approved: true,
			blocking_findings: [],
			non_blocking_findings: [],
			required_fixes: [],
			verdict: "good_enough",
		};
	} else payload = wikiArtifact();
	payload = { ...payload, ...overrides };
	await Bun.write(path.join(input.downloadDir, "response.json"), `${JSON.stringify(payload)}\n`);
	return { ...ok(input, "{}"), downloadedFiles: ["response.json"] };
}

async function writeWikiWorkspace(root: string, options: { omit?: string[] } = {}): Promise<void> {
	const omit = new Set(options.omit ?? []);
	const files: Record<string, string> = {
		"README.md": "# AI Wiki Proof\n",
		"PROJECT_REPORT.md": "Local wiki proof report.\n",
		"AI_WIKI_MANIFEST.json": JSON.stringify(
			{
				schema_version: "omg.ai-wiki.workspace.v1",
				name: "ai-wiki-proof",
				description: "Local deterministic AI wiki proof workspace",
				packages: ["wiki-site", "wiki-data-registry", "wiki-data-devops"],
				test_command: `${process.execPath} scripts/validate-wiki.mjs`,
				required_contracts: [
					"wiki-site/package.json",
					"wiki-site/src/wiki-core/types.ts",
					"wiki-site/static/llms.txt",
					"wiki-site/static/.well-known/wiki-agent.json",
					"wiki-data-registry/sources.json",
					"wiki-data-registry/agent-sources.json",
					"wiki-data-devops/wiki.source.json",
					"wiki-data-devops/docs/index.md",
					"wiki-data-devops/published/latest.json",
					"wiki-data-devops/published/latest-agent.json",
					"wiki-data-devops/published/dist/local/wiki-manifest.json",
					"wiki-data-devops/published/dist/local/wiki-catalog.json",
					"wiki-data-devops/published/dist/local/wiki-tags.json",
					"wiki-data-devops/published/dist/local/wiki-health.json",
					"wiki-data-devops/published/dist/local/agent/agent-manifest.json",
					"wiki-data-devops/published/dist/local/agent/chunks/chunks-0001.jsonl",
				],
				limitations: ["local proof only"],
			},
			null,
			2,
		),
		"scripts/validate-wiki.mjs": "console.log('wiki proof ok');\n",
		"wiki-site/package.json": JSON.stringify({ scripts: { test: "node ../../scripts/validate-wiki.mjs" } }, null, 2),
		"wiki-site/src/wiki-core/types.ts": "export type WikiSourceId = string;\n",
		"wiki-site/static/llms.txt": "# AI Wiki\n",
		"wiki-site/static/.well-known/wiki-agent.json": JSON.stringify({ schemaVersion: "steve-wiki-agent/v1" }),
		"wiki-data-registry/sources.json": JSON.stringify({
			schemaVersion: "steve-wiki-registry/v1",
			routeMode: "query",
			sources: [
				{
					id: "devops",
					label: "DevOps",
					latestUrl: "http://localhost/wiki-data-devops/published/latest.json",
				},
			],
		}),
		"wiki-data-registry/agent-sources.json": JSON.stringify({
			schemaVersion: "steve-wiki-agent-sources/v1",
			sources: [],
		}),
		"wiki-data-devops/wiki.source.json": JSON.stringify({ schemaVersion: "steve-wiki-source/v1", id: "devops" }),
		"wiki-data-devops/docs/index.md": "---\ntitle: Index\n---\n# Index\n",
		"wiki-data-devops/published/latest.json": JSON.stringify({
			schemaVersion: "steve-wiki-latest/v1",
			sourceId: "devops",
			manifestUrl: "http://localhost/wiki-data-devops/published/dist/local/wiki-manifest.json",
			catalogUrl: "http://localhost/wiki-data-devops/published/dist/local/wiki-catalog.json",
			pagefindBundleUrl: "http://localhost/wiki-data-devops/published/dist/local/pagefind/",
			agentManifestUrl: "http://localhost/wiki-data-devops/published/dist/local/agent/agent-manifest.json",
			contentBaseUrl: "http://localhost/wiki-data-devops/docs/",
		}),
		"wiki-data-devops/published/latest-agent.json": JSON.stringify({
			schemaVersion: "steve-wiki-agent-latest/v1",
			sourceId: "devops",
		}),
		"wiki-data-devops/published/dist/local/wiki-manifest.json": JSON.stringify({
			schemaVersion: "steve-wiki-manifest/v1",
			contentBaseUrl: "http://localhost/wiki-data-devops/docs/",
			pages: [
				{
					id: "devops:index",
					sourceId: "devops",
					title: "Index",
					slug: "index",
					file: "index.md",
				},
			],
		}),
		"wiki-data-devops/published/dist/local/wiki-catalog.json": JSON.stringify({
			schemaVersion: "steve-wiki-catalog/v1",
			counts: { pages: 1 },
		}),
		"wiki-data-devops/published/dist/local/wiki-tags.json": JSON.stringify({
			schemaVersion: "steve-wiki-tags/v1",
			tags: [],
		}),
		"wiki-data-devops/published/dist/local/wiki-health.json": JSON.stringify({
			schemaVersion: "steve-wiki-health/v1",
			status: "ok",
		}),
		"wiki-data-devops/published/dist/local/agent/agent-manifest.json": JSON.stringify({
			schemaVersion: "steve-wiki-agent-manifest/v1",
		}),
		"wiki-data-devops/published/dist/local/agent/chunks/chunks-0001.jsonl": `${JSON.stringify({
			chunkId: "devops:index#top",
			pageId: "devops:index",
			url: "/wiki/?s=devops&p=index#top",
			text: "Index",
			checksum: "sha256:test",
		})}\n`,
	};
	await fs.mkdir(root, { recursive: true });
	for (const [relPath, content] of Object.entries(files)) {
		if (omit.has(relPath)) continue;
		const absolute = path.join(root, relPath);
		await fs.mkdir(path.dirname(absolute), { recursive: true });
		await Bun.write(absolute, content);
	}
}

async function zipDirectory(root: string, prefix = ""): Promise<Uint8Array> {
	const entries: Record<string, Uint8Array> = {};
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(absolute);
			} else if (entry.isFile()) {
				const rel = path.relative(root, absolute).replace(/\\/g, "/");
				entries[prefix ? `${prefix}/${rel}` : rel] = new Uint8Array(await Bun.file(absolute).arrayBuffer());
			}
		}
	}
	await walk(root);
	return zipSync(entries);
}
