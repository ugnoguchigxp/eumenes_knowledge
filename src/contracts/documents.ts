import { z } from "zod";

/** The only source in the initial release (p0.md §1). */
export const SOURCE_NAMESPACE_DOCLING = "docling";
export const sourceNamespaceSchema = z.literal(SOURCE_NAMESPACE_DOCLING);
export type SourceNamespace = z.infer<typeof sourceNamespaceSchema>;

export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Docling document id (`larm.docling-files.v1`). */
export const doclingDocumentIdSchema = z.string().regex(/^wiki-[a-f0-9]{32}$/);
/** Strong ETag, quotes included, exactly as Docling returns it. */
export const doclingEtagSchema = z.string().regex(/^"[a-f0-9]{64}"$/);

const text = z.string().min(1);

/**
 * What a listing says about one document. Never carries the body or the recovery.
 *
 * The index version is `markdownSha256` (p0.md §2.1). `etag` and `contentDigest` are
 * observations only: `contentDigest` includes the recovery, so a recovery-only edit changes it
 * without changing the Markdown.
 */
export const documentSummarySchema = z.strictObject({
	sourceNamespace: sourceNamespaceSchema,
	documentId: doclingDocumentIdSchema,
	namespace: text,
	path: text,
	title: text,
	etag: doclingEtagSchema,
	markdownSha256: sha256HexSchema,
	contentDigest: sha256HexSchema,
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

/** One page of the source listing. A listing is complete only when every page was read under one binding. */
export const documentListPageSchema = z.strictObject({
	documents: z.array(documentSummarySchema),
	/** Namespaces the host's source connection may read (Docling's allowed areas). */
	namespaces: z.array(text),
	nextCursor: text.nullable(),
});
export type DocumentListPage = z.infer<typeof documentListPageSchema>;

/**
 * A document as read for ingestion: the summary plus the Markdown body as a JS string.
 * The package derives the UTF-8 bytes itself and checks them against `markdownSha256`
 * (p0.md §2.1). The recovery is never part of the input.
 */
export const documentInputSchema = documentSummarySchema.extend({
	markdown: z.string(),
});
export type DocumentInput = z.infer<typeof documentInputSchema>;

/** Document states (p0.md §2.3). `unverified` is derived when a read is made. */
export const documentStates = [
	"current",
	"unverified",
	"stale",
	"unavailable",
	"excluded",
	"removed",
] as const;
export const documentStateSchema = z.enum(documentStates);
export type DocumentState = z.infer<typeof documentStateSchema>;
