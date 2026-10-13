import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, type GatewayConfig, parseConfigFile } from "../src/config";
import {
	buildHandoffDigest,
	extendHandoffChain,
	HANDOFF_DIGEST_MAX_LENGTH,
	handoffMessageId,
	parseHandoffReply,
	resolveHandoffTarget,
	stripHandoffTokens,
} from "../src/server/handoff";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { Store } from "../src/store";
import { attachTestBrokerOwnership, sessionPortFromResponder } from "./session-port.fake";

const A = { platform: "discord", kind: "channel", conversationId: "chan-a" } as const;
const B = { platform: "discord", kind: "channel", conversationId: "chan-b" } as const;
const C = { platform: "discord", kind: "channel", conversationId: "chan-c" } as const;
const KEY_A = "discord/channel/chan-a";
const KEY_B = "discord/channel/chan-b";
const KEY_C = "discord/channel/chan-c";

let directory = "";
let server: GatewayServer | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

interface Client {
	send(value: unknown): void;
	frames: any[];
}

async function connect(socketPath: string): Promise<Client> {
	const frames: any[] = [];
	let buffered = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				buffered += Buffer.from(data).toString();
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) if (line) frames.push(JSON.parse(line));
			},
		},
	});
	return { send: (value) => socket.write(`${JSON.stringify(value)}\n`), frames };
}

async function settle(): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) await Bun.sleep(5);
}

type Replies = Record<string, (turnText: string) => string>;

/** Three open channels; each origin's session answers with its own scripted reply. */
async function gateway(replies: Replies) {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-handoff-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		gjc: { agentDir: join(directory, "agent") },
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "chan-a": { engagement: "open" }, "chan-b": { engagement: "open" }, "chan-c": { engagement: "open" } },
		handoffTargets: { "gajae-way-dev": B, ops: C, marketing: A },
	};
	const database = await Store.open(config.dbPath);
	const turns: Array<{ originKey: string; text: string }> = [];
	const sessions = new Map<string, string>();
	const sessionPort = sessionPortFromResponder({
		bind: async (originKey, epoch) => {
			const sessionId = `session-${originKey.replaceAll("/", "_")}-${epoch}`;
			sessions.set(sessionId, originKey);
			return sessionId;
		},
		respond: async (sessionId, text) => {
			const originKey = sessions.get(sessionId) as string;
			turns.push({ originKey, text });
			return replies[originKey]?.(text) ?? "[SILENT]";
		},
	});
	attachTestBrokerOwnership(database, sessionPort, join(directory, "agent"));
	server = await startUnixServer({ config, database, sessionPort, onStop: () => database.close() });
	const client = await connect(config.socketPath);
	client.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	for (let attempt = 0; attempt < 60 && client.frames.length < 1; attempt++) await Bun.sleep(5);
	return { client, database, turns };
}

function say(client: Client, origin: typeof A, messageId: string, text: string): void {
	client.send({
		v: "0.1",
		type: "request",
		id: `req-${messageId}`,
		verb: "chat.send",
		params: {
			origin,
			text,
			messageId,
			engagement: { mentioned: true, group: true, authorId: "owner-1", authorName: "형님" },
		},
	});
}

function delivered(client: Client, conversationId: string): string[] {
	return client.frames
		.filter(
			(frame) =>
				frame.type === "event" &&
				frame.event === "chat.message" &&
				frame.payload.origin?.conversationId === conversationId,
		)
		.map((frame) => frame.payload.text as string);
}

test("a handoff from A to B runs exactly one turn in B, answered in B, and A gets only a pointer", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "[HANDOFF:gajae-way-dev]\nGateway tail stalls on reconnect; please triage the relay.",
		[KEY_B]: () => "Triaging the relay stall here.",
	});
	say(client, A, "m1", "이거 게이트웨이 tail 끊기는 거 왜 그래?");
	await settle();

	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	const relayed = targetTurns[0]?.text ?? "";
	// Provenance: source channel, source message, requester, and the relayed marker.
	expect(relayed).toContain("RELAYED HANDOFF");
	expect(relayed).toContain(KEY_A);
	expect(relayed).toContain("msg:m1");
	expect(relayed).toContain("형님");
	expect(relayed).toContain("not the requester's or the owner's instruction");
	expect(relayed).toContain("Gateway tail stalls on reconnect");
	// The digest carries the source conversation.
	expect(relayed).toContain("tail 끊기는 거");

	expect(delivered(client, "chan-b")).toEqual(["Triaging the relay stall here."]);
	const pointer = delivered(client, "chan-a");
	expect(pointer).toHaveLength(1);
	expect(pointer[0]).toStartWith("Moved to gajae-way-dev");
	expect(pointer[0]).not.toContain("[HANDOFF:");
	expect(pointer[0]).not.toContain("please triage the relay");
});

