/** The complete public contract. Source calendars and event metadata stay private. */
export interface BusyInterval {
  start: string;
  end: string;
}

export interface Availability {
  status: "fresh" | "stale" | "unavailable";
  windowStart: string;
  windowEnd: string;
  updatedAt: string | null;
  busy: BusyInterval[];
}

export const DEFAULT_TIME_ZONE = "America/Vancouver";
export const WINDOW_DAYS = 30;
export const STALE_AFTER_MS = 2 * 60 * 1000;
export const UNAVAILABLE_AFTER_MS = 5 * 60 * 1000;
