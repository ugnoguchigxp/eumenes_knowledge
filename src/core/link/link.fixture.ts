import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
	FollowUpJob,
	InferenceRequest,
	IngestDeps,
	LinkNextPayload,
	LinkOptions,
	IngestOptions,
} from "../../contracts/index.js";
import {
	FakeClock,
	FakeEmbedding,
	FakeInference,
	FakeJobSink,
	FakeSource,
	FakeWriter,
	inferenceOk,
	makeDb,
	makeDoc,
	runJob,
} from "../harness.fixture.js";
import {
	createIngestNextHandler,
	createLinkNextHandler,
	createSyncPageHandler,
	type IngestNextHandler,
	type LinkNextHandler,
} from "../index.js";

/** Names the scripted extraction finds in a text (a test double: the real code never does this). */
export const KNOWN_NAMES = [
	"Alpha Corp",
	"Beta Ltd",
	"Gamma Inc",
	"Delta",
	"Alpha Corp Japan",
];

export type MentionJson = {
	name: string;
	type: string;
	description: string;
	evidence: string[];
};
export type LinkInput = {
	mention: MentionJson;
	candidates: (MentionJson & { id: string })[];
};

export function inputOf(request: InferenceRequest): unknown {
	const line = request.prompt.split("\n---Input---\n")[1]?.split("\n")[0];
	return JSON.parse(line ?? "null");
}

export function extractAnswer(text: string): string {
	const found = KNOWN_NAMES.filter((n) => text.includes(n));
	return JSON.stringify({
		entities: found.map((name, i) => ({
			id: `e${i + 1}`,
			name,
			type: "company",
			description: `${name} as described in: ${text.slice(0, 24)}`,
			evidence: [name],
		})),
		relations: [],
	});
}

export type LinkEnv = {
	db: Database;
	source: FakeSource;
	sink: FakeJobSink;
	clock: FakeClock;
	inference: FakeInference;
	embedding: FakeEmbedding;
	writer: FakeWriter;
	sync: ReturnType<typeof createSyncPageHandler>;
	ingest: IngestNextHandler;
	link: LinkNextHandler;
	events: Array<{ type: string; fields?: unknown }>;
	/** Decides one mention/candidate pair (default: same when the names are equal). */
	decide: (mention: MentionJson, candidate: MentionJson) => string;
	/** Replaces the link answer for a call (default: `decide` for every candidate). */
	linkAnswer: ((input: LinkInput, call: number) => string) | null;
	summaryAnswer:
		((input: { names: string[]; descriptions: string[] }) => string) | null;
	calls: { link: number; summarize: number; extract: number };
};

export function makeLinkEnv(
	linkOptions: LinkOptions = {},
	ingestOptions: IngestOptions = {},
): LinkEnv {
	const db = makeDb();
	const source = new FakeSource();
	const sink = new FakeJobSink();
	const clock = new FakeClock();
	const inference = new FakeInference();
	const embedding = new FakeEmbedding();
	const writer = new FakeWriter(db);
	const events: LinkEnv["events"] = [];
	const deps: IngestDeps = {
		source,
		jobs: sink,
		clock,
		events: (e) => events.push(e),
		inference,
		embedding,
		writer,
	};
	// One value for every job (the sync-page job must see what the others do).
	const extractor = ingestOptions.extractor ?? "model";
	const summaries = linkOptions.summaries ?? true;
	const env = {
		db,
		source,
		sink,
		clock,
		inference,
		embedding,
		writer,
		events,
		// The model's extraction, identity and summaries (frozen since kg2.md G7, kept on request)
		// unless a scenario asks for `extractor: "names"` or `summaries: false`.
		sync: createSyncPageHandler(deps, {
			summaryMinMentions: linkOptions.summaryMinMentions,
			summaries,
			extractor,
		}),
		ingest: createIngestNextHandler(deps, {
			...ingestOptions,
			extractor,
		}) as IngestNextHandler,
		link: createLinkNextHandler(deps, {
			...linkOptions,
			summaries,
		}) as LinkNextHandler,
		decide: (m: MentionJson, c: MentionJson) =>
			m.name === c.name ? "same" : "different",
		linkAnswer: null,
		summaryAnswer: null,
		calls: { link: 0, summarize: 0, extract: 0 },
	} as LinkEnv;
	inference.script = (request) => {
		if (request.purpose === "link") {
			env.calls.link += 1;
			const input = inputOf(request) as LinkInput;
			if (env.linkAnswer)
				return inferenceOk(env.linkAnswer(input, env.calls.link));
			return inferenceOk(
				JSON.stringify({
					decisions: input.candidates.map((c) => ({
						candidate: c.id,
						decision: env.decide(input.mention, c),
					})),
				}),
			);
		}
		if (request.purpose === "summarize") {
			env.calls.summarize += 1;
			const input = inputOf(request) as {
				names: string[];
				descriptions: string[];
			};
			if (env.summaryAnswer) return inferenceOk(env.summaryAnswer(input));
			return inferenceOk(
				JSON.stringify({
					summary: `SUMMARY(${input.names.join("/")}; ${input.descriptions.length})`,
				}),
			);
		}
		env.calls.extract += 1;
		const line = request.prompt.split("\n---Input---\n")[1]?.split("\n")[0];
		const text = (JSON.parse(line ?? "{}") as { text?: string }).text ?? "";
		return inferenceOk(extractAnswer(text));
	};
	return env;
}

/** Put a document into the fake source. */
export function putDoc(
	env: LinkEnv,
	n: number,
	markdown: string,
	namespace = "wiki",
): void {
	env.source.put(makeDoc(n, markdown, { namespace }));
	if (!env.source.namespaces.includes(namespace)) {
		env.source.namespaces.push(namespace);
	}
}

/** Run every open job (sync, ingest and link) to the end, oldest first. */
export async function drainAll(
	env: LinkEnv,
	limit = 1000,
): Promise<FollowUpJob[]> {
	const ran: FollowUpJob[] = [];
	while (env.sink.open.length > 0 && ran.length < limit) {
		const job = env.sink.open.shift() as FollowUpJob;
		ran.push(job);
		if (job.kind === "knowledge.sync-page") {
			await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
		} else if (job.kind === "knowledge.ingest-next") {
			await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
		} else {
			await runJob(env.db, env.link, env.link.schema.parse(job.payload));
		}
	}
	return ran;
}

/** One full scan, then everything it caused. */
export async function scanAndDrain(env: LinkEnv): Promise<FollowUpJob[]> {
	await runJob(env.db, env.sync, {
		scanId: randomUUID(),
		cursor: null,
		page: 0,
	});
	return drainAll(env);
}

export const linkPayload = (sweep: number): LinkNextPayload => ({ sweep });
