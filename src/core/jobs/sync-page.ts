import {
	documentListPageSchema,
	ingestNextDedupeKey,
	KNOWLEDGE_JOB_KINDS,
	KnowledgeError,
	SourceError,
	syncPageDedupeKey,
	SOURCE_NAMESPACE_DOCLING,
	syncPagePayloadSchema,
	type CreateSyncPageHandler,
	type HandlerDeps,
	type IngestNextPayload,
	type SyncPagePayload,
} from "../../contracts/index.js";
import {
	beginScanInTransaction,
	failScanInTransaction,
	getScanInTransaction,
	hasCleanupInTransaction,
	isScanPageSettledInTransaction,
	markOutsideNamespacesUnavailableInTransaction,
	observeDocumentInTransaction,
	openChainInTransaction,
	pickNextDocumentInTransaction,
	pruneScansInTransaction,
	settleScanPageInTransaction,
	supersedeRunningScansInTransaction,
} from "../../sqlite/index.js";
import {
	DEFAULT_SUMMARY_MIN_MENTIONS,
	startLinkChainIfWorkInTransaction,
} from "./link-start.js";
import {
	CHAIN_STALE_AFTER_MS,
	DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
	classifyJobError,
	safeEmit,
} from "../support.js";

const MAX_PAGE = 100_000;

export type SyncPageOptions = {
	/**
	 * Must equal the ingest option of the same name: a document at this many attempts (counted for
	 * failures the content caused) is not waiting. Default `DEFAULT_MAX_UNAPPLIED_ATTEMPTS`.
	 */
	maxUnappliedAttempts?: number;
	/** Must equal `LinkOptions.summaryMinMentions`. Default 3. */
	summaryMinMentions?: number;
};

/**
 * The job that reads one listing page and records what it saw (p1.md §2). It never queues a
 * job per document: when a document waits for ingestion (or retired rows wait for cleanup) and
 * the ingest chain is stopped or lost, it starts the chain with one `ingest-next` job (p2.md §3).
 */
