import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { resolveImageRelease } from "../image-release-policy.mjs";

const INVALID_IMAGE_TAG = /Docker image tag/;
const INVALID_COMMIT = /full Git commit/;
const LATEST_NOT_PROMOTED = /promote_latest=false/;

const commit = "a".repeat(40);
const release = overrides =>
	resolveImageRelease({
		eventName: "push",
		refType: "tag",
		refName: "v1.4.20",
		commit,
		tags: ["v1.4.9", "v1.4.19", "v1.4.20"],
		defaultBranchContainsCommit: true,
		...overrides,
	});

it("the highest stable tag in default branch history can promote latest", () => {
	assert.equal(release({}).promoteLatest, true);
});

for (const refType of ["tag", "branch"]) {
	it("manual " + refType + " builds never promote latest", () => {
		assert.equal(release({ eventName: "workflow_dispatch", refType }).promoteLatest, false);
	});
}

it("branch pushes use revision-specific edge tags without changing latest", () => {
	assert.deepEqual(release({ refType: "branch", refName: "feature/player" }), {
		version: "edge-aaaaaaaaaaaa",
		promoteLatest: false,
		reason: "not-a-tag-push",
	});
});

it("re-pushing an old stable version cannot roll back latest", () => {
	assert.equal(release({ refName: "v1.4.9" }).promoteLatest, false);
});

it("stable version comparison is numerical rather than lexical", () => {
	assert.equal(release({ refName: "v1.4.10", tags: ["v1.4.9", "v1.4.10"] }).promoteLatest, true);
	assert.equal(release({ tags: ["v1.4.20", "v2.0.0"] }).promoteLatest, false);
});

for (const refName of ["v2.0.0-rc.1", "v1.4.020", "vdev"]) {
	it("non-stable tag " + refName + " never promotes latest", () => {
		assert.equal(release({ refName, tags: [refName] }).promoteLatest, false);
	});
}

it("a tag outside default branch history cannot promote latest", () => {
	assert.equal(release({ defaultBranchContainsCommit: false }).promoteLatest, false);
});

it("incomplete tag discovery fails closed", () => {
	assert.equal(release({ tags: ["v1.4.19"] }).promoteLatest, false);
});

it("prerelease tags do not block the highest stable version", () => {
	assert.equal(release({ tags: ["v1.4.20", "v2.0.0-rc.1"] }).promoteLatest, true);
});

it("unsafe image tags and non-commit revisions are rejected", () => {
	assert.throws(() => release({ refName: "v1.4.20\nversion=latest" }), INVALID_IMAGE_TAG);
	assert.throws(() => release({ refName: "v1.4.20+build" }), INVALID_IMAGE_TAG);
	assert.throws(() => release({ commit: "HEAD" }), INVALID_COMMIT);
});

it("CLI checks real Git ancestry, peeled tags and the output consumed by Actions", () => {
	const prefix = path.join(os.tmpdir(), "ott-image-release-");
	const directory = fs.mkdtempSync(prefix);
	const script = fileURLToPath(new URL("../image-release-policy.mjs", import.meta.url));
	const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
	try {
		git("init", "--quiet", "--initial-branch=main");
		git("config", "user.name", "Release policy test");
		git("config", "user.email", "release-policy@example.invalid");
		git("commit", "--quiet", "--allow-empty", "-m", "initial");
		git("tag", "-a", "v1.4.20", "-m", "stable");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		const output = path.join(directory, "outputs");
		const run = eventName => {
			fs.writeFileSync(output, "");
			const result = spawnSync(process.execPath, [script], {
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_EVENT_NAME: eventName,
					GITHUB_REF_TYPE: "tag",
					GITHUB_REF_NAME: "v1.4.20",
					DEFAULT_BRANCH: "main",
					GITHUB_OUTPUT: output,
				},
			});
			assert.equal(result.status, 0, result.stderr);
			return fs.readFileSync(output, "utf8");
		};
		assert.equal(run("push"), "version=v1.4.20\npromote_latest=true\n");
		assert.match(run("workflow_dispatch"), LATEST_NOT_PROMOTED);
		git("tag", "v1.4.21");
		assert.match(run("push"), LATEST_NOT_PROMOTED);
		git("tag", "--delete", "v1.4.21");
		git("checkout", "--quiet", "--orphan", "unrelated");
		git("commit", "--quiet", "--allow-empty", "-m", "unrelated");
		git("tag", "--force", "v1.4.20");
		assert.match(run("push"), LATEST_NOT_PROMOTED);
	} finally {
		// Verify the generated temporary target before any recursive cleanup on Windows.
		assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
		assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
