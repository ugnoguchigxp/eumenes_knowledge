import { z } from "zod";
import { CONTRACT_VERSION } from "./version.js";

/**
 * The authenticated HTTP API a host publishes (Eumenes in production, the example host in
 * `examples/`). CLI and MCP use it through the package client and own no data. The principal
 * and its namespaces come from the host's authentication, never from a body or a query.
 */
export const API_BASE_PATH = "/api/knowledge";
export const apiPaths = {
	status: `${API_BASE_PATH}/status`,
	syncRequests: `${API_BASE_PATH}/sync-requests`,
	syncRequest: (requestId: string) =>
		`${API_BASE_PATH}/sync-requests/${encodeURIComponent(requestId)}`,
} as const;

const count = z.number().int().min(0);
const isoTime = z.iso.datetime({ offset: true });

export const partialReasons = [
	/** No listing scan has completed under the current binding. */
	"no_complete_scan",
	"scan_in_progress",
	/** A newer version was observed and is not applied yet (or the document was never ingested). */
	"stale_documents",
	/** Current documents whose last verification is older than the host's limit. */
	"unverified_documents",
	"unavailable_documents",
	/** Stale documents skipped after too many unapplied ingest attempts of their version (p2.md §3). */
	"failed_documents",
	/** Current documents whose published version has fragments whose extraction failed (p2.md §4). */
	"extraction_incomplete",
] as const;

/** GET status. Counts only the documents in the caller's namespaces. */
export const knowledgeStatusSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	documents: z.strictObject({
		total: count,
		current: count,
		unverified: count,
		stale: count,
		unavailable: count,
		excluded: count,
		removed: count,
	}),
	lastScanAt: isoTime.nullable(),
	lastCompleteScanAt: isoTime.nullable(),
	/** True only when nothing in `partialReasons` applies. Never claims "latest" otherwise. */
	complete: z.boolean(),
	partialReasons: z.array(z.enum(partialReasons)),
});
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

/**
 * POST sync-requests. The client chooses the id, so a resend after a lost answer is the same
 * request. Ids are scoped to the principal: another principal's id is simply a different request.
 */
export const syncRequestInputSchema = z.strictObject({
	requestId: z.uuid(),
});
export type SyncRequestInput = z.infer<typeof syncRequestInputSchema>;

export const syncRequestStates = [
	"accepted",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

/**
 * Acceptance and completion are separate states (plan §6). A scan covers every namespace of the
 * source, so the answer carries no page or document counts: they would reveal documents outside
 * the caller's namespaces (p0.md §4). Per-namespace counts come from the status.
 */
export const syncRequestSchema = z.strictObject({
	requestId: z.uuid(),
	state: z.enum(syncRequestStates),
	acceptedAt: isoTime,
	finishedAt: isoTime.nullable(),
	/** The scan read every page under one binding. False for a failed or cancelled scan. */
	complete: z.boolean(),
	errorCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.nullable(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Every error answer. The code is safe to show; it never carries text from a document or a credential. */
export const apiErrorSchema = z.strictObject({
	error: z.string().regex(/^[a-z][a-z0-9_]*$/),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** HTTP status of each error code the API answers with. */
export const API_ERROR_STATUS = {
	invalid_input: 400,
	unauthorized: 401,
	not_available: 404,
	request_conflict: 409,
	payload_too_large: 413,
	internal_error: 500,
	/** The host is starting and refuses everything but its own status. */
	server_starting: 503,
	knowledge_unavailable: 503,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
