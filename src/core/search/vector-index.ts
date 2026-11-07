import {
	KnowledgeError,
	type Tx,
	type VectorIndex,
} from "../../contracts/index.js";
import {
	listPublishedVersionsOfSpaceInSnapshot,
	readVersionVectorMatrixInSnapshot,
} from "../../sqlite/reads.js";
import {
	listSearchableVersionIdsInSnapshot,
	type FragmentRef,
} from "../../sqlite/search.js";

/**
 * The resident vectors of the published fragments (p0.md #11, p3.md §3). One state per embedding
 * space, inside one process: for each published version of the space, its vectors packed in one
 * Float32Array. A search reads the space's list of published version ids (a cheap indexed read,
 * ids only), drops the versions that are no longer published and reads only the new ones; it
 * never re-reads what it already holds. A version's vectors never change once published, so the
 * id is the cache key.
 *
 * What a caller may see is decided on every search from the same snapshot: only versions of
 * `current` documents in the caller's namespaces are scored (`listSearchableVersionIdsInSnapshot`).
 * The cache itself is shared by all callers and holds vectors only, never text.
 */

/** Upper bound of the fragments one space keeps resident (p0.md §6.2). */
export const DEFAULT_MAX_RESIDENT_FRAGMENTS = 50_000;

export type VectorIndexOptions = {
	/** Fragments a space may hold resident; more makes the vector route fail. Default 50,000. */
	maxFragments?: number;
};

type Chunk = { ordinals: Int32Array; matrix: Float32Array };
type SpaceState = {
	dimension: number;
	versions: Map<number, Chunk>;
	fragments: number;
};
type State = {
	readonly maxFragments: number;
	readonly spaces: Map<string, SpaceState>;
	versionLoads: number;
	versionDrops: number;
	/** Rows (fragments) read from the database over the index's life. */
	rowsLoaded: number;
};

// The handle the host holds is opaque; its state lives here.
const states = new WeakMap<object, State>();

export function createVectorIndex(
	options: VectorIndexOptions = {},
): VectorIndex {
	const maxFragments = options.maxFragments ?? DEFAULT_MAX_RESIDENT_FRAGMENTS;
	if (!Number.isSafeInteger(maxFragments) || maxFragments < 0) {
		throw new KnowledgeError("invalid_input");
	}
	const handle: VectorIndex = Object.freeze({
		kind: "knowledge.vector-index" as const,
	});
	states.set(handle, {
		maxFragments,
		spaces: new Map(),
		versionLoads: 0,
		versionDrops: 0,
		rowsLoaded: 0,
	});
	return handle;
}

function stateOf(index: VectorIndex): State {
	const state = states.get(index);
	if (!state) throw new KnowledgeError("invalid_input");
	return state;
}

export type VectorIndexStats = {
	/** Versions read from the database since creation. */
	versionLoads: number;
	/** Versions dropped because they were no longer published. */
	versionDrops: number;
	rowsLoaded: number;
	spaces: { spaceKey: string; versions: number; fragments: number }[];
};

/** Counters for tests and the host's metrics; no document data. */
export function vectorIndexStats(index: VectorIndex): VectorIndexStats {
	const s = stateOf(index);
	return {
		versionLoads: s.versionLoads,
		versionDrops: s.versionDrops,
		rowsLoaded: s.rowsLoaded,
		spaces: [...s.spaces].map(([spaceKey, sp]) => ({
			spaceKey,
			versions: sp.versions.size,
			fragments: sp.fragments,
		})),
	};
}

export type VectorSearchOutcome =
	| {
			ok: true;
			/** Best first. */
			refs: FragmentRef[];
			/** Fragments of this space the caller may read (what was scored). */
			scored: number;
	  }
	| { ok: false; reason: "vector_index_too_large" | "no_vectors" };

/**
 * Bring the space up to date with the snapshot and return the `limit` fragments with the
 * largest inner product with `query`, among the versions the caller may read. Synchronous: it
 * runs inside the snapshot, so the list of published versions and the rows it loads agree.
 */
