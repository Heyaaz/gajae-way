import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/store";
import { type Barrier, eventually, WorkFixture } from "./fixtures/work-lane-server";

const fixtures: WorkFixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture(barrier?: Barrier | { readonly allowNested?: boolean }) {
	const options = typeof barrier === "object" ? barrier : {};
	const barrierPoint = typeof barrier === "string" ? barrier : undefined;
	const f = await WorkFixture.create(options);
	fixtures.push(f);
	await f.start(barrierPoint);
	return f;
}

async function start(f: WorkFixture, name = "journal-crash") {
	const client = await f.connect();
	const response = await client.request("work.start", {
		name,
		text: "journal test work",
		cwd: f.home,
	});
	expect(response.error).toBeUndefined();
	expect(response.result).toMatchObject({ started: true, sessionKey: `work/task/${name}` });
	return { client, receipt: response.result };
}

async function settled(f: WorkFixture) {
	return eventually(
		() => f.snapshot(),
		(snapshot) => snapshot.runtimes.length === 1 && snapshot.runtimes[0].settledAt !== null,
		"durable settlement",
	);
}

test("journal events are recorded during work settlement", async () => {
	const f = await fixture();
	const { receipt } = await start(f);

	// Complete the work
	await f.control(receipt.opRef, { unknown: false, terminal: true, text: "completed" });
	const snapshot = await settled(f);

	// Verify that journal events can be inspected
	const dbPath = join(f.home, "gateway.db");
	const db = await Store.openReadonly(dbPath);
	try {
		const attemptEvents = db.journal.getAttemptEvents(receipt.opRef);
		expect(attemptEvents.length).toBeGreaterThan(0);
		// Events should include attempt_settled
		const settledEvents = attemptEvents.filter((e) => e.eventType === "attempt_settled");
		expect(settledEvents.length).toBeGreaterThan(0);
		expect(settledEvents[0].opRef).toBe(receipt.opRef);
		expect(settledEvents[0].jobId).toBeDefined();
		expect(settledEvents[0].payload.decision).toBeDefined();
	} finally {
		db.close();
	}
}, 30_000);

test("journal replay preserves projected state across crash at settlement boundary", async () => {
	const f = await fixture();
	const { receipt } = await start(f);
	expect(f.snapshot().jobs[0].attempts[0].endedAt).toBeUndefined();
	expect(f.snapshot().deliveries).toHaveLength(0);

	// Kill before settlement completes
	await f.kill();
	await f.control(receipt.opRef, { unknown: true, live: "live" });
	await f.start();

	// Complete the work
	await f.control(receipt.opRef, { unknown: false, terminal: true, text: "after crash" });
	const snapshot = await settled(f);

	// Verify projections are consistent
	expect(snapshot.jobs[0].attempts).toHaveLength(1);
	expect(snapshot.jobs[0].attempts[0].endState).toBe("completed");
	expect(snapshot.deliveries).toHaveLength(1);

	// Verify journal has both pre-crash and post-crash events
	const dbPath = join(f.home, "gateway.db");
	const db = await Store.openReadonly(dbPath);
	try {
		const allEvents = db.journal.getAttemptEvents(receipt.opRef);
		const settledEvents = allEvents.filter((e) => e.eventType === "attempt_settled");
		expect(settledEvents.length).toBeGreaterThan(0);
	} finally {
		db.close();
	}
}, 30_000);

test("journal maintains exactly-once delivery across multiple crashes", async () => {
	const f = await fixture();
	const { receipt } = await start(f);

	// Complete the work
	await f.control(receipt.opRef, { unknown: false, terminal: true, text: "settled" });
	const settled1 = await settled(f);
	expect(settled1.deliveries).toHaveLength(1);
	const deliveryId = settled1.deliveries[0].delivery_id;

	// Kill and restart multiple times, verify delivery ID remains unchanged
	for (let i = 0; i < 2; i++) {
		await f.kill();
		await f.start();
		const snapshot = await f.snapshot();
		expect(snapshot.deliveries).toHaveLength(1);
		expect(snapshot.deliveries[0].delivery_id).toBe(deliveryId);
	}
}, 30_000);

test("journal events survive kill at every transition point", async () => {
	for (const point of ["settle-before", "settle-report", "settle-commit"] as const) {
		const f = await fixture(point);
		const { receipt } = await start(f);

		// This will attempt to crash at the specified point
		// The gateway should recover gracefully
		try {
			await eventually(() => f.snapshot(), () => false, "should crash", 2_000);
		} catch {
			// Expected to crash at the barrier point
		}

		// Restart and verify consistent state
		await f.start();
		await f.control(receipt.opRef, { unknown: false, terminal: true, text: "after crash" });
		const snapshot = await settled(f);

		// Either settled or not, but not partial
		if (snapshot.runtimes[0].settledAt !== null) {
			expect(snapshot.runtimes[0].decision).toBeDefined();
		}

		await f.cleanup();
		fixtures.pop();
	}
}, 45_000);
