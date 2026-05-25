import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";
import {
	runHarnessBenchmark,
	runWikiResearchPublishVerification,
	runWikiResearchQueue,
	runWikiResearchWatchdog,
	syncWikiResearchIssueLabels,
} from "../harness";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["run-queue", "autopilot", "verify-publish", "labels", "benchmark", "watchdog"] as const;

export function parseWikiResearchRepoFlag(value: unknown): string[] | undefined {
	if (!value) return undefined;
	const raw = Array.isArray(value) ? value.join(",") : String(value);
	const repos = raw
		.split(/[,\s]+/)
		.map(repo => repo.trim())
		.filter(Boolean);
	return repos.length ? repos : undefined;
}

export default class WikiResearch extends Command {
	static description = "Run unattended OMG wiki research queues";

	static args = {
		action: Args.string({ description: "Wiki research action", required: false, options: ACTIONS }),
		subject: Args.string({ description: "Optional sub-action", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		owner: Flags.string({ description: "GitHub owner/org" }),
		repo: Flags.string({ description: "Single GitHub repository to target" }),
		issue: Flags.string({ description: "GitHub issue number or URL for verify-publish" }),
		repos: Flags.string({ description: "Comma-separated GitHub repositories to target" }),
		steering: Flags.string({ description: "Path to wiki.steering.json" }),
		registry: Flags.string({ description: "Path to wiki-data-registry sources.json" }),
		apply: Flags.boolean({ description: "Apply GitHub mutations" }),
		"auto-merge": Flags.string({ description: "Auto-merge policy: off or safe", default: "off" }),
		researcher: Flags.string({ description: "Research backend: chatgpt or deterministic" }),
		"allow-deterministic-fallback": Flags.boolean({
			description: "Allow deterministic research fallback if ChatGPT fails",
		}),
		"max-issues": Flags.integer({ description: "Maximum queued issues to process", default: 1 }),
		"publish-attempts": Flags.integer({ description: "Maximum publish verification retry attempts", default: 12 }),
		"interval-seconds": Flags.integer({
			description: "Autopilot sleep interval between queue cycles",
			default: 3600,
		}),
		cycles: Flags.integer({ description: "Autopilot cycles to run before exiting; omit for 24/7" }),
		"local-model-endpoint": Flags.string({
			description: "OpenAI-compatible local watchdog endpoint",
			default: "http://10.10.10.8:8090/v1",
		}),
		"local-model": Flags.string({
			description: "Local watchdog model name",
			default: "qwen3.6-35b-a3b-mtp-q4k-xl",
		}),
		summary: Flags.boolean({ description: "Print compact benchmark summary" }),
	};

	static examples = [
		"# Start the self-sufficient 24/7 wiki autopilot\n  omg wiki-research autopilot --apply --auto-merge=safe --owner StevenBuglione --researcher=chatgpt",
		"# Run the 24/7 wiki research queue safely\n  omg wiki-research run-queue --apply --auto-merge=safe --owner StevenBuglione",
		"# Retry a post-merge publish verification\n  omg wiki-research verify-publish --apply --owner StevenBuglione --repo wiki-data-projects --issue 5 --json",
		"# Sync labels for a wiki repo\n  omg wiki-research labels sync --apply --owner StevenBuglione --repo wiki-data-homelab",
		"# Run the daily harness benchmark\n  omg wiki-research benchmark --summary",
		"# Run the Qwen-only operational watchdog\n  omg wiki-research watchdog --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(WikiResearch);
		await initTheme();
		const action = args.action as (typeof ACTIONS)[number] | undefined;
		if (!action) {
			renderCommandHelp("omg", "wiki-research", WikiResearch);
			return;
		}

		if (action === "labels") {
			if (args.subject !== "sync") throw new Error("supported labels command: omg wiki-research labels sync");
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
			const result = await runHarnessBenchmark({ template: "all" });
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else if (flags.summary) {
				process.stdout.write(`benchmark ${result.ok ? "pass" : "fail"} ${result.benchmarkId}\n`);
				process.stdout.write(`${result.reportPath}\n`);
			} else {
				process.stdout.write(`benchmark ${result.ok ? "pass" : "fail"} ${result.benchmarkId}\n`);
				for (const scenario of result.scenarios) {
					process.stdout.write(`${scenario.ok ? "ok" : "fail"}  ${scenario.id}\n`);
				}
				process.stdout.write(`${result.reportPath}\n`);
			}
			if (!result.ok) process.exitCode = 1;
			return;
		}

		if (action === "watchdog") {
			const result = await runWikiResearchWatchdog({
				localModelBaseUrl: flags["local-model-endpoint"],
				localModel: flags["local-model"],
			});
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else {
				process.stdout.write(`wiki research watchdog ${result.health.status}\n`);
				for (const finding of result.health.findings) process.stdout.write(`- ${finding}\n`);
			}
			if (!result.health.ok) process.exitCode = 1;
			return;
		}

		if (action === "verify-publish") {
			const result = await runWikiResearchPublishVerification({
				owner: flags.owner,
				repo: flags.repo,
				issue: flags.issue ?? args.subject,
				steeringPath: flags.steering,
				registryPath: flags.registry,
				apply: flags.apply,
				publishVerificationAttempts: flags["publish-attempts"],
			});
			if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				process.stdout.write(`wiki publish verification ${result.status} ${result.repo}#${result.issueNumber}\n`);
				if (result.liveUrl) process.stdout.write(`${result.liveUrl}\n`);
			}
			if (result.status !== "verified") process.exitCode = 1;
			return;
		}

		const autoMerge = flags["auto-merge"] === "safe" ? "safe" : "off";
		const researcher =
			flags.researcher === "chatgpt" || flags.researcher === "deterministic" ? flags.researcher : undefined;
		if (flags.researcher && !researcher) throw new Error("--researcher must be chatgpt or deterministic");
		const repos = flags.repo ? [flags.repo] : parseWikiResearchRepoFlag(flags.repos);
		const onEvent = (message: string) => {
			if (flags.json) process.stderr.write(`${JSON.stringify({ type: "wiki-research-event", message })}\n`);
			else process.stdout.write(`${message}\n`);
		};
		if (action === "autopilot") {
			let cycle = 0;
			const maxCycles = flags.cycles && flags.cycles > 0 ? flags.cycles : undefined;
			while (!maxCycles || cycle < maxCycles) {
				cycle += 1;
				const result = await runWikiResearchQueue({
					owner: flags.owner,
					repos,
					steeringPath: flags.steering,
					registryPath: flags.registry,
					apply: flags.apply,
					autoMerge,
					researcher: researcher ?? "chatgpt",
					allowDeterministicFallback: flags["allow-deterministic-fallback"],
					maxIssues: flags["max-issues"],
					seedWhenEmpty: true,
					onEvent,
				});
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ cycle, result }, null, 2)}\n`);
				} else {
					process.stdout.write(
						`wiki autopilot cycle ${cycle}: processed ${result.processed.length}/${result.scanned}; blocked ${result.blocked.length}\n`,
					);
					if (result.seeded) {
						process.stdout.write(
							`- seeded ${result.seeded.repo}#${result.seeded.issueNumber}: ${result.seeded.title}\n`,
						);
					}
					for (const item of result.processed) {
						process.stdout.write(
							`- ${item.repo}#${item.issueNumber}: ${item.status}${item.prUrl ? ` ${item.prUrl}` : ""}${item.liveUrl ? ` ${item.liveUrl}` : ""}\n`,
						);
					}
					for (const item of result.blocked) process.stdout.write(`- blocked ${item.repo}: ${item.reason}\n`);
				}
				if (maxCycles && cycle >= maxCycles) break;
				await new Promise(resolve => setTimeout(resolve, Math.max(30, flags["interval-seconds"]) * 1000));
			}
			return;
		}
		const result = await runWikiResearchQueue({
			owner: flags.owner,
			repos,
			steeringPath: flags.steering,
			registryPath: flags.registry,
			apply: flags.apply,
			autoMerge,
			researcher,
			allowDeterministicFallback: flags["allow-deterministic-fallback"],
			maxIssues: flags["max-issues"],
			onEvent,
		});
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			process.stdout.write(
				`wiki research queue processed ${result.processed.length}/${result.scanned} queued issue(s); blocked ${result.blocked.length}\n`,
			);
			for (const item of result.processed) {
				process.stdout.write(
					`- ${item.repo}#${item.issueNumber}: ${item.status}${item.prUrl ? ` ${item.prUrl}` : ""}${item.liveUrl ? ` ${item.liveUrl}` : ""}\n`,
				);
			}
			for (const item of result.blocked) process.stdout.write(`- blocked ${item.repo}: ${item.reason}\n`);
		}
		if (result.blocked.length && !result.processed.length) process.exitCode = 1;
	}
}
