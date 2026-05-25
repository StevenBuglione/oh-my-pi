import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { type ChatGptWorkerCommand, type ChatGptWorkerCommandResult, runChatGptWorkerCommand } from "./chatgpt-cli";
import { parseChatGptJsonEnvelope } from "./json-contracts";
import {
	bindWorkerRole,
	createHarnessRun,
	ensureHarnessGates,
	getHarnessRunDir,
	readRunState,
	setGateStatus,
	writeReport,
	writeRunFile,
	writeRunState,
} from "./storage";
import {
	type HarnessDoctorCheck,
	type HarnessRunState,
	type WikiContentPlanEnvelope,
	WikiContentPlanEnvelopeSchema,
	type WikiDraftInstructionsEnvelope,
	WikiDraftInstructionsEnvelopeSchema,
	type WikiPageDraftEnvelope,
	WikiPageDraftEnvelopeSchema,
	type WikiResearchBriefEnvelope,
	WikiResearchBriefEnvelopeSchema,
	type WikiResearchReviewEnvelope,
	WikiResearchReviewEnvelopeSchema,
	type WikiSourceDecisionEnvelope,
	WikiSourceDecisionEnvelopeSchema,
} from "./types";

export type WikiResearcherMode = "chatgpt" | "deterministic";
export type WikiResearchWorkerRunner = (input: ChatGptWorkerCommand) => Promise<ChatGptWorkerCommandResult>;

const DEFAULT_QWEN_BASE_URL = "http://10.10.10.8:8090/v1";
const DEFAULT_QWEN_MODEL = "qwen3.6-35b-a3b-mtp-q4k-xl";
const CHATGPT_RESEARCH_MODEL_OPTION = "Pro";
const CHATGPT_RESEARCH_THINKING_OPTION = "Extended";
const CHATGPT_MIN_DEEP_RESEARCH_CITATIONS = 12;
const CHATGPT_MIN_DEEP_RESEARCH_FINDINGS = 12;
const CHATGPT_MIN_DRAFT_SECTIONS = 8;

export const WIKI_RESEARCH_REQUIRED_LABELS = [
	"wiki:research",
	"wiki:queued",
	"wiki:in-progress",
	"wiki:needs-source-decision",
	"wiki:needs-review",
	"wiki:pr-open",
	"wiki:blocked",
	"wiki:merged",
	"wiki:done",
] as const;

type WikiIssueStateLabel = (typeof WIKI_RESEARCH_REQUIRED_LABELS)[number];

interface WikiRegistrySource {
	id: string;
	label: string;
	description?: string;
	enabled?: boolean;
	order?: number;
	latestUrl?: string;
}

interface WikiRegistrySnapshot {
	schemaVersion: string;
	updatedAt?: string;
	routeMode?: string;
	sources: WikiRegistrySource[];
}

interface CandidateSourceDecision {
	action: "use_existing_source" | "needs_source_decision";
	sourceId?: string;
	repoName?: string;
	reason: string;
	score?: number;
	threshold?: number;
	topCandidates?: Array<{ sourceId: string; label: string; score: number }>;
	proposedSourceId?: string;
	proposedRepoName?: string;
}

interface WikiSourceBoundaryDecision {
	schemaVersion: "omg.wiki.source_boundary_decision.v1";
	status: "use_existing_source" | "needs_new_source_review";
	reason: string;
	threshold: number;
	selectedSourceId?: string;
	selectedRepoName?: string;
	proposedSourceId?: string;
	proposedRepoName?: string;
	topCandidates: Array<{ sourceId: string; label: string; score: number }>;
	recommendedNextAction?: string;
	recommendedCommand?: string;
}

export interface WikiResearchIssue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	htmlUrl: string;
	owner: string;
	repo: string;
	createdAt?: string;
}

export interface WikiResearchGitHubClient {
	getAuthenticatedUser(token?: string): Promise<{ login: string }>;
	getRepo(
		token: string | undefined,
		owner: string,
		repo: string,
	): Promise<{ exists: boolean; defaultBranch?: string; sha?: string }>;
	getIssue(token: string | undefined, owner: string, repo: string, issueNumber: number): Promise<WikiResearchIssue>;
	listIssues(token: string | undefined, owner: string, repo: string, labels: string[]): Promise<WikiResearchIssue[]>;
	createIssue(
		token: string,
		input: { owner: string; repo: string; title: string; body: string; labels: string[] },
	): Promise<WikiResearchIssue>;
	commentIssue(
		token: string,
		input: { owner: string; repo: string; issueNumber: number; body: string },
	): Promise<{ htmlUrl?: string }>;
	listIssueComments?(
		token: string | undefined,
		input: { owner: string; repo: string; issueNumber: number },
	): Promise<Array<{ body: string; htmlUrl?: string; createdAt?: string }>>;
	addLabels(
		token: string,
		input: { owner: string; repo: string; issueNumber: number; labels: string[] },
	): Promise<void>;
	removeLabel(
		token: string,
		input: { owner: string; repo: string; issueNumber: number; label: string },
	): Promise<void>;
	ensureLabel(
		token: string,
		input: { owner: string; repo: string; label: string; color: string; description: string },
	): Promise<void>;
	createBranch(
		token: string,
		input: { owner: string; repo: string; branch: string; fromSha: string },
	): Promise<{ ref: string }>;
	putFile(
		token: string,
		input: {
			owner: string;
			repo: string;
			branch: string;
			path: string;
			content: string;
			message: string;
			sha?: string;
		},
	): Promise<{ commitSha: string }>;
	getFile?(
		token: string,
		input: { owner: string; repo: string; branch: string; path: string },
	): Promise<{ sha?: string; content?: string } | undefined>;
	listPullRequests?(
		token: string,
		input: { owner: string; repo: string; head?: string; state?: "open" | "closed" | "all" },
	): Promise<Array<{ number: number; htmlUrl: string; headRef?: string; headSha?: string; mergeableState?: string }>>;
	createPullRequest(
		token: string,
		input: { owner: string; repo: string; title: string; body: string; head: string; base: string },
	): Promise<{ number: number; htmlUrl: string }>;
	listPullRequestFiles?(
		token: string,
		input: { owner: string; repo: string; pullNumber: number },
	): Promise<Array<{ filename: string; status?: string }>>;
	listCheckRunsForRef?(
		token: string,
		input: { owner: string; repo: string; ref: string },
	): Promise<Array<{ name: string; status: string; conclusion?: string | null; htmlUrl?: string }>>;
	mergePullRequest?(
		token: string,
		input: { owner: string; repo: string; pullNumber: number; commitTitle: string },
	): Promise<{ merged: boolean; message?: string; sha?: string }>;
	closeIssue?(token: string, input: { owner: string; repo: string; issueNumber: number }): Promise<void>;
	listWorkflowRuns?(
		token: string | undefined,
		input: { owner: string; repo: string; headSha?: string; workflowName?: string; event?: string },
	): Promise<Array<{ name: string; status: string; conclusion?: string | null; headSha?: string; htmlUrl?: string }>>;
	compareCommits?(
		token: string | undefined,
		input: { owner: string; repo: string; base: string; head: string },
	): Promise<{ status?: string }>;
}

export interface WikiResearchOptions {
	owner?: string;
	repo?: string;
	issue?: string;
	fromIssues?: boolean;
	steeringPath?: string;
	registryPath?: string;
	apply?: boolean;
	autoMerge?: "off" | "safe";
	researcher?: WikiResearcherMode;
	allowDeterministicFallback?: boolean;
	promptLimit?: number;
	githubToken?: string;
	githubClient?: WikiResearchGitHubClient;
	workerRunner?: WikiResearchWorkerRunner;
	fetchImpl?: typeof fetch;
	publishVerificationAttempts?: number;
	publishVerificationDelayMs?: number;
	onEvent?: (message: string) => void;
}

export interface WikiResearchQueueOptions extends WikiResearchOptions {
	repos?: string[];
	maxIssues?: number;
	seedWhenEmpty?: boolean;
}

export interface WikiResearchQueueRunResult {
	schemaVersion: "omg.wiki.research_queue_run.v1";
	owner: string;
	repos: string[];
	startedAt: string;
	finishedAt: string;
	apply: boolean;
	autoMerge: "off" | "safe";
	researcher: WikiResearcherMode;
	scanned: number;
	seeded?: {
		repo: string;
		issueNumber: number;
		issueUrl: string;
		title: string;
		sourceId: string;
	};
	processed: Array<{
		repo: string;
		issueNumber: number;
		issueUrl: string;
		runId?: string;
		status: "good_enough" | "blocked";
		prUrl?: string;
		liveUrl?: string;
		workerId?: string;
		requestId?: string;
		conversationUrl?: string;
		schemaValidation?: "passed" | "failed" | "skipped";
		citationCount?: number;
		error?: string;
	}>;
	blocked: Array<{ repo: string; issueNumber?: number; reason: string }>;
}

export interface WikiPublishRetryResult {
	schemaVersion: "omg.wiki.publish_retry.v1";
	owner: string;
	repo: string;
	issueNumber: number;
	issueUrl?: string;
	status: "verified" | "blocked";
	prUrl?: string;
	runId?: string;
	mergeSha?: string;
	liveUrl?: string;
	verificationReportPath?: string;
	verification: WikiPublishVerificationResult;
}

export interface WikiResearchWatchdogOptions extends WikiResearchOptions {
	localModelBaseUrl?: string;
	localModel?: string;
	now?: Date;
	fetchImpl?: typeof fetch;
	automationsDir?: string;
	chatGptRateLimitRunner?: () => Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }>;
}

export interface WikiResearchWatchdogResult {
	schemaVersion: "omg.wiki.watchdog.v1";
	checkedAt: string;
	localModel: {
		baseUrl: string;
		model: string;
		modelsOk: boolean;
		pingOk: boolean;
		schemaValidation: "passed" | "failed" | "skipped";
		error?: string;
	};
	chatgpt: {
		rateLimitOk: boolean;
		error?: string;
	};
	automation: {
		queueActive: boolean;
		benchmarkActive: boolean;
		watchdogActive: boolean;
	};
	health: {
		ok: boolean;
		status: "healthy" | "warning" | "critical";
		findings: string[];
		recommendedActions: string[];
	};
}

interface WikiResearchDecisionPackage {
	sourceDecision: WikiSourceDecisionEnvelope;
	research: WikiResearchBriefEnvelope;
	contentPlan: WikiContentPlanEnvelope;
	draftInstructions: WikiDraftInstructionsEnvelope;
	criticReview: WikiResearchReviewEnvelope;
	responsePaths: string[];
	requestId?: string;
	conversationUrl?: string;
}

interface WikiPublishVerificationResult {
	ok: boolean;
	expectedCommit?: string;
	latestUrl: string;
	latestAgentUrl: string;
	workflowUrl?: string;
	warnings: string[];
	attempts: Array<{
		attempt: number;
		ok: boolean;
		errors: string[];
		warnings: string[];
		githubLatestCommit?: string;
		githubAgentCommit?: string;
		cdnLatestCommit?: string;
		cdnAgentCommit?: string;
		cdnLatestCommits?: Record<string, string | undefined>;
		cdnAgentCommits?: Record<string, string | undefined>;
		checkedUrls: string[];
	}>;
	errors: string[];
	checkedUrls: string[];
}

export interface WikiResearchIssueBody {
	objective: string;
	expectedOutput?: string;
	constraints: string[];
	preferredSource?: string;
	acceptanceNotes: string[];
	citations: string[];
}

interface WikiResearchSteering {
	owner?: string;
	registryPath?: string;
	registryRepo?: string;
	branchPrefix: string;
	prLabels: string[];
	maxIssuesPerRun: number;
	maxPagesPerIssue: number;
	blockedDomains: string[];
	closeBehavior: "after_pr_merge" | "manual";
	sourceMatchThreshold: number;
}

const DEFAULT_STEERING: WikiResearchSteering = {
	branchPrefix: "omg/wiki-research",
	prLabels: ["wiki:needs-review"],
	maxIssuesPerRun: 1,
	maxPagesPerIssue: 1,
	blockedDomains: [],
	closeBehavior: "after_pr_merge",
	sourceMatchThreshold: 0.16,
};

const STATE_LABELS: WikiIssueStateLabel[] = [
	"wiki:queued",
	"wiki:in-progress",
	"wiki:needs-source-decision",
	"wiki:needs-review",
	"wiki:pr-open",
	"wiki:blocked",
	"wiki:merged",
	"wiki:done",
];

function emit(options: WikiResearchOptions, message: string): void {
	options.onEvent?.(message);
}

function effectiveResearcher(options: WikiResearchOptions): WikiResearcherMode {
	return options.researcher ?? (options.apply ? "chatgpt" : "deterministic");
}

function safeJson(raw: string): any {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function firstWorkerId(raw: string): string | undefined {
	const parsed = safeJson(raw);
	if (Array.isArray(parsed)) return parsed.find(item => typeof item?.worker_id === "string")?.worker_id;
	if (typeof parsed?.worker_id === "string") return parsed.worker_id;
	return undefined;
}

function responseMeta(raw: string): { requestId?: string; conversationUrl?: string } {
	const parsed = safeJson(raw);
	return {
		requestId: typeof parsed?.request_id === "string" ? parsed.request_id : parsed?.last_request_id,
		conversationUrl: typeof parsed?.conversation_url === "string" ? parsed.conversation_url : undefined,
	};
}

function modelSelectionFailed(result: ChatGptWorkerCommandResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
	return (
		text.includes("model") ||
		text.includes("thinking") ||
		text.includes("option") ||
		text.includes("not available") ||
		text.includes("unable to select")
	);
}

async function consumePromptBudget(state: HarnessRunState, role: string): Promise<void> {
	if (state.promptBudget.used >= state.promptBudget.limit) {
		throw new Error(`prompt budget exhausted before ${role} prompt`);
	}
	state.promptBudget.used += 1;
	await writeRunState(state);
}

async function startGate(state: HarnessRunState, id: string, options: WikiResearchOptions): Promise<void> {
	emit(options, `running ${id}`);
	await setGateStatus(state, id, "running");
}

async function passGate(
	state: HarnessRunState,
	id: string,
	options: WikiResearchOptions,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `passed ${id}`);
	await setGateStatus(state, id, "passed", fields);
}

async function failGate(
	state: HarnessRunState,
	id: string,
	options: WikiResearchOptions,
	error: string,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `failed ${id}: ${error}`);
	await setGateStatus(state, id, "failed", { ...fields, error });
}

async function skipGate(
	state: HarnessRunState,
	id: string,
	options: WikiResearchOptions,
	summary: string,
): Promise<void> {
	emit(options, `skipped ${id}: ${summary}`);
	await setGateStatus(state, id, "skipped", { summary });
}

function getGitHubToken(options: WikiResearchOptions): string | undefined {
	return options.githubToken ?? Bun.env.GITHUB_TOKEN ?? Bun.env.GITHUB_PAT;
}

