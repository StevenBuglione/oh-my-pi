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
	type WikiSourceDecisionEnvelope,
	WikiSourceDecisionEnvelopeSchema,
} from "./types";

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

export interface WikiSourceGitHubClient {
	getAuthenticatedUser(token: string): Promise<{ login: string }>;
	getRepo(
		token: string,
		owner: string,
		repo: string,
	): Promise<{ exists: boolean; defaultBranch?: string; sha?: string }>;
	createRepo(
		token: string,
		input: { owner: string; repo: string; private: boolean; description: string; org?: boolean },
	): Promise<{ htmlUrl: string; defaultBranch: string; sha?: string }>;
	putFile(
		token: string,
		input: { owner: string; repo: string; branch: string; path: string; content: string; message: string },
	): Promise<{ commitSha: string }>;
	createBranch(
		token: string,
		input: { owner: string; repo: string; branch: string; fromSha: string },
	): Promise<{ ref: string }>;
}

export interface WikiSourceOptions {
	owner?: string;
	registryPath?: string;
	apply?: boolean;
	private?: boolean;
	promptLimit?: number;
	githubToken?: string;
	githubClient?: WikiSourceGitHubClient;
	onEvent?: (message: string) => void;
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const REQUIRED_SEED_FILES = [
	"README.md",
	"wiki.source.json",
	"docs/index.md",
	"assets/.gitkeep",
	"package.json",
	"scripts/build-wiki.ts",
	"scripts/validate-wiki.ts",
	".github/workflows/publish.yml",
];

function emit(options: WikiSourceOptions, message: string): void {
	options.onEvent?.(message);
}

async function startGate(state: HarnessRunState, id: string, options: WikiSourceOptions): Promise<void> {
	emit(options, `running ${id}`);
	await setGateStatus(state, id, "running");
}

async function passGate(
	state: HarnessRunState,
	id: string,
	options: WikiSourceOptions,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `passed ${id}`);
	await setGateStatus(state, id, "passed", fields);
}

async function failGate(
	state: HarnessRunState,
	id: string,
	options: WikiSourceOptions,
	error: string,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `failed ${id}: ${error}`);
	await setGateStatus(state, id, "failed", { ...fields, error });
}

async function skipGate(
	state: HarnessRunState,
	id: string,
	options: WikiSourceOptions,
	summary: string,
): Promise<void> {
	emit(options, `skipped ${id}: ${summary}`);
	await setGateStatus(state, id, "skipped", { summary });
}

function titleCase(value: string): string {
	return value
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function words(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/[\s-]+/)
		.filter(word => word.length > 2)
		.filter(word => !["create", "source", "wiki", "data", "repo", "notes", "small", "test"].includes(word));
}

function slugify(value: string): string {
	const slug = words(value).slice(0, 3).join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return slug || "reference";
}

function similarity(a: string[], b: string[]): number {
	if (!a.length || !b.length) return 0;
	const left = new Set(a);
	const right = new Set(b);
	const intersection = [...left].filter(word => right.has(word)).length;
	const union = new Set([...left, ...right]).size;
	return union ? intersection / union : 0;
}

function sourceTokens(source: WikiRegistrySource): string[] {
	return words([source.id, source.label, source.description ?? ""].join(" "));
}

function classifySource(objective: string, registry: WikiRegistrySnapshot): WikiSourceDecisionEnvelope {
	const objectiveWords = words(objective);
	const ranked = registry.sources
		.map(source => ({ source, score: similarity(objectiveWords, sourceTokens(source)) }))
		.sort((a, b) => b.score - a.score);
	const best = ranked[0];
	const candidateId = slugify(objective);
	const canonicalId = candidateId.startsWith("wiki-data-") ? candidateId.slice("wiki-data-".length) : candidateId;
	if (best && best.score >= 0.24) {
		return {
			schema_version: "omg.wiki.source_decision.v1",
			status: "complete",
			recommended_action: "use_existing_source",
			source_id: best.source.id,
			repo_name: `wiki-data-${best.source.id}`,
			domain_label: best.source.label,
			reason: `Objective overlaps existing source ${best.source.id} with score ${best.score.toFixed(2)}.`,
			existing_source_candidates: ranked.slice(0, 3).map(item => item.source.id),
			confidence: Math.min(0.95, 0.7 + best.score),
			required_seed_files: [],
		};
	}
	return {
		schema_version: "omg.wiki.source_decision.v1",
		status: "complete",
		recommended_action: "create_new_source",
		source_id: canonicalId,
		repo_name: `wiki-data-${canonicalId}`,
		domain_label: titleCase(canonicalId),
		reason: "No existing registry source sufficiently covers the requested domain.",
		existing_source_candidates: ranked.slice(0, 3).map(item => item.source.id),
		confidence: objectiveWords.length >= 1 ? 0.78 : 0.4,
		required_seed_files: REQUIRED_SEED_FILES,
	};
}

