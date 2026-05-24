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
import type { HarnessDoctorCheck, HarnessRunState } from "./types";
import { WIKI_RESEARCH_REQUIRED_LABELS } from "./wiki-research";

const BOOTSTRAP_REPOS = [
	"wiki-site",
	"wiki-data-registry",
	"wiki-data-devops",
	"wiki-data-homelab",
	"wiki-data-projects",
] as const;

const DATA_SOURCES = [
	{
		id: "devops",
		repo: "wiki-data-devops",
		label: "DevOps",
		description: "Cloud, Kubernetes, CI/CD, automation, infrastructure",
		order: 10,
	},
	{
		id: "homelab",
		repo: "wiki-data-homelab",
		label: "Homelab",
		description: "Self-hosting, networking, storage, disaster recovery",
		order: 20,
	},
	{
		id: "projects",
		repo: "wiki-data-projects",
		label: "Projects",
		description: "Project notes, application architecture, roadmaps, and retrospectives",
		order: 30,
	},
] as const;

type BootstrapRepoName = (typeof BOOTSTRAP_REPOS)[number];

export interface WikiBootstrapGitHubClient {
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
	ensureLabel(
		token: string,
		input: { owner: string; repo: string; label: string; color: string; description: string },
	): Promise<void>;
	createIssue(
		token: string,
		input: { owner: string; repo: string; title: string; body: string; labels: string[] },
	): Promise<{ number: number; htmlUrl: string }>;
}

export interface WikiBootstrapOptions {
	owner?: string;
	apply?: boolean;
	private?: boolean;
	promptLimit?: number;
	githubToken?: string;
	githubClient?: WikiBootstrapGitHubClient;
	onEvent?: (message: string) => void;
}

function emit(options: WikiBootstrapOptions, message: string): void {
	options.onEvent?.(message);
}

async function startGate(state: HarnessRunState, id: string, options: WikiBootstrapOptions): Promise<void> {
	emit(options, `running ${id}`);
	await setGateStatus(state, id, "running");
}

async function passGate(
	state: HarnessRunState,
	id: string,
	options: WikiBootstrapOptions,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `passed ${id}`);
	await setGateStatus(state, id, "passed", fields);
}

async function failGate(
	state: HarnessRunState,
	id: string,
	options: WikiBootstrapOptions,
	error: string,
	fields: Parameters<typeof setGateStatus>[3] = {},
): Promise<void> {
	emit(options, `failed ${id}: ${error}`);
	await setGateStatus(state, id, "failed", { ...fields, error });
}

async function skipGate(
	state: HarnessRunState,
	id: string,
	options: WikiBootstrapOptions,
	summary: string,
): Promise<void> {
	emit(options, `skipped ${id}: ${summary}`);
	await setGateStatus(state, id, "skipped", { summary });
}

function gatePassed(state: HarnessRunState, id: string): boolean {
	return state.gates?.some(gate => gate.id === id && gate.status === "passed") ?? false;
}

function getGitHubToken(options: WikiBootstrapOptions): string | undefined {
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
				: "Not required for dry-run",
	};
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

