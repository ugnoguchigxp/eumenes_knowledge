import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { KnowledgeError } from "../contracts/index.js";
import type { TokenizerPort } from "../contracts/ports.js";
import {
	getDocumentInTransaction,
	getPublishedVersionInSnapshot,
} from "../sqlite/index.js";
import {
	listEntityMentionsInSnapshot,
	listEvidenceInSnapshot,
	listExtractionsInSnapshot,
	listFragmentsInSnapshot,
	listRelationMentionsInSnapshot,
} from "../sqlite/reads.js";
import {
	createCharclassTokenizer,
	SAME_SENTENCE_RELATION,
} from "./extract/index.js";
import {
	docId,
	type Env,
	makeDoc,
	makeEnv,
	sha,
	syncAll,
} from "./harness.fixture.js";
import { classifyJobError, PortFailure } from "./support.js";

const key = { sourceNamespace: "docling", documentId: docId(1) };
const BODY = [
	"# Lantern の設計",
	"",
	"Lantern は MySQL を使う。Mira Okafor が書いた。",
	"詳しくは https://example.com/lantern を見る。",
	"",
	"## 運用",
	"",
	"夜間の Lantern 再起動は運用チームが見る。",
	"",
].join("\n");

/** What the published version holds: fragments, extractions, mentions and their evidence. */
function published(env: Env) {
	const v = getPublishedVersionInSnapshot(env.db, key);
	if (!v) throw new Error("not published");
	const fragments = listFragmentsInSnapshot(env.db, v.versionId);
	const entities = listEntityMentionsInSnapshot(env.db, v.versionId);
	const nameOf = (ordinal: number, localId: string) =>
		entities.find((e) => e.fragmentOrdinal === ordinal && e.localId === localId)
			?.name;
	return {
		v,
		fragments,
		extractions: listExtractionsInSnapshot(env.db, v.versionId),
		names: entities.map((e) => e.name),
		relations: listRelationMentionsInSnapshot(env.db, v.versionId).map((r) => ({
			...r,
			pair: [
				nameOf(r.fragmentOrdinal, r.sourceLocalId),
				nameOf(r.fragmentOrdinal, r.targetLocalId),
			],
		})),
		evidence: listEvidenceInSnapshot(env.db, v.versionId),
	};
}

describe("ingest with the model-free extractor (kg2.md G3)", () => {
	test("names and same-sentence relations are indexed without one model call", async () => {
		const env = makeEnv({ maxFragmentBytes: 120, extractor: "names" });
		env.source.put(makeDoc(1, BODY));
		await syncAll(env);
		expect(env.inference.calls).toHaveLength(0);

		const { v, fragments, extractions, names, relations, evidence } =
			published(env);
		expect(v).toMatchObject({ state: "published", extractionPartial: false });
		expect(fragments.length).toBeGreaterThan(1);
		// Fragments are still embedded: the related-fragment path needs them.
		expect(env.embedding.calls.flatMap((c) => c.texts)).toEqual(
			fragments.map((f) => f.text),
		);
		expect(extractions.map((x) => [x.status, x.model])).toEqual(
			fragments.map(() => ["ok", "names:charclass@rules6"]),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"Lantern",
				"MySQL",
				"Mira Okafor",
				"設計",
				"運用",
			]),
		);
		// The URL is no name.
		expect(names.some((n) => n.includes("example"))).toBe(false);

		expect(relations.map((r) => r.pair)).toEqual(
			expect.arrayContaining([
				["Lantern", "MySQL"],
				["Lantern", "再起動"],
			]),
		);
		// Mira Okafor and MySQL are written in two sentences: no relation.
		expect(
			relations.some(
				(r) => r.pair.includes("Mira Okafor") && r.pair.includes("MySQL"),
			),
		).toBe(false);
		for (const r of relations) {
			expect(r.relation).toBe(SAME_SENTENCE_RELATION);
			expect(r.directed).toBe(false);
		}

		// Every quotation is located in its fragment, as written, and hashed.
		const bytes = Buffer.from(BODY, "utf8");
		expect(evidence.length).toBeGreaterThan(names.length - 1);
		for (const e of evidence) {
			const f = fragments[e.fragmentOrdinal];
			if (!f) throw new Error("no fragment");
			expect(e.byteStart).toBeGreaterThanOrEqual(f.byteStart);
			expect(e.byteEnd).toBeLessThanOrEqual(f.byteEnd);
			expect(sha(bytes.subarray(e.byteStart, e.byteEnd))).toBe(e.quoteSha256);
		}
	});

	test("a host's tokenizer is used and named in the model; it reads the text without URLs", async () => {
		const seen: string[] = [];
		const base = createCharclassTokenizer();
		const tokenizer: TokenizerPort = {
			id: "host-analyzer",
			tokenize: (text) => {
				seen.push(text);
				return base.tokenize(text);
			},
		};
		const env = makeEnv(
			{ maxFragmentBytes: 120, extractor: "names" },
			{ tokenizer },
		);
		env.source.put(makeDoc(1, BODY));
		await syncAll(env);
		const { fragments, extractions } = published(env);
		expect(seen).toHaveLength(fragments.length);
		expect(seen.join("")).not.toContain("example.com");
		expect(new Set(extractions.map((x) => x.model))).toEqual(
			new Set(["names:host-analyzer@rules6"]),
		);
	});

	test("a tokenizer that throws is a temporary failure; nothing is published, its message is not kept", async () => {
		const tokenizer: TokenizerPort = {
			id: "broken",
			tokenize: () => {
				throw new Error("dictionary missing at SECRET-PATH");
			},
		};
		const env = makeEnv({ extractor: "names" }, { tokenizer });
		env.source.put(makeDoc(1, BODY));
		const { rest } = await syncAll(env, randomUUID(), { attempts: "once" });
		const error = rest.logs.find((l) => l.error !== undefined)?.error;
		expect(error).toBeInstanceOf(PortFailure);
		expect((error as PortFailure).port).toBe("tokenizer");
		expect(classifyJobError(error)).toBe("retry");
		expect(String(error)).not.toContain("SECRET");
		expect(JSON.stringify(env.events)).not.toContain("SECRET");
		const row = getDocumentInTransaction(env.db, key);
		expect(row?.publishedVersionId).toBeNull();
		expect(row?.transientFailures).toBe(1);
		expect(getPublishedVersionInSnapshot(env.db, key)).toBeNull();
	});

	test("tokens that do not describe the text fail their fragment alone; the version is partial", async () => {
		const base = createCharclassTokenizer();
		let call = 0;
		const tokenizer: TokenizerPort = {
			id: "flaky-contract",
			// The second fragment's tokens are shifted by one: a broken contract, not an outage.
			tokenize: (text) => {
				call += 1;
				const tokens = base.tokenize(text);
				return call === 2
					? tokens.map((t) => ({ ...t, start: t.start + 1, end: t.end + 1 }))
					: tokens;
			},
		};
		const env = makeEnv(
			{ maxFragmentBytes: 120, extractor: "names" },
			{ tokenizer },
		);
		env.source.put(makeDoc(1, BODY));
		await syncAll(env, randomUUID(), { attempts: "once" });
		const { v, extractions } = published(env);
		expect(v.extractionPartial).toBe(true);
		expect(extractions.map((x) => [x.status, x.errorCode])).toEqual(
			extractions.map((_, i) =>
				i === 1 ? ["failed", "invalid_tokens"] : ["ok", null],
			),
		);
	});

	test("an unknown extractor is refused when the handler is made", () => {
		expect(() => makeEnv({ extractor: "llm" as never })).toThrow(
			KnowledgeError,
		);
	});
});
