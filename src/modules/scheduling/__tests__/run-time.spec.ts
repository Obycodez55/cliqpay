import {
  addDays,
  addOneYear,
  computeDueAt,
  isValidIsoDate,
  lagosToday,
  startDateBounds,
} from '../internal/run-time';

describe('lagosToday', () => {
  it('is the UTC date for most of the day', () => {
    expect(lagosToday(new Date('2026-11-08T10:00:00Z'))).toBe('2026-11-08');
  });

  it('rolls over at 23:00 UTC, which is midnight in Lagos', () => {
    expect(lagosToday(new Date('2026-11-08T22:59:59Z'))).toBe('2026-11-08');
    expect(lagosToday(new Date('2026-11-08T23:00:00Z'))).toBe('2026-11-09');
  });
});

describe('isValidIsoDate', () => {
  it.each(['2026-12-01', '2028-02-29'])('accepts %s', (value) => {
    expect(isValidIsoDate(value)).toBe(true);
  });

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-1', 'tomorrow'])(
    'rejects %s',
    (value) => {
      expect(isValidIsoDate(value)).toBe(false);
    },
  );
});

describe('addDays and addOneYear', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('adds a year, clamping Feb 29', () => {
    expect(addOneYear('2026-11-08')).toBe('2027-11-08');
    expect(addOneYear('2028-02-29')).toBe('2029-02-28');
  });
});

describe('startDateBounds', () => {
  it('runs from tomorrow to a year from today, in Lagos dates', () => {
    expect(startDateBounds(new Date('2026-11-08T10:00:00Z'))).toEqual({
      min: '2026-11-09',
      max: '2027-11-08',
    });
  });

  it('moves with the Lagos day, not the UTC one', () => {
    expect(startDateBounds(new Date('2026-11-08T23:30:00Z')).min).toBe(
      '2026-11-10',
    );
  });
});

describe('computeDueAt', () => {
  it('is the window start in Lagos, which is an hour behind in UTC', () => {
    expect(computeDueAt('2026-12-01', '06:00', 0).toISOString()).toBe(
      '2026-12-01T05:00:00.000Z',
    );
  });

  it('adds the offset in minutes', () => {
    expect(computeDueAt('2026-12-01', '06:00', 239).toISOString()).toBe(
      '2026-12-01T08:59:00.000Z',
    );
  });

  it('honours a window start with minutes', () => {
    expect(computeDueAt('2026-12-01', '07:30', 15).toISOString()).toBe(
      '2026-12-01T06:45:00.000Z',
    );
  });
});
