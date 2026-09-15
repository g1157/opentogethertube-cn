/**
 * Session memory of which media hosts allow cross-origin reads. The server records this as
 * metadata when a link is added, and a live fallback adds the verdict for anything it did
 * not know, so a source that cannot be read cross-origin is never tried that way twice.
 */
const verdicts = new Map<string, boolean>();

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

export function rememberedCors(url: string): boolean | undefined {
	const origin = originOf(url);
	return origin ? verdicts.get(origin) : undefined;
}

export function rememberCors(url: string, allows: boolean): void {
	const origin = originOf(url);
	if (origin) {
		verdicts.set(origin, allows);
	}
}

/** Tests only: forget every verdict so a spec does not leak into the next one. */
export function forgetCorsVerdicts(): void {
	verdicts.clear();
}
