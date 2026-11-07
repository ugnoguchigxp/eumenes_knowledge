if (!(globalThis as Record<string, unknown>).__importGuard)
	throw new Error("run under import-guard");
setInterval(() => {}, 1000);
