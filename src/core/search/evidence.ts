import {
	KnowledgeError,
	evidenceRequestSchema,
	evidenceResponseSchema,
	type EvidenceResponse,
	type ReadEvidence,
} from "../../contracts/index.js";
import { readFragmentsOverlappingInSnapshot } from "../../sqlite/reads.js";
import { readEvidenceTargetInSnapshot } from "../../sqlite/search.js";
import { sha256Hex } from "../bytes.js";

/**
 * The adoption-time check of a cited range (p3.md §4). The range is checked against the body of
 * the published version, which is the published fragments joined in order, so a range may span
 * fragments. Everything is read from one snapshot.
 */
export const readEvidence: ReadEvidence = (deps, access, request) => {
	const parsed = evidenceRequestSchema.safeParse(request);
	if (!parsed.success) throw new KnowledgeError("invalid_input");
	const req = parsed.data;
	const verifiedWithinMs = deps.options.verifiedWithinMs;
	if (
		typeof verifiedWithinMs !== "number" ||
		!Number.isFinite(verifiedWithinMs) ||
		verifiedWithinMs < 0 ||
		!Array.isArray(access?.namespaces)
	) {
		throw new KnowledgeError("invalid_input");
	}
	const response: EvidenceResponse = deps.read((db): EvidenceResponse => {
		const now = deps.clock.now();
		const target = readEvidenceTargetInSnapshot(
			db,
			req.documentId,
			access.namespaces,
		);
		if (!target) return { status: "not_available" };
		if (
			target.state === "unavailable" ||
			target.state === "excluded" ||
			target.state === "removed"
		) {
			return { status: "unavailable" };
		}
		const published = target.published;
		// A stale document is never a current basis, even if the cited version is still held.
		if (
			target.state !== "current" ||
			!published ||
			target.observedMarkdownSha256 !== req.markdownSha256 ||
			published.markdownSha256 !== req.markdownSha256
		) {
			return {
				status: "stale",
				currentMarkdownSha256: published?.markdownSha256 ?? null,
			};
		}
		if (req.byteEnd > published.byteLength) return { status: "mismatch" };
		const fragments = readFragmentsOverlappingInSnapshot(
			db,
			published.versionId,
			req.byteStart,
			req.byteEnd,
		);
		const first = fragments[0];
		const last = fragments[fragments.length - 1];
		if (
			!first ||
			!last ||
			first.byteStart > req.byteStart ||
			last.byteEnd < req.byteEnd
		) {
			return { status: "mismatch" };
		}
		const parts: Buffer[] = [];
		let expectedStart = first.byteStart;
		for (const f of fragments) {
			const bytes = Buffer.from(f.text, "utf8");
			if (
				f.byteStart !== expectedStart ||
				bytes.length !== f.byteEnd - f.byteStart
			) {
				return { status: "mismatch" };
			}
			expectedStart = f.byteEnd;
			parts.push(bytes);
		}
		const body = Buffer.concat(parts);
		const slice = body.subarray(
			req.byteStart - first.byteStart,
			req.byteEnd - first.byteStart,
		);
		if (sha256Hex(slice) !== req.quoteSha256) return { status: "mismatch" };
		let quote: string;
		try {
			quote = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				slice,
			);
		} catch {
			// The digest matched but the range cuts a character: not a quotation.
			return { status: "mismatch" };
		}
		const unverified =
			target.lastVerifiedAt === null ||
			target.lastVerifiedAt < now - verifiedWithinMs;
		return {
			status: "valid",
			quote,
			state: unverified ? "unverified" : "current",
		};
	});
	const checked = evidenceResponseSchema.safeParse(response);
	if (!checked.success) throw new KnowledgeError("contract_mismatch");
	return checked.data;
};
