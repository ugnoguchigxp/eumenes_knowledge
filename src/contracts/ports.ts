import { createHash } from "node:crypto";
import type { DocumentInput, DocumentListPage } from "./documents.js";

// ---------------------------------------------------------------------------
// Document source
// ---------------------------------------------------------------------------

export const sourceErrorCodes = [
	/** 404: the document is not readable now. Never proof of deletion (p0.md §2.3). */
	"not_found",
	/** 403 or a namespace outside the allowed areas. */
	"forbidden",
	/** 401: the host's credential was refused. */
	"unauthorized",
	/** 5xx, connection refused, storage unavailable. */
	"unavailable",
	"timeout",
	/** The response broke the source contract (schema, digest, size, id). */
	"invalid_response",
	/** The signal was aborted. */
	"cancelled",
	/** The host's connection (base URL or credential) changed while reading. */
	"connection_changed",
] as const;
export type SourceErrorCode = (typeof sourceErrorCodes)[number];

/** The only error a `DocumentSourcePort` throws. Carries a code only, never a body or a credential. */
export class SourceError extends Error {
	override readonly name = "SourceError";
	constructor(readonly code: SourceErrorCode) {
		super(code);
	}
}

/**
 * Reads the document source on the host's connection. The host strips the recovery before a
 * document reaches the package. No method writes to the source.
 */
export interface DocumentSourcePort {
	list(cursor: string | null, signal: AbortSignal): Promise<DocumentListPage>;
	read(documentId: string, signal: AbortSignal): Promise<DocumentInput>;
	/**
	 * Opaque identity of the current connection, or null when unconfigured. A listing is complete
	 * only when all its pages were read under one binding. It is stored in the registry, so it
	 * must not reveal the credential: a host should use a connection generation or an HMAC under
	 * a host-held key, not a plain hash of the credential (the example adapter does the latter;
	 * P6 must not copy it).
	 */
	binding(): string | null;
}

// ---------------------------------------------------------------------------
// Inference (shape of eumenes-pipeline's InferencePort, plus deadline and AbortSignal)
// ---------------------------------------------------------------------------

export type InferenceRequest = {
	/** What the call is for (`extract`, `summarize`, ...); recorded with its usage. */
	purpose: string;
	/** Versioned instruction resource the prompt was built from. */
	instructionId: string;
	instructionVersion: number;
	system?: string;
	prompt: string;
	/** JSON Schema of the answer. Constrained output is not guaranteed: answers are always validated. */
	outputSchema?: Record<string, unknown>;
	/** Epoch milliseconds after which the result must not be used. */
	deadlineAtMs: number;
};

/** Token counts as the provider reports them; null when it reports none (never 0 in its place). */
export type InferenceUsage = {
	inputTokens: number | null;
	cachedTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	calls: number | null;
};

export type InferenceResult =
	| {
			ok: true;
			text: string;
			model: string | null;
			usage: InferenceUsage;
			durationMs: number;
	  }
	| {
			ok: false;
			/** Safe code only (`/^[a-z][a-z0-9_]*$/`). */
			error: string;
			model: string | null;
			usage: InferenceUsage;
			durationMs: number;
	  };

export interface InferencePort {
	complete(
		request: InferenceRequest,
		signal: AbortSignal,
	): Promise<InferenceResult>;
}

// ---------------------------------------------------------------------------
// Embedding (same shape as Eumenes' saved LARM embedder)
// ---------------------------------------------------------------------------

export type EmbeddingKind = "query" | "passage";

/** The vector space a provider declares; vectors from different spaces never mix. */
export type EmbeddingSpace = {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
	queryPrefix: string;
	passagePrefix: string;
};

/** Texts per embed call (the Eumenes LARM provider accepts up to 64, none empty). */
export const MAX_EMBED_BATCH = 64;

export interface EmbeddingPort {
	embed(
		texts: string[],
		kind: EmbeddingKind,
		signal: AbortSignal,
	): Promise<{ vectors: number[][]; space: EmbeddingSpace }>;
}

/**
 * Stable key of a vector space. Unlike the router package, the prefixes are part of the key:
 * a different prefix changes what the vectors mean (p0.md #10).
 */
export function embeddingSpaceKey(space: EmbeddingSpace): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				space.modelId,
				space.revision,
				space.artifactDigest,
				space.dimension,
				space.queryPrefix,
				space.passagePrefix,
			]),
		)
		.digest("hex")
		.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Tokenizer (kg2.md §3.2): the model-free extractor's words
// ---------------------------------------------------------------------------

/**
 * One token of a text, as the model-free extractor reads it. The host's adapter maps its
 * tokenizer's part of speech to `kind` and `proper`; the package keeps no tokenizer's tag set.
 */
export type NameToken = {
	/** Exactly `text.slice(start, end)` of the text that was tokenized. */
	surface: string;
	/** UTF-16 offsets into the text that was tokenized. */
	start: number;
	end: number;
	/** A noun (part of a name), a prefix or a noun-like suffix, white space, or anything else. */
	kind: "noun" | "prefix" | "suffix" | "space" | "other";
	/** The tokenizer tags it a proper noun. */
	proper: boolean;
	/** The tokenizer's normalized form (the surface when it has none); name keys use it. */
	norm: string;
};

/**
 * Splits a text into tokens for the model-free extractor (kg2.md G3). Synchronous and local: no
 * network, no model. The package's own is `createCharclassTokenizer` (no dictionary); a host may
 * pass one backed by a morphological analyzer. A throw is a port failure (the ingest is retried).
 */
export interface TokenizerPort {
	/** The tokenizer and its dictionary, recorded with every extraction (`charclass`, ...). */
	readonly id: string;
	tokenize(text: string): NameToken[];
}

// ---------------------------------------------------------------------------
// Clock and events
// ---------------------------------------------------------------------------

export interface Clock {
	/** Epoch milliseconds. */
	now(): number;
}

/**
 * A structured event for the host's logger. Fields carry ids, counts and codes only: never a
 * document body, a quote, a prompt, a credential or a provider's raw answer.
 */
export type KnowledgeEvent = {
	type: string;
	level: "debug" | "info" | "warn" | "error";
	fields?: Record<string, string | number | boolean | null>;
};
export type EventSink = (event: KnowledgeEvent) => void;
