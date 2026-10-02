import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { main } from "../src/main";
import {
	type AssetDownloader,
	acquireUpdateLock,
	CORE_BINARIES,
	isNewer,
	KNOWN_BINARIES,
	parseUpdateArgs,
	type ReleaseFetcher,
	type ReleaseInfo,
	releaseAssetName,
	releaseRepo,
	releaseVersion,
	renderUpdate,
	resolveBinDir,
	runUpdate,
	selectReleaseAsset,
	UPDATE_USAGE,
	type UpdateDeps,
} from "../src/update";

const DARWIN_ASSET = "gajaeway-darwin-arm64.tar.gz";

function release(tag: string, assetNames: readonly string[]): ReleaseInfo {
	return {
		tag,
		assets: assetNames.map((name) => ({ name, url: `https://example.com/releases/${tag}/${name}` })),
	};
}

/** A staged binary the size checks accept; the bytes identify it in assertions. */
async function stagedBinary(dir: string, name: string, marker: string): Promise<void> {
	await writeFile(join(dir, name), `${marker}\n${"x".repeat(1_100_000)}`);
}

const noBytes: AssetDownloader = async () => new Uint8Array(0);

/** Stages the given binaries the way a real tarball extraction would. */
function extractorFor(binaries: readonly { name: string; marker: string }[]): UpdateDeps["extractTarball"] {
	return async (_tarball, intoDir) => {
		for (const binary of binaries) await stagedBinary(intoDir, binary.name, binary.marker);
	};
}

interface Recording {
	readonly downloads: string[];
	readonly restarts: string[];
}

function recorder(): Recording {
	const downloads: string[] = [];
	const restarts: string[] = [];
	return { downloads, restarts };
}

describe("update arguments", () => {
	test("defaults to a real update with restarts", () => {
		expect(parseUpdateArgs([])).toEqual({ check: false, force: false, noRestart: false });
	});

	test("accepts every documented flag", () => {
		expect(parseUpdateArgs(["--check", "--force", "--no-restart", "--bin-dir", "/opt/gajaeway"])).toEqual({
			check: true,
			force: true,
			noRestart: true,
			binDir: "/opt/gajaeway",
		});
	});

	test("refuses unknown flags and empty --bin-dir values with the usage", () => {
		expect(() => parseUpdateArgs(["--wat"])).toThrow(UPDATE_USAGE);
		expect(() => parseUpdateArgs(["--wat"])).toThrow("unknown option: --wat");
		expect(() => parseUpdateArgs(["--bin-dir"])).toThrow("--bin-dir expects a non-empty DIR");
		expect(() => parseUpdateArgs(["--bin-dir", "--check"])).toThrow("--bin-dir expects a non-empty DIR");
	});
});

