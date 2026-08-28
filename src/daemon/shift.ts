// shift.ts — pure evaluator for per-agent shift schedules.
// Per internal design docs §3 schema + §4 behavior matrix.
//
// Decides one of three states for a given now:
//   - in_shift                 : daemon should fire crons / wakes as today
//   - off_shift_emergency_only : drop most events; user-explicit / inbox-priority-high allowed
//   - off_shift_no_wake        : drop all events except direct user wake (Telegram / SIGUSR1)
//
// Pure function. No clock, no config IO. Caller passes now + schedule + agent timezone.
// Backwards compat: schedule undefined → in_shift always (preserves current 24/7 behavior).

export type ShiftWindow = { start: string; end: string }; // "HH:MM" 24h, agent-timezone

export type DayShift = ShiftWindow | "off" | "24h";

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface ExceptionDay {
  date: string; // "YYYY-MM-DD" in agent timezone
  shift: DayShift;
  reason?: string;
}

export interface ShiftSchedule {
  weekly: Record<WeekdayKey, DayShift>;
  exception_days?: ExceptionDay[];
  emergency_override?: {
    off_shift_can_wake_for: string[];
  };
}

export interface ShiftEvaluation {
  in_shift: boolean;
  off_shift_emergency_only: boolean;
  off_shift_no_wake: boolean;
}

const WEEKDAY_MAP: Record<string, WeekdayKey> = {
  Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};

interface TzNow {
  weekdayKey: WeekdayKey;
  dateKey: string; // "YYYY-MM-DD"
  timeKey: string; // "HH:MM" 24h
}

function nowInAgentTz(now: Date, agentTimezone: string): TzNow {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: agentTimezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekdayShort = get("weekday");
  const weekdayKey = WEEKDAY_MAP[weekdayShort];
  if (!weekdayKey) {
    throw new Error(
      `shift.evaluateShift: unrecognized weekday '${weekdayShort}' from Intl in tz '${agentTimezone}'`
    );
  }

  let hour = get("hour");
  // Some Intl implementations return "24" at midnight under hour12: false; normalize to "00".
  if (hour === "24") hour = "00";

  return {
    weekdayKey,
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    timeKey: `${hour}:${get("minute")}`,
  };
}

function isInWindow(timeKey: string, window: ShiftWindow): boolean {
  const { start, end } = window;
  // Same-day window: start <= end
  if (start <= end) {
    return timeKey >= start && timeKey < end;
  }
  // Midnight-crossing window: start > end (e.g. 22:00 - 06:00)
  return timeKey >= start || timeKey < end;
}

function offShiftClassification(schedule: ShiftSchedule): ShiftEvaluation {
  const allowlist = schedule.emergency_override?.off_shift_can_wake_for ?? [];
  if (allowlist.length > 0) {
    return { in_shift: false, off_shift_emergency_only: true, off_shift_no_wake: false };
  }
  return { in_shift: false, off_shift_emergency_only: false, off_shift_no_wake: true };
}

function isShiftWindow(s: DayShift): s is ShiftWindow {
  return typeof s === "object" && s !== null && "start" in s && "end" in s;
}

/**
 * Evaluate the shift state for an agent at `now` given `schedule` and `agentTimezone`.
 *
 * Precedence:
 *   1. If `schedule` is undefined → in_shift (backwards compat with day_mode-less configs).
 *   2. exception_days[].date matching today's date in agent tz wins over weekly.
 *   3. weekly[weekday] resolves to "24h" / "off" / window.
 *   4. Window boundary: inclusive start, exclusive end ("09:00"-"18:00" excludes 18:00 sharp).
 *   5. Off-shift classification: allowlist with ≥1 tag → emergency-only; empty/missing → no-wake.
 */
export function evaluateShift(
  now: Date,
  schedule: ShiftSchedule | undefined,
  agentTimezone: string
): ShiftEvaluation {
  if (!schedule) {
    return { in_shift: true, off_shift_emergency_only: false, off_shift_no_wake: false };
  }

  const tzNow = nowInAgentTz(now, agentTimezone);

  // exception_days override weekly
  const exception = schedule.exception_days?.find((d) => d.date === tzNow.dateKey);
  const dayShift: DayShift | undefined = exception
    ? exception.shift
    : schedule.weekly[tzNow.weekdayKey];

  // Missing weekly entry treated as "off" for safety (RFC §3 says all 7 fields, but be defensive).
  if (dayShift === undefined) {
    return offShiftClassification(schedule);
  }

  if (dayShift === "24h") {
    return { in_shift: true, off_shift_emergency_only: false, off_shift_no_wake: false };
  }

  if (dayShift === "off") {
    return offShiftClassification(schedule);
  }

  if (isShiftWindow(dayShift)) {
    if (isInWindow(tzNow.timeKey, dayShift)) {
      return { in_shift: true, off_shift_emergency_only: false, off_shift_no_wake: false };
    }
    return offShiftClassification(schedule);
  }

  // Unknown shape — defensive default to off-shift no-wake (caller should have caught at config load).
  return offShiftClassification(schedule);
}
