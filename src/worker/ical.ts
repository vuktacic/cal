import type { Availability, BusyInterval } from "../shared/availability.ts";
import { parseRfc3339 } from "./model.ts";

const UTF8 = new TextEncoder();

function formatUtcDateTime(milliseconds: number, rounding: "floor" | "ceil"): string {
  const roundedMilliseconds =
    rounding === "floor"
      ? Math.floor(milliseconds / 1000) * 1000
      : Math.ceil(milliseconds / 1000) * 1000;
  const date = new Date(roundedMilliseconds);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/** Fold a content line at 75 UTF-8 octets without splitting a code point. */
export function foldIcalLine(line: string): string {
  if (UTF8.encode(line).byteLength <= 75) return line;

  let folded = "";
  let octetsOnLine = 0;

  for (const character of line) {
    const characterOctets = UTF8.encode(character).byteLength;
    if (octetsOnLine + characterOctets > 75) {
      folded += "\r\n ";
      octetsOnLine = 1;
    }
    folded += character;
    octetsOnLine += characterOctets;
  }

  return folded;
}

function eventLines(interval: BusyInterval, updatedAtMs: number): string[] {
  const startMs = parseRfc3339(interval.start);
  const endMs = parseRfc3339(interval.end);
  if (startMs === null || endMs === null || startMs >= endMs) {
    throw new Error("Invalid availability interval");
  }

  const uid = `busy-${endMs.toString(36)}@cal.vuktacic.com`;
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatUtcDateTime(updatedAtMs, "floor")}`,
    `DTSTART:${formatUtcDateTime(startMs, "floor")}`,
    `DTEND:${formatUtcDateTime(endMs, "ceil")}`,
    "SUMMARY:Busy",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ];
}

export function buildIcalCalendar(availability: Availability): string {
  if (availability.status === "unavailable" || availability.updatedAt === null) {
    throw new Error("Availability is unavailable");
  }

  const updatedAtMs = parseRfc3339(availability.updatedAt);
  if (updatedAtMs === null) throw new Error("Invalid availability timestamp");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//cal.vuktacic.com//Busy Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const interval of availability.busy) {
    lines.push(...eventLines(interval, updatedAtMs));
  }
  lines.push("END:VCALENDAR");

  return `${lines.map(foldIcalLine).join("\r\n")}\r\n`;
}
