import { describe, expect, test } from "bun:test";
import {
	MAX_EMBED_BATCH,
	embeddingSpaceKey,
	type EmbeddingSpace,
} from "../../src/contracts/index.js";
import {
	createMeaninglessHashEmbedding,
	createScriptedEmbedding,
	createTableEmbedding,
	meaninglessHashVector,
} from "./embedding.js";

const space: EmbeddingSpace = {
	modelId: "synthetic-model",
	revision: "r1",
	artifactDigest: "d".repeat(64),
	dimension: 3,
	queryPrefix: "query: ",
	passagePrefix: "passage: ",
};
const signal = () => new AbortController().signal;

describe("embedding input rules (as the Eumenes provider)", () => {
	test("empty list, blank text and more than 64 texts are refused; 64 is accepted", async () => {
		const { port, control } = createMeaninglessHashEmbedding({ space });
		for (const texts of [[], ["ok", ""], ["ok", "  \n"], Array(65).fill("t")]) {
			await expect(port.embed(texts, "passage", signal())).rejects.toThrow(
				"invalid_embedding_input",
			);
		}
		const ok = await port.embed(
			Array(MAX_EMBED_BATCH).fill("t"),
			"passage",
			signal(),
		);
		expect(ok.vectors).toHaveLength(64);
		expect(control.calls().map((c) => c.outcome)).toEqual([
			"invalid_input",
			"invalid_input",
			"invalid_input",
			"invalid_input",
			"ok",
		]);
	});

	test("an aborted signal rejects with AbortError", async () => {
		const { port, control } = createMeaninglessHashEmbedding({ space });
		const controller = new AbortController();
		controller.abort();
		await expect(
			port.embed(["a"], "query", controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(control.calls()[0]?.outcome).toBe("aborted");
	});
});

describe("table embedding", () => {
	const table = {
		query: { 水路: [1, 0, 0] },
		passage: { 水路: [0, 1, 0], 堰: [0, 0, 1] },
	};

	test("returns the stated vector per kind, so query and passage differ", async () => {
		const { port } = createTableEmbedding({ space, table });
		expect((await port.embed(["水路"], "query", signal())).vectors).toEqual([
			[1, 0, 0],
		]);
		const passage = await port.embed(["水路", "堰"], "passage", signal());
		expect(passage.vectors).toEqual([
			[0, 1, 0],
			[0, 0, 1],
		]);
		expect(passage.space).toEqual(space);
	});

	test("an unmapped text throws a code without the text", async () => {
		const { port, control } = createTableEmbedding({ space, table });
		const error = await port
			.embed(["UNMAPPED-TEXT-MARKER"], "query", signal())
			.catch((e: Error) => e);
		expect((error as Error).message).toBe("unmapped_text");
		expect(control.calls()[0]?.outcome).toBe("unmapped_text");
		expect(JSON.stringify(control.calls())).not.toContain("UNMAPPED");
	});

	test("returned vectors are copies", async () => {
		const { port } = createTableEmbedding({ space, table });
		const a = await port.embed(["水路"], "passage", signal());
		a.vectors[0]?.fill(9);
		const b = await port.embed(["水路"], "passage", signal());
		expect(b.vectors).toEqual([[0, 1, 0]]);
	});
});

describe("scripted embedding", () => {
	test("steps answer by call order and check the expected kind and count", async () => {
		const { port, control } = createScriptedEmbedding({
			space,
			steps: [
				{
					expect: { kind: "passage", count: 2 },
					vectors: [
						[1, 0, 0],
						[0, 1, 0],
					],
				},
				{ expect: { kind: "query" }, vectors: [[0, 0, 1]] },
			],
		});
		await expect(port.embed(["a"], "passage", signal())).rejects.toThrow(
			"unexpected_call",
		);
		expect(
			(await port.embed(["a", "b"], "passage", signal())).vectors,
		).toHaveLength(2);
		expect((await port.embed(["q"], "query", signal())).vectors).toEqual([
			[0, 0, 1],
		]);
		await expect(port.embed(["x"], "query", signal())).rejects.toThrow(
			"unexpected_call",
		);
		expect(control.remaining()).toBe(0);
	});

	test("a wrong-dimension answer is returned as scripted unless checkResult is set", async () => {
		const steps = [{ vectors: [[1, 0]] }];
		const raw = createScriptedEmbedding({ space, steps });
		const result = await raw.port.embed(["a"], "passage", signal());
		expect(result.vectors[0]).toHaveLength(2);
		expect(result.space.dimension).toBe(3);

		const strict = createScriptedEmbedding({ space, steps, checkResult: true });
		await expect(strict.port.embed(["a"], "passage", signal())).rejects.toThrow(
			"invalid_embedding_result",
		);
		expect(strict.control.calls()[0]?.outcome).toBe("invalid_result");

		const count = createScriptedEmbedding({
			space,
			steps: [{ vectors: [[1, 0, 0]] }],
			checkResult: true,
		});
		await expect(
			count.port.embed(["a", "b"], "passage", signal()),
		).rejects.toThrow("invalid_embedding_result");
	});

	test("a step can report another space for one call", async () => {
		const changed: EmbeddingSpace = { ...space, revision: "r2" };
		const { port } = createScriptedEmbedding({
			space,
			steps: [
				{ vectors: [[1, 0, 0]], space: changed },
				{ vectors: [[1, 0, 0]] },
			],
		});
		const first = await port.embed(["a"], "passage", signal());
		const second = await port.embed(["a"], "passage", signal());
		expect(embeddingSpaceKey(first.space)).not.toBe(
			embeddingSpaceKey(second.space),
		);
		expect(second.space).toEqual(space);
	});

	test("hold waits for release and abort rejects", async () => {
		const { port, control } = createScriptedEmbedding({
			space,
			steps: [
				{ vectors: [[1, 0, 0]], hold: true },
				{ vectors: [[1, 0, 0]], hold: true },
			],
		});
		const first = port.embed(["a"], "passage", signal());
		await control.whenHeld();
		control.releaseHeld();
		expect((await first).vectors).toHaveLength(1);
		const controller = new AbortController();
		const second = port.embed(["a"], "passage", controller.signal);
		await control.whenHeld();
		controller.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(control.heldCount()).toBe(0);
	});
});

describe("space change and hash vectors", () => {
	test("setSpace changes the space of later calls (and the dimension of hash vectors)", async () => {
		const { port, control } = createMeaninglessHashEmbedding({ space });
		const before = await port.embed(["a"], "passage", signal());
		control.setSpace({ ...space, revision: "r2", dimension: 5 });
		const after = await port.embed(["a"], "passage", signal());
		expect(embeddingSpaceKey(before.space)).not.toBe(
			embeddingSpaceKey(after.space),
		);
		expect(before.vectors[0]).toHaveLength(3);
		expect(after.vectors[0]).toHaveLength(5);
		expect(control.space().revision).toBe("r2");
	});

	test("hash vectors are deterministic, unit length, and depend on the prefix", async () => {
		const v = meaninglessHashVector("x", 384);
		expect(v).toHaveLength(384);
		expect(v).toEqual(meaninglessHashVector("x", 384));
		expect(Math.hypot(...v)).toBeCloseTo(1, 10);
		expect(v).not.toEqual(meaninglessHashVector("y", 384));
		const { port } = createMeaninglessHashEmbedding({ space });
		const q = await port.embed(["same"], "query", signal());
		const p = await port.embed(["same"], "passage", signal());
		expect(q.vectors).not.toEqual(p.vectors);
		expect(() => meaninglessHashVector("x", 0)).toThrow("invalid_dimension");
	});

	test("calls record counts, never texts", async () => {
		const { port, control } = createMeaninglessHashEmbedding({ space });
		await port.embed(["TEXT-MARKER-1", "TEXT-MARKER-2"], "passage", signal());
		expect(control.calls()).toEqual([
			{
				callIndex: 0,
				kind: "passage",
				count: 2,
				stepIndex: null,
				outcome: "ok",
			},
		]);
	});
});
