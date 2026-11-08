// `bun scripts/kg-view.ts <run dir>`: builds a self-contained graph viewer page (graph.html) from
// a kg-live run directory (graph.json and report.json). The page embeds the graph without the
// quotation ranges; nothing is fetched at view time except the fonts and d3 from the CDN.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GraphResponse } from "../src/contracts/index.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun scripts/kg-view.ts <run dir>");
const runDir = resolve(dir);
const graph = JSON.parse(
	await readFile(join(runDir, "graph.json"), "utf8"),
) as GraphResponse;
const report = JSON.parse(await readFile(join(runDir, "report.json"), "utf8"));

const docIndex = new Map(graph.documents.map((d, i) => [d.documentId, i]));
const docs = (ids: readonly string[]) =>
	ids.map((id) => docIndex.get(id)).filter((i): i is number => i !== undefined);
const evidenceTotal = Object.values(
	report.evidence as Record<string, number>,
).reduce((s, n) => s + n, 0);
const calls = Object.values(
	report.inference as Record<string, { calls: number }>,
).reduce((s, p) => s + p.calls, 0);

const data = {
	run: {
		llm: report.larm.llm.model,
		profile: report.larm.profile,
		date: String(report.startedAt).slice(0, 10),
		minutes: report.elapsedMinutes,
		bytes: (report.corpus as { bytes: number }[]).reduce(
			(s, d) => s + d.bytes,
			0,
		),
		fragments: report.store.fragments,
		extractionsFailed: report.store.extractionsFailed,
		entityMentions: report.store.entityMentions,
		relationMentions: report.store.relationMentions,
		linksSame: report.store.linksSame,
		linksDifferent: report.store.linksDifferent,
		linksUnsure: report.store.linksUnsure,
		evidenceValid: report.evidence.valid,
		evidenceTotal,
		calls,
	},
	documents: graph.documents.map((d) => ({ title: d.title, path: d.path })),
	partialReasons: graph.partialReasons,
	nodes: graph.nodes.map((n) => ({
		id: n.nodeId,
		label: n.label,
		names: n.names,
		types: n.types,
		m: n.mentionCount,
		docs: docs(n.documentIds),
		summary: n.summary,
	})),
	edges: graph.edges.map((e) => ({
		id: e.edgeId,
		s: e.source,
		t: e.target,
		rel: e.relation,
		dir: e.directed,
		neg: e.negated,
		cert: e.certainty,
		m: e.mentionCount,
		docs: docs(e.documentIds),
	})),
	evaluation: report.evaluation,
};

const template = await readFile(
	join(import.meta.dir, "kg-view/template.html"),
	"utf8",
);
// `<` is escaped so no string in the data can close the script element.
const json = JSON.stringify(data).replaceAll("<", "\\u003c");
const page = template.replace("__KG_DATA__", () => json);
const out = join(runDir, "graph.html");
await writeFile(out, page);
console.log(`wrote ${out} (${Buffer.byteLength(page, "utf8")} bytes)`);
