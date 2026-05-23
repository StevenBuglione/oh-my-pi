import * as fs from "node:fs/promises";
import { APP_NAME } from "@oh-my-gpt/gpt-utils";
import { getAgentDir } from "@oh-my-gpt/gpt-utils/dirs";
import type { Subprocess } from "bun";
import { validateChatGptSkill } from "./skills";
import { listHarnessRuns } from "./storage";
import type { HarnessDoctorCheck, HarnessDoctorResult } from "./types";

export interface HarnessCommandResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type HarnessCommandRunner = (
	command: string[],
	options?: { timeoutMs?: number },
) => Promise<HarnessCommandResult>;

const REQUIRED_LIVE_SKILLS = ["artifact-builder", "critic-review"];

export const defaultHarnessCommandRunner: HarnessCommandRunner = async (command, options = {}) => {
	let proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		proc = Bun.spawn(command, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...Bun.env, COLUMNS: Bun.env.COLUMNS ?? "10000", FORCE_COLOR: "0" },
		});
		timeout = options.timeoutMs
			? setTimeout(() => {
					proc?.kill();
				}, options.timeoutMs)
			: undefined;
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exitCode === 0, exitCode, stdout, stderr };
	} catch (error) {
		return { ok: false, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

function check(
	id: string,
	label: string,
	ok: boolean,
	blocking: boolean,
	summary: string,
	details?: unknown,
): HarnessDoctorCheck {
	return { id, label, ok, blocking, summary, details };
}

async function checkCdp(endpoint: string): Promise<HarnessDoctorCheck> {
	try {
		const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) {
			return check("chrome_cdp", "Chrome CDP", false, true, `CDP returned HTTP ${response.status}`);
		}
		const data = await response.json().catch(() => ({}));
		return check("chrome_cdp", "Chrome CDP", true, true, "Chrome remote debugging endpoint is reachable", data);
	} catch (error) {
		return check(
			"chrome_cdp",
			"Chrome CDP",
			false,
			true,
			"Could not reach http://127.0.0.1:9222; start Chrome with remote debugging before live harness runs",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function runHarnessDoctor(
	options: { cwd?: string; cdp?: string; runner?: HarnessCommandRunner; requireLive?: boolean } = {},
): Promise<HarnessDoctorResult> {
	const cwd = options.cwd ?? process.cwd();
	const runner = options.runner ?? defaultHarnessCommandRunner;
	const checks: HarnessDoctorCheck[] = [];

	const agentDir = getAgentDir();
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await fs.access(agentDir);
	checks.push(check("agent_dir", "Harness run root", true, true, `Writable agent root: ${agentDir}`));

	checks.push(
		check(
			"omg_runtime",
			"OMG runtime",
			APP_NAME === "omg",
			false,
			APP_NAME === "omg"
				? "Running as omg"
				: `Running as ${APP_NAME}; native omg binary not required for source tests`,
			{ execPath: process.execPath },
		),
	);

	const omgCommand = process.env.OMG_COMPILED === "true" ? [process.execPath, "--version"] : ["omg", "--version"];
	const omgVersion = await runner(omgCommand, { timeoutMs: 10_000 });
	checks.push(
		check(
			"omg_bin",
			"Native OMG binary",
			omgVersion.ok,
			true,
			omgVersion.ok ? "Native omg executable is available" : "Native omg executable failed or is missing",
			{ exitCode: omgVersion.exitCode, stderr: omgVersion.stderr },
		),
	);

	const chatgptHelp = await runner(["chatgpt", "--help"], { timeoutMs: 10_000 });
	checks.push(
		check(
			"chatgpt_bin",
			"ChatGPT CLI",
			chatgptHelp.ok,
			true,
			chatgptHelp.ok ? "Global chatgpt executable is available" : "Global chatgpt executable failed or is missing",
			{ exitCode: chatgptHelp.exitCode, stderr: chatgptHelp.stderr },
		),
	);

	const artifactHelp = await runner(["chatgpt", "--headless", "--help"], { timeoutMs: 10_000 });
	const artifactHelpText = `${artifactHelp.stdout}\n${artifactHelp.stderr}`;
	checks.push(
		check(
			"artifact_download",
			"Artifact download support",
			artifactHelp.ok && artifactHelpText.includes("--download-artifacts"),
			true,
			artifactHelp.ok && artifactHelpText.includes("--download-artifacts")
				? "ChatGPT CLI exposes --download-artifacts"
				: "ChatGPT CLI does not expose artifact download support",
			{ exitCode: artifactHelp.exitCode, stderr: artifactHelp.stderr },
		),
	);

	checks.push(await checkCdp(options.cdp ?? "http://127.0.0.1:9222"));

	const workers = await runner(["chatgpt", "workers", "list", "--json"], { timeoutMs: 15_000 });
	checks.push(
		check(
			"workers",
			"ChatGPT workers",
			workers.ok,
			true,
			workers.ok ? "Worker registry is reachable" : "Worker registry is not reachable; sign in and rerun doctor",
			{ exitCode: workers.exitCode, stderr: workers.stderr },
		),
	);

	const staleRuns = (await listHarnessRuns()).filter(run => {
		if (run.status !== "active" && run.status !== "blocked") return false;
		if (Date.now() - Date.parse(run.updatedAt) < 60 * 60 * 1000) return false;
		return run.workers.some(worker => worker.workerId);
	});
	checks.push(
		check(
			"stale_workers",
			"Stale harness workers",
			staleRuns.length === 0,
			false,
			staleRuns.length === 0
				? "No stale harness workers found"
				: `${staleRuns.length} active/blocked run(s) older than 1 hour have recorded workers; consider omg harness cleanup --stale`,
			{ runIds: staleRuns.map(run => run.runId) },
		),
	);

	for (const skill of REQUIRED_LIVE_SKILLS) {
		const validation = await validateChatGptSkill(skill, cwd);
		checks.push(
			check(
				`skill_${skill}`,
				`Skill ${skill}`,
				validation.ok,
				true,
				validation.ok ? `Valid ChatGPT skill: ${skill}` : validation.findings.join("; "),
				{ skillDir: validation.skillDir },
			),
		);
	}

	return {
		ok: checks.every(item => item.ok || !item.blocking || !options.requireLive),
		checks,
	};
}
