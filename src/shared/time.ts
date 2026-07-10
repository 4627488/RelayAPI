export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export type LocalDateTimeResult =
  | { ok: true; value: string }
  | { ok: false; reason: "invalid" | "ambiguous" | "nonexistent" };

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseInstant(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.includes(" ")
    ? trimmed.replace(" ", "T")
    : trimmed;
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(withTime);
  const timestamp = Date.parse(hasZone ? withTime : `${withTime}Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function formatInstant(
  value: string | null | undefined,
  timeZone: string,
) {
  const date = parseInstant(value);
  if (!date || !isValidTimeZone(timeZone)) {
    return null;
  }
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

export function instantToDateKey(value: string | Date, timeZone: string) {
  const date = value instanceof Date ? value : parseInstant(value);
  if (!date || !isValidTimeZone(timeZone)) {
    throw new RangeError("A valid instant and IANA timezone are required");
  }
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function addDateKeyDays(dateKey: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isFinite(days)) {
    throw new RangeError("A valid date key and finite day offset are required");
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Invalid date key");
  }
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return date.toISOString().slice(0, 10);
}

export function instantToLocalDateTime(
  value: string | null | undefined,
  timeZone: string,
) {
  const date = parseInstant(value);
  if (!date || !isValidTimeZone(timeZone)) {
    return "";
  }
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function localDateTimeToInstant(
  value: string,
  timeZone: string,
): LocalDateTimeResult {
  const target = parseLocalDateTime(value);
  if (!target || !isValidTimeZone(timeZone)) {
    return { ok: false, reason: "invalid" };
  }

  const wallTime = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(wallTime + hours * 60 * 60 * 1000);
    offsets.add(zoneOffsetMs(sample, timeZone));
  }

  const candidates = [...offsets]
    .map((offset) => new Date(wallTime - offset))
    .filter((candidate) => sameParts(zonedParts(candidate, timeZone), target))
    .map((candidate) => candidate.getTime());
  const unique = [...new Set(candidates)].sort((left, right) => left - right);
  if (unique.length === 0) {
    return { ok: false, reason: "nonexistent" };
  }
  if (unique.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, value: new Date(unique[0]!).toISOString() };
}

function parseLocalDateTime(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim(),
  );
  if (!match) {
    return null;
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
  const check = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return check.getUTCFullYear() === parts.year &&
    check.getUTCMonth() + 1 === parts.month &&
    check.getUTCDate() === parts.day &&
    check.getUTCHours() === parts.hour &&
    check.getUTCMinutes() === parts.minute &&
    check.getUTCSeconds() === parts.second
    ? parts
    : null;
}

function zonedParts(date: Date, timeZone: string): DateParts {
  const formatter = zonedFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedFormatter(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zoneOffsetMs(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function sameParts(left: DateParts, right: DateParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}
