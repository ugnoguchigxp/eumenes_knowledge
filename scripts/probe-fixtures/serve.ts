if (!(globalThis as Record<string, unknown>).__importGuard)
	throw new Error("run under import-guard");
Bun.serve({ port: 0, fetch: () => new Response("x") });
