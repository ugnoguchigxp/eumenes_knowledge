/** Reciprocal rank fusion constant (the usual 60). Only ranks enter the fusion, never scores. */
export const RRF_K = 60;

export type FusedItem<K> = {
	key: K;
	/** Rank per input list (1-based), by list index; absent when the list did not contain it. */
	ranks: (number | undefined)[];
	score: number;
};

/**
 * Fuse ranked lists (best first) by reciprocal rank fusion: the score of an item is the sum of
 * `1 / (RRF_K + rank)` over the lists that contain it. Ties are broken by the better single rank,
 * then by the order of first appearance (list order, then rank), so the result is deterministic.
 * The score is internal; callers return ranks only.
 */
export function fuseRanks<K>(lists: readonly (readonly K[])[]): FusedItem<K>[] {
	const items = new Map<K, FusedItem<K> & { first: number }>();
	let seen = 0;
	lists.forEach((list, li) => {
		list.forEach((key, i) => {
			const rank = i + 1;
			let item = items.get(key);
			if (!item) {
				item = { key, ranks: [], score: 0, first: seen++ };
				items.set(key, item);
			}
			if (item.ranks[li] !== undefined) return; // a duplicate in one list counts once
			item.ranks[li] = rank;
			item.score += 1 / (RRF_K + rank);
		});
	});
	const best = (x: FusedItem<K>) =>
		Math.min(...x.ranks.filter((r): r is number => r !== undefined));
	return [...items.values()].sort(
		(a, b) => b.score - a.score || best(a) - best(b) || a.first - b.first,
	);
}
