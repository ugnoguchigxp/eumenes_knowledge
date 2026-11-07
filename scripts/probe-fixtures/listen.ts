if (!(globalThis as Record<string, unknown>).__importGuard)
	throw new Error("run under import-guard");
Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
