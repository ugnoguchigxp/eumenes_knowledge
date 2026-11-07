import {
	searchRequestSchema,
	searchResponseSchema,
	type SearchRequest,
	type SearchResponse,
} from "../contracts/index.js";

export interface ClientOptions {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}

/** API client: talks to the Eumenes public API only; owns no data. */
export function createClient(options: ClientOptions) {
	const doFetch = options.fetch ?? fetch;
	return {
		async search(input: SearchRequest): Promise<SearchResponse> {
			const body = searchRequestSchema.parse(input);
			const response = await doFetch(
				`${options.baseUrl}/api/knowledge/search`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${options.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			if (!response.ok) throw new Error(`knowledge_http_${response.status}`);
			return searchResponseSchema.parse(await response.json());
		},
	};
}