function applyLocalPolicy(
	decision: WikiSourceDecisionEnvelope,
	registry: WikiRegistrySnapshot,
): { accepted: boolean; action: WikiSourceDecisionEnvelope["recommended_action"]; reason: string } {
	if (decision.status !== "complete" || decision.recommended_action === "blocked") {
		return { accepted: false, action: "blocked", reason: decision.reason || "source decision was blocked" };
	}
	if (decision.confidence < 0.65) {
		return { accepted: false, action: "blocked", reason: "source decision confidence is below 0.65" };
	}
	if (!SOURCE_ID_PATTERN.test(decision.source_id)) {
		return { accepted: false, action: "blocked", reason: `source_id ${decision.source_id} is not safe` };
	}
	if (decision.repo_name !== `wiki-data-${decision.source_id}`) {
		return { accepted: false, action: "blocked", reason: "repo_name must exactly match wiki-data-<source_id>" };
	}
	const existing = registry.sources.find(source => source.id === decision.source_id);
	if (existing) {
		return {
			accepted: true,
			action: "use_existing_source",
			reason: `source_id ${decision.source_id} already exists; route to existing source`,
		};
	}
	return { accepted: true, action: decision.recommended_action, reason: "source decision accepted by OMG policy" };
}

async function readRegistrySnapshot(
	options: WikiSourceOptions,
): Promise<{ snapshot: WikiRegistrySnapshot; path?: string }> {
	const registryPath = options.registryPath ?? path.join(process.cwd(), "wiki-data-registry", "sources.json");
	const text = await fs.readFile(registryPath, "utf8");
	const parsed = JSON.parse(text) as WikiRegistrySnapshot;
	if (!Array.isArray(parsed.sources)) throw new Error("registry sources must be an array");
	return { snapshot: parsed, path: registryPath };
}

function registryPatch(
	registry: WikiRegistrySnapshot,
	owner: string,
	decision: WikiSourceDecisionEnvelope,
): WikiRegistrySnapshot {
	const existing = registry.sources.some(source => source.id === decision.source_id);
	if (existing) return registry;
	const order = Math.max(0, ...registry.sources.map(source => Number(source.order ?? 0))) + 10;
	return {
		...registry,
		updatedAt: new Date().toISOString(),
		routeMode: "query",
		sources: [
			...registry.sources,
			{
				id: decision.source_id,
				label: decision.domain_label,
				description: decision.reason,
				enabled: true,
				order,
				latestUrl: `https://cdn.jsdelivr.net/gh/${owner}/${decision.repo_name}@published/latest.json`,
			},
		].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.id.localeCompare(b.id)),
	};
}