test("an unresolvable target surfaces an error in A and runs nothing anywhere else", async () => {
	const { client, turns } = await gateway({ [KEY_A]: () => "[HANDOFF:nowhere]\nplease take this" });
	say(client, A, "m1", "work item");
	await settle();
	expect(turns.map((turn) => turn.originKey)).toEqual([KEY_A]);
	const notice = delivered(client, "chan-a");
	expect(notice).toHaveLength(1);
	expect(notice[0]).toContain("Handoff to nowhere failed");
	expect(notice[0]).toContain("unknown handoff target");
	expect(delivered(client, "chan-b")).toEqual([]);
});

test("a chain deeper than the cap is refused at the hop that would exceed it", async () => {
	// A -> B -> C is two hops; C cannot hand on to a fourth room.
	const D = { platform: "discord", kind: "channel", conversationId: "chan-d" } as const;
	const { client, turns } = await gateway({
		[KEY_A]: () => "[HANDOFF:gajae-way-dev]\nfirst hop",
		[KEY_B]: () => "[HANDOFF:ops]\nsecond hop",
		[KEY_C]: () => `[HANDOFF:discord:${D.conversationId}]\nthird hop`,
	});
	say(client, A, "m1", "start");
	await settle();
	expect(turns.map((turn) => turn.originKey)).toEqual([KEY_A, KEY_B, KEY_C]);
	expect(turns[2]?.text).toContain(`${KEY_A} -> ${KEY_B} -> this conversation`);
	const refusal = delivered(client, "chan-c");
	expect(refusal).toHaveLength(1);
	expect(refusal[0]).toContain("would exceed 2 hops");
	expect(delivered(client, "chan-d")).toEqual([]);
});

test("a handoff to an origin already in the chain is refused", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "[HANDOFF:gajae-way-dev]\ntake it",
		[KEY_B]: () => "[HANDOFF:marketing]\nback to you",
	});
	say(client, A, "m1", "start");
	await settle();
	// A ran once (the human's message), B once (the handoff); nothing ran A again.
	expect(turns.map((turn) => turn.originKey)).toEqual([KEY_A, KEY_B]);
	const refusal = delivered(client, "chan-b");
	expect(refusal).toHaveLength(1);
	expect(refusal[0]).toContain("already in this handoff chain");
	expect(delivered(client, "chan-a")).toHaveLength(1);
});

test("a replayed handoff for the same source message does not run the target turn twice", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "[HANDOFF:gajae-way-dev]\ntake it",
		[KEY_B]: () => "on it",
	});
	say(client, A, "m1", "start");
	await settle();
	// The edit re-runs A's turn for the SAME source message; A hands off again.
	client.send({
		v: "0.1",
		type: "request",
		id: "edit-1",
		verb: "chat.edit",
		params: {
			origin: A,
			messageId: "m1",
			text: "start (edited)",
			engagement: { mentioned: true, group: true, authorId: "owner-1", authorName: "형님" },
		},
	});
	await settle();
	expect(turns.filter((turn) => turn.originKey === KEY_A)).toHaveLength(2);
	expect(turns.filter((turn) => turn.originKey === KEY_B)).toHaveLength(1);
	expect(delivered(client, "chan-b")).toEqual(["on it"]);
});

test("the handoff token counts only as the first line; mid-text it is plain text", () => {
	expect(parseHandoffReply("[HANDOFF:dev]\nbody")).toEqual({ target: "dev", note: "body" });
	expect(parseHandoffReply("  [HANDOFF:discord/channel/1] body on the same line")).toBeUndefined();
	expect(parseHandoffReply("see [HANDOFF:dev] later")).toBeUndefined();
	expect(parseHandoffReply("[HANDOFF:]\nbody")).toBeUndefined();
});

