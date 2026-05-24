import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";
import {
	buildEvidencePacket,
	bundleChatGptSkill,
	cleanupHarnessRuns,
	createHarnessRun,
	getCurrentHarnessArtifacts,
	getCurrentHarnessValidation,
	getHarnessNextAction,
	getHarnessRunDir,
	listHarnessRuns,
	normalizeHarnessTemplate,
	readRunState,
	resumeArtifactProjectHarness,
	resumeWikiBootstrapHarness,
	resumeWikiMachineHarness,
	resumeWikiResearchHarness,
	resumeWikiSourceHarness,
	runArtifactProjectHarness,
	runHarnessBenchmark,
	runHarnessDoctor,
	runWikiBootstrapHarness,
	runWikiMachineHarness,
	runWikiResearchHarness,
	runWikiSourceHarness,
	syncWikiResearchIssueLabels,
	validateChatGptSkill,
	writeReport,
} from "../harness";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = [
	"run",
	"resume",
	"status",
	"inspect",
	"export",
	"skills",
	"doctor",
	"cleanup",
	"benchmark",
	"next",
	"wiki",
] as const;

export default class Harness extends Command {
	static description = "Run and inspect OMG harness workflows";

	static args = {
		action: Args.string({ description: "Harness action", required: false, options: ACTIONS }),
		subject: Args.string({ description: "Run id, skill action, or objective", required: false }),
		value: Args.string({ description: "Skill name or objective continuation", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		limit: Flags.integer({ description: "ChatGPT prompt budget limit", default: 10 }),
		role: Flags.string({ description: "Evidence packet role", default: "planner" }),
		file: Flags.string({ description: "Include a scoped file in the evidence packet", multiple: true }),
		live: Flags.boolean({ description: "Run the live ChatGPT worker workflow" }),
		canary: Flags.boolean({ description: "Run the smallest live harness canary benchmark" }),
		summary: Flags.boolean({ description: "Print compact benchmark summary" }),
		template: Flags.string({ description: "Harness workflow template", default: "artifact-project" }),
		owner: Flags.string({ description: "GitHub owner/org for wiki-source provisioning" }),
		repo: Flags.string({ description: "GitHub repository for issue-backed wiki research" }),
		issue: Flags.string({ description: "GitHub issue URL, owner/repo#number, or issue number" }),
		"from-issues": Flags.boolean({ description: "Run wiki-research from the next queued GitHub issue" }),
		steering: Flags.string({ description: "Path to wiki.steering.json for wiki-research runs" }),
		registry: Flags.string({ description: "Path to wiki-data-registry sources.json for wiki-source runs" }),
		apply: Flags.boolean({ description: "Apply mutating wiki-source GitHub provisioning steps" }),
		private: Flags.boolean({ description: "Create wiki-source repositories as private when --apply is used" }),
		run: Flags.string({ description: "Harness run id for cleanup" }),
		stale: Flags.boolean({ description: "Clean up stale run-scoped workers" }),
		"include-live-runs": Flags.boolean({ description: "Include existing live run summaries in benchmark output" }),
	};

	static examples = [
		'# Start a harness run\n  omg harness run "build a small validated tool"',
		"# List harness runs\n  omg harness status",
		"# Resume a failed or interrupted live run\n  omg harness resume <run-id>",
		"# Inspect a run ledger\n  omg harness inspect <run-id>",
		"# Export a run report\n  omg harness export <run-id>",
		"# Clean up run-scoped workers\n  omg harness cleanup --run <run-id>",
		"# Run the offline harness benchmark\n  omg harness benchmark --template all",
		"# Run a tiny live wiki canary benchmark\n  omg harness benchmark --live --canary --template wiki",
		"# Show the next action for a run\n  omg harness next <run-id>",
		"# Validate or bundle a ChatGPT worker skill\n  omg harness skills validate critic-review\n  omg harness skills bundle artifact-builder",
		"# Check live harness prerequisites\n  omg harness doctor",
		'# Run the live artifact-project workflow\n  omg harness run --live --template artifact-project "build a small validated tool"',
		'# Run the live wiki workflow\n  omg harness run --live --template wiki "build a local AI wiki proof"',
		'# Dry-run wiki data source provisioning\n  omg harness run --template wiki-source --owner YOUR_ORG "create a sandbox notes source"',
		"# Run issue-backed wiki research\n  omg harness run --template wiki-research --issue https://github.com/YOUR_ORG/wiki-data-registry/issues/1",
		"# Bootstrap the five public wiki repos\n  omg harness run --template wiki-bootstrap --owner StevenBuglione",
		"# Sync wiki research labels\n  omg harness wiki issues sync --owner YOUR_ORG --repo wiki-data-registry",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Harness);
		await initTheme();
		const action = args.action as (typeof ACTIONS)[number] | undefined;
		if (!action) {
			renderCommandHelp("omg", "harness", Harness);
			return;
		}

		if (action === "run") {
			const objective = [args.subject, args.value].filter(Boolean).join(" ").trim();
			const template = normalizeHarnessTemplate(flags.template);
			if (template === "wiki-bootstrap") {
				const state = await runWikiBootstrapHarness(objective || "bootstrap AI wiki repositories", {
					promptLimit: flags.limit,
					owner: flags.owner,
					apply: flags.apply,
					private: flags.private,
					onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
				});
				if (flags.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				else process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
				return;
			}
			if (template === "wiki-research") {
				if (!objective && !flags.issue && !flags["from-issues"]) {
					throw new Error(
						"omg harness run --template wiki-research requires an objective, --issue, or --from-issues",
					);
				}
				const state = await runWikiResearchHarness(objective || "issue-backed wiki research", {
					promptLimit: flags.limit,
					owner: flags.owner,
					repo: flags.repo,
					issue: flags.issue,
					fromIssues: flags["from-issues"],
					steeringPath: flags.steering,
					registryPath: flags.registry,
					apply: flags.apply,
					onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
				});
				if (flags.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				else process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
				return;
			}
			if (!objective) throw new Error("omg harness run requires an objective");
			if (template === "wiki-source") {
				const state = await runWikiSourceHarness(objective, {
					promptLimit: flags.limit,
					owner: flags.owner,
					registryPath: flags.registry,
					apply: flags.apply,
					private: flags.private,
					onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
				});
				if (flags.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				else process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
				return;
			}
			if (flags.live) {
				if (!template) {
					throw new Error(
						"supported live harness templates: artifact-project, wiki (wiki-machine alias accepted)",
					);
				}
				const runTemplate = template === "wiki" ? runWikiMachineHarness : runArtifactProjectHarness;
				const state = await runTemplate(objective, {
					promptLimit: flags.limit,
					files: flags.file ?? [],
					onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
				});
				if (flags.json) {
					process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				} else {
					process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
				}
				return;
			}
			const state = await createHarnessRun(objective, { promptLimit: flags.limit, template });
			const packet = await buildEvidencePacket({
				runId: state.runId,
				objective,
				role: template === "wiki" ? "wiki-architect" : (flags.role ?? "planner"),
				successCriteria: [
					"Use evidence packets for ChatGPT handoffs.",
					"Require structured JSON responses.",
					"Accept success only after local validation.",
				],
				files: flags.file ?? [],
			});
			state.evidencePackets.push(packet.packetDir);
			await writeReport(state);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ state, packet }, null, 2)}\n`);
			} else {
				process.stdout.write(`started harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
			}
			return;
		}

		if (action === "resume") {
			if (!args.subject) throw new Error("omg harness resume requires a run id");
			const existing = await readRunState(args.subject);
			const resumeTemplate =
				normalizeHarnessTemplate(existing.template) === "wiki-bootstrap"
					? resumeWikiBootstrapHarness
					: normalizeHarnessTemplate(existing.template) === "wiki-research"
						? resumeWikiResearchHarness
						: normalizeHarnessTemplate(existing.template) === "wiki-source"
							? resumeWikiSourceHarness
							: normalizeHarnessTemplate(existing.template) === "wiki"
								? resumeWikiMachineHarness
								: resumeArtifactProjectHarness;
			const state = await resumeTemplate(args.subject, {
				promptLimit: flags.limit,
				files: flags.file ?? [],
				owner: flags.owner,
				repo: flags.repo,
				issue: flags.issue,
				fromIssues: flags["from-issues"],
				steeringPath: flags.steering,
				registryPath: flags.registry,
				apply: flags.apply,
				private: flags.private,
				onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
			});
			if (flags.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
			else process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
			return;
		}

		if (action === "doctor") {
			const requiredSkills =
				normalizeHarnessTemplate(flags.template) === "wiki"
					? ["wiki-architect", "wiki-builder", "wiki-critic"]
					: undefined;
			if (normalizeHarnessTemplate(flags.template) === "wiki-source") {
				const tokenPresent = Boolean(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT);
				const result = {
					ok: !flags.apply || tokenPresent,
					checks: [
						{
							id: "github_token",
							label: "GitHub token",
							ok: tokenPresent || !flags.apply,
							blocking: Boolean(flags.apply),
							summary: tokenPresent
								? "GitHub token is present (value redacted)"
								: flags.apply
									? "Set GITHUB_TOKEN or GITHUB_PAT before --apply"
									: "Not required for dry-run; set GITHUB_TOKEN or GITHUB_PAT before --apply",
						},
					],
				};
				if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				else {
					for (const check of result.checks) {
						process.stdout.write(`${check.ok ? "ok" : "fail"}  ${check.label}: ${check.summary}\n`);
					}
				}
				if (!result.ok) process.exitCode = 1;
				return;
			}
			if (normalizeHarnessTemplate(flags.template) === "wiki-research") {
				const tokenPresent = Boolean(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT);
				const steeringPresent = flags.steering
					? await Bun.file(flags.steering).exists()
					: await Bun.file("wiki.steering.json").exists();
				const result = {
					ok: (!flags.apply || tokenPresent) && (!flags.apply || steeringPresent),
					checks: [
						{
							id: "github_token",
							label: "GitHub token",
							ok: tokenPresent || !flags.apply,
							blocking: Boolean(flags.apply),
							summary: tokenPresent
								? "GitHub token is present (value redacted)"
								: flags.apply
									? "Set GITHUB_TOKEN or GITHUB_PAT before --apply"
									: "Not required for dry-run",
						},
						{
							id: "wiki_steering",
							label: "Wiki steering",
							ok: steeringPresent || !flags.apply,
							blocking: Boolean(flags.apply),
							summary: steeringPresent
								? "Wiki steering file is present"
								: flags.apply
									? "wiki.steering.json is required before --apply"
									: "Dry-run will use conservative steering defaults",
						},
					],
				};
				if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				else {
					for (const check of result.checks) {
						process.stdout.write(`${check.ok ? "ok" : "fail"}  ${check.label}: ${check.summary}\n`);
					}
				}
				if (!result.ok) process.exitCode = 1;
				return;
			}
			if (normalizeHarnessTemplate(flags.template) === "wiki-bootstrap") {
				const tokenPresent = Boolean(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT);
				const result = {
					ok: !flags.apply || tokenPresent,
					checks: [
						{
							id: "github_token",
							label: "GitHub token",
							ok: tokenPresent || !flags.apply,
							blocking: Boolean(flags.apply),
							summary: tokenPresent
								? "GitHub token is present (value redacted)"
								: flags.apply
									? "Set GITHUB_TOKEN or GITHUB_PAT before --apply"
									: "Not required for dry-run",
						},
					],
				};
				if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				else {
					for (const check of result.checks) {
						process.stdout.write(`${check.ok ? "ok" : "fail"}  ${check.label}: ${check.summary}\n`);
					}
				}
				if (!result.ok) process.exitCode = 1;
				return;
			}
			const result = await runHarnessDoctor({ cwd: process.cwd(), requireLive: true, requiredSkills });
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else {
				for (const check of result.checks) {
					process.stdout.write(`${check.ok ? "ok" : "fail"}  ${check.label}: ${check.summary}\n`);
				}
			}
			if (!result.ok) process.exitCode = 1;
			return;
		}

		if (action === "wiki") {
			if (args.subject !== "issues" || args.value !== "sync") {
				throw new Error("supported wiki harness command: omg harness wiki issues sync");
			}
			const result = await syncWikiResearchIssueLabels({
				owner: flags.owner,
				repo: flags.repo,
				apply: flags.apply,
			});
			if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				process.stdout.write(
					`${result.applied ? "synced" : "planned"} ${result.labels.length} wiki research label(s) for ${result.owner}/${result.repo}\n`,
				);
			}
			return;
		}

		if (action === "benchmark") {
			const templateWasProvided = process.argv.some(arg => arg === "--template" || arg.startsWith("--template="));
			const result = await runHarnessBenchmark({
				template: templateWasProvided ? flags.template : "all",
				includeLiveRuns: flags["include-live-runs"],
				live: flags.live,
				canary: flags.canary,
			});
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else if (flags.summary) {
				const weakest =
					result.scenarios.find(scenario => !scenario.ok) ??
					[...result.scenarios].sort(
						(a, b) =>
							b.promptBudget.used / Math.max(1, b.promptBudget.expectedMax) -
								a.promptBudget.used / Math.max(1, a.promptBudget.expectedMax) ||
							b.gates.failed - a.gates.failed,
					)[0];
				process.stdout.write(
					`benchmark ${result.ok ? "pass" : "fail"} ${result.benchmarkId} (${result.scenarios.length} scenario(s))\n`,
				);
				if (weakest) {
					process.stdout.write(
						`weakest ${weakest.id}: prompts ${weakest.promptBudget.used}/${weakest.promptBudget.expectedMax}, repairs ${weakest.repairPrompts}, downloads ${weakest.artifactDownloadAttempts}${weakest.blocker ? `, blocker ${weakest.blocker}` : ""}\n`,
					);
				}
				process.stdout.write(`${result.reportPath}\n`);
			} else {
				process.stdout.write(`benchmark ${result.ok ? "pass" : "fail"} ${result.benchmarkId}\n`);
				for (const scenario of result.scenarios) {
					process.stdout.write(
						`${scenario.ok ? "ok" : "fail"}  ${scenario.id}  prompts ${scenario.promptBudget.used}/${scenario.promptBudget.expectedMax}  repairs ${scenario.repairPrompts}  downloads ${scenario.artifactDownloadAttempts}${scenario.blocker ? `  ${scenario.blocker}` : ""}\n`,
					);
				}
				process.stdout.write(`${result.reportPath}\n`);
			}
			if (!result.ok) process.exitCode = 1;
			return;
		}

		if (action === "next") {
			if (!args.subject) throw new Error("omg harness next requires a run id");
			const state = await readRunState(args.subject);
			const next = getHarnessNextAction(state);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
			} else {
				process.stdout.write(`next command: ${next.command}\n`);
				process.stdout.write(`reason: ${next.reason}\n`);
				if (next.currentGate) process.stdout.write(`gate: ${next.currentGate}\n`);
				if (next.blocker) process.stdout.write(`blocker: ${next.blocker}\n`);
				if (next.wikiLadder) {
					process.stdout.write("wiki ladder:\n");
					for (const step of next.wikiLadder) {
						process.stdout.write(`- L${step.level} ${step.title}: ${step.description}\n`);
					}
				}
			}
			return;
		}

