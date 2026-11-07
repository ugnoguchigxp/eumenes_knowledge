import type {
	Clock,
	InferencePort,
	InferenceRequest,
	InferenceResult,
	InferenceUsage,
} from "../../src/contracts/index.js";
import { abortError, createGate } from "./gate.js";

/**
 * A scripted `InferencePort`. The answer is chosen by the scenario ID and the order of calls
 * only. The prompt is never read for meaning: the mock checks that the call is the one the
 * script expects (purpose, instruction id and version, whether an output schema is attached),
 * then returns the step's answer.
 */

export type ScriptedAnswer =
	| {
			text: string;
			model?: string | null;
			usage?: Partial<InferenceUsage>;
	  }
	| {
			/** Safe code (`/^[a-z][a-z0-9_]*$/`) returned as `{ok:false, error}`. */
			error: string;
			model?: string | null;
			usage?: Partial<InferenceUsage>;
	  };

export type ScriptedStep = {
	expect: {
		purpose: string;
		instructionId: string;
		instructionVersion: number;
		/** Whether the call must carry an `outputSchema`. Omit to accept either. */
		outputSchema?: boolean;
	};
	answer: ScriptedAnswer;
	/**
	 * Holds the call until `control.releaseHeld()` (a slow provider). An abort rejects it. The
	 * answer is returned after the release.
	 */
	hold?: boolean;
	/**
	 * Simulated elapsed milliseconds: reported as `durationMs` and handed to `advanceClock`, so
	 * an injected clock passes time without any real wait.
	 */
	delayMs?: number;
};

export type InferenceCallOutcome =
	| "pending"
	| "answered"
	| "error"
	| "unexpected_call"
	| "deadline_exceeded"
	| "aborted";

/** What is recorded about a call: lengths and identifiers only, never the prompt or the answer. */
export type InferenceCallRecord = {
	callIndex: number;
	scenarioId: string | null;
	/** The consumed step, or null when the call consumed none. */
	stepIndex: number | null;
	purpose: string;
	instructionId: string;
	instructionVersion: number;
	promptBytes: number;
	systemBytes: number;
	hasOutputSchema: boolean;
	outcome: InferenceCallOutcome;
	/** Why an unexpected call was refused. */
	reason?: "no_scenario" | "script_exhausted" | "mismatch";
};

export type ScriptedInferenceOptions = {
	scenarios: Readonly<Record<string, readonly ScriptedStep[]>>;
	/** The scenario in force from the start. Otherwise call `control.useScenario`. */
	scenarioId?: string;
	clock: Clock;
	/** Called with a step's `delayMs`; a test clock advances here. */
	advanceClock?(ms: number): void;
};

export type ScriptedInferenceControl = {
	/** Selects a scenario and restarts its script from the first step. */
	useScenario(id: string): void;
	calls(): readonly InferenceCallRecord[];
	/** Steps of the current scenario not consumed yet. */
	remaining(): number;
	releaseHeld(): number;
	heldCount(): number;
	whenHeld(n?: number): Promise<void>;
};

const SAFE_CODE = /^[a-z][a-z0-9_]*$/;
const noUsage: InferenceUsage = {
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
};

function failure(error: string, durationMs = 0): InferenceResult {
	return { ok: false, error, model: null, usage: { ...noUsage }, durationMs };
}

export function createScriptedInference(options: ScriptedInferenceOptions): {
	port: InferencePort;
	control: ScriptedInferenceControl;
} {
	for (const steps of Object.values(options.scenarios))
		for (const step of steps)
			if ("error" in step.answer && !SAFE_CODE.test(step.answer.error))
				throw new Error("invalid_error_code");

	const calls: InferenceCallRecord[] = [];
	const gate = createGate();
	let scenarioId: string | null = null;
	let position = 0;

	function useScenario(id: string): void {
		if (!Object.hasOwn(options.scenarios, id))
			throw new Error("unknown_scenario");
		scenarioId = id;
		position = 0;
	}
	if (options.scenarioId !== undefined) useScenario(options.scenarioId);

	const encoder = new TextEncoder();

	async function complete(
		request: InferenceRequest,
		signal: AbortSignal,
	): Promise<InferenceResult> {
		const record: InferenceCallRecord = {
			callIndex: calls.length,
			scenarioId,
			stepIndex: null,
			purpose: request.purpose,
			instructionId: request.instructionId,
			instructionVersion: request.instructionVersion,
			promptBytes: encoder.encode(request.prompt).byteLength,
			systemBytes:
				request.system === undefined
					? 0
					: encoder.encode(request.system).byteLength,
			hasOutputSchema: request.outputSchema !== undefined,
			outcome: "pending",
		};
		calls.push(record);

		if (signal.aborted) {
			record.outcome = "aborted";
			throw abortError();
		}
		if (options.clock.now() > request.deadlineAtMs) {
			record.outcome = "deadline_exceeded";
			return failure("deadline_exceeded");
		}

		const steps =
			scenarioId === null ? undefined : options.scenarios[scenarioId];
		const step = steps?.[position];
		const reason: InferenceCallRecord["reason"] =
			steps === undefined
				? "no_scenario"
				: step === undefined
					? "script_exhausted"
					: step.expect.purpose !== request.purpose ||
						  step.expect.instructionId !== request.instructionId ||
						  step.expect.instructionVersion !== request.instructionVersion ||
						  (step.expect.outputSchema !== undefined &&
								step.expect.outputSchema !== record.hasOutputSchema)
						? "mismatch"
						: undefined;
		if (reason !== undefined || step === undefined) {
			record.outcome = "unexpected_call";
			record.reason = reason;
			return failure("unexpected_call");
		}

		record.stepIndex = position;
		position += 1;

		if (step.hold) {
			try {
				await gate.hold(signal);
			} catch (error) {
				record.outcome = "aborted";
				throw error;
			}
		}
		if (signal.aborted) {
			record.outcome = "aborted";
			throw abortError();
		}
		const durationMs = step.delayMs ?? 0;
		if (durationMs > 0) options.advanceClock?.(durationMs);

		const answer = step.answer;
		const usage = { ...noUsage, ...answer.usage };
		const model = answer.model ?? null;
		if ("error" in answer) {
			record.outcome = "error";
			return { ok: false, error: answer.error, model, usage, durationMs };
		}
		record.outcome = "answered";
		return { ok: true, text: answer.text, model, usage, durationMs };
	}

	return {
		port: { complete },
		control: {
			useScenario,
			calls: () => calls,
			remaining() {
				const steps =
					scenarioId === null ? undefined : options.scenarios[scenarioId];
				return steps ? steps.length - position : 0;
			},
			releaseHeld: () => gate.release(),
			heldCount: () => gate.count(),
			whenHeld: (n) => gate.whenHeld(n),
		},
	};
}
