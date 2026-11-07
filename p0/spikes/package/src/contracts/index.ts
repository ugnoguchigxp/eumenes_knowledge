import { z } from "zod";

/** Public contract version. Bump when any exported schema changes shape. */
export const CONTRACT_VERSION = 1;

export const searchRequestSchema = z.object({
	query: z.string().min(1).max(2_000),
	limit: z.number().int().min(1).max(50).default(10),
});
export type SearchRequest = z.input<typeof searchRequestSchema>;

export const searchResponseSchema = z.object({
	hits: z.array(
		z.object({
			documentId: z.string(),
			version: z.string(),
			digest: z.string(),
		}),
	),
	complete: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
