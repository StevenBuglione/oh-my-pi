import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";
import {
	buildEvidencePacket,
	bundleChatGptSkill,
	createHarnessRun,
	getHarnessRunDir,
	listHarnessRuns,
	readRunState,
	validateChatGptSkill,
	writeReport,
} from "../harness";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["run", "status", "export", "skills"] as const;

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
	};

	static examples = [
		'# Start a harness run\n  omg harness run "build a small validated tool"',
		"# List harness runs\n  omg harness status",
		"# Export a run report\n  omg harness export <run-id>",
		"# Validate or bundle a ChatGPT worker skill\n  omg harness skills validate critic-review\n  omg harness skills bundle artifact-builder",
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
			const state = await createHarnessRun(objective, { promptLimit: flags.limit });
			const packet = await buildEvidencePacket({
				runId: state.runId,
				objective,
				role: flags.role ?? "planner",
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

		if (action === "export") {
			if (!args.subject) throw new Error("omg harness export requires a run id");
			const state = await readRunState(args.subject);
			const report = await writeReport(state);
			if (flags.json) process.stdout.write(`${JSON.stringify({ run: state, report }, null, 2)}\n`);
			else process.stdout.write(`${report}\n`);
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
