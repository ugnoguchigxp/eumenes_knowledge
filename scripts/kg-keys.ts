// `bun scripts/kg-keys.ts --from <knowledge.db>`: the deterministic key graph of kg.md §8. No model
// is asked. It takes the extraction of an earlier run (its identity links and summaries are
// dropped), joins the mentions whose name keys are equal, reads the graph through the API, checks
// every quotation with the evidence API and evaluates the graph against expected.json. It counts
// the connections across documents (shared nodes, relation and co-occurrence pairs of nodes) for
// this graph and for the compared runs' databases, and lists pairs where the keys and a compared
// run's model decisions disagree, for a person to check.
//
// Keys (both: NFKC, lower case, white space removed):
//   nfkc     the name as written
//   sudachi  each morpheme replaced first by Sudachi's normalized form (SplitMode C, dictionary
//            core; scripts/kg-keys/sudachi.py through `uv`, versions pinned in SUDACHI)
// With --rules, the name is first cleaned by RULES (kg.md §8.6; scripts/kg-keys/names.ts): a
// leading list number, code marks in full-width brackets such as （E5）, and 約 before a number.
//
// Options:
//   --from <file>      knowledge.db of an earlier run (required): its extraction is used
//   --key nfkc|sudachi (default sudachi)
//   --compare <file>   knowledge.db of an earlier run on the same extraction (repeatable)
//   --corpus <name>    the corpus under examples/corpus the run ingested (default ai-memory); its
//                      expected.json grades the graph
//   --out <dir>        output directory (default verification/kg-<corpus>/<UTC stamp>-keys-<key>)
//   --rules            clean names by RULES before the key (default off)
//   --import-same <file>  also take the `same` decisions of an earlier run on the same extraction
//                      between mentions whose keys differ (its `different` and `unsure` are not
//                      taken: equal keys stay joined); kg.md §8.8
//   --llm-merge attach|free  how the model's `same` (imported or voted) may join nodes: attach
//                      (default) only moves a single mention onto a node; free uses every pair
//   --vote dry|run     the local model's vote on contained names (kg.md §8.7; scripts/kg-keys/vote.ts):
//                      dry counts the questions only; run asks LARM (LARM_API_TOKEN,
//                      KG_LARM_BASE_URL, KG_LARM_PROFILE, KG_LARM_AUDIENCE, as kg-live.ts)
//   --samples <n>      disagreeing pairs listed per kind and compared run (default 20)
//   --judgments <file> a person's (or a first pass's) judgments of listed pairs, by entity ids:
//                      {"extraction": "…", "pairs": {"<a>-<b>": {"verdict": "キー"|"モデル"|"？",
//                      "note": "…", "names": ["…", "…"], "truth": "same"|"different"|null}}};
//                      filled into disagreements.md, and the keys are scored on the pairs' truth
//
// Writes graph.json, report.json, disagreements.md and knowledge.db (not committed) in --out.
// The copy of --from lives in a temporary directory that is removed at the end.
// Documents are synthetic research notes, never personal ones.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { createKnowledgeClient } from "../src/client/index.js";
import type {
	AccessContext,
	EmbeddingPort,
	InferencePort,
	StatusOptions,
} from "../src/contracts/index.js";
import {
	createVectorIndex,
	readEvidence,
	readGraph,
	readRelated,
	search,
} from "../src/core/index.js";
import { normalizeForSearch } from "../src/core/text/normalize.js";
import {
	migrations,
	readScanInSnapshot,
	readStatusInSnapshot,
} from "../src/sqlite/index.js";
import { recordLinkDecisionsInTransaction } from "../src/sqlite/links.js";
import { createExampleHost } from "../examples/host/index.js";
import { createDoclingMock } from "../examples/mocks/docling.js";
import { createDoclingSource } from "../examples/mocks/docling-source.js";
import { createLarm } from "../examples/larm/index.js";
import {
	buildVoteRequest,
	containmentCandidates,
	parseVote,
	profile,
	VOTE_INSTRUCTION,
	type VoteGroup,
} from "./kg-keys/vote.js";
import { RULES } from "./kg-keys/names.js";
import {
	accounted,
	type Link,
	type Mention,
	nodesOf,
	pairKey,
	readCurrentLinks,
	readMentions,
	sameNode,
	env,
	corpusDir,
	type CorpusDocument,
	checkEvidence,
	readGraphFitting,
	evaluate,
	fullGraph,
	type Expected,
	graphStats,
	largest,
	linkingStats,
	log,
	prepareRelink,
	ROOT,
	reportPath,
} from "./kg-common.js";

const SUDACHI = { sudachipy: "0.7.0", dictionary: "20261015" } as const;
const TOKEN = "kg-keys-token-0123456789abcdefghij";
const DOCLING_CREDENTIAL = "docling-mock-credential-0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The extraction is reused as it was: its last scan may be days old. */
const VERIFIED_WITHIN_MS = 365 * DAY_MS;
const PROVENANCE_INSTRUCTION = "keys";

type KeyKind = "nfkc" | "sudachi";
type MergePolicy = "attach" | "free";

type Options = {
	from: string;
	key: KeyKind;
	compare: string[];
	out: string | null;
	samples: number;
	judgments: string | null;
	rules: boolean;
	vote: "off" | "dry" | "run";
	importSame: string | null;
	llmMerge: MergePolicy;
	corpus: string;
};