export function createSyncPageHandler(
	deps: HandlerDeps,
	options: SyncPageOptions = {},
): ReturnType<CreateSyncPageHandler> {
	const maxUnappliedAttempts =
		options.maxUnappliedAttempts ?? DEFAULT_MAX_UNAPPLIED_ATTEMPTS;
	const summaryMinMentions =
		options.summaryMinMentions ?? DEFAULT_SUMMARY_MIN_MENTIONS;
	return {
		kind: KNOWLEDGE_JOB_KINDS.syncPage,
		payloadVersions: [1],
		schema: syncPagePayloadSchema,
		recovery: "replay_safe",

		prepareInTransaction(tx, claim) {
			const { scanId, page } = claim.payload;
			const now = deps.clock.now();
			const existing = getScanInTransaction(tx, scanId);
			if (existing && existing.state !== "running") {
				return { status: "stale", reason: "scan_closed" };
			}
			if (existing && isScanPageSettledInTransaction(tx, scanId, page)) {
				return { status: "stale", reason: "page_settled" };
			}
			const binding = deps.source.binding();
			if (binding === null) {
				if (existing)
					failScanInTransaction(tx, scanId, "source_unconfigured", now);
				return { status: "stale", reason: "source_unconfigured" };
			}
			if (!existing) {
				if (page !== 0) return { status: "stale", reason: "scan_unknown" };
				beginScanInTransaction(tx, scanId, binding, now);
				// A newer scan replaces any older one that never finished (for example after queue_full).
				supersedeRunningScansInTransaction(tx, scanId, now);
			} else if (existing.binding !== binding) {
				failScanInTransaction(tx, scanId, "binding_changed", now);
				return { status: "stale", reason: "binding_changed" };
			}
			return { status: "ready", input: { ...claim.payload, binding } };
		},

		async execute(input, context) {
			const assertBinding = () => {
				if (deps.source.binding() !== input.binding) {
					throw new SourceError("connection_changed");
				}
			};
			assertBinding();
			const raw = await deps.source.list(input.cursor, context.signal);
			assertBinding();
			const parsed = documentListPageSchema.safeParse(raw);
			if (!parsed.success) throw new KnowledgeError("contract_mismatch");
			return { binding: input.binding, page: parsed.data };
		},

		classify: classifyJobError,

		settleInTransaction(tx, claim, _input, outcome) {
			const { scanId, page } = claim.payload;
			const now = deps.clock.now();
			const scan = getScanInTransaction(tx, scanId);
			const open =
				scan !== null &&
				scan.state === "running" &&
				!isScanPageSettledInTransaction(tx, scanId, page);

			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success") {
				// A failed page never deletes or changes a document: unseen ones stay as they were.
				if (open) {
					const code =
						outcome.type === "expired"
							? "expired"
							: outcome.type === "failed" || outcome.type === "interrupted"
								? outcome.errorCode
								: "failed";
					failScanInTransaction(tx, scanId, code, now);
					safeEmit(deps.events, {
						type: "knowledge.scan.failed",
						level: "warn",
						fields: { scanId, page, code },
					});
				}
				return "applied";
			}

			if (!scan || !open) return "stale";
			const { binding, page: listing } = outcome.result;
			if (deps.source.binding() !== scan.binding || binding !== scan.binding) {
				failScanInTransaction(tx, scanId, "binding_changed", now);
				return { status: "failed", errorCode: "binding_changed" };
			}
			if (listing.nextCursor !== null && page + 1 > MAX_PAGE) {
				failScanInTransaction(tx, scanId, "scan_too_long", now);
				return { status: "failed", errorCode: "scan_too_long" };
			}

			// The allowed areas are the same on every page of a scan: apply them once, on page 0, so
			// the whole table is scanned once per scan. A change shows from the next scan.
			if (page === 0) {
				const leftAllowedAreas = markOutsideNamespacesUnavailableInTransaction(
					tx,
					SOURCE_NAMESPACE_DOCLING,
					listing.namespaces,
					now,
				);
				if (leftAllowedAreas > 0)
					safeEmit(deps.events, {
						type: "knowledge.documents.outside_allowed_namespaces",
						level: "warn",
						fields: { scanId, page, documents: leftAllowedAreas },
					});
			}

			let queued = 0;
			for (const summary of listing.documents) {
				const seen = observeDocumentInTransaction(
					tx,
					summary,
					listing.namespaces,
					now,
				);
				if (seen.needsIngest) queued += 1;
			}
			// A live link is already working through the registry; a stopped or lost one is restarted.
			if (
				pickNextDocumentInTransaction(tx, { maxUnappliedAttempts, now }) !==
					null ||
				hasCleanupInTransaction(tx)
			) {
				const sweep = openChainInTransaction(tx, now, CHAIN_STALE_AFTER_MS);
				if (sweep !== null) {
					const chain: IngestNextPayload = { sweep };
					deps.jobs.enqueueInTransaction(tx, {
						kind: KNOWLEDGE_JOB_KINDS.ingestNext,
						payloadVersion: 1,
						dedupeKey: ingestNextDedupeKey(chain),
						payload: chain,
						lane: "background",
					});
				}
			}
			// Published versions nobody compared yet (or entities without a summary, checked once per
			// scan) start the identity chain, unless a live link is open (p3.md 8).
			startLinkChainIfWorkInTransaction(tx, deps.jobs, now, {
				checkSummaries: listing.nextCursor === null,
				summaryMinMentions,
			});
			if (listing.nextCursor !== null) {
				const next: SyncPagePayload = {
					scanId,
					cursor: listing.nextCursor,
					page: page + 1,
				};
				deps.jobs.enqueueInTransaction(tx, {
					kind: KNOWLEDGE_JOB_KINDS.syncPage,
					payloadVersion: 1,
					dedupeKey: syncPageDedupeKey(next),
					payload: next,
					lane: "background",
				});
			}
			settleScanPageInTransaction(
				tx,
				scanId,
				page,
				queued,
				listing.nextCursor === null,
				now,
			);
			// Old scan records go in small steps whenever a scan finishes.
			if (listing.nextCursor === null) pruneScansInTransaction(tx, now, 500);
			safeEmit(deps.events, {
				type: "knowledge.scan.page_settled",
				level: "info",
				fields: {
					scanId,
					page,
					documents: listing.documents.length,
					queued,
					last: listing.nextCursor === null,
				},
			});
			return "applied";
		},

		cancelInTransaction(tx, job, reason) {
			const { scanId, page } = job.payload;
			const scan = getScanInTransaction(tx, scanId);
			if (
				scan &&
				scan.state === "running" &&
				!isScanPageSettledInTransaction(tx, scanId, page)
			) {
				failScanInTransaction(tx, scanId, "cancelled", deps.clock.now());
				safeEmit(deps.events, {
					type: "knowledge.scan.cancelled",
					level: "info",
					fields: { scanId, page, reasonLength: reason.length },
				});
			}
		},
	};
}
