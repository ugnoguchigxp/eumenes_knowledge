if (!(globalThis as Record<string, unknown>).__importGuard)
	throw new Error("run under import-guard");
import { writeFileSync } from "node:fs";
writeFileSync("created.txt", "x");
