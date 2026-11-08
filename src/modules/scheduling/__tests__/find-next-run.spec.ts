import { RunCursor, findNextRun, lagosDayEnd } from '../internal/run-time';

const base: RunCursor = {
  startDate: '2026-12-01',
  anchorRunNumber: 1,
  intervalUnit: 'week',
  intervalCount: 1,
  endDate: null,
  maxRuns: null,
  nextRunNumber: 1,
  runOffsetMinutes: 0,
};

// 06:00 Lagos is 05:00 UTC.
const dueAt = (date: string) => new Date(`${date}T05:00:00Z`);

describe('findNextRun', () => {
  it('is the cursor run when nothing is skipped', () => {
    expect(findNextRun({ ...base, nextRunNumber: 2 }, 1, '06:00')).toEqual({
      runNumber: 2,
      dueAt: dueAt('2026-12-08'),
    });
  });

  it('skips runs whose due time has passed', () => {
    const now = new Date('2026-12-20T12:00:00Z');
    expect(findNextRun(base, 1, '06:00', now)).toEqual({
      runNumber: 4,
      dueAt: dueAt('2026-12-22'),
    });
  });

  it('keeps a 31st anchor after skipping past a short month', () => {
    const monthly = {
      ...base,
      startDate: '2026-01-31',
      intervalUnit: 'month',
    } as const;
    const now = new Date('2026-02-20T00:00:00Z');
    expect(findNextRun(monthly, 1, '06:00', now)?.dueAt).toEqual(
      dueAt('2026-02-28'),
    );
    expect(
      findNextRun({ ...monthly, nextRunNumber: 3 }, 2, '06:00')?.dueAt,
    ).toEqual(dueAt('2026-03-31'));
  });

  it('counts created runs against maxRuns, not run numbers', () => {
    const capped = { ...base, maxRuns: 3, nextRunNumber: 6 };
    expect(findNextRun(capped, 2, '06:00')?.runNumber).toBe(6);
    expect(findNextRun(capped, 3, '06:00')).toBeNull();
  });

  it('stops at the end date', () => {
    const ended = { ...base, endDate: '2026-12-10' };
    const now = new Date('2026-12-07T00:00:00Z');
    expect(findNextRun(ended, 1, '06:00', now)?.runNumber).toBe(2);
    expect(
      findNextRun(ended, 1, '06:00', new Date('2026-12-10T12:00:00Z')),
    ).toBeNull();
  });

  it('has nothing for a one-time schedule whose date has passed or that already ran', () => {
    const once = { ...base, intervalUnit: null, intervalCount: null };
    expect(findNextRun(once, 0, '06:00')?.runNumber).toBe(1);
    expect(
      findNextRun(once, 0, '06:00', new Date('2026-12-02T00:00:00Z')),
    ).toBeNull();
    expect(findNextRun({ ...once, nextRunNumber: 2 }, 1, '06:00')).toBeNull();
  });
});

describe('lagosDayEnd', () => {
  it('is Lagos midnight after the date', () => {
    expect(lagosDayEnd('2026-12-01')).toEqual(new Date('2026-12-01T23:00:00Z'));
  });
});
