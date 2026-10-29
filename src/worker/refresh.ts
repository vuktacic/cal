import type { BusyInterval } from "../shared/availability.ts";
import { availabilityWindow } from "../shared/window.ts";
import { fetchGoogleBusyIntervals, type GoogleCredentials } from "./google-calendar.ts";
import type { SnapshotStore } from "./storage.ts";

const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface RefreshOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  onFailure?: () => void;
}

export async function refreshAvailability(
  credentials: GoogleCredentials,
  store: SnapshotStore,
  options: RefreshOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs)) {
    options.onFailure?.();
    return false;
  }

  let attemptAt: string | null;
  try {
    attemptAt = await store.beginAttempt(startedAtMs);
  } catch {
    options.onFailure?.();
    return false;
  }
  if (attemptAt === null) return true;

  const { startMs, endMs } = availabilityWindow(startedAtMs);
  const windowStart = new Date(startMs).toISOString();
  const windowEnd = new Date(endMs).toISOString();
  const updatedAt = new Date(startedAtMs).toISOString();

  try {
    const busy: BusyInterval[] = await fetchGoogleBusyIntervals(
      credentials,
      windowStart,
      windowEnd,
      { fetcher: options.fetcher },
    );
    if (new TextEncoder().encode(JSON.stringify(busy)).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("Availability snapshot exceeded size limit");
    }
    const saved = await store.saveSuccess({
      attemptAt,
      windowStart,
      windowEnd,
      updatedAt,
      busy,
    });
    return saved;
  } catch {
    try {
      await store.saveFailure(attemptAt, now());
    } catch {
      // Preserve the previous snapshot if D1 is unavailable; the next cron run retries.
    }
    options.onFailure?.();
    return false;
  }
}
