import { z } from "zod";
import {
	doclingDocumentIdSchema,
	sha256HexSchema,
	sourceNamespaceSchema,
} from "./documents.js";
import { CONTRACT_VERSION } from "./version.js";

/**
 * The authenticated HTTP API a host publishes (Eumenes in production, the example host in
 * `examples/`). CLI and MCP use it through the package client and own no data. The principal
 * and its namespaces come from the host's authentication, never from a body or a query.
 */
export const API_BASE_PATH = "/api/knowledge";
export const apiPaths = {
	status: `${API_BASE_PATH}/status`,
	syncRequests: `${API_BASE_PATH}/sync-requests`,
	syncRequest: (requestId: string) =>
		`${API_BASE_PATH}/sync-requests/${encodeURIComponent(requestId)}`,
	search: `${API_BASE_PATH}/search`,
	evidence: `${API_BASE_PATH}/evidence`,
	related: `${API_BASE_PATH}/related`,
	graph: `${API_BASE_PATH}/graph`,
} as const;

const count = z.number().int().min(0);
const isoTime = z.iso.datetime({ offset: true });

export const partialReasons = [
	/** No listing scan has completed under the current binding. */
	"no_complete_scan",
	"scan_in_progress",
	/** A newer version was observed and is not applied yet (or the document was never ingested). */
	"stale_documents",
	/** Current documents whose last verification is older than the host's limit. */
	"unverified_documents",
	"unavailable_documents",
	/** Stale documents skipped after too many unapplied ingest attempts of their version (p2.md §3). */
	"failed_documents",
	/** Current documents whose published version has fragments whose extraction failed (p2.md §4). */
	"extraction_incomplete",
	/**
	 * Current documents whose published version left out names or pairs at a fragment's limits
	 * (kg2.md §7.10): a missing name or edge may be one of them.
	 */
	"extraction_truncated",
	/**
	 * The current documents were extracted by more than one extractor (a re-extraction is under
	 * way, or the extractor changed): the names of one may not join those of another (kg2.md §7.10).
	 */
	"extractor_mixed",
] as const;

/** GET status. Counts only the documents in the caller's namespaces. */
export const knowledgeStatusSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	documents: z.strictObject({
		total: count,
		current: count,
		unverified: count,
		stale: count,
		unavailable: count,
		excluded: count,
		removed: count,
	}),
	lastScanAt: isoTime.nullable(),
	lastCompleteScanAt: isoTime.nullable(),
	/** True only when nothing in `partialReasons` applies. Never claims "latest" otherwise. */
	complete: z.boolean(),
	partialReasons: z.array(z.enum(partialReasons)),
});
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

/**
 * POST sync-requests. The client chooses the id, so a resend after a lost answer is the same
 * request. Ids are scoped to the principal: another principal's id is simply a different request.
 */
export const syncRequestInputSchema = z.strictObject({
	requestId: z.uuid(),
});
export type SyncRequestInput = z.infer<typeof syncRequestInputSchema>;

