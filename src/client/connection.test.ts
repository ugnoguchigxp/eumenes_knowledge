import { describe, expect, test } from "bun:test";
import {
	ConnectionConfigError,
	resolveConnection,
	TOKEN_MIN_LENGTH,
	type ConnectionConfigErrorCode,
	type ConnectionSources,
} from "./index.js";

const TOKEN = "a".repeat(64);
const SHORT = "a".repeat(TOKEN_MIN_LENGTH - 1);

const sources = (over: Partial<ConnectionSources> = {}): ConnectionSources => ({
	env: {},
	readTokenFile: () => {
		throw new Error("no file should be read");
	},
	...over,
});

const codeOf = async (
	input: ConnectionSources,
): Promise<ConnectionConfigErrorCode | "ok"> => {
	try {
		await resolveConnection(input);
		return "ok";
	} catch (error) {
		expect(error).toBeInstanceOf(ConnectionConfigError);
		return (error as ConnectionConfigError).code;
	}
};

describe("url", () => {
	test("is required: no default is embedded", async () => {
		expect(await codeOf(sources({ env: { EUMENES_API_TOKEN: TOKEN } }))).toBe(
			"connection_url_required",
		);
		expect(
			await codeOf(
				sources({
					flags: { url: "" },
					env: { EUMENES_URL: "", EUMENES_API_TOKEN: TOKEN },
				}),
			),
		).toBe("connection_url_required");
	});

	test("--url wins over EUMENES_URL; the result is the origin", async () => {
		const result = await resolveConnection(
			sources({
				flags: { url: "http://localhost:9000/" },
				env: { EUMENES_URL: "http://127.0.0.1:1", EUMENES_API_TOKEN: TOKEN },
			}),
		);
		expect(result.baseUrl).toBe("http://localhost:9000");
		const fromEnv = await resolveConnection(
			sources({
				env: { EUMENES_URL: "http://127.0.0.1:8787", EUMENES_API_TOKEN: TOKEN },
			}),
		);
		expect(fromEnv.baseUrl).toBe("http://127.0.0.1:8787");
	});

	test("only plain http(s) loopback origins are accepted", async () => {
		const env = { EUMENES_API_TOKEN: TOKEN };
		for (const url of [
			"nope",
			"ftp://127.0.0.1",
			"http://u:p@127.0.0.1",
			"http://127.0.0.1/x",
			"http://127.0.0.1/?q=1",
		]) {
			expect(await codeOf(sources({ flags: { url }, env }))).toBe(
				"connection_url_invalid",
			);
		}
		for (const url of [
			"http://example.com",
			"http://192.168.0.5:8787",
			"http://0.0.0.0",
		]) {
			expect(await codeOf(sources({ flags: { url }, env }))).toBe(
				"connection_url_not_loopback",
			);
		}
	});
});

describe("token", () => {
	const url = { flags: { url: "http://127.0.0.1:8787" } };

	test("comes from EUMENES_API_TOKEN", async () => {
		const result = await resolveConnection(
			sources({ ...url, env: { EUMENES_API_TOKEN: TOKEN } }),
		);
		expect(result.token).toBe(TOKEN);
	});

	test("is required", async () => {
		expect(await codeOf(sources({ ...url }))).toBe("connection_token_required");
		expect(
			await codeOf(sources({ ...url, env: { EUMENES_API_TOKEN: "" } })),
		).toBe("connection_token_required");
	});

	test("shorter than 24 characters, or with whitespace, is refused", async () => {
		expect(
			await codeOf(sources({ ...url, env: { EUMENES_API_TOKEN: SHORT } })),
		).toBe("connection_token_invalid");
		expect(
			await codeOf(
				sources({ ...url, env: { EUMENES_API_TOKEN: `${TOKEN} ` } }),
			),
		).toBe("connection_token_invalid");
		expect(
			await codeOf(
				sources({
					...url,
					env: { EUMENES_API_TOKEN: "a".repeat(TOKEN_MIN_LENGTH) },
				}),
			),
		).toBe("ok");
	});

	test("--token-file reads only the named path, and trims the trailing newline", async () => {
		const reads: string[] = [];
		const result = await resolveConnection(
			sources({
				flags: { ...url.flags, tokenFile: "/secrets/api.token" },
				readTokenFile: (path) => {
					reads.push(path);
					return `${TOKEN}\n`;
				},
			}),
		);
		expect(result.token).toBe(TOKEN);
		expect(reads).toEqual(["/secrets/api.token"]);
	});

	test("EUMENES_API_TOKEN_FILE works, and an async reader is awaited; --token-file wins over it", async () => {
		const reads: string[] = [];
		const read = async (path: string) => {
			reads.push(path);
			return TOKEN;
		};
		await resolveConnection(
			sources({
				...url,
				env: { EUMENES_API_TOKEN_FILE: "/from/env" },
				readTokenFile: read,
			}),
		);
		await resolveConnection(
			sources({
				flags: { ...url.flags, tokenFile: "/from/flag" },
				env: { EUMENES_API_TOKEN_FILE: "/from/env" },
				readTokenFile: read,
			}),
		);
		expect(reads).toEqual(["/from/env", "/from/flag"]);
	});

	test("a token file together with a token value is an error, and nothing is read", async () => {
		expect(
			await codeOf(
				sources({
					flags: { ...url.flags, tokenFile: "/f" },
					env: { EUMENES_API_TOKEN: TOKEN },
				}),
			),
		).toBe("connection_token_conflict");
		expect(
			await codeOf(
				sources({
					...url,
					env: { EUMENES_API_TOKEN: TOKEN, EUMENES_API_TOKEN_FILE: "/f" },
				}),
			),
		).toBe("connection_token_conflict");
	});

	test("an unreadable or short file is refused without naming the path or content", async () => {
		const failing = sources({
			flags: { ...url.flags, tokenFile: "/secret/path/api.token" },
			readTokenFile: () => {
				throw new Error("ENOENT /secret/path/api.token");
			},
		});
		expect(await codeOf(failing)).toBe("connection_token_file_unreadable");
		try {
			await resolveConnection(failing);
		} catch (error) {
			expect(String(error)).not.toContain("/secret/path");
		}
		expect(
			await codeOf(
				sources({
					flags: { ...url.flags, tokenFile: "/f" },
					readTokenFile: () => `${SHORT}\n`,
				}),
			),
		).toBe("connection_token_invalid");
		expect(
			await codeOf(
				sources({
					flags: { ...url.flags, tokenFile: "/f" },
					readTokenFile: () => "",
				}),
			),
		).toBe("connection_token_invalid");
		expect(
			await codeOf(sources({ flags: { ...url.flags, tokenFile: "/f\0x" } })),
		).toBe("connection_token_file_unreadable");
	});

	test("an invalid token never appears in the error", async () => {
		try {
			await resolveConnection(
				sources({ ...url, env: { EUMENES_API_TOKEN: "short secret" } }),
			);
		} catch (error) {
			expect(String(error)).not.toContain("secret");
		}
	});

	test("no other environment variable is consulted", async () => {
		const env = new Proxy(
			{
				EUMENES_URL: "http://127.0.0.1:8787",
				EUMENES_API_TOKEN: TOKEN,
			} as Record<string, string>,
			{
				get(target, key) {
					if (
						typeof key === "string" &&
						![
							"EUMENES_URL",
							"EUMENES_API_TOKEN",
							"EUMENES_API_TOKEN_FILE",
						].includes(key)
					) {
						throw new Error(`read of ${key}`);
					}
					return target[key as string];
				},
			},
		);
		expect((await resolveConnection(sources({ env }))).token).toBe(TOKEN);
	});
});