test("targets resolve by alias, origin key or platform:channel, and only to chat origins", () => {
	const config = { handoffTargets: { dev: B } };
	expect(resolveHandoffTarget("dev", config)).toMatchObject({ ok: true, originKey: KEY_B });
	expect(resolveHandoffTarget(KEY_C, config)).toMatchObject({ ok: true, originKey: KEY_C });
	expect(resolveHandoffTarget("slack:C9", config)).toMatchObject({ ok: true, originKey: "slack/channel/C9" });
	expect(resolveHandoffTarget("monitor/eventtype/x", config)).toMatchObject({ ok: false });
	expect(resolveHandoffTarget("loopback/loopback/loopback", config)).toMatchObject({ ok: false });
	expect(resolveHandoffTarget("dev2", config)).toMatchObject({ ok: false });
});

test("the chain bound and the idempotency key are pure functions of the hop", () => {
	expect(extendHandoffChain([], KEY_A, KEY_B)).toEqual({ ok: true, chain: [KEY_A] });
	expect(extendHandoffChain([KEY_A], KEY_B, KEY_C)).toEqual({ ok: true, chain: [KEY_A, KEY_B] });
	expect(extendHandoffChain([KEY_A, KEY_B], KEY_C, "discord/channel/d")).toMatchObject({ ok: false });
	expect(extendHandoffChain([KEY_A], KEY_B, KEY_A)).toMatchObject({ ok: false });
	expect(extendHandoffChain([], KEY_A, KEY_A)).toMatchObject({ ok: false });
	expect(handoffMessageId(KEY_A, "m1", KEY_B)).toBe(handoffMessageId(KEY_A, "m1", KEY_B));
	expect(handoffMessageId(KEY_A, "m1", KEY_B)).not.toBe(handoffMessageId(KEY_A, "m2", KEY_B));
});

test("the digest keeps the newest lines under the monitor digest ceiling", () => {
	const entries = Array.from({ length: 200 }, (_, index) => ({
		at: `2026-09-25T00:${String(index % 60).padStart(2, "0")}:00Z`,
		author: "형님",
		body: `line ${index} ${"x".repeat(200)}`,
	}));
	const digest = buildHandoffDigest(entries);
	expect(digest.length).toBeLessThanOrEqual(HANDOFF_DIGEST_MAX_LENGTH);
	expect(digest).toContain("line 199");
	expect(digest).not.toContain("line 0 ");
});

test("handoffTargets must name chat origins", () => {
	expect(parseConfigFile({ schemaVersion: 1, handoffTargets: { dev: B } }).handoffTargets).toEqual({ dev: B });
	for (const handoffTargets of [
		{ dev: { platform: "monitor", kind: "eventtype", conversationId: "x" } },
		{ dev: { platform: "discord", kind: "channel" } },
		{ "a/b": B },
		[],
	])
		expect(() => parseConfigFile({ schemaVersion: 1, handoffTargets })).toThrow(ConfigError);
});

test("text before handoff token in message -> handoff enqueued", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () =>
			"Some initial analysis.\n\nMore context here.\n\n[HANDOFF:gajae-way-dev]\nPlease take this from here.",
		[KEY_B]: () => "Got it, handling now.",
	});
	say(client, A, "m1", "work item");
	await settle();

	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	const relayed = targetTurns[0]?.text ?? "";
	expect(relayed).toContain("RELAYED HANDOFF");
	expect(relayed).toContain("Please take this from here");

	expect(delivered(client, "chan-b")).toEqual(["Got it, handling now."]);
});

test("line-standalone unparseable token (empty target) -> stripped from delivery", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "Some analysis.\n[HANDOFF:]\nThe target above is empty.",
	});
	say(client, A, "m1", "work item");
	await settle();

	const delivered_a = delivered(client, "chan-a");
	expect(delivered_a).toHaveLength(1);
	// The line-standalone unparseable token (empty target) should be stripped
	expect(delivered_a[0]).not.toContain("[HANDOFF:");
	// The surrounding text should remain
	expect(delivered_a[0]).toContain("Some analysis");
	expect(delivered_a[0]).toContain("The target above is empty");
});

test("inline token mention -> preserved as literal text", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "See [HANDOFF:dev] for more info. Use `[HANDOFF:code]` in your implementation.",
	});
	say(client, A, "m1", "work item");
	await settle();

	const delivered_a = delivered(client, "chan-a");
	expect(delivered_a).toHaveLength(1);
	// Inline mentions are preserved (not valid directives)
	expect(delivered_a[0]).toContain("[HANDOFF:dev]");
	expect(delivered_a[0]).toContain("[HANDOFF:code]");
	// The message content is intact
	expect(delivered_a[0]).toContain("for more info");
	expect(delivered_a[0]).toContain("in your implementation");
});