function registrySources(owner: string) {
	return DATA_SOURCES.map(source => ({
		id: source.id,
		label: source.label,
		description: source.description,
		enabled: true,
		order: source.order,
		latestUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@published/latest.json`,
	}));
}

function siteFiles(owner: string): Record<string, string> {
	return {
		"README.md": "# Wiki Site\n\nDocusaurus/React shell for the AI-native wiki.\n",
		"package.json": `${JSON.stringify(
			{
				name: "wiki-site",
				private: true,
				type: "module",
				scripts: {
					dev: "docusaurus start",
					build: "docusaurus build",
					test: "node scripts/smoke-test.mjs",
				},
				dependencies: {
					"@docusaurus/core": "latest",
					"@docusaurus/preset-classic": "latest",
					react: "latest",
					"react-dom": "latest",
					"react-markdown": "latest",
					"remark-gfm": "latest",
					"rehype-sanitize": "latest",
				},
				devDependencies: {},
			},
			null,
			2,
		)}\n`,
		"docusaurus.config.ts": [
			"import type { Config } from '@docusaurus/types';",
			"",
			"const config: Config = {",
			"  title: 'AI Wiki',",
			"  url: 'https://example.com',",
			"  baseUrl: '/',",
			"  presets: [['classic', { docs: false, blog: false }]],",
			"};",
			"",
			"export default config;",
			"",
		].join("\n"),
		"src/pages/wiki.tsx": [
			"import React from 'react';",
			"",
			"export default function WikiPage() {",
			"  return <main><h1>AI Wiki</h1><p>Runtime wiki reader placeholder.</p></main>;",
			"}",
			"",
		].join("\n"),
		"src/wiki-core/registry.ts": [
			`export const registryUrl = "https://cdn.jsdelivr.net/gh/${owner}/wiki-data-registry@main/sources.json";`,
			"",
		].join("\n"),
		"static/llms.txt": [
			"# AI Wiki",
			"",
			"> Repo-backed wiki for humans and AI agents.",
			"",
			"## Sources",
			`- DevOps: https://cdn.jsdelivr.net/gh/${owner}/wiki-data-devops@published/latest-agent.json`,
			`- Homelab: https://cdn.jsdelivr.net/gh/${owner}/wiki-data-homelab@published/latest-agent.json`,
			`- Projects: https://cdn.jsdelivr.net/gh/${owner}/wiki-data-projects@published/latest-agent.json`,
			"",
		].join("\n"),
		"static/.well-known/wiki-agent.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-agent/v1",
				name: "AI Wiki",
				registryUrl: `https://cdn.jsdelivr.net/gh/${owner}/wiki-data-registry@main/agent-sources.json`,
				contentPolicy: { public: true, noSecrets: true, aiGeneratedContentMarked: true, citationsPreferred: true },
			},
			null,
			2,
		)}\n`,
		".github/workflows/pages.yml": [
			"name: Deploy wiki shell",
			"on:",
			"  push:",
			"    branches: [main]",
			"  workflow_dispatch:",
			"permissions:",
			"  contents: read",
			"  pages: write",
			"  id-token: write",
			"jobs:",
			"  build:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - uses: actions/setup-node@v4",
			"        with:",
			"          node-version: 22",
			"      - run: npm install",
			"      - run: npm run build",
			"",
		].join("\n"),
		"scripts/smoke-test.mjs": "console.log('wiki-site smoke ok');\n",
	};
}

function registryFiles(owner: string): Record<string, string> {
	const sources = registrySources(owner);
	return {
		"README.md": "# Wiki Data Registry\n\nRuntime source registry for the AI wiki.\n",
		"sources.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-registry/v1",
				updatedAt: new Date().toISOString(),
				routeMode: "query",
				sources,
			},
			null,
			2,
		)}\n`,
		"agent-sources.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-agent-sources/v1",
				updatedAt: new Date().toISOString(),
				sources: sources.map(source => ({
					id: source.id,
					label: source.label,
					description: source.description,
					latestUrl: source.latestUrl,
					agentManifestUrl: source.latestUrl.replace("latest.json", "latest-agent.json"),
				})),
			},
			null,
			2,
		)}\n`,
		"taxonomy.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-taxonomy/v1",
				facets: {
					status: ["draft", "active", "deprecated", "archived"],
					difficulty: ["beginner", "intermediate", "advanced"],
				},
			},
			null,
			2,
		)}\n`,
		"wiki.steering.json": `${JSON.stringify(
			{
				owner,
				registryRepo: "wiki-data-registry",
				registryPath: "sources.json",
				branchPrefix: "omg/wiki-research",
				prLabels: ["wiki:needs-review"],
				maxIssuesPerRun: 1,
				maxPagesPerIssue: 1,
				closeBehavior: "after_pr_merge",
				blockedDomains: [],
			},
			null,
			2,
		)}\n`,
		"schemas/registry.schema.json": `${JSON.stringify({ type: "object", required: ["schemaVersion", "sources"] }, null, 2)}\n`,
		"schemas/source.schema.json": `${JSON.stringify({ type: "object", required: ["schemaVersion", "id"] }, null, 2)}\n`,
		"schemas/manifest.schema.json": `${JSON.stringify({ type: "object", required: ["schemaVersion", "pages"] }, null, 2)}\n`,
	};
}