function parseArgs(argv: readonly string[]): Options {
	let from: string | null = null;
	const options: Omit<Options, "from"> = {
		key: "sudachi",
		compare: [],
		out: null,
		samples: 20,
		judgments: null,
		rules: false,
		vote: "off",
		importSame: null,
		llmMerge: "attach",
		corpus: "ai-memory",
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--rules") {
			options.rules = true;
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`missing value for ${flag}`);
		if (flag === "--from") from = resolve(value);
		else if (flag === "--key" && (value === "nfkc" || value === "sudachi"))
			options.key = value;
		else if (flag === "--compare") options.compare.push(resolve(value));
		else if (flag === "--out") options.out = resolve(value);
		else if (flag === "--samples") options.samples = Number(value);
		else if (flag === "--judgments") options.judgments = resolve(value);
		else if (flag === "--import-same") options.importSame = resolve(value);
		else if (flag === "--llm-merge" && (value === "attach" || value === "free"))
			options.llmMerge = value;
		else if (flag === "--vote" && (value === "dry" || value === "run"))
			options.vote = value;
		else if (flag === "--corpus" && /^[a-z0-9-]+$/.test(value))
			options.corpus = value;
		else throw new Error(`unknown option ${flag}`);
		i++;
	}
	if (!from) throw new Error("--from <knowledge.db> is required");
	// attach is checked within one set of pairs: imported and voted pairs are not mixed in one run.
	if (options.importSame && options.vote === "run")
		throw new Error("--import-same and --vote run are not used together");
	if (!Number.isSafeInteger(options.samples) || options.samples < 0)
		throw new Error("invalid --samples");
	for (const file of [
		from,
		...options.compare,
		...(options.judgments ? [options.judgments] : []),
		...(options.importSame ? [options.importSame] : []),
	])
		if (!existsSync(file))
			throw new Error(`no such database: ${basename(file)}`);
	return { from, ...options };
}

// ---------------------------------------------------------------------------
// Mentions and keys
// ---------------------------------------------------------------------------

/** NFKC, lower case, white space removed. */
const squash = (s: string): string =>
	normalizeForSearch(s).replace(/\s+/gu, "");

async function sudachiForms(
	names: readonly string[],
	cwd: string,
): Promise<string[]> {
	const proc = Bun.spawn(
		[
			"uv",
			"run",
			"--no-project",
			"--no-config",
			"--isolated",
			"--quiet",
			"--with",
			`sudachipy==${SUDACHI.sudachipy}`,
			"--with",
			`sudachidict_core==${SUDACHI.dictionary}`,
			"python",
			"-I",
			join(ROOT, "scripts/kg-keys/sudachi.py"),
		],
		{ cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	proc.stdin.write(JSON.stringify(names));
	await proc.stdin.end();
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`sudachi exited ${code}: ${err.slice(0, 400)}`);
	const forms = JSON.parse(out) as unknown;
	if (
		!Array.isArray(forms) ||
		forms.length !== names.length ||
		!forms.every((f) => typeof f === "string")
	)
		throw new Error("sudachi: unexpected output");
	return forms as string[];
}

async function keysOf(
	mentions: readonly Mention[],
	kind: KeyKind,
	rules: boolean,
	cwd: string,
): Promise<{ keys: Map<number, string>; cleaned: Map<number, string> }> {
	// The rules read the name as written (full-width brackets mark codes), then NFKC.
	const names = mentions.map((m) =>
		(rules ? RULES.apply(m.name) : m.name).normalize("NFKC"),
	);
	const forms = kind === "sudachi" ? await sudachiForms(names, cwd) : names;
	return {
		keys: new Map(mentions.map((m, i) => [m.id, squash(forms[i] ?? "")])),
		cleaned: new Map(mentions.map((m, i) => [m.id, names[i] ?? ""])),
	};
}

/**
 * Join the mentions of one namespace whose keys are equal: a `same` link from the first mention
 * of each key (entity id order) to every other one, and every current version marked compared.
 */
function writeKeyLinks(
	db: Database,
	mentions: readonly Mention[],
	keys: ReadonlyMap<number, string>,
	kind: KeyKind,
	now: number,
): { keys: number; joinedKeys: number; links: number } {
	const groups = new Map<string, number[]>();
	for (const m of mentions) {
		const key = keys.get(m.id) ?? "";
		if (key === "") continue;
		const group = `${m.namespace}\u0000${key}`;
		const list = groups.get(group);
		if (list) list.push(m.id);
		else groups.set(group, [m.id]);
	}
	const items = [...groups.values()].flatMap(([first, ...others]) =>
		others.map((otherId) => ({
			entityId: first as number,
			otherId,
			decision: "same" as const,
		})),
	);
	db.transaction(() => {
		recordLinkDecisionsInTransaction(
			db,
			items,
			{
				model: `keys:${kind}`,
				instructionId: PROVENANCE_INSTRUCTION,
				instructionVersion: 1,
			},
			now,
		);
		const versions = (
			db
				.query(
					"SELECT published_version_id AS v FROM knowledge_documents WHERE state = 'current' AND published_version_id IS NOT NULL",
				)
				.all() as { v: number }[]
		).map((r) => r.v);
		const mark = db.query(
			`INSERT INTO knowledge_link_versions (version_id, state, instruction_id, instruction_version, updated_at)
VALUES (?, 'done', ?, 1, ?)`,
		);
		for (const v of versions) mark.run(v, PROVENANCE_INSTRUCTION, now);
	})();
	return {
		keys: groups.size,
		joinedKeys: [...groups.values()].filter((g) => g.length >= 2).length,
		links: items.length,
	};
}

// ---------------------------------------------------------------------------
// Connections across documents (the same node rule as the graph read)
// ---------------------------------------------------------------------------

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const set = map.get(key);
	if (set) set.add(value);
	else map.set(key, new Set([value]));
}

/**
 * What connects documents, with nodes as the graph read makes them (`nodesOf`): nodes in two or
 * more documents, node pairs joined by a relation mention or by sharing a fragment, counted when
 * they occur in two or more documents.
 */
