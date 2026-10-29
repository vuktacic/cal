import type { Availability } from "../shared/availability.ts";
import { buildIcalCalendar } from "./ical.ts";
import { makeAvailability, unavailableAvailability } from "./model.ts";
import { refreshAvailability } from "./refresh.ts";
import { D1SnapshotStore, type SnapshotStore } from "./storage.ts";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
};

interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface RequestDependencies {
  store: SnapshotStore;
  assets: AssetBinding;
  now?: () => number;
}

function applySecurityHeaders(response: Response, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (additionalHeaders) {
    new Headers(additionalHeaders).forEach((value, name) => headers.set(name, value));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function apiJsonResponse(value: Availability, status: number): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
}

function apiErrorResponse(status: number, error: "not_found" | "method_not_allowed"): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify({ error }), {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...(status === 405 ? { Allow: "GET" } : {}),
      },
    }),
  );
}

function apiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function icalFailureResponse(request: Request, status: 503 | 405): Response {
  const unavailable = status === 503;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  if (unavailable) {
    headers.set("Retry-After", "60");
    headers.set("X-Availability-Status", "unavailable");
  } else {
    headers.set("Allow", "GET, HEAD");
  }
  const body = unavailable ? "Availability temporarily unavailable\r\n" : "Method not allowed\r\n";
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  return applySecurityHeaders(
    new Response(request.method === "HEAD" ? null : body, { status, headers }),
  );
}

async function handleIcalRequest(
  request: Request,
  dependencies: RequestDependencies,
  nowMs: number,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return icalFailureResponse(request, 405);
  }

  let availability: Availability;
  try {
    availability = makeAvailability(await dependencies.store.load(), nowMs);
  } catch {
    return icalFailureResponse(request, 503);
  }
  if (availability.status === "unavailable") return icalFailureResponse(request, 503);

  try {
    const calendar = buildIcalCalendar(availability);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="busy.ics"',
      "Content-Type": "text/calendar;charset=utf-8",
      "X-Availability-Status": availability.status,
      "Content-Length": String(new TextEncoder().encode(calendar).byteLength),
    });
    return applySecurityHeaders(
      new Response(request.method === "HEAD" ? null : calendar, { status: 200, headers }),
    );
  } catch {
    return icalFailureResponse(request, 503);
  }
}

export async function handleRequest(
  request: Request,
  dependencies: RequestDependencies,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const nowMs = (dependencies.now ?? Date.now)();

  if (pathname === "/busy.ics") {
    return handleIcalRequest(request, dependencies, nowMs);
  }

  if (pathname === "/api/availability") {
    if (request.method !== "GET") return apiErrorResponse(405, "method_not_allowed");
    try {
      const availability = makeAvailability(await dependencies.store.load(), nowMs);
      return apiJsonResponse(availability, availability.status === "unavailable" ? 503 : 200);
    } catch {
      return apiJsonResponse(unavailableAvailability(nowMs), 503);
    }
  }

  if (apiPath(pathname)) return apiErrorResponse(404, "not_found");

  try {
    return applySecurityHeaders(await dependencies.assets.fetch(request));
  } catch {
    return applySecurityHeaders(
      new Response("Service unavailable", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, {
      store: new D1SnapshotStore(env.DB),
      assets: env.ASSETS,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    await refreshAvailability(
      {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: env.GOOGLE_REFRESH_TOKEN,
      },
      new D1SnapshotStore(env.DB),
      {
        onFailure: () => console.error(JSON.stringify({ event: "availability_refresh_failed" })),
      },
    );
  },
} satisfies ExportedHandler<Env>;