export const syncRequestStates = [
	"accepted",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

/**
 * Acceptance and completion are separate states (plan §6). A scan covers every namespace of the
 * source, so the answer carries no page or document counts: they would reveal documents outside
 * the caller's namespaces (p0.md §4). Per-namespace counts come from the status.
 */
export const syncRequestSchema = z.strictObject({
	requestId: z.uuid(),
	state: z.enum(syncRequestStates),
	acceptedAt: isoTime,
	finishedAt: isoTime.nullable(),
	/** The scan read every page under one binding. False for a failed or cancelled scan. */
	complete: z.boolean(),
	errorCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.nullable(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Every error answer. The code is safe to show; it never carries text from a document or a credential. */
export const apiErrorSchema = z.strictObject({
	error: z.string().regex(/^[a-z][a-z0-9_]*$/),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Search (p3.md §3)
// ---------------------------------------------------------------------------

export const searchRoutes = ["text", "vector", "entity", "relation"] as const;
export type SearchRoute = (typeof searchRoutes)[number];

export const SEARCH_LIMITS = {
	queryChars: 1000,
	maxResults: 50,
	defaultResults: 10,
	candidatesPerRoute: 200,
	responseBytes: 100 * 1024,
} as const;

export const searchRequestSchema = z.strictObject({
	query: z.string().min(1).max(SEARCH_LIMITS.queryChars),
	limit: z
		.number()
		.int()
		.min(1)
		.max(SEARCH_LIMITS.maxResults)
		.default(SEARCH_LIMITS.defaultResults),
	/** Routes to use. Default: every route. */
	routes: z
		.array(z.enum(searchRoutes))
		.min(1)
		.max(searchRoutes.length)
		.optional(),
	/** Narrows the caller's namespaces; never widens them. */
	namespaces: z.array(z.string().min(1).max(512)).max(100).optional(),
});
export type SearchRequest = z.input<typeof searchRequestSchema>;
export type ParsedSearchRequest = z.output<typeof searchRequestSchema>;

const byteRange = {
	byteStart: count,
	byteEnd: count,
};

/** Where a matched mention's quotation sits (entity and relation routes). */
export const searchMentionSchema = z.strictObject({
	kind: z.enum(["entity", "relation"]),
	/** The entity's name, or the relation's short description, as the model wrote it. */
	label: z.string(),
	evidence: z.array(
		z.strictObject({ ...byteRange, quoteSha256: sha256HexSchema }),
	),
});

export const searchHitSchema = z.strictObject({
	/** 1-based rank after fusion. Ranks only: no score is returned as a measure of truth. */
	rank: z.number().int().min(1),
	sourceNamespace: sourceNamespaceSchema,
	documentId: doclingDocumentIdSchema,
	namespace: z.string(),
	path: z.string(),
	title: z.string(),
	markdownSha256: sha256HexSchema,
	state: z.enum(["current", "unverified"]),
	fragment: z.strictObject({
		ordinal: count,
		...byteRange,
		headingPath: z.array(z.string()),
	}),
	/** The fragment's original text (at most one fragment) and its sha256. */
	quote: z.string(),
	quoteSha256: sha256HexSchema,
	matchedBy: z.array(
		z.strictObject({
			route: z.enum(searchRoutes),
			rank: z.number().int().min(1),
		}),
	),
	mentions: z.array(searchMentionSchema),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchPartialReasons = [
	...partialReasons,
	/** The vector route could not run (embedding failed or timed out, no vectors in the space). */
	"vector_unavailable",
	/** A route stopped at its candidate limit. */
	"route_budget_exhausted",
	/** A requested route could not run for this query (for example a query under 3 characters above the scan limit). */
	"route_skipped",
	/** Results were dropped to keep the answer within its byte budget. */
	"response_truncated",
	"deadline_exceeded",
] as const;

export const searchResponseSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	results: z.array(searchHitSchema),
	/** How the text route matched: the trigram index, a substring scan (query under 3 characters), or not run. */
	lexicalMode: z.enum(["trigram", "substring_scan", "none"]),
	routes: z.array(
		z.strictObject({
			route: z.enum(searchRoutes),
			status: z.enum(["ok", "skipped", "failed"]),
			reason: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.nullable(),
			candidates: count,
		}),
	),
	/** Documents in the caller's (narrowed) namespaces, by what the search could use. */
	coverage: z.strictObject({
		documents: count,
		searchable: count,
		stale: count,
		unavailable: count,
		failed: count,
		extractionIncomplete: count,
	}),
	complete: z.boolean(),
	partialReasons: z.array(z.enum(searchPartialReasons)),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ---------------------------------------------------------------------------
// Evidence check (p3.md §4)
// ---------------------------------------------------------------------------

export const evidenceRequestSchema = z
	.strictObject({
		documentId: doclingDocumentIdSchema,
		markdownSha256: sha256HexSchema,
		...byteRange,
		quoteSha256: sha256HexSchema,
	})
	.refine((v) => v.byteEnd > v.byteStart, { message: "empty_range" });
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;

export const evidenceResponseSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("valid"),
		quote: z.string(),
		state: z.enum(["current", "unverified"]),
	}),
	/** A newer version exists (applied or not yet): the reference must not be adopted. */
	z.strictObject({
		status: z.literal("stale"),
		currentMarkdownSha256: sha256HexSchema.nullable(),
	}),
	z.strictObject({ status: z.literal("unavailable") }),
	/** Same version, but the range is outside the body or the quote digest differs. */
	z.strictObject({ status: z.literal("mismatch") }),
	/** Unknown, or outside the caller's namespaces: the two are not told apart (p0.md §4). */
	z.strictObject({ status: z.literal("not_available") }),
]);
export type EvidenceResponse = z.infer<typeof evidenceResponseSchema>;

// ---------------------------------------------------------------------------
// Related documents (p3.md §8)
// ---------------------------------------------------------------------------

/**
 * How a related document was found (kg2.md §3.5, §7.14): shared entities, nearness of fragments,
 * or a link the author wrote between the two documents.
 */
export const relatedRoutes = ["entities", "embedding", "links"] as const;

export const relatedRequestSchema = z.strictObject({
	documentId: doclingDocumentIdSchema,
	limit: z
		.number()
		.int()
		.min(1)
		.max(SEARCH_LIMITS.maxResults)
		.default(SEARCH_LIMITS.defaultResults),
	namespaces: z.array(z.string().min(1).max(512)).max(100).optional(),
	/**
	 * The routes to use (default all). `embedding` needs the host's vector index; without it the
	 * route finds nothing.
	 */
	routes: z.array(z.enum(relatedRoutes)).min(1).max(3).optional(),
});
export type RelatedRequest = z.input<typeof relatedRequestSchema>;

const evidencePoint = z.strictObject({
	fragmentOrdinal: count,
	...byteRange,
	quoteSha256: sha256HexSchema,
});

export const RELATED_LIMITS = {
	/** Shared entities listed per result, the most specific (highest IDF) first. */
	sharedPerResult: 20,
	/** Pairs of fragments listed per result, best first. */
	passagesPerResult: 3,
	/** Fragments of the requested document that are compared; more is `response_truncated`. */
	fragmentsPerDocument: 64,
	/** Nearest fragments read per fragment of the requested document (the embedding route). */
	nearestPerFragment: 200,
	/**
	 * A document that links to more documents than this is an index (a table of contents): its
	 * links say where to go, not what is related, and rank after shared entities (kg2.md §7.14).
	 */
	indexLinks: 20,
	/**
	 * Links to the requested document used (the links route); more is `response_truncated`, as
	 * are more than 20,000 links in its namespace to files of its file name (`README.md`).
	 */
	linksToDocument: 1000,
} as const;

export const relatedPartialReasons = [
	...partialReasons,
	/** Some current documents in scope were not compared for identity yet. */
	"linking_pending",
	/** The model was unsure for some candidate pairs; they are not counted as the same entity. */
	"linking_unsure",
	"response_truncated",
	/**
	 * The embedding route could not run (the vector index is too large, the document has no
	 * vectors) or did not see some documents in scope (another embedding space).
	 */
	"vector_unavailable",
] as const;

export const relatedResponseSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	/** `not_available`: unknown or outside the caller's namespaces (not told apart). `stale`: the document is not current. */
	status: z.enum(["ok", "stale", "not_available"]),
	document: z
		.strictObject({
			documentId: doclingDocumentIdSchema,
			markdownSha256: sha256HexSchema,
		})
		.nullable(),
	results: z.array(
		z.strictObject({
			/**
			 * Documents linked to or from the requested one first (a link the author wrote, kg2.md
			 * §7.14), then those that share an entity, then those linked only by an index (a document of
			 * more than `RELATED_LIMITS.indexLinks` links), then those the embedding route alone found
			 * (the nearest fragments, without a threshold: near is not the same as related). Within
			 * each, by the best pair of fragments (one of the requested document, one of this one): the
			 * reciprocal rank fusion of the fragments' links, shared entities (weighted by IDF) and
			 * embedding nearness; equal scores by document id. An order, not a measure of truth.
			 */
			rank: z.number().int().min(1),
			documentId: doclingDocumentIdSchema,
			namespace: z.string(),
			path: z.string(),
			title: z.string(),
			markdownSha256: sha256HexSchema,
			state: z.enum(["current", "unverified"]),
			/** The routes that found any pair of fragments of this document (`passages` shows the best). */
			routes: z.array(z.enum(relatedRoutes)),
			/**
			 * The links between the two documents (the links route): `to`, the requested document links
			 * to this one; `from`, this one links to the requested one. A link's pair of fragments is
			 * the fragment that holds the link and the first fragment of the document it names.
			 */
			links: z.array(z.enum(["to", "from"])).max(2),
			/**
			 * The best pairs of fragments, at most `RELATED_LIMITS.passagesPerResult`: each fragment as a
			 * quotation of its document (the whole fragment), and the routes that ranked the pair.
			 */
			passages: z
				.array(
					z.strictObject({
						document: evidencePoint,
						related: evidencePoint,
						routes: z.array(z.enum(relatedRoutes)),
					}),
				)
				.max(RELATED_LIMITS.passagesPerResult),
			/**
			 * Entities both documents name, the most specific first (IDF over the fragments in the
			 * caller's scope), at most `RELATED_LIMITS.sharedPerResult`. Empty when only the embedding
			 * route found the document.
			 */
			shared: z
				.array(
					z.strictObject({
						/** The entity's name in the requested document and in this one, as written. */
						label: z.string(),
						relatedLabel: z.string(),
						/** Quotations of the two mentions joined as the same entity. */
						evidence: z.strictObject({
							document: z.array(evidencePoint),
							related: z.array(evidencePoint),
						}),
						/**
						 * Who decided it: a model's or a person's link with its provenance (p0.md #2), or the
						 * model-free extractor's identity key (`name_key`).
						 */
						decidedBy: z.strictObject({
							model: z.string().nullable(),
							instructionId: z.string(),
							instructionVersion: z.number().int().min(1),
						}),
						/**
						 * The entity's derived summary (p0.md #5), only when every mention it was made from is
						 * current and inside the caller's namespaces; otherwise null.
						 */
						summary: z.string().nullable(),
					}),
				)
				.max(RELATED_LIMITS.sharedPerResult),
		}),
	),
	complete: z.boolean(),
	partialReasons: z.array(z.enum(relatedPartialReasons)),
});
export type RelatedResponse = z.infer<typeof relatedResponseSchema>;
export type RelatedRoute = (typeof relatedRoutes)[number];

// ---------------------------------------------------------------------------
// Knowledge graph (kg.md §2)
// ---------------------------------------------------------------------------

export const GRAPH_LIMITS = {
	defaultNodes: 200,
	maxNodes: 1000,
	defaultEdges: 500,
	maxEdges: 2000,
	/** Quotations returned per node and per edge (the first ones, one per document first). */
	evidencePerItem: 3,
	/** Distinct names and types listed per node. */
	namesPerNode: 10,
	/**
	 * Documents listed per node and per edge (`documentIds`): those with the most mentions, ties by
	 * id; `documentCount` counts them all (kg2.md §7.12: a frequent name is in every document).
	 */
	documentsPerItem: 20,
	/** Current mentions read for one graph; a larger scope answers `mentions_truncated`. */
	maxMentions: 20_000,
	/** Relation mentions read for one graph; more answers `relations_truncated`. */
	maxRelations: 50_000,
	/**
	 * Characters of the JSON answer at most (the package's client reads 1 MiB): beyond it, fewer
	 * nodes and edges are returned (`nodes_truncated`, `edges_truncated`).
	 */
	responseChars: 900_000,
	/** Node types a request may name (`types`). */
	types: 20,
} as const;

export const graphRequestSchema = z.strictObject({
	maxNodes: z
		.number()
		.int()
		.min(1)
		.max(GRAPH_LIMITS.maxNodes)
		.default(GRAPH_LIMITS.defaultNodes),
	maxEdges: z
		.number()
		.int()
		.min(0)
		.max(GRAPH_LIMITS.maxEdges)
		.default(GRAPH_LIMITS.defaultEdges),
	/** Narrows the caller's namespaces; never widens them. */
	namespaces: z.array(z.string().min(1).max(512)).max(100).optional(),
	/** Only nodes whose mentions span at least this many documents (kg2.md §3.5). Default 1. */
	minDocuments: z.number().int().min(1).max(10_000).default(1),
	/** Only edges whose relation mentions span at least this many documents. Default 1. */
	minEdgeDocuments: z.number().int().min(1).max(10_000).default(1),
	/**
	 * Only nodes with a mention of one of these types, as written at extraction (the model-free
	 * extractor writes 固有名 or 名詞). Default: every type.
	 */
	types: z
		.array(z.string().min(1).max(80))
		.min(1)
		.max(GRAPH_LIMITS.types)
		.optional(),
});
export type GraphRequest = z.input<typeof graphRequestSchema>;
export type ParsedGraphRequest = z.output<typeof graphRequestSchema>;

/** A quotation that backs a node or an edge; check it with the evidence API before using it. */
const graphEvidencePoint = z.strictObject({
	documentId: doclingDocumentIdSchema,
	markdownSha256: sha256HexSchema,
	fragmentOrdinal: count,
	...byteRange,
	quoteSha256: sha256HexSchema,
});

const linkProvenance = z.strictObject({
	model: z.string().nullable(),
	instructionId: z.string(),
	instructionVersion: z.number().int().min(1),
});

export const graphPartialReasons = [
	...partialReasons,
	/** Some current documents in scope were not compared for identity yet: nodes may split later. */
	"linking_pending",
	/** The model was unsure for some candidate pairs; they are not merged. */
	"linking_unsure",
	/**
	 * Some `same` judgments contradict `different` ones (joining them would put two mentions judged
	 * different into one node); those `same` links were not used.
	 */
	"linking_conflict",
	/** More nodes than `maxNodes`: the most mentioned ones are returned. */
	"nodes_truncated",
	/** More edges between the returned nodes than `maxEdges`: the most mentioned ones are returned. */
	"edges_truncated",
	/** The scope holds more than `GRAPH_LIMITS.maxMentions` current mentions: only the first were read. */
	"mentions_truncated",
	/** The read versions hold more than `GRAPH_LIMITS.maxRelations` relation mentions: only the first were read. */
	"relations_truncated",
] as const;

export const graphResponseSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	status: z.literal("ok"),
	/** The documents the returned nodes and edges come from. */
	documents: z.array(
		z.strictObject({
			documentId: doclingDocumentIdSchema,
			namespace: z.string(),
			path: z.string(),
			title: z.string(),
			markdownSha256: sha256HexSchema,
			state: z.enum(["current", "unverified"]),
		}),
	),
	/**
	 * One node per entity: the current mentions in the caller's scope joined by `same` links whose
	 * both ends are in scope (a mention outside never joins two inside), and by identity key (the
	 * mentions of one namespace with the same model-free key; `decidedBy` names it `name_key`). A
	 * `same` link that would put two mentions judged `different` into one node is not used
	 * (`linking_conflict`); a key join judged `different` is not made.
	 */
	nodes: z.array(
		z.strictObject({
			/** An ordinal valid within this response only (`n1`, `n2`, ... in the returned order). */
			nodeId: z.string(),
			/** The name written most often among the mentions. */
			label: z.string(),
			/** Distinct names as written, most frequent first. */
			names: z.array(z.string()),
			/** Distinct types given at extraction, most frequent first. */
			types: z.array(z.string()),
			mentionCount: z.number().int().min(1),
			/** Documents of the mentions, all of them. */
			documentCount: z.number().int().min(1),
			/** At most `GRAPH_LIMITS.documentsPerItem` of them (the most mentioned), in id order. */
			documentIds: z.array(doclingDocumentIdSchema),
			evidence: z.array(graphEvidencePoint),
			/** Who joined the mentions (`same` links inside the node); empty for one mention. */
			decidedBy: z.array(linkProvenance),
			/** The derived summary, only when it was made from exactly these mentions (p0.md #5). */
			summary: z.string().nullable(),
		}),
	),
	/**
	 * Relation mentions grouped by their two nodes, direction, relation name (normalized),
	 * negation and certainty. Only edges whose both nodes are returned.
	 */
	edges: z.array(
		z.strictObject({
			/** An ordinal valid within this response only (`e1`, `e2`, ... in the returned order). */
			edgeId: z.string(),
			source: z.string(),
			target: z.string(),
			directed: z.boolean(),
			/** The relation name written most often among the grouped mentions. */
			relation: z.string(),
			keywords: z.array(z.string()),
			negated: z.boolean(),
			certainty: z.enum(["stated", "uncertain", "hypothetical"]),
			conditions: z.array(z.string()),
			mentionCount: z.number().int().min(1),
			/** Documents of the relation mentions, all of them. */
			documentCount: z.number().int().min(1),
			/** At most `GRAPH_LIMITS.documentsPerItem` of them (the most mentioned), in id order. */
			documentIds: z.array(doclingDocumentIdSchema),
			evidence: z.array(graphEvidencePoint),
		}),
	),
	complete: z.boolean(),
	partialReasons: z.array(z.enum(graphPartialReasons)),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

/** HTTP status of each error code the API answers with. */
export const API_ERROR_STATUS = {
	invalid_input: 400,
	unauthorized: 401,
	not_available: 404,
	request_conflict: 409,
	payload_too_large: 413,
	internal_error: 500,
	/** The host is starting and refuses everything but its own status. */
	server_starting: 503,
	knowledge_unavailable: 503,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
