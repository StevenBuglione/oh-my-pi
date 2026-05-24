import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
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
	type WikiPageDraftEnvelope,
	WikiPageDraftEnvelopeSchema,
	type WikiResearchBriefEnvelope,
	WikiResearchBriefEnvelopeSchema,
	type WikiResearchReviewEnvelope,
	WikiResearchReviewEnvelopeSchema,
} from "./types";

export const WIKI_RESEARCH_REQUIRED_LABELS = [
	"wiki:research",
	"wiki:queued",
	"wiki:in-progress",
	"wiki:needs-source-decision",
	"wiki:needs-review",
	"wiki:pr-open",
	"wiki:blocked",
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
		input: { owner: string; repo: string; branch: string; path: string; content: string; message: string },
	): Promise<{ commitSha: string }>;
	createPullRequest(
		token: string,
		input: { owner: string; repo: string; title: string; body: string; head: string; base: string },
	): Promise<{ number: number; htmlUrl: string }>;
}

export interface WikiResearchOptions {
	owner?: string;
	repo?: string;
	issue?: string;
	fromIssues?: boolean;
	steeringPath?: string;
	registryPath?: string;
	apply?: boolean;
	promptLimit?: number;
	githubToken?: string;
	githubClient?: WikiResearchGitHubClient;
	onEvent?: (message: string) => void;
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
}

const DEFAULT_STEERING: WikiResearchSteering = {
	branchPrefix: "omg/wiki-research",
	prLabels: ["wiki:needs-review"],
	maxIssuesPerRun: 1,
	maxPagesPerIssue: 1,
	blockedDomains: [],
	closeBehavior: "after_pr_merge",
};

const STATE_LABELS: WikiIssueStateLabel[] = [
	"wiki:queued",
	"wiki:in-progress",
	"wiki:needs-source-decision",
	"wiki:needs-review",
	"wiki:pr-open",
	"wiki:blocked",
	"wiki:done",
];

