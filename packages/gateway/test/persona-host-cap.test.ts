import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PersonaBindHoldInput,
	PersonaSessionManager,
	STALLED_TURN_TERMINAL_TIMEOUT_MS,
} from "../src/orchestrator/persona-session";
import { Store } from "../src/store";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "./session-port.fake";

let home = "";
let database: Store | undefined;
let manager: PersonaSessionManager | undefined;

afterEach(async () => {
	await manager?.stop();
	database?.close();
	manager = undefined;
	database = undefined;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

function origin(name: string) {
	return {
		key: `loopback/loopback/${name}`,
		ref: JSON.stringify({ platform: "loopback", kind: "loopback", conversationId: name }),
	};
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

async function harness(options: {
	maxLiveHosts: number;
	hostIdleRetireMs?: number;
	now?: () => number;
	brokerAvailable?: () => boolean;
	onFailure?: () => void;
}) {
	home = await mkdtemp(join(tmpdir(), "gajaeway-persona-host-cap-"));
	database = await Store.open(join(home, "gateway.db"));
	const port = attachTestBrokerOwnership(database, new ScriptedSessionPort(), join(home, "agent"));
	const logs: string[] = [];
	const holds: PersonaBindHoldInput[] = [];
	manager = new PersonaSessionManager({
		database,
		port,
		instanceId: "instance-test",
		repo: join(home, "workspace"),
		submissionRetryDelayMs: 1,
		maxLiveHosts: options.maxLiveHosts,
		...(options.hostIdleRetireMs === undefined ? {} : { hostIdleRetireMs: options.hostIdleRetireMs }),
		...(options.now ? { now: options.now } : {}),
		...(options.brokerAvailable ? { brokerAvailable: options.brokerAvailable } : {}),
		...(options.onFailure
			? {
					onTurnStart: ({ trigger }) => ({
						text: trigger.body,
						onFailure: () => options.onFailure?.(),
					}),
				}
			: {}),
		log: (line) => {
			logs.push(line);
		},
		onBindHold: (input) => {
			holds.push(input);
		},
	});
	const active = manager;
	const db = database;
	/** Enqueues one message for an origin and waits until the actor either sent it or holds it. */
	const send = async (name: string, body: string) => {
		const { key, ref } = origin(name);
		expect(
			db.transaction((tx) =>
				db.inbox.enqueue(tx, {
					messageId: `${name}:${body}`,
					originKey: key,
					originRefJson: ref,
					body,
					source: "platform",
				}),
			),
		).toBe(true);
		await active.notifyInbound(key);
	};
	const sent = (body: string) => port.sends.find((input) => input.text === body);
	const sessionOf = (body: string): string => {
		const input = sent(body);
		if (!input) throw new Error(`turn ${body} was never sent`);
		return input.sessionId;
	};
	/** Completes a sent turn and waits for its origin to settle back to idle. */
	const complete = async (name: string, body: string) => {
		const { key } = origin(name);
		const input = sent(body);
		if (!input) throw new Error(`turn ${body} was never sent`);
		port.complete(input.opRef, `answer to ${body}`);
		await active.tick(key);
		await eventually(
			() => db.inbox.turnRow(input.opRef)?.turn_state === "done" && active.state(key) === "idle",
			`turn ${body} did not settle`,
		);
	};
	return { port, logs, holds, send, sent, sessionOf, complete, manager: active, database: db };
}

test("at the cap the least-recently-active idle host is ended before a new origin binds, and its session resumes later", async () => {
	const h = await harness({ maxLiveHosts: 2 });
	await h.send("a", "a1");
	await h.complete("a", "a1");
	await h.send("b", "b1");
	await h.complete("b", "b1");
	expect(h.manager.liveHostCount()).toBe(2);
	const sessionA = h.sessionOf("a1");
	const sessionB = h.sessionOf("b1");

	await h.send("c", "c1");
	await eventually(() => h.sent("c1") !== undefined, "c1 was not dispatched after an idle host was retired");
	expect(h.port.closes.map((close) => close.sessionId)).toEqual([sessionA]);
	expect(h.manager.liveHostCount()).toBe(2);
	expect(
		h.logs.some(
			(line) =>
				line.startsWith(`persona_host_retired origin=${origin("a").key}`) && line.includes("reason=host_capacity"),
		),
	).toBe(true);
	await h.complete("c", "c1");

	// Origin a returns: b is now the oldest idle host, and a's own session resumes with its history.
	await h.send("a", "a2");
	await eventually(() => h.sent("a2") !== undefined, "a2 was not dispatched");
	expect(h.port.closes.map((close) => close.sessionId)).toEqual([sessionA, sessionB]);
	expect(h.port.resumes.map((resume) => resume.sessionId)).toEqual([sessionA]);
	expect(h.sessionOf("a2")).toBe(sessionA);
	expect(h.holds).toHaveLength(0);
});

test("with every host busy a new origin is held, not spawned, and dispatches when a host frees", async () => {
	const h = await harness({ maxLiveHosts: 2 });
	await h.send("a", "a1");
	await h.send("b", "b1");
	await eventually(() => h.sent("a1") !== undefined && h.sent("b1") !== undefined, "a1/b1 were not sent");

	await h.send("c", "c1");
	await Bun.sleep(20);
	expect(h.sent("c1")).toBeUndefined();
	expect(h.port.binds.map((bind) => bind.originKey)).not.toContain(origin("c").key);
	expect(h.port.closes).toHaveLength(0);
	expect(h.manager.liveHostCount()).toBe(2);
	expect(h.manager.admissionHold(origin("c").key)).toBe("host_capacity");
	expect(h.holds).toHaveLength(1);
	expect(h.holds[0]).toMatchObject({ originKey: origin("c").key, reason: "host_capacity" });
	expect(h.holds[0]?.notice).toContain("2/2 busy");
	expect(
		h.logs.filter((line) => line.includes("reason=host_capacity") && line.startsWith("persona_bind_hold")),
	).toHaveLength(1);

	await h.complete("a", "a1");
	await eventually(() => h.sent("c1") !== undefined, "c1 was not dispatched once a host freed");
	// a's host was idle and least recently active, so it made room for c.
	expect(h.port.closes.map((close) => close.sessionId)).toEqual([h.sessionOf("a1")]);
	expect(h.manager.liveHostCount()).toBe(2);
	expect(h.manager.admissionHold(origin("c").key)).toBeUndefined();
});

test("a stalled-turn cutoff frees one host slot once when its failure notice retries", async () => {
	let clock = 1_000_000;
	let failureCalls = 0;
	const h = await harness({
		maxLiveHosts: 1,
		now: () => clock,
		onFailure: () => {
			failureCalls++;
			if (failureCalls === 1) throw new Error("cutoff notice persistence failed");
		},
	});
	await h.send("a", "a1");
	await eventually(() => h.sent("a1") !== undefined, "a1 was not dispatched");
	const sessionA = h.sessionOf("a1");
	await h.send("b", "b1");
	await eventually(() => h.manager.admissionHold(origin("b").key) === "host_capacity", "b1 was not held at capacity");
	await h.send("c", "c1");
	await eventually(() => h.manager.admissionHold(origin("c").key) === "host_capacity", "c1 was not held at capacity");
	expect(h.sent("b1")).toBeUndefined();
	expect(h.sent("c1")).toBeUndefined();
	expect(h.manager.liveHostCount()).toBe(1);

	const originalTerminate = h.port.terminateHost.bind(h.port);
	const originalBind = h.port.bind.bind(h.port);
	let terminationCalls = 0;
	let bindCalls = 0;
	let releaseBinds!: () => void;
	const bindGate = new Promise<void>((resolve) => {
		releaseBinds = resolve;
	});
	h.port.terminateHost = async (input) => {
		terminationCalls++;
		return await originalTerminate(input);
	};
	h.port.bind = async (input) => {
		if (input.originKey === origin("b").key || input.originKey === origin("c").key) {
			bindCalls++;
			await bindGate;
		}
		return await originalBind(input);
	};
	h.port.setActivity(sessionA, "tool", clock);
	const statusReads = h.port.statusReads.length;
	h.port.emitStall(sessionA);
	await eventually(() => h.port.statusReads.length > statusReads, "stalled turn did not reconcile status");
	clock += STALLED_TURN_TERMINAL_TIMEOUT_MS;
	try {
		await expect(h.manager.tick(origin("a").key)).rejects.toThrow("cutoff notice persistence failed");
		await eventually(() => bindCalls > 0, "no capacity waiter started binding after the dead host was removed");
		await Bun.sleep(50);
		expect(bindCalls).toBe(1);
		expect(h.manager.admissionHold(origin("c").key)).toBe("host_capacity");
		await h.manager.tick(origin("a").key);
		expect(bindCalls).toBe(1);
		expect(h.manager.admissionHold(origin("c").key)).toBe("host_capacity");
		expect(failureCalls).toBe(2);
		releaseBinds();
		await eventually(
			() => h.sent("b1") !== undefined,
			"b1 did not start after the dead host was removed from capacity",
		);
		expect(h.manager.admissionHold(origin("b").key)).toBeUndefined();
		expect(h.sent("c1")).toBeUndefined();
		expect(terminationCalls).toBe(2);
		expect(h.port.closes.map((close) => close.sessionId)).toContain(sessionA);
		expect(h.manager.liveHostCount()).toBe(1);
	} finally {
		releaseBinds();
	}
});

test("idle hosts past the retire window are ended by the sweep and busy ones are left alone", async () => {
	let clock = 1_000_000;
	const h = await harness({ maxLiveHosts: 8, hostIdleRetireMs: 60_000, now: () => clock });
	await h.send("a", "a1");
	await h.complete("a", "a1");
	await h.send("b", "b1");
	await eventually(() => h.sent("b1") !== undefined, "b1 was not sent");
	expect(await h.manager.sweepIdleHosts()).toBe(0);
	clock += 60_000;
	expect(await h.manager.sweepIdleHosts()).toBe(1);
	expect(h.port.closes.map((close) => close.sessionId)).toEqual([h.sessionOf("a1")]);
	expect(h.manager.liveHostCount()).toBe(1);
	expect(h.logs.some((line) => line.includes("reason=host_idle"))).toBe(true);
	expect(await h.manager.sweepIdleHosts()).toBe(0);
});

test("an idle host refused during broker outage stops consuming host capacity", async () => {
	let brokerAvailable = true;
	const h = await harness({ maxLiveHosts: 1, brokerAvailable: () => brokerAvailable });
	await h.send("a", "a1");
	await h.complete("a", "a1");
	h.port.terminateHost = async () => {
		brokerAvailable = false;
		return { outcome: "refused", reason: "inspect_failed: broker_unavailable" };
	};

	await h.send("b", "b1");
	expect(h.sent("b1")).toBeUndefined();
	expect(h.manager.liveHostCount()).toBe(0);
	expect(h.logs.some((line) => line.includes("outcome=refused") && line.includes("broker_unavailable"))).toBe(true);

	await h.send("c", "c1");
	await eventually(() => h.sent("c1") !== undefined, "c1 did not bind after the broker went unavailable");
	expect(h.port.binds.map((bind) => bind.originKey)).toContain(origin("c").key);
	expect(h.manager.liveHostCount()).toBe(1);
});
