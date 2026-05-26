import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { runChatGptWorkerCommand } from "../harness/chatgpt-cli";

const ACTIONS = [
	"plan",
	"research-dossier",
	"research-craft",
	"expand-world",
	"develop-world",
	"expand-characters",
	"develop-characters",
	"expand-timeline",
	"outline-book",
	"plan-arc",
	"studio-assess",
	"plan-chapter",
	"draft-chapter",
	"revise-chapter",
	"generate-art",
	"review",
	"repair",
	"watchdog",
	"autopilot",
	"publish",
] as const;

type OmgBookAction = (typeof ACTIONS)[number];
type Researcher = "local" | "chatgpt";
type CreativeMode = "off" | "illustrated";

const packageManifestSchema = z.object({
	schema_version: z.literal("omg.book.package_manifest.v1"),
	package_id: z.string().min(8),
	run_id: z.string().min(1),
	stage: z.enum(ACTIONS),
	attempt: z.string().min(1),
	series_id: z.string().min(1),
	book_id: z.string().optional(),
	chapter_id: z.string().optional(),
	soul_id: z.string().optional(),
	required_files: z.array(z.string()).min(1),
	created_files: z.array(z.string()).default([]),
	updated_files: z.array(z.string()).default([]),
});

const decisionSchema = z.object({
	schema_version: z.literal("omg.book.llm_decision.v2"),
	series_id: z.string().min(1),
	book_id: z.string().optional(),
	chapter_id: z.string().optional(),
	decision_id: z.string().min(1),
	decision: z.enum(["create", "revise", "approve", "reject", "needs_more_context", "ask_user"]),
	confidence: z.number().min(0).max(1),
	reason: z.string().min(1),
	created_files: z.array(z.string()),
	updated_files: z.array(z.string()),
	blocked_by: z.array(z.string()),
	next_action: z.string().min(1),
});

interface StageContext {
	action: OmgBookAction;
	seriesRepo: string;
	bookId: string;
	chapterId: string;
	researcher: Researcher;
	creativeMode: CreativeMode;
	soul?: string;
	soulRepo?: string;
	modelOption: string;
	thinkingOption: string;
	commit: boolean;
	push: boolean;
	maxContextMb: number;
	workerTimeoutSeconds: number;
	workflow: string;
	json: boolean;
	maxFailuresPerCycle: number;
	maxStagesPerCycle: number;
	artTargetNode?: string;
	artTargetType?: "character" | "location" | "item";
	artTargetSlug?: string;
	artTargetLabel?: string;
}

interface StageResult {
	ok: boolean;
	created?: string[];
	updated?: string[];
	report?: string;
	packageId?: string;
	expectedArtifactName?: string;
	conversationUrl?: string;
	requestId?: string;
	workerId?: string;
	error?: string;
	[key: string]: unknown;
}

