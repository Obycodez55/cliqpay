const DAY_MS = 24 * 60 * 60 * 1000;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function addWeekdays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setTime(result.getTime() + DAY_MS);
    if (!isWeekend(result)) {
      remaining -= 1;
    }
  }
  return result;
}

export function subtractWeekdays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setTime(result.getTime() - DAY_MS);
    if (!isWeekend(result)) {
      remaining -= 1;
    }
  }
  return result;
}
