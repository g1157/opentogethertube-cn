/// <reference types="vitest" />
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "ts-out"],
		pool: "forks",
		setupFiles: ["./tests/unit/jest.setup.redis-mock.js"],
		coverage: {
			exclude: [
				...(configDefaults.coverage.exclude ?? []),
				"config/**",
				"migrations/**",
				"**/tests/**",
				"**/common/**",
				"**/*.spec-d.ts",
				// Compiled output of `tsc`; a stale copy used to crash the coverage
				// conversion (its source maps point at files that no longer exist).
				"ts-out",
				"ts-out/**",
			],
		},
		typecheck: {
			enabled: true,
			include: ["**/*.spec-d.ts"],
		},
	},
});