function dataFiles(owner: string, source: (typeof DATA_SOURCES)[number]): Record<string, string> {
	const repoUrl = `https://github.com/${owner}/${source.repo}`;
	return {
		"README.md": `# ${source.label}\n\n${source.description}\n`,
		"wiki.source.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-source/v1",
				id: source.id,
				label: source.label,
				description: source.description,
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
			},
			null,
			2,
		)}\n`,
		"docs/index.md": [
			"---",
			`title: ${source.label}`,
			`description: ${source.description}`,
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
			`# ${source.label}`,
			"",
			`${source.description}.`,
			"",
		].join("\n"),
		"assets/.gitkeep": "",
		"package.json": `${JSON.stringify(
			{
				name: source.repo,
				private: true,
				type: "module",
				scripts: {
					"wiki:validate": "node scripts/validate-wiki.mjs",
					"wiki:build": "node scripts/build-wiki.mjs",
				},
				devDependencies: {},
			},
			null,
			2,
		)}\n`,
		"scripts/validate-wiki.mjs": [
			"import { readFileSync } from 'node:fs';",
			"JSON.parse(readFileSync('wiki.source.json', 'utf8'));",
			"JSON.parse(readFileSync('package.json', 'utf8'));",
			"console.log('wiki data validation ok');",
			"",
		].join("\n"),
		"scripts/build-wiki.mjs": "console.log('wiki data build placeholder');\n",
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
			"      - uses: actions/setup-node@v4",
			"        with:",
			"          node-version: 22",
			"      - run: npm run wiki:validate",
			"",
		].join("\n"),
		"published/latest.json": `${JSON.stringify(
			{
				schemaVersion: "steve-wiki-latest/v1",
				sourceId: source.id,
				sourceCommit: "bootstrap",
				generatedAt: new Date().toISOString(),
				artifactBaseUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@published/dist/bootstrap/`,
				manifestUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@published/dist/bootstrap/wiki-manifest.json`,
				catalogUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@published/dist/bootstrap/wiki-catalog.json`,
				pagefindBundleUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@published/dist/bootstrap/pagefind/`,
				contentBaseUrl: `https://cdn.jsdelivr.net/gh/${owner}/${source.repo}@main/docs/`,
			},
			null,
			2,
		)}\n`,
	};
}

function seedFiles(owner: string, repo: BootstrapRepoName): Record<string, string> {
	if (repo === "wiki-site") return siteFiles(owner);
	if (repo === "wiki-data-registry") return registryFiles(owner);
	const source = DATA_SOURCES.find(item => item.repo === repo);
	if (!source) throw new Error(`unknown bootstrap repo ${repo}`);
	return dataFiles(owner, source);
}

function repoDescription(repo: BootstrapRepoName): string {
	if (repo === "wiki-site") return "Docusaurus/React shell for the AI wiki.";
	if (repo === "wiki-data-registry") return "Runtime source registry for the AI wiki.";
	return DATA_SOURCES.find(source => source.repo === repo)?.description ?? "Wiki data source.";
}

async function writeSeedWorkspace(state: HarnessRunState, owner: string): Promise<string> {
	const root = path.join(getHarnessRunDir(state.runId), "artifacts", "bootstrap");
	for (const repo of BOOTSTRAP_REPOS) {
		for (const [file, content] of Object.entries(seedFiles(owner, repo))) {
			const target = path.join(root, repo, file);
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await Bun.write(target, content);
		}
	}
	return root;
}

async function validateSeedWorkspace(root: string): Promise<string[]> {
	const errors: string[] = [];
	const required: Record<BootstrapRepoName, string[]> = {
		"wiki-site": [
			"README.md",
			"package.json",
			"src/pages/wiki.tsx",
			"static/llms.txt",
			"static/.well-known/wiki-agent.json",
			".github/workflows/pages.yml",
		],
		"wiki-data-registry": ["sources.json", "agent-sources.json", "taxonomy.json", "wiki.steering.json"],
		"wiki-data-devops": [
			"wiki.source.json",
			"docs/index.md",
			"package.json",
			".github/workflows/publish.yml",
			"published/latest.json",
		],
		"wiki-data-homelab": [
			"wiki.source.json",
			"docs/index.md",
			"package.json",
			".github/workflows/publish.yml",
			"published/latest.json",
		],
		"wiki-data-projects": [
			"wiki.source.json",
			"docs/index.md",
			"package.json",
			".github/workflows/publish.yml",
			"published/latest.json",
		],
	};
	for (const [repo, files] of Object.entries(required) as Array<[BootstrapRepoName, string[]]>) {
		for (const file of files) {
			try {
				await fs.access(path.join(root, repo, file));
			} catch {
				errors.push(`missing ${repo}/${file}`);
			}
		}
	}
	try {
		const registry = JSON.parse(await fs.readFile(path.join(root, "wiki-data-registry", "sources.json"), "utf8")) as {
			sources?: Array<{ id?: string; latestUrl?: string }>;
		};
		for (const id of ["devops", "homelab", "projects"]) {
			if (
				!registry.sources?.some(
					source => source.id === id && source.latestUrl?.includes(`/wiki-data-${id}@published/latest.json`),
				)
			) {
				errors.push(`registry missing jsDelivr source ${id}`);
			}
		}
	} catch {
		errors.push("invalid wiki-data-registry/sources.json");
	}
	return errors;
}

export const fetchWikiBootstrapGitHubClient: WikiBootstrapGitHubClient = {
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
		const data = (await response.json()) as { default_branch?: string };
		return { exists: true, defaultBranch: data.default_branch ?? "main" };
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
		const contentUrl = `https://api.github.com/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}`;
		const existing = await fetch(`${contentUrl}?ref=${encodeURIComponent(input.branch)}`, {
			headers: githubHeaders(token),
		});
		let sha: string | undefined;
		if (existing.ok) {
			const data = (await existing.json()) as { sha?: string };
			sha = data.sha;
		} else if (existing.status !== 404) {
			throw new Error(`GitHub lookup file ${input.path} failed with HTTP ${existing.status}`);
		}
		const response = await fetch(contentUrl, {
			method: "PUT",
			headers: githubHeaders(token),
			body: JSON.stringify({
				message: input.message,
				content: Buffer.from(input.content, "utf8").toString("base64"),
				branch: input.branch,
				...(sha ? { sha } : {}),
			}),
		});
		if (!response.ok) throw new Error(`GitHub put file ${input.path} failed with HTTP ${response.status}`);
		const data = (await response.json()) as { commit?: { sha?: string } };
		return { commitSha: data.commit?.sha ?? "" };
	},
	async createBranch(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/refs`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.fromSha }),
		});
		if (!response.ok && response.status !== 422)
			throw new Error(`GitHub create branch failed with HTTP ${response.status}`);
		return { ref: `refs/heads/${input.branch}` };
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
	async createIssue(token, input) {
		const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`, {
			method: "POST",
			headers: githubHeaders(token),
			body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
		});
		if (!response.ok) throw new Error(`GitHub issue create failed with HTTP ${response.status}`);
		const data = (await response.json()) as { number: number; html_url: string };
		return { number: data.number, htmlUrl: data.html_url };
	},
};

