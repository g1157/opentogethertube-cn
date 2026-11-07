import fs from "node:fs";
import path from "node:path";

const commit = process.argv[2] ?? process.env.GIT_COMMIT ?? "";
if (!commit) {
	console.error("usage: node scripts/check-client-revision.mjs <commit>");
	process.exit(2);
}

const ENTRY_BUNDLE = /^index-.*\.js$/;
const assets = path.join("client", "dist", "assets");
const bundles = fs.existsSync(assets)
	? fs.readdirSync(assets).filter(name => ENTRY_BUNDLE.test(name))
	: [];
if (bundles.length !== 1) {
	console.error(`expected exactly one client entry bundle in ${assets}, found ${bundles.length}`);
	process.exit(1);
}

const bundle = path.join(assets, bundles[0]);
const text = fs.readFileSync(bundle, "utf8");
const quoted = [`revision:\`${commit}\``, `revision:"${commit}"`, `revision:'${commit}'`];
if (!quoted.some(value => text.includes(value))) {
	console.error(
		`${bundle} does not carry revision ${commit}; a stale client/dist would make every ` +
			`loaded client report a new version forever`,
	);
	process.exit(1);
}
console.log(`client bundle revision matches ${commit}`);