function emit(options: WikiResearchOptions, message: string): void {
	options.onEvent?.(message);
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
	const qualified = ref.match(/^([^/]+)\/([^/]+)#?(\d+)$/);
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
): { action: "use_existing_source" | "needs_source_decision"; sourceId?: string; repoName?: string; reason: string } {
	const preferred = sourceFromLabels(issue.labels) ?? body.preferredSource;
	if (preferred && registry.sources.some(source => source.id === preferred)) {
		return {
			action: "use_existing_source",
			sourceId: preferred,
			repoName: `wiki-data-${preferred}`,
			reason: `Preferred source ${preferred} is registered.`,
		};
	}
	const objectiveWords = words(body.objective);
	const ranked = registry.sources
		.map(source => ({ source, score: similarity(objectiveWords, sourceTokens(source)) }))
		.sort((a, b) => b.score - a.score);
	const best = ranked[0];
	if (best && best.score >= 0.16) {
		return {
			action: "use_existing_source",
			sourceId: best.source.id,
			repoName: `wiki-data-${best.source.id}`,
			reason: `Issue overlaps existing source ${best.source.id} with score ${best.score.toFixed(2)}.`,
		};
	}
	return { action: "needs_source_decision", reason: "No registered source confidently covers this issue." };
}

async function readRegistrySnapshot(
	options: WikiResearchOptions,
	steering: WikiResearchSteering,
): Promise<{ snapshot: WikiRegistrySnapshot; path: string }> {
	const registryPath =
		options.registryPath ?? steering.registryPath ?? path.join(process.cwd(), "wiki-data-registry", "sources.json");
	const text = await fs.readFile(registryPath, "utf8");
	const parsed = JSON.parse(text) as WikiRegistrySnapshot;
	if (!Array.isArray(parsed.sources)) throw new Error("registry sources must be an array");
	return { snapshot: parsed, path: registryPath };
}

async function loadSteering(
	options: WikiResearchOptions,
): Promise<{ steering: WikiResearchSteering; path?: string; defaulted: boolean }> {
	const steeringPath = options.steeringPath ?? path.join(process.cwd(), "wiki.steering.json");
	try {
		const parsed = JSON.parse(await fs.readFile(steeringPath, "utf8")) as Partial<WikiResearchSteering>;
		return {
			steering: {
				...DEFAULT_STEERING,
				...parsed,
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

function draftMarkdown(issue: WikiResearchIssue, body: WikiResearchIssueBody, sourceId: string): WikiPageDraftEnvelope {
	const title = issue.title.replace(/^\[[^\]]+\]\s*/, "").trim();
	const slug = slugify(title);
	const citationLines = body.citations.map(
		url => `  - title: ${url}\n    url: ${url}\n    accessed: ${new Date().toISOString().slice(0, 10)}`,
	);
	const markdown = [
		"---",
		`title: ${title}`,
		`description: ${body.expectedOutput ?? body.objective}`,
		"tags:",
		"  - research",
		"area: general",
		"status: draft",
		"difficulty: intermediate",
		"review_status: ai_draft",
		"human_reviewed: false",
		`last_verified: ${new Date().toISOString().slice(0, 10)}`,
		"confidence: medium",
		"sources:",
		...(citationLines.length ? citationLines : ["  []"]),
		"---",
		"",
		`# ${title}`,
		"",
		body.objective,
		"",
		"## Research Notes",
		"",
		body.acceptanceNotes.length
			? body.acceptanceNotes.map(item => `- ${item}`).join("\n")
			: "- Initial AI-assisted research draft.",
		"",
		"## Sources",
		"",
		...(body.citations.length ? body.citations.map(url => `- ${url}`) : ["- Citation required before publication."]),
		"",
	].join("\n");
	return {
		schema_version: "omg.wiki.page_draft.v1",
		status: "complete",
		source_id: sourceId,
		path: `docs/${slug}.md`,
		markdown,
		citations: body.citations,
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
	if (!/last_verified:\s*\d{4}-\d{2}-\d{2}/.test(draft.markdown))
		errors.push("draft frontmatter must include last_verified");
	if (!draft.citations.length) errors.push("factual wiki research drafts require at least one citation URL");
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
		return { exists: true, defaultBranch: data.default_branch ?? "main", sha: undefined };
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
				}),
			},
		);
		if (!response.ok) throw new Error(`GitHub put file failed with HTTP ${response.status}`);
		const data = (await response.json()) as { commit?: { sha?: string } };
		return { commitSha: data.commit?.sha ?? "" };
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
			issue = {
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
		const sourceDecision = decideSource(issue, issueBody, registry.snapshot);
		const sourcePath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-source-decision.json",
			`${JSON.stringify(sourceDecision, null, 2)}\n`,
		);
		if (sourceDecision.action === "needs_source_decision") {
			if (options.apply && token && issue.number) {
				await setIssueState(token, client, issue, "wiki:needs-source-decision");
				await client.commentIssue(token, {
					owner: issue.owner,
					repo: issue.repo,
					issueNumber: issue.number,
					body: compactStatusComment(state, "blocked", sourceDecision.reason),
				});
			}
			await failGate(state, "source_decision", options, sourceDecision.reason, { outputPaths: [sourcePath] });
			throw new Error(sourceDecision.reason);
		}
		await passGate(state, "source_decision", options, { summary: sourceDecision.reason, outputPaths: [sourcePath] });

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
		const research: WikiResearchBriefEnvelope = {
			schema_version: "omg.wiki.research_brief.v1",
			status: issueBody.citations.length ? "complete" : "blocked",
			topic: issueBody.objective,
			summary: issueBody.objective,
			citations: issueBody.citations,
			findings: issueBody.acceptanceNotes,
			confidence: issueBody.citations.length ? 0.8 : 0.2,
		};
		const researchPath = await writeRunFile(
			state.runId,
			"responses",
			"wiki-research-brief.json",
			`${JSON.stringify(research, null, 2)}\n`,
		);
		const researchValidation = WikiResearchBriefEnvelopeSchema.safeParse(research);
		if (!researchValidation.success || research.status !== "complete") {
			await failGate(state, "researcher", options, "research issue needs at least one citation URL", {
				outputPaths: [researchPath],
			});
			throw new Error("research issue needs at least one citation URL");
		}
		await passGate(state, "researcher", options, { outputPaths: [researchPath] });

		await startGate(state, "content_plan", options);
		const plan: WikiContentPlanEnvelope = {
			schema_version: "omg.wiki.content_plan.v1",
			status: "complete",
			source_id: sourceDecision.sourceId!,
			pages: [
				{
					title: activeIssue.title,
					slug: slugify(activeIssue.title),
					description: issueBody.expectedOutput ?? issueBody.objective,
					tags: ["research"],
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
		await passGate(state, "content_plan", options, { outputPaths: [planPath] });

		await startGate(state, "draft_builder", options);
		const draft = draftMarkdown(activeIssue, issueBody, sourceDecision.sourceId!);
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

		const branch = `${steering.branchPrefix}/${state.runId.slice(0, 8)}-${sourceDecision.sourceId}`;
		await startGate(state, "branch_create", options);
		let pr: { number: number; htmlUrl: string } | undefined;
		if (!options.apply) {
			await skipGate(state, "branch_create", options, "dry-run; branch not created");
			await skipGate(state, "pr_create", options, "dry-run; PR not created");
		} else if (token) {
			const repoInfo = await client.getRepo(token, activeIssue.owner, targetRepo);
			const base = repoInfo.defaultBranch ?? "main";
			const sha = repoInfo.sha ?? "0000000000000000000000000000000000000000";
			await client.createBranch(token, { owner: activeIssue.owner, repo: targetRepo, branch, fromSha: sha });
			await client.putFile(token, {
				owner: activeIssue.owner,
				repo: targetRepo,
				branch,
				path: draft.path,
				content: draft.markdown,
				message: `Add wiki research draft for #${activeIssue.number}`,
			});
			await passGate(state, "branch_create", options, { summary: branch });
			await startGate(state, "pr_create", options);
			pr = await client.createPullRequest(token, {
				owner: activeIssue.owner,
				repo: targetRepo,
				title: `Wiki research: ${activeIssue.title}`,
				body: `Drafted from ${activeIssue.htmlUrl || `issue #${activeIssue.number}`}.\n\nCloses after merge policy: ${steering.closeBehavior}.`,
				head: branch,
				base,
			});
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
		const review: WikiResearchReviewEnvelope = {
			schema_version: "omg.wiki.research_review.v1",
			approved: true,
			blocking_findings: [],
			non_blocking_findings: [],
			verdict: "good_enough",
		};
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
