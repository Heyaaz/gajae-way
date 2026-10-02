import { CronExpressionParser } from "cron-parser";

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
const CRON_FIELD_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
] as const;

function dateFields(date: Date, timezone?: string): [number, number, number, number, number] {
	if (timezone === undefined)
		return [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
	let formatter = timezoneFormatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			weekday: "short",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			hourCycle: "h23",
		});
		timezoneFormatters.set(timezone, formatter);
	}
	const parts = new Map(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
	const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	const minute = Number(parts.get("minute"));
	const hour = Number(parts.get("hour"));
	const day = Number(parts.get("day"));
	const month = Number(parts.get("month"));
	const weekday = weekdays[parts.get("weekday") ?? ""];
	if (![minute, hour, day, month].every(Number.isFinite) || weekday === undefined)
		throw new Error(`could not read cron time in timezone ${timezone}`);
	return [minute, hour, day, month, weekday];
}
export function cronMatches(schedule: string, date: Date, timezone?: string): boolean {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("cron schedule must have five fields");
	const values = dateFields(date, timezone);
	return fields.every((field, index) => {
		const value = values[index];
		return field !== undefined && value !== undefined && cronFieldMatches(field, value, 0);
	});
}
export function cronFieldMatches(field: string, value: number, min: number): boolean {
	return field.split(",").some((part) => {
		const [base, stepText] = part.split("/");
		const step = stepText ? Number(stepText) : 1;
		if (!Number.isInteger(step) || step < 1) return false;
		if (base === "*") return (value - min) % step === 0;
		const range = base.split("-").map(Number);
		if (range.length === 1) return value === range[0] && step === 1;
		return (
			range.length === 2 &&
			Number.isInteger(range[0]) &&
			Number.isInteger(range[1]) &&
			value >= range[0]! &&
			value <= range[1]! &&
			(value - range[0]!) % step === 0
		);
	});
}

export function nextCronFire(schedule: string, from: Date, timezone: string): Date | null {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const nearTerm: Date[] = [];
	cronSlotsBetween(
		schedule,
		from,
		new Date(from.getTime() + 4 * 60 * 60 * 1000),
		1,
		(slot) => {
			nearTerm.push(slot);
			return true;
		},
		timezone,
	);
	if (nearTerm[0]) return nearTerm[0];

	const values = fields.map((field, index) => {
		const range = CRON_FIELD_RANGES[index];
		if (!range) return null;
		const matching: number[] = [];
		for (let value = range[0]; value <= range[1]; value++) {
			if (cronFieldMatches(field, value, 0)) matching.push(value);
		}
		return matching.length ? matching : null;
	});
	const [minutes, hours, days, months, weekdays] = values;
	if (!minutes?.length || !hours?.length || !days?.length || !months?.length || !weekdays?.length) return null;
	let hasCalendarMatch = false;
	const firstYear = from.getUTCFullYear();
	for (let year = firstYear; year <= firstYear + 400 && !hasCalendarMatch; year++) {
		for (const month of months) {
			const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
			for (const day of days) {
				if (day <= daysInMonth && weekdays.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) {
					hasCalendarMatch = true;
					break;
				}
			}
			if (hasCalendarMatch) break;
		}
	}
	if (!hasCalendarMatch) return null;
	const candidateSchedule = [minutes, hours, days, months, weekdays].map((field) => field.join(",")).join(" ");
	const endDate = new Date(from.getTime() + 400 * 366 * 24 * 60 * 60 * 1000);
	try {
		const candidates = CronExpressionParser.parse(candidateSchedule, {
			currentDate: from,
			endDate,
			tz: timezone,
		});
		while (candidates.hasNext()) {
			const candidate = candidates.next().toDate();
			if (candidate.getTime() <= from.getTime()) continue;
			if (cronMatches(schedule, candidate, timezone)) return candidate;
		}
	} catch {
		return null;
	}
	return null;
}

/** Absolute minute epoch — identical for the same wall-clock minute worldwide. */
export function minuteEpoch(date: Date): number {
	return Math.floor(date.getTime() / 60_000);
}

/**
 * Exact scheduled slot timestamps for every schedule minute in the half-open
 * window (from, now], oldest first. Each cursor step is an absolute minute;
 * fields are evaluated in the explicit IANA zone or the process-local zone.
 * A spring-forward minute does not exist; a repeated fall-back minute has two
 * distinct UTC slots.
 *
 * `fire` returning false means the slot was NOT newly admitted (already
 * claimed durably by an earlier tick/process). Only NEW admissions count
 * against `budget`, so duplicates never consume catch-up capacity.
 */
export function cronSlotsBetween(
	schedule: string,
	from: Date,
	now: Date,
	budget: number,
	fire: (slotAt: Date) => boolean,
	timezone?: string,
): number {
	let fired = 0;
	const cursor = new Date((minuteEpoch(from) + 1) * 60_000);
	while (cursor.getTime() <= now.getTime()) {
		if (cronMatches(schedule, cursor, timezone)) {
			if (fired >= budget) break;
			if (fire(new Date(cursor.getTime()))) fired++;
		}
		cursor.setTime(cursor.getTime() + 60_000);
	}
	return fired;
}

