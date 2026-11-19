import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function stableVersion(tag) {
	const match = STABLE_VERSION.exec(tag);
	return match ? match.slice(1).map(value => BigInt(value)) : null;
}

function newerVersion(left, right) {
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) {
			return left[index] > right[index];
		}
	}
	return false;
}

/** Only a new stable tag in the default branch history may move the deployment alias. */
export function resolveImageRelease({
	eventName,
	refType,
	refName,
	commit,
	tags,
	defaultBranchContainsCommit,
}) {
	if (!COMMIT.test(commit)) {
		throw new Error("A full Git commit ID is required for an image release");
	}
	const version = refType === "tag" ? refName : "edge-" + commit.slice(0, 12);
	if (!IMAGE_TAG.test(version)) {
		throw new Error("Release ref is not a valid Docker image tag");
	}
	const result = reason => ({ version, promoteLatest: false, reason });
	if (eventName !== "push" || refType !== "tag") {
		return result("not-a-tag-push");
	}
	const candidate = stableVersion(refName);
	if (!candidate) {
		return result("not-a-stable-version");
	}
	if (defaultBranchContainsCommit !== true) {
		return result("outside-default-branch-history");
	}
	if (!tags.includes(refName)) {
		return result("release-tag-not-fetched");
	}
	for (const tag of tags) {
		const other = stableVersion(tag);
		if (other && newerVersion(other, candidate)) {
			return result("newer-stable-tag-exists");
		}
	}
	return { version, promoteLatest: true, reason: "latest-stable-default-branch-release" };
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
	const {
		GITHUB_EVENT_NAME: eventName,
		GITHUB_REF_TYPE: refType,
		GITHUB_REF_NAME: refName,
		DEFAULT_BRANCH: defaultBranch,
	} = process.env;
	if (!eventName || !refType || !refName || !defaultBranch) {
		throw new Error("GitHub event, ref and repository default branch are required");
	}
	const commit = git("rev-parse", "--verify", "HEAD^{commit}");
	const defaultRef = "refs/remotes/origin/" + defaultBranch;
	git("check-ref-format", defaultRef);
	git("rev-parse", "--verify", defaultRef + "^{commit}");
	if (
		refType === "tag" &&
		git("rev-parse", "--verify", "refs/tags/" + refName + "^{commit}") !== commit
	) {
		throw new Error("Checked-out commit does not match the release tag");
	}
	const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", commit, defaultRef], {
		encoding: "utf8",
	});
	if (ancestry.error || (ancestry.status !== 0 && ancestry.status !== 1)) {
		throw ancestry.error ?? new Error("Cannot establish release ancestry: " + ancestry.stderr);
	}
	const policy = resolveImageRelease({
		eventName,
		refType,
		refName,
		commit,
		tags: git("tag", "--list").split("\n").filter(Boolean),
		defaultBranchContainsCommit: ancestry.status === 0,
	});
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			"version=" + policy.version + "\npromote_latest=" + policy.promoteLatest + "\n",
		);
	}
	console.log(JSON.stringify(policy));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