function connections(db: Database) {
	const { ms, of } = nodesOf(db);
	const docsOfNode = new Map<number, Set<string>>();
	const sizeOfNode = new Map<number, number>();
	ms.forEach((m, i) => {
		const node = of[i] as number;
		addTo(docsOfNode, node, m.documentId);
		sizeOfNode.set(node, (sizeOfNode.get(node) ?? 0) + 1);
	});
	const multiDocument = (node: number) =>
		(docsOfNode.get(node)?.size ?? 0) >= 2;

	// Relation mentions, by the pair of nodes their two ends are in (relation names ignored).
	const byLocal = new Map(
		ms.map((m, i) => [`${m.versionId}:${m.fragment}:${m.localId}`, i]),
	);
	const relationRows = db
		.query(
			`SELECT r.version_id AS v, r.fragment_ordinal AS f, r.source_local_id AS s,
 r.target_local_id AS t, d.document_id AS doc
FROM knowledge_relation_mentions r
JOIN knowledge_documents d ON d.published_version_id = r.version_id AND d.state = 'current'`,
		)
		.all() as { v: number; f: number; s: string; t: string; doc: string }[];
	const relationPairs = new Map<string, Set<string>>();
	let relationsInsideNode = 0;
	for (const r of relationRows) {
		const a = byLocal.get(`${r.v}:${r.f}:${r.s}`);
		const b = byLocal.get(`${r.v}:${r.f}:${r.t}`);
		if (a === undefined || b === undefined) continue;
		const na = of[a] as number;
		const nb = of[b] as number;
		if (na === nb) relationsInsideNode++;
		else addTo(relationPairs, pairKey(na, nb), r.doc);
	}

	// Nodes named in one fragment, every pair of them (co-occurrence).
	const nodesOfFragment = new Map<
		string,
		{ doc: string; nodes: Set<number> }
	>();
	ms.forEach((m, i) => {
		const key = `${m.versionId}:${m.fragment}`;
		const entry = nodesOfFragment.get(key) ?? {
			doc: m.documentId,
			nodes: new Set(),
		};
		entry.nodes.add(of[i] as number);
		nodesOfFragment.set(key, entry);
	});
	const cooccurrence = new Map<string, Set<string>>();
	for (const { doc, nodes } of nodesOfFragment.values()) {
		const list = [...nodes];
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++)
				addTo(cooccurrence, pairKey(list[i] as number, list[j] as number), doc);
	}
	const across = (pairs: Map<string, Set<string>>) =>
		[...pairs.values()].filter((docs) => docs.size >= 2).length;

	// Shared nodes per pair of documents, and fragments that reach another document.
	const nameOf = new Map(
		ms.map((m) => [m.documentId, m.path.replace(/\.md$/, "")]),
	);
	const sharedByDocPair = new Map<string, number>();
	for (const docs of docsOfNode.values()) {
		const list = [...docs].sort();
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++) {
				const key = `${nameOf.get(list[i] as string)} / ${nameOf.get(list[j] as string)}`;
				sharedByDocPair.set(key, (sharedByDocPair.get(key) ?? 0) + 1);
			}
	}
	const fragments = [...nodesOfFragment.values()];
	return {
		mentions: ms.length,
		nodes: docsOfNode.size,
		singletonNodes: [...sizeOfNode.values()].filter((n) => n === 1).length,
		multiDocumentNodes: [...docsOfNode.keys()].filter(multiDocument).length,
		largestNode: largest(sizeOfNode.values()),
		relationMentionsInsideOneNode: relationsInsideNode,
		relationNodePairs: relationPairs.size,
		relationNodePairsAcrossDocuments: across(relationPairs),
		cooccurrenceNodePairs: cooccurrence.size,
		cooccurrenceNodePairsAcrossDocuments: across(cooccurrence),
		fragmentsWithMentions: fragments.length,
		fragmentsSharingANodeWithAnotherDocument: fragments.filter((f) =>
			[...f.nodes].some(multiDocument),
		).length,
		sharedNodesByDocumentPair: Object.fromEntries(
			[...sharedByDocPair].sort(([a], [b]) => a.localeCompare(b)),
		),
	};
}

// ---------------------------------------------------------------------------
// Where the keys and a compared run's model decisions disagree
// ---------------------------------------------------------------------------

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");
const cell = (s: string) =>
	s.replace(/\s+/gu, " ").replace(/\|/g, "\\|").trim();
const short = (s: string, n: number) =>
	[...s].length > n ? `${[...s].slice(0, n).join("")}…` : s;

/** At most `n` pairs, one per pair of keys, in a fixed pseudo-random order. */
function spread(
	links: readonly Link[],
	keys: ReadonlyMap<number, string>,
	n: number,
): Link[] {
	const byGroup = new Map<string, Link>();
	for (const l of [...links].sort((x, y) =>
		hashOf(pairKey(x.a, x.b)).localeCompare(hashOf(pairKey(y.a, y.b))),
	)) {
		const group = [keys.get(l.a), keys.get(l.b)].sort().join("\u0000");
		if (!byGroup.has(group)) byGroup.set(group, l);
	}
	return [...byGroup.values()].slice(0, n);
}

/**
 * The mentions of another run's database, which must be the same extraction (relink copies keep
 * the entity ids): ids, names, versions, fragments, local ids and documents all equal.
 */
function sameExtraction(
	db: Database,
	mentions: readonly Mention[],
	option: string,
): Mention[] {
	const theirs = readMentions(db);
	if (
		theirs.length !== mentions.length ||
		theirs.some((m, i) => {
			const o = mentions[i];
			return (
				!o ||
				m.id !== o.id ||
				m.name !== o.name ||
				m.versionId !== o.versionId ||
				m.fragment !== o.fragment ||
				m.localId !== o.localId ||
				m.documentId !== o.documentId
			);
		})
	)
		throw new Error(`${option}: not the same extraction as --from`);
	return theirs;
}