function seedFiles(owner: string, decision: WikiSourceDecisionEnvelope): Record<string, string> {
	const repoUrl = `https://github.com/${owner}/${decision.repo_name}`;
	const sourceConfig = {
		schemaVersion: "steve-wiki-source/v1",
		id: decision.source_id,
		label: decision.domain_label,
		description: decision.reason,
		language: "en",
		contentRoot: "docs",
		assetsRoot: "assets",
		defaultPage: "index",
		repoUrl,
		editBaseUrl: `${repoUrl}/edit/main/docs`,
		facets: {
			area: ["general"],
			status: ["draft", "active", "deprecated", "archived"],
			difficulty: ["beginner", "intermediate", "advanced"],
		},
	};
	return {
		"README.md": `# ${decision.domain_label}\n\nRepo-backed wiki data source for ${decision.domain_label}.\n`,
		"wiki.source.json": `${JSON.stringify(sourceConfig, null, 2)}\n`,
		"docs/index.md": [
			"---",
			`title: ${decision.domain_label}`,
			`description: ${decision.reason}`,
			"tags:",
			"  - index",
			"area: general",
			"status: draft",
			"difficulty: beginner",
			"review_status: ai_draft",
			"human_reviewed: false",
			`last_verified: ${new Date().toISOString().slice(0, 10)}`,
			"confidence: medium",
			"---",
			"",
			`# ${decision.domain_label}`,
			"",
			"Starter page for this wiki data source.",
			"",
		].join("\n"),
		"assets/.gitkeep": "",
		"package.json": `${JSON.stringify(
			{
				name: decision.repo_name,
				private: true,
				type: "module",
				scripts: {
					"wiki:validate": "bun scripts/validate-wiki.ts",
					"wiki:build": "bun scripts/build-wiki.ts",
				},
				devDependencies: {},
			},
			null,
			2,
		)}\n`,
		"scripts/build-wiki.ts":
			"console.log('wiki build placeholder: generated artifacts are added in the next ladder step');\n",
		"scripts/validate-wiki.ts": [
			"import { readFileSync } from 'node:fs';",
			"JSON.parse(readFileSync('wiki.source.json', 'utf8'));",
			"JSON.parse(readFileSync('package.json', 'utf8'));",
			"console.log('wiki source seed validation passed');",
			"",
		].join("\n"),
		".github/workflows/publish.yml": [
			"name: Publish wiki data",
			"on:",
			"  push:",
			"    branches: [main]",
			"  workflow_dispatch:",
			"permissions:",
			"  contents: write",
			"jobs:",
			"  validate:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - uses: oven-sh/setup-bun@v2",
			"      - run: bun run wiki:validate",
			"",
		].join("\n"),
	};
}

async function writeSeedWorkspace(
	state: HarnessRunState,
	owner: string,
	decision: WikiSourceDecisionEnvelope,
): Promise<string> {
	const root = path.join(getHarnessRunDir(state.runId), "artifacts", "seed", decision.repo_name);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	for (const [file, content] of Object.entries(seedFiles(owner, decision))) {
		const target = path.join(root, file);
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await Bun.write(target, content);
	}
	return root;
}

async function validateSeedWorkspace(root: string): Promise<string[]> {
	const errors: string[] = [];
	for (const file of REQUIRED_SEED_FILES) {
		try {
			await fs.access(path.join(root, file));
		} catch {
			errors.push(`missing ${file}`);
		}
	}
	for (const file of ["wiki.source.json", "package.json"]) {
		try {
			JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
		} catch {
			errors.push(`invalid JSON ${file}`);
		}
	}
	return errors;
}

function getGitHubToken(options: WikiSourceOptions): string | undefined {
	return options.githubToken ?? Bun.env.GITHUB_TOKEN ?? Bun.env.GITHUB_PAT;
}

function redactedTokenCheck(token: string | undefined): HarnessDoctorCheck {
	return {
		id: "github_token",
		label: "GitHub token",
		ok: Boolean(token),
		blocking: true,
		summary: token ? "GitHub token is present (value redacted)" : "Set GITHUB_TOKEN or GITHUB_PAT for --apply",
	};
}

