import { describe, expect, test } from "bun:test";
import type { Clock, InferenceRequest } from "../../src/contracts/index.js";
import { createScriptedInference, type ScriptedStep } from "./inference.js";

function manualClock(start = 1_000): Clock & { advance(ms: number): void } {
	let now = start;
	return {
		now: () => now,
		advance(ms) {
			now += ms;
		},
	};
}

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
	purpose: "extract",
	instructionId: "extract-entities",
	instructionVersion: 1,
	prompt: "PROMPT-TEXT-MARKER 日本語",
	outputSchema: { type: "object" },
	deadlineAtMs: 10_000,
	...over,
});
const signal = () => new AbortController().signal;

const extractStep: ScriptedStep = {
	expect: {
		purpose: "extract",
		instructionId: "extract-entities",
		instructionVersion: 1,
		outputSchema: true,
	},
	answer: { text: '{"entities":[]}', model: "scripted-1" },
};
const summarizeStep: ScriptedStep = {
	expect: {
		purpose: "summarize",
		instructionId: "summarize",
		instructionVersion: 2,
	},
	answer: { error: "provider_failed" },
};

function setup(steps: readonly ScriptedStep[] = [extractStep, summarizeStep]) {
	const clock = manualClock();
	const mock = createScriptedInference({
		scenarios: { one: steps, empty: [] },
		scenarioId: "one",
		clock,
		advanceClock: (ms) => clock.advance(ms),
	});
	return { ...mock, clock };
}

describe("scripted inference", () => {
	test("answers by order, with null usage unless the step states it", async () => {
		const { port, control } = setup();
		const first = await port.complete(request(), signal());
		expect(first).toEqual({
			ok: true,
			text: '{"entities":[]}',
			model: "scripted-1",
			usage: {
				inputTokens: null,
				cachedTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				calls: null,
			},
			durationMs: 0,
		});
		const second = await port.complete(
			request({
				purpose: "summarize",
				instructionId: "summarize",
				instructionVersion: 2,
				outputSchema: undefined,
			}),
			signal(),
		);
		expect(second).toMatchObject({ ok: false, error: "provider_failed" });
		expect(control.remaining()).toBe(0);
		expect(control.calls().map((c) => c.outcome)).toEqual([
			"answered",
			"error",
		]);
	});

	test("the answer does not depend on the prompt", async () => {
		const a = setup();
		const b = setup();
		const x = await a.port.complete(request({ prompt: "alpha" }), signal());
		const y = await b.port.complete(
			request({ prompt: "完全に別の文" }),
			signal(),
		);
		expect(x).toEqual(y);
	});

	test("an out-of-order or mismatching call is unexpected_call and consumes nothing", async () => {
		const { port, control } = setup();
		const cases: Partial<InferenceRequest>[] = [
			{ purpose: "summarize" },
			{ instructionId: "other" },
			{ instructionVersion: 2 },
			{ outputSchema: undefined },
		];
		for (const over of cases) {
			const result = await port.complete(request(over), signal());
			expect(result).toMatchObject({ ok: false, error: "unexpected_call" });
		}
		expect(control.remaining()).toBe(2);
		expect(control.calls().every((c) => c.reason === "mismatch")).toBe(true);
		// the right call still gets step 0
		expect((await port.complete(request(), signal())).ok).toBe(true);
	});

	test("exceeding the script, no scenario and unknown scenarios are refused", async () => {
		const { port, control } = setup([extractStep]);
		await port.complete(request(), signal());
		const extra = await port.complete(request(), signal());
		expect(extra).toMatchObject({ ok: false, error: "unexpected_call" });
		expect(control.calls().at(-1)?.reason).toBe("script_exhausted");

		const bare = createScriptedInference({
			scenarios: { s: [extractStep] },
			clock: manualClock(),
		});
		expect(await bare.port.complete(request(), signal())).toMatchObject({
			error: "unexpected_call",
		});
		expect(bare.control.calls()[0]?.reason).toBe("no_scenario");
		expect(() => bare.control.useScenario("missing")).toThrow(
			"unknown_scenario",
		);
		bare.control.useScenario("s");
		expect((await bare.port.complete(request(), signal())).ok).toBe(true);
		// selecting again restarts the script
		bare.control.useScenario("s");
		expect(bare.control.remaining()).toBe(1);
	});

	test("a call past its deadline is deadline_exceeded and consumes no step", async () => {
		const { port, control, clock } = setup();
		clock.advance(9_001);
		const late = await port.complete(
			request({ deadlineAtMs: 10_000 }),
			signal(),
		);
		expect(late).toMatchObject({ ok: false, error: "deadline_exceeded" });
		expect(control.remaining()).toBe(2);
		// exactly at the deadline is still in time
		const onTime = await port.complete(
			request({ deadlineAtMs: 10_001 }),
			signal(),
		);
		expect(onTime.ok).toBe(true);
	});

	test("delayMs advances the injected clock and is reported", async () => {
		const { port, clock } = setup([{ ...extractStep, delayMs: 5_000 }]);
		const before = clock.now();
		const result = await port.complete(request(), signal());
		expect(result.durationMs).toBe(5_000);
		expect(clock.now()).toBe(before + 5_000);
	});

	test("a held call waits for release; abort rejects with AbortError", async () => {
		const { port, control } = setup([
			{ ...extractStep, hold: true },
			{ ...extractStep, hold: true },
		]);
		let settled = false;
		const first = port.complete(request(), signal()).then((r) => {
			settled = true;
			return r;
		});
		await control.whenHeld();
		expect(settled).toBe(false);
		expect(control.calls()[0]?.outcome).toBe("pending");
		control.releaseHeld();
		expect((await first).ok).toBe(true);

		const controller = new AbortController();
		const second = port.complete(request(), controller.signal);
		await control.whenHeld();
		controller.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(control.calls()[1]?.outcome).toBe("aborted");
		expect(control.heldCount()).toBe(0);
	});

	test("an already-aborted signal rejects before touching the script", async () => {
		const { port, control } = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			port.complete(request(), controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(control.remaining()).toBe(2);
	});

	test("calls record lengths and identifiers only", async () => {
		const { port, control } = setup();
		await port.complete(request({ system: "システム" }), signal());
		const record = control.calls()[0];
		expect(record).toMatchObject({
			purpose: "extract",
			instructionId: "extract-entities",
			instructionVersion: 1,
			promptBytes: new TextEncoder().encode("PROMPT-TEXT-MARKER 日本語").length,
			systemBytes: 12,
			hasOutputSchema: true,
			scenarioId: "one",
			stepIndex: 0,
		});
		expect(JSON.stringify(control.calls())).not.toContain("PROMPT-TEXT-MARKER");
	});

	test("an unsafe error code is rejected when the script is built", () => {
		expect(() =>
			createScriptedInference({
				scenarios: {
					bad: [{ ...extractStep, answer: { error: "Bad Code: with text" } }],
				},
				clock: manualClock(),
			}),
		).toThrow("invalid_error_code");
	});
});