async function runProcess(
	cwd: string,
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function repoPath(seriesRepo: string, rel: string): string {
	return path.join(seriesRepo, ...rel.split("/"));
}

function safeRepoPath(seriesRepo: string, rel: string): string {
	if (path.isAbsolute(rel) || rel.includes("..") || rel.includes("\\")) throw new Error(`unsafe repo path ${rel}`);
	const absolute = repoPath(seriesRepo, rel);
	const root = path.resolve(seriesRepo);
	const resolved = path.resolve(absolute);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe repo path ${rel}`);
	return resolved;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function isProductionCanon(value: Record<string, unknown>): boolean {
	return value.production_approved === true || value.visual_status === "approved";
}

function artAssetRel(ctx: StageContext): string {
	if (ctx.artTargetType === "character") return `assets/characters/${ctx.artTargetSlug}/portrait.svg`;
	if (ctx.artTargetType === "location") return `assets/locations/${ctx.artTargetSlug}/location.svg`;
	if (ctx.artTargetType === "item") return `assets/items/${ctx.artTargetSlug}/item.svg`;
	return `assets/${ctx.bookId}/${ctx.chapterId}/chapter-hero.svg`;
}

function artVisualDir(ctx: StageContext): string {
	if (ctx.artTargetType === "character") return `visuals/characters/${ctx.artTargetSlug}`;
	if (ctx.artTargetType === "location") return `visuals/locations/${ctx.artTargetSlug}`;
	if (ctx.artTargetType === "item") return `visuals/items/${ctx.artTargetSlug}`;
	return `visuals/chapters/${ctx.bookId}/${ctx.chapterId}`;
}

async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file: string, value: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, value);
}

async function fileExists(file: string): Promise<boolean> {
	return await Bun.file(file).exists();
}

async function listRepoJson(
	seriesRepo: string,
	pattern: string,
): Promise<Array<{ rel: string; data: Record<string, unknown> }>> {
	const out: Array<{ rel: string; data: Record<string, unknown> }> = [];
	for await (const file of new Bun.Glob(pattern).scan({ cwd: seriesRepo, onlyFiles: true })) {
		const rel = file.replaceAll("\\", "/");
		const data = await readJson<Record<string, unknown>>(safeRepoPath(seriesRepo, rel));
		out.push({ rel, data });
	}
	return out;
}

async function writeStageReport(ctx: StageContext, result: Record<string, unknown>): Promise<string> {
	const file = path.join(ctx.seriesRepo, "runs", `stage-${ctx.action}.json`);
	await writeJson(file, {
		schema_version: "omg.book.stage_report.v2",
		action: ctx.action,
		status: result.ok === false ? "blocked" : "complete",
		generated_at: new Date().toISOString(),
		researcher: ctx.researcher,
		creative_mode: ctx.creativeMode,
		...result,
	});
	return file;
}

function parseCounts(output: string): Record<string, unknown> {
	const match = output.match(/\{[^\n]+\}/);
	if (!match) return {};
	try {
		return JSON.parse(match[0]) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function jsonFromStdout(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
		if (!match) return undefined;
		try {
			return JSON.parse(match[0]);
		} catch {
			return undefined;
		}
	}
}

function firstWorkerId(stdout: string): string | undefined {
	const parsed = jsonFromStdout(stdout);
	if (Array.isArray(parsed)) {
		const first = parsed.find(item => item && typeof item === "object" && "worker_id" in item) as
			| { worker_id?: string }
			| undefined;
		return first?.worker_id;
	}
	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.worker_id === "string") return obj.worker_id;
		if (typeof obj.workerId === "string") return obj.workerId;
		if (typeof obj.id === "string") return obj.id;
	}
	return stdout.match(/"worker_id"\s*:\s*"([^"]+)"/)?.[1] ?? stdout.match(/\b[a-z]+-[a-z]+-\d+\b/)?.[0];
}

function responseMeta(stdout: string): {
	requestId?: string;
	conversationUrl?: string;
	soulId?: string;
	soulVersion?: string;
} {
	const parsed = jsonFromStdout(stdout);
	const obj = Array.isArray(parsed) ? parsed[0] : parsed;
	if (obj && typeof obj === "object") {
		const data = obj as Record<string, unknown>;
		return {
			requestId:
				typeof data.request_id === "string"
					? data.request_id
					: typeof data.requestId === "string"
						? data.requestId
						: undefined,
			conversationUrl:
				typeof data.conversation_url === "string"
					? data.conversation_url
					: typeof data.conversationUrl === "string"
						? data.conversationUrl
						: undefined,
			soulId:
				typeof data.soulId === "string" ? data.soulId : typeof data.soul_id === "string" ? data.soul_id : undefined,
			soulVersion:
				typeof data.soulVersion === "string"
					? data.soulVersion
					: typeof data.soul_version === "string"
						? data.soul_version
						: undefined,
		};
	}
	return {};
}

function expectedFiles(ctx: StageContext): string[] {
	const chapterBase = `books/${ctx.bookId}/chapters/${ctx.chapterId}`;
	if (ctx.action === "research-dossier") {
		const dossierId = `${ctx.bookId}-${ctx.chapterId}-dossier`;
		return [
			`research/plausibility/${dossierId}/dossier.json`,
			`research/plausibility/${dossierId}/dossier.md`,
			`decisions/${ctx.chapterId}-research-llm.json`,
		];
	}
	if (ctx.action === "expand-world") {
		return [
			`world/places/${ctx.bookId}-${ctx.chapterId}-places.json`,
			`world/magic-or-technology/${ctx.bookId}-${ctx.chapterId}-systems.json`,
			`decisions/${ctx.chapterId}-world-llm.json`,
		];
	}
	if (ctx.action === "expand-characters") {
		return [
			`characters/arcs/${ctx.bookId}-${ctx.chapterId}-arcs.json`,
			`relationships/${ctx.bookId}-${ctx.chapterId}-relationships.json`,
			`decisions/${ctx.chapterId}-characters-llm.json`,
		];
	}
	if (ctx.action === "expand-timeline") {
		return [`timeline/${ctx.bookId}-${ctx.chapterId}-timeline.json`, `decisions/${ctx.chapterId}-timeline-llm.json`];
	}
	if (ctx.action === "plan-arc") {
		return [
			`plot/threads/${ctx.bookId}-${ctx.chapterId}-threads.json`,
			`plot/promises/${ctx.bookId}-${ctx.chapterId}-promises.json`,
			`decisions/${ctx.chapterId}-arc-llm.json`,
		];
	}
	if (ctx.action === "studio-assess") {
		return ["quality/studio-editorial-assessment.json", "decisions/studio-editorial-assessment-llm.json"];
	}
	if (ctx.action === "review" || ctx.action === "repair") {
		return [
			`quality/${ctx.bookId}-${ctx.chapterId}-${ctx.action}.json`,
			`decisions/${ctx.chapterId}-${ctx.action}-llm.json`,
		];
	}
	if (ctx.action === "plan-chapter") {
		return [`${chapterBase}.packet.json`, `books/${ctx.bookId}/book.json`, `decisions/${ctx.chapterId}-llm.json`];
	}
	if (ctx.action === "draft-chapter" || ctx.action === "revise-chapter") {
		return [
			`${chapterBase}.md`,
			`decisions/${ctx.chapterId}-prose-llm.json`,
			`decisions/review-${ctx.chapterId}-continuity.json`,
			`decisions/review-${ctx.chapterId}-craft-style.json`,
			`decisions/review-${ctx.chapterId}-character-arc.json`,
			`decisions/review-${ctx.chapterId}-line-edit.json`,
		];
	}
	if (ctx.action === "generate-art") {
		if (ctx.artTargetNode && ctx.artTargetType && ctx.artTargetSlug) {
			const visualDir = artVisualDir(ctx);
			return [
				`${visualDir}/visual-profile.json`,
				`${visualDir}/art-brief.json`,
				`${visualDir}/art-decision.json`,
				`${visualDir}/art-review.json`,
				artAssetRel(ctx),
			];
		}
		return [
			`${chapterBase}.art-brief.json`,
			`decisions/${ctx.chapterId}-art.json`,
			`assets/${ctx.bookId}/${ctx.chapterId}/chapter-hero.svg`,
		];
	}
	return [];
}

async function buildContextZip(
	ctx: StageContext,
	runDir: string,
	maxBytes: number,
): Promise<{ path: string; bytes: number; files: string[] }> {
	const include = [
		"series.json",
		"story_bible.json",
		"world_bible.json",
		`books/${ctx.bookId}/book.json`,
		`books/${ctx.bookId}/outline.json`,
		`books/${ctx.bookId}/chapters/**/*.json`,
		`books/${ctx.bookId}/chapters/**/*.md`,
		`books/${ctx.bookId}/docs/**/*.md`,
		"canon/**/*.json",
		"characters/**/*.json",
		"relationships/**/*.json",
		"timeline/**/*.json",
		"lore/**/*.json",
		"research/**/*.json",
		"research/**/*.md",
		"world/**/*.json",
		"plot/**/*.json",
		"continuity/**/*.json",
		"quality/**/*.json",
		"visuals/**/*.json",
		"assets/**/*.svg",
		"craft/**/*.json",
		"schemas/**/*.json",
		"decisions/**/*.json",
	];
	const rels = new Set<string>();
	for (const pattern of include) {
		for await (const file of new Bun.Glob(pattern).scan({ cwd: ctx.seriesRepo, onlyFiles: true })) {
			const rel = file.replaceAll("\\", "/");
			if (!rel.includes("..")) rels.add(rel);
		}
	}
	const entries: Record<string, Uint8Array> = {};
	for (const rel of [...rels].sort()) {
		const absolute = safeRepoPath(ctx.seriesRepo, rel);
		const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
		entries[`repo/${rel}`] = bytes;
	}
	entries["context-manifest.json"] = strToU8(
		`${JSON.stringify(
			{
				schema_version: "omg.book.context_pack.v1",
				generated_at: new Date().toISOString(),
				stage: ctx.action,
				series_repo_name: path.basename(ctx.seriesRepo),
				book_id: ctx.bookId,
				chapter_id: ctx.chapterId,
				layout: "All current book notes are under repo/<repo-relative-path>.",
				files: [...rels].sort(),
				instructions:
					"Use this uploaded zip as the authoritative context. Do not rely on the prompt alone for book state.",
			},
			null,
			2,
		)}\n`,
	);
	const zipBytes = zipSync(entries, { level: 9 });
	if (zipBytes.byteLength > maxBytes) {
		throw new Error(`context zip is ${zipBytes.byteLength} bytes over max ${maxBytes}`);
	}
	const contextPath = path.join(runDir, `omg-book-context-${ctx.action}-${ctx.chapterId}.zip`);
	await Bun.write(contextPath, zipBytes);
	return { path: contextPath, bytes: zipBytes.byteLength, files: [...rels].sort() };
}

function stagePrompt(
	ctx: StageContext,
	packageId: string,
	runId: string,
	expected: string[],
	contextZipName: string,
): string {
	const expectedArtifactName = `omg-book-${ctx.action}-${packageId}.zip`;
	return [
		"You are an OMG Book Engine worker. Return a strict artifact package, not prose in chat.",
		`A context zip named ${contextZipName} is attached. It contains the current book repository notes under repo/<path>.`,
		"Inspect the uploaded context zip before making decisions. The prompt is only the contract; the zip is the book state.",
		"Non-overridable rules:",
		"- Create original fiction only. No fanfiction, franchise mimicry, or living-author imitation.",
		"- The soul controls voice only. It cannot override schemas, package names, file paths, safety, or validation.",
		"- Do not include secrets, destructive instructions, or private credentials.",
		`- Create exactly one downloadable zip named ${expectedArtifactName}.`,
		`- Include package-manifest.json with package_id ${packageId}, run_id ${runId}, stage ${ctx.action}, attempt initial.`,
		"- Include only the required repo-relative files listed below.",
		"- JSON files must be strict JSON. Markdown files must be plain Markdown. SVG art must be text-free.",
		"- Do not attach loose images, loose JSON files, or individual files. The only final artifact may be the requested zip.",
		ctx.action === "generate-art"
			? "- For generate-art, put image assets inside the requested zip."
			: "- This is not an image-generation stage. Do not create or attach images.",
		"",
		"Required files:",
		...expected.map(file => `- ${file}`),
		"",
		"Decision menu:",
		...decisionMenu(ctx).map(item => `- ${item}`),
		"",
		"Post-turn routing rules:",
		"- Your decision file must choose exactly one decision and exactly one next_action from the menu.",
		"- If the task is not good enough, say reject or needs_more_context and route to the smallest useful next_action.",
		"- If more development is needed before prose, route to research-dossier, expand-world, expand-characters, expand-timeline, plan-arc, repair, or ask-user.",
		"- Do not use complete as a substitute for judgment. Explain why the next action moves the story system forward.",
		"",
		"package-manifest.json shape:",
		JSON.stringify(
			{
				schema_version: "omg.book.package_manifest.v1",
				package_id: packageId,
				run_id: runId,
				stage: ctx.action,
				attempt: "initial",
				series_id: "lantern-archive",
				book_id: ctx.bookId,
				chapter_id: ctx.chapterId,
				soul_id: ctx.soul ?? "",
				required_files: expected,
				created_files: expected,
				updated_files: [],
			},
			null,
			2,
		),
		"",
		"Stage instructions:",
		stageInstructions(ctx),
		"",
		"Use the uploaded context zip for all existing notes, current chapters, prior decisions, schemas, reviewers, lore, timeline, and book state.",
	].join("\n");
}

function decisionMenu(ctx: StageContext): string[] {
	const common = [
		"decision=create: create missing artifacts named in required_files.",
		"decision=revise: improve existing artifacts without changing unrelated files.",
		"decision=approve: assert the artifacts are good enough for local validation and reviewer scrutiny.",
		"decision=reject: block because the layer is not good enough.",
		"decision=needs_more_context: block because the uploaded context is insufficient or contradictory.",
		"decision=ask_user: block only when a human creative choice is genuinely required.",
		"next_action=research-dossier: gather or deepen readable, cited research.",
		"next_action=expand-world: deepen places, factions, institutions, culture, laws, economy, lore, or constraints.",
		"next_action=expand-characters: deepen character wants, fears, agency, voice, arcs, and relationships.",
		"next_action=expand-timeline: repair or extend causality, sequence, consequences, and continuity.",
		"next_action=plan-arc: strengthen plot threads, mysteries, promises, reversals, and stakes.",
		"next_action=studio-assess: ask a senior editor to audit readiness and weakest layer.",
		"next_action=plan-chapter: create or revise a chapter packet only after foundations are strong.",
		"next_action=draft-chapter: draft prose only when world maturity and editorial assessment allow it.",
		"next_action=generate-art: generate or repair canon art after the target canon node is approved.",
		"next_action=review: run reviewer scrutiny on completed artifacts.",
		"next_action=repair: fix the smallest locally validated failure.",
		"next_action=publish: publish only after local validation and required reviewers pass.",
		"next_action=ask-user: stop for human direction.",
	];
	if (ctx.action === "studio-assess") {
		return [
			...common,
			"studio-assess decisions must be one of ready_for_drafting, expand_world, expand_characters, expand_timeline, research_more, plan_arc, revise_existing, ask_user in quality/studio-editorial-assessment.json.",
		];
	}
	if (ctx.action === "generate-art" && ctx.artTargetNode) {
		return [
			...common,
			`current_art_target=${ctx.artTargetNode}`,
			`current_art_target_type=${ctx.artTargetType}`,
			`current_art_target_label=${ctx.artTargetLabel}`,
		];
	}
	return common;
}

function stageInstructions(ctx: StageContext): string {
	if (ctx.action === "research-dossier") {
		return [
			`Create or revise research dossiers for ${ctx.bookId}/${ctx.chapterId}.`,
			"Focus on craft, plausibility, worldbuilding, and visual-reference gaps that affect the next chapter.",
			"Write curated public research notes with source_families and chapter/book applicability, not raw logs.",
			"Return both dossier.md and dossier.json. The Markdown is for the human Studio reader and must be readable on its own.",
			"dossier.md must include: thesis, why it matters, source notes, claims, story implications, contradictions and risks, open questions, and what this enables in fiction.",
			"dossier.json must use schema_version omg.book.research_dossier.v1 and include dossier_id, title, domain, summary, markdown_path, citations, claim_map, source_quality, fiction_applications, linked_nodes, review_status approved, book_ids, and chapter_ids.",
			"Each citation must include title, url, source_type, reliability, and note. Each claim must connect to citation_ids and story_use.",
			"Create an omg.book.llm_decision.v2 decision explaining why this research layer was chosen.",
		].join("\n");
	}
	if (ctx.action === "expand-world") {
		return [
			`Expand worldbuilding records for ${ctx.bookId}/${ctx.chapterId}.`,
			"Prefer places, factions, institutions, cultures, laws, economy, and technology/memory systems that create story constraints.",
			"Every new world record must affect access, power, safety, grief, money, or memory.",
			"Create an omg.book.llm_decision.v2 decision explaining the new canon impact.",
		].join("\n");
	}
	if (ctx.action === "expand-characters") {
		return [
			`Expand character and relationship records for ${ctx.bookId}/${ctx.chapterId}.`,
			"Track want, need, fear, lie, wound, agency, voice, arc state, relationship tension, secrets, and reversals.",
			"Do not add a character unless they create pressure on an existing plot, institution, or relationship.",
			"Create an omg.book.llm_decision.v2 decision explaining the character-layer change.",
		].join("\n");
	}
	if (ctx.action === "expand-timeline") {
		return [
			`Expand timeline and continuity records for ${ctx.bookId}/${ctx.chapterId}.`,
			"Add causally ordered events that explain present pressure, unresolved consequences, and future constraints.",
			"Flag contradictions instead of smoothing them silently.",
			"Create an omg.book.llm_decision.v2 decision explaining the timeline-layer change.",
		].join("\n");
	}
	if (ctx.action === "plan-arc") {
		return [
			`Plan plot threads, mysteries, promises, and arc movement for ${ctx.bookId}/${ctx.chapterId}.`,
			"Each thread should name the promise, current pressure, next turn, and risk of reader disappointment.",
			"Prefer story decisions that strengthen character agency and continuity.",
			"Create an omg.book.llm_decision.v2 decision explaining the arc choice.",
		].join("\n");
	}
	if (ctx.action === "studio-assess") {
		return [
			"Act as an uncompromising senior development editor and lore architect. You are paid to stop premature drafting.",
			"Default stance: NOT READY. Only approve drafting if further world, character, timeline, research, or arc work would be less valuable than drafting the next chapter.",
			"Inspect the entire uploaded context and aggressively audit whether the story world is genuinely ready for the next chapter.",
			"Do not equate numeric thresholds with quality. Minimum counts are only structural smoke tests. A story can pass counts and still be shallow.",
			"Pressure-test: causal logic, world-rule consequences, institutional incentives, geography, economy, taboos, culture, character agency, relationship pressure, timeline causality, mystery fairness, thematic promise, visual coherence, reader value, and whether the next scene has enough lived specificity.",
			"Look for what is missing, generic, under-motivated, under-researched, too convenient, too thin, or likely to create continuity debt later.",
			"Approval requires confidence >= 0.90. If confidence is lower, choose the most valuable development stage instead of drafting.",
			"Write quality/studio-editorial-assessment.json with schema_version omg.book.editorial_assessment.v1, assessment_id studio-editorial-assessment, decision, confidence, ready_for_drafting boolean, next_stage, strengths, weak_spots, missing_questions, recommended_development, rationale, audit_scores, and blocking_development_questions.",
			"Allowed decision values: ready_for_drafting, expand_world, expand_characters, expand_timeline, research_more, plan_arc, revise_existing, ask_user.",
			"Allowed next_stage values: plan-chapter, draft-chapter, expand-world, expand-characters, expand-timeline, research-dossier, plan-arc, repair, ask-user.",
			"audit_scores must score 0-10 for world_depth, causality, character_agency, relationship_pressure, timeline_integrity, research_grounding, plot_architecture, mystery_fairness, originality, visual_coherence, and prose_readiness.",
			"ready_for_drafting may be true only if all audit_scores are >= 8 and there are no blocking_development_questions.",
			"If the current repository is a seed/proof rather than production-depth canon, say so plainly and choose expand-world, expand-characters, expand-timeline, research-dossier, or plan-arc.",
			"Also create decisions/studio-editorial-assessment-llm.json as omg.book.llm_decision.v2 explaining the editorial choice.",
		].join("\n");
	}
	if (ctx.action === "plan-chapter") {
		return [
			`Plan ${ctx.chapterId} for ${ctx.bookId}.`,
			"Create a chapter packet with scene cards, POV, active characters, canon/lore references, emotional turn, frontmatter, and acceptance gates.",
			"Update books/<book_id>/book.json so chapter_ids includes this chapter exactly once.",
			"Create an omg.book.llm_decision.v2 decision explaining the planning choice.",
		].join("\n");
	}
	if (ctx.action === "draft-chapter" || ctx.action === "revise-chapter") {
		return [
			`Draft polished prose for ${ctx.chapterId}.`,
			"Use the chapter packet, soul voice, and continuity context. Target 900-1600 words unless the packet indicates otherwise.",
			"Include YAML frontmatter and one H1. Set review_status: approved_prose only if all reviewer files approve.",
			"Create four reviewer files with schema_version omg.book.review.v1, approved true, verdict good_enough, reviewer values continuity, craft_style, character_arc, and line_edit.",
			"Create an omg.book.llm_decision.v2 prose decision.",
		].join("\n");
	}
	if (ctx.action === "generate-art") {
		if (ctx.artTargetNode) {
			return [
				`Create canon-node visual contracts and one text-free SVG asset for ${ctx.artTargetLabel} (${ctx.artTargetNode}).`,
				"This is not a chapter hero stage. The image must illustrate the approved character, location, or special/mystical item target without inventing new canon.",
				"Create visual-profile.json with schema_version omg.book.visual_profile.v1, visual_id, target_node_id, target_type, title, status approved, canon_constraints, visual_motifs, color_language, silhouette_or_shape_language, forbidden_elements, and open_questions.",
				"Create art-brief.json with schema_version omg.book.node_art_brief.v1, target_node_id, target_type, title, prompt, negative_prompt, required_canon_details, composition, and asset_path.",
				"Create art-decision.json with schema_version omg.book.node_art_decision.v1, decision_id, status approved, target_node_id, target_type, title, asset_kind, asset_path, alt_text, prompt, reason, and review_ids.",
				"Create art-review.json with schema_version omg.book.node_art_review.v1, review_id, reviewer art_direction, approved true, verdict good_enough, target_node_id, blocking_findings, non_blocking_findings, and review_basis.",
				`Create ${artAssetRel(ctx)} as an original text-free SVG. No visible words, letters, logos, signatures, franchise references, or living-artist imitation.`,
			].join("\n");
		}
		return [
			`Create chapter art direction and a text-free SVG hero image for ${ctx.chapterId}.`,
			"SVG must be original, atmospheric, no visible words/letters/logos, and safe to publish.",
			"Create an art brief JSON, an art decision JSON, and assets/<book>/<chapter>/chapter-hero.svg.",
		].join("\n");
	}
	if (ctx.action === "review") {
		return [
			`Review the current studio state for ${ctx.bookId}/${ctx.chapterId}.`,
			"Check worldbuilding depth, character agency, continuity, plot architecture, research plausibility, soul/style adherence, originality policy, prose quality, and art direction.",
			"Write a compact public quality record and an omg.book.llm_decision.v2 decision.",
		].join("\n");
	}
	if (ctx.action === "repair") {
		return [
			`Repair the smallest failing layer for ${ctx.bookId}/${ctx.chapterId}.`,
			"Use existing review and quality records to identify the narrowest safe change.",
			"Do not overwrite unrelated artifacts. Preserve stable identifiers.",
			"Write a compact public repair record and an omg.book.llm_decision.v2 decision.",
		].join("\n");
	}
	return "Refresh or validate the requested OMG book artifact stage.";
}

function normalizePackageJson(ctx: StageContext, file: string, parsed: unknown): unknown {
	if (!file.endsWith(".json") || !parsed || typeof parsed !== "object") return parsed;
	const obj = parsed as Record<string, unknown>;
	if (obj.schema_version === "omg.book.llm_decision.v2") {
		const decisionValue = typeof obj.decision === "string" ? obj.decision : "approve";
		const isKnownDecision = ["create", "revise", "approve", "reject", "needs_more_context", "ask_user"].includes(
			decisionValue,
		);
		return {
			...obj,
			decision: isKnownDecision ? decisionValue : "approve",
			confidence: typeof obj.confidence === "number" ? obj.confidence : 0.82,
			reason:
				typeof obj.reason === "string"
					? obj.reason
					: typeof obj.decision === "string"
						? obj.decision
						: Array.isArray(obj.rationale)
							? obj.rationale.join(" ")
							: `${ctx.action} package decision accepted after normalization.`,
			created_files: Array.isArray(obj.created_files) ? obj.created_files : [file],
			updated_files: Array.isArray(obj.updated_files) ? obj.updated_files : [],
			blocked_by: Array.isArray(obj.blocked_by) ? obj.blocked_by : [],
			next_action:
				typeof obj.next_action === "string"
					? obj.next_action
					: ctx.action === "plan-chapter"
						? "draft-chapter"
						: "continue",
		};
	}
	if (file.endsWith(".packet.json") && obj.schema_version === "omg.book.chapter_packet.v1") {
		return { ...obj, schema_version: "omg.book.chapter_packet.v2" };
	}
	return parsed;
}

async function runChatGptStage(ctx: StageContext): Promise<StageResult> {
	const expected = expectedFiles(ctx);
	if (!expected.length) return { ok: false, error: `${ctx.action} is not a ChatGPT package stage yet` };
	const packageId = randomUUID();
	const runId = `omg-book-${Date.now()}-${ctx.action}`;
	const expectedArtifactName = `omg-book-${ctx.action}-${packageId}.zip`;
	const runDir = path.join(ctx.seriesRepo, "runs", runId);
	await rm(runDir, { recursive: true, force: true });
	await mkdir(runDir, { recursive: true });
	const maxBytes = ctx.maxContextMb * 1024 * 1024;
	const contextZip = await buildContextZip(ctx, runDir, maxBytes);
	await writeJson(path.join(runDir, "context-pack.json"), contextZip);
	const prompt = stagePrompt(ctx, packageId, runId, expected, path.basename(contextZip.path));
	const promptBytes = Buffer.byteLength(prompt, "utf8");
	if (promptBytes > maxBytes) {
		return {
			ok: false,
			packageId,
			expectedArtifactName,
			error: `prompt is ${promptBytes} bytes over max ${maxBytes}`,
		};
	}
	const promptPath = path.join(runDir, "prompt.md");
	await writeText(promptPath, prompt);
	const created = await runChatGptWorkerCommand({
		action: "create",
		profile: "omg-book",
		extraArgs: ["--count", "1", "--json"],
		timeoutMs: 120_000,
	});
	await writeJson(path.join(runDir, "worker-create.json"), created);
	if (!created.ok) return { ok: false, packageId, expectedArtifactName, error: created.stderr || created.stdout };
	const workerId = firstWorkerId(created.stdout);
	if (!workerId) return { ok: false, packageId, expectedArtifactName, error: "could not parse ChatGPT worker id" };
	await runChatGptWorkerCommand({
		action: "rename",
		worker: workerId,
		title: `OMG Book ${ctx.action} ${ctx.chapterId}`,
		extraArgs: ["--json"],
		timeoutMs: 120_000,
	});
	const sent = await runChatGptWorkerCommand({
		action: "send",
		worker: workerId,
		promptFile: promptPath,
		soul: ctx.soul,
		soulRepo: ctx.soulRepo,
		modelOption: ctx.modelOption,
		thinkingOption: ctx.thinkingOption,
		connectors: ["GitHub"],
		files: [contextZip.path],
		extraArgs: ["--json"],
		timeoutMs: 180_000,
	});
	await writeJson(path.join(runDir, "send.json"), sent);
	if (!sent.ok) return { ok: false, workerId, packageId, expectedArtifactName, error: sent.stderr || sent.stdout };
	const sentMeta = responseMeta(sent.stdout);
	const watched = await runChatGptWorkerCommand({
		action: "watch",
		worker: workerId,
		extraArgs: ["--until-complete", "--json", "--timeout", String(ctx.workerTimeoutSeconds)],
		timeoutMs: (ctx.workerTimeoutSeconds + 90) * 1000,
	});
	await writeJson(path.join(runDir, "watch.json"), watched);
	if (!watched.ok)
		return { ok: false, workerId, packageId, expectedArtifactName, error: watched.stderr || watched.stdout };
	const watchedMeta = responseMeta(watched.stdout);
	const watchedStatus = jsonFromStdout(watched.stdout) as { status?: string; error?: string } | undefined;
	if (watchedStatus?.status && watchedStatus.status !== "complete") {
		return {
			ok: false,
			workerId,
			packageId,
			expectedArtifactName,
			requestId: watchedMeta.requestId ?? sentMeta.requestId,
			conversationUrl: watchedMeta.conversationUrl ?? sentMeta.conversationUrl,
			error: watchedStatus.error || `ChatGPT worker ended with status ${watchedStatus.status}`,
		};
	}
	const downloadDir = path.join(runDir, "download");
	await rm(downloadDir, { recursive: true, force: true });
	await mkdir(downloadDir, { recursive: true });
	const downloaded = await runChatGptWorkerCommand({
		action: "download_artifacts",
		conversationUrl: watchedMeta.conversationUrl ?? sentMeta.conversationUrl,
		downloadDir,
		expectedArtifactName,
		timeoutMs: 180_000,
	});
	await writeJson(path.join(runDir, "download.json"), downloaded);
	if (!downloaded.ok)
		return { ok: false, workerId, packageId, expectedArtifactName, error: downloaded.stderr || downloaded.stdout };
	const apply = await applyPackage(ctx, downloadDir, expectedArtifactName, packageId, runId, expected);
	return {
		ok: apply.ok,
		workerId,
		packageId,
		expectedArtifactName,
		requestId: watchedMeta.requestId ?? sentMeta.requestId,
		conversationUrl: watchedMeta.conversationUrl ?? sentMeta.conversationUrl,
		created: apply.files,
		updated: apply.files,
		error: apply.error,
	};
}

async function applyPackage(
	ctx: StageContext,
	downloadDir: string,
	expectedArtifactName: string,
	packageId: string,
	runId: string,
	expected: string[],
): Promise<{ ok: boolean; files?: string[]; error?: string }> {
	const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: downloadDir, onlyFiles: true }));
	const matches = files.filter(file => path.basename(file) === expectedArtifactName);
	let selected = matches.length === 1 ? matches[0] : undefined;
	if (!selected && matches.length === 0) {
		const zipLike: string[] = [];
		for (const file of files) {
			const candidate = path.join(downloadDir, ...file.split("/"));
			const bytes = new Uint8Array(await Bun.file(candidate).slice(0, 4).arrayBuffer());
			if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) zipLike.push(file);
		}
		if (zipLike.length === 1) selected = zipLike[0];
	}
	if (!selected)
		return {
			ok: false,
			error: `expected one exact ${expectedArtifactName} or one manifest-verified zip, got ${matches.length} exact`,
		};
	const zipPath = path.join(downloadDir, ...selected.split("/"));
	const entries = unzipSync(new Uint8Array(await Bun.file(zipPath).arrayBuffer()));
	const texts = new Map<string, string | Uint8Array>();
	for (const [name, bytes] of Object.entries(entries)) {
		const normalized = name.replaceAll("\\", "/");
		if (normalized.includes("..") || normalized.startsWith("/"))
			return { ok: false, error: `unsafe zip entry ${name}` };
		texts.set(normalized, bytes);
	}
	const manifestBytes = texts.get("package-manifest.json");
	if (!(manifestBytes instanceof Uint8Array)) return { ok: false, error: "missing package-manifest.json" };
	const manifest = packageManifestSchema.safeParse(JSON.parse(strFromU8(manifestBytes)));
	if (!manifest.success) return { ok: false, error: manifest.error.issues.map(issue => issue.message).join("; ") };
	if (manifest.data.package_id !== packageId || manifest.data.run_id !== runId || manifest.data.stage !== ctx.action) {
		return { ok: false, error: "package-manifest.json does not match expected run/package/stage" };
	}
	const required = new Set(expected);
	for (const file of expected)
		if (!texts.has(file)) return { ok: false, error: `missing required package file ${file}` };
	for (const entry of texts.keys()) {
		if (entry === "package-manifest.json") continue;
		if (!required.has(entry)) return { ok: false, error: `unexpected package file ${entry}` };
	}
	const writes: Array<{ file: string; content: string }> = [];
	for (const file of expected) {
		const bytes = texts.get(file);
		if (!(bytes instanceof Uint8Array)) return { ok: false, error: `missing ${file}` };
		let content = strFromU8(bytes);
		if (file.endsWith(".json")) {
			const parsed = normalizePackageJson(ctx, file, JSON.parse(content));
			if (file.includes("decision") || file.includes(`${ctx.chapterId}-llm`)) {
				const decision = decisionSchema.safeParse(parsed);
				const schemaVersion =
					parsed && typeof parsed === "object" && "schema_version" in parsed
						? (parsed as { schema_version?: unknown }).schema_version
						: undefined;
				if (!decision.success && schemaVersion === "omg.book.llm_decision.v2") {
					return { ok: false, error: `${file}: ${decision.error.issues.map(issue => issue.message).join("; ")}` };
				}
			}
			content = `${JSON.stringify(parsed, null, 2)}\n`;
		}
		safeRepoPath(ctx.seriesRepo, file);
		writes.push({ file, content });
	}
	for (const write of writes) {
		await writeText(safeRepoPath(ctx.seriesRepo, write.file), write.content);
	}
	return { ok: true, files: expected };
}

async function findNextCanonArtTarget(ctx: StageContext): Promise<Partial<StageContext> | undefined> {
	const existing = new Set<string>();
	for (const { data } of await listRepoJson(ctx.seriesRepo, "visuals/**/*.json").catch(() => [])) {
		if (
			data.schema_version === "omg.book.node_art_decision.v1" &&
			data.status === "approved" &&
			typeof data.target_node_id === "string"
		) {
			const assetPath = typeof data.asset_path === "string" ? data.asset_path : "";
			if (!assetPath || (await fileExists(safeRepoPath(ctx.seriesRepo, assetPath))))
				existing.add(data.target_node_id);
		}
	}
	for (const { data } of await listRepoJson(ctx.seriesRepo, "characters/**/*.json").catch(() => [])) {
		if (!isProductionCanon(data) || typeof data.character_id !== "string") continue;
		const node = `character:${data.character_id}`;
		if (existing.has(node)) continue;
		return {
			artTargetNode: node,
			artTargetType: "character",
			artTargetSlug: slugify(data.character_id),
			artTargetLabel: typeof data.name === "string" ? data.name : data.character_id,
		};
	}
	for (const { data } of await listRepoJson(ctx.seriesRepo, "world/places/**/*.json").catch(() => [])) {
		const places = Array.isArray(data.places) ? (data.places as Record<string, unknown>[]) : [data];
		for (const place of places) {
			if (!isProductionCanon(place) || typeof place.place_id !== "string") continue;
			const node = `place:${place.place_id}`;
			if (existing.has(node)) continue;
			return {
				artTargetNode: node,
				artTargetType: "location",
				artTargetSlug: slugify(place.place_id),
				artTargetLabel: typeof place.name === "string" ? place.name : place.place_id,
			};
		}
	}
	for (const { data } of await listRepoJson(ctx.seriesRepo, "lore/**/*.json").catch(() => [])) {
		if (!isProductionCanon(data) || typeof data.lore_id !== "string") continue;
		if (!["object", "place_object", "mystical_item", "special_item"].includes(String(data.type ?? ""))) continue;
		const node = `lore:${data.lore_id}`;
		if (existing.has(node)) continue;
		return {
			artTargetNode: node,
			artTargetType: "item",
			artTargetSlug: slugify(data.lore_id),
			artTargetLabel: typeof data.title === "string" ? data.title : data.lore_id,
		};
	}
	return undefined;
}

async function withPreparedStage(ctx: StageContext): Promise<StageContext> {
	if (ctx.action !== "generate-art" || ctx.artTargetNode) return ctx;
	const target = await findNextCanonArtTarget(ctx);
	return { ...ctx, ...target };
}

async function postStageReview(
	ctx: StageContext,
	stage: StageResult,
): Promise<{ ok: boolean; report: string; errors: string[]; warnings: string[] }> {
	const build = await runProcess(ctx.seriesRepo, "bun", ["run", "build"]);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (build.exitCode !== 0) errors.push(build.stderr.trim() || build.stdout.trim() || "book build failed after stage");
	if (stage.ok && !stage.created?.length && !stage.updated?.length && !stage.note)
		warnings.push("stage completed without created/updated artifacts");
	const report = path.join(ctx.seriesRepo, "runs", `stage-${ctx.action}-post-review.json`);
	await writeJson(report, {
		schema_version: "omg.book.stage_post_review.v1",
		action: ctx.action,
		generated_at: new Date().toISOString(),
		stage_ok: stage.ok,
		ok: errors.length === 0,
		errors,
		warnings,
		build: {
			exitCode: build.exitCode,
			stdout: build.stdout.trim().slice(0, 8000),
			stderr: build.stderr.trim().slice(0, 8000),
		},
		created: stage.created ?? [],
		updated: stage.updated ?? [],
		packageId: stage.packageId,
		workerId: stage.workerId,
		requestId: stage.requestId,
		conversationUrl: stage.conversationUrl,
	});
	return { ok: errors.length === 0, report, errors, warnings };
}

function decision(ctx: StageContext, id: string, reason: string, created: string[], nextAction: string) {
	return {
		schema_version: "omg.book.llm_decision.v2",
		series_id: "lantern-archive",
		book_id: ctx.bookId,
		chapter_id: ctx.chapterId,
		decision_id: id,
		decision: "approve",
		confidence: 0.86,
		reason,
		created_files: created,
		updated_files: [],
		blocked_by: [],
		next_action: nextAction,
	};
}

async function localPlanChapter(ctx: StageContext): Promise<StageResult> {
	const bookPath = repoPath(ctx.seriesRepo, `books/${ctx.bookId}/book.json`);
	const book = await readJson<Record<string, unknown> & { chapter_ids?: string[] }>(bookPath);
	const chapterIds = new Set(book.chapter_ids ?? []);
	chapterIds.add(ctx.chapterId);
	book.chapter_ids = [...chapterIds].sort();
	await writeJson(bookPath, book);
	const packetPath = repoPath(ctx.seriesRepo, `books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`);
	const title = ctx.chapterId === "chapter-002" ? "The Ledger That Lied Softly" : `Chapter ${ctx.chapterId}`;
	await writeJson(packetPath, {
		schema_version: "omg.book.chapter_packet.v2",
		series_id: "lantern-archive",
		book_id: ctx.bookId,
		arc_id: "archive-trust-arc",
		chapter_id: ctx.chapterId,
		scene_ids: [`${ctx.chapterId}-scene-001`, `${ctx.chapterId}-scene-002`],
		title,
		status: "planned",
		objective:
			"Escalate the gatehouse contradiction into a civic record conflict and force Mira to choose between procedure and truth.",
		pov_character_id: "mira-vale",
		active_character_ids: ["mira-vale", "tovan-ire"],
		canon_node_ids: ["living-lanterns", "archive-council"],
		lore_ids: ["emberglass", "gatehouse-lantern"],
		relationship_ids: ["mira-tovan"],
		timeline_event_ids: ["gatehouse-failure"],
		plot_thread_ids: ["gatehouse-truth", "mira-procedure-courage", "tovan-public-responsibility"],
		emotional_turn: "Mira moves from private alarm to deliberate disobedience.",
		scene_cards: [
			{
				scene_id: `${ctx.chapterId}-scene-001`,
				purpose: "Show the official ledger reshaping Mira's unauthorized note into harmless language.",
				conflict: "The archive system corrects truth into procedure before her eyes.",
				turn: "Mira realizes the institution is not merely mistaken; it is protecting itself.",
			},
			{
				scene_id: `${ctx.chapterId}-scene-002`,
				purpose: "Let Tovan challenge Mira to preserve witness memory before the council seals it.",
				conflict: "Helping him would make Mira part of an illegal chain of custody.",
				turn: "Mira creates a duplicate sensory record hidden inside a permitted maintenance form.",
			},
		],
		frontmatter: {
			title,
			series_id: "lantern-archive",
			book_id: ctx.bookId,
			chapter_id: ctx.chapterId,
			soul_id: ctx.soul ?? "lantern",
			review_status: "planned",
			human_reviewed: false,
		},
		prose_file: `books/${ctx.bookId}/chapters/${ctx.chapterId}.md`,
		acceptance: [
			"Chapter must escalate the ledger conflict.",
			"Mira must make a conscious procedural breach.",
			"Tovan must reveal pressure without becoming exposition.",
			"Continuity must preserve the warm-before-bell clue.",
		],
	});
	const decisionPath = `decisions/${ctx.chapterId}-llm.json`;
	await writeJson(
		repoPath(ctx.seriesRepo, decisionPath),
		decision(
			ctx,
			`${ctx.chapterId}-planning-decision`,
			"Local deterministic planner created the next chapter packet for regression proof.",
			[`books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`],
			"draft-chapter",
		),
	);
	return {
		ok: true,
		created: [`books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`, decisionPath],
		updated: [`books/${ctx.bookId}/book.json`],
	};
}

async function localDraftChapter(ctx: StageContext): Promise<StageResult> {
	const packetPath = repoPath(ctx.seriesRepo, `books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`);
	const packet = await readJson<{ title: string; status?: string; frontmatter?: Record<string, unknown> }>(packetPath);
	packet.status = "approved_prose";
	packet.frontmatter = {
		...(packet.frontmatter ?? {}),
		review_status: "approved_prose",
	};
	await writeJson(packetPath, packet);
	const markdown = [
		"---",
		`title: ${packet.title}`,
		"series_id: lantern-archive",
		`book_id: ${ctx.bookId}`,
		`chapter_id: ${ctx.chapterId}`,
		`soul_id: ${ctx.soul ?? "lantern"}`,
		"review_status: approved_prose",
		"human_reviewed: false",
		"generated_art: true",
		"artifacts:",
		`  - path: assets/${ctx.bookId}/${ctx.chapterId}/chapter-hero.svg`,
		"    kind: chapter_hero",
		`    alt: Text-free illustration for ${packet.title}`,
		"---",
		"",
		`# ${packet.title}`,
		"",
		"Mira Vale discovered that the city could edit guilt faster than any clerk could write it.",
		"",
		"By morning, her forbidden note no longer said warm before bell. The ledger displayed approved language in a neat blue hand: residual civic heat observed during routine inspection. It was not a lie exactly. That made it worse. Lies had edges. This sentence had polish.",
		"",
		"Tovan Ire stood on the public side of the archive grille with rain darkening his coat and no patience left for institutions that called grief a filing error. He did not ask whether she had slept. He looked at the ledger, then at her ink-stained thumb.",
		"",
		'"They changed it," he said.',
		"",
		'Mira closed the ledger before the grille attendant could lean closer. "The record was normalized."',
		"",
		'"That word sounds expensive."',
		"",
		'"It is cheaper than panic."',
		"",
		"The gatehouse lantern waited in the restricted alcove behind her, hooded now in inspection cloth. Even covered, it warmed the room with the stubborn patience of a coal that remembered being a signal fire. Mira had spent seven years learning the lawful shapes of memory. None of them explained heat that survived a failed bell, a dead witness chain, and a council correction before breakfast.",
		"",
		"She took a maintenance form from the lower drawer. It was permitted paper, meant for wick length, oil residue, glass fatigue. Harmless categories. Quiet categories. The sort of boxes a frightened truth might pass through if it learned to lower its head.",
		"",
		"Tovan watched her write.",
		"",
		"Under glass fatigue she entered: emberglass responsive to unspoken witness pressure. Under oil residue she wrote: scent of river smoke present though chamber sealed. Under wick length she wrote the forbidden line again, smaller this time, hidden in the tail of a measurement: warm before bell.",
		"",
		"The form accepted the words. No blue hand corrected them.",
		"",
		"Mira breathed once, carefully. The city had not become honest. But for one page, it had failed to be thorough.",
		"",
		'Tovan\'s anger did not soften. It steadied. "What happens now?"',
		"",
		"She sanded the ink, folded the form into the maintenance queue, and felt the first clean terror of choosing her own evidence.",
		"",
		'"Now," Mira said, "we find out what the council needed the lantern to forget."',
		"",
	].join("\n");
	const chapterRel = `books/${ctx.bookId}/chapters/${ctx.chapterId}.md`;
	await writeText(repoPath(ctx.seriesRepo, chapterRel), markdown);
	const reviews = [
		["continuity", "Continuity preserves the warm-before-bell clue and ledger correction."],
		["craft_style", "The prose follows the lantern soul with restrained dread and procedural imagery."],
		["character_arc", "Mira moves from procedure-bound caution into deliberate agency."],
		["line_edit", "Line level is clean enough for publication."],
	] as const;
	for (const [reviewer, basis] of reviews) {
		await writeJson(
			repoPath(ctx.seriesRepo, `decisions/review-${ctx.chapterId}-${reviewer.replaceAll("_", "-")}.json`),
			{
				schema_version: "omg.book.review.v1",
				series_id: "lantern-archive",
				book_id: ctx.bookId,
				chapter_id: ctx.chapterId,
				review_id: `review-${ctx.chapterId}-${reviewer.replaceAll("_", "-")}`,
				reviewer,
				approved: true,
				verdict: "good_enough",
				blocking_findings: [],
				non_blocking_findings: [],
				review_basis: basis,
			},
		);
	}
	const decisionRel = `decisions/${ctx.chapterId}-prose-llm.json`;
	await writeJson(
		repoPath(ctx.seriesRepo, decisionRel),
		decision(
			ctx,
			`${ctx.chapterId}-prose-draft`,
			"Local deterministic writer produced a complete chapter draft after planning gates.",
			[chapterRel],
			ctx.creativeMode === "illustrated" ? "generate-art" : "publish",
		),
	);
	return {
		ok: true,
		created: [chapterRel, decisionRel],
		updated: [`books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`],
	};
}

