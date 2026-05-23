import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-gpt/gpt-coding-agent/capability/types";
import { getConfigDirs } from "@oh-my-gpt/gpt-coding-agent/config";
import { getUserPath } from "@oh-my-gpt/gpt-coding-agent/discovery/helpers";

describe("OMG_CONFIG_DIR", () => {
	const original = process.env.OMG_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.OMG_CONFIG_DIR;
		} else {
			process.env.OMG_CONFIG_DIR = original;
		}
	});

	test("getUserPath uses OMG_CONFIG_DIR for native userAgent", () => {
		process.env.OMG_CONFIG_DIR = ".config/omg";
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		const result = getUserPath(ctx, "native", "commands");
		expect(result).toBe(path.join(ctx.home, ".config/omg/agent", "commands"));
	});

	test("getConfigDirs respects OMG_CONFIG_DIR for user base", () => {
		process.env.OMG_CONFIG_DIR = ".config/omg";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/omg", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".omg", level: "user" });
	});
});
