import {
	CONTRACT_VERSION,
	KnowledgeError,
	SEARCH_LIMITS,
	SOURCE_NAMESPACE_DOCLING,
	embeddingSpaceKey,
	searchRequestSchema,
	searchPartialReasons,
	searchResponseSchema,
	searchRoutes,
	type AccessContext,
	type EmbeddingPort,
	type EmbeddingSpace,
	type ParsedSearchRequest,
	type Search,
	type SearchHit,
	type SearchOptions,
	type SearchResponse,
	type SearchRoute,
	type Tx,
	type VectorIndex,
} from "../../contracts/index.js";
import {
	MAX_SEARCH_LIMIT,
	searchFragmentsInSnapshot,
} from "../../sqlite/reads.js";
import {
	countSearchableFragmentsInSnapshot,
	readSearchCoverageInSnapshot,
	readSearchableFragmentsInSnapshot,
	scanFragmentsInSnapshot,
	scanMentionsInSnapshot,
	searchMentionsInSnapshot,
	type FragmentRef,
	type MentionHit,
	type MentionKind,
	type SearchableFragment,
} from "../../sqlite/search.js";
import { normalizeForSearch } from "../text/normalize.js";
import { fuseRanks } from "./fusion.js";
import { searchVectorIndexInSnapshot } from "./vector-index.js";

/**
 * Search (p3.md §3). Every path is a mechanical match (string containment, inner product) and the
 * paths are merged by rank alone. No branch depends on what a query means.
 *
 * Order of work: validate; embed the query (outside any snapshot, so no snapshot is held open
 * across an await); then one synchronous read of one snapshot does every route, the fusion, the
 * fragments' text and the coverage, so all of them describe the same state of the index.
 *
 * A cancelled `signal` stops the search by throwing the signal's reason (an `AbortError` for a
 * plain `abort()`), never by returning a partial answer: whoever aborted is no longer waiting.
 * `deadline_exceeded` is reported only when the query embedding hits its own time limit (which
 * leaves the vector route failed and the rest of the answer intact).
 */

export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 2500;
/** Normalized queries shorter than this (in characters) cannot use the trigram index. */
export const MIN_TRIGRAM_CHARS = 3;

type ResolvedOptions = {
	candidates: number;
	embeddingTimeoutMs: number;
	maxResponseBytes: number;
	substringScanMaxFragments: number;
	verifiedWithinMs: number;
	maxUnappliedAttempts: number | undefined;
};

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;

function resolveOptions(o: SearchOptions): ResolvedOptions {
	const r: ResolvedOptions = {
		candidates: o.candidatesPerRoute ?? SEARCH_LIMITS.candidatesPerRoute,
		embeddingTimeoutMs:
			o.queryEmbeddingTimeoutMs ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS,
		maxResponseBytes: o.maxResponseBytes ?? SEARCH_LIMITS.responseBytes,
		substringScanMaxFragments: o.substringScanMaxFragments ?? 50_000,
		verifiedWithinMs: o.verifiedWithinMs,
		maxUnappliedAttempts: o.maxUnappliedAttempts,
	};
	if (
		// One more than this is read to see whether the route was cut.
		!isInt(r.candidates, 1, MAX_SEARCH_LIMIT - 1) ||
		!isInt(r.embeddingTimeoutMs, 1) ||
		!isInt(r.maxResponseBytes, 0) ||
		!isInt(r.substringScanMaxFragments, 0) ||
		typeof r.verifiedWithinMs !== "number" ||
		!Number.isFinite(r.verifiedWithinMs) ||
		r.verifiedWithinMs < 0 ||
		(r.maxUnappliedAttempts !== undefined && !isInt(r.maxUnappliedAttempts, 1))
	) {
		throw new KnowledgeError("invalid_input");
	}
	return r;
}

// ---------------------------------------------------------------------------
// The query embedding
// ---------------------------------------------------------------------------

type QueryVector =
	| { ok: true; vector: Float32Array; space: EmbeddingSpace; key: string }
	| {
			ok: false;
			reason: "embedding_failed" | "embedding_timeout" | "dimension_mismatch";
	  };

const isSpace = (s: unknown): s is EmbeddingSpace => {
	const x = s as Partial<EmbeddingSpace> | null;
	return (
		typeof x === "object" &&
		x !== null &&
		typeof x.modelId === "string" &&
		typeof x.revision === "string" &&
		typeof x.artifactDigest === "string" &&
		typeof x.queryPrefix === "string" &&
		typeof x.passagePrefix === "string" &&
		isInt(x.dimension, 1)
	);
};

