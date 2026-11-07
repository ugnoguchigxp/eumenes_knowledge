import { createHash } from "node:crypto";
import {
	MAX_EMBED_BATCH,
	type EmbeddingKind,
	type EmbeddingPort,
	type EmbeddingSpace,
} from "../../src/contracts/index.js";
import { abortError, createGate } from "./gate.js";

/**
 * `EmbeddingPort` mocks. Vectors come from a script (explicit, in call order), from a table the
 * fixture states (text to vector, per kind), or, for performance runs only, from a hash that has
 * no meaning. No mock here computes a vector from the meaning of a text.
 *
 * Like Eumenes' LARM provider they refuse an empty list, more than 64 texts and any blank text
 * with `invalid_embedding_input`. Errors are plain `Error`s whose message is a code.
 */

export type EmbeddingCallOutcome =
	| "pending"
	| "ok"
	| "invalid_input"
	| "unexpected_call"
	| "unmapped_text"
	| "invalid_result"
	| "aborted";

/** Counts and codes only: a recorded call never holds a text or a vector. */
export type EmbeddingCallRecord = {
	callIndex: number;
	kind: EmbeddingKind;
	count: number;
	stepIndex: number | null;
	outcome: EmbeddingCallOutcome;
};

export type EmbeddingControl = {
	/** The space reported by the calls that follow (a mid-run change of space). */
	setSpace(space: EmbeddingSpace): void;
	space(): EmbeddingSpace;
	calls(): readonly EmbeddingCallRecord[];
	/** Texts across all recorded calls (refused calls included), for tests with many fragments. */
	totalTexts(): number;
	releaseHeld(): number;
	heldCount(): number;
	whenHeld(n?: number): Promise<void>;
};

type Resolved = {
	vectors: number[][];
	space?: EmbeddingSpace;
	hold?: boolean;
	stepIndex?: number;
};

type CoreOptions = {
	space: EmbeddingSpace;
	/** When true, a result with a wrong count, dimension or a non-finite number throws, as the Eumenes provider does. Default false: the wrong answer is returned as scripted. */
	checkResult?: boolean;
	resolve(
		texts: string[],
		kind: EmbeddingKind,
		space: EmbeddingSpace,
	): Resolved;
};

function createCore(options: CoreOptions): {
	port: EmbeddingPort;
	control: EmbeddingControl;
} {
	let space = { ...options.space };
	const calls: EmbeddingCallRecord[] = [];
	const gate = createGate();

	async function embed(
		texts: string[],
		kind: EmbeddingKind,
		signal: AbortSignal,
	) {
		const record: EmbeddingCallRecord = {
			callIndex: calls.length,
			kind,
			count: texts.length,
			stepIndex: null,
			outcome: "pending",
		};
		calls.push(record);
		if (signal.aborted) {
			record.outcome = "aborted";
			throw abortError();
		}
		if (
			texts.length === 0 ||
			texts.length > MAX_EMBED_BATCH ||
			texts.some((t) => !t.trim())
		) {
			record.outcome = "invalid_input";
			throw new Error("invalid_embedding_input");
		}
		let resolved: Resolved;
		try {
			resolved = options.resolve(texts, kind, space);
		} catch (error) {
			const code = error instanceof Error ? error.message : "unexpected_call";
			record.outcome =
				code === "unmapped_text" ? "unmapped_text" : "unexpected_call";
			throw error;
		}
		record.stepIndex = resolved.stepIndex ?? null;
		if (resolved.hold) {
			try {
				await gate.hold(signal);
			} catch (error) {
				record.outcome = "aborted";
				throw error;
			}
		}
		if (signal.aborted) {
			record.outcome = "aborted";
			throw abortError();
		}
		const reported = { ...(resolved.space ?? space) };
		if (
			options.checkResult &&
			(resolved.vectors.length !== texts.length ||
				!resolved.vectors.every(
					(v) =>
						v.length === reported.dimension &&
						v.every((n) => Number.isFinite(n)),
				))
		) {
			record.outcome = "invalid_result";
			throw new Error("invalid_embedding_result");
		}
		record.outcome = "ok";
		return {
			vectors: resolved.vectors.map((v) => [...v]),
			space: reported,
		};
	}

	return {
		port: { embed },
		control: {
			setSpace(next) {
				space = { ...next };
			},
			space: () => ({ ...space }),
			calls: () => calls,
			totalTexts: () => calls.reduce((sum, call) => sum + call.count, 0),
			releaseHeld: () => gate.release(),
			heldCount: () => gate.count(),
			whenHeld: (n) => gate.whenHeld(n),
		},
	};
}

