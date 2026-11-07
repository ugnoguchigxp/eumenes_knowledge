// Pure checks shared by import-probe.ts and verify-package.ts. No file or process access here,
// so they can be tested with in-memory inputs.
import { dirname, resolve, sep } from "node:path";

export type ImportRef = { kind: string; path: string };

/** Static, dynamic (string literal) and require imports of a JS module, found by Bun's parser. */
export function scanImports(source: string): ImportRef[] {
	// The parser rejects a shebang line (bin files have one); blank it, keeping line numbers.
	const code = source.startsWith("#!") ? `//${source}` : source;
	return new Bun.Transpiler({ loader: "js" }).scanImports(code);
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export function bareName(spec: string): string {
	return spec.startsWith("@")
		? spec.split("/").slice(0, 2).join("/")
		: (spec.split("/")[0] as string);
}

const isBuiltin = (spec: string) =>
	spec.startsWith("node:") || spec.startsWith("bun:");

// --- tarball shape --------------------------------------------------------------------------

const allowedTarPath =
	/^package\/(dist\/.+|package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|distribution-manifest\.json)$/;
const forbiddenTarPath =
	/(^|\/)(src|examples|scripts|out|p0|spikes?|fixtures?|mocks?|node_modules|\.git)(\/|$)|\.(test|fixture)\.|mock|fixture/i;

/** Problems with the list of paths in a tgz (`tar -tzf` output). Empty when the shape is right. */
export function checkTarEntries(entries: readonly string[]): string[] {
	const problems: string[] = [];
	for (const entry of entries) {
		if (entry === "package/" || entry === "package/dist/") continue;
		if (entry.split("/").includes("..") || entry.startsWith("/")) {
			problems.push(`path escapes the package: ${entry}`);
		} else if (forbiddenTarPath.test(entry)) {
			problems.push(`forbidden path (source/test/example/p0): ${entry}`);
		} else if (!allowedTarPath.test(entry)) {
			problems.push(`path outside the allowed list: ${entry}`);
		}
	}
	for (const required of ["package/package.json", "package/LICENSE"]) {
		if (!entries.includes(required)) problems.push(`missing: ${required}`);
	}
	if (!entries.some((entry) => entry.startsWith("package/dist/"))) {
		problems.push("missing: package/dist/");
	}
	return problems;
}

// --- imports inside dist --------------------------------------------------------------------

export type DistModule = { path: string; source: string };

/**
 * Relative imports must stay inside `distRoot` and exist; bare imports must be declared
 * dependencies. `exists` answers for absolute file paths.
 */
export function checkDistImports(
	modules: readonly DistModule[],
	options: {
		distRoot: string;
		declared: ReadonlySet<string>;
		exists: (path: string) => boolean;
	},
): string[] {
	const problems: string[] = [];
	const inside = `${options.distRoot}${sep}`;
	for (const module of modules) {
		for (const { path: spec } of scanImports(module.source)) {
			if (spec.startsWith(".")) {
				const target = resolve(dirname(module.path), spec);
				if (!target.startsWith(inside)) {
					problems.push(
						`relative import leaves dist: ${module.path} -> ${spec}`,
					);
				} else if (!options.exists(target)) {
					problems.push(
						`relative import target missing: ${module.path} -> ${spec}`,
					);
				}
			} else if (!isBuiltin(spec) && !options.declared.has(bareName(spec))) {
				problems.push(`undeclared dependency: ${module.path} -> ${spec}`);
			}
		}
	}
	return problems;
}

// --- import graph of one public entry ---------------------------------------------------------

export type EntryRule = {
	name: string;
	/** Absolute path of the entry module. */
	file: string;
	/** Absolute directories this entry may not reach. */
	forbidDirs: readonly string[];
	/** Whether `node:` / `bun:` builtins may be imported: all (`true`), none (`false`) or the listed ones. */
	builtins: boolean | readonly string[];
};

export type ImportGraph = Map<string, ImportRef[] | null>;

/** Walks relative imports from `entry`. A module that cannot be read is recorded as `null`. */
export function buildImportGraph(
	entry: string,
	read: (path: string) => string | null,
	graph: ImportGraph = new Map(),
): ImportGraph {
	if (graph.has(entry)) return graph;
	const source = read(entry);
	if (source === null) {
		graph.set(entry, null);
		return graph;
	}
	const refs = scanImports(source);
	graph.set(entry, refs);
	for (const ref of refs) {
		if (ref.path.startsWith(".")) {
			buildImportGraph(resolve(dirname(entry), ref.path), read, graph);
		}
	}
	return graph;
}

/** Problems with an entry's import closure. Empty when it is allowed. */
export function checkEntryGraph(
	graph: ImportGraph,
	rule: EntryRule,
	allowedBare: ReadonlySet<string>,
	label: (path: string) => string = (path) => path,
): string[] {
	const problems: string[] = [];
	for (const [file, refs] of graph) {
		if (refs === null) {
			problems.push(`unreadable module ${label(file)}`);
			continue;
		}
		for (const dir of rule.forbidDirs) {
			if (file.startsWith(`${dir}${sep}`)) {
				problems.push(`reaches ${label(file)}`);
			}
		}
		for (const { path: spec } of refs) {
			if (spec.startsWith(".")) continue;
			if (isBuiltin(spec)) {
				// ESM named imports of builtins cannot be trapped at runtime, so this static rule is the
				// primary guard for entries that must stay free of fs/net/bun:sqlite.
				const allowed =
					rule.builtins === true ||
					(Array.isArray(rule.builtins) && rule.builtins.includes(spec));
				if (!allowed) problems.push(`builtin ${spec} in ${label(file)}`);
				continue;
			}
			if (!allowedBare.has(bareName(spec))) {
				problems.push(`undeclared import ${spec} in ${label(file)}`);
			}
		}
	}
	return problems;
}
