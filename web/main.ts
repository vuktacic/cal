import { STALE_AFTER_MS, UNAVAILABLE_AFTER_MS, type Availability } from "../src/shared/availability.ts";
import {
  addCalendarDays,
  classifyFreshness,
  clampCompactStart,
  clipIntervalsToStart,
  formatCompactTimeGridBlockLabel,
  dateRange,
  formatTimeGridBlockLabel,
  formatUtcOffset,
  isWithinRetentionWindow,
  layoutDayTimeGrid,
  moveCompactStartWithinRange,
  moveWeekWithinRange,
  offsetMinutesAt,
  rangeBounds,
  splitIntervalsByDate,
  startOfDateInZone,
  startOfWeekSunday,
  toDateKey,
  validateAvailabilityPayload,
  wallClockMinuteAt,
  wallClockMarks,
  type TimeGridBlock,
  type WeekDateState,
} from "./calendar.ts";

const VANCOUVER_ZONE = "America/Vancouver";
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const REFRESH_INTERVAL_MS = 15_000;
const CLOCK_REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RUNTIME_RULE_PREFIX = ".calendar-runtime-";
const HEADER_HEIGHT = 72;
const TIMELINE_EDGE_PADDING = 7;
const DEFAULT_SCROLL_MINUTE = 8 * 60;
const COMPACT_BREAKPOINT = 1050;
const COMPACT_DAY_COUNT = 3;
const MAX_VISIBLE_CONTAINER_HEIGHT = 680;
const MIN_VISIBLE_CONTAINER_HEIGHT = 120;

type DisplayState = "loading" | "fresh" | "stale" | "unavailable";
type ZoneChoice = "vancouver" | "local";