// ---------------------------------------------------------------------------
// Scripted: vectors per call, in call order
// ---------------------------------------------------------------------------

export type ScriptedEmbeddingStep = {
	expect?: { kind?: EmbeddingKind; count?: number };
	/** Returned as is, so a step can carry a wrong count or dimension on purpose. */
	vectors: number[][];
	/** Reports this space for this call only (a provider that changed under the caller). */
	space?: EmbeddingSpace;
	/** Holds the call until `control.releaseHeld()`; an abort rejects it. */
	hold?: boolean;
};

export function createScriptedEmbedding(options: {
	space: EmbeddingSpace;
	steps: readonly ScriptedEmbeddingStep[];
	checkResult?: boolean;
}) {
	let position = 0;
	const core = createCore({
		space: options.space,
		checkResult: options.checkResult,
		resolve(texts, kind) {
			const step = options.steps[position];
			if (
				!step ||
				(step.expect?.kind !== undefined && step.expect.kind !== kind) ||
				(step.expect?.count !== undefined && step.expect.count !== texts.length)
			)
				throw new Error("unexpected_call");
			const stepIndex = position;
			position += 1;
			return {
				vectors: step.vectors,
				space: step.space,
				hold: step.hold,
				stepIndex,
			};
		},
	});
	return {
		...core,
		control: {
			...core.control,
			remaining: () => options.steps.length - position,
		},
	};
}

// ---------------------------------------------------------------------------
// Table: an explicit text to vector map per kind, stated by the fixture
// ---------------------------------------------------------------------------

export type EmbeddingTable = {
	query?: Readonly<Record<string, readonly number[]>>;
	passage?: Readonly<Record<string, readonly number[]>>;
};

export function createTableEmbedding(options: {
	space: EmbeddingSpace;
	table: EmbeddingTable;
	checkResult?: boolean;
}) {
	const maps: Record<EmbeddingKind, Map<string, readonly number[]>> = {
		query: new Map(Object.entries(options.table.query ?? {})),
		passage: new Map(Object.entries(options.table.passage ?? {})),
	};
	return createCore({
		space: options.space,
		checkResult: options.checkResult,
		resolve(texts, kind) {
			const vectors = texts.map((t) => {
				const v = maps[kind].get(t);
				// The message is a code: the text is never put into an error.
				if (!v) throw new Error("unmapped_text");
				return [...v];
			});
			return { vectors };
		},
	});
}

// ---------------------------------------------------------------------------
// Hash-derived vectors for load and speed tests. They carry no meaning.
// ---------------------------------------------------------------------------

/**
 * A deterministic unit vector derived from sha256 of `input`. Equal inputs give equal vectors and
 * nothing else about the vector relates to the text: it is for exercising storage and search
 * speed, never for judging retrieval quality.
 */
export function meaninglessHashVector(
	input: string,
	dimension: number,
): number[] {
	if (!Number.isInteger(dimension) || dimension < 1)
		throw new Error("invalid_dimension");
	const out: number[] = [];
	for (let block = 0; out.length < dimension; block++) {
		const digest = createHash("sha256")
			.update(`meaningless-hash-vector-v1\n${block}\n${input}`)
			.digest();
		for (let i = 0; i + 4 <= digest.length && out.length < dimension; i += 4)
			out.push((digest.readUInt32BE(i) / 0x100000000) * 2 - 1);
	}
	const norm = Math.sqrt(out.reduce((sum, n) => sum + n * n, 0)) || 1;
	return out.map((n) => n / norm);
}

/**
 * Embeds every text to `meaninglessHashVector(prefix + text)`, with the space's query or passage
 * prefix, so a query and a passage of the same text differ as they do with a real provider.
 */
export function createMeaninglessHashEmbedding(options: {
	space: EmbeddingSpace;
	checkResult?: boolean;
}) {
	return createCore({
		space: options.space,
		checkResult: options.checkResult,
		resolve(texts, kind, space) {
			const prefix = kind === "query" ? space.queryPrefix : space.passagePrefix;
			return {
				vectors: texts.map((t) =>
					meaninglessHashVector(prefix + t, space.dimension),
				),
			};
		},
	});
}
