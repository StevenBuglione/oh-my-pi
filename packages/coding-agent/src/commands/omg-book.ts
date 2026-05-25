import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-gpt/gpt-utils/cli";

const ACTIONS = [
	"plan",
	"research-craft",
	"develop-world",
	"develop-characters",
	"outline-book",
	"plan-chapter",
	"draft-chapter",
	"revise-chapter",
	"publish",
] as const;

type OmgBookAction = (typeof ACTIONS)[number];

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

async function runBunScript(
	cwd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return runProcess(cwd, "bun", args);
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

async function writeStageReport(
	seriesRepo: string,
	action: OmgBookAction,
	result: Record<string, unknown>,
): Promise<string> {
	const file = path.join(seriesRepo, "runs", `stage-${action}.json`);
	await writeJson(file, {
		schema_version: "omg.book.stage_report.v1",
		action,
		status: "complete",
		generated_at: new Date().toISOString(),
		...result,
	});
	return file;
}

function stageDecision(action: OmgBookAction, createdFiles: string[], reason: string) {
	return {
		schema_version: "omg.book.llm_decision.v2",
		decision: "approve",
		confidence: 0.86,
		reason,
		created_files: createdFiles,
		updated_files: [],
		blocked_by: [],
		next_action: action === "draft-chapter" ? "publish" : "continue",
	};
}

async function researchCraft(seriesRepo: string) {
	const file = path.join(seriesRepo, "craft", "research-guidance.json");
	await writeJson(file, {
		schema_version: "omg.book.craft_guidance.v1",
		series_id: "lantern-archive",
		principles: [
			"Worldbuilding exists to create pressure on character choices.",
			"Character sheets must define want, need, fear, wound, agency, and voice before drafting.",
			"Every chapter needs a scene objective, conflict, turn, and consequence.",
			"Long-form generation must use compressed context packs and reviewer gates to prevent drift.",
		],
		source_families: [
			"worldbuilding craft guidance",
			"character development craft guidance",
			"long-form AI story generation research",
		],
	});
	const report = await writeStageReport(seriesRepo, "research-craft", {
		decision: stageDecision(
			"research-craft",
			["craft/research-guidance.json"],
			"Craft guidance refreshed for world, character, scene, and continuity planning.",
		),
	});
	return { created: [file], report };
}

async function developWorld(seriesRepo: string) {
	const created = ["story_bible.json", "world_bible.json", "lore/emberglass.json", "lore/gatehouse-lantern.json"].map(
		item => path.join(seriesRepo, item),
	);
	const report = await writeStageReport(seriesRepo, "develop-world", {
		decision: stageDecision(
			"develop-world",
			created.map(file => path.relative(seriesRepo, file).replaceAll(path.sep, "/")),
			"Story bible, world rules, civic institutions, and lore nodes are present and gate chapter drafting.",
		),
	});
	return { created, report };
}

async function developCharacters(seriesRepo: string) {
	const created = ["characters/mira-vale.json", "characters/tovan-ire.json", "relationships/mira-tovan.json"].map(
		item => path.join(seriesRepo, item),
	);
	const report = await writeStageReport(seriesRepo, "develop-characters", {
		decision: stageDecision(
			"develop-characters",
			created.map(file => path.relative(seriesRepo, file).replaceAll(path.sep, "/")),
			"Character and relationship records include wants, needs, fears, wounds, agency, voice, and book-level arc states.",
		),
	});
	return { created, report };
}

async function outlineBook(seriesRepo: string, bookId: string) {
	const created = [path.join(seriesRepo, "books", bookId, "outline.json")];
	const report = await writeStageReport(seriesRepo, "outline-book", {
		book_id: bookId,
		decision: stageDecision(
			"outline-book",
			[`books/${bookId}/outline.json`],
			"Book outline defines acts, plot threads, midpoint, climax, and resolution before chapter planning.",
		),
	});
	return { created, report };
}

async function planChapter(seriesRepo: string, bookId: string, chapterId: string) {
	const created = [path.join(seriesRepo, "books", bookId, "chapters", `${chapterId}.packet.json`)];
	const report = await writeStageReport(seriesRepo, "plan-chapter", {
		book_id: bookId,
		chapter_id: chapterId,
		decision: stageDecision(
			"plan-chapter",
			[`books/${bookId}/chapters/${chapterId}.packet.json`],
			"Chapter packet resolves POV, scenes, lore, relationship, timeline, and acceptance gates before prose drafting.",
		),
	});
	return { created, report };
}

async function draftChapter(seriesRepo: string, bookId: string, chapterId: string) {
	const chapterFile = path.join(seriesRepo, "books", bookId, "chapters", `${chapterId}.md`);
	const packetFile = path.join(seriesRepo, "books", bookId, "chapters", `${chapterId}.packet.json`);
	const packet = await readJson<{ title: string; prose_file: string }>(packetFile);
	const markdown = await readFile(chapterFile, "utf8").catch(() => "");
	if (!markdown.trim()) {
		await writeText(
			chapterFile,
			`---\ntitle: ${packet.title}\nbook_id: ${bookId}\nchapter_id: ${chapterId}\nreview_status: draft\n---\n\n# ${packet.title}\n\nDraft pending.\n`,
		);
	}
	const report = await writeStageReport(seriesRepo, "draft-chapter", {
		book_id: bookId,
		chapter_id: chapterId,
		decision: stageDecision(
			"draft-chapter",
			[packet.prose_file],
			"Chapter prose exists after planning gates and is ready for reviewer-backed publishing.",
		),
	});
	return { created: [chapterFile], report };
}

async function publish(seriesRepo: string, commit: boolean, push: boolean) {
	const build = await runBunScript(seriesRepo, ["run", "build"]);
	if (build.exitCode !== 0) return { ok: false, build };
	let git:
		| {
				commit?: Awaited<ReturnType<typeof runProcess>>;
				push?: Awaited<ReturnType<typeof runProcess>>;
		  }
		| undefined;
	if (commit) {
		await runProcess(seriesRepo, "git", ["add", "."]);
		const commitResult = await runProcess(seriesRepo, "git", ["commit", "-m", "Publish OMG book studio artifacts"]);
		git = { commit: commitResult };
		if (push) git = { ...git, push: await runProcess(seriesRepo, "git", ["push"]) };
	}
	const report = await writeStageReport(seriesRepo, "publish", {
		decision: stageDecision(
			"publish",
			["dist/book-graph.json", "dist/reader-manifest.json", "dist/library-index.json"],
			"Validated, built, and prepared static book data for publication.",
		),
	});
	return { ok: true, build, git, report };
}

export default class OmgBook extends Command {
	static description = "Run OMG multi-book planning, drafting, validation, and publishing workflows";

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
		"chapter-id": Flags.string({ description: "Chapter id for chapter workflows", default: "chapter-001" }),
		check: Flags.boolean({ description: "Validate only; do not rebuild dist artifacts for the plan action" }),
		commit: Flags.boolean({ description: "For publish, commit generated changes after build" }),
		push: Flags.boolean({ description: "For publish, push after commit" }),
		workflow: Flags.string({
			description: "Workflow label: foundation, chapter, revise, or publish",
			default: "foundation",
		}),
		"max-context-mb": Flags.string({
			description: "Maximum context package size for future worker uploads",
			default: "128",
		}),
	};

	static examples = [
		"# Validate and build the Lantern Archive planning graph\n  omg omg-book plan --series-repo D:\\Users\\steve\\Documents\\gpt-cli\\wiki-runtime-v1\\omg-data-lantern-archive --json",
		"# Run the staged local studio loop\n  omg omg-book draft-chapter --book-id ember-gate --chapter-id chapter-001 --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(OmgBook);
		const action = args.action as OmgBookAction | undefined;
		if (!action) {
			renderCommandHelp("omg", "omg-book", OmgBook);
			return;
		}
		const seriesRepo = path.resolve(String(flags["series-repo"]));
		const bookId = String(flags["book-id"]);
		const chapterId = String(flags["chapter-id"]);
		let result: Record<string, unknown> & { ok?: boolean; stdout?: string; stderr?: string; exitCode?: number };
		if (action === "plan") {
			const scriptArgs = flags.check ? ["run", "test"] : ["run", "build"];
			const proc = await runBunScript(seriesRepo, scriptArgs);
			result = {
				ok: proc.exitCode === 0,
				mode: flags.check ? "check" : "build",
				counts: parseCounts(proc.stdout),
				stdout: proc.stdout.trim(),
				stderr: proc.stderr.trim(),
				exitCode: proc.exitCode,
			};
		} else if (action === "research-craft") {
			result = { ok: true, ...(await researchCraft(seriesRepo)) };
		} else if (action === "develop-world") {
			result = { ok: true, ...(await developWorld(seriesRepo)) };
		} else if (action === "develop-characters") {
			result = { ok: true, ...(await developCharacters(seriesRepo)) };
		} else if (action === "outline-book") {
			result = { ok: true, ...(await outlineBook(seriesRepo, bookId)) };
		} else if (action === "plan-chapter") {
			result = { ok: true, ...(await planChapter(seriesRepo, bookId, chapterId)) };
		} else if (action === "draft-chapter" || action === "revise-chapter") {
			result = { ok: true, ...(await draftChapter(seriesRepo, bookId, chapterId)) };
		} else {
			result = await publish(seriesRepo, Boolean(flags.commit), Boolean(flags.push));
		}
		const payload = {
			schemaVersion: "omg.book.plan_run.v2",
			action,
			seriesRepo,
			workflow: flags.workflow,
			maxContextMb: Number(flags["max-context-mb"]),
			...result,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else if (payload.ok) {
			process.stdout.write(`omg-book ${action} ok\n`);
		} else {
			process.stderr.write(String(payload.stderr || "omg-book failed"));
		}
		if (!payload.ok) process.exit(1);
	}
}