/** An empty key joins nothing (writeKeyLinks), so two empty keys are not equal keys. */
const keysEqual =
	(keys: ReadonlyMap<number, string>) =>
	(a: number, b: number): boolean => {
		const k = keys.get(a) ?? "";
		return k !== "" && k === keys.get(b);
	};

/**
 * Copies the `same` decisions of another run between mentions whose keys differ into the copy,
 * with their own provenance (kg.md §8.8). `different` and `unsure` are not copied.
 */
function importSame(
	dbFile: string,
	file: string,
	mentions: readonly Mention[],
	keys: ReadonlyMap<number, string>,
	policy: MergePolicy,
) {
	const source = new Database(file, { readonly: true });
	let links: (Link & { model: string | null; instruction: string })[];
	try {
		const theirs = sameExtraction(source, mentions, "--import-same");
		const provenance = new Map(
			(
				source
					.query(
						"SELECT entity_a AS a, entity_b AS b, model, instruction_id AS instruction FROM knowledge_entity_links",
					)
					.all() as {
					a: number;
					b: number;
					model: string | null;
					instruction: string;
				}[]
			).map((r) => [pairKey(r.a, r.b), r]),
		);
		const equal = keysEqual(keys);
		links = readCurrentLinks(source, theirs)
			.filter(
				(l) =>
					l.decision === "same" &&
					l.instruction !== PROVENANCE_INSTRUCTION &&
					!equal(l.a, l.b),
			)
			.map((l) => {
				const p = provenance.get(pairKey(l.a, l.b));
				return {
					...l,
					model: p?.model ?? null,
					instruction: p?.instruction ?? "link",
				};
			});
	} finally {
		source.close();
	}
	const offered = links.length;
	if (policy === "attach") {
		const keep = new Set(
			attachOnly(
				links.map((l) => [l.a, l.b] as const),
				mentions,
				keys,
			).map(([a, b]) => pairKey(a, b)),
		);
		links = links.filter((l) => keep.has(pairKey(l.a, l.b)));
	}
	const byProvenance = new Map<string, typeof links>();
	for (const l of links) {
		const k = JSON.stringify([l.model, l.instruction, l.version]);
		const list = byProvenance.get(k);
		if (list) list.push(l);
		else byProvenance.set(k, [l]);
	}
	const db = new Database(dbFile);
	try {
		db.transaction(() => {
			for (const list of byProvenance.values()) {
				const first = list[0] as (typeof links)[number];
				recordLinkDecisionsInTransaction(
					db,
					list.map((l) => ({
						entityId: l.a,
						otherId: l.b,
						decision: "same" as const,
					})),
					{
						model: first.model,
						instructionId: first.instruction,
						instructionVersion: first.version,
					},
					Date.now(),
				);
			}
		})();
	} finally {
		db.close();
	}
	return {
		from: reportPath(file),
		policy,
		sameAcrossKeys: offered,
		taken: links.length,
	};
}

/**
 * The model's `same` pairs a merge may use under the `attach` policy (kg.md §8.8): a pair is used
 * only when it joins a single mention (a key group of one, not attached yet) to another node, and
 * the other end is not itself a mention attached this way. Two nodes of several mentions are never
 * joined by the model, and no chain grows through an attached mention: a wrong pick misplaces one
 * mention. Pairs are taken in entity id order.
 */
function attachOnly(
	pairs: readonly (readonly [number, number])[],
	mentions: readonly Mention[],
	keys: ReadonlyMap<number, string>,
): (readonly [number, number])[] {
	const groupOf = new Map(
		mentions.map((m) => {
			const key = keys.get(m.id) ?? "";
			return [
				m.id,
				key === "" ? `id:${m.id}` : `${m.namespace}\u0000${key}`,
			] as const;
		}),
	);
	const size = new Map<string, number>();
	for (const g of groupOf.values()) size.set(g, (size.get(g) ?? 0) + 1);
	const attached = new Set<number>();
	const grown = new Set<string>();
	const single = (id: number) => {
		const g = groupOf.get(id) as string;
		return size.get(g) === 1 && !attached.has(id) && !grown.has(g);
	};
	const taken: (readonly [number, number])[] = [];
	for (const [a, b] of [...pairs].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
		// The single mention moves; prefer moving the later one when both are single.
		const mover = single(b) ? b : single(a) ? a : null;
		if (mover === null) continue;
		const target = mover === a ? b : a;
		if (attached.has(target)) continue;
		attached.add(mover);
		grown.add(groupOf.get(target) as string);
		taken.push([a, b]);
	}
	return taken;
}

function disagreements(
	db: Database,
	mentions: readonly Mention[],
	keys: ReadonlyMap<number, string>,
	samples: number,
) {
	const theirs = sameExtraction(db, mentions, "--compare");
	const links = readCurrentLinks(db, theirs);
	const equalKeys = keysEqual(keys);
	const counts = {
		keyEqual: { same: 0, different: 0, unsure: 0 },
		keyDiffer: { same: 0, different: 0, unsure: 0 },
	};
	for (const l of links)
		counts[equalKeys(l.a, l.b) ? "keyEqual" : "keyDiffer"][l.decision]++;
	const equalButDifferent = links.filter(
		(l) => l.decision === "different" && equalKeys(l.a, l.b),
	);
	const sameButDiffer = links.filter(
		(l) => l.decision === "same" && !equalKeys(l.a, l.b),
	);
	return {
		instructionVersions: [...new Set(links.map((l) => l.version))].sort(),
		counts,
		equalButDifferent: spread(equalButDifferent, keys, samples),
		sameButDiffer: spread(sameButDiffer, keys, samples),
	};
}

