import type { StoreCore } from "../core";
import type { WriteTx } from "../tx";

/** Durable append-only event journal for work attempts and delivery state. */

export type WorkJournalEventType =
	| "attempt_started"
	| "attempt_accepted"
	| "attempt_settled"
	| "attempt_terminal"
	| "delivery_queued"
	| "delivery_sent"
	| "delivery_confirmed"
	| "delivery_failed";

export interface WorkJournalEvent {
	readonly eventId: string;
	readonly opRef: string;
	readonly jobId: string;
	readonly eventType: WorkJournalEventType;
	readonly payload: Record<string, unknown>;
	readonly recordedAt: string;
}

export class JournalGroup {
	readonly #db: ReturnType<StoreCore["groupDb"]>;
	readonly instanceId: string;

	constructor(core: StoreCore) {
		this.#db = core.groupDb("journal");
		this.instanceId = core.instanceId;
	}

	/**
	 * Append a journal event in the current transaction.
	 * Events are immutable once written and ordered by recordedAt.
	 */
	appendEvent(
		tx: WriteTx,
		eventId: string,
		opRef: string,
		jobId: string,
		eventType: WorkJournalEventType,
		payload: Record<string, unknown>,
	): void {
		const recordedAt = new Date().toISOString();
		this.#db
			.prepare(
				"INSERT INTO work_journal (event_id, op_ref, job_id, event_type, payload_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(tx, eventId, opRef, jobId, eventType, JSON.stringify(payload), recordedAt);
	}

	/**
	 * Get all journal events for a work attempt, in chronological order.
	 */
	getAttemptEvents(opRef: string): WorkJournalEvent[] {
		return (
			this.#db
				.prepare(
					"SELECT event_id, op_ref, job_id, event_type, payload_json, recorded_at FROM work_journal WHERE op_ref = ? ORDER BY recorded_at ASC",
				)
				.all(opRef) as Array<{
					event_id: string;
					op_ref: string;
					job_id: string;
					event_type: WorkJournalEventType;
					payload_json: string;
					recorded_at: string;
				}>
		).map((row) => ({
			eventId: row.event_id,
			opRef: row.op_ref,
			jobId: row.job_id,
			eventType: row.event_type,
			payload: JSON.parse(row.payload_json),
			recordedAt: row.recorded_at,
		}));
	}

	/**
	 * Get all journal events for a work attempt by job ID, in chronological order.
	 */
	getJobEvents(jobId: string): WorkJournalEvent[] {
		return (
			this.#db
				.prepare(
					"SELECT event_id, op_ref, job_id, event_type, payload_json, recorded_at FROM work_journal WHERE job_id = ? ORDER BY recorded_at ASC",
				)
				.all(jobId) as Array<{
					event_id: string;
					op_ref: string;
					job_id: string;
					event_type: WorkJournalEventType;
					payload_json: string;
					recorded_at: string;
				}>
		).map((row) => ({
			eventId: row.event_id,
			opRef: row.op_ref,
			jobId: row.job_id,
			eventType: row.event_type,
			payload: JSON.parse(row.payload_json),
			recordedAt: row.recorded_at,
		}));
	}

	/**
	 * Get all unprocessed journal events since a given opRef, ordered chronologically.
	 * Used during boot recovery to replay state.
	 */
	getEventsSince(afterOpRef: string, limit = 1000): WorkJournalEvent[] {
		return (
			this.#db
				.prepare(
					`SELECT event_id, op_ref, job_id, event_type, payload_json, recorded_at
					 FROM work_journal
					 WHERE op_ref > ? OR (op_ref = ? AND recorded_at > (
						 SELECT COALESCE(MAX(recorded_at), '0000-01-01T00:00:00.000Z')
						 FROM work_journal WHERE op_ref = ?
					 ))
					 ORDER BY recorded_at ASC
					 LIMIT ?`,
				)
				.all(afterOpRef, afterOpRef, afterOpRef, limit) as Array<{
					event_id: string;
					op_ref: string;
					job_id: string;
					event_type: WorkJournalEventType;
					payload_json: string;
					recorded_at: string;
				}>
		).map((row) => ({
			eventId: row.event_id,
			opRef: row.op_ref,
			jobId: row.job_id,
			eventType: row.event_type,
			payload: JSON.parse(row.payload_json),
			recordedAt: row.recorded_at,
		}));
	}
}
