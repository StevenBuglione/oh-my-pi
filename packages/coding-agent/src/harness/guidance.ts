import { getCurrentHarnessValidation } from "./storage";
import type { HarnessRunState } from "./types";
import { normalizeHarnessTemplate } from "./types";

export const WIKI_IMPLEMENTATION_LADDER = [
	{
		level: 1,
		id: "local-artifact",
		title: "Local wiki artifact",
		description: "Produce a downloadable local wiki workspace with AI_WIKI_MANIFEST.json and smoke validation.",
	},
	{
		level: 2,
		id: "pagefind-ready-contracts",
		title: "Pagefind-ready data contracts",
		description:
			"Add generated registry, manifest, catalog, tags, health, agent chunks, and Pagefind-ready metadata.",
	},
	{
		level: 3,
		id: "docusaurus-shell-smoke",
		title: "Docusaurus shell smoke test",
		description: "Add a local shell test proving the wiki reader can load registry and render a source page.",
	},
	{
		level: 4,
		id: "repo-patch-mode",
		title: "Validated repo patch mode",
		description: "Use ChatGPT workers for artifacts/patches while local OMG applies changes and owns tests.",
	},
	{
		level: 5,
		id: "multi-repo-scaffold",
		title: "Multi-repo scaffold plan",
		description: "Generate a gated plan for wiki-site, wiki-data-registry, and wiki-data-* repositories.",
	},
] as const;

export interface HarnessNextAction {
	runId: string;
	status: HarnessRunState["status"];
	template: string;
	currentGate?: string;
	blocker?: string;
	command: string;
	reason: string;
	wikiLadder?: typeof WIKI_IMPLEMENTATION_LADDER;
}

export function getHarnessNextAction(state: HarnessRunState): HarnessNextAction {
	const template = normalizeHarnessTemplate(state.template) ?? state.template ?? "(none)";
	const failedGate = state.gates?.find(gate => gate.status === "failed");
	const runningGate = state.gates?.find(gate => gate.status === "running");
	const pendingGate = state.gates?.find(gate => gate.status === "pending");
	const latestFailure = getCurrentHarnessValidation(state).findLast(entry => entry.status === "failed");
	const blocker = failedGate?.error ?? latestFailure?.summary;
	const promptExhausted = state.promptBudget.used >= state.promptBudget.limit;
	const nextLimit = promptExhausted ? Math.max(state.promptBudget.limit + 3, 10) : state.promptBudget.limit;

	if (state.status === "good_enough") {
		return {
			runId: state.runId,
			status: state.status,
			template,
			command: `omg harness export ${state.runId}`,
			reason: "Run is good_enough; export the report or clean up run-scoped workers.",
			wikiLadder: template === "wiki" ? WIKI_IMPLEMENTATION_LADDER : undefined,
		};
	}

	if (state.status === "abandoned") {
		return {
			runId: state.runId,
			status: state.status,
			template,
			command: `omg harness inspect ${state.runId}`,
			reason: "Run is abandoned; inspect it for evidence, then start a new run if needed.",
			wikiLadder: template === "wiki" ? WIKI_IMPLEMENTATION_LADDER : undefined,
		};
	}

	return {
		runId: state.runId,
		status: state.status,
		template,
		currentGate: failedGate?.id ?? runningGate?.id ?? pendingGate?.id,
		blocker,
		command: promptExhausted
			? `omg harness resume ${state.runId} --limit ${nextLimit}`
			: `omg harness resume ${state.runId}`,
		reason: promptExhausted
			? "Prompt budget is exhausted; resume with a larger explicit limit after reviewing the blocker."
			: "Run is not complete; resume starts at the first failed or incomplete gate.",
		wikiLadder: template === "wiki" ? WIKI_IMPLEMENTATION_LADDER : undefined,
	};
}