type Judgment = {
	verdict: string;
	note: string;
	names: [string, string];
	truth?: "same" | "different" | null;
};
type Judgments = { extraction: string; pairs: Record<string, Judgment> };

/** The judgments file, checked against the mentions (the names must match the entity ids). */
async function readJudgments(
	file: string,
	byId: ReadonlyMap<number, Mention>,
): Promise<Judgments> {
	const j = JSON.parse(await readFile(file, "utf8")) as Judgments;
	if (typeof j.extraction !== "string" || typeof j.pairs !== "object")
		throw new Error("--judgments: expected {extraction, pairs}");
	for (const [pair, v] of Object.entries(j.pairs)) {
		const [a, b] = pair.split("-").map(Number);
		if (
			!Number.isSafeInteger(a) ||
			!Number.isSafeInteger(b) ||
			(a as number) >= (b as number) ||
			byId.get(a as number)?.name !== v.names?.[0] ||
			byId.get(b as number)?.name !== v.names?.[1] ||
			!["キー", "モデル", "？", "票", "取込"].includes(v.verdict) ||
			![undefined, null, "same", "different"].includes(v.truth)
		)
			throw new Error(`--judgments: ${pair} does not match this extraction`);
	}
	return j;
}

/**
 * The final nodes scored on the judged pairs whose truth is known: a `same` pair should be in one
 * node, a `different` pair in two.
 */
function scoreOnJudgments(
	judgments: Judgments,
	together: (a: number, b: number) => boolean,
	byId: ReadonlyMap<number, Mention>,
) {
	const matrix = {
		same: { together: 0, apart: 0 },
		different: { together: 0, apart: 0 },
	};
	const wrong: {
		pair: string;
		names: string[];
		truth: string;
		together: boolean;
	}[] = [];
	for (const [pair, v] of Object.entries(judgments.pairs)) {
		if (v.truth !== "same" && v.truth !== "different") continue;
		const [a, b] = pair.split("-").map(Number) as [number, number];
		const joined = together(a, b);
		matrix[v.truth][joined ? "together" : "apart"]++;
		if (joined !== (v.truth === "same"))
			wrong.push({
				pair,
				names: [byId.get(a)?.name ?? "?", byId.get(b)?.name ?? "?"],
				truth: v.truth,
				together: joined,
			});
	}
	return { matrix, wrong };
}

// ---------------------------------------------------------------------------
// The local model's vote on contained names (kg.md §8.7)
// ---------------------------------------------------------------------------

const VOTE_TIMEOUT_MS = 2 * 60 * 1000;
const VOTE_RETRY_DELAY_MS = 10_000;
/** Stop when this many questions in a row get no answer (LARM down): nothing is written. */
const VOTE_MAX_FAILURES_IN_A_ROW = 5;

/**
 * Groups the mentions by key (an empty key is a group of its own), asks the model about every
 * group whose name contains other groups' names, and writes a `same` link for every pick.
 */
async function runVote(
	dbFile: string,
	mentions: readonly Mention[],
	keys: ReadonlyMap<number, string>,
	cleaned: ReadonlyMap<number, string>,
	mode: "dry" | "run",
	policy: MergePolicy,
	now: number,
) {
	const byGroup = new Map<string, VoteGroup>();
	for (const m of mentions) {
		const key = keys.get(m.id) ?? "";
		const group = key === "" ? `id:${m.id}` : `${m.namespace}\u0000${key}`;
		const member = {
			id: m.id,
			name: m.name,
			type: m.type,
			description: m.description,
			namespace: m.namespace,
			cleaned: cleaned.get(m.id) ?? m.name,
		};
		const g = byGroup.get(group);
		if (g) g.members.push(member);
		else byGroup.set(group, { members: [member] });
	}
	const groups = [...byGroup.values()];
	const questions = containmentCandidates(groups);
	const summary = {
		mode,
		instruction: VOTE_INSTRUCTION,
		groups: groups.length,
		questions: questions.length,
		candidatePairs: questions.reduce((s, q) => s + q.candidates.length, 0),
	};
	if (mode === "dry")
		return { ...summary, model: null, answers: null, picks: [] };

	const larm = createLarm({
		baseUrl: env("KG_LARM_BASE_URL"),
		token: env("LARM_API_TOKEN"),
		profile: env("KG_LARM_PROFILE"),
		audience: env("KG_LARM_AUDIENCE"),
		...(process.env.KG_LARM_PROVIDER_HOSTS
			? {
					providerHosts: process.env.KG_LARM_PROVIDER_HOSTS.split(",")
						.map((h) => h.trim())
						.filter(Boolean),
				}
			: {}),
		reasoning: "off",
		maxOutputTokens: 256,
	});
	const binding = await larm.describe(AbortSignal.timeout(30_000));
	log(`vote: LARM profile=${binding.profile} llm=${binding.llm.model}`);
	const inference = accounted(larm.inference);
	const text = await readFile(
		join(ROOT, `scripts/kg-keys/vote.v${VOTE_INSTRUCTION.version}.md`),
		"utf8",
	);
	const answers = { picked: 0, none: 0, invalid: 0, failed: 0 };
	const picks: { pair: string; item: string; picked: string }[] = [];
	const links: { entityId: number; otherId: number; decision: "same" }[] = [];
	const started = Date.now();
	let failedInARow = 0;
	for (const [n, q] of questions.entries()) {
		if (failedInARow >= VOTE_MAX_FAILURES_IN_A_ROW)
			throw new Error(
				`vote: ${failedInARow} questions failed in a row; stopped (nothing written)`,
			);
		const item = groups[q.item] as VoteGroup;
		const candidates = q.candidates.map((i) => groups[i] as VoteGroup);
		let result: Awaited<ReturnType<typeof inference.port.complete>> | null =
			null;
		for (let attempt = 0; attempt < 3 && !result?.ok; attempt++) {
			if (attempt > 0) await Bun.sleep(VOTE_RETRY_DELAY_MS);
			try {
				result = await inference.port.complete(
					buildVoteRequest(
						item,
						candidates,
						text,
						Date.now() + VOTE_TIMEOUT_MS,
					),
					AbortSignal.timeout(VOTE_TIMEOUT_MS),
				);
			} catch {
				result = null;
			}
		}
		if (!result?.ok) {
			answers.failed++;
			failedInARow++;
			continue;
		}
		failedInARow = 0;
		const choice = parseVote(result.text, candidates.length);
		if (choice === "invalid") answers.invalid++;
		else if (choice === null) answers.none++;
		else {
			const chosen = candidates[choice] as VoteGroup;
			answers.picked++;
			links.push({
				entityId: item.members[0]?.id as number,
				otherId: chosen.members[0]?.id as number,
				decision: "same",
			});
			picks.push({
				pair: pairKey(
					item.members[0]?.id as number,
					chosen.members[0]?.id as number,
				),
				item: profile(item).names[0] ?? "?",
				picked: profile(chosen).names[0] ?? "?",
			});
		}
		if ((n + 1) % 25 === 0)
			log(
				`vote: ${n + 1}/${questions.length} ${JSON.stringify(answers)} ${((Date.now() - started) / 60_000).toFixed(1)} min`,
			);
	}
	const taken =
		policy === "attach"
			? new Set(
					attachOnly(
						links.map((l) => [l.entityId, l.otherId] as const),
						mentions,
						keys,
					).map(([a, b]) => pairKey(a, b)),
				)
			: null;
	// One link per pair (two items may pick each other).
	const seen = new Set<string>();
	const used = links.filter((l) => {
		const k = pairKey(l.entityId, l.otherId);
		if (seen.has(k) || (taken && !taken.has(k))) return false;
		seen.add(k);
		return true;
	});
	const db = new Database(dbFile);
	try {
		db.transaction(() =>
			recordLinkDecisionsInTransaction(
				db,
				used,
				{
					model: binding.llm.model,
					instructionId: VOTE_INSTRUCTION.id,
					instructionVersion: VOTE_INSTRUCTION.version,
				},
				now,
			),
		)();
	} finally {
		db.close();
	}
	return {
		...summary,
		model: { profile: binding.profile, llm: binding.llm.model },
		minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
		policy,
		taken: used.length,
		answers,
		inference: inference.stats(),
		picks,
	};
}