export const fetchWikiSourceGitHubClient: WikiSourceGitHubClient = {
	async getAuthenticatedUser(token) {
		const response = await fetch("https://api.github.com/user", {
			headers: githubHeaders(token),
		});
		if (!response.ok) throw new Error(`GitHub auth failed with HTTP ${response.status}`);
		const data = (await response.json()) as { login?: string };
		if (!data.login) throw new Error("GitHub auth response did not include login");
		return { login: data.login };
	},
	async getRepo(token, owner, repo) {
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
			headers: githubHeaders(token),
		});
		if (response.status === 404) return { exists: false };
		if (!response.ok) throw new Error(`GitHub repo lookup failed with HTTP ${response.status}`);
		const data = (await response.json()) as { default_branch?: string };
		return { exists: true, defaultBranch: data.default_branch };
	},
	async createRepo(token, input) {
		const endpoint = input.org
			? `https://api.github.com/orgs/${input.owner}/repos`
			: "https://api.github.com/user/repos";
		const response = await fetch(endpoint, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({
				name: input.repo,
				private: input.private,
				description: input.description,
				has_issues: true,
				has_projects: false,
				has_wiki: false,
				auto_init: true,
			}),
		});
		if (!response.ok) throw new Error(`GitHub repo create failed with HTTP ${response.status}`);
		const data = (await response.json()) as { html_url?: string; default_branch?: string };
		return {
			htmlUrl: data.html_url ?? `https://github.com/${input.owner}/${input.repo}`,
			defaultBranch: data.default_branch ?? "main",
		};
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
		if (!response.ok) throw new Error(`GitHub put file ${input.path} failed with HTTP ${response.status}`);
		const data = (await response.json()) as { commit?: { sha?: string } };
		return { commitSha: data.commit?.sha ?? "" };
	},
	async createBranch(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/refs`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({
				ref: `refs/heads/${input.branch}`,
				sha: input.fromSha,
			}),
		});
		if (!response.ok && response.status !== 422) {
			throw new Error(`GitHub create branch ${input.branch} failed with HTTP ${response.status}`);
		}
		return { ref: `refs/heads/${input.branch}` };
	},
};

function githubHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function githubPreflight(
	state: HarnessRunState,
	options: WikiSourceOptions,
	owner: string,
	repoName: string,
): Promise<{ token?: string; user?: string; exists?: boolean }> {
	const token = getGitHubToken(options);
	const checks = [redactedTokenCheck(token)];
	if (!token) {
		const pathOut = await writeRunFile(
			state.runId,
			"validation",
			"github-preflight.json",
			`${JSON.stringify({ checks }, null, 2)}\n`,
		);
		state.validation.push({ status: "failed", summary: "GitHub token missing for --apply", logPath: pathOut });
		await writeRunState(state);
		return {};
	}
	const client = options.githubClient ?? fetchWikiSourceGitHubClient;
	const user = await client.getAuthenticatedUser(token);
	const repo = await client.getRepo(token, owner, repoName);
	const sanitized = {
		checks: [
			...checks,
			{ id: "github_auth", ok: true, blocking: true, summary: `Authenticated as ${user.login}` },
			{
				id: "repo_lookup",
				ok: true,
				blocking: true,
				summary: repo.exists ? "Repository already exists" : "Repository name is available",
			},
		],
		owner,
		repo: repoName,
	};
	const pathOut = await writeRunFile(
		state.runId,
		"validation",
		"github-preflight.json",
		`${JSON.stringify(sanitized, null, 2)}\n`,
	);
	state.validation.push({
		status: "passed",
		summary: "GitHub preflight passed with redacted token",
		logPath: pathOut,
	});
	await writeRunState(state);
	return { token, user: user.login, exists: repo.exists };
}

export async function runWikiSourceHarness(
	objective: string,
	options: WikiSourceOptions = {},
): Promise<HarnessRunState> {
	const state = await createHarnessRun(objective, {
		promptLimit: options.promptLimit ?? 10,
		template: "wiki-source",
	});
	return await continueWikiSourceHarness(state, options);
}

export async function resumeWikiSourceHarness(
	runId: string,
	options: WikiSourceOptions = {},
): Promise<HarnessRunState> {
	const state = await readRunState(runId);
	if (state.template !== "wiki-source") throw new Error(`run ${runId} is not a wiki-source harness run`);
	if (state.status === "good_enough" || state.status === "abandoned") return state;
	state.status = "active";
	if (options.promptLimit) state.promptBudget.limit = options.promptLimit;
	await writeRunState(state);
	return await continueWikiSourceHarness(state, options);
}

async function continueWikiSourceHarness(
	state: HarnessRunState,
	options: WikiSourceOptions = {},
): Promise<HarnessRunState> {
	ensureHarnessGates(state);
	const owner = options.owner ?? "YOUR_ORG";
	try {
		await startGate(state, "doctor", options);
		const doctor = {
			apply: Boolean(options.apply),
			checks: options.apply ? [redactedTokenCheck(getGitHubToken(options))] : [],
		};
		const doctorPath = await writeRunFile(
			state.runId,
			"validation",
			"wiki-source-doctor.json",
			`${JSON.stringify(doctor, null, 2)}\n`,
		);
		if (options.apply && !getGitHubToken(options)) {
			await failGate(state, "doctor", options, "GITHUB_TOKEN or GITHUB_PAT is required for --apply", {
				outputPaths: [doctorPath],
			});
			throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
		}
		await passGate(state, "doctor", options, {
			summary: options.apply ? "GitHub mutation prerequisites checked" : "dry-run mode; GitHub token not required",
			outputPaths: [doctorPath],
		});

		await startGate(state, "registry_snapshot", options);
		let registry: { snapshot: WikiRegistrySnapshot; path?: string };
		try {
			registry = await readRegistrySnapshot(options);
		} catch (error) {
			const summary =
				error instanceof Error
					? `registry snapshot unavailable: ${error.message}`
					: "registry snapshot unavailable";
			await failGate(state, "registry_snapshot", options, summary);
			throw new Error(summary);
		}
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

		await startGate(state, "decision_packet", options);
		const packetPath = await writeRunFile(
			state.runId,
			"packets",
			"wiki-source-decision.json",
			`${JSON.stringify({ objective: state.objective, registry: registry.snapshot }, null, 2)}\n`,
		);
		state.evidencePackets = [packetPath];
		await writeRunState(state);
		await passGate(state, "decision_packet", options, { outputPaths: [packetPath] });

		await startGate(state, "source_classifier", options);
		const decision = classifySource(state.objective, registry.snapshot);
		const decisionValidation = WikiSourceDecisionEnvelopeSchema.safeParse(decision);
		const decisionPath = await writeRunFile(
			state.runId,
			"responses",
			"source-decision.json",
			`${JSON.stringify(decision, null, 2)}\n`,
		);
		if (!decisionValidation.success) {
			await failGate(state, "source_classifier", options, decisionValidation.error.message, {
				outputPaths: [decisionPath],
			});
			throw new Error("source decision JSON was invalid");
		}
		await passGate(state, "source_classifier", options, { outputPaths: [decisionPath] });

		await startGate(state, "decision_contract", options);
		const policy = applyLocalPolicy(decisionValidation.data, registry.snapshot);
		const policyPath = await writeRunFile(
			state.runId,
			"validation",
			"source-policy.json",
			`${JSON.stringify(policy, null, 2)}\n`,
		);
		if (!policy.accepted) {
			await failGate(state, "decision_contract", options, policy.reason, { outputPaths: [policyPath] });
			throw new Error(policy.reason);
		}
		await passGate(state, "decision_contract", options, { summary: policy.reason, outputPaths: [policyPath] });

		await startGate(state, "provision_plan", options);
		const effectiveAction = policy.action;
		const provisionPlan = {
			mode: options.apply ? "apply" : "dry-run",
			action: effectiveAction,
			owner,
			source_id: decision.source_id,
			repo_name: decision.repo_name,
			seed_files: effectiveAction === "create_new_source" ? REQUIRED_SEED_FILES : [],
		};
		const planPath = await writeRunFile(
			state.runId,
			"artifacts",
			"provision-plan.json",
			`${JSON.stringify(provisionPlan, null, 2)}\n`,
		);
		state.artifacts.push({ source: "wiki-source", path: planPath, validationStatus: "planned" });
		await writeRunState(state);
		await passGate(state, "provision_plan", options, { outputPaths: [planPath] });

		if (effectiveAction === "use_existing_source") {
			for (const gate of ["github_preflight", "repo_create", "repo_seed", "registry_update"] as const) {
				await skipGate(state, gate, options, "existing source selected; no repo mutation needed");
			}
		} else if (!options.apply) {
			await skipGate(state, "github_preflight", options, "dry-run; GitHub API not called");
			await skipGate(state, "repo_create", options, "dry-run; repository creation not applied");
			await skipGate(state, "repo_seed", options, "dry-run; seed files written locally only");
			const seedRoot = await writeSeedWorkspace(state, owner, decision);
			const patch = registryPatch(registry.snapshot, owner, decision);
			const patchPath = await writeRunFile(
				state.runId,
				"artifacts",
				"registry-patch-sources.json",
				`${JSON.stringify(patch, null, 2)}\n`,
			);
			state.artifacts.push({ source: "wiki-source", path: seedRoot, validationStatus: "seed-dry-run" });
			state.artifacts.push({ source: "wiki-source", path: patchPath, validationStatus: "registry-patch-dry-run" });
			await writeRunState(state);
			await passGate(state, "registry_update", options, {
				summary: "dry-run registry patch generated",
				outputPaths: [patchPath],
			});
		} else {
			await startGate(state, "github_preflight", options);
			const preflight = await githubPreflight(state, options, owner, decision.repo_name);
			if (!preflight.token) {
				await failGate(state, "github_preflight", options, "GitHub token missing");
				throw new Error("GitHub token missing");
			}
			await passGate(state, "github_preflight", options, { summary: "GitHub preflight passed" });

			const client = options.githubClient ?? fetchWikiSourceGitHubClient;
			await startGate(state, "repo_create", options);
			if (preflight.exists && !registry.snapshot.sources.some(source => source.id === decision.source_id)) {
				const summary = "repository already exists but the source is not registered; needs_user_decision";
				await failGate(state, "repo_create", options, summary);
				throw new Error(summary);
			}
			const repo = preflight.exists
				? { htmlUrl: `https://github.com/${owner}/${decision.repo_name}`, defaultBranch: "main", sha: undefined }
				: await client.createRepo(preflight.token, {
						owner,
						repo: decision.repo_name,
						private: options.private ?? false,
						description: decision.reason,
						org: preflight.user !== owner,
					});
			await passGate(state, "repo_create", options, { summary: `repository ready: ${repo.htmlUrl}` });

			await startGate(state, "repo_seed", options);
			const files = seedFiles(owner, decision);
			let lastCommitSha = repo.sha ?? "";
			for (const [file, content] of Object.entries(files)) {
				const written = await client.putFile(preflight.token, {
					owner,
					repo: decision.repo_name,
					branch: "main",
					path: file,
					content,
					message: `Seed ${file}`,
				});
				lastCommitSha = written.commitSha || lastCommitSha;
			}
			const branchSha = lastCommitSha || repo.sha || "0000000000000000000000000000000000000000";
			await client.createBranch(preflight.token, {
				owner,
				repo: decision.repo_name,
				branch: "published",
				fromSha: branchSha,
			});
			const latest = {
				schemaVersion: "steve-wiki-latest/v1",
				sourceId: decision.source_id,
				sourceCommit: branchSha,
				generatedAt: new Date().toISOString(),
				artifactBaseUrl: `https://cdn.jsdelivr.net/gh/${owner}/${decision.repo_name}@published/dist/${branchSha}/`,
			};
			await client.putFile(preflight.token, {
				owner,
				repo: decision.repo_name,
				branch: "published",
				path: "latest.json",
				content: `${JSON.stringify(latest, null, 2)}\n`,
				message: "Seed published latest pointer",
			});
			await passGate(state, "repo_seed", options, { summary: "main and published branches seeded" });

			await startGate(state, "registry_update", options);
			const patch = registryPatch(registry.snapshot, owner, decision);
			const patchPath = await writeRunFile(
				state.runId,
				"artifacts",
				"registry-patch-sources.json",
				`${JSON.stringify(patch, null, 2)}\n`,
			);
			await passGate(state, "registry_update", options, {
				summary: "registry patch generated for local review",
				outputPaths: [patchPath],
			});
		}

		await startGate(state, "validate", options);
		const seedRoot = path.join(getHarnessRunDir(state.runId), "artifacts", "seed", decision.repo_name);
		if (effectiveAction === "create_new_source") {
			if (!(await Bun.file(path.join(seedRoot, "wiki.source.json")).exists())) {
				await writeSeedWorkspace(state, owner, decision);
			}
			const errors = await validateSeedWorkspace(seedRoot);
			const validationPath = await writeRunFile(
				state.runId,
				"validation",
				"wiki-source-validation.json",
				`${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`,
			);
			if (errors.length) {
				await failGate(state, "validate", options, errors.join("; "), { outputPaths: [validationPath] });
				throw new Error(`wiki-source validation failed: ${errors.join("; ")}`);
			}
			state.validation.push({
				status: "passed",
				summary: "wiki-source seed validation passed",
				logPath: validationPath,
			});
			await writeRunState(state);
			await passGate(state, "validate", options, { outputPaths: [validationPath] });
		} else {
			await passGate(state, "validate", options, { summary: "existing source route validated" });
		}

		await startGate(state, "critic", options);
		await passGate(state, "critic", options, {
			summary: "deterministic local policy accepted the wiki-source result",
		});
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
