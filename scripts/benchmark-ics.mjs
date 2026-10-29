import { buildIcalCalendar } from "../src/worker/ical.ts";

// Synthetic data only; no credentials, database access, or network calls.
const now = Date.now();
const availability = {
  status: "fresh",
  windowStart: new Date(now).toISOString(),
  windowEnd: new Date(now + 30 * 86_400_000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  busy: Array.from({ length: 100 }, (_, index) => ({
    start: new Date(now + index * 7_200_000).toISOString(),
    end: new Date(now + index * 7_200_000 + 3_600_000).toISOString(),
  })),
};

for (let index = 0; index < 50; index++) buildIcalCalendar(availability);
const iterations = 300;
const started = process.cpuUsage();
for (let index = 0; index < iterations; index++) buildIcalCalendar(availability);
const cpu = process.cpuUsage(started);

console.log(JSON.stringify({
  events: availability.busy.length,
  bytes: Buffer.byteLength(buildIcalCalendar(availability)),
  iterations,
  averageFormattingCpuMs: (cpu.user + cpu.system) / (iterations * 1000),
  note: "Local formatting CPU only; measure full request CPU on Cloudflare before launch.",
}, null, 2));
