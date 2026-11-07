import {
	SourceError,
	type EventSink,
	type KnowledgeEvent,
} from "../contracts/index.js";

/** An event sink must never break a transaction. */
export function safeEmit(
	sink: EventSink | undefined,
	event: KnowledgeEvent,
): void {
	if (!sink) return;
	try {
		sink(event);
	} catch {
		// Logging failures are not the job's failures.
	}
}

/** Only a source that is down or slow is worth another attempt. */
export function classifyJobError(error: unknown): "retry" | "fail" {
	if (
		error instanceof SourceError &&
		(error.code === "unavailable" || error.code === "timeout")
	) {
		return "retry";
	}
	return "fail";
}
