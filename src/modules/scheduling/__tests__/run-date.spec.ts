import { runDate } from '../internal/run-time';

const monthly = { unit: 'month', count: 1 } as const;

describe('runDate', () => {
  it('is the start date for the anchor run', () => {
    expect(runDate('2026-12-01', 1, { unit: 'day', count: 3 }, 1)).toBe(
      '2026-12-01',
    );
  });

  it('steps days', () => {
    expect(runDate('2026-12-30', 1, { unit: 'day', count: 1 }, 4)).toBe(
      '2027-01-02',
    );
    expect(runDate('2026-12-01', 1, { unit: 'day', count: 10 }, 3)).toBe(
      '2026-12-21',
    );
  });

  it('steps weeks, and biweekly', () => {
    expect(runDate('2026-12-01', 1, { unit: 'week', count: 1 }, 3)).toBe(
      '2026-12-15',
    );
    expect(runDate('2026-12-01', 1, { unit: 'week', count: 2 }, 3)).toBe(
      '2026-12-29',
    );
  });

  it('steps months on the same day of the month', () => {
    expect(runDate('2026-12-15', 1, monthly, 2)).toBe('2027-01-15');
    expect(runDate('2026-12-15', 1, { unit: 'month', count: 3 }, 3)).toBe(
      '2027-06-15',
    );
  });

  it('clamps a month-end anchor and recovers on longer months', () => {
    const dates = [1, 2, 3, 4, 5].map((n) =>
      runDate('2027-01-31', 1, monthly, n),
    );
    expect(dates).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ]);
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(runDate('2027-12-31', 1, monthly, 3)).toBe('2028-02-29');
  });

  it('takes a Feb 29 anchor to Feb 28 in non-leap years and back', () => {
    const yearly = { unit: 'month', count: 12 } as const;
    expect(runDate('2028-02-29', 1, yearly, 2)).toBe('2029-02-28');
    expect(runDate('2028-02-29', 1, yearly, 5)).toBe('2032-02-29');
  });

  it('counts from the anchor run number, not from run 1', () => {
    expect(runDate('2026-12-01', 4, { unit: 'week', count: 1 }, 4)).toBe(
      '2026-12-01',
    );
    expect(runDate('2026-12-01', 4, { unit: 'week', count: 1 }, 6)).toBe(
      '2026-12-15',
    );
  });

  it('is independent of earlier runs for large n', () => {
    expect(runDate('2027-01-31', 1, monthly, 366)).toBe('2057-06-30');
    expect(runDate('2026-12-01', 1, { unit: 'day', count: 365 }, 366)).toBe(
      '2391-09-04',
    );
  });
});