function disagreementsMarkdown(
	kind: KeyKind,
	from: string,
	compared: { from: string; result: ReturnType<typeof disagreements> }[],
	byId: ReadonlyMap<number, Mention>,
	judgments: Judgments | null,
): string {
	const who = (id: number) => {
		const m = byId.get(id);
		if (!m) return "?";
		return `**${cell(m.name)}**（${cell(short(m.type, 24))}、${basename(m.path, ".md")}）: ${cell(short(m.description, 70))}`;
	};
	const lines = [
		"# 正規化キーとモデルの判断が食い違う組",
		"",
		`キーは \`${kind}\`（kg.md §8）。抽出は \`${from}\` のもの。比べた実行ごとに、キーが同じかどうかと、その実行のモデルの判断が食い違った組を、キーの組ごとに 1 組ずつ、決まった擬似乱数の順で並べる。`,
		"",
		"- 並ぶのはモデルが判断した組だけ。v3 はまとまりごとに 1 件しか問わないので、キーが同じでもモデルが判断していない組は多い。`unsure` の組は並べない。",
		"- 同じキーの組に食い違いが何組あっても、並ぶのは 1 組。数は表の全体の数と比べて読む。",
		judgments
			? `- 「判定」は \`--judgments\` の ${Object.keys(judgments.pairs).length} 組から: キー（キーが正しい）、モデル（モデルが正しい）、？（決められない。多くは文脈で意味の決まらない一般語）、票（ローカル LLM の票が選んだ組への判定）、取込（取り込んだ判断のうち使われた組への判定）。${judgments.extraction}`
			: "- 「判定」は空（`--judgments` で埋める）。",
		"",
	];
	const verdictOf = (l: Link) => {
		const v = judgments?.pairs[pairKey(l.a, l.b)];
		return v ? `${v.verdict}（${cell(v.note)}）` : "";
	};
	let n = 0;
	for (const { from: run, result } of compared) {
		const c = result.counts;
		lines.push(
			`## \`${run}\`（link v${result.instructionVersions.join("・")}）`,
			"",
			"| | same | different | unsure |",
			"| --- | --- | --- | --- |",
			`| キーが同じ | ${c.keyEqual.same} | ${c.keyEqual.different} | ${c.keyEqual.unsure} |`,
			`| キーが違う | ${c.keyDiffer.same} | ${c.keyDiffer.different} | ${c.keyDiffer.unsure} |`,
			"",
		);
		for (const [title, list, total] of [
			[
				"キーは同じ、モデルは different",
				result.equalButDifferent,
				c.keyEqual.different,
			],
			["キーは違う、モデルは same", result.sameButDiffer, c.keyDiffer.same],
		] as const) {
			lines.push(
				`### ${title}（全 ${total} 組から ${list.length} 組）`,
				"",
				"| # | 言及 A | 言及 B | 判定 |",
				"| --- | --- | --- | --- |",
			);
			for (const l of list)
				lines.push(`| ${++n} | ${who(l.a)} | ${who(l.b)} | ${verdictOf(l)} |`);
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const stubInference: InferencePort = {
	async complete() {
		throw new Error("kg-keys asks no model");
	},
};
const stubEmbedding: EmbeddingPort = {
	async embed() {
		throw new Error("kg-keys embeds nothing");
	},
};

/** Remove the temporary copy: only a `kg-relink-*` directory directly under the OS temp directory. */
async function removeCopy(dir: string): Promise<void> {
	const inside = relative(tmpdir(), dir);
	if (
		!isAbsolute(dir) ||
		inside.startsWith("..") ||
		inside.includes("/") ||
		!inside.startsWith("kg-relink-")
	)
		throw new Error("refusing to remove a directory outside the temp copy");
	await rm(dir, { recursive: true, force: true });
}

/** The report of the run that extracted (following relinks back), for the extraction's model. */
async function extractionReport(
	from: string,
): Promise<{ larm?: unknown; instructions?: { extract?: number } } | null> {
	let file = join(dirname(from), "report.json");
	for (let hop = 0; hop < 5 && existsSync(file); hop++) {
		const r = JSON.parse(await readFile(file, "utf8")) as {
			larm?: unknown;
			instructions?: { extract?: number };
			relinkedFrom?: string | null;
		};
		if (!r.relinkedFrom) return r;
		file = join(dirname(resolve(ROOT, r.relinkedFrom)), "report.json");
	}
	return null;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const started = Date.now();
	const copy = await prepareRelink(options.from, "--from");
	try {
		await run(options, started, copy);
	} finally {
		await removeCopy(copy.dir);
	}
}

async function run(
	options: Options,
	started: number,
	copy: Awaited<ReturnType<typeof prepareRelink>>,
) {
	const dbFile = join(copy.dir, "knowledge.db");

	// Keys and their links, written into the copy before the host opens it.
	const db = new Database(dbFile);
	let mentions: Mention[];
	let keys: Map<number, string>;
	let cleaned: Map<number, string>;
	let keyLinks: ReturnType<typeof writeKeyLinks>;
	try {
		mentions = readMentions(db);
		({ keys, cleaned } = await keysOf(
			mentions,
			options.key,
			options.rules,
			copy.dir,
		));
		keyLinks = writeKeyLinks(db, mentions, keys, options.key, started);
	} finally {
		db.close();
	}
	log(
		`keys=${options.key} mentions=${mentions.length} keys=${keyLinks.keys} joined=${keyLinks.joinedKeys} links=${keyLinks.links}`,
	);
	const imported = options.importSame
		? importSame(dbFile, options.importSame, mentions, keys, options.llmMerge)
		: null;
	if (imported) log(`imported same: ${JSON.stringify(imported)}`);
	const vote =
		options.vote === "off"
			? null
			: await runVote(
					dbFile,
					mentions,
					keys,
					cleaned,
					options.vote,
					options.llmMerge,
					started,
				);
	if (vote)
		log(
			`vote: ${vote.mode} questions=${vote.questions} candidatePairs=${vote.candidatePairs} answers=${JSON.stringify(vote.answers)}`,
		);

	const corpus: CorpusDocument[] = copy.documents.map((d) => ({
		file: basename(d.path),
		path: d.path,
		markdown: d.markdown,
	}));
	// The database must hold the documents of --corpus (its expected.json grades them).
	if (corpus.some((d) => !d.path.startsWith(`${options.corpus}/`)))
		throw new Error(
			`the documents are not of --corpus ${options.corpus} (pass the corpus the run used)`,
		);
	const expected = JSON.parse(
		await readFile(join(corpusDir(options.corpus), "expected.json"), "utf8"),
	) as Expected;
	const namespaces = [...new Set(copy.documents.map((d) => d.namespace))];
	const docling = createDoclingMock({
		documents: copy.documents,
		namespaces,
		pageSize: 100,
		credential: DOCLING_CREDENTIAL,
	});
	const source = createDoclingSource({
		fetch: (input, init) => docling.app.request(input, init),
		baseUrl: "http://docling.mock",
		credential: DOCLING_CREDENTIAL,
	});
	const principals: Record<string, AccessContext> = {
		[TOKEN]: { principal: "kg-keys", namespaces },
	};
	const statusOptions: StatusOptions = {
		verifiedWithinMs: VERIFIED_WITHIN_MS,
		maxUnappliedAttempts: 3,
		get binding() {
			return source.binding();
		},
	};
	const host = createExampleHost({
		dir: copy.dir,
		keep: true,
		source,
		principals,
		clock: { now: () => Date.now() },
		inference: stubInference,
		embedding: stubEmbedding,
		handlerFactories: [],
		readStatusInSnapshot,
		readScanInSnapshot,
		packageMigrations: migrations,
		statusOptions,
		search,
		readEvidence,
		readRelated,
		readGraph,
		createVectorIndex,
		searchOptions: {
			verifiedWithinMs: VERIFIED_WITHIN_MS,
			maxUnappliedAttempts: 3,
		},
	});
	await host.ready;
	const client = createKnowledgeClient({
		baseUrl: "http://example.host",
		token: TOKEN,
		fetch: async (input, init) => host.app.request(input, init),
	});
	const stamp = new Date(started)
		.toISOString()
		.replace(/[-:]/g, "")
		.slice(0, 15);
	const out =
		options.out ??
		join(
			ROOT,
			`verification/kg-${options.corpus}`,
			`${stamp}-keys-${options.key}${options.rules ? "-rules" : ""}${options.vote === "run" ? "-vote" : ""}`,
		);
	await mkdir(out, { recursive: true });
	try {
		const { graph, request: graphRequest } = await readGraphFitting(client);
		const evidence = await checkEvidence(client, graph);
		const documents = host.store.read(
			(d) =>
				d
					.query(
						"SELECT document_id, path, state FROM knowledge_documents ORDER BY path",
					)
					.all() as { document_id: string; path: string; state: string }[],
		);
		const docIdByPath = new Map(documents.map((d) => [d.path, d.document_id]));
		const evaluation = evaluate(graph, expected, corpus, docIdByPath);
		// The same evaluation on every name of every mention: the API answer has at most
		// namesPerNode names per node, so it can miss an alias in a large node (kg.md §8.8).
		const evaluationAllNames = host.store.read(
			(d) => evaluate(fullGraph(d), expected, corpus, docIdByPath).summary,
		);
		const store = host.store.read((d) => {
			const one = (sql: string) =>
				(d.query(sql).get() as { n: number } | null)?.n ?? 0;
			return {
				fragments: one("SELECT count(*) AS n FROM knowledge_fragments"),
				extractionsFailed: one(
					"SELECT count(*) AS n FROM knowledge_extractions WHERE status = 'failed'",
				),
				entityMentions: one(
					"SELECT count(*) AS n FROM knowledge_entity_mentions",
				),
				relationMentions: one(
					"SELECT count(*) AS n FROM knowledge_relation_mentions",
				),
				linksSame: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'same'",
				),
				linksDifferent: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'different'",
				),
				linksUnsure: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'unsure'",
				),
			};
		});
		const ownConnections = host.store.read((d) => connections(d));
		const together = host.store.read((d) => sameNode(d));
		const linking = host.store.read((d) => linkingStats(d));
		const status = await client.status();

		const compared = options.compare.map((file) => {
			const other = new Database(file, { readonly: true });
			try {
				return {
					from: reportPath(file),
					connections: connections(other),
					result: disagreements(other, mentions, keys, options.samples),
				};
			} finally {
				other.close();
			}
		});

		// The extraction's model, from the run that made it (for the viewer page).
		const sourceReport = await extractionReport(options.from);
		const byId = new Map(mentions.map((m) => [m.id, m]));
		const judgments = options.judgments
			? await readJudgments(options.judgments, byId)
			: null;
		const sample = (list: readonly Link[]) =>
			list.map((l) => ({
				pair: pairKey(l.a, l.b),
				names: [byId.get(l.a)?.name, byId.get(l.b)?.name],
				verdict: judgments?.pairs[pairKey(l.a, l.b)]?.verdict ?? null,
			}));
		const report = {
			kind: "kg-keys",
			note:
				vote?.mode === "run"
					? "Identity by equal normalized name keys on an earlier run's extraction, plus the local model's vote on contained names. A single run: not a benchmark."
					: "Identity by equal normalized name keys on an earlier run's extraction; no model is asked. A single run: not a benchmark.",
			startedAt: new Date(started).toISOString(),
			elapsedMinutes: Number(((Date.now() - started) / 60_000).toFixed(2)),
			finished: true,
			extractedIn: reportPath(options.from),
			relinkedFrom: null,
			key: options.key,
			sudachi: options.key === "sudachi" ? SUDACHI : null,
			rules: options.rules ? RULES.version : null,
			judged: judgments ? scoreOnJudgments(judgments, together, byId) : null,
			keyLinks,
			imported,
			vote,
			instructions: {
				extract: sourceReport?.instructions?.extract ?? null,
				link: null,
				summarize: null,
			},
			larm: sourceReport?.larm ?? null,
			documents: documents.map((d) => ({
				documentId: d.document_id,
				path: d.path,
				state: d.state,
			})),
			corpus: corpus.map((d) => ({
				path: d.path,
				bytes: Buffer.byteLength(d.markdown, "utf8"),
			})),
			inference: {},
			store,
			linking,
			status: {
				complete: status.complete,
				partialReasons: status.partialReasons,
			},
			graph: {
				request: graphRequest,
				complete: graph.complete,
				partialReasons: graph.partialReasons,
				...graphStats(graph),
			},
			evidence,
			evaluation,
			evaluationAllNames,
			connections: {
				keys: ownConnections,
				compared: compared.map((c) => ({ from: c.from, ...c.connections })),
			},
			disagreements: compared.map((c) => ({
				from: c.from,
				instructionVersions: c.result.instructionVersions,
				counts: c.result.counts,
				equalButDifferent: sample(c.result.equalButDifferent),
				sameButDiffer: sample(c.result.sameButDiffer),
			})),
		};
		// "wx": an earlier run's files are never overwritten.
		await writeFile(
			join(out, "graph.json"),
			`${JSON.stringify(graph, null, "\t")}\n`,
			{ flag: "wx" },
		);
		await writeFile(
			join(out, "report.json"),
			`${JSON.stringify(report, null, "\t")}\n`,
			{ flag: "wx" },
		);
		await writeFile(
			join(out, "disagreements.md"),
			disagreementsMarkdown(
				options.key,
				reportPath(options.from),
				compared.map((c) => ({ from: c.from, result: c.result })),
				byId,
				judgments,
			),
			{ flag: "wx" },
		);
		const snapshot = new Database(dbFile, { readonly: true });
		try {
			snapshot.run("VACUUM INTO ?", [join(out, "knowledge.db")]);
		} finally {
			snapshot.close();
		}
		log(
			`wrote ${reportPath(out)}: graph.json, report.json, disagreements.md, knowledge.db`,
		);
		log(`evaluation: ${JSON.stringify(evaluation.summary)}`);
		log(
			`connections: ${JSON.stringify({ ...ownConnections, sharedNodesByDocumentPair: undefined })}`,
		);
		log(`evidence: ${JSON.stringify(evidence)}`);
		if (judgments)
			log(
				`judged pairs: ${JSON.stringify(scoreOnJudgments(judgments, together, byId).matrix)}`,
			);
	} finally {
		await host.close();
	}
}

await main();
