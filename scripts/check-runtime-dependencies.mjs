import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const root = path.resolve(
	args.find(argument => !argument.startsWith("--")) ?? path.join(import.meta.dirname, ".."),
);
const require = createRequire(path.join(root, "server", "package.json"));
const lock = readFileSync(path.join(root, "yarn.lock"), "utf8");
const lockedVersions = new Map();
let descriptors = [];
for (const line of lock.split("\n")) {
	if (line.startsWith('"') && line.endsWith(":")) {
		descriptors = JSON.parse(line.slice(0, -1)).split(", ");
	} else if (line.startsWith("  version: ")) {
		const version = line.slice("  version: ".length).replaceAll('"', "").trim();
		for (const descriptor of descriptors) {
			lockedVersions.set(descriptor, version);
		}
	} else if (line && !line.startsWith(" ")) {
		descriptors = [];
	}
}

function installedVersion(name) {
	let directory;
	try {
		directory = path.dirname(require.resolve(`${name}/package.json`));
	} catch {
		directory = path.dirname(require.resolve(name));
	}
	while (directory !== path.dirname(directory)) {
		const file = path.join(directory, "package.json");
		if (existsSync(file)) {
			const manifest = JSON.parse(readFileSync(file, "utf8"));
			if (manifest.name === name) {
				return manifest.version;
			}
		}
		directory = path.dirname(directory);
	}
	throw new Error(`Cannot locate the runtime manifest for ${name}`);
}

const manifest = JSON.parse(readFileSync(path.join(root, "server", "package.json"), "utf8"));
const resolutions = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).resolutions;
const versions = {};
for (const [name, range] of Object.entries(manifest.dependencies)) {
	if (range.startsWith("workspace:")) {
		continue;
	}
	const descriptor = `${name}@npm:${range}`;
	const override = resolutions?.[descriptor];
	const candidates = override
		? [...lockedVersions.entries()].filter(
				([key]) => key === `${name}@${override}` || key.startsWith(`${name}@${override}::`),
			)
		: [[descriptor, lockedVersions.get(descriptor)]];
	const expected = candidates.length === 1 ? candidates[0][1] : undefined;
	if (!expected) {
		throw new Error(`Missing lockfile entry for ${name}@${range}`);
	}
	const actual = installedVersion(name);
	if (actual !== expected) {
		throw new Error(`${name}: runtime ${actual} differs from locked ${expected}`);
	}
	versions[name] = actual;
}

const rateLimiter = require("rate-limiter-flexible");
if (
	typeof rateLimiter.RateLimiterAbstract !== "function" ||
	typeof rateLimiter.RateLimiterStoreAbstract !== "function"
) {
	throw new Error("The locked rate-limiter-flexible patch is missing from the runtime");
}

let runtimeFiles;
if (args.includes("--image")) {
	if (process.getuid?.() === 0) {
		throw new Error("The application image must run as an unprivileged user");
	}
	const allowed = {
		"": [
			"node_modules",
			"package.json",
			"yarn.lock",
			"server",
			"common",
			"client",
			"scripts",
			"LICENSE",
			"UPSTREAM.md",
		],
		server: [
			"package.json",
			"node_modules",
			"ts-out",
			"config",
			"migrations",
			".sequelizerc",
			"import-room-state.mjs",
		],
		common: ["package.json", "node_modules", "ts-out"],
		client: ["dist"],
	};
	for (const [directory, names] of Object.entries(allowed)) {
		for (const name of readdirSync(path.join(root, directory))) {
			if (!names.includes(name)) {
				throw new Error(`Unexpected application image file: ${path.join(directory, name)}`);
			}
		}
	}
	runtimeFiles = {};
	const inspect = directory => {
		let files = 0;
		for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
			if (
				entry.name === "tests" ||
				entry.name === "fixtures" ||
				entry.name.includes(".spec.")
			) {
				throw new Error(
					`Test artifact remains in the runtime: ${path.join(directory, entry.name)}`,
				);
			}
			files += entry.isDirectory() ? inspect(path.join(directory, entry.name)) : 1;
		}
		return files;
	};
	for (const directory of [
		"server/ts-out",
		"common/ts-out",
		"server/migrations",
		"client/dist",
	]) {
		runtimeFiles[directory] = inspect(directory);
	}
}

// Keep the known remotely reachable issue fixed even if a future lockfile regresses.
const minimums = { ws: "7.5.11", sequelize: "6.37.8" };
for (const [name, minimum] of Object.entries(minimums)) {
	const actual = versions[name].split(".").map(Number);
	const floor = minimum.split(".").map(Number);
	const difference = actual.findIndex((part, index) => part !== floor[index]);
	if (difference >= 0 && actual[difference] < floor[difference]) {
		throw new Error(`${name}: runtime version must be at least ${minimum}`);
	}
}

for (const name of ["xmldom", "@liveinstantly/dash-mpd-parser"]) {
	try {
		require.resolve(name);
	} catch (error) {
		if (error.code === "MODULE_NOT_FOUND") {
			continue;
		}
		throw error;
	}
	throw new Error(`Obsolete DASH parser remains in the runtime: ${name}`);
}

console.log(
	JSON.stringify({
		node: process.version,
		uid: process.getuid?.(),
		lockSha256: createHash("sha256").update(lock).digest("hex"),
		patchedRateLimiter: true,
		runtimeFiles,
		versions,
	}),
);