describe("update release metadata", () => {
	test("accepts v-prefixed, plain, and prerelease tags; refuses anything else", () => {
		expect(releaseVersion("v0.1.2")).toBe("0.1.2");
		expect(releaseVersion("0.1.2")).toBe("0.1.2");
		expect(releaseVersion("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
		expect(releaseVersion("v0.1")).toBeUndefined();
		expect(releaseVersion("release-2026")).toBeUndefined();
	});

	test("selects this platform's tarball and nothing else", () => {
		expect(releaseAssetName("darwin", "arm64")).toBe(DARWIN_ASSET);
		const info = release("v0.2.0", ["gajaeway-linux-x64.tar.gz", DARWIN_ASSET]);
		expect(selectReleaseAsset(info, DARWIN_ASSET)?.name).toBe(DARWIN_ASSET);
		expect(selectReleaseAsset(info, "gajaeway-win32-x64.tar.gz")).toBeUndefined();
	});

	test("only a strictly newer release counts", () => {
		expect(isNewer("0.1.2", "0.1.3")).toBe(true);
		expect(isNewer("0.1.2", "0.1.2")).toBe(false);
		expect(isNewer("0.1.3", "0.1.2")).toBe(false);
		expect(isNewer("0.1.3", "0.1.3-rc.1")).toBe(false);
	});

	test("the repo default comes from the package declaration; the env override wins", () => {
		expect(releaseRepo({})).toBe("Yeachan-Heo/gajae-way");
		expect(releaseRepo({ GAJAEWAY_UPDATE_REPO: "VC-Kyeongmin/gajae-way" })).toBe("VC-Kyeongmin/gajae-way");
		expect(releaseRepo({ GAJAEWAY_UPDATE_REPO: "  " })).toBe("Yeachan-Heo/gajae-way");
	});
});

describe("update bin dir resolution", () => {
	test("a compiled gajaeway binary names its own directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gajaeway-update-bindir-"));
		try {
			const binary = join(dir, "gajaeway");
			await writeFile(binary, "stub");
			expect(await resolveBinDir(undefined, binary)).toBe(await realpath(dir));
			expect(await resolveBinDir("/elsewhere", binary)).toBe("/elsewhere");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an interpreter exec path is not an install", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gajaeway-update-bindir-"));
		try {
			const bun = join(dir, "bun");
			await writeFile(bun, "stub");
			expect(await resolveBinDir(undefined, bun)).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runUpdate", () => {
	async function binDirWith(marker: string, binaries: readonly string[]): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "gajaeway-update-bin-"));
		for (const name of binaries) await writeFile(join(dir, name), `old-${name}`);
		if (marker !== "") await writeFile(join(dir, ".gajaeway-release"), `${marker}\n`);
		return dir;
	}

	test("--check against the running package version reads as up to date and touches nothing", async () => {
		const calls = recorder();
		const result = await runUpdate({
			args: { check: true, force: false, noRestart: false },
			home: "/tmp/unused-home",
			deps: {
				fetchLatestRelease: async () => release(`v${pkg.version}`, [DARWIN_ASSET]),
				downloadAsset: async (asset) => {
					calls.downloads.push(asset.name);
					return new Uint8Array(0);
				},
				extractTarball: async () => {
					throw new Error("check must not extract");
				},
				platform: "darwin",
				arch: "arm64",
				execPath: "/usr/local/bin/bun",
			},
		});
		expect(result).toMatchObject({ checkedOnly: true, upToDate: true, installed: [] });
		expect(calls.downloads).toHaveLength(0);
		expect(renderUpdate(result)).toEqual([`up to date: ${pkg.version} (latest release v${pkg.version})`]);
	});

	test("--check with a newer release reports availability using the installed marker", async () => {
		const dir = await binDirWith("0.1.1", []);
		try {
			const result = await runUpdate({
				args: { check: true, force: false, noRestart: false, binDir: dir },
				home: "/tmp/unused-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					platform: "darwin",
					arch: "arm64",
				},
			});
			expect(result.current).toBe("0.1.1");
			expect(result.upToDate).toBe(false);
			expect(result.checkedOnly).toBe(true);
			expect(renderUpdate(result)).toEqual(["update available: 0.1.1 → 0.2.0 (release v0.2.0)"]);
			// A check never stages, backs up, or marks anything.
			expect(await readdir(dir)).not.toContain(".gajaeway-update.lock");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an install replaces installed binaries, backs them up, marks the release, and queues the restart", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway", "gajaeway-gateway", "gajaeway-slack"]);
		const calls = recorder();
		const extractor = extractorFor(KNOWN_BINARIES.map((name) => ({ name, marker: `staged-${name}` })));
		try {
			const result = await runUpdate({
				args: { check: false, force: false, noRestart: false, binDir: dir },
				home: "/tmp/gajaeway-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					downloadAsset: async (asset) => {
						calls.downloads.push(asset.name);
						return new Uint8Array(0);
					},
					extractTarball: extractor,
					queueRestart: async (home) => {
						calls.restarts.push(home);
						return { receiptId: "r-1", supervisorPid: 42 };
					},
					platform: "darwin",
					arch: "arm64",
				},
			});
			// Adapters the host never installed stay uninstalled; the core pair is refreshed.
			expect(result.installed).toEqual(["gajaeway", "gajaeway-gateway", "gajaeway-slack"]);
			expect(result.restartQueued).toBe("r-1");
			expect(result.upToDate).toBe(false);
			expect(calls.downloads).toEqual([DARWIN_ASSET]);
			expect(calls.restarts).toEqual(["/tmp/gajaeway-home"]);
			for (const name of ["gajaeway", "gajaeway-gateway", "gajaeway-slack"]) {
				const body = await readFile(join(dir, name), "utf8");
				expect(body.startsWith(`staged-${name}\n`)).toBe(true);
				expect((await stat(join(dir, name))).mode & 0o777).toBe(0o755);
			}
			expect(await readFile(join(dir, ".gajaeway-release"), "utf8")).toBe("0.2.0\n");
			const backups = (await readdir(dir)).filter((name) => name.startsWith("backup-0.1.1-"));
			expect(backups).toHaveLength(1);
			for (const name of ["gajaeway", "gajaeway-gateway", "gajaeway-slack"])
				expect(await readFile(join(dir, backups[0], name), "utf8")).toBe(`old-${name}`);
			// No half-applied temp files or locks survive the run.
			for (const entry of await readdir(dir))
				expect(entry.startsWith(".update-") || entry === ".gajaeway-update.lock").toBe(false);
			expect(await readdir(dir)).not.toContain("gajaeway-admin");
			const lines = renderUpdate(result);
			expect(lines[0]).toBe("updated 0.1.1 → 0.2.0 from Yeachan-Heo/gajae-way (v0.2.0)");
			expect(lines[1]).toBe("installed: gajaeway, gajaeway-gateway, gajaeway-slack");
			expect(lines[2]).toBe(`backup: ${join(dir, backups[0])}`);
			expect(lines[3]).toBe("restart: queued r-1 — check with: gajaeway ops restart-stack --status");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("--no-restart replaces binaries without touching the service manager", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway", "gajaeway-gateway"]);
		const calls = recorder();
		try {
			const result = await runUpdate({
				args: { check: false, force: false, noRestart: true, binDir: dir },
				home: "/tmp/gajaeway-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					downloadAsset: noBytes,
					extractTarball: extractorFor(CORE_BINARIES.map((name) => ({ name, marker: `staged-${name}` }))),
					queueRestart: async (home) => {
						calls.restarts.push(home);
						return { receiptId: "r-1", supervisorPid: 42 };
					},
					platform: "darwin",
					arch: "arm64",
				},
			});
			expect(result.restartSkipped).toBe(true);
			expect(result.restartQueued).toBeUndefined();
			expect(calls.restarts).toHaveLength(0);
			expect(renderUpdate(result).at(-1)).toBe("restart: skipped (--no-restart)");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("--force reinstalls even when the latest release is already installed", async () => {
		const dir = await binDirWith("0.2.0", ["gajaeway", "gajaeway-gateway"]);
		try {
			const result = await runUpdate({
				args: { check: false, force: true, noRestart: true, binDir: dir },
				home: "/tmp/gajaeway-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					downloadAsset: noBytes,
					extractTarball: extractorFor(CORE_BINARIES.map((name) => ({ name, marker: `again-${name}` }))),
					platform: "darwin",
					arch: "arm64",
				},
			});
			expect(result.installed).toEqual(["gajaeway", "gajaeway-gateway"]);
			expect((await readFile(join(dir, "gajaeway"), "utf8")).startsWith("again-gajaeway\n")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("without --force an up-to-date install is a no-op", async () => {
		const dir = await binDirWith("0.2.0", ["gajaeway", "gajaeway-gateway"]);
		try {
			const result = await runUpdate({
				args: { check: false, force: false, noRestart: false, binDir: dir },
				home: "/tmp/gajaeway-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					downloadAsset: async () => {
						throw new Error("up to date must not download");
					},
					platform: "darwin",
					arch: "arm64",
				},
			});
			expect(result.upToDate).toBe(true);
			expect((await readFile(join(dir, "gajaeway"), "utf8")).startsWith("old-")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a release without this platform's asset is a hard error naming the assets", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway"]);
		try {
			await expect(
				runUpdate({
					args: { check: true, force: false, noRestart: false, binDir: dir },
					home: "/tmp/gajaeway-home",
					deps: {
						fetchLatestRelease: async () => release("v0.2.0", ["gajaeway-linux-x64.tar.gz"]),
						platform: "darwin",
						arch: "arm64",
					},
				}),
			).rejects.toThrow("has no asset gajaeway-darwin-arm64.tar.gz");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a tarball missing a core binary is refused", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway"]);
		try {
			await expect(
				runUpdate({
					args: { check: false, force: false, noRestart: false, binDir: dir },
					home: "/tmp/gajaeway-home",
					deps: {
						fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
						downloadAsset: noBytes,
						extractTarball: extractorFor([{ name: "gajaeway", marker: "staged" }]),
						platform: "darwin",
						arch: "arm64",
					},
				}),
			).rejects.toThrow("missing core binaries: gajaeway-gateway");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an undersized staged binary is treated as a broken extraction", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway", "gajaeway-gateway"]);
		try {
			await expect(
				runUpdate({
					args: { check: false, force: false, noRestart: false, binDir: dir },
					home: "/tmp/gajaeway-home",
					deps: {
						fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
						downloadAsset: noBytes,
						extractTarball: async (_tarball, intoDir) => {
							await writeFile(join(intoDir, "gajaeway"), "x");
							await writeFile(join(intoDir, "gajaeway-gateway"), "x");
						},
						platform: "darwin",
						arch: "arm64",
					},
				}),
			).rejects.toThrow("refusing a broken extraction");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a lock naming a live pid refuses a concurrent update and downloads nothing", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway", "gajaeway-gateway"]);
		await writeFile(join(dir, ".gajaeway-update.lock"), `${JSON.stringify({ pid: process.pid })}\n`);
		try {
			await expect(
				runUpdate({
					args: { check: false, force: false, noRestart: false, binDir: dir },
					home: "/tmp/gajaeway-home",
					deps: {
						fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
						downloadAsset: async () => {
							throw new Error("a fenced update must not download");
						},
						extractTarball: async () => {
							throw new Error("a fenced update must not extract");
						},
						platform: "darwin",
						arch: "arm64",
					},
				}),
			).rejects.toThrow(`pid ${process.pid}`);
			expect((await readFile(join(dir, "gajaeway"), "utf8")).startsWith("old-")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a lock naming a dead pid is stale and taken over", async () => {
		const dir = await binDirWith("0.1.1", ["gajaeway", "gajaeway-gateway"]);
		// PID 2^22-1 is outside any real pid space but parses as a number.
		await writeFile(join(dir, ".gajaeway-update.lock"), `${JSON.stringify({ pid: 4_194_303 })}\n`);
		try {
			const result = await runUpdate({
				args: { check: false, force: true, noRestart: true, binDir: dir },
				home: "/tmp/gajaeway-home",
				deps: {
					fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
					downloadAsset: noBytes,
					extractTarball: extractorFor(CORE_BINARIES.map((name) => ({ name, marker: `staged-${name}` }))),
					platform: "darwin",
					arch: "arm64",
				},
			});
			expect(result.installed).toEqual(["gajaeway", "gajaeway-gateway"]);
			expect(await readdir(dir)).not.toContain(".gajaeway-update.lock");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an install without a resolvable bin dir asks for --bin-dir instead of guessing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gajaeway-update-bunpath-"));
		try {
			const bun = join(dir, "bun");
			await writeFile(bun, "stub");
			await expect(
				runUpdate({
					args: { check: false, force: false, noRestart: true },
					home: "/tmp/gajaeway-home",
					deps: {
						fetchLatestRelease: async () => release("v0.2.0", [DARWIN_ASSET]),
						downloadAsset: noBytes,
						extractTarball: extractorFor(CORE_BINARIES.map((name) => ({ name, marker: `staged-${name}` }))),
						platform: "darwin",
						arch: "arm64",
						execPath: bun,
					},
				}),
			).rejects.toThrow("--bin-dir");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the update lock is a plain pid file that releases cleanly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gajaeway-update-lock-"));
		try {
			const unlock = await acquireUpdateLock(dir);
			expect(JSON.parse(await readFile(join(dir, ".gajaeway-update.lock"), "utf8")).pid).toBe(process.pid);
			await expect(acquireUpdateLock(dir)).rejects.toThrow(`pid ${process.pid}`);
			await unlock();
			expect(await readdir(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("update dispatch through main", () => {
	test("gajaeway update --check prints availability without a gateway socket", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (line: unknown) => output.push(String(line));
		try {
			await main(["update", "--check"], {
				update: {
					fetchLatestRelease: (async () => release("v99.0.0", [DARWIN_ASSET])) satisfies ReleaseFetcher,
					platform: "darwin",
					arch: "arm64",
					execPath: "/usr/local/bin/bun",
				},
			});
		} finally {
			console.log = originalLog;
		}
		expect(output.join("\n")).toContain("update available:");
	});

	test("an unknown update flag is refused with the usage", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: unknown) => errors.push(String(message));
		const previousExit = process.exitCode;
		try {
			await main(["update", "--wat"]);
			expect(errors.join("\n")).toContain("unknown option: --wat");
			expect(process.exitCode).toBe(1);
		} finally {
			console.error = originalError;
			process.exitCode = previousExit ?? 0;
		}
	});
});
