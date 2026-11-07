import type {
	AccessContext,
	InferenceRequest,
	SearchDeps,
	SearchOptions,
	SearchRequest,
} from "../../contracts/index.js";
import {
	fragmentTextOf,
	inferenceOk,
	makeDoc,
	makeEnv,
	syncAll,
	type Env,
} from "../harness.fixture.js";
import { createVectorIndex, search } from "./index.js";

/** Topic words of the test embedding: a text maps to the unit vector of the first one it holds. */
export const TOPICS = ["alpha", "bravo", "charlie", "delta"] as const;

export function topicVector(text: string): number[] {
	const lower = text.toLowerCase();
	const hits = TOPICS.map((t) => lower.indexOf(t));
	let best = -1;
	for (let i = 0; i < hits.length; i++) {
		if (hits[i]! >= 0 && (best < 0 || hits[i]! < hits[best]!)) best = i;
	}
	return TOPICS.map((_, i) => (i === best ? 1 : best < 0 ? 0.01 : 0));
}

/**
 * An answer with one entity named after the first 6 characters of the fragment and one relation
 * between it and a second entity (the next 6), so that the mention routes have something to find.
 */
export function mentionAnswer(request: InferenceRequest): string {
	const chars = [...fragmentTextOf(request)];
	const a = chars.slice(0, 6).join("");
	const b = chars.slice(6, 12).join("");
	if (a.trim().length === 0 || b.trim().length === 0) {
		return JSON.stringify({ entities: [], relations: [] });
	}
	return JSON.stringify({
		entities: [
			{
				id: "e1",
				name: `name-${a}`,
				type: "thing",
				description: `about ${a}`,
				evidence: [a],
			},
			{
				id: "e2",
				name: `name-${b}`,
				type: "thing",
				description: `about ${b}`,
				evidence: [b],
			},
		],
		relations: [
			{
				id: "r1",
				source: "e1",
				target: "e2",
				directed: false,
				relation: `links-${a}`,
				description: `${a} to ${b}`,
				keywords: [`kw-${b}`],
				qualifiers: { negated: false, condition: null, certainty: "stated" },
				evidence: [`${a}${b}`],
			},
		],
	});
}

export const ACCESS: AccessContext = { principal: "p", namespaces: ["wiki"] };
export const HOUR = 3_600_000;

export type SearchEnv = Env & {
	vectors: ReturnType<typeof createVectorIndex>;
	deps: SearchDeps;
	run: (
		request: SearchRequest,
		options?: Partial<SearchOptions>,
		access?: AccessContext,
		signal?: AbortSignal,
	) => ReturnType<typeof search>;
};

/** An ingest environment whose embedding is `topicVector` and whose extraction is `mentionAnswer`. */
export function makeSearchEnv(): SearchEnv {
	const env = makeEnv();
	env.inference.script = (request) => inferenceOk(mentionAnswer(request));
	env.embedding.mutate = (answer, call) => ({
		space: answer.space,
		vectors: env.embedding.calls[call - 1]!.texts.map(topicVector),
	});
	const vectors = createVectorIndex();
	const deps: SearchDeps = {
		read: (operation) => env.db.transaction(() => operation(env.db))(),
		embedding: env.embedding,
		vectors,
		clock: env.clock,
		options: { verifiedWithinMs: HOUR },
	};
	return {
		...env,
		vectors,
		deps,
		run: (request, options = {}, access = ACCESS, signal) =>
			search(
				{ ...deps, options: { ...deps.options, ...options } },
				access,
				request,
				signal ?? new AbortController().signal,
			),
	};
}

/** Put documents in the source and ingest them all (documents are numbered from 1). */
export async function ingestAll(
	env: Env,
	docs: readonly { n: number; markdown: string; namespace?: string }[],
): Promise<void> {
	for (const d of docs) {
		env.source.put(
			makeDoc(d.n, d.markdown, d.namespace ? { namespace: d.namespace } : {}),
		);
	}
	await syncAll(env);
}
