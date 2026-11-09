import { z } from "zod";

/**
 * What one document version is turned into (p2.md §2, §4, §5). Byte ranges are always offsets
 * into the UTF-8 bytes of the exact Markdown body (BOM included), never UTF-16 string indexes.
 */

/** Upper bound of one fragment in UTF-8 bytes (p0.md #3). */
export const MAX_FRAGMENT_BYTES = 2048;

/**
 * One fragment of a document version. Fragments do not overlap and cover the body without gaps:
 * concatenating `text` in ordinal order gives the body back, and
 * `bytes.subarray(byteStart, byteEnd)` decodes to `text`.
 */
export type Fragment = {
	ordinal: number;
	byteStart: number;
	byteEnd: number;
	/** Titles of the enclosing Markdown headings, outermost first (structure only, no meaning). */
	headingPath: readonly string[];
	text: string;
};

// ---------------------------------------------------------------------------
// Extraction output (the model's answer for one fragment). Strict: unknown keys, too many
// items and too long strings are an invalid answer, never silently cut (p2.md §4).
// ---------------------------------------------------------------------------

export const EXTRACTION_LIMITS = {
	entities: 40,
	relations: 60,
	evidencePerItem: 4,
	nameChars: 200,
	typeChars: 80,
	relationChars: 120,
	descriptionChars: 1000,
	quoteChars: 400,
	keywords: 10,
	keywordChars: 60,
	conditionChars: 300,
	/** An identity key (`VerifiedEntity.key`). */
	keyChars: 400,
} as const;

const L = EXTRACTION_LIMITS;
const text = (max: number) => z.string().min(1).max(max);
const entityId = z.string().regex(/^e[0-9]{1,3}$/);
const relationId = z.string().regex(/^r[0-9]{1,3}$/);
/** A contiguous quotation of the fragment's original text. */
const quote = text(L.quoteChars);

export const extractionEntitySchema = z.strictObject({
	id: entityId,
	/** As written in the document. */
	name: text(L.nameChars),
	/** Short free description of what the entity is. */
	type: text(L.typeChars),
	description: text(L.descriptionChars),
	evidence: z.array(quote).min(1).max(L.evidencePerItem),
});

/** Conditions, negation and certainty as the model states them; never dropped (plan §5.1). */
export const extractionQualifiersSchema = z.strictObject({
	negated: z.boolean(),
	condition: z.string().min(1).max(L.conditionChars).nullable(),
	certainty: z.enum(["stated", "uncertain", "hypothetical"]),
});

export const extractionRelationSchema = z.strictObject({
	id: relationId,
	source: entityId,
	target: entityId,
	/** False when the text gives no direction (LightRAG's default is undirected). */
	directed: z.boolean(),
	/** Short free description of the relation. */
	relation: text(L.relationChars),
	description: text(L.descriptionChars),
	keywords: z.array(text(L.keywordChars)).max(L.keywords),
	qualifiers: extractionQualifiersSchema,
	evidence: z.array(quote).min(1).max(L.evidencePerItem),
});

export const extractionOutputSchema = z.strictObject({
	entities: z.array(extractionEntitySchema).max(L.entities),
	relations: z.array(extractionRelationSchema).max(L.relations),
});
export type ExtractionEntity = z.infer<typeof extractionEntitySchema>;
export type ExtractionRelation = z.infer<typeof extractionRelationSchema>;
export type ExtractionQualifiers = z.infer<typeof extractionQualifiersSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// ---------------------------------------------------------------------------
// Verified extraction (what is stored)
// ---------------------------------------------------------------------------

/** Where a quotation was found: located mechanically in the fragment, never taken from the model. */
export type EvidenceRange = {
	fragmentOrdinal: number;
	byteStart: number;
	byteEnd: number;
	/** sha256 of the quoted UTF-8 bytes. */
	quoteSha256: string;
	/**
	 * The quotation occurs more than once in the fragment. A model's quotation is located at the
	 * first occurrence; the model-free extractor's at the occurrence it quotes.
	 */
	ambiguous: boolean;
};

export type VerifiedEntity = Omit<ExtractionEntity, "evidence"> & {
	evidence: EvidenceRange[];
	/**
	 * The identity key the model-free extractor gives (kg2.md §3.3): the tokenizer's normalized
	 * forms joined, NFKC, lower case, white space removed. Mentions of one namespace with the same
	 * key are one entity when read. Absent for a model's extraction (the model's links decide).
	 */
	key?: string;
};
export type VerifiedRelation = Omit<ExtractionRelation, "evidence"> & {
	evidence: EvidenceRange[];
};

/** Why an element or a quotation of an answer was dropped (codes only). */
export const extractionDropReasons = [
	/** The quotation does not occur in the fragment's text. */
	"not_in_fragment",
	/** No quotation of the element survived. */
	"no_evidence",
	/** A relation names an entity id the answer does not define. */
	"unknown_entity",
	/** Two elements share an id. */
	"duplicate_id",
	/** Beyond a fragment's limit of the model-free extractor (kg2.md G3), or too far apart to quote. */
	"over_limit",
] as const;
export type ExtractionDropReason = (typeof extractionDropReasons)[number];

/** The checked result of one fragment. */
export type FragmentExtraction =
	| {
			fragmentOrdinal: number;
			status: "ok";
			entities: VerifiedEntity[];
			relations: VerifiedRelation[];
			dropped: { reason: ExtractionDropReason; count: number }[];
			model: string | null;
	  }
	| {
			fragmentOrdinal: number;
			/** The answer was missing, not JSON, or broke the schema; nothing of it is kept. */
			status: "failed";
			errorCode: string;
			model: string | null;
	  };

// ---------------------------------------------------------------------------
// Identity links and summaries (p3.md §8; p0.md #2, #5). The code narrows candidates
// mechanically; whether two mentions are the same entity is the model's judgment.
// ---------------------------------------------------------------------------

export const LINK_LIMITS = {
	/** Candidates shown with one mention in one call. */
	candidatesPerCall: 10,
	summaryChars: 1500,
} as const;

/** The model's answer for one mention and its numbered candidates (`c1`, `c2`, ...). */
export const linkAnswerSchema = z.strictObject({
	decisions: z
		.array(
			z.strictObject({
				candidate: z.string().regex(/^c[0-9]{1,3}$/),
				decision: z.enum(["same", "different", "unsure"]),
			}),
		)
		.max(LINK_LIMITS.candidatesPerCall),
});
export type LinkAnswer = z.infer<typeof linkAnswerSchema>;

/** The model's summary of one entity's mentions (derived data, never a source). */
export const summaryAnswerSchema = z.strictObject({
	summary: z.string().min(1).max(LINK_LIMITS.summaryChars),
});
export type SummaryAnswer = z.infer<typeof summaryAnswerSchema>;