async function readPreviousIssueArtifact(runId: string): Promise<WikiResearchIssue | undefined> {
	try {
		const issuePath = path.join(getHarnessRunDir(runId), "artifacts", "issue.json");
		const parsed = JSON.parse(await fs.readFile(issuePath, "utf8")) as Partial<WikiResearchIssue>;
		if (
			typeof parsed.number === "number" &&
			parsed.number > 0 &&
			typeof parsed.title === "string" &&
			typeof parsed.body === "string" &&
			Array.isArray(parsed.labels) &&
			typeof parsed.owner === "string" &&
			typeof parsed.repo === "string"
		) {
			return {
				number: parsed.number,
				title: parsed.title,
				body: parsed.body,
				labels: parsed.labels.filter((label): label is string => typeof label === "string"),
				htmlUrl: typeof parsed.htmlUrl === "string" ? parsed.htmlUrl : "",
				owner: parsed.owner,
				repo: parsed.repo,
				createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function redactedTokenCheck(token: string | undefined, apply: boolean): HarnessDoctorCheck {
	return {
		id: "github_token",
		label: "GitHub token",
		ok: Boolean(token) || !apply,
		blocking: apply,
		summary: token
			? "GitHub token is present (value redacted)"
			: apply
				? "Set GITHUB_TOKEN or GITHUB_PAT before --apply"
				: "Not required for dry-run; public issues may still be readable without a token",
	};
}

function githubHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function parseIssueRef(
	ref: string,
	defaults: { owner?: string; repo?: string },
): { owner: string; repo: string; number: number } {
	const urlMatch = ref.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
	if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: Number(urlMatch[3]) };
	const qualified = ref.match(/^([^/]+)\/([^/#]+)#?(\d+)$/);
	if (qualified) return { owner: qualified[1]!, repo: qualified[2]!, number: Number(qualified[3]) };
	if (/^\d+$/.test(ref) && defaults.owner && defaults.repo) {
		return { owner: defaults.owner, repo: defaults.repo, number: Number(ref) };
	}
	throw new Error("issue must be a GitHub issue URL, owner/repo#number, or number with --owner and --repo");
}

function section(body: string, name: string): string | undefined {
	const pattern = new RegExp(`(?:^|\\n)#{2,3}\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s+|$)`, "i");
	const match = body.match(pattern);
	return match?.[1]?.trim();
}

function lines(value: string | undefined): string[] {
	return (value ?? "")
		.split(/\r?\n/)
		.map(line => line.replace(/^[-*]\s+/, "").trim())
		.filter(Boolean);
}

function urls(value: string): string[] {
	return [...value.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(match => match[0]!);
}

export function parseWikiResearchIssueBody(issue: Pick<WikiResearchIssue, "title" | "body">): WikiResearchIssueBody {
	const objective = section(issue.body, "Objective") ?? issue.title;
	const expectedOutput = section(issue.body, "Expected output");
	const constraints = lines(section(issue.body, "Constraints"));
	const preferredSource = section(issue.body, "Preferred source")?.split(/\s+/)[0];
	const acceptanceNotes = lines(section(issue.body, "Acceptance"));
	const citations = urls(issue.body);
	return { objective, expectedOutput, constraints, preferredSource, acceptanceNotes, citations };
}

function words(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/[\s-]+/)
		.filter(word => word.length > 2)
		.filter(
			word =>
				![
					"wiki",
					"research",
					"topic",
					"notes",
					"page",
					"create",
					"source",
					"http",
					"https",
					"www",
					"docs",
				].includes(word),
		);
}

function slugify(value: string): string {
	return words(value).slice(0, 5).join("-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "research-note";
}

function normalizeResearchTitle(title: string): string {
	return title
		.replace(/^\[[^\]]+\]\s*/, "")
		.replace(/^canary:\s*/i, "")
		.trim();
}

function stableDraftPath(issue: WikiResearchIssue): string {
	return `docs/${slugify(normalizeResearchTitle(issue.title))}.md`;
}

function proposedSourceId(issue: WikiResearchIssue, body: WikiResearchIssueBody): string {
	const preferred = sourceFromLabels(issue.labels) ?? body.preferredSource;
	if (preferred) return slugify(preferred.replace(/^wiki-data-/i, ""));
	const tokens = words(`${body.objective} ${issue.title}`).filter(
		word =>
			![
				"and",
				"for",
				"from",
				"in",
				"of",
				"the",
				"to",
				"wiki",
				"research",
				"page",
				"notes",
				"guide",
				"basics",
				"starter",
				"create",
				"content",
			].includes(word),
	);
	return slugify(tokens.slice(0, 4).join("-") || normalizeResearchTitle(issue.title));
}

function similarity(leftWords: string[], rightWords: string[]): number {
	if (!leftWords.length || !rightWords.length) return 0;
	const left = new Set(leftWords);
	const right = new Set(rightWords);
	const intersection = [...left].filter(word => right.has(word)).length;
	const union = new Set([...left, ...right]).size;
	return union ? intersection / union : 0;
}

function sourceTokens(source: WikiRegistrySource): string[] {
	return words([source.id, source.label, source.description ?? ""].join(" "));
}

function sourceFromLabels(labels: string[]): string | undefined {
	const label = labels.find(item => item.startsWith("source:"));
	return label?.slice("source:".length);
}

function decideSource(
	issue: WikiResearchIssue,
	body: WikiResearchIssueBody,
	registry: WikiRegistrySnapshot,
	steering: WikiResearchSteering,
): CandidateSourceDecision {
	const preferred = sourceFromLabels(issue.labels) ?? body.preferredSource;
	if (preferred && registry.sources.some(source => source.id === preferred)) {
		return {
			action: "use_existing_source",
			sourceId: preferred,
			repoName: `wiki-data-${preferred}`,
			reason: `Preferred source ${preferred} is registered.`,
			score: 1,
			threshold: steering.sourceMatchThreshold,
		};
	}
	const objectiveWords = words(body.objective);
	const ranked = registry.sources
		.map(source => ({ source, score: similarity(objectiveWords, sourceTokens(source)) }))
		.sort((a, b) => b.score - a.score);
	const best = ranked[0];
	const topCandidates = ranked.slice(0, 3).map(item => ({
		sourceId: item.source.id,
		label: item.source.label,
		score: Number(item.score.toFixed(3)),
	}));
	if (best && best.score >= steering.sourceMatchThreshold) {
		return {
			action: "use_existing_source",
			sourceId: best.source.id,
			repoName: `wiki-data-${best.source.id}`,
			reason: `Issue overlaps existing source ${best.source.id} with score ${best.score.toFixed(2)}.`,
			score: Number(best.score.toFixed(3)),
			threshold: steering.sourceMatchThreshold,
			topCandidates,
		};
	}
	const sourceId = proposedSourceId(issue, body);
	return {
		action: "needs_source_decision",
		reason: best
			? `No registered source reached the match threshold ${steering.sourceMatchThreshold}; best candidate ${best.source.id} scored ${best.score.toFixed(2)}.`
			: "No registered sources are available for this issue.",
		score: best ? Number(best.score.toFixed(3)) : 0,
		threshold: steering.sourceMatchThreshold,
		topCandidates,
		proposedSourceId: sourceId,
		proposedRepoName: `wiki-data-${sourceId}`,
	};
}

function sourceBoundaryDecision(
	owner: string,
	issue: WikiResearchIssue,
	body: WikiResearchIssueBody,
	candidate: CandidateSourceDecision,
): WikiSourceBoundaryDecision {
	if (candidate.action === "use_existing_source") {
		return {
			schemaVersion: "omg.wiki.source_boundary_decision.v1",
			status: "use_existing_source",
			reason: candidate.reason,
			threshold: candidate.threshold ?? DEFAULT_STEERING.sourceMatchThreshold,
			selectedSourceId: candidate.sourceId,
			selectedRepoName: candidate.repoName,
			topCandidates: candidate.topCandidates ?? [],
		};
	}
	const sourceId = candidate.proposedSourceId ?? proposedSourceId(issue, body);
	const repoName = candidate.proposedRepoName ?? `wiki-data-${sourceId}`;
	return {
		schemaVersion: "omg.wiki.source_boundary_decision.v1",
		status: "needs_new_source_review",
		reason: candidate.reason,
		threshold: candidate.threshold ?? DEFAULT_STEERING.sourceMatchThreshold,
		proposedSourceId: sourceId,
		proposedRepoName: repoName,
		topCandidates: candidate.topCandidates ?? [],
		recommendedNextAction:
			"Open a source-provisioning review for a new public wiki data repository before drafting content.",
		recommendedCommand: `omg harness run --template wiki-source --owner ${owner} --apply ${JSON.stringify(
			`create ${repoName} for ${body.objective}`,
		)}`,
	};
}

async function readRegistrySnapshot(
	options: WikiResearchOptions,
	steering: WikiResearchSteering,
): Promise<{ snapshot: WikiRegistrySnapshot; path: string }> {
	const registryPath =
		options.registryPath ??
		steering.registryPath ??
		(await discoverWikiRegistryFile("sources.json")) ??
		path.join(process.cwd(), "wiki-data-registry", "sources.json");
	const text = await fs.readFile(registryPath, "utf8");
	const parsed = JSON.parse(text) as WikiRegistrySnapshot;
	if (!Array.isArray(parsed.sources)) throw new Error("registry sources must be an array");
	return { snapshot: parsed, path: registryPath };
}

async function loadSteering(
	options: WikiResearchOptions,
): Promise<{ steering: WikiResearchSteering; path?: string; defaulted: boolean }> {
	const steeringPath =
		options.steeringPath ??
		(await discoverWikiRegistryFile("wiki.steering.json")) ??
		path.join(process.cwd(), "wiki.steering.json");
	try {
		const parsed = JSON.parse(await fs.readFile(steeringPath, "utf8")) as Partial<WikiResearchSteering>;
		const registryPath =
			typeof parsed.registryPath === "string" && !path.isAbsolute(parsed.registryPath)
				? path.join(path.dirname(steeringPath), parsed.registryPath)
				: parsed.registryPath;
		return {
			steering: {
				...DEFAULT_STEERING,
				...parsed,
				registryPath,
				prLabels: parsed.prLabels ?? DEFAULT_STEERING.prLabels,
				blockedDomains: parsed.blockedDomains ?? DEFAULT_STEERING.blockedDomains,
			},
			path: steeringPath,
			defaulted: false,
		};
	} catch {
		if (options.apply) throw new Error("wiki.steering.json is required for --apply wiki-research runs");
		return { steering: DEFAULT_STEERING, defaulted: true };
	}
}

async function discoverWikiRegistryFile(fileName: "wiki.steering.json" | "sources.json"): Promise<string | undefined> {
	const roots = [
		process.cwd(),
		path.dirname(process.cwd()),
		path.join(process.cwd(), "wiki-data-registry"),
		path.join(path.dirname(process.cwd()), "wiki-data-registry"),
		path.join(path.dirname(process.cwd()), "wiki-runtime-v1", "wiki-data-registry"),
		path.join(process.cwd(), "wiki-runtime-v1", "wiki-data-registry"),
	];
	for (const root of roots) {
		const candidate = path.join(root, fileName);
		if (await Bun.file(candidate).exists()) return candidate;
	}
	return undefined;
}

function issueStateLabels(next: WikiIssueStateLabel): string[] {
	return ["wiki:research", next];
}

function compactStatusComment(state: HarnessRunState, status: string, details: string): string {
	return [
		`OMG wiki research ${status}`,
		"",
		`Run: ${state.runId}`,
		`Report: ${path.join(getHarnessRunDir(state.runId), "report.md")}`,
		"",
		details,
	].join("\n");
}

function citationSeedUrls(sourceId: string | undefined, topic: string): string[] {
	const topicWords = new Set(words(topic));
	const seeds: Record<string, string[]> = {
		devops: [
			"https://kubernetes.io/docs/home/",
			"https://docs.docker.com/",
			"https://developer.hashicorp.com/terraform/docs",
			"https://docs.github.com/en/actions",
			"https://learn.microsoft.com/en-us/azure/",
		],
		homelab: [
			"https://pve.proxmox.com/pve-docs/",
			"https://openwrt.org/docs/start",
			"https://www.truenas.com/docs/",
			"https://docs.ansible.com/",
			"https://jellyfin.org/docs/",
		],
		projects: [
			"https://docs.github.com/en/issues/planning-and-tracking-with-projects",
			"https://docs.github.com/en/repositories/creating-and-managing-repositories",
			"https://www.markdownguide.org/basic-syntax/",
			"https://www.atlassian.com/agile/project-management",
		],
	};
	const selected = [...(sourceId ? (seeds[sourceId] ?? []) : [])];
	if (topicWords.has("kubernetes")) selected.unshift("https://kubernetes.io/docs/home/");
	if (topicWords.has("backup") || topicWords.has("restore")) selected.unshift("https://velero.io/docs/");
	if (topicWords.has("proxmox")) selected.unshift("https://pve.proxmox.com/pve-docs/");
	if (topicWords.has("github")) selected.unshift("https://docs.github.com/");
	return [...new Set(selected)];
}

function discoverResearchBrief(
	issue: WikiResearchIssue,
	body: WikiResearchIssueBody,
	sourceId: string | undefined,
	steering: WikiResearchSteering,
): WikiResearchBriefEnvelope {
	const discovered = [...body.citations, ...citationSeedUrls(sourceId, `${issue.title} ${body.objective}`)].filter(
		url => {
			try {
				const host = new URL(url).hostname;
				return !steering.blockedDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
			} catch {
				return false;
			}
		},
	);
	const citations = [...new Set(discovered)].slice(0, 6);
	const findings = [
		`Research topic: ${body.objective}`,
		`Target source: ${sourceId ?? "undecided"}`,
		...(body.acceptanceNotes.length ? body.acceptanceNotes : ["Create a starter page with cited public references."]),
	];
	return {
		schema_version: "omg.wiki.research_brief.v1",
		status: citations.length ? "complete" : "blocked",
		topic: body.objective,
		summary: citations.length
			? `Evidence-first starter research for ${issue.title}.`
			: `No acceptable public citations were discovered for ${issue.title}.`,
		citations,
		source_quality: citations.map(url => ({
			url,
			title: new URL(url).hostname,
			source_type: "supporting",
			why_it_matters: "Public seed citation for deterministic wiki research mode.",
		})),
		claim_citations: findings.map((claim, index) => ({
			claim,
			citation_urls: citations.length ? [citations[index % citations.length]] : [],
		})),
		findings,
		reader_takeaways: findings.slice(0, 3),
		confidence: citations.length >= 2 ? 0.78 : citations.length ? 0.62 : 0.15,
	};
}

function wikiResearchBriefPrompt(input: {
	issue: WikiResearchIssue;
	body: WikiResearchIssueBody;
	candidateSourceDecision: CandidateSourceDecision;
	registry: WikiRegistrySnapshot;
	steering: WikiResearchSteering;
}): string {
	const sourceId = input.candidateSourceDecision.sourceId ?? "undecided";
	const repoName = input.candidateSourceDecision.repoName ?? "";
	return [
		"You are the research backend for OMG unattended wiki publishing.",
		"You are running as the Pro Extended research worker. Spend the effort needed to produce a professional reference-quality package, not a thin canary draft.",
		"ChatGPT is the only content decision engine. Local Qwen/watchdog models are not allowed to approve source, draft, critic, merge, or publishing decisions.",
		"A zip file named chatgpt-schema-bundle.zip is attached. Extract it, use the JSON schemas in schemas/, and run validate_schema_package.py against your completed package before you return.",
		"Create and attach a downloadable package containing source-decision.json, research-brief.json, content-plan.json, draft-instructions.json, critic-review.json, and validation.json.",
		"Do not paste any JSON into chat.",
		"Before exiting, validate every JSON file with the attached validator and record the validator result in validation.json.",
		"Your final chat message must contain only the downloadable package/artifact link or a one-line artifact-ready note.",
		"",
		"source-decision.json required schema:",
		JSON.stringify(
			{
				schema_version: "omg.wiki.source_decision.v1",
				status: "complete | blocked | needs_user_decision",
				recommended_action: "use_existing_source | create_new_source | blocked",
				source_id: sourceId,
				repo_name: repoName,
				domain_label: "string",
				reason: "string",
				existing_source_candidates: ["string"],
				confidence: 0.0,
				required_seed_files: ["string"],
			},
			null,
			2,
		),
		"",
		"research-brief.json required schema:",
		JSON.stringify(
			{
				schema_version: "omg.wiki.research_brief.v1",
				status: "complete | blocked | needs_more_context",
				topic: "string",
				summary: "string",
				citations: ["https://public-source.example/path"],
				source_quality: [
					{
						url: "https://public-source.example/path",
						title: "Source title",
						source_type: "official | standards | reference | supporting",
						why_it_matters: "why this source is authoritative for the page",
					},
				],
				claim_citations: [
					{ claim: "specific factual claim", citation_urls: ["https://public-source.example/path"] },
				],
				findings: ["string"],
				reader_takeaways: ["specific practical takeaway for a human reader"],
				confidence: 0.0,
			},
			null,
			2,
		),
		"",
		"content-plan.json required schema:",
		JSON.stringify(
			{
				schema_version: "omg.wiki.content_plan.v1",
				status: "complete | blocked",
				source_id: sourceId,
				pages: [
					{
						title: "string",
						slug: "kebab-or-folder-slug",
						description: "string",
						tags: ["string"],
						reader_value: "what a knowledgeable human reader should learn from this page",
						outline: ["Summary", "Checklist", "Decision Guidance", "Common Pitfalls", "Maintenance Notes"],
					},
				],
			},
			null,
			2,
		),
		"",
		"draft-instructions.json required schema:",
		JSON.stringify(
			{
				schema_version: "omg.wiki.draft_instructions.v1",
				status: "complete | blocked",
				source_id: sourceId,
				path: "docs/topic-slug.md",
				title: "string",
				description: "string",
				tags: ["research", sourceId],
				required_sections: [
					"Summary",
					"Decision Matrix",
					"Reference Architecture",
					"Restore Runbook",
					"Failure Scenarios",
					"Operational Checklist",
					"Common Pitfalls",
					"Maintenance Notes",
					"Sources",
				],
				notes: ["string"],
				sections: [
					{
						heading: "Summary",
						purpose: "reader value of the section",
						paragraphs: [
							"human-readable prose paragraph grounded in cited evidence",
							"second professional-depth paragraph with concrete operational guidance",
						],
						bullets: ["optional practical bullet with inline citation support"],
						citation_urls: ["https://public-source.example/path"],
					},
				],
				confidence: 0.0,
			},
			null,
			2,
		),
		"",
		"critic-review.json required schema:",
		JSON.stringify(
			{
				schema_version: "omg.wiki.research_review.v1",
				approved: true,
				blocking_findings: ["string"],
				non_blocking_findings: ["string"],
				verdict: "good_enough | not_good_enough",
			},
			null,
			2,
		),
		"",
		"Rules:",
		"- Use public, non-credentialed sources only.",
		"- Prefer official vendor, project, standards, or primary documentation.",
		"- Blogs/forums may only support primary sources.",
		"- If you cannot identify acceptable public citations, set status to blocked or needs_more_context.",
		`- For complete status, include at least ${CHATGPT_MIN_DEEP_RESEARCH_CITATIONS} high-quality citation URLs for normal factual pages.`,
		`- Include at least ${CHATGPT_MIN_DEEP_RESEARCH_FINDINGS} substantive findings and claim-level citation mappings.`,
		`- draft-instructions.json must include at least ${CHATGPT_MIN_DRAFT_SECTIONS} full sections with human-readable paragraphs, not placeholder bullets.`,
		"- Each draft section should normally include at least two substantive paragraphs plus practical bullets where useful.",
		"- Target professional reference quality: include decision matrices, tool comparisons, restore runbooks, failure scenarios, sample commands or command templates, storage-driver caveats, RPO/RTO examples, testing checklists, maintenance cadence, and explicit assumptions when relevant.",
		"- Write like an experienced human operator explaining tradeoffs to another practitioner. Avoid filler, vague best practices, marketing language, and unsupported certainty.",
		"- Use concrete examples and operational sequences, but keep commands conservative unless directly supported by official documentation.",
		"- Write section paragraphs as a knowledgeable human would: specific, explanatory, calm, and useful. Avoid generic filler.",
		"- Include source_quality entries for every citation and mark official/project/vendor/standards docs as official or standards.",
		"- Every finding must be specific and supported by claim_citations.",
		"- For every research-brief.findings string, include one claim_citations entry whose claim value is byte-for-byte identical to that finding and whose citation_urls support that finding.",
		"- Prefer official documentation and primary sources; use blogs/forums only as supporting context.",
		"- Do not invent citations, product facts, versions, or dates.",
		"- Plan a page with Summary, Decision Matrix, Reference Architecture, Restore Runbook, Failure Scenarios, Operational Checklist, Common Pitfalls, Maintenance Notes, and Sources unless the issue explicitly asks for a different structure.",
		"- If you agree with the candidate source, set source-decision recommended_action to use_existing_source.",
		"- If the registered candidate source is wrong, set source-decision to blocked or needs_user_decision; do not silently pick a different repo.",
		"- critic-review.json is your ChatGPT preflight approval of the package and planned draft. If citations or source coverage are weak, do not approve.",
		`- Exclude blocked domains: ${input.steering.blockedDomains.length ? input.steering.blockedDomains.join(", ") : "none"}.`,
		"- validation.json must be JSON with ok, schema_version, checked_files, errors, citation_count, worker_id, request_id, and conversation_url fields when available.",
		"",
		"Wiki issue:",
		JSON.stringify(
			{
				title: input.issue.title,
				body: input.issue.body,
				parsed: input.body,
				candidateSourceDecision: input.candidateSourceDecision,
				registrySources: input.registry.sources.map(source => ({
					id: source.id,
					label: source.label,
					description: source.description,
					enabled: source.enabled,
				})),
				issueUrl: input.issue.htmlUrl,
			},
			null,
			2,
		),
	].join("\n");
}

function wikiResearchBriefRepairPrompt(invalidText: string, error: string | undefined): string {
	return [
		"Your previous response was rejected by the OMG schema validator.",
		"The chat still has chatgpt-schema-bundle.zip attached. Use its JSON schemas and validate_schema_package.py before replying.",
		"Create and attach a corrected downloadable package containing source-decision.json, research-brief.json, content-plan.json, draft-instructions.json, critic-review.json, and validation.json.",
		"Do not paste JSON into chat. The final chat message must contain only the artifact link or a one-line artifact-ready note.",
		"Each package file must use the schema_version requested in the original prompt, and validation.json must prove you checked every file before exiting.",
		"If the validation error mentions claim citation mapping, update research-brief.json so every findings[] string has a claim_citations[] object with claim exactly equal to that finding string and citation_urls containing supporting public URLs.",
		`Validation error: ${error ?? "invalid JSON envelope"}`,
		"",
		"Previous response:",
		invalidText.slice(0, 12_000),
	].join("\n");
}

async function createResearchWorker(state: HarnessRunState, runner: WikiResearchWorkerRunner): Promise<string> {
	const existing = state.workers.find(worker => worker.role === "researcher" && !worker.stoppedAt)?.workerId;
	if (existing) return existing;
	const result = await runner({
		action: "create",
		profile: "omg-wiki-research",
		extraArgs: ["--count", "1", "--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", "researcher-create.json", result.stdout || result.stderr);
	if (!result.ok) throw new Error(`failed to create researcher worker: ${result.stderr || result.stdout}`);
	const workerId = firstWorkerId(result.stdout);
	if (!workerId) throw new Error("failed to parse researcher worker id from ChatGPT create output");
	const title = `OMG ${state.runId.split("-").at(-1)?.slice(0, 8) ?? state.runId.slice(0, 8)} wiki researcher`;
	const rename = await runner({
		action: "rename",
		worker: workerId,
		title,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(state.runId, "responses", "researcher-rename.json", rename.stdout || rename.stderr);
	await bindWorkerRole(state, "researcher", { workerId, title });
	return workerId;
}

async function stopResearchWorker(
	state: HarnessRunState,
	workerId: string,
	runner: WikiResearchWorkerRunner,
): Promise<void> {
	const stopped = await runner({
		action: "stop",
		worker: workerId,
		extraArgs: ["--json"],
		timeoutMs: 30_000,
	});
	await writeRunFile(state.runId, "responses", "researcher-stop.json", stopped.stdout || stopped.stderr);
	await bindWorkerRole(state, "researcher", { workerId, stoppedAt: new Date().toISOString() });
}

async function downloadResearchBriefPackage(
	state: HarnessRunState,
	input: {
		requestId?: string;
		conversationUrl?: string;
		runner: WikiResearchWorkerRunner;
		attempt: "initial" | "repair";
	},
): Promise<
	| ({ ok: true } & WikiResearchDecisionPackage)
	| {
			ok: false;
			error?: string;
			requestId?: string;
			conversationUrl?: string;
	  }
> {
	if (!input.conversationUrl) return { ok: false, error: "ChatGPT researcher did not return a conversation URL" };
	const runDir = getHarnessRunDir(state.runId);
	const downloadDir = path.join(
		runDir,
		"responses",
		input.attempt === "initial" ? "researcher-package" : "researcher-repair-package",
	);
	await fs.rm(downloadDir, { recursive: true, force: true });
	await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
	const downloaded = await input.runner({
		action: "download_artifacts",
		conversationUrl: input.conversationUrl,
		downloadDir,
		timeoutMs: 180_000,
	});
	await writeRunFile(
		state.runId,
		"responses",
		input.attempt === "initial" ? "researcher-package-download.json" : "researcher-repair-package-download.json",
		downloaded.stdout || downloaded.stderr,
	);
	if (!downloaded.ok) {
		return { ok: false, error: `failed to download researcher package: ${downloaded.stderr || downloaded.stdout}` };
	}
	const files = await expandResearchPackageFiles(downloadDir, downloaded.downloadedFiles ?? []);
	if (!files.length) return { ok: false, error: "researcher did not attach a downloadable package" };
	const validationRel = findPackageFile(files, "validation.json");
	if (!validationRel) return { ok: false, error: "researcher package is missing validation.json" };
	const validationPath = safeDownloadedPath(downloadDir, validationRel);
	if (!validationPath) return { ok: false, error: "researcher package has an unsafe validation.json path" };
	const validation = safeJson(await Bun.file(validationPath).text());
	if (validation?.ok !== true) {
		return { ok: false, error: `researcher self-validation did not pass: ${JSON.stringify(validation)}` };
	}
	const parseResult = await parseResearchDecisionPackageFiles(state, downloadDir, files, input.attempt);
	if (!parseResult.ok) {
		return {
			ok: false,
			error: parseResult.error,
			requestId: input.requestId,
			conversationUrl: input.conversationUrl,
		};
	}
	return {
		ok: true,
		...parseResult.package,
		requestId: input.requestId,
		conversationUrl: input.conversationUrl,
	};
}

async function parseResearchDecisionPackageFiles(
	state: HarnessRunState,
	downloadDir: string,
	files: string[],
	attempt: "initial" | "repair",
): Promise<
	| { ok: true; package: Omit<WikiResearchDecisionPackage, "requestId" | "conversationUrl"> }
	| { ok: false; error: string }
> {
	const prefix = attempt === "initial" ? "researcher-package" : "researcher-repair-package";
	const required = [
		"source-decision.json",
		"research-brief.json",
		"content-plan.json",
		"draft-instructions.json",
		"critic-review.json",
	] as const;
	const missing = required.filter(name => !findPackageFile(files, name));
	if (missing.length) return { ok: false, error: `researcher package is missing ${missing.join(", ")}` };

	const errors: string[] = [];
	async function parseFile<T>(
		filename: (typeof required)[number],
		expectedVersion: string,
		validate: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } },
	): Promise<{ value?: T; outputPath?: string }> {
		const relPath = findPackageFile(files, filename);
		if (!relPath) {
			errors.push(`${filename}: missing`);
			return {};
		}
		const absolute = safeDownloadedPath(downloadDir, relPath);
		if (!absolute) {
			errors.push(`${filename}: unsafe package path`);
			return {};
		}
		const text = (await Bun.file(absolute).text()).trim();
		const parsed = parseChatGptJsonEnvelope(text);
		if (!parsed.ok || parsed.value?.schema_version !== expectedVersion) {
			errors.push(`${filename}: ${parsed.ok ? `expected ${expectedVersion}` : (parsed.error ?? "invalid JSON")}`);
			return {};
		}
		const checked = validate(parsed.value);
		if (!checked.success) {
			errors.push(`${filename}: ${checked.error.message}`);
			return {};
		}
		const outputPath = await writeRunFile(
			state.runId,
			"responses",
			`${prefix}-${filename}`,
			`${JSON.stringify(checked.data, null, 2)}\n`,
		);
		return { value: checked.data, outputPath };
	}

	const sourceDecision = await parseFile(
		"source-decision.json",
		"omg.wiki.source_decision.v1",
		value => WikiSourceDecisionEnvelopeSchema.safeParse(value) as any,
	);
	const research = await parseFile(
		"research-brief.json",
		"omg.wiki.research_brief.v1",
		value => WikiResearchBriefEnvelopeSchema.safeParse(value) as any,
	);
	const contentPlan = await parseFile(
		"content-plan.json",
		"omg.wiki.content_plan.v1",
		value => WikiContentPlanEnvelopeSchema.safeParse(value) as any,
	);
	const draftInstructions = await parseFile(
		"draft-instructions.json",
		"omg.wiki.draft_instructions.v1",
		value => WikiDraftInstructionsEnvelopeSchema.safeParse(value) as any,
	);
	const criticReview = await parseFile(
		"critic-review.json",
		"omg.wiki.research_review.v1",
		value => WikiResearchReviewEnvelopeSchema.safeParse(value) as any,
	);

	if (errors.length) {
		await writeRunFile(state.runId, "responses", `${prefix}-invalid.txt`, `${errors.join("\n")}\n`);
		return { ok: false, error: errors.join("; ") };
	}
	if (
		!sourceDecision.value ||
		!research.value ||
		!contentPlan.value ||
		!draftInstructions.value ||
		!criticReview.value
	) {
		return { ok: false, error: "researcher package parser failed without detailed errors" };
	}
	return {
		ok: true,
		package: {
			sourceDecision: sourceDecision.value as WikiSourceDecisionEnvelope,
			research: research.value as WikiResearchBriefEnvelope,
			contentPlan: contentPlan.value as WikiContentPlanEnvelope,
			draftInstructions: draftInstructions.value as WikiDraftInstructionsEnvelope,
			criticReview: criticReview.value as WikiResearchReviewEnvelope,
			responsePaths: [
				sourceDecision.outputPath,
				research.outputPath,
				contentPlan.outputPath,
				draftInstructions.outputPath,
				criticReview.outputPath,
			].filter(Boolean) as string[],
		},
	};
}

async function expandResearchPackageFiles(downloadDir: string, files: string[]): Promise<string[]> {
	const expanded = new Set(files);
	for (const relPath of files) {
		if (!relPath.toLowerCase().endsWith(".zip")) continue;
		const absolute = safeDownloadedPath(downloadDir, relPath);
		if (!absolute) continue;
		const zipBytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
		let entries: Record<string, Uint8Array>;
		try {
			entries = unzipSync(zipBytes);
		} catch {
			continue;
		}
		const outRootRel = `${relPath.replace(/\.zip$/i, "")}.contents`;
		for (const [entryName, bytes] of Object.entries(entries)) {
			const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
			if (!normalized || normalized.endsWith("/")) continue;
			const entryRel = path.posix.join(outRootRel.replace(/\\/g, "/"), normalized);
			const target = safeDownloadedPath(downloadDir, entryRel);
			if (!target) continue;
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await Bun.write(target, bytes);
			expanded.add(entryRel);
		}
	}
	return [...expanded].sort();
}

function safeDownloadedPath(root: string, relPath: string): string | undefined {
	const resolvedRoot = path.resolve(root);
	const absolute = path.resolve(resolvedRoot, relPath);
	if (absolute !== resolvedRoot && absolute.startsWith(`${resolvedRoot}${path.sep}`)) return absolute;
	return undefined;
}

function findPackageFile(files: string[], filename: string): string | undefined {
	const target = filename.toLowerCase();
	return files.find(file => path.basename(file).toLowerCase() === target);
}

function stringArraySchema(minItems = 1): Record<string, unknown> {
	return { type: "array", minItems, items: { type: "string" } };
}

function objectSchema(
	required: string[],
	properties: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		required,
		properties,
		additionalProperties: true,
		...extra,
	};
}

function wikiResearchPackageSchemas(sourceId: string, repoName: string): Record<string, Record<string, unknown>> {
	const sourceQuality = {
		type: "object",
		required: ["url", "title", "source_type", "why_it_matters"],
		properties: {
			url: { type: "string" },
			title: { type: "string" },
			source_type: { type: "string", enum: ["official", "standards", "reference", "supporting"] },
			why_it_matters: { type: "string" },
		},
	};
	return {
		"source-decision.schema.json": objectSchema(
			[
				"schema_version",
				"status",
				"recommended_action",
				"source_id",
				"repo_name",
				"domain_label",
				"reason",
				"existing_source_candidates",
				"confidence",
				"required_seed_files",
			],
			{
				schema_version: { const: "omg.wiki.source_decision.v1" },
				status: { type: "string", enum: ["complete", "blocked", "needs_user_decision"] },
				recommended_action: { type: "string", enum: ["use_existing_source", "create_new_source", "blocked"] },
				source_id: { type: "string", const: sourceId },
				repo_name: { type: "string", const: repoName },
				domain_label: { type: "string" },
				reason: { type: "string" },
				existing_source_candidates: stringArraySchema(0),
				confidence: { type: "number" },
				required_seed_files: stringArraySchema(0),
			},
		),
		"research-brief.schema.json": objectSchema(
			[
				"schema_version",
				"status",
				"topic",
				"summary",
				"citations",
				"source_quality",
				"claim_citations",
				"findings",
				"reader_takeaways",
				"confidence",
			],
			{
				schema_version: { const: "omg.wiki.research_brief.v1" },
				status: { type: "string", enum: ["complete", "blocked", "needs_more_context"] },
				topic: { type: "string" },
				summary: { type: "string" },
				citations: stringArraySchema(CHATGPT_MIN_DEEP_RESEARCH_CITATIONS),
				source_quality: { type: "array", minItems: CHATGPT_MIN_DEEP_RESEARCH_CITATIONS, items: sourceQuality },
				claim_citations: {
					type: "array",
					minItems: CHATGPT_MIN_DEEP_RESEARCH_FINDINGS,
					items: {
						type: "object",
						required: ["claim", "citation_urls"],
						properties: { claim: { type: "string" }, citation_urls: stringArraySchema() },
					},
				},
				findings: stringArraySchema(CHATGPT_MIN_DEEP_RESEARCH_FINDINGS),
				reader_takeaways: stringArraySchema(3),
				confidence: { type: "number" },
			},
		),
		"content-plan.schema.json": objectSchema(["schema_version", "status", "source_id", "pages"], {
			schema_version: { const: "omg.wiki.content_plan.v1" },
			status: { type: "string", enum: ["complete", "blocked"] },
			source_id: { type: "string", const: sourceId },
			pages: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					required: ["title", "slug", "description", "tags", "reader_value", "outline"],
					properties: {
						title: { type: "string" },
						slug: { type: "string" },
						description: { type: "string" },
						tags: stringArraySchema(),
						reader_value: { type: "string" },
						outline: stringArraySchema(CHATGPT_MIN_DRAFT_SECTIONS),
					},
				},
			},
		}),
		"draft-instructions.schema.json": objectSchema(
			[
				"schema_version",
				"status",
				"source_id",
				"path",
				"title",
				"description",
				"tags",
				"required_sections",
				"notes",
				"sections",
				"confidence",
			],
			{
				schema_version: { const: "omg.wiki.draft_instructions.v1" },
				status: { type: "string", enum: ["complete", "blocked"] },
				source_id: { type: "string", const: sourceId },
				path: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
				tags: stringArraySchema(),
				required_sections: stringArraySchema(CHATGPT_MIN_DRAFT_SECTIONS),
				notes: stringArraySchema(0),
				sections: {
					type: "array",
					minItems: CHATGPT_MIN_DRAFT_SECTIONS,
					items: {
						type: "object",
						required: ["heading", "purpose", "paragraphs", "bullets", "citation_urls"],
						properties: {
							heading: { type: "string" },
							purpose: { type: "string" },
							paragraphs: stringArraySchema(2),
							bullets: stringArraySchema(0),
							citation_urls: stringArraySchema(),
						},
					},
				},
				confidence: { type: "number" },
			},
		),
		"critic-review.schema.json": objectSchema(
			["schema_version", "approved", "blocking_findings", "non_blocking_findings", "verdict"],
			{
				schema_version: { const: "omg.wiki.research_review.v1" },
				approved: { type: "boolean", const: true },
				blocking_findings: stringArraySchema(0),
				non_blocking_findings: stringArraySchema(0),
				verdict: { type: "string", const: "good_enough" },
			},
		),
		"validation.schema.json": objectSchema(["ok", "schema_version", "checked_files", "errors", "citation_count"], {
			ok: { type: "boolean", const: true },
			schema_version: { type: "string" },
			checked_files: stringArraySchema(6),
			errors: stringArraySchema(0),
			citation_count: { type: "number" },
			worker_id: { type: "string" },
			request_id: { type: "string" },
			conversation_url: { type: "string" },
		}),
	};
}

async function writeWikiResearchSchemaFiles(
	state: HarnessRunState,
	candidateSourceDecision: CandidateSourceDecision,
): Promise<string[]> {
	const sourceId = candidateSourceDecision.sourceId ?? "undecided";
	const repoName = candidateSourceDecision.repoName ?? "";
	const schemas = wikiResearchPackageSchemas(sourceId, repoName);
	const out: string[] = [];
	for (const [filename, schema] of Object.entries(schemas)) {
		out.push(
			await writeRunFile(
				state.runId,
				"artifacts",
				`research-schema/${filename}`,
				`${JSON.stringify(schema, null, 2)}\n`,
			),
		);
	}
	return out;
}

async function sendResearchPrompt(
	state: HarnessRunState,
	workerId: string,
	prompt: string,
	runner: WikiResearchWorkerRunner,
	attempt: "initial" | "repair",
	schemaPaths: string[],
): Promise<{ requestId?: string; conversationUrl?: string }> {
	const promptName = attempt === "initial" ? "researcher.md" : "researcher-repair.md";
	await writeRunFile(state.runId, "prompts", promptName, prompt);
	await consumePromptBudget(state, "researcher");
	let modelOption = CHATGPT_RESEARCH_MODEL_OPTION;
	let thinkingOption = CHATGPT_RESEARCH_THINKING_OPTION;
	let send = await runner({
		action: "send",
		worker: workerId,
		prompt,
		modelOption,
		thinkingOption,
		schemas: schemaPaths,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	await writeRunFile(
		state.runId,
		"responses",
		attempt === "initial" ? "researcher-send.json" : "researcher-repair-send.json",
		send.stdout || send.stderr,
	);
	if (!send.ok && modelSelectionFailed(send)) {
		modelOption = "Thinking";
		thinkingOption = "Standard";
		send = await runner({
			action: "send",
			worker: workerId,
			prompt,
			modelOption,
			thinkingOption,
			schemas: schemaPaths,
			extraArgs: ["--json"],
			timeoutMs: 120_000,
		});
		await writeRunFile(
			state.runId,
			"responses",
			attempt === "initial" ? "researcher-send-fallback.json" : "researcher-repair-send-fallback.json",
			send.stdout || send.stderr,
		);
	}
	if (!send.ok) throw new Error(`failed to send researcher prompt: ${send.stderr || send.stdout}`);
	const sent = responseMeta(send.stdout);
	const watched = await runner({
		action: "watch",
		worker: workerId,
		extraArgs: ["--timeout", "600", "--json"],
		timeoutMs: 600_000,
	});
	await writeRunFile(
		state.runId,
		"responses",
		attempt === "initial" ? "researcher-watch.json" : "researcher-repair-watch.json",
		watched.stdout || watched.stderr,
	);
	if (!watched.ok) throw new Error(`failed while watching researcher worker: ${watched.stderr || watched.stdout}`);
	const watchMeta = responseMeta(watched.stdout);
	await bindWorkerRole(state, "researcher", {
		workerId,
		requestId: watchMeta.requestId ?? sent.requestId,
		conversationUrl: watchMeta.conversationUrl ?? sent.conversationUrl,
		modelOption,
		thinkingOption,
	});
	return {
		requestId: watchMeta.requestId ?? sent.requestId,
		conversationUrl: watchMeta.conversationUrl ?? sent.conversationUrl,
	};
}

function validateCompletedResearchBrief(
	research: WikiResearchBriefEnvelope,
	steering: WikiResearchSteering,
	mode: WikiResearcherMode,
): string[] {
	const errors: string[] = [];
	if (research.status !== "complete") errors.push(`research status is ${research.status}`);
	if (!research.citations.length) errors.push("research brief has no citations");
	if (mode === "chatgpt" && research.citations.length < CHATGPT_MIN_DEEP_RESEARCH_CITATIONS) {
		errors.push(
			`ChatGPT research brief needs at least ${CHATGPT_MIN_DEEP_RESEARCH_CITATIONS} high-quality citations`,
		);
	}
	if (mode === "chatgpt" && research.findings.length < CHATGPT_MIN_DEEP_RESEARCH_FINDINGS) {
		errors.push(`ChatGPT research brief needs at least ${CHATGPT_MIN_DEEP_RESEARCH_FINDINGS} substantive findings`);
	}
	if (!research.claim_citations.length) errors.push("research brief needs claim-level citation mappings");
	if (mode === "chatgpt" && research.source_quality.length < research.citations.length) {
		errors.push("ChatGPT research brief needs source_quality metadata for every citation");
	}
	if (mode === "chatgpt" && research.reader_takeaways.length < 3) {
		errors.push("ChatGPT research brief needs at least three reader_takeaways");
	}
	if (research.confidence < 0.5) errors.push("research confidence is too low");
	for (const finding of research.findings) {
		if (!research.claim_citations.some(item => item.claim === finding && item.citation_urls.length)) {
			errors.push(`finding is missing claim citation mapping: ${finding.slice(0, 80)}`);
		}
	}
	for (const citation of research.citations) {
		const host = new URL(citation).hostname;
		if (steering.blockedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
			errors.push(`citation uses blocked domain ${host}`);
		}
	}
	return errors;
}

async function runChatGptResearchBrief(
	state: HarnessRunState,
	issue: WikiResearchIssue,
	body: WikiResearchIssueBody,
	candidateSourceDecision: CandidateSourceDecision,
	registry: WikiRegistrySnapshot,
	steering: WikiResearchSteering,
	options: WikiResearchOptions,
): Promise<{
	sourceDecision: WikiSourceDecisionEnvelope;
	research: WikiResearchBriefEnvelope;
	contentPlan: WikiContentPlanEnvelope;
	draftInstructions: WikiDraftInstructionsEnvelope;
	criticReview: WikiResearchReviewEnvelope;
	responsePaths: string[];
	workerId: string;
	requestId?: string;
	conversationUrl?: string;
}> {
	const runner = options.workerRunner ?? runChatGptWorkerCommand;
	const workerId = await createResearchWorker(state, runner);
	const schemaPaths = await writeWikiResearchSchemaFiles(state, candidateSourceDecision);
	try {
		const sent = await sendResearchPrompt(
			state,
			workerId,
			wikiResearchBriefPrompt({ issue, body, candidateSourceDecision, registry, steering }),
			runner,
			"initial",
			schemaPaths,
		);
		let parsed = await downloadResearchBriefPackage(state, {
			requestId: sent.requestId,
			conversationUrl: sent.conversationUrl,
			runner,
			attempt: "initial",
		});
		let repaired = false;
		if (!parsed.ok) {
			const copied = await runner({
				action: "copy_message",
				conversationUrl: sent.conversationUrl,
				timeoutMs: 120_000,
			});
			await writeRunFile(state.runId, "responses", "researcher-copy.txt", copied.stdout || copied.stderr);
			const repairSent = await sendResearchPrompt(
				state,
				workerId,
				wikiResearchBriefRepairPrompt(copied.stdout || parsed.error || "", parsed.error),
				runner,
				"repair",
				schemaPaths,
			);
			parsed = await downloadResearchBriefPackage(state, {
				requestId: repairSent.requestId ?? sent.requestId,
				conversationUrl: repairSent.conversationUrl ?? sent.conversationUrl,
				runner,
				attempt: "repair",
			});
			repaired = true;
		}
		if (!parsed.ok) {
			throw new Error(
				`ChatGPT researcher returned invalid schema JSON: ${parsed.error ?? "unknown validation error"}`,
			);
		}
		let completionErrors = validateChatGptResearchDecisionPackage(parsed, steering, candidateSourceDecision);
		if (completionErrors.length && !repaired) {
			const repairSent = await sendResearchPrompt(
				state,
				workerId,
				wikiResearchBriefRepairPrompt(
					JSON.stringify(
						{
							sourceDecision: parsed.sourceDecision,
							research: parsed.research,
							contentPlan: parsed.contentPlan,
							draftInstructions: parsed.draftInstructions,
							criticReview: parsed.criticReview,
						},
						null,
						2,
					),
					`ChatGPT research brief failed quality gates: ${completionErrors.join("; ")}`,
				),
				runner,
				"repair",
				schemaPaths,
			);
			const repairedPackage = await downloadResearchBriefPackage(state, {
				requestId: repairSent.requestId ?? parsed.requestId ?? sent.requestId,
				conversationUrl: repairSent.conversationUrl ?? parsed.conversationUrl ?? sent.conversationUrl,
				runner,
				attempt: "repair",
			});
			if (!repairedPackage.ok) {
				throw new Error(
					`ChatGPT researcher returned invalid schema JSON after quality repair: ${
						repairedPackage.error ?? "unknown validation error"
					}`,
				);
			}
			parsed = repairedPackage;
			repaired = true;
			completionErrors = validateChatGptResearchDecisionPackage(parsed, steering, candidateSourceDecision);
		}
		if (completionErrors.length) {
			throw new Error(`ChatGPT research brief failed quality gates: ${completionErrors.join("; ")}`);
		}
		const canonicalPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-brief.json",
			`${JSON.stringify(parsed.research, null, 2)}\n`,
		);
		const sourceDecisionPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-source-decision-chatgpt.json",
			`${JSON.stringify(parsed.sourceDecision, null, 2)}\n`,
		);
		const planPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-content-plan-chatgpt.json",
			`${JSON.stringify(parsed.contentPlan, null, 2)}\n`,
		);
		const draftInstructionPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-draft-instructions-chatgpt.json",
			`${JSON.stringify(parsed.draftInstructions, null, 2)}\n`,
		);
		const criticPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-review-chatgpt.json",
			`${JSON.stringify(parsed.criticReview, null, 2)}\n`,
		);
		return {
			sourceDecision: parsed.sourceDecision,
			research: parsed.research,
			contentPlan: parsed.contentPlan,
			draftInstructions: parsed.draftInstructions,
			criticReview: parsed.criticReview,
			responsePaths: [
				...parsed.responsePaths,
				canonicalPath,
				sourceDecisionPath,
				planPath,
				draftInstructionPath,
				criticPath,
			],
			workerId,
			requestId: parsed.requestId,
			conversationUrl: parsed.conversationUrl,
		};
	} finally {
		await stopResearchWorker(state, workerId, runner).catch(async error => {
			await writeRunFile(
				state.runId,
				"responses",
				"researcher-stop-error.txt",
				error instanceof Error ? error.message : String(error),
			);
		});
	}
}

function validateChatGptResearchDecisionPackage(
	decisionPackage: WikiResearchDecisionPackage,
	steering: WikiResearchSteering,
	candidateSourceDecision: CandidateSourceDecision,
): string[] {
	return [
		...validateCompletedResearchBrief(decisionPackage.research, steering, "chatgpt"),
		...validateChatGptDecisionPackage(decisionPackage, candidateSourceDecision),
	];
}

function validateChatGptDecisionPackage(
	decisionPackage: WikiResearchDecisionPackage,
	candidateSourceDecision: CandidateSourceDecision,
): string[] {
	const errors: string[] = [];
	const sourceDecision = decisionPackage.sourceDecision;
	if (sourceDecision.status !== "complete") errors.push(`source decision status is ${sourceDecision.status}`);
	if (sourceDecision.recommended_action !== "use_existing_source") {
		errors.push(`source decision recommended ${sourceDecision.recommended_action}`);
	}
	if (candidateSourceDecision.sourceId && sourceDecision.source_id !== candidateSourceDecision.sourceId) {
		errors.push(
			`source decision ${sourceDecision.source_id} disagrees with candidate ${candidateSourceDecision.sourceId}`,
		);
	}
	if (candidateSourceDecision.repoName && sourceDecision.repo_name !== candidateSourceDecision.repoName) {
		errors.push(
			`source repo ${sourceDecision.repo_name} disagrees with candidate ${candidateSourceDecision.repoName}`,
		);
	}
	if (sourceDecision.confidence < 0.5) errors.push("source decision confidence is too low");
	if (decisionPackage.contentPlan.status !== "complete") errors.push("content plan is not complete");
	if (decisionPackage.contentPlan.source_id !== sourceDecision.source_id) {
		errors.push("content plan source_id does not match source decision");
	}
	if (!decisionPackage.contentPlan.pages.length) errors.push("content plan has no pages");
	if (decisionPackage.draftInstructions.status !== "complete") errors.push("draft instructions are not complete");
	if (decisionPackage.draftInstructions.source_id !== sourceDecision.source_id) {
		errors.push("draft instructions source_id does not match source decision");
	}
	if (!decisionPackage.draftInstructions.path.startsWith("docs/")) {
		errors.push("draft instructions path must be under docs/");
	}
	if (!decisionPackage.draftInstructions.path.endsWith(".md")) errors.push("draft instructions path must be markdown");
	if (decisionPackage.draftInstructions.confidence < 0.5) errors.push("draft instruction confidence is too low");
	if (decisionPackage.draftInstructions.sections.length < CHATGPT_MIN_DRAFT_SECTIONS) {
		errors.push(`draft instructions need at least ${CHATGPT_MIN_DRAFT_SECTIONS} full human-readable sections`);
	}
	for (const section of decisionPackage.draftInstructions.sections) {
		if (!section.paragraphs.length)
			errors.push(`draft section ${section.heading} needs at least one prose paragraph`);
		if (!section.citation_urls.length) errors.push(`draft section ${section.heading} needs citation URLs`);
	}
	if (!decisionPackage.criticReview.approved || decisionPackage.criticReview.blocking_findings.length) {
		errors.push("ChatGPT critic review did not approve the package");
	}
	if (decisionPackage.criticReview.verdict !== "good_enough") errors.push("ChatGPT critic verdict is not good_enough");
	return errors;
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

function citationLink(url: string, citations: string[]): string {
	const index = Math.max(0, citations.indexOf(url)) + 1;
	return `[${index || 1}](${url})`;
}

function citedFinding(claim: string, research: WikiResearchBriefEnvelope, index: number): string {
	const mapped = research.claim_citations.find(item => item.claim === claim)?.citation_urls[0];
	const url = mapped ?? research.citations[index % Math.max(1, research.citations.length)];
	return url ? `${claim} ${citationLink(url, research.citations)}` : claim;
}

function appendSectionCitations(text: string, urls: string[], citations: string[]): string {
	const links = urls
		.filter(url => citations.includes(url))
		.slice(0, 2)
		.map(url => citationLink(url, citations));
	if (!links.length || /\[\d+\]\(https?:\/\/[^)]+\)/.test(text)) return text;
	return `${text} ${links.join(" ")}`;
}

function renderInstructionSections(instructions: WikiDraftInstructionsEnvelope, citations: string[]): string[] {
	return instructions.sections.flatMap(section => [
		`## ${section.heading}`,
		"",
		...section.paragraphs.flatMap(paragraph => [
			appendSectionCitations(paragraph, section.citation_urls, citations),
			"",
		]),
		...(section.bullets.length
			? [...section.bullets.map(item => `- ${appendSectionCitations(item, section.citation_urls, citations)}`), ""]
			: []),
	]);
}

function draftMarkdown(
	issue: WikiResearchIssue,
	body: WikiResearchIssueBody,
	sourceId: string,
	research: WikiResearchBriefEnvelope,
	instructions?: WikiDraftInstructionsEnvelope,
): WikiPageDraftEnvelope {
	const title = instructions?.title.trim() || normalizeResearchTitle(issue.title);
	const draftPath = instructions?.path?.startsWith("docs/") ? instructions.path : stableDraftPath(issue);
	const description = instructions?.description || body.expectedOutput || body.objective;
	const tags = [...new Set([...(instructions?.tags ?? []), "research", sourceId])].filter(Boolean);
	const requiredSections = (instructions?.required_sections ?? []).filter(
		section =>
			![
				"Summary",
				"Checklist",
				"Decision Guidance",
				"Common Pitfalls",
				"Maintenance Notes",
				"Sources",
				"Research Notes",
				"Drafting Notes",
			].includes(section),
	);
	const today = new Date().toISOString().slice(0, 10);
	const publishStatus = research.confidence >= 0.75 ? "active" : "draft";
	const reviewStatus = research.confidence >= 0.75 ? "needs_review" : "ai_draft";
	const citationLines = research.citations.map(
		url => `  - title: ${yamlScalar(new URL(url).hostname)}\n    url: ${yamlScalar(url)}\n    accessed: ${today}`,
	);
	const citedFindings = research.findings.map((finding, index) => citedFinding(finding, research, index));
	const summaryCitations = research.citations
		.slice(0, 2)
		.map(url => citationLink(url, research.citations))
		.join(" ");
	const checklistItems = citedFindings.slice(0, 6);
	const authoredSections = instructions?.sections.length
		? renderInstructionSections(
				{
					...instructions,
					sections: instructions.sections.filter(section => section.heading !== "Sources"),
				},
				research.citations,
			)
		: [];
	const markdown = [
		"---",
		`title: ${yamlScalar(title)}`,
		`description: ${yamlScalar(description)}`,
		"tags:",
		...tags.map(tag => `  - ${yamlScalar(tag)}`),
		"area: general",
		`status: ${publishStatus}`,
		"difficulty: intermediate",
		`review_status: ${reviewStatus}`,
		"generated_by: omg-wiki-research",
		"human_reviewed: false",
		`last_verified: ${today}`,
		`confidence: ${research.confidence >= 0.75 ? "medium" : "low"}`,
		"sources:",
		...(citationLines.length ? citationLines : ["  []"]),
		"---",
		"",
		`# ${title}`,
		"",
		...(authoredSections.length
			? authoredSections
			: [
					"## Summary",
					"",
					`${research.summary}${summaryCitations ? ` ${summaryCitations}` : ""}`,
					"",
					"## Checklist",
					"",
					checklistItems.length
						? checklistItems.map(item => `- ${item}`).join("\n")
						: "- Initial AI-assisted research draft.",
					"",
					"## Decision Guidance",
					"",
					"- Prefer the smallest process that keeps the project understandable, reviewable, and repeatable.",
					"- Use the cited source material as the baseline, then adapt the details to the project size and risk.",
					"",
					"## Common Pitfalls",
					"",
					"- Avoid uncited process rules, stale version claims, and documentation that only restates tool names.",
					"- Keep draft pages marked as AI-assisted until a human review confirms the guidance.",
					"",
					"## Maintenance Notes",
					"",
					`- Re-check the cited sources after major workflow or tooling changes. Last verified: ${today}.`,
					"",
				]),
		...requiredSections.flatMap(section => [`## ${section}`, "", "- To be expanded from cited source material.", ""]),
		"## Sources",
		"",
		...(research.citations.length
			? research.citations.map((url, index) => `${index + 1}. [${new URL(url).hostname}](${url})`)
			: ["- Citation required before publication."]),
		"",
	].join("\n");
	return {
		schema_version: "omg.wiki.page_draft.v1",
		status: "complete",
		source_id: sourceId,
		path: draftPath,
		markdown,
		citations: research.citations,
	};
}

async function writeDraftWorkspace(state: HarnessRunState, draft: WikiPageDraftEnvelope): Promise<string> {
	const root = path.join(getHarnessRunDir(state.runId), "artifacts", "draft");
	const target = path.join(root, draft.path);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await Bun.write(target, draft.markdown);
	return target;
}

function validateDraft(draft: WikiPageDraftEnvelope, steering: WikiResearchSteering): string[] {
	const errors: string[] = [];
	if (!draft.path.startsWith("docs/") || !draft.path.endsWith(".md")) errors.push("draft path must be docs/<slug>.md");
	if (!/^#[^#]/m.test(draft.markdown)) errors.push("draft must include one H1");
	if (!/title:\s*\S/.test(draft.markdown)) errors.push("draft frontmatter must include title");
	if (!/review_status:\s*\S/.test(draft.markdown)) errors.push("draft frontmatter must include review_status");
	if (!/generated_by:\s*\S/.test(draft.markdown)) errors.push("draft frontmatter must include generated_by");
	if (!/human_reviewed:\s*false/.test(draft.markdown)) errors.push("draft frontmatter must mark human_reviewed false");
	if (!/last_verified:\s*\d{4}-\d{2}-\d{2}/.test(draft.markdown))
		errors.push("draft frontmatter must include last_verified");
	if (/<script\b|<iframe\b|onerror\s*=|onclick\s*=/i.test(draft.markdown)) errors.push("draft contains unsafe HTML");
	if (!draft.citations.length) errors.push("factual wiki research drafts require at least one citation URL");
	if (!/\[\d+\]\(https?:\/\/[^)]+\)/.test(draft.markdown)) {
		errors.push("draft must include inline numeric citation links");
	}
	for (const citation of draft.citations) {
		try {
			const host = new URL(citation).hostname;
			if (steering.blockedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
				errors.push(`citation uses blocked domain ${host}`);
			}
		} catch {
			errors.push(`invalid citation URL ${citation}`);
		}
	}
	return errors;
}

function reviewDraft(draft: WikiPageDraftEnvelope, research: WikiResearchBriefEnvelope): WikiResearchReviewEnvelope {
	const blocking = validateDraft(draft, DEFAULT_STEERING);
	if (research.status !== "complete") blocking.push("research brief is not complete");
	if (research.confidence < 0.5) blocking.push("research confidence is too low");
	if (!research.citations.length) blocking.push("research brief has no citations");
	if (!/^## Sources\s*$/m.test(draft.markdown)) blocking.push("draft must include a Sources section");
	if ((draft.markdown.match(/^## Sources\s*$/gm) ?? []).length > 1) blocking.push("draft must not duplicate Sources");
	if (/^## (Research Notes|Drafting Notes)\s*$/m.test(draft.markdown)) {
		blocking.push("draft must not publish internal research or drafting notes sections");
	}
	if (/To be expanded from cited source material/i.test(draft.markdown)) {
		blocking.push("draft must not publish placeholder expansion text");
	}
	if (!/\[\d+\]\(https?:\/\/[^)]+\)/.test(draft.markdown)) blocking.push("draft needs inline citations");
	return {
		schema_version: "omg.wiki.research_review.v1",
		approved: blocking.length === 0,
		blocking_findings: blocking,
		non_blocking_findings:
			research.citations.length < 2 ? ["Only one citation was available; keep page in ai_draft status."] : [],
		verdict: blocking.length === 0 ? "good_enough" : "not_good_enough",
	};
}

function stableIssueBranch(steering: WikiResearchSteering, issue: WikiResearchIssue, sourceId: string): string {
	const issuePart = issue.number ? `issue-${issue.number}` : slugify(issue.title);
	return `${steering.branchPrefix}/${issuePart}-${sourceId}`;
}

function wikiUrlForDraft(sourceId: string, draft: WikiPageDraftEnvelope): string {
	const slug = draft.path.replace(/^docs\//, "").replace(/\.md$/, "");
	return `https://StevenBuglione.github.io/wiki-site/wiki/?s=${encodeURIComponent(sourceId)}&p=${encodeURIComponent(slug)}`;
}

const AUTOPILOT_TOPIC_BACKLOG: Record<string, string[]> = {
	devops: [
		"Kubernetes restore testing and disaster recovery runbooks",
		"Terraform state locking, recovery, and workspace operations",
		"GitHub Actions release governance and rollback strategy",
		"Kubernetes ingress TLS renewal and certificate operations",
		"Container image supply chain hardening for small teams",
	],
	homelab: [
		"Proxmox backup and restore strategy for small clusters",
		"Homelab VLAN design and firewall boundary patterns",
		"TrueNAS snapshot replication and recovery planning",
		"UPS shutdown automation and power resilience",
		"Self-hosted monitoring and alert routing for homelabs",
	],
	projects: [
		"Architecture decision records for solo and small-team projects",
		"Release checklist and rollback strategy for application projects",
		"Observability baseline for small web applications",
		"Dependency update policy and vulnerability response workflow",
		"Project documentation structure for maintainable handoffs",
	],
};

function autopilotTopicsForSource(source: WikiRegistrySource): string[] {
	return (
		AUTOPILOT_TOPIC_BACKLOG[source.id] ?? [
			`${source.label} operational architecture and maintenance guide`,
			`${source.label} troubleshooting and recovery runbook`,
			`${source.label} security baseline and review checklist`,
		]
	);
}

function wikiResearchSeedBody(source: WikiRegistrySource, topic: string): string {
	return [
		"## Objective",
		`Create a professional, deeply researched wiki reference page for: ${topic}.`,
		"",
		"## Preferred source",
		source.id,
		"",
		"## Expected output",
		"A polished reference-quality Markdown page with claim-level inline citations, decision guidance, operational checklists, failure scenarios, maintenance notes, and source metadata.",
		"",
		"## Constraints",
		"- Use public, non-credentialed sources only.",
		"- Prefer official vendor, project, standards, or primary documentation.",
		"- Include practical commands or templates only when supported by cited sources.",
		"- Keep AI provenance metadata in frontmatter.",
		"",
		"## Acceptance",
		"- At least 12 high-quality citations are discovered by ChatGPT.",
		"- The page includes inline numeric citations near supported claims.",
		"- The page reads like an experienced practitioner wrote it.",
		"- The PR remains content-only and safe-auto-merge eligible if all gates pass.",
	].join("\n");
}

async function createAutopilotSeedIssue(
	token: string,
	client: WikiResearchGitHubClient,
	owner: string,
	registry: WikiRegistrySnapshot,
	repos: string[],
): Promise<{ repo: string; issue: WikiResearchIssue; sourceId: string }> {
	const enabledSources = registry.sources
		.filter(source => source.enabled !== false)
		.filter(source => repos.includes(`wiki-data-${source.id}`))
		.sort((left, right) => (left.order ?? 999) - (right.order ?? 999) || left.id.localeCompare(right.id));
	const source = enabledSources[0];
	if (!source) throw new Error("autopilot could not find an enabled wiki data source to seed");
	const repo = `wiki-data-${source.id}`;
	const existing = await client.listIssues(token, owner, repo, ["wiki:research"]);
	const existingTitles = new Set(existing.map(issue => normalizeResearchTitle(issue.title).toLowerCase()));
	const topic =
		autopilotTopicsForSource(source).find(candidate => !existingTitles.has(candidate.toLowerCase())) ??
		`${source.label} operations research note ${new Date().toISOString().slice(0, 10)}`;
	const issue = await client.createIssue(token, {
		owner,
		repo,
		title: topic,
		body: wikiResearchSeedBody(source, topic),
		labels: ["wiki:research", "wiki:queued", `source:${source.id}`],
	});
	return { repo, issue, sourceId: source.id };
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function prUrlFromState(state: HarnessRunState): string | undefined {
	const prGate = state.gates?.find(gate => gate.id === "pr_create");
	const summary = prGate?.summary ?? "";
	return summary.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
}

function isSafeAutoMergePath(filename: string): boolean {
	return /^docs\/[^<>:"|?*]+\.md$/.test(filename);
}

export async function syncWikiResearchIssueLabels(
	options: WikiResearchOptions,
): Promise<{ owner: string; repo: string; labels: string[]; applied: boolean }> {
	const owner = options.owner ?? "YOUR_ORG";
	const repo = options.repo ?? "wiki-data-registry";
	if (!options.apply) return { owner, repo, labels: [...WIKI_RESEARCH_REQUIRED_LABELS], applied: false };
	const token = getGitHubToken(options);
	if (!token) throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
	const client = options.githubClient ?? fetchWikiResearchGitHubClient;
	for (const label of WIKI_RESEARCH_REQUIRED_LABELS) {
		await client.ensureLabel(token, {
			owner,
			repo,
			label,
			color: label === "wiki:blocked" ? "d73a4a" : "2f81f7",
			description: "OMG wiki research workflow label",
		});
	}
	return { owner, repo, labels: [...WIKI_RESEARCH_REQUIRED_LABELS], applied: true };
}

export async function runWikiResearchQueue(
	options: WikiResearchQueueOptions = {},
): Promise<WikiResearchQueueRunResult> {
	const startedAt = new Date().toISOString();
	const token = getGitHubToken(options);
	if (options.apply && !token) throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
	const loadedSteering = await loadSteering(options);
	const steering = loadedSteering.steering;
	const owner = options.owner ?? steering.owner ?? "YOUR_ORG";
	const registryRepo = steering.registryRepo ?? "wiki-data-registry";
	const registry = await readRegistrySnapshot(options, steering);
	const repos = options.repos ?? [
		registryRepo,
		...registry.snapshot.sources.filter(source => source.enabled !== false).map(source => `wiki-data-${source.id}`),
	];
	const maxIssues = Math.max(1, options.maxIssues ?? steering.maxIssuesPerRun ?? 1);
	const client = options.githubClient ?? fetchWikiResearchGitHubClient;
	const researcher = effectiveResearcher(options);
	let contentIssuesProcessed = 0;
	const result: WikiResearchQueueRunResult = {
		schemaVersion: "omg.wiki.research_queue_run.v1",
		owner,
		repos,
		startedAt,
		finishedAt: startedAt,
		apply: Boolean(options.apply),
		autoMerge: options.autoMerge ?? "off",
		researcher,
		scanned: 0,
		processed: [],
		blocked: [],
	};

	for (const repo of repos) {
		if (contentIssuesProcessed >= maxIssues) break;
		try {
			const queued = await client.listIssues(token, owner, repo, ["wiki:research", "wiki:queued"]);
			const prOpen = await client.listIssues(token, owner, repo, ["wiki:research", "wiki:pr-open"]);
			const blocked = await client.listIssues(token, owner, repo, ["wiki:research", "wiki:blocked"]);
			const publishBlocked: WikiResearchIssue[] = [];
			if (client.listIssueComments) {
				for (const issue of blocked) {
					const comments = await client.listIssueComments(token, { owner, repo, issueNumber: issue.number });
					if (comments.some(comment => isPostMergePublishBlockedComment(comment.body))) publishBlocked.push(issue);
				}
			}
			const issueMode: "research" | "publish_retry" = queued.length || prOpen.length ? "research" : "publish_retry";
			const issues = queued.length ? queued : prOpen.length ? prOpen : publishBlocked;
			result.scanned += issues.length;
			const issue = [...issues].sort((a, b) =>
				String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
			)[0];
			if (!issue) continue;
			if (issueMode === "publish_retry" && publishBlocked.some(item => item.number === issue.number)) {
				const quickPublishRetry = Boolean(options.seedWhenEmpty);
				const verification = await runWikiResearchPublishVerification({
					...options,
					owner,
					repo,
					issue: `${owner}/${repo}#${issue.number}`,
					publishVerificationAttempts: quickPublishRetry ? 1 : options.publishVerificationAttempts,
					publishVerificationDelayMs: quickPublishRetry ? 0 : options.publishVerificationDelayMs,
				});
				result.processed.push({
					repo,
					issueNumber: issue.number,
					issueUrl: issue.htmlUrl,
					status: verification.status === "verified" ? "good_enough" : "blocked",
					prUrl: verification.prUrl,
					liveUrl: verification.liveUrl,
				});
				if (verification.status === "blocked") {
					result.blocked.push({
						repo,
						issueNumber: issue.number,
						reason: verification.verification.errors.join("; ") || "publish verification still blocked",
					});
				}
				continue;
			}
			if (contentIssuesProcessed >= maxIssues) continue;
			const state = await runWikiResearchHarness(`queue ${owner}/${repo}#${issue.number}`, {
				...options,
				owner,
				repo,
				issue: `${owner}/${repo}#${issue.number}`,
				fromIssues: false,
				steeringPath: loadedSteering.path ?? options.steeringPath,
				registryPath: options.registryPath ?? registry.path,
				autoMerge: options.autoMerge ?? "off",
				researcher,
			});
			const researchGate = state.gates?.find(gate => gate.id === "researcher");
			const researchBrief = (await Bun.file(
				path.join(getHarnessRunDir(state.runId), "responses", "wiki-research-brief.json"),
			)
				.json()
				.catch(() => undefined)) as Partial<WikiResearchBriefEnvelope> | undefined;
			const draftArtifact = state.artifacts.find(artifact => artifact.source === "wiki-research");
			let liveUrl: string | undefined;
			if (draftArtifact?.path) {
				try {
					const draft = JSON.parse(
						await fs.readFile(
							path.join(getHarnessRunDir(state.runId), "responses", "wiki-page-draft.json"),
							"utf8",
						),
					) as WikiPageDraftEnvelope;
					liveUrl = wikiUrlForDraft(draft.source_id, draft);
				} catch {
					liveUrl = undefined;
				}
			}
			result.processed.push({
				repo,
				issueNumber: issue.number,
				issueUrl: issue.htmlUrl,
				runId: state.runId,
				status: state.status === "good_enough" ? "good_enough" : "blocked",
				prUrl: prUrlFromState(state),
				liveUrl,
				workerId: researchGate?.workerId,
				requestId: researchGate?.requestId,
				conversationUrl: researchGate?.conversationUrl,
				schemaValidation:
					researchGate?.status === "passed" ? "passed" : researchGate?.status === "failed" ? "failed" : "skipped",
				citationCount: Array.isArray(researchBrief?.citations) ? researchBrief.citations.length : undefined,
			});
			contentIssuesProcessed += 1;
		} catch (error) {
			result.blocked.push({
				repo,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (contentIssuesProcessed === 0 && options.seedWhenEmpty) {
		if (!options.apply || !token) {
			result.blocked.push({
				repo: registryRepo,
				reason: "autopilot queue seeding requires --apply and a GitHub token",
			});
		} else {
			const seeded = await createAutopilotSeedIssue(token, client, owner, registry.snapshot, repos);
			result.seeded = {
				repo: seeded.repo,
				issueNumber: seeded.issue.number,
				issueUrl: seeded.issue.htmlUrl,
				title: seeded.issue.title,
				sourceId: seeded.sourceId,
			};
			const seededRun = await runWikiResearchQueue({
				...options,
				repos: [seeded.repo],
				maxIssues: 1,
				seedWhenEmpty: false,
			});
			result.scanned += seededRun.scanned;
			result.processed.push(...seededRun.processed);
			result.blocked.push(...seededRun.blocked);
		}
	}
	result.finishedAt = new Date().toISOString();
	return result;
}

export async function runWikiResearchPublishVerification(
	options: WikiResearchOptions = {},
): Promise<WikiPublishRetryResult> {
	const token = getGitHubToken(options);
	if (options.apply && !token) throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
	const loadedSteering = await loadSteering(options);
	const steering = loadedSteering.steering;
	const owner = options.owner ?? steering.owner ?? "YOUR_ORG";
	const repo = options.repo ?? steering.registryRepo ?? "wiki-data-registry";
	if (!options.issue) throw new Error("--issue is required for verify-publish");
	const parsed = parseIssueRef(options.issue, { owner, repo });
	const client = options.githubClient ?? fetchWikiResearchGitHubClient;
	const issue = await client.getIssue(token, parsed.owner, parsed.repo, parsed.number);
	if (!client.listIssueComments) throw new Error("GitHub client cannot read issue comments for publish verification");
	const comments = await client.listIssueComments(token, {
		owner: issue.owner,
		repo: issue.repo,
		issueNumber: issue.number,
	});
	const context = await publishRetryContext(token, client, issue, comments);
	const verification = await verifyPublishedWikiArtifacts(token ?? "", client, {
		owner: issue.owner,
		repo: issue.repo,
		sourceId: context.sourceId,
		expectedCommit: context.mergeSha,
		draft: context.draft,
		options,
	});
	const liveUrl = wikiUrlForDraft(context.sourceId, context.draft);
	const result: WikiPublishRetryResult = {
		schemaVersion: "omg.wiki.publish_retry.v1",
		owner: issue.owner,
		repo: issue.repo,
		issueNumber: issue.number,
		issueUrl: issue.htmlUrl,
		status: verification.ok ? "verified" : "blocked",
		prUrl: context.prUrl,
		runId: context.runId,
		mergeSha: context.mergeSha,
		liveUrl,
		verification,
	};
	const reportRunId =
		context.runId ??
		(
			await createHarnessRun(`wiki publish verification ${issue.owner}/${issue.repo}#${issue.number}`, {
				template: "wiki-research",
			})
		).runId;
	result.runId = result.runId ?? reportRunId;
	result.verificationReportPath = await writeRunFile(
		reportRunId,
		"validation",
		"wiki-publish-verification.json",
		`${JSON.stringify(result, null, 2)}\n`,
	);
	if (options.apply && token) {
		if (verification.ok) {
			await setIssueState(token, client, issue, "wiki:merged");
			await client.commentIssue(token, {
				owner: issue.owner,
				repo: issue.repo,
				issueNumber: issue.number,
				body: [
					"OMG wiki research published and verified",
					"",
					`Merge: ${context.mergeSha}`,
					`PR: ${context.prUrl ?? "unknown"}`,
					`Live page: ${liveUrl}`,
					`Workflow: ${verification.workflowUrl ?? "not found"}`,
					"",
					...(verification.warnings.length
						? ["Warnings:", ...verification.warnings.map(warning => `- ${warning}`), ""]
						: []),
					"Checked URLs:",
					...verification.checkedUrls.map(url => `- ${url}`),
				].join("\n"),
			});
			if (client.closeIssue) {
				await client.closeIssue(token, { owner: issue.owner, repo: issue.repo, issueNumber: issue.number });
			}
		} else {
			await setIssueState(token, client, issue, "wiki:blocked");
			await client.commentIssue(token, {
				owner: issue.owner,
				repo: issue.repo,
				issueNumber: issue.number,
				body: [
					"OMG wiki research publish verification still blocked",
					"",
					`Expected commit: ${context.mergeSha}`,
					`Workflow: ${verification.workflowUrl ?? "not found"}`,
					"",
					"Errors:",
					...(verification.errors.length ? verification.errors.map(error => `- ${error}`) : ["- unknown"]),
					"",
					...(verification.warnings.length
						? ["Warnings:", ...verification.warnings.map(warning => `- ${warning}`), ""]
						: []),
					"Checked URLs:",
					...verification.checkedUrls.map(url => `- ${url}`),
				].join("\n"),
			});
		}
	}
	return result;
}

function isPostMergePublishBlockedComment(body: string): boolean {
	return /Post-merge publish verification failed|publish verification still blocked/i.test(body);
}

async function publishRetryContext(
	token: string | undefined,
	client: WikiResearchGitHubClient,
	issue: WikiResearchIssue,
	comments: Array<{ body: string }>,
): Promise<{ runId?: string; prUrl?: string; mergeSha: string; sourceId: string; draft: WikiPageDraftEnvelope }> {
	const joined = comments.map(comment => comment.body).join("\n\n");
	const runId = [...joined.matchAll(/Run:\s*([^\s]+)/g)].at(-1)?.[1];
	const prUrl = [...joined.matchAll(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/g)].at(-1)?.[0];
	const mergeSha =
		[...joined.matchAll(/Expected commit:\s*([a-f0-9]{40})/gi)].at(-1)?.[1] ??
		[...joined.matchAll(/merged at\s+([a-f0-9]{40})/gi)].at(-1)?.[1];
	if (!mergeSha) throw new Error("could not find merge SHA in issue comments");
	const sourceId = sourceFromLabels(issue.labels) ?? issue.repo.replace(/^wiki-data-/, "");
	const runDraftPath = runId ? path.join(getHarnessRunDir(runId), "responses", "wiki-page-draft.json") : "";
	if (runDraftPath && (await Bun.file(runDraftPath).exists())) {
		return { runId, prUrl, mergeSha, sourceId, draft: JSON.parse(await fs.readFile(runDraftPath, "utf8")) };
	}
	const pullNumber = prUrl?.match(/\/pull\/(\d+)/)?.[1];
	const files =
		pullNumber && client.listPullRequestFiles
			? await client.listPullRequestFiles(token ?? "", {
					owner: issue.owner,
					repo: issue.repo,
					pullNumber: Number(pullNumber),
				})
			: [];
	const file = files.find(item => /^docs\/.+\.md$/.test(item.filename))?.filename;
	if (!file) throw new Error("could not recover published draft path from run artifacts or PR files");
	return {
		runId,
		prUrl,
		mergeSha,
		sourceId,
		draft: {
			schema_version: "omg.wiki.page_draft.v1",
			status: "complete",
			source_id: sourceId,
			path: file,
			markdown: "",
			citations: [],
		},
	};
}

export async function runWikiResearchWatchdog(
	options: WikiResearchWatchdogOptions = {},
): Promise<WikiResearchWatchdogResult> {
	const checkedAt = (options.now ?? new Date()).toISOString();
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = (options.localModelBaseUrl ?? DEFAULT_QWEN_BASE_URL).replace(/\/+$/, "");
	const model = options.localModel ?? DEFAULT_QWEN_MODEL;
	const findings: string[] = [];
	const recommendedActions: string[] = [];

	const localModel: WikiResearchWatchdogResult["localModel"] = {
		baseUrl,
		model,
		modelsOk: false,
		pingOk: false,
		schemaValidation: "skipped",
	};
	try {
		const modelsResponse = await fetchImpl(`${baseUrl}/models`);
		if (!modelsResponse.ok) throw new Error(`/models returned HTTP ${modelsResponse.status}`);
		const modelsJson = safeJson(await modelsResponse.text()) as { data?: Array<{ id?: string }> } | undefined;
		const modelIds = (modelsJson?.data ?? []).map(item => item.id).filter(Boolean);
		localModel.modelsOk = modelIds.length === 0 || modelIds.includes(model);

		const pingResponse = await fetchImpl(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{
						role: "system",
						content:
							"Return strict JSON only. You are an operations watchdog. You cannot approve wiki content, merges, or publishing.",
					},
					{
						role: "user",
						content:
							'Return {"schemaVersion":"omg.wiki.watchdog_probe.v1","ok":true,"summary":"reachable"} and nothing else.',
					},
				],
				temperature: 0,
				max_tokens: 80,
			}),
		});
		if (!pingResponse.ok) throw new Error(`/chat/completions returned HTTP ${pingResponse.status}`);
		const pingJson = safeJson(await pingResponse.text()) as
			| { choices?: Array<{ message?: { content?: string } }> }
			| undefined;
		const content = pingJson?.choices?.[0]?.message?.content?.trim() ?? "";
		const parsed = safeJson(content) as { schemaVersion?: string; ok?: boolean } | undefined;
		localModel.pingOk = parsed?.ok === true;
		localModel.schemaValidation =
			parsed?.schemaVersion === "omg.wiki.watchdog_probe.v1" && parsed.ok === true ? "passed" : "failed";
	} catch (error) {
		localModel.error = error instanceof Error ? error.message : String(error);
		localModel.schemaValidation = localModel.schemaValidation === "skipped" ? "failed" : localModel.schemaValidation;
	}

	const chatgpt: WikiResearchWatchdogResult["chatgpt"] = { rateLimitOk: false };
	try {
		const rateLimit = options.chatGptRateLimitRunner
			? await options.chatGptRateLimitRunner()
			: await runProcessJson(["chatgpt", "rate-limit", "status", "--json"], 30_000);
		chatgpt.rateLimitOk = rateLimit.ok;
		if (!rateLimit.ok) chatgpt.error = rateLimit.stderr || rateLimit.stdout || `exit ${rateLimit.exitCode}`;
	} catch (error) {
		chatgpt.error = error instanceof Error ? error.message : String(error);
	}

	const automation = await readWikiResearchAutomationHealth(options.automationsDir);
	if (!localModel.modelsOk || !localModel.pingOk || localModel.schemaValidation !== "passed") {
		findings.push("local Qwen watchdog probe is unhealthy");
		recommendedActions.push("check local model service reachability");
	}
	if (!chatgpt.rateLimitOk) {
		findings.push("ChatGPT CLI rate-limit status is unavailable");
		recommendedActions.push("verify ChatGPT CLI session before the next queue run");
	}
	if (!automation.queueActive) {
		findings.push("hourly wiki research queue automation was not found");
		recommendedActions.push("create or re-enable omg wiki-research run-queue automation");
	}
	if (!automation.benchmarkActive) {
		findings.push("daily wiki research benchmark automation was not found");
		recommendedActions.push("create or re-enable omg wiki-research benchmark automation");
	}
	if (!automation.watchdogActive) {
		findings.push("wiki research watchdog automation was not found");
		recommendedActions.push("create or re-enable omg wiki-research watchdog automation");
	}
	const critical = !chatgpt.rateLimitOk || !automation.queueActive;
	const status = findings.length ? (critical ? "critical" : "warning") : "healthy";
	return {
		schemaVersion: "omg.wiki.watchdog.v1",
		checkedAt,
		localModel,
		chatgpt,
		automation,
		health: {
			ok: findings.length === 0,
			status,
			findings,
			recommendedActions,
		},
	};
}

async function runProcessJson(
	command: string[],
	timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timeout = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exitCode === 0, exitCode, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

async function readWikiResearchAutomationHealth(
	automationsDir?: string,
): Promise<WikiResearchWatchdogResult["automation"]> {
	const root =
		automationsDir ??
		(process.env.CODEX_HOME
			? path.join(process.env.CODEX_HOME, "automations")
			: path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex", "automations"));
	const result = { queueActive: false, benchmarkActive: false, watchdogActive: false };
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const text = await fs.readFile(path.join(root, entry.name, "automation.toml"), "utf8").catch(() => "");
		result.queueActive ||= text.includes("wiki-research run-queue") && text.includes("ACTIVE");
		result.benchmarkActive ||= text.includes("wiki-research benchmark") && text.includes("ACTIVE");
		result.watchdogActive ||= text.includes("wiki-research watchdog") && text.includes("ACTIVE");
	}
	return result;
}

export const fetchWikiResearchGitHubClient: WikiResearchGitHubClient = {
	async getAuthenticatedUser(token) {
		const response = await fetch("https://api.github.com/user", { headers: githubHeaders(token) });
		if (!response.ok) throw new Error(`GitHub auth failed with HTTP ${response.status}`);
		const data = (await response.json()) as { login?: string };
		if (!data.login) throw new Error("GitHub auth response did not include login");
		return { login: data.login };
	},
	async getRepo(token, owner, repo) {
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: githubHeaders(token) });
		if (response.status === 404) return { exists: false };
		if (!response.ok) throw new Error(`GitHub repo lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as { default_branch?: string; pushed_at?: string };
		const defaultBranch = data.default_branch ?? "main";
		const ref = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, {
			headers: githubHeaders(token),
		});
		if (!ref.ok) throw new Error(`GitHub default branch lookup failed with HTTP ${ref.status}`);
		const refData = (await ref.json()) as { object?: { sha?: string } };
		return { exists: true, defaultBranch, sha: refData.object?.sha };
	},
	async getIssue(token, owner, repo, issueNumber) {
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
			headers: githubHeaders(token),
		});
		if (!response.ok) throw new Error(`GitHub issue lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as {
			number: number;
			title: string;
			body?: string;
			html_url: string;
			created_at?: string;
			labels?: Array<{ name?: string } | string>;
		};
		return {
			number: data.number,
			title: data.title,
			body: data.body ?? "",
			labels: (data.labels ?? [])
				.map(label => (typeof label === "string" ? label : (label.name ?? "")))
				.filter(Boolean),
			htmlUrl: data.html_url,
			owner,
			repo,
			createdAt: data.created_at,
		};
	},
	async listIssues(token, owner, repo, labels) {
		const params = new URLSearchParams({ state: "open", labels: labels.join(","), per_page: "20" });
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?${params}`, {
			headers: githubHeaders(token),
		});
		if (!response.ok) throw new Error(`GitHub issue list failed with HTTP ${response.status}`);
		const data = (await response.json()) as Array<{
			number: number;
			title: string;
			body?: string;
			html_url: string;
			created_at?: string;
			labels?: Array<{ name?: string } | string>;
			pull_request?: unknown;
		}>;
		return data
			.filter(item => !item.pull_request)
			.map(item => ({
				number: item.number,
				title: item.title,
				body: item.body ?? "",
				labels: (item.labels ?? [])
					.map(label => (typeof label === "string" ? label : (label.name ?? "")))
					.filter(Boolean),
				htmlUrl: item.html_url,
				owner,
				repo,
				createdAt: item.created_at,
			}));
	},
	async createIssue(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
		});
		if (!response.ok) throw new Error(`GitHub issue create failed with HTTP ${response.status}`);
		const data = (await response.json()) as {
			number: number;
			title: string;
			body?: string;
			html_url: string;
			labels?: Array<{ name?: string } | string>;
		};
		return {
			number: data.number,
			title: data.title,
			body: data.body ?? "",
			labels: (data.labels ?? [])
				.map(label => (typeof label === "string" ? label : (label.name ?? "")))
				.filter(Boolean),
			htmlUrl: data.html_url,
			owner: input.owner,
			repo: input.repo,
		};
	},
	async commentIssue(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
			{
				method: "POST",
				headers: githubHeaders(token),
				body: JSON.stringify({ body: input.body }),
			},
		);
		if (!response.ok) throw new Error(`GitHub issue comment failed with HTTP ${response.status}`);
		const data = (await response.json()) as { html_url?: string };
		return { htmlUrl: data.html_url };
	},
	async listIssueComments(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`,
			{ headers: githubHeaders(token) },
		);
		if (!response.ok) throw new Error(`GitHub issue comments lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as Array<{ body?: string; html_url?: string; created_at?: string }>;
		return data.map(item => ({
			body: item.body ?? "",
			htmlUrl: item.html_url,
			createdAt: item.created_at,
		}));
	},
	async addLabels(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/labels`,
			{
				method: "POST",
				headers: githubHeaders(token),
				body: JSON.stringify({ labels: input.labels }),
			},
		);
		if (!response.ok) throw new Error(`GitHub issue label update failed with HTTP ${response.status}`);
	},
	async removeLabel(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/labels/${encodeURIComponent(input.label)}`,
			{ method: "DELETE", headers: githubHeaders(token) },
		);
		if (!response.ok && response.status !== 404)
			throw new Error(`GitHub issue label removal failed with HTTP ${response.status}`);
	},
	async ensureLabel(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/labels`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ name: input.label, color: input.color, description: input.description }),
		});
		if (!response.ok && response.status !== 422)
			throw new Error(`GitHub label create failed with HTTP ${response.status}`);
	},
	async createBranch(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/refs`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.fromSha }),
		});
		if (!response.ok && response.status !== 422)
			throw new Error(`GitHub branch create failed with HTTP ${response.status}`);
		return { ref: `refs/heads/${input.branch}` };
	},
	async putFile(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}`,
			{
				method: "PUT",
				headers: githubHeaders(token),
				body: JSON.stringify({
					message: input.message,
					content: Buffer.from(input.content, "utf8").toString("base64"),
					branch: input.branch,
					sha: input.sha,
				}),
			},
		);
		if (!response.ok) throw new Error(`GitHub put file failed with HTTP ${response.status}`);
		const data = (await response.json()) as { commit?: { sha?: string } };
		return { commitSha: data.commit?.sha ?? "" };
	},
	async getFile(token, input) {
		const params = new URLSearchParams({ ref: input.branch });
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}?${params}`,
			{ headers: githubHeaders(token) },
		);
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error(`GitHub get file failed with HTTP ${response.status}`);
		const data = (await response.json()) as { sha?: string; content?: string; encoding?: string };
		return {
			sha: data.sha,
			content:
				data.encoding === "base64" && data.content
					? Buffer.from(data.content, "base64").toString("utf8")
					: undefined,
		};
	},
	async listPullRequests(token, input) {
		const params = new URLSearchParams({ state: input.state ?? "open", per_page: "20" });
		if (input.head) params.set("head", `${input.owner}:${input.head}`);
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls?${params}`, {
			headers: githubHeaders(token),
		});
		if (!response.ok) throw new Error(`GitHub PR list failed with HTTP ${response.status}`);
		const data = (await response.json()) as Array<{
			number: number;
			html_url: string;
			mergeable_state?: string;
			head?: { ref?: string; sha?: string };
		}>;
		return data.map(item => ({
			number: item.number,
			htmlUrl: item.html_url,
			headRef: item.head?.ref,
			headSha: item.head?.sha,
			mergeableState: item.mergeable_state,
		}));
	},
	async createPullRequest(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
		});
		if (!response.ok) throw new Error(`GitHub PR create failed with HTTP ${response.status}`);
		const data = (await response.json()) as { number: number; html_url: string };
		return { number: data.number, htmlUrl: data.html_url };
	},
	async listPullRequestFiles(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/files?per_page=100`,
			{ headers: githubHeaders(token) },
		);
		if (!response.ok) throw new Error(`GitHub PR files failed with HTTP ${response.status}`);
		const data = (await response.json()) as Array<{ filename: string; status?: string }>;
		return data.map(item => ({ filename: item.filename, status: item.status }));
	},
	async listCheckRunsForRef(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/commits/${input.ref}/check-runs`,
			{
				headers: {
					...githubHeaders(token),
					Accept: "application/vnd.github+json",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub checks lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as {
			check_runs?: Array<{ name: string; status: string; conclusion?: string | null; html_url?: string }>;
		};
		return (data.check_runs ?? []).map(item => ({
			name: item.name,
			status: item.status,
			conclusion: item.conclusion,
			htmlUrl: item.html_url,
		}));
	},
	async listWorkflowRuns(token, input) {
		const params = new URLSearchParams({ per_page: "20" });
		if (input.headSha) params.set("head_sha", input.headSha);
		if (input.event) params.set("event", input.event);
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/actions/runs?${params}`, {
			headers: githubHeaders(token),
		});
		if (!response.ok) throw new Error(`GitHub workflow run lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as {
			workflow_runs?: Array<{
				name?: string;
				status?: string;
				conclusion?: string | null;
				head_sha?: string;
				html_url?: string;
			}>;
		};
		return (data.workflow_runs ?? [])
			.map(item => ({
				name: item.name ?? "",
				status: item.status ?? "",
				conclusion: item.conclusion,
				headSha: item.head_sha,
				htmlUrl: item.html_url,
			}))
			.filter(item => !input.workflowName || item.name === input.workflowName);
	},
	async compareCommits(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/compare/${input.base}...${input.head}`,
			{ headers: githubHeaders(token) },
		);
		if (!response.ok) throw new Error(`GitHub compare failed with HTTP ${response.status}`);
		const data = (await response.json()) as { status?: string };
		return { status: data.status };
	},
	async mergePullRequest(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/merge`,
			{
				method: "PUT",
				headers: githubHeaders(token),
				body: JSON.stringify({ commit_title: input.commitTitle, merge_method: "squash" }),
			},
		);
		if (!response.ok) throw new Error(`GitHub PR merge failed with HTTP ${response.status}`);
		const data = (await response.json()) as { merged?: boolean; message?: string; sha?: string };
		return { merged: Boolean(data.merged), message: data.message, sha: data.sha };
	},
	async closeIssue(token, input) {
		const response = await fetch(
			`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
			{
				method: "PATCH",
				headers: githubHeaders(token),
				body: JSON.stringify({ state: "closed" }),
			},
		);
		if (!response.ok) throw new Error(`GitHub issue close failed with HTTP ${response.status}`);
	},
};

async function setIssueState(
	token: string,
	client: WikiResearchGitHubClient,
	issue: WikiResearchIssue,
	next: WikiIssueStateLabel,
): Promise<void> {
	for (const label of STATE_LABELS) {
		if (label !== next && issue.labels.includes(label)) {
			await client.removeLabel(token, { owner: issue.owner, repo: issue.repo, issueNumber: issue.number, label });
		}
	}
	await client.addLabels(token, {
		owner: issue.owner,
		repo: issue.repo,
		issueNumber: issue.number,
		labels: issueStateLabels(next),
	});
	issue.labels = [
		...issue.labels.filter(label => !STATE_LABELS.includes(label as WikiIssueStateLabel)),
		...issueStateLabels(next),
	];
}

async function trySafeAutoMerge(
	token: string,
	client: WikiResearchGitHubClient,
	input: {
		issue: WikiResearchIssue;
		targetRepo: string;
		pr: { number: number; htmlUrl: string; headSha?: string };
		review: WikiResearchReviewEnvelope;
		draft: WikiPageDraftEnvelope;
	},
): Promise<{ merged: boolean; reason: string; sha?: string }> {
	if (!client.listPullRequestFiles || !client.listCheckRunsForRef || !client.mergePullRequest) {
		return { merged: false, reason: "safe auto-merge skipped; GitHub client does not expose merge checks" };
	}
	if (!input.review.approved || input.review.blocking_findings.length) {
		return { merged: false, reason: "safe auto-merge blocked by critic findings" };
	}
	if (!input.draft.citations.length) {
		return { merged: false, reason: "safe auto-merge blocked because draft has no citations" };
	}
	const files = await client.listPullRequestFiles(token, {
		owner: input.issue.owner,
		repo: input.targetRepo,
		pullNumber: input.pr.number,
	});
	if (!files.length) return { merged: false, reason: "safe auto-merge blocked because PR file list is empty" };
	const unsafe = files.filter(file => !isSafeAutoMergePath(file.filename));
	if (unsafe.length) {
		return {
			merged: false,
			reason: `safe auto-merge blocked by non-content files: ${unsafe.map(file => file.filename).join(", ")}`,
		};
	}
	if (!input.pr.headSha) return { merged: false, reason: "safe auto-merge waiting for PR head SHA" };
	const checks = await client.listCheckRunsForRef(token, {
		owner: input.issue.owner,
		repo: input.targetRepo,
		ref: input.pr.headSha,
	});
	const pending = checks.filter(check => check.status !== "completed");
	if (pending.length) {
		return {
			merged: false,
			reason: `safe auto-merge waiting for checks: ${pending.map(check => check.name).join(", ")}`,
		};
	}
	const failed = checks.filter(
		check => check.conclusion && check.conclusion !== "success" && check.conclusion !== "neutral",
	);
	if (failed.length) {
		return {
			merged: false,
			reason: `safe auto-merge blocked by checks: ${failed.map(check => check.name).join(", ")}`,
		};
	}
	const merged = await client.mergePullRequest(token, {
		owner: input.issue.owner,
		repo: input.targetRepo,
		pullNumber: input.pr.number,
		commitTitle: `Wiki research: ${input.issue.title}`,
	});
	if (!merged.merged) return { merged: false, reason: merged.message ?? "GitHub did not merge the pull request" };
	await setIssueState(token, client, input.issue, "wiki:merged");
	return { merged: true, reason: merged.sha ? `merged at ${merged.sha}` : "merged", sha: merged.sha };
}

async function verifyPublishedWikiArtifacts(
	token: string,
	client: WikiResearchGitHubClient,
	input: {
		owner: string;
		repo: string;
		sourceId: string;
		expectedCommit: string;
		draft: WikiPageDraftEnvelope;
		options: WikiResearchOptions;
	},
): Promise<WikiPublishVerificationResult> {
	const fetchImpl = input.options.fetchImpl ?? fetch;
	const attempts = Math.max(1, input.options.publishVerificationAttempts ?? 12);
	const delayMs = Math.max(0, input.options.publishVerificationDelayMs ?? 10_000);
	const latestUrls = jsDelivrPointerUrls(input.owner, input.repo, "latest.json");
	const latestAgentUrls = jsDelivrPointerUrls(input.owner, input.repo, "latest-agent.json");
	const latestUrl = latestUrls[0];
	const latestAgentUrl = latestAgentUrls[0];
	const result: WikiPublishVerificationResult = {
		ok: false,
		expectedCommit: input.expectedCommit,
		latestUrl,
		latestAgentUrl,
		attempts: [],
		errors: [],
		warnings: [],
		checkedUrls: [...latestUrls, ...latestAgentUrls],
	};

	if (!client.getFile) {
		result.errors.push("GitHub client cannot read published/latest.json");
		return result;
	}

	await waitForPublishWorkflow(token, client, {
		owner: input.owner,
		repo: input.repo,
		expectedCommit: input.expectedCommit,
		attempts,
		delayMs,
		result,
	});
	const workflowErrors = [...result.errors];

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const checkedUrls = [...latestUrls, ...latestAgentUrls];
		const errors: string[] = [...workflowErrors];
		const warnings: string[] = [];
		const githubLatest = await readPublishedJson(token, client, input.owner, input.repo, "latest.json");
		const githubAgent = await readPublishedJson(token, client, input.owner, input.repo, "latest-agent.json");
		const githubLatestCommit = stringField(githubLatest, "sourceCommit");
		const githubAgentCommit = stringField(githubAgent, "sourceCommit");
		const acceptableCommit = createPublishedCommitAcceptor(token, client, input);
		if (!(await acceptableCommit(githubLatestCommit))) {
			errors.push(
				`GitHub published/latest.json points at ${githubLatestCommit ?? "missing"}, expected ${input.expectedCommit} or a descendant commit`,
			);
		}
		if (!(await acceptableCommit(githubAgentCommit))) {
			errors.push(
				`GitHub published/latest-agent.json points at ${githubAgentCommit ?? "missing"}, expected ${input.expectedCommit} or a descendant commit`,
			);
		}

		await Promise.all([...latestUrls, ...latestAgentUrls].map(url => purgeJsDelivr(fetchImpl, url)));
		const cdnLatestResults = await Promise.all(latestUrls.map(url => fetchJson(fetchImpl, url, checkedUrls)));
		const cdnAgentResults = await Promise.all(latestAgentUrls.map(url => fetchJson(fetchImpl, url, checkedUrls)));
		const cdnLatestCommits = Object.fromEntries(
			latestUrls.map((url, index) => [url, stringField(cdnLatestResults[index]?.value, "sourceCommit")]),
		);
		const cdnAgentCommits = Object.fromEntries(
			latestAgentUrls.map((url, index) => [url, stringField(cdnAgentResults[index]?.value, "sourceCommit")]),
		);
		for (const [index, cdnLatest] of cdnLatestResults.entries()) {
			const url = latestUrls[index];
			const commit = cdnLatestCommits[url];
			const pointerIssues = index === 0 ? errors : warnings;
			if (!cdnLatest.ok) pointerIssues.push(`${url} fetch failed: ${cdnLatest.error}`);
			else if (!(await acceptableCommit(commit))) {
				pointerIssues.push(
					`${url} is stale at ${commit ?? "missing"}, expected ${input.expectedCommit} or a descendant commit`,
				);
			}
		}
		for (const [index, cdnAgent] of cdnAgentResults.entries()) {
			const url = latestAgentUrls[index];
			const commit = cdnAgentCommits[url];
			const pointerIssues = index === 0 ? errors : warnings;
			if (!cdnAgent.ok) pointerIssues.push(`${url} fetch failed: ${cdnAgent.error}`);
			else if (!(await acceptableCommit(commit))) {
				pointerIssues.push(
					`${url} is stale at ${commit ?? "missing"}, expected ${input.expectedCommit} or a descendant commit`,
				);
			}
		}

		let latestForArtifacts: (typeof cdnLatestResults)[number] | undefined;
		for (const item of cdnLatestResults) {
			if (item.ok && (await acceptableCommit(stringField(item.value, "sourceCommit")))) {
				latestForArtifacts = item;
				break;
			}
		}
		let agentForArtifacts: (typeof cdnAgentResults)[number] | undefined;
		for (const item of cdnAgentResults) {
			if (item.ok && (await acceptableCommit(stringField(item.value, "sourceCommit")))) {
				agentForArtifacts = item;
				break;
			}
		}
		if (!errors.length && latestForArtifacts?.value && agentForArtifacts?.value) {
			errors.push(
				...(await verifyArtifactUrls(
					fetchImpl,
					latestForArtifacts.value,
					agentForArtifacts.value,
					input,
					checkedUrls,
				)),
			);
		}

		const attemptResult = {
			attempt,
			ok: errors.length === 0,
			errors,
			warnings,
			githubLatestCommit,
			githubAgentCommit,
			cdnLatestCommit: cdnLatestCommits[latestUrl],
			cdnAgentCommit: cdnAgentCommits[latestAgentUrl],
			cdnLatestCommits,
			cdnAgentCommits,
			checkedUrls,
		};
		result.attempts.push(attemptResult);
		result.checkedUrls = [...new Set([...result.checkedUrls, ...checkedUrls])];
		if (attemptResult.ok) {
			result.ok = true;
			result.warnings = warnings;
			return result;
		}
		if (attempt < attempts && delayMs) await sleep(delayMs);
	}

	result.errors = result.attempts.at(-1)?.errors ?? ["publish verification did not complete"];
	result.warnings = result.attempts.at(-1)?.warnings ?? [];
	return result;
}

function jsDelivrPointerUrls(owner: string, repo: string, fileName: "latest.json" | "latest-agent.json"): string[] {
	const path = `/gh/${owner}/${repo}@published/${fileName}`;
	return [
		`https://cdn.jsdelivr.net${path}`,
		`https://fastly.jsdelivr.net${path}`,
		`https://gcore.jsdelivr.net${path}`,
		`https://testingcf.jsdelivr.net${path}`,
	];
}

async function waitForPublishWorkflow(
	token: string | undefined,
	client: WikiResearchGitHubClient,
	input: {
		owner: string;
		repo: string;
		expectedCommit: string;
		attempts: number;
		delayMs: number;
		result: WikiPublishVerificationResult;
	},
): Promise<void> {
	if (!client.listWorkflowRuns) return;
	for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
		const runs = await client.listWorkflowRuns(token, {
			owner: input.owner,
			repo: input.repo,
			headSha: input.expectedCommit,
			workflowName: "Publish wiki data",
			event: "push",
		});
		const run =
			runs.find(item => item.headSha === input.expectedCommit && item.name === "Publish wiki data") ?? runs[0];
		if (run?.htmlUrl) input.result.workflowUrl = run.htmlUrl;
		if (run?.status === "completed") {
			if (run.conclusion && run.conclusion !== "success") {
				input.result.errors.push(`publish workflow concluded ${run.conclusion}: ${run.htmlUrl ?? "no url"}`);
			}
			return;
		}
		if (attempt < input.attempts && input.delayMs) await sleep(input.delayMs);
	}
}

