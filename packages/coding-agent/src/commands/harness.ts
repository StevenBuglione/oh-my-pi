import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";
import {
	buildEvidencePacket,
	bundleChatGptSkill,
	cleanupHarnessRuns,
	createHarnessRun,
	getHarnessRunDir,
	listHarnessRuns,
	readRunState,
	resumeArtifactProjectHarness,
	resumeWikiMachineHarness,
	runArtifactProjectHarness,
	runHarnessDoctor,
	runWikiMachineHarness,
	validateChatGptSkill,
	writeReport,
} from "../harness";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["run", "resume", "status", "inspect", "export", "skills", "doctor", "cleanup"] as const;

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
		template: Flags.string({ description: "Harness workflow template", default: "artifact-project" }),
		run: Flags.string({ description: "Harness run id for cleanup" }),
		stale: Flags.boolean({ description: "Clean up stale run-scoped workers" }),
	};

	static examples = [
		'# Start a harness run\n  omg harness run "build a small validated tool"',
		"# List harness runs\n  omg harness status",
		"# Resume a failed or interrupted live run\n  omg harness resume <run-id>",
		"# Inspect a run ledger\n  omg harness inspect <run-id>",
		"# Export a run report\n  omg harness export <run-id>",
		"# Clean up run-scoped workers\n  omg harness cleanup --run <run-id>",
		"# Validate or bundle a ChatGPT worker skill\n  omg harness skills validate critic-review\n  omg harness skills bundle artifact-builder",
		"# Check live harness prerequisites\n  omg harness doctor",
		'# Run the live artifact-project workflow\n  omg harness run --live --template artifact-project "build a small validated tool"',
		'# Run the live wiki-machine workflow\n  omg harness run --live --template wiki-machine "build a local AI wiki proof"',
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
			if (!objective) throw new Error("omg harness run requires an objective");
			if (flags.live) {
				if (flags.template !== "artifact-project" && flags.template !== "wiki-machine") {
					throw new Error("supported live harness templates: artifact-project, wiki-machine");
				}
				const runTemplate = flags.template === "wiki-machine" ? runWikiMachineHarness : runArtifactProjectHarness;
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
			const template =
				flags.template === "artifact-project" || flags.template === "wiki-machine" ? flags.template : undefined;
			const state = await createHarnessRun(objective, { promptLimit: flags.limit, template });
			const packet = await buildEvidencePacket({
				runId: state.runId,
				objective,
				role: template === "wiki-machine" ? "wiki-architect" : (flags.role ?? "planner"),
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
				existing.template === "wiki-machine" ? resumeWikiMachineHarness : resumeArtifactProjectHarness;
			const state = await resumeTemplate(args.subject, {
				promptLimit: flags.limit,
				files: flags.file ?? [],
				onEvent: flags.json ? undefined : message => process.stdout.write(`${message}\n`),
			});
			if (flags.json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
			else process.stdout.write(`${state.status} harness run ${state.runId}\n${getHarnessRunDir(state.runId)}\n`);
			return;
		}

		if (action === "doctor") {
			const requiredSkills =
				flags.template === "wiki-machine" ? ["wiki-architect", "wiki-builder", "wiki-critic"] : undefined;
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
			for (const artifact of state.artifacts) {
				const line = `- ${artifact.source}: ${artifact.path} ${artifact.sha256 ?? ""}`.trimEnd();
				process.stdout.write(`${line}\n`);
			}
			process.stdout.write("\nvalidation\n");
			for (const validation of state.validation) {
				process.stdout.write(
					`- ${validation.status}: ${validation.summary}${validation.command ? ` (${validation.command})` : ""}\n`,
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
