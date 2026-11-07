// Resolves where the CLI and the MCP server connect and with which token (p0.md #15, #16,
// mcp-cli.md 5.1). Nothing is read implicitly: the environment and the file reader are
// passed in, there is no default URL, and the host's data directory is never searched.

/** Shortest accepted token (Eumenes refuses shorter ones too). */
export const TOKEN_MIN_LENGTH = 24;

export const connectionConfigErrorCodes = [
	"connection_url_required",
	"connection_url_invalid",
	"connection_url_not_loopback",
	"connection_token_required",
	/** A token value and a token file were both given. */
	"connection_token_conflict",
	"connection_token_invalid",
	"connection_token_file_unreadable",
] as const;
export type ConnectionConfigErrorCode =
	(typeof connectionConfigErrorCodes)[number];

/** A bad connection setting. The message is the code; the URL, path and token never appear. */
export class ConnectionConfigError extends Error {
	override readonly name = "ConnectionConfigError";
	constructor(readonly code: ConnectionConfigErrorCode) {
		super(code);
	}
}

export type ConnectionSources = {
	/** Command line flags `--url` and `--token-file` (there is deliberately no `--token`). */
	flags?: {
		url?: string | undefined;
		tokenFile?: string | undefined;
	};
	/** Usually `process.env`; read keys: EUMENES_URL, EUMENES_API_TOKEN, EUMENES_API_TOKEN_FILE. */
	env: Readonly<Record<string, string | undefined>>;
	/** Reads a token file the user named. Injected so no path is touched without the caller. */
	readTokenFile: (path: string) => string | Promise<string>;
};

export type Connection = {
	/** Origin only, e.g. `http://127.0.0.1:8787`. */
	baseUrl: string;
	token: string;
};

const loopbackHosts = new Set(["127.0.0.1", "localhost"]);
const tokenPattern = new RegExp(`^[\\x21-\\x7e]{${TOKEN_MIN_LENGTH},}$`);

const present = (value: string | undefined): value is string =>
	value !== undefined && value !== "";

function resolveUrl(raw: string | undefined): string {
	if (!present(raw)) throw new ConnectionConfigError("connection_url_required");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConnectionConfigError("connection_url_invalid");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new ConnectionConfigError("connection_url_invalid");
	}
	if (!loopbackHosts.has(url.hostname)) {
		throw new ConnectionConfigError("connection_url_not_loopback");
	}
	return url.origin;
}

function checkToken(token: string): string {
	if (!tokenPattern.test(token)) {
		throw new ConnectionConfigError("connection_token_invalid");
	}
	return token;
}

/**
 * Flags win over the environment. A token file (flag or `EUMENES_API_TOKEN_FILE`) together with a
 * token value (`EUMENES_API_TOKEN`) is an error: no silent choice between two secrets.
 */
export async function resolveConnection(
	sources: ConnectionSources,
): Promise<Connection> {
	const { flags, env } = sources;
	const baseUrl = resolveUrl(flags?.url ?? env.EUMENES_URL);
	const tokenFile = present(flags?.tokenFile)
		? flags.tokenFile
		: env.EUMENES_API_TOKEN_FILE;
	const tokenValue = env.EUMENES_API_TOKEN;
	if (present(tokenFile) && present(tokenValue)) {
		throw new ConnectionConfigError("connection_token_conflict");
	}
	if (present(tokenFile)) {
		if (tokenFile.includes("\0")) {
			throw new ConnectionConfigError("connection_token_file_unreadable");
		}
		let content: string;
		try {
			content = await sources.readTokenFile(tokenFile);
		} catch {
			throw new ConnectionConfigError("connection_token_file_unreadable");
		}
		return { baseUrl, token: checkToken(content.trim()) };
	}
	if (present(tokenValue)) return { baseUrl, token: checkToken(tokenValue) };
	throw new ConnectionConfigError("connection_token_required");
}
