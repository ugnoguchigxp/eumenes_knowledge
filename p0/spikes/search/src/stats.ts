export function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return NaN;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i]!;
}
export function summarize(samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1]! };
}
/** deterministic PRNG (mulberry32) so runs are repeatable */
export function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
export const ms = (t0: number) => performance.now() - t0;
