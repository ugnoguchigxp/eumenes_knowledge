import {
	searchRequestSchema,
	type SearchResponse,
} from "../contracts/index.js";

/** Pure function over host-provided ports; opens no connection at import time. */
export interface SearchPorts {
	search(query: string, limit: number): Promise<SearchResponse>;
}

export async function search(
	ports: SearchPorts,
	input: unknown,
): Promise<SearchResponse> {
	const request = searchRequestSchema.parse(input);
	return ports.search(request.query, request.limit);
}