const element = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required page element: ${selector}`);
  return found;
};

const statusLine = element<HTMLParagraphElement>("#availability-status");
const previousButton = element<HTMLButtonElement>("#previous-button");
const nextButton = element<HTMLButtonElement>("#next-button");
const todayButton = element<HTMLButtonElement>("#today-button");
const weekHeading = element<HTMLHeadingElement>("#week-heading");
const timezoneToggle = element<HTMLButtonElement>("#timezone-toggle");
const calendarViewport = element<HTMLDivElement>("#calendar-viewport");
const weekGrid = element<HTMLDivElement>("#week-grid");
const linkedStylesheet = (() => {
  const stylesheet = element<HTMLLinkElement>("#calendar-stylesheet").sheet;
  if (!stylesheet) throw new Error("The same-origin calendar stylesheet is unavailable");
  return stylesheet;
})();

let zoneChoice: ZoneChoice = "vancouver";
let selectedDate = toDateKey(Date.now(), VANCOUVER_ZONE);
let weekStart = startOfWeekSunday(selectedDate);
let compactStart = selectedDate;
let previousRenderWasCompact: boolean | null = null;
let renderedTodayDate = "";
let displayState: DisplayState = "loading";
let visibleSnapshot: Availability | null = null;
let lastGoodSnapshot: Availability | null = null;
let requestActive = false;
let refreshQueued = false;
let requestAbortedForVisibility = false;
let activeController: AbortController | null = null;
let pollTimer: number | null = null;
let freshnessTimer: number | null = null;
let clockTimer: number | null = null;
let runtimeRuleId = 0;
let pixelsPerMinute = 1;
let logicalScrollMinute = DEFAULT_SCROLL_MINUTE;
let horizontalScrollPosition = 0;
let hasViewportState = false;
let restoringViewport = false;
let resizeFrame = 0;
let currentTimeLine: HTMLElement | null = null;
let currentTimeLineClass: string | null = null;

function activeZone(): string {
  return zoneChoice === "vancouver" ? VANCOUVER_ZONE : LOCAL_ZONE;
}

function currentDateInZone(): string {
  return toDateKey(Date.now(), activeZone());
}

function currentBounds(): { min: string; max: string } {
  const today = currentDateInZone();
  const currentSunday = startOfWeekSunday(today);
  if (visibleSnapshot) {
    return rangeBounds(Date.now(), activeZone(), visibleSnapshot.windowStart, visibleSnapshot.windowEnd);
  }
  const finalWeek = startOfWeekSunday(addCalendarDays(today, 29));
  return { min: currentSunday, max: addCalendarDays(finalWeek, 6) };
}

function formatDate(dateKey: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: activeZone() }).format(
    startOfDateInZone(dateKey, activeZone()),
  );
}

function formatTimestamp(timestamp: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: activeZone() }).format(Date.parse(timestamp));
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: activeZone(),
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.parse(timestamp));
}

function dayOffsetLabel(dateKey: string): string | null {
  const start = startOfDateInZone(dateKey, activeZone());
  const end = startOfDateInZone(addCalendarDays(dateKey, 1), activeZone()) - 1;
  const startOffset = formatUtcOffset(offsetMinutesAt(start, activeZone()));
  const endOffset = formatUtcOffset(offsetMinutesAt(end, activeZone()));
  return startOffset === endOffset ? null : `DST · ${startOffset.replace("UTC", "")} → ${endOffset.replace("UTC", "")}`;
}

function refreshTimezoneNote(): void {
  timezoneToggle.textContent = "Vancouver time";
  timezoneToggle.setAttribute("aria-checked", String(zoneChoice === "vancouver"));
  timezoneToggle.title = activeZone();
}

function setStatus(state: DisplayState): void {
  displayState = state;
  if (state === "loading") {
    statusLine.textContent = "Checking availability…";
  } else if (state === "fresh" && visibleSnapshot?.updatedAt) {
    statusLine.textContent = `Updated ${formatTimestamp(visibleSnapshot.updatedAt, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}.`;
  } else if (state === "stale" && visibleSnapshot?.updatedAt) {
    statusLine.textContent = `Update is stale · last updated ${formatTimestamp(visibleSnapshot.updatedAt, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}; busy times may have changed.`;
  } else {
    statusLine.textContent = "Unavailable · busy times are hidden until data is available.";
  }
}

function clearFreshnessTimer(): void {
  if (freshnessTimer !== null) window.clearTimeout(freshnessTimer);
  freshnessTimer = null;
}

function scheduleFreshnessTimer(now = Date.now()): void {
  clearFreshnessTimer();
  if (!visibleSnapshot || (displayState !== "fresh" && displayState !== "stale")) return;

  const updatedAt = Date.parse(visibleSnapshot.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return;
  const threshold = displayState === "fresh" ? STALE_AFTER_MS : UNAVAILABLE_AFTER_MS;
  const delay = Math.max(1, updatedAt + threshold - now + 1);
  freshnessTimer = window.setTimeout(() => {
    freshnessTimer = null;
    refreshSnapshotFreshness();
  }, delay);
}

function refreshSnapshotFreshness(now = Date.now()): void {
  if (!visibleSnapshot) {
    clearFreshnessTimer();
    return;
  }

  const nextState = classifyFreshness(visibleSnapshot.status, visibleSnapshot.updatedAt, now);
  if (nextState === "unavailable") {
    visibleSnapshot = null;
    clearFreshnessTimer();
    setStatus("unavailable");
    captureAndRenderWeek();
    return;
  }

  const changed = nextState !== displayState || visibleSnapshot.status !== nextState;
  visibleSnapshot = { ...visibleSnapshot, status: nextState };
  setStatus(nextState);
  if (changed) captureAndRenderWeek();
  scheduleFreshnessTimer(now);
}

function captureViewportPosition(): void {
  if (!hasViewportState || restoringViewport) return;
  logicalScrollMinute = Math.min(24 * 60, Math.max(0, calendarViewport.scrollTop / pixelsPerMinute));
  horizontalScrollPosition = Math.max(0, calendarViewport.scrollLeft);
}

function visibleViewportSize(): { height: number } {
  const top = calendarViewport.getBoundingClientRect().top + window.scrollY;
  const statusStyle = getComputedStyle(statusLine);
  const statusHeight = Math.max(statusLine.getBoundingClientRect().height, parseFloat(statusStyle.lineHeight) * 2);
  const bottomPadding = parseFloat(getComputedStyle(calendarViewport.parentElement!).paddingBottom);
  const available = window.innerHeight - top - statusHeight - parseFloat(statusStyle.marginTop) - bottomPadding - 32;
  const height = Math.max(MIN_VISIBLE_CONTAINER_HEIGHT, Math.min(MAX_VISIBLE_CONTAINER_HEIGHT, available));
  return { height };
}

function clearRuntimeRules(): void {
  for (let index = linkedStylesheet.cssRules.length - 1; index >= 0; index -= 1) {
    const rule = linkedStylesheet.cssRules[index];
    const selector = (rule as CSSStyleRule).selectorText;
    if (typeof selector === "string" && selector.startsWith(RUNTIME_RULE_PREFIX)) {
      linkedStylesheet.deleteRule(index);
    }
  }
  for (const target of [calendarViewport, weekGrid]) {
    for (const className of [...target.classList]) {
      if (className.startsWith(RUNTIME_RULE_PREFIX.slice(1))) target.classList.remove(className);
    }
  }
  runtimeRuleId = 0;
  currentTimeLine = null;
  currentTimeLineClass = null;
}

function installRuntimeRule(selector: string, declarations: string): void {
  linkedStylesheet.insertRule(`${selector}{${declarations}}`, linkedStylesheet.cssRules.length);
}

function addRuntimeRule(elementToStyle: HTMLElement, declarations: string): string {
  const className = `calendar-runtime-${runtimeRuleId++}`;
  elementToStyle.classList.add(className);
  installRuntimeRule(`.${className}`, declarations);
  return className;
}

function applyTimePosition(elementToStyle: HTMLElement, minute: number, heightMinutes?: number): string | null {
  if (!Number.isFinite(minute) || minute < 0 || minute > 1440) return null;
  const declarations = [`top:${(minute * pixelsPerMinute + TIMELINE_EDGE_PADDING).toFixed(4)}px`];
  if (heightMinutes !== undefined) {
    const remaining = Math.max(0, 1440 - minute);
    const height = Math.min(Math.max(0, heightMinutes), remaining);
    if (!Number.isFinite(height) || height <= 0) return null;
    declarations.push(`height:${(height * pixelsPerMinute).toFixed(4)}px`);
  }
  return addRuntimeRule(elementToStyle, declarations.join(";"));
}

function updateCurrentTimeLinePosition(): void {
  if (!currentTimeLine || !currentTimeLineClass) return;
  const minute = wallClockMinuteAt(Date.now(), activeZone());
  const selector = `.${currentTimeLineClass}`;
  for (const rule of linkedStylesheet.cssRules) {
    if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
      rule.style.setProperty("top", `${(minute * pixelsPerMinute + TIMELINE_EDGE_PADDING).toFixed(4)}px`);
      return;
    }
  }
}

function busyAccessibleLabel(block: TimeGridBlock): string {
  const ranges = block.sourceIntervals.map((interval) => {
    const startOffset = formatUtcOffset(offsetMinutesAt(Date.parse(interval.start), activeZone()));
    const endOffset = formatUtcOffset(offsetMinutesAt(Date.parse(interval.end), activeZone()));
    const exactStart = new Date(Date.parse(interval.start)).toISOString();
    const exactEnd = new Date(Date.parse(interval.end)).toISOString();
    return `${formatTime(interval.start)} ${startOffset} (${exactStart}) to ${formatTime(interval.end)} ${endOffset} (${exactEnd})`;
  });
  return `Busy from ${ranges.join("; ")} in ${activeZone()}`;
}

function makeDayMessage(state: WeekDateState, currentState: DisplayState): string | null {
  if (state === "past") return "Past date · not shown";
  if (state === "uncovered") return "Outside available window";
  if (state === "outside") return "Outside available window";
  if (currentState === "loading") return "Checking availability";
  if (currentState === "unavailable") return "Availability unavailable";
  return null;
}

function captureAndRenderWeek(captureViewport = true): void {
  if (captureViewport) captureViewportPosition();
  const bounds = currentBounds();
  const today = currentDateInZone();
  const minimumWeek = startOfWeekSunday(today);
  const maximumWeek = startOfWeekSunday(bounds.max);
  const compact = window.innerWidth <= COMPACT_BREAKPOINT;
  let dates: ReturnType<typeof dateRange>;
  if (compact) {
    if (!previousRenderWasCompact) compactStart = selectedDate;
    compactStart = clampCompactStart(compactStart, bounds.min, bounds.max);
    dates = dateRange(compactStart, COMPACT_DAY_COUNT, minimumWeek, bounds.min, bounds.max);
    previousButton.disabled = compactStart <= clampCompactStart(bounds.min, bounds.min, bounds.max);
    nextButton.disabled = compactStart >= clampCompactStart(bounds.max, bounds.min, bounds.max);
  } else {
    if (previousRenderWasCompact) weekStart = startOfWeekSunday(selectedDate);
    weekStart = startOfWeekSunday(weekStart);
    if (weekStart < minimumWeek) weekStart = minimumWeek;
    if (weekStart > maximumWeek) weekStart = maximumWeek;
    dates = dateRange(weekStart, 7, minimumWeek, bounds.min, bounds.max);
    previousButton.disabled = weekStart <= minimumWeek;
    nextButton.disabled = weekStart >= maximumWeek;
  }
  previousRenderWasCompact = compact;
  todayButton.disabled = false;
  previousButton.setAttribute("aria-label", compact ? "Previous three days" : "Previous week");
  nextButton.setAttribute("aria-label", compact ? "Next three days" : "Next week");
  renderedTodayDate = today;

  const firstDate = dates[0].date;
  const lastDate = dates.at(-1)?.date ?? firstDate;
  const firstLabel = formatDate(firstDate, { month: "short", day: "numeric" });
  const lastLabel = formatDate(lastDate, {
    month: "short",
    day: "numeric",
    year: firstDate.slice(0, 4) !== lastDate.slice(0, 4) ? "numeric" : undefined,
  });
  weekHeading.textContent = `${firstLabel} – ${lastLabel}`;
  const rangeLabel = `${firstLabel} – ${lastLabel}`;
  calendarViewport.setAttribute(
    "aria-label",
    `${compact ? "Three-day" : "Weekly"} calendar, ${rangeLabel}. Scroll vertically to view midnight through midnight.`,
  );
  weekGrid.setAttribute("aria-label", `${compact ? "Three-day" : "Weekly"} availability by day, ${rangeLabel}`);
  refreshTimezoneNote();

  const viewportSize = visibleViewportSize();
  restoringViewport = true;
  clearRuntimeRules();
  weekGrid.replaceChildren();

  addRuntimeRule(calendarViewport, `height:${viewportSize.height.toFixed(2)}px`);
  pixelsPerMinute = Math.max(1, calendarViewport.clientHeight - HEADER_HEIGHT - 2 * TIMELINE_EDGE_PADDING) / (13 * 60);
  const timelineHeight = 1440 * pixelsPerMinute + 2 * TIMELINE_EDGE_PADDING;
  const weekClass = addRuntimeRule(weekGrid, `grid-template-rows:${HEADER_HEIGHT}px ${timelineHeight.toFixed(4)}px`);
  const hourHeight = 60 * pixelsPerMinute;
  installRuntimeRule(
    `.${weekClass} .day-timeline`,
    `background-image:repeating-linear-gradient(to bottom,#ededed 0px,#ededed 1px,transparent 1px,transparent ${hourHeight.toFixed(4)}px);background-position:0 ${TIMELINE_EDGE_PADDING}px`,
  );

  const busyStart = visibleSnapshot
    ? Math.max(
        startOfDateInZone(startOfWeekSunday(today), activeZone()),
        Date.parse(visibleSnapshot.windowStart),
      )
    : Number.POSITIVE_INFINITY;
  const visibleBusy = visibleSnapshot ? clipIntervalsToStart(visibleSnapshot.busy, busyStart) : [];
  const busyByDate = splitIntervalsByDate(visibleBusy, activeZone());

  const corner = document.createElement("div");
  corner.className = "grid-corner";
  corner.textContent = "Time";
  corner.setAttribute("aria-hidden", "true");
  weekGrid.append(corner);

  for (const day of dates) {
    const message = makeDayMessage(day.state, displayState);
    const heading = document.createElement("header");
    heading.className = "day-header";
    const date = document.createElement("h2");
    date.className = "day-date";
    date.textContent = formatDate(day.date, { weekday: "short", day: "numeric" });
    const exactDate = formatDate(day.date, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (day.date === today) {
      heading.dataset.today = "true";
      date.setAttribute("aria-current", "date");
    }
    const offsetText = dayOffsetLabel(day.date);
    if (offsetText) {
      const offset = document.createElement("span");
      offset.className = "day-offset";
      offset.textContent = offsetText;
      heading.append(date, offset);
    } else {
      heading.append(date);
    }
    if (message) {
      heading.dataset.range = day.state;
      heading.dataset.state = displayState;
      heading.setAttribute("aria-disabled", "true");
      heading.setAttribute("aria-label", `${exactDate}: ${message}`);
    } else {
      heading.setAttribute("aria-label", `${exactDate}${offsetText ? `, ${offsetText}` : ""}`);
    }
    weekGrid.append(heading);
  }

  const ruler = document.createElement("aside");
  ruler.className = "time-ruler";
  ruler.setAttribute("aria-label", "Time of day, midnight to midnight");
  const rulerContent = document.createElement("div");
  rulerContent.className = "time-ruler-content";
  for (const mark of wallClockMarks()) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.setAttribute("aria-label", `${mark.label} ${activeZone()}`);
    applyTimePosition(tick, mark.topMinutes);
    const label = document.createElement("span");
    label.className = "ruler-label";
    label.textContent = mark.label;
    if (mark.topMinutes === 0) label.classList.add("ruler-label-start");
    if (mark.topMinutes === 1440) label.classList.add("ruler-label-end");
    tick.append(label);
    rulerContent.append(tick);
  }
  addRuntimeRule(rulerContent, `height:${timelineHeight.toFixed(4)}px`);
  ruler.append(rulerContent);
  weekGrid.append(ruler);

  for (const day of dates) {
    const message = makeDayMessage(day.state, displayState);
    const layout = layoutDayTimeGrid(busyByDate.get(day.date) ?? [], day.date, activeZone());
    const timeline = document.createElement("div");
    timeline.className = "day-timeline";
    timeline.setAttribute("role", "group");
    timeline.dataset.range = day.state;
    timeline.dataset.state = displayState;
    if (day.date === today) timeline.dataset.today = "true";
    timeline.setAttribute(
      "aria-label",
      formatDate(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    );

    if (message) {
      timeline.setAttribute("aria-disabled", "true");
      const stateMessage = document.createElement("p");
      stateMessage.className = "day-state-message";
      stateMessage.textContent = message;
      timeline.append(stateMessage);
    } else if (visibleSnapshot) {
      timeline.setAttribute(
        "aria-label",
        `${formatDate(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}. ${
          layout.blocks.length > 0
            ? "Busy blocks are listed."
            : displayState === "stale"
              ? "No busy blocks listed in the last update."
              : "No busy blocks listed."
        }`,
      );
      for (const block of layout.blocks) {
        const top = Math.max(0, Math.min(1440, block.topMinutes));
        const remaining = Math.max(0, 1440 - top);
        const height = Math.min(Math.max(0, block.heightMinutes), remaining);
        if (height <= 0) continue;
        const busy = document.createElement("div");
        busy.className = "busy-block";
        busy.setAttribute("role", "group");
        const title = document.createElement("span");
        title.className = "busy-title";
        title.textContent = "Busy";
        const time = document.createElement("span");
        time.className = "busy-time";
        const renderedHeight = height * pixelsPerMinute;
        const size = renderedHeight >= 44 ? "tall" : renderedHeight >= 20 ? "compact" : "tiny";
        busy.dataset.size = size;
        time.textContent = size === "compact"
          ? formatCompactTimeGridBlockLabel(block, activeZone())
          : formatTimeGridBlockLabel(block, activeZone());
        busy.append(title, time);
        busy.setAttribute("aria-label", busyAccessibleLabel(block));
        busy.title = busyAccessibleLabel(block);
        applyTimePosition(busy, top, height);
        timeline.append(busy);
      }
    }
    if (day.date === today) {
      const line = document.createElement("div");
      line.className = "current-time-line";
      line.setAttribute("aria-hidden", "true");
      currentTimeLine = line;
      currentTimeLineClass = applyTimePosition(line, wallClockMinuteAt(Date.now(), activeZone()));
      timeline.append(line);
    }
    weekGrid.append(timeline);
  }

  calendarViewport.scrollTop = logicalScrollMinute * pixelsPerMinute;
  calendarViewport.scrollLeft = horizontalScrollPosition;
  hasViewportState = true;
  restoringViewport = false;
}

function keepRecentSnapshot(now: number): void {
  if (lastGoodSnapshot && isWithinRetentionWindow(lastGoodSnapshot.updatedAt, now)) {
    visibleSnapshot = { ...lastGoodSnapshot, status: "stale" };
    setStatus("stale");
    scheduleFreshnessTimer(now);
  } else {
    visibleSnapshot = null;
    clearFreshnessTimer();
    setStatus("unavailable");
  }
  captureAndRenderWeek();
}

async function refreshAvailability(): Promise<void> {
  if (document.hidden) return;
  refreshSnapshotFreshness();
  if (requestActive) {
    refreshQueued = true;
    return;
  }
  requestActive = true;
  const controller = new AbortController();
  activeController = controller;
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/availability", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Availability response was not valid JSON");
    }

    if (!validateAvailabilityPayload(payload, response.status)) {
      throw new Error("Availability response did not match the public contract");
    }

    const responseTime = Date.now();
    const responseFreshness = classifyFreshness(payload.status, payload.updatedAt, responseTime);
    if (responseFreshness === "unavailable") {
      keepRecentSnapshot(responseTime);
    } else {
      const today = toDateKey(responseTime, activeZone());
      const currentDayEnd = startOfDateInZone(addCalendarDays(today, 1), activeZone());
      if (
        Date.parse(payload.windowStart) > responseTime + 60_000 ||
        Date.parse(payload.windowEnd) < currentDayEnd
      ) {
        throw new Error("Availability response window does not cover today");
      }
      visibleSnapshot = { ...payload, status: responseFreshness };
      lastGoodSnapshot = payload;
      setStatus(responseFreshness);
      scheduleFreshnessTimer(responseTime);
      captureAndRenderWeek();
    }
  } catch {
    if (!document.hidden && !requestAbortedForVisibility) keepRecentSnapshot(Date.now());
  } finally {
    window.clearTimeout(timeout);
    if (activeController === controller) activeController = null;
    requestActive = false;
    requestAbortedForVisibility = false;
    if (refreshQueued && !document.hidden) {
      refreshQueued = false;
      void refreshAvailability();
    }
  }
}

