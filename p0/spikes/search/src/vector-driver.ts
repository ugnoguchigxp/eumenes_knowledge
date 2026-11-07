// (dim, N) の全組合せを 1 件ずつ子プロセスで測る（RSS を互いに汚さないため）。
const dims = (process.env.V_DIMS ?? "384,768,1024").split(",").map(Number);
const Ns = (process.env.V_NS ?? "1000,10000,50000,100000").split(",").map(Number);
const all: unknown[] = [];
for (const dim of dims)
	for (const N of Ns) {
		const p = Bun.spawnSync([process.execPath, "run", new URL("./vector-bench.ts", import.meta.url).pathname, String(dim), String(N)], { env: process.env, stderr: "inherit" });
		const line = p.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
		if (!line) { console.error(`dim=${dim} N=${N} failed`); continue; }
		const r = JSON.parse(line.slice(7));
		console.log(line);
		all.push(r);
	}
await Bun.write(new URL("../results/vector-bench.json", import.meta.url), JSON.stringify(all, null, 1));
