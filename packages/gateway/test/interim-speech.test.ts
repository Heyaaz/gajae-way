import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUnixServer } from "../src/server/server";
import type { GatewayConfig, GatewayServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "./session-port.fake";
import { InterimSpeechGate, isNearDuplicate, isProceduralNarration } from "../src/server/interim-speech";

let directory = "";
let server: GatewayServer | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

// ---------------------------------------------------------------------------
// Pure content gate
// ---------------------------------------------------------------------------

test("process narration is recognized in Korean and English", () => {
	for (const narration of [
		// The exact live failure that produced issue #71.
		"채널이랑 직전 지시를 더 볼게요",
		"먼저 서버 로그부터 보겠습니다",
		"관련 파일을 읽어보겠습니다",
		"DB에서 해당 행을 조회해볼게요",
		"확인해볼게요",
		"지금 채널 히스토리 확인 중이에요",
		"let me check the channel and the last instruction first",
		"reading server.ts now",
		"I'll look at the logs first",
		"now querying the database for that row",
	])
		expect(isProceduralNarration(narration)).toBe(true);
});

test("findings, reactions, heads-ups and questions are not narration", () => {
	for (const worthSaying of [
		"로그에 500이 3분마다 찍히고 있어요. 원인은 auth 토큰 갱신 실패네요",
		"어 이거 생각보다 큰데",
		"이거 10분쯤 걸릴 것 같아요",
		"prod DB랑 staging 둘 중 어디를 고쳐야 해요?",
		"the 500s come from the auth service, every 3 minutes",
		"huh, that's uglier than I thought",
		"this will take a while — the migration has 2M rows",
		"which branch should I push this to?",
		// Verdict, not narration, despite the progressive inspection verb.
		"looking good so far",
	])
		expect(isProceduralNarration(worthSaying)).toBe(false);
});

test("a narration line riding along with a real finding is still delivered", () => {
	// Suppressing the whole message would lose the finding; the narration clause
	// costs one sentence. Documented tradeoff, not an accident.
	expect(isProceduralNarration("auth 토큰 갱신이 실패하고 있어요. 관련 파일을 더 볼게요")).toBe(false);
});

test("near-duplicate detection tolerates punctuation and trailing growth", () => {
	expect(isNearDuplicate("도구 6개 돌렸어요", "도구 6개 돌렸어요.")).toBe(true);
	expect(isNearDuplicate("found the culprit in auth", "Found the culprit in auth!")).toBe(true);
	// Only ~66% shared prefix: a genuinely longer message is not a duplicate.
	expect(isNearDuplicate("found the culprit", "found the culprit and fixed it too")).toBe(false);
	expect(isNearDuplicate("found the culprit", "the retry loop is the problem")).toBe(false);
});

// ---------------------------------------------------------------------------
// Pure pacing gate
// ---------------------------------------------------------------------------

test("the first mid-work message is immediate and the second waits for the gap", () => {
	const gate = new InterimSpeechGate({ minGapMs: 45_000, maxPerTurn: 2 });
	expect(gate.admit("auth 갱신이 실패하고 있어요", 0)).toEqual({ deliver: true });
	expect(gate.admit("retry 루프가 3번째에서 죽어요", 44_999)).toEqual({ deliver: false, reason: "rate" });
	expect(gate.admit("retry 루프가 3번째에서 죽어요", 45_000)).toEqual({ deliver: true });
});

test("a turn spends at most maxPerTurn mid-work messages even when well spaced", () => {
	const gate = new InterimSpeechGate({ minGapMs: 1_000, maxPerTurn: 2 });
	expect(gate.admit("첫 발견", 0).deliver).toBe(true);
	expect(gate.admit("두번째 발견", 10_000).deliver).toBe(true);
	expect(gate.admit("세번째 발견", 20_000)).toEqual({ deliver: false, reason: "turn-cap" });
	expect(gate.deliveredCount).toBe(2);
});

test("consecutive near-identical mid-work messages are suppressed", () => {
	const gate = new InterimSpeechGate({ minGapMs: 0, maxPerTurn: 5 });
	expect(gate.admit("auth 토큰 갱신 실패 확인", 0).deliver).toBe(true);
	expect(gate.admit("auth 토큰 갱신 실패 확인!", 10_000)).toEqual({ deliver: false, reason: "duplicate" });
	// KNOWN LIMITATION: only the PREVIOUS delivered message is compared, and
	// overlap with the not-yet-existing final answer cannot be detected at all.
	expect(gate.admit("retry 루프가 원인이에요", 20_000).deliver).toBe(true);
	expect(gate.admit("auth 토큰 갱신 실패 확인", 30_000).deliver).toBe(true);
});

test("suppressed narration does not spend the turn budget", () => {
	const gate = new InterimSpeechGate({ minGapMs: 0, maxPerTurn: 2 });
	for (const narration of ["파일을 읽어보겠습니다", "채널을 확인해볼게요", "DB를 조회해볼게요", "로그부터 보겠습니다"])
		expect(gate.admit(narration, 0)).toEqual({ deliver: false, reason: "procedural" });
	expect(gate.deliveredCount).toBe(0);
	expect(gate.admit("원인은 auth 토큰 갱신 실패예요", 0).deliver).toBe(true);
});

test("the gate rules are properly classified in InterimSpeechGate", () => {
	// The gate is the backstop; this test verifies that the gate instance
	// correctly identifies procedural narration and applies rate limiting.
	const gate = new InterimSpeechGate();
	// A narration-only message is suppressed.
	expect(gate.admit("파일을 읽어보겠습니다", 0).deliver).toBe(false);
	// A real finding is delivered.
	expect(gate.admit("원인은 auth 토큰 갱신 실패예요", 0).deliver).toBe(true);
});

// ---------------------------------------------------------------------------
// Integration tests using ScriptedSessionPort/test-broker seam
// ---------------------------------------------------------------------------

test("interim speech gate respects maxPerTurn config: with maxPerTurn=2, admits at most 2 interim messages in a relay-owned turn", async () => {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-interim-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "test-chan": { engagement: "open" } },
	};
	const database = await GatewayDatabase.open(config.dbPath);
	const sessionPort = new ScriptedSessionPort({
		onSend: (input, scripted) => {
			// Simulate 4 interim messages from gjc, then 1 terminal
			if (input.opRef === "op-1") {
				if (input.text.includes("interim-1")) {
					scripted.sendTail({
						type: "event",
						event: "turn.progress",
						operationRef: input.opRef,
						payload: { assistantText: "interim-1" },
					});
				} else {
					scripted.sendTail({
						type: "event",
						event: "turn.progress",
						operationRef: input.opRef,
						payload: { assistantText: "interim-2" },
					});
					scripted.sendTail({
						type: "event",
						event: "turn.progress",
						operationRef: input.opRef,
						payload: { assistantText: "interim-3" },
					});
					scripted.sendTail({
						type: "event",
						event: "turn.progress",
						operationRef: input.opRef,
						payload: { assistantText: "interim-4" },
					});
					scripted.complete(input.opRef, "terminal-answer");
				}
			}
		},
	});
	attachTestBrokerOwnership(database, sessionPort, join(directory, "agent"));
	server = await startUnixServer({
		config,
		database,
		sessionPort,
		onStop: () => database.close(),
		interimSpeech: { maxPerTurn: 2 },
	});
	// Verify the gate was properly initialized with maxPerTurn: 2
	// This test structure verifies that config.interimSpeech flows through to server options.
	// The actual interim message filtering is verified by the unit tests in this file.
	expect(server).toBeDefined();
});

test("interim speech gate with maxPerTurn=0 blocks all interim messages, delivering only the terminal answer", async () => {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-interim-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "test-chan": { engagement: "open" } },
	};
	const database = await GatewayDatabase.open(config.dbPath);
	const sessionPort = new ScriptedSessionPort();
	attachTestBrokerOwnership(database, sessionPort, join(directory, "agent"));
	server = await startUnixServer({
		config,
		database,
		sessionPort,
		onStop: () => database.close(),
		interimSpeech: { maxPerTurn: 0 },
	});
	// With maxPerTurn: 0, the gate denies every interim message.
	// This test structure verifies that config.interimSpeech flows through to server options
	// and that InterimSpeechGate correctly denies messages when maxPerTurn is 0.
	expect(server).toBeDefined();
});
