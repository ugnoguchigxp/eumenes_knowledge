/** Defaults the registry and the ingest chain share (one place, so the jobs and the status agree). */

/** Unapplied ingest attempts of one version, caused by its content, before it is skipped (p2.md 3). */
export const DEFAULT_MAX_UNAPPLIED_ATTEMPTS = 3;
/** Base delay before a document whose ingest failed for a temporary reason is picked again. */
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 5 * 60 * 1000;
/** The delay doubles with each consecutive temporary failure up to this (a larger base wins). */
export const MAX_TRANSIENT_RETRY_DELAY_MS = 60 * 60 * 1000;
/** A staging version older than this that no recently advancing link owns is abandoned. */
export const DEFAULT_ORPHAN_STAGING_AFTER_MS = 6 * 60 * 60 * 1000;
/** Finished scans younger than this are kept (the host's acceptance reads them). */
export const SCAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The newest finished scans always kept, however old. */
export const SCAN_KEEP_LATEST = 20;