/** Every schedule slot in the half-open window (from, now], oldest first. */
export function cronSlotList(schedule: string, from: Date, now: Date, timezone?: string): Date[] {
	const slots: Date[] = [];
	cronSlotsBetween(
		schedule,
		from,
		now,
		Number.POSITIVE_INFINITY,
		(slot) => {
			slots.push(slot);
			return true;
		},
		timezone,
	);
	return slots;
}

/** Safety valve: a single in-process suspension sweep never authorizes more than this many slots. */
export const DEFAULT_MAX_CATCH_UP_SLOTS = 8;

/** How far back a running process re-scans for slots skipped by a suspended tick. */
export const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;

/** Oldest missed slot a fresh process may still owe after downtime. */
export const DEFAULT_MAX_CATCH_UP_AGE_MS = 24 * 60 * 60 * 1000;

/** Marks the single coalesced event a fresh process fires for slots missed while it was down. */
export type CronCatchUp = {
	readonly cause: "startup";
	/** Oldest missed slot inside the age bound. */
	readonly missedFrom: string;
	/** Newest missed slot — the one fired. */
	readonly missedTo: string;
	readonly missedSlots: number;
};

/**
 * Cron trigger with an absolute-minute cursor (red-team blocker 5).
 *
 * - `minute` is an absolute minute EPOCH, never minute-of-hour: a suspended
 *   process whose next tick lands +60m later on the same wall-minute does not
 *   return early — the epoch advanced, so the due-window scan still runs.
 * - `fire(slotAt)` receives the EXACT scheduled slot timestamp (red-team
 *   blocker 3); the caller persists it as the event's scheduled identity.
 * - Dedupe/budget durability lives with the caller (the propagator claims the
 *   slot and admits the event in one transaction); this module only computes
 *   WHEN slots are due.
 * - Startup (issue #162): `since` is the persisted schedule boundary (the
 *   monitor's last claimed slot, else its creation instant). Every slot missed
 *   between it and now — bounded by `maxCatchUpAgeMs` — coalesces into ONE
 *   fire of the newest missed slot, marked with a `CronCatchUp` record. A slot
 *   due in the current minute fires normally. Replaying every historical
 *   slot would storm the authoring path after a long outage.
 * - While running, each tick scans from the last evaluated instant (bounded by
 *   `CATCH_UP_WINDOW_MS` and the slot budget), so a suspended tick still fires
 *   the slots it skipped without re-scanning slots already evaluated.
 */
export function startCron(
	schedule: string,
	fire: (slotAt: Date, catchUp?: CronCatchUp) => boolean,
	options: {
		since: Date;
		now?: () => Date;
		maxCatchUpSlots?: number;
		maxCatchUpAgeMs?: number;
		intervalMs?: number;
		timezone?: string;
	},
): () => void {
	const now = options.now ?? (() => new Date());
	const budget = options.maxCatchUpSlots ?? DEFAULT_MAX_CATCH_UP_SLOTS;
	const maxAge = options.maxCatchUpAgeMs ?? DEFAULT_MAX_CATCH_UP_AGE_MS;
	let minute = -1;
	let started = 0;
	const tick = () => {
		const date = now();
		const epoch = minuteEpoch(date);
		if (epoch === minute) return;
		if (minute === -1) {
			const from = Math.max(options.since.getTime(), date.getTime() - maxAge);
			const due = cronSlotList(schedule, new Date(from), date, options.timezone);
			const last = due.at(-1);
			const current = last && minuteEpoch(last) === epoch ? due.pop() : undefined;
			const oldest = due[0];
			const newest = due.at(-1);
			if (oldest && newest)
				fire(newest, {
					cause: "startup",
					missedFrom: oldest.toISOString(),
					missedTo: newest.toISOString(),
					missedSlots: due.length,
				});
			if (current) fire(current);
			started = date.getTime();
		} else {
			// A suspension can skip due slots even when the current minute also
			// matches (e.g. */30, prior tick 06:00, resume 07:30 — 06:30 and 07:00
			// fire alongside 07:30); caller-side slot claims make re-scanned slots
			// no-ops. The scan never reaches behind startup, whose missed slots were
			// already coalesced. The extra minute keeps the boundary slot (now-60m
			// exactly) inside the half-open scan.
			const from = Math.max(started, date.getTime() - CATCH_UP_WINDOW_MS - 60_000);
			cronSlotsBetween(schedule, new Date(from), date, budget, fire, options.timezone);
		}
		minute = epoch;
	};
	tick();
	const timer = setInterval(tick, options.intervalMs ?? 30_000);
	return () => clearInterval(timer);
}
