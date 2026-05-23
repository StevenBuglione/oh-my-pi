import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, getLegacyAgentDbPath, getReadableAgentDbPath, setAgentDir } from "../src/dirs";
import { Snowflake } from "../src/snowflake";

describe("legacy credential fallback paths", () => {
	let tempRoot = "";
	let originalAgentDir = "";
	let originalHome = "";
	let originalUserProfile = "";

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalHome = process.env.HOME ?? "";
		originalUserProfile = process.env.USERPROFILE ?? "";
		tempRoot = path.join(os.tmpdir(), "omg-legacy-credentials", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
		process.env.HOME = tempRoot;
		process.env.USERPROFILE = tempRoot;
		setAgentDir(path.join(tempRoot, ".omg", "agent"));
	});

	afterEach(async () => {
		if (originalHome) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("prefers the primary .omg agent database when present", async () => {
		const primary = getAgentDbPath();
		await fs.mkdir(path.dirname(primary), { recursive: true });
		await Bun.write(primary, "");

		expect(getReadableAgentDbPath()).toBe(primary);
	});

	it("falls back to legacy .omp agent database only when primary is absent", async () => {
		const legacy = getLegacyAgentDbPath();
		await fs.mkdir(path.dirname(legacy), { recursive: true });
		await Bun.write(legacy, "");

		expect(getReadableAgentDbPath()).toBe(legacy);
	});
});
