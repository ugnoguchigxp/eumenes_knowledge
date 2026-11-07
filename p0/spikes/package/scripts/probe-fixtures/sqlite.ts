if (!(globalThis as Record<string, unknown>).__importGuard)
	throw new Error("run under import-guard");
import { Database } from "bun:sqlite";
new Database(":memory:").exec("select 1");
