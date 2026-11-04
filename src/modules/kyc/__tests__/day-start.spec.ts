import { startOfDay } from '../internal/day-start';

const iso = (d: Date) => d.toISOString();

describe('startOfDay', () => {
  describe('Africa/Lagos (UTC+1, no DST)', () => {
    const lagos = (s: string) => iso(startOfDay(new Date(s), 'Africa/Lagos'));

    it('keeps 23:59:59 WAT in the same day', () => {
      expect(lagos('2026-10-17T22:59:59.000Z')).toBe(
        '2026-10-16T23:00:00.000Z',
      );
    });

    it('starts a new day at exactly 00:00:00 WAT', () => {
      expect(lagos('2026-10-17T23:00:00.000Z')).toBe(
        '2026-10-17T23:00:00.000Z',
      );
    });

    it('is already the next day just before the UTC date changes', () => {
      expect(lagos('2026-10-17T23:30:00.000Z')).toBe(
        '2026-10-17T23:00:00.000Z',
      );
    });

    it('puts 00:30 UTC (01:30 WAT) in the day that began at 23:00 UTC before', () => {
      expect(lagos('2026-10-18T00:30:00.000Z')).toBe(
        '2026-10-17T23:00:00.000Z',
      );
    });

    it('handles the year boundary', () => {
      expect(lagos('2026-12-31T23:30:00.000Z')).toBe(
        '2026-12-31T23:00:00.000Z',
      );
    });
  });

  it('works for a zone behind UTC with DST (America/New_York, summer)', () => {
    expect(
      iso(startOfDay(new Date('2026-07-01T03:59:59.000Z'), 'America/New_York')),
    ).toBe('2026-06-30T04:00:00.000Z');
    expect(
      iso(startOfDay(new Date('2026-07-01T04:00:00.000Z'), 'America/New_York')),
    ).toBe('2026-07-01T04:00:00.000Z');
  });

  it('uses the winter offset in the same zone', () => {
    expect(
      iso(startOfDay(new Date('2026-01-15T12:00:00.000Z'), 'America/New_York')),
    ).toBe('2026-01-15T05:00:00.000Z');
  });

  it('handles a day containing a DST change (spring forward)', () => {
    expect(
      iso(startOfDay(new Date('2026-03-08T20:00:00.000Z'), 'America/New_York')),
    ).toBe('2026-03-08T05:00:00.000Z');
  });

  it('handles a half-hour offset zone (Asia/Kolkata)', () => {
    expect(
      iso(startOfDay(new Date('2026-10-17T18:29:59.000Z'), 'Asia/Kolkata')),
    ).toBe('2026-10-16T18:30:00.000Z');
    expect(
      iso(startOfDay(new Date('2026-10-17T18:30:00.000Z'), 'Asia/Kolkata')),
    ).toBe('2026-10-17T18:30:00.000Z');
  });
});