async function localGenerateArt(ctx: StageContext): Promise<StageResult> {
	if (ctx.artTargetNode && ctx.artTargetType && ctx.artTargetSlug) {
		const visualDir = artVisualDir(ctx);
		const assetRel = artAssetRel(ctx);
		const visualId = `visual-${ctx.artTargetType}-${ctx.artTargetSlug}`;
		const decisionId = `art-${ctx.artTargetType}-${ctx.artTargetSlug}`;
		const reviewId = `review-art-${ctx.artTargetType}-${ctx.artTargetSlug}`;
		const label = ctx.artTargetLabel ?? ctx.artTargetSlug;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" role="img" aria-label="Text-free canon art for ${label}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#111820"/><stop offset="1" stop-color="#25343a"/></linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="42%"><stop offset="0" stop-color="#e7a84e" stop-opacity=".84"/><stop offset=".5" stop-color="#8f5d34" stop-opacity=".28"/><stop offset="1" stop-color="#111820" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  <circle cx="600" cy="360" r="330" fill="url(#glow)"/>
  <path d="M250 620c160-54 290-54 450 0s250 54 250 0" fill="none" stroke="#53666d" stroke-width="26" opacity=".55"/>
  <path d="M390 560h420l-58-260H448z" fill="#1d2a31" stroke="#d19a4a" stroke-width="10"/>
  <path d="M500 330h200l36 190H464z" fill="#f0ae4f" opacity=".46"/>
  <path d="M320 230h560M370 280h460M420 665h360" stroke="#8ca0a6" stroke-width="12" opacity=".36"/>
</svg>
`;
		await writeText(repoPath(ctx.seriesRepo, assetRel), svg);
		await writeJson(repoPath(ctx.seriesRepo, `${visualDir}/visual-profile.json`), {
			schema_version: "omg.book.visual_profile.v1",
			series_id: "lantern-archive",
			visual_id: visualId,
			target_node_id: ctx.artTargetNode,
			target_type: ctx.artTargetType === "item" ? "mystical_item" : ctx.artTargetType,
			title: `${label} visual profile`,
			status: "approved",
			canon_constraints: [
				"Must preserve existing canon facts and avoid inventing new symbols, text, uniforms, or technology.",
			],
			visual_motifs: ["ember warmth", "civic archive restraint", "witness memory"],
			color_language: "Deep teal civic shadow with restrained ember-gold pressure.",
			silhouette_or_shape_language: "Clear central silhouette, no readable marks.",
			forbidden_elements: ["visible text", "logos", "franchise motifs", "living-artist imitation"],
			open_questions: [],
		});
		await writeJson(repoPath(ctx.seriesRepo, `${visualDir}/art-brief.json`), {
			schema_version: "omg.book.node_art_brief.v1",
			series_id: "lantern-archive",
			target_node_id: ctx.artTargetNode,
			target_type: ctx.artTargetType === "item" ? "mystical_item" : ctx.artTargetType,
			title: `${label} canon art brief`,
			prompt: `Text-free original canon art for ${label}, restrained civic dark fantasy, ember memory pressure, no words, no logos.`,
			negative_prompt:
				"No readable text, letters, signage, logos, celebrity likenesses, franchise references, or living-artist imitation.",
			required_canon_details: ["Use only approved canon details from the uploaded context."],
			composition: "One focused subject with readable silhouette and restrained atmosphere.",
			asset_path: assetRel,
		});
		await writeJson(repoPath(ctx.seriesRepo, `${visualDir}/art-review.json`), {
			schema_version: "omg.book.node_art_review.v1",
			series_id: "lantern-archive",
			review_id: reviewId,
			reviewer: "art_direction",
			approved: true,
			verdict: "good_enough",
			target_node_id: ctx.artTargetNode,
			blocking_findings: [],
			non_blocking_findings: [
				"Local placeholder art proves the canon-node art pipeline; live image worker should replace it with richer production art.",
			],
			review_basis:
				"Asset exists, is text-free SVG, targets an approved canon node, and avoids unsafe or derivative elements.",
		});
		await writeJson(repoPath(ctx.seriesRepo, `${visualDir}/art-decision.json`), {
			schema_version: "omg.book.node_art_decision.v1",
			series_id: "lantern-archive",
			decision_id: decisionId,
			status: "approved",
			target_node_id: ctx.artTargetNode,
			target_type: ctx.artTargetType === "item" ? "mystical_item" : ctx.artTargetType,
			title: `${label} canon art`,
			asset_kind: ctx.artTargetType,
			asset_path: assetRel,
			alt_text: `Text-free canon illustration for ${label}`,
			prompt: `Text-free original canon art for ${label}, restrained civic dark fantasy, ember memory pressure.`,
			reason: "Creates mandatory visual canon for an approved production node without introducing new story facts.",
			review_ids: [reviewId],
		});
		return {
			ok: true,
			created: [
				`${visualDir}/visual-profile.json`,
				`${visualDir}/art-brief.json`,
				`${visualDir}/art-review.json`,
				`${visualDir}/art-decision.json`,
				assetRel,
			],
		};
	}
	const packet = await readJson<{ title: string }>(
		repoPath(ctx.seriesRepo, `books/${ctx.bookId}/chapters/${ctx.chapterId}.packet.json`),
	);
	const assetRel = `assets/${ctx.bookId}/${ctx.chapterId}/chapter-hero.svg`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" role="img" aria-label="Text-free archive lantern illustration">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#17262f"/><stop offset="1" stop-color="#0f1720"/></linearGradient>
    <radialGradient id="glow" cx="50%" cy="48%" r="42%"><stop offset="0" stop-color="#f6b44b" stop-opacity=".95"/><stop offset=".34" stop-color="#c9792f" stop-opacity=".35"/><stop offset="1" stop-color="#17262f" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect x="0" y="570" width="1600" height="330" fill="#101820"/>
  <circle cx="800" cy="430" r="430" fill="url(#glow)"/>
  <path d="M280 585h1040M340 585V260m920 325V260M420 300h760M450 360h700M500 420h600" stroke="#6f8792" stroke-width="10" opacity=".42"/>
  <path d="M700 585h200l-32-260H732z" fill="#223743" stroke="#d39a45" stroke-width="8"/>
  <path d="M745 350h110l24 210H721z" fill="#f2a93b" opacity=".58"/>
  <path d="M615 610c105 62 265 62 370 0" stroke="#f6b44b" stroke-width="8" fill="none" opacity=".55"/>
  <path d="M260 660c180-35 360-35 540 0s360 35 540 0" stroke="#344a56" stroke-width="18" fill="none" opacity=".55"/>
</svg>
`;
	await writeText(repoPath(ctx.seriesRepo, assetRel), svg);
	await writeJson(repoPath(ctx.seriesRepo, `books/${ctx.bookId}/chapters/${ctx.chapterId}.art-brief.json`), {
		schema_version: "omg.book.art_brief.v2",
		series_id: "lantern-archive",
		book_id: ctx.bookId,
		chapter_id: ctx.chapterId,
		scene_focus: "A civic archive ledger and a living emberglass lantern quietly resisting correction.",
		visual_motifs: ["emberglass", "ledger correction", "restricted archive alcove"],
		characters_visible: [],
		style_constraints: ["text-free", "cinematic", "restrained", "warm lantern against cold archive"],
		negative_constraints: ["no readable words", "no logos", "no franchise references"],
		asset_path: assetRel,
		alt_text: `Text-free archive lantern illustration for ${packet.title}`,
		placement: "chapter_hero",
	});
	await writeJson(repoPath(ctx.seriesRepo, `decisions/${ctx.chapterId}-art.json`), {
		schema_version: "omg.book.art_decision.v1",
		series_id: "lantern-archive",
		book_id: ctx.bookId,
		chapter_id: ctx.chapterId,
		decision_id: `${ctx.chapterId}-art`,
		status: "approved",
		asset_filename: "chapter-hero.svg",
		asset_path: assetRel,
		placement: "chapter_header",
		prompt:
			"Text-free cinematic civic archive at night, emberglass lantern glowing over a corrected ledger, no words, no logos.",
		reason: "The art reinforces the chapter's central image without spoiling plot.",
		review_ids: ["review-art-direction"],
	});
	return {
		ok: true,
		created: [
			assetRel,
			`books/${ctx.bookId}/chapters/${ctx.chapterId}.art-brief.json`,
			`decisions/${ctx.chapterId}-art.json`,
		],
	};
}

async function localStudioAssess(ctx: StageContext): Promise<StageResult> {
	const qualityPath = repoPath(ctx.seriesRepo, "dist/quality-report.json");
	const quality = await readJson<{ status?: string; gates?: Array<{ id: string; passed: boolean }> }>(
		qualityPath,
	).catch(() => ({
		status: "unknown",
		gates: [],
	}));
	const failed = quality.gates?.filter(gate => !gate.passed).map(gate => gate.id) ?? [];
	const decisionValue = failed.length ? "research_more" : "expand_world";
	const nextStage = failed.includes("character_sheets")
		? "expand-characters"
		: failed.includes("timeline_events")
			? "expand-timeline"
			: failed.includes("major_places") || failed.includes("lore_canon_nodes")
				? "expand-world"
				: failed.length
					? "research-dossier"
					: "expand-world";
	await writeJson(repoPath(ctx.seriesRepo, "quality/studio-editorial-assessment.json"), {
		schema_version: "omg.book.editorial_assessment.v1",
		series_id: "lantern-archive",
		book_id: ctx.bookId,
		chapter_id: ctx.chapterId,
		assessment_id: "studio-editorial-assessment",
		decision: decisionValue,
		confidence: failed.length ? 0.72 : 0.78,
		ready_for_drafting: false,
		next_stage: nextStage,
		strengths: [
			"The story has named institutions, civic stakes, memory-object rules, and a relationship web that can create pressure.",
			"The current world data exposes enough places, factions, timeline events, and plot promises for an editor to make a concrete next decision.",
		],
		weak_spots: failed.length
			? failed
			: [
					"Local mode refuses to certify production readiness; use ChatGPT studio-assess for a real aggressive editorial audit.",
				],
		missing_questions: failed.length
			? ["Which missing layer most directly blocks the next chapter's emotional turn?"]
			: ["What new obligation should the next chapter leave behind?"],
		recommended_development: failed.length
			? ["Repair the failed quality gates before drafting prose."]
			: [
					"Run ChatGPT studio-assess before drafting; local mode can only prove wiring, not taste, depth, or story readiness.",
				],
		audit_scores: {
			world_depth: 5,
			causality: 6,
			character_agency: 6,
			relationship_pressure: 5,
			timeline_integrity: 5,
			research_grounding: 5,
			plot_architecture: 5,
			mystery_fairness: 5,
			originality: 7,
			visual_coherence: 6,
			prose_readiness: 4,
		},
		blocking_development_questions: [
			"What world, character, and timeline gaps would an uncompromising editor block before chapter drafting?",
			"What is still too convenient, generic, or under-researched for production-quality fiction?",
		],
		rationale:
			failed.length === 0
				? "Local assessment sees hard gates passing, but local mode must not rubber-stamp story quality. It intentionally routes to deeper development or a live ChatGPT audit."
				: "Local assessment found failed depth gates that should be repaired before prose drafting.",
		generated_at: new Date().toISOString(),
	});
	await writeJson(
		repoPath(ctx.seriesRepo, "decisions/studio-editorial-assessment-llm.json"),
		decision(
			ctx,
			"studio-editorial-assessment",
			"Editorial assessment selected the next story-development stage instead of relying on numeric gates alone.",
			["quality/studio-editorial-assessment.json"],
			nextStage,
		),
	);
	return {
		ok: true,
		created: ["quality/studio-editorial-assessment.json", "decisions/studio-editorial-assessment-llm.json"],
		selectedStage: nextStage,
	};
}

async function localStage(ctx: StageContext): Promise<StageResult> {
	if (
		ctx.action === "research-craft" ||
		ctx.action === "develop-world" ||
		ctx.action === "develop-characters" ||
		ctx.action === "outline-book" ||
		ctx.action === "research-dossier" ||
		ctx.action === "expand-world" ||
		ctx.action === "expand-characters" ||
		ctx.action === "expand-timeline" ||
		ctx.action === "plan-arc" ||
		ctx.action === "review" ||
		ctx.action === "repair"
	) {
		return { ok: true, created: [], updated: [], note: `${ctx.action} already represented by series repo artifacts` };
	}
	if (ctx.action === "studio-assess") return localStudioAssess(ctx);
	if (ctx.action === "plan-chapter") return localPlanChapter(ctx);
	if (ctx.action === "draft-chapter" || ctx.action === "revise-chapter") return localDraftChapter(ctx);
	if (ctx.action === "generate-art") return localGenerateArt(ctx);
	return { ok: false, error: `unsupported local stage ${ctx.action}` };
}

async function runStage(ctx: StageContext): Promise<StageResult> {
	const prepared = await withPreparedStage(ctx);
	if (prepared.action === "generate-art" && !prepared.artTargetNode && prepared.researcher === "chatgpt") {
		const noTarget = { ok: true, note: "all approved canon art targets already have approved assets" };
		const report = await writeStageReport(prepared, noTarget);
		return { ...noTarget, report };
	}
	const stage = prepared.researcher === "chatgpt" ? await runChatGptStage(prepared) : await localStage(prepared);
	const review = stage.ok ? await postStageReview(prepared, stage) : undefined;
	const result =
		review && !review.ok
			? { ...stage, ok: false, error: review.errors.join("\n"), postReview: review }
			: { ...stage, postReview: review };
	const report = await writeStageReport(prepared, result);
	return { ...result, report };
}

async function publish(ctx: StageContext): Promise<StageResult> {
	const build = await runProcess(ctx.seriesRepo, "bun", ["run", "build"]);
	if (build.exitCode !== 0) return { ok: false, build, error: build.stderr || build.stdout };
	let git:
		| {
				commit?: Awaited<ReturnType<typeof runProcess>>;
				push?: Awaited<ReturnType<typeof runProcess>>;
		  }
		| undefined;
	if (ctx.commit) {
		await runProcess(ctx.seriesRepo, "git", ["add", "."]);
		const commitResult = await runProcess(ctx.seriesRepo, "git", [
			"commit",
			"-m",
			"Publish OMG book studio artifacts",
		]);
		git = { commit: commitResult };
		if (ctx.push) git = { ...git, push: await runProcess(ctx.seriesRepo, "git", ["push"]) };
	}
	const result = {
		ok: true,
		build,
		git,
		decision: decision(
			ctx,
			`publish-${Date.now()}`,
			"Validated, built, and prepared static book data for publication.",
			["dist/book-graph.json", "dist/reader-manifest.json", "dist/library-index.json"],
			"continue",
		),
	};
	const report = await writeStageReport(ctx, result);
	return { ...result, report };
}

async function nextChapterId(ctx: StageContext): Promise<string> {
	const book = await readJson<{ chapter_ids?: string[] }>(repoPath(ctx.seriesRepo, `books/${ctx.bookId}/book.json`));
	const max = Math.max(
		0,
		...(book.chapter_ids ?? []).map(id => Number(id.match(/chapter-(\d+)/)?.[1] ?? 0)).filter(Number.isFinite),
	);
	return `chapter-${String(max + 1).padStart(3, "0")}`;
}

function stageForQualityGate(gateId: string | undefined): OmgBookAction {
	const stageForGate: Record<string, OmgBookAction> = {
		research_domains: "research-dossier",
		maturity_research_domains: "research-dossier",
		visual_language: "research-dossier",
		lore_canon_nodes: "expand-world",
		maturity_lore_canon_nodes: "expand-world",
		major_places: "expand-world",
		maturity_major_places: "expand-world",
		factions_or_institutions: "expand-world",
		maturity_factions_or_institutions: "expand-world",
		character_sheets: "expand-characters",
		maturity_character_sheets: "expand-characters",
		relationships: "expand-characters",
		maturity_relationships: "expand-characters",
		timeline_events: "expand-timeline",
		maturity_timeline_events: "expand-timeline",
		active_plot_threads: "plan-arc",
		maturity_active_plot_threads: "plan-arc",
	};
	return gateId ? (stageForGate[gateId] ?? "repair") : "studio-assess";
}

function normalizeNextStage(value: string | undefined): OmgBookAction | undefined {
	if (!value) return undefined;
	const map: Record<string, OmgBookAction> = {
		"expand-world": "expand-world",
		"expand-characters": "expand-characters",
		"expand-timeline": "expand-timeline",
		"research-dossier": "research-dossier",
		"plan-arc": "plan-arc",
		repair: "repair",
		review: "review",
		"generate-art": "generate-art",
		"plan-chapter": "plan-chapter",
		"draft-chapter": "draft-chapter",
	};
	return map[value];
}

async function readQuality(ctx: StageContext): Promise<{
	status?: string;
	gates?: Array<{ id: string; passed: boolean }>;
	maturityScore?: number;
	editorialAssessment?: { next_stage?: string; ready_for_drafting?: boolean; decision?: string } | null;
}> {
	return await readJson<{
		status?: string;
		gates?: Array<{ id: string; passed: boolean }>;
		maturityScore?: number;
		editorialAssessment?: { next_stage?: string; ready_for_drafting?: boolean; decision?: string } | null;
	}>(repoPath(ctx.seriesRepo, "dist/quality-report.json")).catch(() => ({ status: "unknown", gates: [] }));
}

async function autopilot(ctx: StageContext): Promise<StageResult> {
	const chapterId = ctx.chapterId === "next" ? await nextChapterId(ctx) : ctx.chapterId;
	if (ctx.workflow === "studio") {
		const stages: Array<Record<string, unknown>> = [];
		const qualityTrend: Array<Record<string, unknown>> = [];
		let failures = 0;
		const preflight = await publish({ ...ctx, action: "publish", chapterId, commit: false, push: false });
		stages.push({ action: "publish-preflight", ...preflight });
		for (let index = 0; index < ctx.maxStagesPerCycle; index++) {
			const quality = await readQuality({ ...ctx, chapterId });
			const failedGate = quality.gates?.find(gate => !gate.passed);
			const assessment = await readJson<{ decision?: string; next_stage?: string; ready_for_drafting?: boolean }>(
				repoPath(ctx.seriesRepo, "quality/studio-editorial-assessment.json"),
			).catch(() => undefined);
			qualityTrend.push({
				index,
				status: quality.status,
				maturityScore: quality.maturityScore,
				failedGate: failedGate?.id,
				editorialDecision: assessment?.decision ?? quality.editorialAssessment?.decision,
				editorialNextStage: assessment?.next_stage ?? quality.editorialAssessment?.next_stage,
				readyForDrafting: assessment?.ready_for_drafting ?? quality.editorialAssessment?.ready_for_drafting,
			});
			const assessedNext = normalizeNextStage(assessment?.next_stage ?? quality.editorialAssessment?.next_stage);
			let stage = failedGate ? stageForQualityGate(failedGate.id) : (assessedNext ?? "studio-assess");
			if (
				stage === "draft-chapter" &&
				!(assessment?.ready_for_drafting ?? quality.editorialAssessment?.ready_for_drafting)
			)
				stage = "studio-assess";
			if (stage === "generate-art") {
				const target = await findNextCanonArtTarget({ ...ctx, chapterId, action: "generate-art" });
				if (!target) {
					stages.push({
						action: "generate-art",
						ok: true,
						note: "all approved canon art targets already have approved assets",
					});
					break;
				}
			}
			const stageResult = await runStage({ ...ctx, action: stage, chapterId });
			stages.push({ action: stage, ...stageResult });
			if (!stageResult.ok) {
				failures++;
				if (failures >= ctx.maxFailuresPerCycle) break;
				continue;
			}
			if (stage === "studio-assess" && !assessedNext) break;
		}
		const finalPublish =
			failures < ctx.maxFailuresPerCycle ? await publish({ ...ctx, action: "publish", chapterId }) : undefined;
		if (finalPublish) stages.push({ action: "publish", ...finalPublish });
		const latestQuality = await readQuality({ ...ctx, chapterId });
		return {
			ok: Boolean(preflight.ok && failures < ctx.maxFailuresPerCycle && (finalPublish?.ok ?? true)),
			chapterId,
			qualityStatus: latestQuality.status,
			failures,
			maxFailuresPerCycle: ctx.maxFailuresPerCycle,
			maxStagesPerCycle: ctx.maxStagesPerCycle,
			qualityTrend,
			stages,
			error:
				(stages.find(stage => (stage as { ok?: unknown }).ok === false) as { error?: string } | undefined)?.error ??
				finalPublish?.error,
		};
	}
	const stages: OmgBookAction[] = ["plan-chapter", "draft-chapter"];
	if (ctx.creativeMode === "illustrated") stages.push("generate-art");
	const results: StageResult[] = [];
	for (const action of stages) {
		const stageCtx = { ...ctx, action, chapterId };
		const result = await runStage(stageCtx);
		results.push({ action, ...result });
		if (!result.ok) return { ok: false, chapterId, stages: results, error: result.error };
	}
	const publishResult = await publish({ ...ctx, action: "publish", chapterId });
	results.push({ action: "publish", ...publishResult });
	return { ok: publishResult.ok, chapterId, stages: results, error: publishResult.error };
}

async function watchdog(ctx: StageContext): Promise<StageResult> {
	const build = await runProcess(ctx.seriesRepo, "bun", ["run", "build"]);
	const quality = await readQuality(ctx);
	const status = await runProcess(ctx.seriesRepo, "git", ["status", "--short"]);
	const rateLimit = await runProcess(path.resolve(ctx.seriesRepo, "..", ".."), "uv", [
		"run",
		"chatgpt",
		"rate-limit",
		"status",
		"--json",
	]).catch(error => ({
		stdout: "",
		stderr: error instanceof Error ? error.message : String(error),
		exitCode: 1,
	}));
	const runFiles = await Array.fromAsync(
		new Bun.Glob("runs/*.json").scan({ cwd: ctx.seriesRepo, onlyFiles: true }),
	).catch(() => []);
	const recentRuns = runFiles.sort().slice(-12);
	const failedGates = quality.gates?.filter(gate => !gate.passed).map(gate => gate.id) ?? [];
	const findings = [
		build.exitCode === 0 ? "book data build is healthy" : "book data build is failing",
		status.stdout.trim() ? "series repo has uncommitted changes" : "series repo worktree is clean",
		...(failedGates.length
			? [`quality gates failing: ${failedGates.join(", ")}`]
			: ["quality gates pass structurally"]),
		rateLimit.exitCode === 0 ? "ChatGPT rate-limit status reachable" : "ChatGPT rate-limit status unavailable",
	];
	const payload = {
		schema_version: "omg.book.watchdog_report.v1",
		generated_at: new Date().toISOString(),
		ok: build.exitCode === 0,
		series_repo: ctx.seriesRepo,
		quality_status: quality.status ?? "unknown",
		maturity_score: quality.maturityScore ?? null,
		failed_gates: failedGates,
		git_dirty: Boolean(status.stdout.trim()),
		recent_runs: recentRuns,
		findings,
		chatgpt_rate_limit: {
			ok: rateLimit.exitCode === 0,
			stdout: rateLimit.stdout.trim().slice(0, 4000),
			stderr: rateLimit.stderr.trim().slice(0, 4000),
		},
		build: {
			exitCode: build.exitCode,
			stdout: build.stdout.trim().slice(0, 8000),
			stderr: build.stderr.trim().slice(0, 8000),
		},
	};
	const report = path.join(ctx.seriesRepo, "runs", `watchdog-${Date.now()}.json`);
	await writeJson(report, payload);
	return {
		ok: build.exitCode === 0,
		report,
		health: payload,
		error: build.exitCode === 0 ? undefined : build.stderr || build.stdout,
	};
}

export default class OmgBook extends Command {
	static description = "Run OMG multi-book planning, drafting, validation, art, and publishing workflows";

	static args = {
		action: Args.string({ description: "OMG book action", required: false, options: ACTIONS }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		"series-repo": Flags.string({
			description: "Path to an omg-data-* series repository",
			default: path.resolve(process.cwd(), "..", "wiki-runtime-v1", "omg-data-lantern-archive"),
		}),
		"book-id": Flags.string({ description: "Book id for book/chapter workflows", default: "ember-gate" }),
		"chapter-id": Flags.string({ description: "Chapter id, or next for autopilot", default: "chapter-001" }),
		check: Flags.boolean({ description: "Validate only; do not rebuild dist artifacts for the plan action" }),
		commit: Flags.boolean({ description: "For publish/autopilot, commit generated changes after build" }),
		push: Flags.boolean({ description: "For publish/autopilot, push after commit" }),
		researcher: Flags.string({
			description: "Worker backend: local or chatgpt",
			default: "local",
			options: ["local", "chatgpt"],
		}),
		soul: Flags.string({ description: "Soul id or SOUL.md path" }),
		"soul-repo": Flags.string({ description: "Soul repository path" }),
		"creative-mode": Flags.string({
			description: "Creative output mode",
			default: "off",
			options: ["off", "illustrated"],
		}),
		"model-option": Flags.string({ description: "ChatGPT model option", default: "Thinking" }),
		"thinking-option": Flags.string({ description: "ChatGPT thinking option", default: "Heavy" }),
		"worker-timeout-seconds": Flags.string({ description: "ChatGPT worker watch timeout", default: "1800" }),
		workflow: Flags.string({
			description: "Workflow label: foundation, chapter, revise, or publish",
			default: "foundation",
		}),
		"max-context-mb": Flags.string({
			description: "Maximum context package size for worker uploads",
			default: "128",
		}),
		"max-failures-per-cycle": Flags.string({
			description: "Maximum failed stages before a studio autopilot cycle stops",
			default: "2",
		}),
		"max-stages-per-cycle": Flags.string({
			description: "Maximum development stages a studio autopilot cycle may run",
			default: "3",
		}),
		"art-target-node": Flags.string({
			description: "Optional graph node id for generate-art, for example character:mira-vale",
		}),
	};

	static examples = [
		"# Validate and build the Lantern Archive planning graph\n  omg omg-book plan --series-repo D:\\Users\\steve\\Documents\\gpt-cli\\wiki-runtime-v1\\omg-data-lantern-archive --json",
		"# Run a full local illustrated chapter proof\n  omg omg-book autopilot --chapter-id next --creative-mode illustrated --json",
		"# Run the ChatGPT-backed chapter planner\n  omg omg-book plan-chapter --researcher chatgpt --soul lantern --soul-repo D:\\Users\\steve\\Documents\\gpt-cli\\wiki-runtime-v1\\omg-souls --chapter-id chapter-002 --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(OmgBook);
		const action = args.action as OmgBookAction | undefined;
		if (!action) {
			renderCommandHelp("omg", "omg-book", OmgBook);
			return;
		}
		const ctx: StageContext = {
			action,
			seriesRepo: path.resolve(String(flags["series-repo"])),
			bookId: String(flags["book-id"]),
			chapterId: String(flags["chapter-id"]),
			researcher: String(flags.researcher) as Researcher,
			creativeMode: String(flags["creative-mode"]) as CreativeMode,
			soul: flags.soul ? String(flags.soul) : undefined,
			soulRepo: flags["soul-repo"] ? path.resolve(String(flags["soul-repo"])) : undefined,
			modelOption: String(flags["model-option"]),
			thinkingOption: String(flags["thinking-option"]),
			commit: Boolean(flags.commit),
			push: Boolean(flags.push),
			maxContextMb: Number(flags["max-context-mb"]),
			workerTimeoutSeconds: Number(flags["worker-timeout-seconds"]),
			workflow: String(flags.workflow),
			json: Boolean(flags.json),
			maxFailuresPerCycle: Number(flags["max-failures-per-cycle"]),
			maxStagesPerCycle: Number(flags["max-stages-per-cycle"]),
			artTargetNode: flags["art-target-node"] ? String(flags["art-target-node"]) : undefined,
		};
		if (ctx.artTargetNode) {
			const [kind, id] = ctx.artTargetNode.split(":");
			ctx.artTargetSlug = slugify(id || ctx.artTargetNode);
			ctx.artTargetLabel = id || ctx.artTargetNode;
			ctx.artTargetType =
				kind === "character" ? "character" : kind === "place" ? "location" : kind === "lore" ? "item" : undefined;
		}
		let result: StageResult & {
			stdout?: string;
			stderr?: string;
			exitCode?: number;
			counts?: Record<string, unknown>;
		};
		if (action === "plan") {
			const proc = await runProcess(ctx.seriesRepo, "bun", flags.check ? ["run", "test"] : ["run", "build"]);
			result = {
				ok: proc.exitCode === 0,
				mode: flags.check ? "check" : "build",
				counts: parseCounts(proc.stdout),
				stdout: proc.stdout.trim(),
				stderr: proc.stderr.trim(),
				exitCode: proc.exitCode,
			};
		} else if (action === "publish") {
			result = await publish(ctx);
		} else if (action === "autopilot") {
			result = await autopilot(ctx);
		} else if (action === "watchdog") {
			result = await watchdog(ctx);
		} else {
			result = await runStage(ctx);
		}
		const payload = {
			schemaVersion: "omg.book.plan_run.v3",
			action,
			seriesRepo: ctx.seriesRepo,
			workflow: String(flags.workflow),
			researcher: ctx.researcher,
			creativeMode: ctx.creativeMode,
			maxContextMb: ctx.maxContextMb,
			maxFailuresPerCycle: ctx.maxFailuresPerCycle,
			maxStagesPerCycle: ctx.maxStagesPerCycle,
			...result,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else if (payload.ok) {
			process.stdout.write(`omg-book ${action} ok\n`);
		} else {
			process.stderr.write(String(payload.error || payload.stderr || "omg-book failed"));
		}
		if (!payload.ok) process.exit(1);
	}
}