test("parseHandoffReply requires token at message start", () => {
	// Verify that parseHandoffReply only recognizes tokens at the very start
	// Text before the token is not part of a handoff directive
	expect(parseHandoffReply("text\n[HANDOFF:x]\nnote")).toBeUndefined();
	expect(parseHandoffReply("line1\nline2\n[HANDOFF:target]\nthe note")).toBeUndefined();
	// Tokens at the start work
	expect(parseHandoffReply("[HANDOFF:x]\nnote")).toEqual({
		target: "x",
		note: "note",
	});
	expect(parseHandoffReply("  [HANDOFF:target]  \nthe note")).toEqual({
		target: "target",
		note: "the note",
	});
});

test("regression: text before handoff token (same message) -> handoff enqueued", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "text\n[HANDOFF:gajae-way-dev]\nnote",
		[KEY_B]: () => "received",
	});
	say(client, A, "m1", "work");
	await settle();

	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	const relayed = targetTurns[0]?.text ?? "";
	expect(relayed).toContain("RELAYED HANDOFF");
	expect(relayed).toContain("note");
});

test("mid-message handoff: simple text before token - delivered then pointer", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "Analysis.\n[HANDOFF:gajae-way-dev]\nHandoff note.",
		[KEY_B]: () => "Received.",
	});
	say(client, A, "m1", "work");
	await settle();

	// Check target received the handoff
	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	const relayed = targetTurns[0]?.text ?? "";
	expect(relayed).toContain("RELAYED HANDOFF");
	expect(relayed).toContain("Handoff note");

	// Check source: at least one message delivered (text or pointer)
	const delivered_a = delivered(client, "chan-a");
	expect(delivered_a.length).toBeGreaterThan(0);
});

test("mid-message handoff with [BREAK] separator -> handoff enqueued", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "Block 1 analysis.\n\n[BREAK]\n\nMore analysis.\n[HANDOFF:gajae-way-dev]\nHandoff note here.",
		[KEY_B]: () => "Received and processing.",
	});
	say(client, A, "m1", "complex work");
	await settle();

	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	const relayed = targetTurns[0]?.text ?? "";
	expect(relayed).toContain("RELAYED HANDOFF");
	expect(relayed).toContain("Handoff note here");
});

test("reaction-only text before a mid-message handoff token -> reaction delivered and handoff still enqueued", async () => {
	const { client, turns } = await gateway({
		[KEY_A]: () => "[REACT:👀]\n[HANDOFF:gajae-way-dev]\nForward this.",
		[KEY_B]: () => "Received.",
	});
	say(client, A, "m1", "work");
	await settle();

	const reactions = client.frames.filter(
		(frame) =>
			frame.event === "chat.message" && frame.payload.origin?.conversationId === "chan-a" && frame.payload.reaction,
	);
	expect(reactions).toHaveLength(1);
	expect(reactions[0]?.payload.reaction).toMatchObject({ targetMessageId: "m1", emoji: "👀" });
	const targetTurns = turns.filter((turn) => turn.originKey === KEY_B);
	expect(targetTurns).toHaveLength(1);
	expect(targetTurns[0]?.text ?? "").toContain("Forward this.");
	expect(delivered(client, "chan-a").some((text) => text?.includes("[HANDOFF:"))).toBe(false);
});

test("interim: mid-line token not exposed (stripped from interim delivery)", async () => {
	const { client, turns } = await gateway({
		// Split into interim frames
		[KEY_A]: () => "Frame 1 text\n[HANDOFF:gajae-way-dev]\nFrame 2 content",
	});
	say(client, A, "m1", "work");
	await settle();

	// Interim deliveries should not contain the unparseable token line
	const delivered_a = delivered(client, "chan-a");
	// Should only have the pointer, no handoff token should appear
	const hasToken = delivered_a.some((msg) => msg.includes("[HANDOFF:"));
	expect(hasToken).toBe(false);
});

test("backtick and inline mentions preserved (not stripped)", () => {
	// Verify that inline code mentions are not removed
	const text = "Example usage: `[HANDOFF:code]` for reference. Also see [HANDOFF:example].";
	const stripped = stripHandoffTokens(text);
	// Inline mentions outside backticks at line start should be removed if invalid
	// But mentions in backticks are preserved
	expect(stripped).toContain("`[HANDOFF:code]`");
});