function startPolling(): void {
  if (pollTimer !== null || document.hidden) return;
  pollTimer = window.setInterval(() => void refreshAvailability(), REFRESH_INTERVAL_MS);
}

previousButton.addEventListener("click", () => {
  if (previousButton.disabled) return;
  const bounds = currentBounds();
  if (window.innerWidth <= COMPACT_BREAKPOINT) {
    compactStart = moveCompactStartWithinRange(compactStart, -1, bounds.min, bounds.max);
    selectedDate = compactStart;
  } else {
    const currentSunday = startOfWeekSunday(currentDateInZone());
    weekStart = moveWeekWithinRange(weekStart, -1, currentSunday, bounds.max);
    selectedDate = weekStart;
  }
  captureAndRenderWeek();
});

nextButton.addEventListener("click", () => {
  if (nextButton.disabled) return;
  const bounds = currentBounds();
  if (window.innerWidth <= COMPACT_BREAKPOINT) {
    compactStart = moveCompactStartWithinRange(compactStart, 1, bounds.min, bounds.max);
    selectedDate = compactStart;
  } else {
    const currentSunday = startOfWeekSunday(currentDateInZone());
    weekStart = moveWeekWithinRange(weekStart, 1, currentSunday, bounds.max);
    selectedDate = weekStart;
  }
  captureAndRenderWeek();
});

