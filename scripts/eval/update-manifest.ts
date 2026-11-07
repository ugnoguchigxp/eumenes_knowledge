// `bun scripts/eval/update-manifest.ts`: rewrites examples/fixtures/eval/manifest.json from the
// files. A version is raised by one when its digest changed; unchanged digests keep their version.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	computeManifest,
	loadFixture,
	type FixtureManifest,
} from "./fixture.js";

export function updatedManifest(
	fixture: ReturnType<typeof loadFixture>,
): FixtureManifest {
	const previous = fixture.manifest;
	const bytes = new Uint8Array(
		readFileSync(join(fixture.dir, "extraction.json")),
	);
	const next = computeManifest(
		fixture.documents,
		bytes,
		fixture.questions,
		previous,
	);
	if (!previous) return next;
	const bump = (old: { version: number; digest: string }, now: string) =>
		old.digest === now ? old.version : old.version + 1;
	return {
		corpus: {
			...next.corpus,
			version: bump(previous.corpus, next.corpus.digest),
		},
		extraction: {
			...next.extraction,
			version: bump(previous.extraction, next.extraction.digest),
		},
		questions: {
			...next.questions,
			version: bump(previous.questions, next.questions.digest),
		},
	};
}

if (import.meta.main) {
	const fixture = loadFixture();
	const manifest = updatedManifest(fixture);
	writeFileSync(
		join(fixture.dir, "manifest.json"),
		`${JSON.stringify(manifest, null, 1)}\n`,
	);
	console.log(JSON.stringify(manifest));
}
