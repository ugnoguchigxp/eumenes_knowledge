/**
 * A response gate: a call waits on a Promise until the test releases it. No timers, so a held
 * call never depends on wall-clock time. An aborted signal rejects the held call.
 */

export function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

export type Gate = {
	/** Resolves when `release()` runs; rejects with an AbortError when the signal aborts first. */
	hold(signal: AbortSignal): Promise<void>;
	/** Releases every held call. Returns how many were released. */
	release(): number;
	count(): number;
	/** Resolves once at least `n` calls are held (immediately when they already are). */
	whenHeld(n?: number): Promise<void>;
};

export function createGate(): Gate {
	type Held = { resolve(): void };
	const held = new Set<Held>();
	let waiters: { n: number; resolve(): void }[] = [];

	function notify(): void {
		const ready = waiters.filter((w) => held.size >= w.n);
		waiters = waiters.filter((w) => held.size < w.n);
		for (const w of ready) w.resolve();
	}

	return {
		hold(signal) {
			return new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(abortError());
					return;
				}
				const entry: Held = {
					resolve() {
						signal.removeEventListener("abort", onAbort);
						held.delete(entry);
						resolve();
					},
				};
				const onAbort = () => {
					held.delete(entry);
					reject(abortError());
				};
				signal.addEventListener("abort", onAbort, { once: true });
				held.add(entry);
				notify();
			});
		},
		release() {
			const entries = [...held];
			for (const entry of entries) entry.resolve();
			return entries.length;
		},
		count: () => held.size,
		whenHeld(n = 1) {
			if (held.size >= n) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push({ n, resolve });
			});
		},
	};
}