export function searchVectorIndexInSnapshot(
	index: VectorIndex,
	db: Tx,
	space: { key: string; dimension: number },
	query: Float32Array,
	namespaces: readonly string[],
	limit: number,
): VectorSearchOutcome {
	const state = stateOf(index);
	if (query.length !== space.dimension) {
		throw new KnowledgeError("invalid_input");
	}
	const sp = syncSpace(state, db, space);
	if (sp === "too_large")
		return { ok: false, reason: "vector_index_too_large" };

	const allowed = listSearchableVersionIdsInSnapshot(db, space.key, namespaces);
	const dim = space.dimension;
	const topVersion: number[] = [];
	const topOrdinal: number[] = [];
	const topScore: number[] = [];
	let min = -Infinity;
	let scored = 0;
	for (const versionId of allowed) {
		const chunk = sp.versions.get(versionId);
		if (!chunk) continue;
		const { ordinals, matrix } = chunk;
		scored += ordinals.length;
		for (let row = 0; row < ordinals.length; row++) {
			const off = row * dim;
			let s0 = 0;
			let s1 = 0;
			let s2 = 0;
			let s3 = 0;
			let i = 0;
			for (; i + 4 <= dim; i += 4) {
				s0 += matrix[off + i]! * query[i]!;
				s1 += matrix[off + i + 1]! * query[i + 1]!;
				s2 += matrix[off + i + 2]! * query[i + 2]!;
				s3 += matrix[off + i + 3]! * query[i + 3]!;
			}
			for (; i < dim; i++) s0 += matrix[off + i]! * query[i]!;
			const score = s0 + s1 + s2 + s3;
			if (topScore.length === limit && score <= min) continue;
			// Insert into the descending top list; equal scores keep the earlier (version, ordinal).
			let at = topScore.length;
			while (at > 0 && topScore[at - 1]! < score) at--;
			topScore.splice(at, 0, score);
			topVersion.splice(at, 0, versionId);
			topOrdinal.splice(at, 0, ordinals[row]!);
			if (topScore.length > limit) {
				topScore.pop();
				topVersion.pop();
				topOrdinal.pop();
			}
			if (topScore.length === limit) min = topScore[limit - 1]!;
		}
	}
	if (scored === 0) return { ok: false, reason: "no_vectors" };
	return {
		ok: true,
		refs: topVersion.map((versionId, i) => ({
			versionId,
			ordinal: topOrdinal[i]!,
		})),
		scored,
	};
}

/** Drop what is no longer published, check the bound, load what is new. */
function syncSpace(
	state: State,
	db: Tx,
	space: { key: string; dimension: number },
): SpaceState | "too_large" {
	const published = listPublishedVersionsOfSpaceInSnapshot(db, space.key);
	let sp = state.spaces.get(space.key);
	if (sp && sp.dimension !== space.dimension) {
		// The key includes the dimension, so this does not happen; start over if it ever does.
		state.spaces.delete(space.key);
		sp = undefined;
	}
	if (!sp) {
		sp = { dimension: space.dimension, versions: new Map(), fragments: 0 };
		state.spaces.set(space.key, sp);
	}
	const live = new Set(published.map((p) => p.versionId));
	for (const [versionId, chunk] of sp.versions) {
		if (live.has(versionId)) continue;
		sp.versions.delete(versionId);
		sp.fragments -= chunk.ordinals.length;
		state.versionDrops += 1;
	}
	const wanted = published.reduce((n, p) => n + p.fragments, 0);
	if (wanted > state.maxFragments) return "too_large";
	for (const p of published) {
		if (sp.versions.has(p.versionId)) continue;
		const chunk = readVersionVectorMatrixInSnapshot(
			db,
			p.versionId,
			space.key,
			space.dimension,
			p.fragments,
		);
		sp.versions.set(p.versionId, chunk);
		sp.fragments += chunk.ordinals.length;
		state.versionLoads += 1;
		state.rowsLoaded += chunk.ordinals.length;
	}
	return sp;
}
