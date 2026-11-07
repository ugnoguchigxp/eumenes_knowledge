export const knowledgeErrorCodes = [
	"invalid_input",
	/** The UTF-8 bytes of the body do not hash to the declared `markdownSha256`. */
	"digest_mismatch",
	/** The read document is not the observed one (id, namespace or version). */
	"document_mismatch",
	"document_too_large",
	"not_available",
	"contract_mismatch",
	/** A transactional callback returned a Promise or thenable. */
	"async_transaction_callback",
] as const;
export type KnowledgeErrorCode = (typeof knowledgeErrorCodes)[number];

/** Errors the package throws. The message is the code; no document text or secret is attached. */
export class KnowledgeError extends Error {
	override readonly name = "KnowledgeError";
	constructor(readonly code: KnowledgeErrorCode) {
		super(code);
	}
}
