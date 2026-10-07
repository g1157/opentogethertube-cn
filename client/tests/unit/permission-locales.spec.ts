import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "ott-common/permissions";
import de from "@/locales/de";
import en from "@/locales/en";
import es from "@/locales/es";
import fr from "@/locales/fr";
import pirate from "@/locales/pirate";
import ptBr from "@/locales/pt-br";
import ru from "@/locales/ru";
import zhCN from "@/locales/zh-CN";

const locales: Record<string, unknown> = {
	en,
	"zh-CN": zhCN,
	de,
	es,
	fr,
	pirate,
	"pt-br": ptBr,
	ru,
};

function lookup(messages: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((node, part) => {
		if (node === null || typeof node !== "object") {
			return undefined;
		}
		return (node as Record<string, unknown>)[part];
	}, messages);
}

/**
 * Permissions are the one table every locale shows verbatim; a permission added without
 * translations silently falls back to English in seven languages.
 */
describe("permission localization", () => {
	it.each(Object.entries(locales))("labels every permission in %s", (_language, messages) => {
		const missing = PERMISSIONS.map(permission => permission.name).filter(
			name => typeof lookup(messages, `permissions.${name}`) !== "string",
		);
		expect(missing).toEqual([]);
	});

	it.each(Object.entries(locales))("labels every editor group in %s", (_language, messages) => {
		const reference = Object.keys((lookup(en, "permissions-editor.groups") ?? {}) as object);
		const groups = (lookup(messages, "permissions-editor.groups") ?? {}) as Record<
			string,
			unknown
		>;
		const missing = reference.filter(key => typeof groups[key] !== "string");
		expect(missing).toEqual([]);
		expect(typeof lookup(messages, "permissions-editor.group-count")).toBe("string");
	});
});
