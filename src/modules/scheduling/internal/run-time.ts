const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Africa/Lagos is UTC+1 all year, with no DST.
const LAGOS_OFFSET_MS = 60 * MINUTE_MS;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function lagosToday(now: Date): string {
  return toIsoDate(new Date(now.getTime() + LAGOS_OFFSET_MS));
}

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) {
    return false;
  }
  const parsed = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return toIsoDate(parsed) === value;
}

export function addDays(isoDate: string, days: number): string {
  return toIsoDate(
    new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS),
  );
}

// Feb 29 + 1 year is Feb 28, never Mar 1.
export function addOneYear(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const lastDayOfMonth = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  return toIsoDate(
    new Date(Date.UTC(year + 1, month - 1, Math.min(day, lastDayOfMonth))),
  );
}

// The allowed start dates, as Lagos calendar dates: tomorrow at the
// earliest, one year ahead at the latest.
export function startDateBounds(now: Date): { min: string; max: string } {
  const today = lagosToday(now);
  return { min: addDays(today, 1), max: addOneYear(today) };
}

export const INTERVAL_UNITS = ['day', 'week', 'month'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export interface Interval {
  unit: IntervalUnit;
  count: number;
}

function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return toIsoDate(
    new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))),
  );
}

// Always counted from the anchor, never from the previous run, so a clamped
// month (Jan 31 -> Feb 28) doesn't drag later months down to the 28th.
export function runDate(
  startDate: string,
  anchorRunNumber: number,
  interval: Interval,
  runNumber: number,
): string {
  const steps = (runNumber - anchorRunNumber) * interval.count;
  switch (interval.unit) {
    case 'day':
      return addDays(startDate, steps);
    case 'week':
      return addDays(startDate, steps * 7);
    case 'month':
      return addMonths(startDate, steps);
  }
}

export function computeDueAt(
  isoDate: string,
  windowStart: string,
  offsetMinutes: number,
): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hours, minutes] = windowStart.split(':').map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hours, minutes) -
      LAGOS_OFFSET_MS +
      offsetMinutes * MINUTE_MS,
  );
}