async function embedQuery(
	embedding: EmbeddingPort,
	query: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<QueryVector> {
	signal.throwIfAborted();
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			resolve("timeout");
			controller.abort();
		}, timeoutMs);
	});
	const aborted = new Promise<"aborted">((resolve) => {
		if (signal.aborted) resolve("aborted");
		else
			signal.addEventListener("abort", () => resolve("aborted"), {
				once: true,
			});
	});
	try {
		// The port may ignore its signal; the race gives the limit regardless.
		const call = (async () => {
			try {
				return {
					ok: true as const,
					answer: await embedding.embed([query], "query", controller.signal),
				};
			} catch {
				return { ok: false as const };
			}
		})();
		const first = await Promise.race([call, expired, aborted]);
		signal.throwIfAborted();
		if (first === "timeout") {
			return { ok: false, reason: "embedding_timeout" };
		}
		if (first === "aborted" || !first.ok) {
			return { ok: false, reason: "embedding_failed" };
		}
		const { vectors, space } = first.answer ?? {};
		if (!isSpace(space) || !Array.isArray(vectors) || vectors.length !== 1) {
			return { ok: false, reason: "embedding_failed" };
		}
		const v: unknown = vectors[0];
		if (!Array.isArray(v) && !(v instanceof Float32Array)) {
			return { ok: false, reason: "embedding_failed" };
		}
		if (v.length !== space.dimension) {
			return { ok: false, reason: "dimension_mismatch" };
		}
		const vector = new Float32Array(v.length);
		for (let i = 0; i < v.length; i++) {
			const x = v[i];
			if (typeof x !== "number" || !Number.isFinite(x)) {
				return { ok: false, reason: "embedding_failed" };
			}
			vector[i] = x;
			if (!Number.isFinite(vector[i]!)) {
				return { ok: false, reason: "embedding_failed" };
			}
		}
		return { ok: true, vector, space, key: embeddingSpaceKey(space) };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Routes (each runs inside the snapshot)
// ---------------------------------------------------------------------------

type RouteRun = {
	route: SearchRoute;
	status: "ok" | "skipped" | "failed";
	reason: string | null;
	/** Fragments, best first. */
	refs: FragmentRef[];
	/** More matched than the route may return. */
	exhausted: boolean;
	/** The route's matches, by fragment key (entity and relation routes). */
	mentions?: Map<string, MentionHit[]>;
};

const refKey = (r: FragmentRef): string => `${r.versionId}:${r.ordinal}`;

const emptyRun = (
	route: SearchRoute,
	status: "skipped" | "failed",
	reason: string,
): RouteRun => ({ route, status, reason, refs: [], exhausted: false });

function runMentionRoute(
	db: Tx,
	kind: MentionKind,
	query: string,
	short: boolean,
	scanAllowed: boolean,
	candidates: number,
	namespaces: readonly string[],
): RouteRun {
	const route = kind;
	if (short && !scanAllowed)
		return emptyRun(route, "skipped", "query_too_short");
	const hits = short
		? scanMentionsInSnapshot(db, kind, query, candidates + 1, namespaces)
		: searchMentionsInSnapshot(db, kind, query, candidates + 1, namespaces);
	const exhausted = hits.length > candidates;
	const used = hits.slice(0, candidates);
	const refs: FragmentRef[] = [];
	const mentions = new Map<string, MentionHit[]>();
	for (const h of used) {
		const ref = { versionId: h.versionId, ordinal: h.fragmentOrdinal };
		const key = refKey(ref);
		const list = mentions.get(key);
		if (list) list.push(h);
		else {
			mentions.set(key, [h]);
			refs.push(ref);
		}
	}
	return { route, status: "ok", reason: null, refs, exhausted, mentions };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

function emptyResponse(
	routes: readonly SearchRoute[],
	reason: string,
): SearchResponse {
	return {
		contractVersion: CONTRACT_VERSION,
		results: [],
		lexicalMode: "none",
		routes: routes.map((route) => ({
			route,
			status: "skipped" as const,
			reason,
			candidates: 0,
		})),
		coverage: {
			documents: 0,
			searchable: 0,
			stale: 0,
			unavailable: 0,
			failed: 0,
			extractionIncomplete: 0,
		},
		complete: false,
		// Nothing the caller may read is in scope: there is nothing to claim a result about.
		partialReasons: ["unavailable_documents"],
	};
}

/** The namespaces searched: the caller's own, narrowed (never widened) by the request. */
function scopeOf(
	access: AccessContext,
	request: ParsedSearchRequest,
): string[] {
	const own = new Set(access.namespaces);
	const wanted = request.namespaces ? new Set(request.namespaces) : null;
	return [...own].filter((n) => wanted === null || wanted.has(n));
}

export const search: Search = async (deps, access, request, signal) => {
	const parsedRequest = searchRequestSchema.safeParse(request);
	if (!parsedRequest.success) throw new KnowledgeError("invalid_input");
	const req = parsedRequest.data;
	const opts = resolveOptions(deps.options);
	if (
		!access ||
		!Array.isArray(access.namespaces) ||
		access.namespaces.some((n) => typeof n !== "string")
	) {
		throw new KnowledgeError("invalid_input");
	}
	signal.throwIfAborted();
	const startedAt = deps.clock.now();

	const wanted = new Set(req.routes ?? searchRoutes);
	const routes = searchRoutes.filter((r) => wanted.has(r));
	const namespaces = scopeOf(access, req);
	if (namespaces.length === 0)
		return finish(emptyResponse(routes, "no_namespaces"));

	// 1. The query embedding, before and outside the snapshot.
	const queryVector = wanted.has("vector")
		? await embedQuery(
				deps.embedding,
				req.query,
				opts.embeddingTimeoutMs,
				signal,
			)
		: null;
	signal.throwIfAborted();

	// 2. One snapshot: every route, the fusion, the text and the coverage.
	const response = deps.read((db) =>
		searchInSnapshot(db, deps.vectors, deps.clock.now(), {
			req,
			opts,
			routes,
			namespaces,
			queryVector,
		}),
	);
	signal.throwIfAborted();

	deps.events?.({
		type: "knowledge.search",
		level: "info",
		fields: {
			results: response.results.length,
			complete: response.complete,
			vector:
				response.routes.find((r) => r.route === "vector")?.status ?? "off",
			durationMs: Math.max(0, deps.clock.now() - startedAt),
		},
	});
	return finish(response);
};

/** The one place an answer leaves: it must satisfy the contract. */
function finish(response: SearchResponse): SearchResponse {
	const checked = searchResponseSchema.safeParse(response);
	if (!checked.success) throw new KnowledgeError("contract_mismatch");
	return checked.data;
}

type SnapshotInput = {
	req: ParsedSearchRequest;
	opts: ResolvedOptions;
	routes: readonly SearchRoute[];
	namespaces: readonly string[];
	queryVector: QueryVector | null;
};

function searchInSnapshot(
	db: Tx,
	vectors: VectorIndex,
	now: number,
	{ req, opts, routes, namespaces, queryVector }: SnapshotInput,
): SearchResponse {
	const normalized = normalizeForSearch(req.query);
	const short = [...normalized].length < MIN_TRIGRAM_CHARS;
	const K = opts.candidates;
	const reasons = new Set<SearchResponse["partialReasons"][number]>();

	const registry = readSearchCoverageInSnapshot(db, namespaces, now, {
		verifiedWithinMs: opts.verifiedWithinMs,
		maxUnappliedAttempts: opts.maxUnappliedAttempts,
	});
	for (const r of registry.partialReasons) reasons.add(r);

	const needsScanBound =
		short &&
		routes.some((r) => r === "text" || r === "entity" || r === "relation");
	const searchableFragments =
		needsScanBound || routes.includes("vector")
			? countSearchableFragmentsInSnapshot(db, namespaces)
			: 0;
	const scanAllowed = searchableFragments <= opts.substringScanMaxFragments;

	let lexicalMode: SearchResponse["lexicalMode"] = "none";
	const runs: RouteRun[] = [];
	for (const route of routes) {
		if (route === "text") {
			if (short && !scanAllowed) {
				runs.push(emptyRun(route, "skipped", "query_too_short"));
				continue;
			}
			lexicalMode = short ? "substring_scan" : "trigram";
			const refs = short
				? scanFragmentsInSnapshot(db, req.query, K + 1, namespaces)
				: searchFragmentsInSnapshot(db, req.query, K + 1, namespaces);
			runs.push({
				route,
				status: "ok",
				reason: null,
				refs: refs.slice(0, K).map((h) => ({
					versionId: h.versionId,
					ordinal: h.ordinal,
				})),
				exhausted: refs.length > K,
			});
		} else if (route === "vector") {
			runs.push(
				runVectorRoute(
					db,
					vectors,
					queryVector,
					namespaces,
					K,
					searchableFragments,
					reasons,
				),
			);
		} else {
			runs.push(
				runMentionRoute(
					db,
					route,
					req.query,
					short,
					scanAllowed,
					K,
					namespaces,
				),
			);
		}
	}
	if (runs.some((r) => r.exhausted)) reasons.add("route_budget_exhausted");
	// A route that did not run for this query leaves part of the index unread (p0.md 6.1).
	if (runs.some((r) => r.status === "skipped")) reasons.add("route_skipped");

	// Fusion by rank, then the fragments of the best `limit`.
	const fused = fuseRanks(runs.map((r) => r.refs.map(refKey))).slice(
		0,
		req.limit,
	);
	const refByKey = new Map<string, FragmentRef>();
	for (const run of runs)
		for (const ref of run.refs) refByKey.set(refKey(ref), ref);
	const fragments = readSearchableFragmentsInSnapshot(
		db,
		fused.map((f) => refByKey.get(f.key)!),
		namespaces,
	);
	const byKey = new Map<string, SearchableFragment>(
		fragments.map((f) => [`${f.versionId}:${f.ordinal}`, f]),
	);

	const results: SearchHit[] = [];
	let bytes = 0;
	for (const item of fused) {
		const f = byKey.get(item.key);
		if (!f) continue; // no longer readable in this snapshot: never returned
		const size = utf8Length(f.text);
		if (bytes + size > opts.maxResponseBytes) {
			reasons.add("response_truncated");
			break;
		}
		bytes += size;
		const unverified =
			f.lastVerifiedAt === null ||
			f.lastVerifiedAt < now - opts.verifiedWithinMs;
		results.push({
			rank: results.length + 1,
			sourceNamespace: f.sourceNamespace as typeof SOURCE_NAMESPACE_DOCLING,
			documentId: f.documentId,
			namespace: f.namespace,
			path: f.path,
			title: f.title,
			markdownSha256: f.markdownSha256,
			state: unverified ? "unverified" : "current",
			fragment: {
				ordinal: f.ordinal,
				byteStart: f.byteStart,
				byteEnd: f.byteEnd,
				headingPath: f.headingPath,
			},
			quote: f.text,
			quoteSha256: f.textSha256,
			matchedBy: runs.flatMap((run, i) => {
				const rank = item.ranks[i];
				return rank === undefined ? [] : [{ route: run.route, rank }];
			}),
			mentions: runs.flatMap((run) =>
				(run.mentions?.get(item.key) ?? []).map((m) => ({
					kind: m.kind,
					label: m.label,
					evidence: m.evidence,
				})),
			),
		});
	}

	if (queryVector && !queryVector.ok) {
		reasons.add("vector_unavailable");
		if (queryVector.reason === "embedding_timeout")
			reasons.add("deadline_exceeded");
	}
	// The contract's order: a reason added there is never dropped here.
	const partialReasons = searchPartialReasons.filter((r) => reasons.has(r));
	return {
		contractVersion: CONTRACT_VERSION,
		results,
		lexicalMode,
		routes: runs.map((r) => ({
			route: r.route,
			status: r.status,
			reason: r.reason,
			candidates: r.refs.length,
		})),
		coverage: registry.coverage,
		complete: partialReasons.length === 0,
		partialReasons,
	};
}

function runVectorRoute(
	db: Tx,
	vectors: VectorIndex,
	queryVector: QueryVector | null,
	namespaces: readonly string[],
	candidates: number,
	searchableFragments: number,
	reasons: Set<SearchResponse["partialReasons"][number]>,
): RouteRun {
	if (!queryVector || !queryVector.ok) {
		return emptyRun(
			"vector",
			"failed",
			queryVector?.ok === false ? queryVector.reason : "embedding_failed",
		);
	}
	const out = searchVectorIndexInSnapshot(
		vectors,
		db,
		{ key: queryVector.key, dimension: queryVector.space.dimension },
		queryVector.vector,
		namespaces,
		candidates,
	);
	if (!out.ok) {
		reasons.add("vector_unavailable");
		return emptyRun("vector", "failed", out.reason);
	}
	let reason: string | null = null;
	if (out.scored < searchableFragments) {
		// Some searchable documents were indexed in another embedding space: the route did not see them.
		reason = "other_space_documents";
		reasons.add("vector_unavailable");
	}
	return {
		route: "vector",
		status: "ok",
		reason,
		refs: out.refs,
		// A nearest-neighbour route always has more to give; only the matching routes report a cut.
		exhausted: false,
	};
}

export type { EmbeddingPort };