		if (action === "status") {
			const runs = await listHarnessRuns();
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
				return;
			}
			if (runs.length === 0) {
				process.stdout.write("no harness runs found\n");
				return;
			}
			for (const run of runs) {
				process.stdout.write(
					`${run.runId}  ${run.status}  ${run.promptBudget.used}/${run.promptBudget.limit}  ${run.objective}\n`,
				);
			}
			return;
		}

		if (action === "inspect") {
			if (!args.subject) throw new Error("omg harness inspect requires a run id");
			const state = await readRunState(args.subject);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				return;
			}
			process.stdout.write(`run ${state.runId}\nstatus ${state.status}\nverdict ${state.verdict ?? "(pending)"}\n`);
			process.stdout.write(`template ${normalizeHarnessTemplate(state.template) ?? "(none)"}\n`);
			process.stdout.write(`prompt budget ${state.promptBudget.used}/${state.promptBudget.limit}\n\n`);
			process.stdout.write("gates\n");
			for (const gate of state.gates ?? []) {
				process.stdout.write(`- ${gate.id}: ${gate.status}${gate.error ? ` - ${gate.error}` : ""}\n`);
			}
			process.stdout.write("\nworkers\n");
			for (const worker of state.workers) {
				process.stdout.write(
					`- ${worker.role}: ${worker.workerId ?? "(unassigned)"} ${worker.conversationUrl ?? ""}\n`.trimEnd() +
						"\n",
				);
			}
			process.stdout.write("\nartifacts\n");
			for (const artifact of getCurrentHarnessArtifacts(state)) {
				const line = `- ${artifact.source}: ${artifact.path} ${artifact.sha256 ?? ""}`.trimEnd();
				process.stdout.write(`${line}\n`);
			}
			process.stdout.write("\ncurrent validation\n");
			for (const validation of getCurrentHarnessValidation(state)) {
				process.stdout.write(
					`- ${validation.status}: ${validation.summary}${validation.command ? ` (${validation.command})` : ""}\n`,
				);
			}
			if (state.validation.length > getCurrentHarnessValidation(state).length) {
				process.stdout.write(
					`\n${state.validation.length - getCurrentHarnessValidation(state).length} older validation entries retained in run.json\n`,
				);
			}
			return;
		}

		if (action === "export") {
			if (!args.subject) throw new Error("omg harness export requires a run id");
			const state = await readRunState(args.subject);
			const report = await writeReport(state);
			if (flags.json) process.stdout.write(`${JSON.stringify({ run: state, report }, null, 2)}\n`);
			else process.stdout.write(`${report}\n`);
			return;
		}

		if (action === "cleanup") {
			const runId = flags.run ?? args.subject;
			if (!runId && !flags.stale) throw new Error("omg harness cleanup requires --run <run-id> or --stale");
			const result = await cleanupHarnessRuns({ runId, stale: flags.stale });
			if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else process.stdout.write(`cleaned ${result.cleaned.length} worker(s)\n`);
			return;
		}

		if (action === "skills") {
			const skillAction = args.subject;
			const skill = args.value;
			if (skillAction !== "validate" && skillAction !== "bundle") {
				throw new Error("omg harness skills requires 'validate' or 'bundle'");
			}
			if (!skill) throw new Error("omg harness skills requires a skill name");
			if (skillAction === "validate") {
				const validation = await validateChatGptSkill(skill);
				if (flags.json) process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
				else {
					process.stdout.write(`${validation.ok ? "ok" : "invalid"} ${validation.skillDir}\n`);
					for (const finding of validation.findings) process.stdout.write(`- ${finding}\n`);
				}
				if (!validation.ok) process.exitCode = 1;
				return;
			}
			const bundle = await bundleChatGptSkill(skill);
			if (flags.json) process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
			else process.stdout.write(`${bundle.zipPath}\n`);
		}
	}
}
