// A minimal stand-in for the package's `search`, typed as the contract's `Search`. It answers the
// text route from the package's trigram index (`searchFragmentsInSnapshot`) and nothing else, so the
// evaluation can be run and tested while (or without) the real search being wired in. It is not a
// baseline and is never used unless `--search fake` is given. It has no question-specific branch.
import {
	CONTRACT_VERSION,
	SEARCH_LIMITS,
	searchRequestSchema,
	searchResponseSchema,
	searchRoutes,
	type Search,
	type SearchHit,
	type SearchResponse,
} from "../../src/contracts/index.js";
import { searchFragmentsInSnapshot } from "../../src/sqlite/index.js";

type DocRow = {
	namespace: string;
	path: string;
	title: string;
	source_namespace: string;
	document_id: string;
	applied_markdown_sha256: string | null;
	state: string;
};

export const fakeSearch: Search = async (deps, access, request, signal) => {
	const parsed = searchRequestSchema.parse(request);
	const routes = parsed.routes ?? searchRoutes;
	const namespaces = parsed.namespaces
		? access.namespaces.filter((n) => parsed.namespaces?.includes(n))
		: access.namespaces;
	const useText = routes.includes("text");
	if (routes.includes("vector")) {
		// Only to make the query-embedding count observable; the vectors are not used.
		await deps.embedding.embed([parsed.query], "query", signal);
	}
	return deps.read((db): SearchResponse => {
		const found = useText
			? searchFragmentsInSnapshot(
					db,
					parsed.query,
					SEARCH_LIMITS.candidatesPerRoute,
					namespaces,
				)
			: [];
		const documents = db
			.query<DocRow>(
				`SELECT namespace, path, title, source_namespace, document_id, applied_markdown_sha256, state
 FROM knowledge_documents WHERE namespace IN (SELECT value FROM json_each(?1))`,
			)
			.all(JSON.stringify(namespaces));
		const byId = new Map(documents.map((d) => [d.document_id, d]));
		const results: SearchHit[] = found
			.slice(0, parsed.limit)
			.flatMap((fragment, index) => {
				const document = byId.get(fragment.documentId);
				if (!document?.applied_markdown_sha256) return [];
				return [
					{
						rank: index + 1,
						sourceNamespace: "docling" as const,
						documentId: fragment.documentId,
						namespace: document.namespace,
						path: document.path,
						title: document.title,
						markdownSha256: document.applied_markdown_sha256,
						state: "current" as const,
						fragment: {
							ordinal: fragment.ordinal,
							byteStart: fragment.byteStart,
							byteEnd: fragment.byteEnd,
							headingPath: fragment.headingPath,
						},
						quote: fragment.text,
						quoteSha256: fragment.textSha256,
						matchedBy: [{ route: "text" as const, rank: index + 1 }],
						mentions: [],
					},
				];
			});
		const count = (state: string) =>
			documents.filter((d) => d.state === state).length;
		const nonCurrent = documents.length - count("current");
		return searchResponseSchema.parse({
			contractVersion: CONTRACT_VERSION,
			results,
			lexicalMode: useText ? "trigram" : "none",
			routes: routes.map((route) => ({
				route,
				status: route === "text" ? "ok" : "skipped",
				reason: route === "text" ? null : "fake_search",
				candidates: route === "text" ? found.length : 0,
			})),
			coverage: {
				documents: documents.length,
				searchable: count("current"),
				stale: count("stale"),
				unavailable: count("unavailable"),
				failed: 0,
				extractionIncomplete: 0,
			},
			complete: nonCurrent === 0,
			partialReasons: nonCurrent === 0 ? [] : ["stale_documents"],
		});
	});
};
