import { UNAVAILABLE_AFTER_MS, type Availability } from "../shared/availability.ts";
import { parseRfc3339, type SnapshotToSave, type StoredSnapshot } from "./model.ts";

export interface SnapshotStore {
  beginAttempt(nowMs: number): Promise<string | null>;
  load(): Promise<StoredSnapshot | null>;
  saveSuccess(snapshot: SnapshotToSave): Promise<boolean>;
  saveFailure(attemptAt: string, failedAtMs: number): Promise<boolean>;
}

interface DatabaseSnapshotRow {
  status: string;
  window_start: string | null;
  window_end: string | null;
  updated_at: string | null;
  last_attempt_at: string | null;
  busy_json: string;
}

interface LastAttemptRow {
  last_attempt_at: string | null;
}

function isAvailabilityStatus(value: string): value is Availability["status"] {
  return value === "fresh" || value === "stale" || value === "unavailable";
}

/** D1-backed store. The database contains one singleton snapshot row. */
export class D1SnapshotStore implements SnapshotStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async beginAttempt(nowMs: number): Promise<string | null> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO availability_snapshot
          (id, status, window_start, window_end, updated_at, last_attempt_at, busy_json)
         VALUES (1, 'unavailable', NULL, NULL, NULL, NULL, '[]')`,
      )
      .run();

    const previous = await this.db
      .prepare("SELECT last_attempt_at FROM availability_snapshot WHERE id = 1")
      .first<LastAttemptRow>();
    if (!previous || !Number.isFinite(nowMs)) return null;

    const previousMs = previous.last_attempt_at === null ? null : parseRfc3339(previous.last_attempt_at);
    const attemptMs = Math.max(nowMs, previousMs === null ? nowMs : previousMs + 1);
    const attemptAt = new Date(attemptMs).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE availability_snapshot
         SET last_attempt_at = ?
         WHERE id = 1 AND last_attempt_at IS ?`,
      )
      .bind(attemptAt, previous.last_attempt_at)
      .run();

    return result.meta.changes === 1 ? attemptAt : null;
  }

  async load(): Promise<StoredSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT status, window_start, window_end, updated_at, last_attempt_at, busy_json
         FROM availability_snapshot WHERE id = 1`,
      )
      .first<DatabaseSnapshotRow>();
    if (!row || !isAvailabilityStatus(row.status) || typeof row.busy_json !== "string") return null;

    return {
      status: row.status,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      updatedAt: row.updated_at,
      lastAttemptAt: row.last_attempt_at,
      busyJson: row.busy_json,
    };
  }

  async saveSuccess(snapshot: SnapshotToSave): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE availability_snapshot
         SET status = 'fresh', window_start = ?, window_end = ?, updated_at = ?, busy_json = ?
         WHERE id = 1 AND last_attempt_at = ?`,
      )
      .bind(
        snapshot.windowStart,
        snapshot.windowEnd,
        snapshot.updatedAt,
        JSON.stringify(snapshot.busy),
        snapshot.attemptAt,
      )
      .run();
    return result.meta.changes === 1;
  }

  async saveFailure(attemptAt: string, failedAtMs: number): Promise<boolean> {
    const current = await this.db
      .prepare("SELECT updated_at FROM availability_snapshot WHERE id = 1 AND last_attempt_at = ?")
      .bind(attemptAt)
      .first<{ updated_at: string | null }>();
    if (!current) return false;

    const updatedAtMs = current.updated_at === null ? null : parseRfc3339(current.updated_at);
    const status: Availability["status"] =
      updatedAtMs === null || failedAtMs - updatedAtMs >= UNAVAILABLE_AFTER_MS
        ? "unavailable"
        : "stale";
    const result = await this.db
      .prepare(
        `UPDATE availability_snapshot
         SET status = ?
         WHERE id = 1 AND last_attempt_at = ?`,
      )
      .bind(status, attemptAt)
      .run();
    return result.meta.changes === 1;
  }
}
