/**
 * Show what the read tool will return for a given path.
 */
import { Args, Command } from "@oh-my-gpt/gpt-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path or URL";

	static args = {
		path: Args.string({
			description: "Path or URL to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"omg read src/foo.ts",
		"omg read src/foo.ts:50-100",
		"omg read src/foo.ts:raw",
		"omg read https://example.com",
		"omg read path/to/archive.zip:dir/file.ts",
		"omg read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
