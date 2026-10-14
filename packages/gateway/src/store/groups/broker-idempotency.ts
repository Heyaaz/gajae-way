import type { GroupDb, StoreCore } from "../core";
import type { WriteTx } from "../tx";

export interface BrokerOperationResult {
	readonly operationKey: string;
	readonly operationType: string;
	readonly resultJson: string;
	readonly createdAt: string;
	readonly expiresAt: string;
}

const OPERATION_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Persistence for broker operation idempotency: caches operation results by key to ensure retries return the same result. */
export class BrokerIdempotencyGroup {
	#db: GroupDb;

	constructor(core: StoreCore) {
		this.#db = core.groupDb("broker_operation_idempotency");
	}

	/**
	 * Records the result of a broker operation for idempotency.
	 * If the operation key already exists, this is a no-op (the cached result is preserved).
	 */
	recordOperation(tx: WriteTx, operationKey: string, operationType: string, resultJson: string): void {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + OPERATION_IDEMPOTENCY_RETENTION_MS).toISOString();

		const existing = this.#db
			.prepare(
				"SELECT result_json FROM broker_operation_idempotency WHERE operation_key = ? AND expiresAt > ?",
			)
			.get(operationKey, now) as { result_json: string } | undefined;

		if (!existing) {
			this.#db
				.prepare(
					"INSERT INTO broker_operation_idempotency (operation_key, operation_type, result_json, created_at, expiresAt) VALUES (?, ?, ?, ?, ?)",
				)
				.run(tx, operationKey, operationType, resultJson, now, expiresAt);
		}
	}

	/**
	 * Retrieves a cached operation result if it exists and hasn't expired.
	 * Returns the cached result or undefined if not found or expired.
	 */
	getCachedResult(operationKey: string): string | undefined {
		const now = new Date().toISOString();
		const row = this.#db
			.prepare(
				"SELECT result_json FROM broker_operation_idempotency WHERE operation_key = ? AND expiresAt > ?",
			)
			.get(operationKey, now) as { result_json: string } | undefined;

		return row?.result_json;
	}

	/**
	 * Removes expired cached results.
	 * Returns the number of rows deleted.
	 */
	cleanupExpiredResults(tx: WriteTx): number {
		const now = new Date().toISOString();
		const result = this.#db.prepare("DELETE FROM broker_operation_idempotency WHERE expiresAt <= ?").run(tx, now);
		return result.changes;
	}
}
