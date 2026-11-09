/**
 * The one rule that joins mentions into nodes (kg.md §2), shared by the graph read and the
 * choice of identity candidates (kg.md §7): components of `same` links under the `different`
 * judgments as cannot-link constraints.
 *
 * Items are numbered 0..n-1. The links are applied in a fixed order: first those whose two ends
 * have an equal normalized name, then the others, each group in the order given. A link that
 * would join two components holding a pair judged `different` is not used (`rejected`).
 * `unsure` is neither a link nor a constraint (the caller passes neither). Smaller components
 * are merged into larger ones and only their members' `different` neighbours are looked at, so
 * the work stays near (links + constraints) log (items).
 */
export function constrainedComponents(
	nameNorms: readonly string[],
	same: readonly (readonly [number, number])[],
	different: readonly (readonly [number, number])[],
): {
	/** The component of every item: the index of one of its members. */
	of: number[];
	/** Indexes into `same` of the links used (including those inside one component already). */
	used: number[];
	rejected: number;
} {
	const n = nameNorms.length;
	const cannot = new Map<number, number[]>();
	for (const [x, y] of different) {
		for (const [p, q] of [
			[x, y],
			[y, x],
		] as const) {
			const list = cannot.get(p);
			if (list) list.push(q);
			else cannot.set(p, [q]);
		}
	}
	const order = same.map((_, i) => i);
	// A stable split keeps the given order inside each group.
	const ordered = [
		...order.filter((i) => nameNorms[same[i]![0]] === nameNorms[same[i]![1]]),
		...order.filter((i) => nameNorms[same[i]![0]] !== nameNorms[same[i]![1]]),
	];
	const of = Array.from({ length: n }, (_, i) => i);
	const members = Array.from({ length: n }, (_, i) => [i]);
	const used: number[] = [];
	let rejected = 0;
	for (const i of ordered) {
		const [a, b] = same[i]!;
		const ca = of[a] as number;
		const cb = of[b] as number;
		if (ca === cb) {
			used.push(i);
			continue;
		}
		let small = members[ca] as number[];
		let large = members[cb] as number[];
		let smallId = ca;
		let largeId = cb;
		if (small.length > large.length) {
			[small, large] = [large, small];
			[smallId, largeId] = [largeId, smallId];
		}
		const conflict = small.some((m) =>
			(cannot.get(m) ?? []).some((d) => of[d] === largeId),
		);
		if (conflict) {
			rejected++;
			continue;
		}
		for (const m of small) {
			of[m] = largeId;
			large.push(m);
		}
		members[smallId] = [];
		used.push(i);
	}
	return { of, used, rejected };
}
