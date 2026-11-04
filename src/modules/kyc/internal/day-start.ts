function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function startOfDay(now: Date, timeZone: string): Date {
  const wallClock = new Date(now.getTime() + offsetMs(now, timeZone));
  const localMidnightAsUtc = Date.UTC(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate(),
  );
  // Re-read the offset at the candidate instant so a DST change earlier in
  // the day doesn't shift the result by an hour.
  const candidate = new Date(localMidnightAsUtc - offsetMs(now, timeZone));
  return new Date(localMidnightAsUtc - offsetMs(candidate, timeZone));
}