function createPublishedCommitAcceptor(
	token: string | undefined,
	client: WikiResearchGitHubClient,
	input: { owner: string; repo: string; expectedCommit: string },
): (candidate: string | undefined) => Promise<boolean> {
	const cache = new Map<string, Promise<boolean>>();
	return async candidate => {
		if (!candidate) return false;
		if (candidate === input.expectedCommit) return true;
		if (!client.compareCommits) return false;
		let cached = cache.get(candidate);
		if (!cached) {
			cached = client
				.compareCommits(token, {
					owner: input.owner,
					repo: input.repo,
					base: input.expectedCommit,
					head: candidate,
				})
				.then(compare => compare.status === "ahead" || compare.status === "identical")
				.catch(() => false);
			cache.set(candidate, cached);
		}
		return cached;
	};
}

async function readPublishedJson(
	token: string,
	client: WikiResearchGitHubClient,
	owner: string,
	repo: string,
	filePath: string,
): Promise<unknown> {
	const file = await client.getFile?.(token, { owner, repo, branch: "published", path: filePath });
	if (!file?.content) return undefined;
	return safeJson(file.content);
}

async function verifyArtifactUrls(
	fetchImpl: typeof fetch,
	latest: unknown,
	latestAgent: unknown,
	input: { sourceId: string; draft: WikiPageDraftEnvelope },
	checkedUrls: string[],
): Promise<string[]> {
	const errors: string[] = [];
	const urls = [
		stringField(latest, "manifestUrl"),
		stringField(latest, "catalogUrl"),
		stringField(latest, "tagsUrl"),
		stringField(latest, "graphUrl"),
		stringField(latest, "healthUrl"),
		stringField(latest, "agentManifestUrl"),
		stringField(latestAgent, "chunksIndexUrl"),
		stringField(latestAgent, "llmsSourceUrl"),
	].filter(Boolean) as string[];
	const contentBaseUrl = stringField(latest, "contentBaseUrl");
	if (contentBaseUrl) urls.push(new URL(input.draft.path.replace(/^docs\//, ""), contentBaseUrl).toString());
	urls.push(wikiUrlForDraft(input.sourceId, input.draft));

	for (const url of urls) {
		checkedUrls.push(url);
		const response = await fetchImpl(url);
		if (!response.ok) errors.push(`${url} returned HTTP ${response.status}`);
	}

	const manifestUrl = stringField(latest, "manifestUrl");
	if (manifestUrl) {
		const manifest = await fetchJson(fetchImpl, manifestUrl, checkedUrls);
		const slug = input.draft.path.replace(/^docs\//, "").replace(/\.md$/, "");
		const pages = Array.isArray((manifest.value as { pages?: unknown[] } | undefined)?.pages)
			? ((manifest.value as { pages?: unknown[] }).pages ?? [])
			: [];
		if (!pages.some(page => (page as { slug?: unknown }).slug === slug)) {
			errors.push(`${manifestUrl} does not include page slug ${slug}`);
		}
	}
	return errors;
}

async function fetchJson(
	fetchImpl: typeof fetch,
	url: string,
	checkedUrls: string[],
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; value?: undefined }> {
	checkedUrls.push(url);
	try {
		const response = await fetchImpl(url);
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
		return { ok: true, value: safeJson(await response.text()) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function purgeJsDelivr(fetchImpl: typeof fetch, url: string): Promise<void> {
	try {
		const parsed = new URL(url);
		await fetchImpl(`https://purge.jsdelivr.net${parsed.pathname}`);
	} catch {
		// Purge is best-effort; verification below is authoritative.
	}
}

function stringField(value: unknown, key: string): string | undefined {
	return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[key] === "string"
		? ((value as Record<string, unknown>)[key] as string)
		: undefined;
}

export async function runWikiResearchHarness(
	objective: string,
	options: WikiResearchOptions = {},
): Promise<HarnessRunState> {
	const state = await createHarnessRun(objective, {
		promptLimit: options.promptLimit ?? 10,
		template: "wiki-research",
	});
	return await continueWikiResearchHarness(state, options);
}

export async function resumeWikiResearchHarness(
	runId: string,
	options: WikiResearchOptions = {},
): Promise<HarnessRunState> {
	const state = await readRunState(runId);
	if (state.template !== "wiki-research") throw new Error(`run ${runId} is not a wiki-research harness run`);
	if (state.status === "good_enough" || state.status === "abandoned") return state;
	state.status = "active";
	if (options.promptLimit) state.promptBudget.limit = options.promptLimit;
	await writeRunState(state);
	return await continueWikiResearchHarness(state, options);
}

async function continueWikiResearchHarness(
	state: HarnessRunState,
	options: WikiResearchOptions = {},
): Promise<HarnessRunState> {
	ensureHarnessGates(state);
	const token = getGitHubToken(options);
	const client = options.githubClient ?? fetchWikiResearchGitHubClient;
	try {
		await startGate(state, "doctor", options);
		const doctorPath = await writeRunFile(
			state.runId,
			"validation",
			"wiki-research-doctor.json",
			`${JSON.stringify({ apply: Boolean(options.apply), checks: [redactedTokenCheck(token, Boolean(options.apply))] }, null, 2)}\n`,
		);
		if (options.apply && !token) {
			await failGate(state, "doctor", options, "GITHUB_TOKEN or GITHUB_PAT is required for --apply", {
				outputPaths: [doctorPath],
			});
			throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
		}
		await passGate(state, "doctor", options, { outputPaths: [doctorPath] });

		await startGate(state, "steering_load", options);
		let loadedSteering: Awaited<ReturnType<typeof loadSteering>>;
		try {
			loadedSteering = await loadSteering(options);
		} catch (error) {
			const summary = error instanceof Error ? error.message : String(error);
			await failGate(state, "steering_load", options, summary);
			throw error;
		}
		const steeringPath = await writeRunFile(
			state.runId,
			"artifacts",
			"wiki-steering-effective.json",
			`${JSON.stringify(loadedSteering, null, 2)}\n`,
		);
		await passGate(state, "steering_load", options, {
			summary: loadedSteering.defaulted
				? "dry-run conservative steering defaults loaded"
				: `steering loaded from ${loadedSteering.path}`,
			outputPaths: [steeringPath],
		});
		const steering = loadedSteering.steering;

		await startGate(state, "issue_fetch", options);
		const owner = options.owner ?? steering.owner ?? "YOUR_ORG";
		const repo = options.repo ?? steering.registryRepo ?? "wiki-data-registry";
		let issue: WikiResearchIssue;
		if (options.fromIssues) {
			const issues = await client.listIssues(token, owner, repo, ["wiki:research", "wiki:queued"]);
			const sorted = [...issues].sort((a, b) => {
				const priority = (value: WikiResearchIssue) =>
					value.labels.includes("priority:high") ? 0 : value.labels.includes("priority:normal") ? 1 : 2;
				return priority(a) - priority(b) || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
			});
			if (!sorted[0]) throw new Error("no queued wiki research issues found");
			issue = sorted[0];
		} else if (options.issue) {
			const parsed = parseIssueRef(options.issue, { owner, repo });
			issue = await client.getIssue(token, parsed.owner, parsed.repo, parsed.number);
		} else {
			issue = (await readPreviousIssueArtifact(state.runId)) ?? {
				number: 0,
				title: state.objective,
				body: `## Objective\n${state.objective}\n`,
				labels: ["wiki:research", "wiki:queued"],
				htmlUrl: "",
				owner,
				repo,
			};
		}
		const issuePath = await writeRunFile(
			state.runId,
			"artifacts",
			"issue.json",
			`${JSON.stringify(issue, null, 2)}\n`,
		);
		await passGate(state, "issue_fetch", options, {
			summary: `issue ${issue.owner}/${issue.repo}#${issue.number || "local"}`,
			outputPaths: [issuePath],
		});
		if (options.apply && token && issue.number) {
			await setIssueState(token, client, issue, "wiki:in-progress");
			await client.commentIssue(token, {
				owner: issue.owner,
				repo: issue.repo,
				issueNumber: issue.number,
				body: compactStatusComment(state, "leased", "This issue is leased by the 24/7 wiki research runner."),
			});
		}

		await startGate(state, "registry_snapshot", options);
		const registry = await readRegistrySnapshot(options, steering);
		const registryPath = await writeRunFile(
			state.runId,
			"artifacts",
			"registry-snapshot.json",
			`${JSON.stringify(registry.snapshot, null, 2)}\n`,
		);
		await passGate(state, "registry_snapshot", options, {
			summary: `registry loaded from ${registry.path}`,
			outputPaths: [registryPath],
		});

		const issueBody = parseWikiResearchIssueBody(issue);
		await startGate(state, "source_decision", options);
		const candidateSourceDecision = decideSource(issue, issueBody, registry.snapshot, steering);
		const boundaryDecision = sourceBoundaryDecision(owner, issue, issueBody, candidateSourceDecision);
		const sourcePath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-source-candidate.json",
			`${JSON.stringify(candidateSourceDecision, null, 2)}\n`,
		);
		const boundaryPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-source-boundary-decision.json",
			`${JSON.stringify(boundaryDecision, null, 2)}\n`,
		);
		if (candidateSourceDecision.action === "needs_source_decision") {
			if (options.apply && token && issue.number) {
				await setIssueState(token, client, issue, "wiki:needs-source-decision");
				await client.commentIssue(token, {
					owner: issue.owner,
					repo: issue.repo,
					issueNumber: issue.number,
					body: compactStatusComment(
						state,
						"needs-source-decision",
						[
							candidateSourceDecision.reason,
							"",
							`Proposed source: ${boundaryDecision.proposedSourceId ?? "unknown"}`,
							`Proposed repo: ${boundaryDecision.proposedRepoName ?? "unknown"}`,
							`Threshold: ${boundaryDecision.threshold}`,
							"",
							"Top existing candidates:",
							...(boundaryDecision.topCandidates.length
								? boundaryDecision.topCandidates.map(
										item => `- ${item.sourceId} (${item.label}) score ${item.score}`,
									)
								: ["- none"]),
							"",
							`Next action: ${boundaryDecision.recommendedNextAction ?? "review source boundary"}`,
							boundaryDecision.recommendedCommand ? `Command: \`${boundaryDecision.recommendedCommand}\`` : "",
						]
							.filter(Boolean)
							.join("\n"),
					),
				});
			}
			await failGate(state, "source_decision", options, candidateSourceDecision.reason, {
				outputPaths: [sourcePath, boundaryPath],
			});
			throw new Error(candidateSourceDecision.reason);
		}
		let sourceDecision = candidateSourceDecision;
		await passGate(state, "source_decision", options, {
			summary: candidateSourceDecision.reason,
			outputPaths: [sourcePath, boundaryPath],
		});

		await startGate(state, "issue_route", options);
		let activeIssue = issue;
		const targetRepo = sourceDecision.repoName ?? issue.repo;
		if (targetRepo !== issue.repo) {
			if (options.apply && token && issue.number) {
				activeIssue = await client.createIssue(token, {
					owner: issue.owner,
					repo: targetRepo,
					title: issue.title,
					body: `${issue.body}\n\nRouted from ${issue.htmlUrl || `${issue.owner}/${issue.repo}#${issue.number}`}.`,
					labels: [...new Set([...issueStateLabels("wiki:queued"), `source:${sourceDecision.sourceId}`])],
				});
				await client.commentIssue(token, {
					owner: issue.owner,
					repo: issue.repo,
					issueNumber: issue.number,
					body: compactStatusComment(state, "routed", `Created routed issue: ${activeIssue.htmlUrl}`),
				});
			}
			await passGate(state, "issue_route", options, { summary: `issue routed to ${issue.owner}/${targetRepo}` });
		} else {
			await passGate(state, "issue_route", options, { summary: "issue already belongs to target source repo" });
		}

		await startGate(state, "research_packet", options);
		const packetPath = await writeRunFile(
			state.runId,
			"packets",
			"wiki-research-packet.json",
			`${JSON.stringify({ issue: activeIssue, parsedIssue: issueBody, sourceDecision, steering }, null, 2)}\n`,
		);
		state.evidencePackets = [packetPath];
		await writeRunState(state);
		await passGate(state, "research_packet", options, { outputPaths: [packetPath] });

		await startGate(state, "researcher", options);
		const researcherMode = effectiveResearcher(options);
		let research: WikiResearchBriefEnvelope;
		let researchPath: string;
		let contentPlan: WikiContentPlanEnvelope | undefined;
		let draftInstructions: WikiDraftInstructionsEnvelope | undefined;
		let chatGptCriticReview: WikiResearchReviewEnvelope | undefined;
		let researchWorker:
			| {
					workerId: string;
					requestId?: string;
					conversationUrl?: string;
			  }
			| undefined;
		try {
			if (researcherMode === "chatgpt") {
				const chatgptResearch = await runChatGptResearchBrief(
					state,
					activeIssue,
					issueBody,
					candidateSourceDecision,
					registry.snapshot,
					steering,
					options,
				);
				sourceDecision = {
					action: "use_existing_source",
					sourceId: chatgptResearch.sourceDecision.source_id,
					repoName: chatgptResearch.sourceDecision.repo_name,
					reason: chatgptResearch.sourceDecision.reason,
				};
				research = chatgptResearch.research;
				researchPath =
					chatgptResearch.responsePaths.find(item => item.endsWith("wiki-research-brief.json")) ??
					chatgptResearch.responsePaths[0]!;
				contentPlan = chatgptResearch.contentPlan;
				draftInstructions = chatgptResearch.draftInstructions;
				chatGptCriticReview = chatgptResearch.criticReview;
				researchWorker = {
					workerId: chatgptResearch.workerId,
					requestId: chatgptResearch.requestId,
					conversationUrl: chatgptResearch.conversationUrl,
				};
			} else {
				research = discoverResearchBrief(activeIssue, issueBody, sourceDecision.sourceId, steering);
				researchPath = await writeRunFile(
					state.runId,
					"responses",
					"wiki-research-brief.json",
					`${JSON.stringify(research, null, 2)}\n`,
				);
			}
		} catch (error) {
			if (researcherMode === "chatgpt" && options.allowDeterministicFallback) {
				await writeRunFile(
					state.runId,
					"responses",
					"researcher-chatgpt-fallback.json",
					`${JSON.stringify(
						{
							schemaVersion: "omg.wiki.researcher_fallback.v1",
							reason: error instanceof Error ? error.message : String(error),
						},
						null,
						2,
					)}\n`,
				);
				research = discoverResearchBrief(activeIssue, issueBody, sourceDecision.sourceId, steering);
				researchPath = await writeRunFile(
					state.runId,
					"responses",
					"wiki-research-brief.json",
					`${JSON.stringify(research, null, 2)}\n`,
				);
			} else {
				const reason = error instanceof Error ? error.message : String(error);
				if (options.apply && token && activeIssue.number) {
					await setIssueState(token, client, activeIssue, "wiki:blocked");
					await client.commentIssue(token, {
						owner: activeIssue.owner,
						repo: activeIssue.repo,
						issueNumber: activeIssue.number,
						body: compactStatusComment(state, "blocked", reason),
					});
				}
				await failGate(state, "researcher", options, reason);
				throw error;
			}
		}
		const researchValidation = WikiResearchBriefEnvelopeSchema.safeParse(research);
		const researchErrors = researchValidation.success
			? validateCompletedResearchBrief(research, steering, researcherMode)
			: [researchValidation.error.message];
		if (researchErrors.length) {
			const reason = researchErrors.join("; ");
			if (options.apply && token && activeIssue.number) {
				await setIssueState(token, client, activeIssue, "wiki:blocked");
				await client.commentIssue(token, {
					owner: activeIssue.owner,
					repo: activeIssue.repo,
					issueNumber: activeIssue.number,
					body: compactStatusComment(state, "blocked", reason),
				});
			}
			await failGate(state, "researcher", options, reason, {
				outputPaths: [researchPath],
				workerRole: researcherMode === "chatgpt" ? "researcher" : undefined,
				workerId: researchWorker?.workerId,
				requestId: researchWorker?.requestId,
				conversationUrl: researchWorker?.conversationUrl,
			});
			throw new Error(reason);
		}
		await passGate(state, "researcher", options, {
			outputPaths: [researchPath],
			workerRole: researcherMode === "chatgpt" ? "researcher" : undefined,
			workerId: researchWorker?.workerId,
			requestId: researchWorker?.requestId,
			conversationUrl: researchWorker?.conversationUrl,
			summary: `${researcherMode} research produced ${research.citations.length} citation(s)`,
		});

		await startGate(state, "content_plan", options);
		const plan: WikiContentPlanEnvelope = contentPlan ?? {
			schema_version: "omg.wiki.content_plan.v1",
			status: "complete",
			source_id: sourceDecision.sourceId!,
			pages: [
				{
					title: normalizeResearchTitle(activeIssue.title),
					slug: stableDraftPath(activeIssue)
						.replace(/^docs\//, "")
						.replace(/\.md$/, ""),
					description: issueBody.expectedOutput ?? issueBody.objective,
					tags: ["research", sourceDecision.sourceId!],
					reader_value: issueBody.expectedOutput ?? issueBody.objective,
					outline: [
						"Summary",
						"Checklist",
						"Decision Guidance",
						"Common Pitfalls",
						"Maintenance Notes",
						"Sources",
					],
				},
			],
		};
		const planPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-content-plan.json",
			`${JSON.stringify(plan, null, 2)}\n`,
		);
		const planValidation = WikiContentPlanEnvelopeSchema.safeParse(plan);
		if (!planValidation.success) {
			await failGate(state, "content_plan", options, planValidation.error.message, { outputPaths: [planPath] });
			throw new Error("wiki content plan failed schema validation");
		}
		if (plan.status !== "complete" || plan.source_id !== sourceDecision.sourceId || !plan.pages.length) {
			const reason = "wiki content plan is not complete or does not match the selected source";
			await failGate(state, "content_plan", options, reason, { outputPaths: [planPath] });
			throw new Error(reason);
		}
		await passGate(state, "content_plan", options, { outputPaths: [planPath] });

		await startGate(state, "draft_builder", options);
		const draft = draftMarkdown(activeIssue, issueBody, sourceDecision.sourceId!, research, draftInstructions);
		const draftFile = await writeDraftWorkspace(state, draft);
		const draftJson = await writeRunFile(
			state.runId,
			"responses",
			"wiki-page-draft.json",
			`${JSON.stringify(draft, null, 2)}\n`,
		);
		const draftValidation = WikiPageDraftEnvelopeSchema.safeParse(draft);
		if (!draftValidation.success) {
			await failGate(state, "draft_builder", options, draftValidation.error.message, { outputPaths: [draftJson] });
			throw new Error("wiki page draft failed schema validation");
		}
		state.artifacts.push({ source: "wiki-research", path: draftFile, validationStatus: "drafted" });
		await writeRunState(state);
		await passGate(state, "draft_builder", options, { outputPaths: [draftJson, draftFile] });

		await startGate(state, "validate_content", options);
		const draftErrors = validateDraft(draft, steering);
		const validationPath = await writeRunFile(
			state.runId,
			"validation",
			"wiki-research-content-validation.json",
			`${JSON.stringify({ ok: draftErrors.length === 0, errors: draftErrors }, null, 2)}\n`,
		);
		if (draftErrors.length) {
			await failGate(state, "validate_content", options, draftErrors.join("; "), { outputPaths: [validationPath] });
			throw new Error(`wiki research content validation failed: ${draftErrors.join("; ")}`);
		}
		state.validation.push({
			status: "passed",
			summary: "wiki research content validation passed",
			logPath: validationPath,
		});
		await writeRunState(state);
		await passGate(state, "validate_content", options, { outputPaths: [validationPath] });

		const branch = stableIssueBranch(steering, activeIssue, sourceDecision.sourceId!);
		await startGate(state, "branch_create", options);
		let pr: { number: number; htmlUrl: string; headSha?: string } | undefined;
		if (!options.apply) {
			await skipGate(state, "branch_create", options, "dry-run; branch not created");
			await skipGate(state, "pr_create", options, "dry-run; PR not created");
		} else if (token) {
			const repoInfo = await client.getRepo(token, activeIssue.owner, targetRepo);
			const base = repoInfo.defaultBranch ?? "main";
			const sha = repoInfo.sha ?? "0000000000000000000000000000000000000000";
			await client.createBranch(token, { owner: activeIssue.owner, repo: targetRepo, branch, fromSha: sha });
			const existingFile = client.getFile
				? await client.getFile(token, { owner: activeIssue.owner, repo: targetRepo, branch, path: draft.path })
				: undefined;
			await client.putFile(token, {
				owner: activeIssue.owner,
				repo: targetRepo,
				branch,
				path: draft.path,
				content: draft.markdown,
				message: `Add wiki research draft for #${activeIssue.number}`,
				sha: existingFile?.sha,
			});
			await passGate(state, "branch_create", options, { summary: branch });
			await startGate(state, "pr_create", options);
			const existingPr = client.listPullRequests
				? (
						await client.listPullRequests(token, {
							owner: activeIssue.owner,
							repo: targetRepo,
							head: branch,
							state: "open",
						})
					)[0]
				: undefined;
			pr =
				existingPr ??
				(await client.createPullRequest(token, {
					owner: activeIssue.owner,
					repo: targetRepo,
					title: `Wiki research: ${activeIssue.title}`,
					body: [
						`Drafted from ${activeIssue.htmlUrl || `issue #${activeIssue.number}`}.`,
						"",
						`Research run: ${state.runId}`,
						`Research backend: ${researcherMode}`,
						...(researchWorker?.workerId ? [`ChatGPT worker: ${researchWorker.workerId}`] : []),
						...(researchWorker?.requestId ? [`ChatGPT request: ${researchWorker.requestId}`] : []),
						...(researchWorker?.conversationUrl
							? [`ChatGPT conversation: ${researchWorker.conversationUrl}`]
							: []),
						`Live page after publish: ${wikiUrlForDraft(sourceDecision.sourceId!, draft)}`,
						"",
						`Safe auto-merge: ${options.autoMerge === "safe" ? "enabled for content-only PRs" : "disabled"}.`,
						`Closes after merge policy: ${steering.closeBehavior}.`,
					].join("\n"),
					head: branch,
					base,
				}));
			if (!pr.headSha && client.listPullRequests) {
				const refreshedPr = (
					await client.listPullRequests(token, {
						owner: activeIssue.owner,
						repo: targetRepo,
						head: branch,
						state: "open",
					})
				).find(candidate => candidate.number === pr?.number);
				if (refreshedPr?.headSha) pr = { ...pr, headSha: refreshedPr.headSha };
			}
			await passGate(state, "pr_create", options, { summary: pr.htmlUrl });
		}

		await startGate(state, "issue_update", options);
		if (options.apply && token && activeIssue.number) {
			await setIssueState(token, client, activeIssue, pr ? "wiki:pr-open" : "wiki:needs-review");
			await client.commentIssue(token, {
				owner: activeIssue.owner,
				repo: activeIssue.repo,
				issueNumber: activeIssue.number,
				body: compactStatusComment(
					state,
					"validated",
					pr ? `Draft PR opened: ${pr.htmlUrl}` : "Dry-run completed.",
				),
			});
		}
		await passGate(state, "issue_update", options, {
			summary: pr ? `issue linked to ${pr.htmlUrl}` : "dry-run issue update skipped",
		});

		await startGate(state, "critic", options);
		const localReview = reviewDraft(draft, research);
		const review: WikiResearchReviewEnvelope =
			chatGptCriticReview && (!localReview.approved || localReview.blocking_findings.length)
				? {
						...chatGptCriticReview,
						approved: false,
						verdict: "not_good_enough",
						blocking_findings: [...chatGptCriticReview.blocking_findings, ...localReview.blocking_findings],
						non_blocking_findings: [
							...chatGptCriticReview.non_blocking_findings,
							...localReview.non_blocking_findings,
						],
					}
				: (chatGptCriticReview ?? localReview);
		const reviewPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-review.json",
			`${JSON.stringify(review, null, 2)}\n`,
		);
		const reviewValidation = WikiResearchReviewEnvelopeSchema.safeParse(review);
		if (!reviewValidation.success || !review.approved) {
			await failGate(state, "critic", options, "wiki research critic did not approve", {
				outputPaths: [reviewPath],
			});
			throw new Error("wiki research critic did not approve");
		}
		await passGate(state, "critic", options, { outputPaths: [reviewPath] });

		let mergeResult: { merged: boolean; reason: string; sha?: string } | undefined;
		await startGate(state, "safe_auto_merge", options);
		if (!options.apply || !token || !pr || options.autoMerge !== "safe") {
			await skipGate(
				state,
				"safe_auto_merge",
				options,
				options.autoMerge === "safe"
					? "dry-run or missing PR; safe auto-merge skipped"
					: "safe auto-merge disabled",
			);
		} else if (researcherMode !== "chatgpt" || !researchWorker?.workerId) {
			await skipGate(
				state,
				"safe_auto_merge",
				options,
				"safe auto-merge blocked because this run does not have schema-valid ChatGPT researcher metadata",
			);
		} else {
			const merge = await trySafeAutoMerge(token, client, {
				issue: activeIssue,
				targetRepo,
				pr,
				review,
				draft,
			});
			mergeResult = merge;
			if (merge.merged) {
				await passGate(state, "safe_auto_merge", options, { summary: merge.reason });
				await client.commentIssue(token, {
					owner: activeIssue.owner,
					repo: activeIssue.repo,
					issueNumber: activeIssue.number,
					body: compactStatusComment(state, "merged", `${pr.htmlUrl}\n\n${merge.reason}`),
				});
			} else {
				await skipGate(state, "safe_auto_merge", options, merge.reason);
			}
		}

		await startGate(state, "publish_verify", options);
		if (!options.apply || !token || !mergeResult?.merged || !mergeResult.sha) {
			await skipGate(
				state,
				"publish_verify",
				options,
				mergeResult?.merged ? "merge SHA unavailable; publish verification skipped" : "no merged PR to verify",
			);
		} else {
			const publishVerification = await verifyPublishedWikiArtifacts(token, client, {
				owner: activeIssue.owner,
				repo: targetRepo,
				sourceId: sourceDecision.sourceId,
				expectedCommit: mergeResult.sha,
				draft,
				options,
			});
			const publishVerificationPath = await writeRunFile(
				state.runId,
				"validation",
				"wiki-publish-verification.json",
				`${JSON.stringify(publishVerification, null, 2)}\n`,
			);
			if (publishVerification.ok) {
				await passGate(state, "publish_verify", options, {
					summary: `published artifacts verified at ${mergeResult.sha}`,
					outputPaths: [publishVerificationPath],
				});
				if (client.closeIssue && activeIssue.number && steering.closeBehavior === "after_pr_merge") {
					await client.closeIssue(token, {
						owner: activeIssue.owner,
						repo: activeIssue.repo,
						issueNumber: activeIssue.number,
					});
				}
			} else {
				const summary = publishVerification.errors.join("; ") || "publish verification failed";
				await failGate(state, "publish_verify", options, summary, {
					outputPaths: [publishVerificationPath],
				});
				await setIssueState(token, client, activeIssue, "wiki:blocked");
				await client.commentIssue(token, {
					owner: activeIssue.owner,
					repo: activeIssue.repo,
					issueNumber: activeIssue.number,
					body: compactStatusComment(
						state,
						"blocked",
						[
							"Post-merge publish verification failed.",
							"",
							`Expected commit: ${mergeResult.sha}`,
							`Workflow: ${publishVerification.workflowUrl ?? "not found"}`,
							"",
							"Errors:",
							...publishVerification.errors.map(error => `- ${error}`),
							"",
							"Checked URLs:",
							...publishVerification.checkedUrls.map(url => `- ${url}`),
						].join("\n"),
					),
				});
				throw new Error(summary);
			}
		}

		await startGate(state, "report", options);
		state.status = "good_enough";
		state.verdict = "good_enough";
		await writeRunState(state);
		await passGate(state, "report", options, {
			outputPaths: [path.join(getHarnessRunDir(state.runId), "report.md")],
		});
		await writeReport(state);
		return state;
	} catch (error) {
		state.status = "blocked";
		state.verdict = "blocked";
		state.validation.push({ status: "failed", summary: error instanceof Error ? error.message : String(error) });
		await writeRunState(state);
		await writeReport(state);
		throw error;
	}
}