todayButton.addEventListener("click", () => {
  selectedDate = currentDateInZone();
  compactStart = selectedDate;
  weekStart = startOfWeekSunday(selectedDate);
  logicalScrollMinute = DEFAULT_SCROLL_MINUTE;
  captureAndRenderWeek(false);
});

timezoneToggle.addEventListener("click", () => {
  zoneChoice = zoneChoice === "vancouver" ? "local" : "vancouver";
  selectedDate = currentDateInZone();
  compactStart = selectedDate;
  weekStart = startOfWeekSunday(selectedDate);
  captureAndRenderWeek();
});

calendarViewport.addEventListener(
  "scroll",
  () => {
    if (restoringViewport || !hasViewportState) return;
    logicalScrollMinute = Math.min(24 * 60, Math.max(0, calendarViewport.scrollTop / pixelsPerMinute));
    horizontalScrollPosition = Math.max(0, calendarViewport.scrollLeft);
  },
  { passive: true },
);

function clearClockTimer(): void {
  if (clockTimer !== null) window.clearTimeout(clockTimer);
  clockTimer = null;
}

function refreshCurrentTime(): void {
  clearClockTimer();
  if (document.hidden) return;

  const today = currentDateInZone();
  if (today !== renderedTodayDate) {
    captureAndRenderWeek();
  } else {
    refreshTimezoneNote();
    updateCurrentTimeLinePosition();
  }

  const delay = CLOCK_REFRESH_INTERVAL_MS - (Date.now() % CLOCK_REFRESH_INTERVAL_MS) + 5;
  clockTimer = window.setTimeout(refreshCurrentTime, delay);
}

function refreshWhenActive(): void {
  refreshCurrentTime();
  refreshSnapshotFreshness();
  void refreshAvailability();
}

window.addEventListener("focus", refreshWhenActive);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
    clearClockTimer();
    refreshQueued = false;
    requestAbortedForVisibility = activeController !== null;
    activeController?.abort();
  } else {
    refreshWhenActive();
    startPolling();
  }
});

window.addEventListener(
  "resize",
  () => {
    if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      captureAndRenderWeek();
    });
  },
  { passive: true },
);

setStatus("loading");
captureAndRenderWeek();
refreshCurrentTime();
void refreshAvailability();
startPolling();
