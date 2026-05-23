import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-gpt/gpt-utils/dirs";

let fflateModulePromise: Promise<typeof import("fflate")> | undefined;
function loadFflate(): Promise<typeof import("fflate")> {
	if (!fflateModulePromise) fflateModulePromise = import("fflate");
	return fflateModulePromise;
}

const REQUIRED_SKILL_FILES = ["SKILL.md"];

export interface ChatGptSkillValidation {
	ok: boolean;
	skillDir: string;
	findings: string[];
	files: string[];
}

export function getChatGptSkillsRoot(cwd: string = getProjectDir()): string {
	return path.join(cwd, ".omg", "chatgpt-skills");
}

export function getChatGptSkillDir(skill: string, cwd?: string): string {
	return path.join(getChatGptSkillsRoot(cwd), skill);
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(root, absolute)));
		} else if (entry.isFile()) {
			files.push(path.relative(root, absolute).replace(/\\/g, "/"));
		}
	}
	return files.sort();
}

export async function validateChatGptSkill(skill: string, cwd?: string): Promise<ChatGptSkillValidation> {
	const skillDir = getChatGptSkillDir(skill, cwd);
	const findings: string[] = [];
	const exists = await fs
		.stat(skillDir)
		.then(s => s.isDirectory())
		.catch(() => false);
	if (!exists) {
		return { ok: false, skillDir, findings: [`missing skill directory: ${skillDir}`], files: [] };
	}
	const files = await walkFiles(skillDir);
	for (const required of REQUIRED_SKILL_FILES) {
		if (!files.includes(required)) findings.push(`missing required file: ${required}`);
	}
	const skillMd = path.join(skillDir, "SKILL.md");
	const content = await fs.readFile(skillMd, "utf8").catch(() => "");
	if (!/^---\s*$/m.test(content)) findings.push("SKILL.md should include frontmatter");
	if (!/expected output|output format|json/i.test(content)) {
		findings.push("SKILL.md should describe the expected structured output format");
	}
	if (!/validation|acceptance|checks/i.test(content)) {
		findings.push("SKILL.md should include validation notes or acceptance checks");
	}
	return { ok: findings.length === 0, skillDir, findings, files };
}

export async function bundleChatGptSkill(
	skill: string,
	options: { cwd?: string; outDir?: string } = {},
): Promise<{ zipPath: string; validation: ChatGptSkillValidation }> {
	const validation = await validateChatGptSkill(skill, options.cwd);
	if (!validation.ok) {
		throw new Error(`ChatGPT skill ${skill} is invalid:\n${validation.findings.join("\n")}`);
	}
	const entries: Record<string, Uint8Array> = {};
	for (const file of validation.files) {
		entries[file] = new Uint8Array(await Bun.file(path.join(validation.skillDir, file)).arrayBuffer());
	}
	const outDir = options.outDir ?? path.join(getChatGptSkillsRoot(options.cwd), "bundles");
	await fs.mkdir(outDir, { recursive: true });
	const zipPath = path.join(outDir, `${skill}.oai.zip`);
	const { zipSync } = await loadFflate();
	await Bun.write(zipPath, zipSync(entries));
	return { zipPath, validation };
}