export async function runWikiBootstrapHarness(
	objective: string,
	options: WikiBootstrapOptions = {},
): Promise<HarnessRunState> {
	const state = await createHarnessRun(objective, {
		promptLimit: options.promptLimit ?? 10,
		template: "wiki-bootstrap",
	});
	return await continueWikiBootstrapHarness(state, options);
}

export async function resumeWikiBootstrapHarness(
	runId: string,
	options: WikiBootstrapOptions = {},
): Promise<HarnessRunState> {
	const state = await readRunState(runId);
	if (state.template !== "wiki-bootstrap") throw new Error(`run ${runId} is not a wiki-bootstrap harness run`);
	if (state.status === "good_enough" || state.status === "abandoned") return state;
	state.status = "active";
	if (options.promptLimit) state.promptBudget.limit = options.promptLimit;
	await writeRunState(state);
	return await continueWikiBootstrapHarness(state, options);
}

async function continueWikiBootstrapHarness(
	state: HarnessRunState,
	options: WikiBootstrapOptions = {},
): Promise<HarnessRunState> {
	ensureHarnessGates(state);
	const owner = options.owner ?? "StevenBuglione";
	const token = getGitHubToken(options);
	const client = options.githubClient ?? fetchWikiBootstrapGitHubClient;
	try {
		await startGate(state, "doctor", options);
		const doctorPath = await writeRunFile(
			state.runId,
			"validation",
			"wiki-bootstrap-doctor.json",
			`${JSON.stringify({ apply: Boolean(options.apply), checks: [redactedTokenCheck(token, Boolean(options.apply))] }, null, 2)}\n`,
		);
		if (options.apply && !token) {
			await failGate(state, "doctor", options, "GITHUB_TOKEN or GITHUB_PAT is required for --apply", {
				outputPaths: [doctorPath],
			});
			throw new Error("GITHUB_TOKEN or GITHUB_PAT is required for --apply");
		}
		await passGate(state, "doctor", options, { outputPaths: [doctorPath] });

		await startGate(state, "provision_plan", options);
		const plan = {
			mode: options.apply ? "apply" : "dry-run",
			owner,
			visibility: options.private ? "private" : "public",
			repos: BOOTSTRAP_REPOS.map(repo => ({ name: repo, description: repoDescription(repo) })),
			sources: registrySources(owner),
		};
		const planPath = await writeRunFile(
			state.runId,
			"artifacts",
			"wiki-bootstrap-plan.json",
			`${JSON.stringify(plan, null, 2)}\n`,
		);
		state.artifacts.push({ source: "wiki-bootstrap", path: planPath, validationStatus: "planned" });
		await writeRunState(state);
		await passGate(state, "provision_plan", options, { outputPaths: [planPath] });

		await startGate(state, "repo_preflight", options);
		if (options.apply && token) {
			const auth = await client.getAuthenticatedUser(token);
			const existing: string[] = [];
			for (const repo of BOOTSTRAP_REPOS) {
				const lookup = await client.getRepo(token, owner, repo);
				if (lookup.exists) existing.push(repo);
			}
			const preflightPath = await writeRunFile(
				state.runId,
				"validation",
				"wiki-bootstrap-preflight.json",
				`${JSON.stringify({ authenticatedAs: auth.login, owner, existing }, null, 2)}\n`,
			);
			if (existing.length && !gatePassed(state, "repo_create")) {
				await failGate(
					state,
					"repo_preflight",
					options,
					`refusing to overwrite existing repos: ${existing.join(", ")}`,
					{
						outputPaths: [preflightPath],
					},
				);
				throw new Error(`refusing to overwrite existing repos: ${existing.join(", ")}`);
			}
			await passGate(state, "repo_preflight", options, {
				outputPaths: [preflightPath],
				summary: existing.length
					? "existing repos accepted because repo_create already passed in this run"
					: "target repos are available",
			});
		} else {
			await skipGate(state, "repo_preflight", options, "dry-run; GitHub API not called");
		}

		const seedRoot = await writeSeedWorkspace(state, owner);
		state.artifacts.push({ source: "wiki-bootstrap", path: seedRoot, validationStatus: "seeded" });
		await writeRunState(state);

		if (!options.apply) {
			await skipGate(state, "repo_create", options, "dry-run; repositories not created");
			await skipGate(state, "repo_seed", options, "dry-run; seed files written locally only");
			await skipGate(state, "labels_sync", options, "dry-run; labels and starter issues not created");
		} else if (token) {
			if (gatePassed(state, "repo_create")) {
				await passGate(state, "repo_create", options, {
					summary: "repositories already created in this run; resuming seeding",
				});
			} else {
				await startGate(state, "repo_create", options);
				const auth = await client.getAuthenticatedUser(token);
				const created: string[] = [];
				for (const repo of BOOTSTRAP_REPOS) {
					await client.createRepo(token, {
						owner,
						repo,
						private: options.private ?? false,
						description: repoDescription(repo),
						org: owner !== auth.login,
					});
					created.push(repo);
				}
				await passGate(state, "repo_create", options, { summary: `created ${created.join(", ")}` });
			}

			await startGate(state, "repo_seed", options);
			for (const repo of BOOTSTRAP_REPOS) {
				let lastCommitSha = "";
				for (const [file, content] of Object.entries(seedFiles(owner, repo))) {
					if (file.startsWith("published/")) continue;
					const written = await client.putFile(token, {
						owner,
						repo,
						branch: "main",
						path: file,
						content,
						message: `Seed ${file}`,
					});
					lastCommitSha = written.commitSha || lastCommitSha;
				}
				if (repo.startsWith("wiki-data-") && repo !== "wiki-data-registry") {
					const branchSha = lastCommitSha || "0000000000000000000000000000000000000000";
					await client.createBranch(token, { owner, repo, branch: "published", fromSha: branchSha });
					const latest = seedFiles(owner, repo)["published/latest.json"];
					if (latest) {
						await client.putFile(token, {
							owner,
							repo,
							branch: "published",
							path: "latest.json",
							content: latest,
							message: "Seed published latest pointer",
						});
					}
				}
			}
			await passGate(state, "repo_seed", options, { summary: "seeded main and published branches" });

			await startGate(state, "labels_sync", options);
			for (const repo of BOOTSTRAP_REPOS.filter(repo => repo.startsWith("wiki-data-"))) {
				for (const label of WIKI_RESEARCH_REQUIRED_LABELS) {
					await client.ensureLabel(token, {
						owner,
						repo,
						label,
						color: label === "wiki:blocked" ? "d73a4a" : "2f81f7",
						description: "OMG wiki research workflow label",
					});
				}
			}
			await client.createIssue(token, {
				owner,
				repo: "wiki-data-registry",
				title: "Research initial wiki source priorities",
				body: "## Objective\nDecide the first high-value research topics for the wiki.\n\n## Acceptance\n- Create one issue per source.\n",
				labels: ["wiki:research", "wiki:queued"],
			});
			for (const source of DATA_SOURCES) {
				await client.createIssue(token, {
					owner,
					repo: source.repo,
					title: `Research ${source.label} starter content`,
					body: `## Objective\nResearch starter content for ${source.label}.\n\n## Preferred source\n${source.id}\n`,
					labels: ["wiki:research", "wiki:queued", `source:${source.id}`],
				});
			}
			await passGate(state, "labels_sync", options, { summary: "labels and starter issues created" });
		}

		await startGate(state, "validate", options);
		const errors = await validateSeedWorkspace(seedRoot);
		const validationPath = await writeRunFile(
			state.runId,
			"validation",
			"wiki-bootstrap-validation.json",
			`${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`,
		);
		if (errors.length) {
			await failGate(state, "validate", options, errors.join("; "), { outputPaths: [validationPath] });
			throw new Error(`wiki bootstrap validation failed: ${errors.join("; ")}`);
		}
		state.validation.push({
			status: "passed",
			summary: "wiki bootstrap seed validation passed",
			logPath: validationPath,
		});
		await writeRunState(state);
		await passGate(state, "validate", options, { outputPaths: [validationPath] });

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
