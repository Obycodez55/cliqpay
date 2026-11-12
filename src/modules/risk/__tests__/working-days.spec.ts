import { addWeekdays, subtractWeekdays } from '../internal/working-days';

const at = (iso: string) => new Date(`${iso}Z`);

describe('addWeekdays', () => {
  it('counts weekdays inside a week and keeps the time of day', () => {
    expect(addWeekdays(at('2026-11-09T10:30:00'), 3)).toEqual(
      at('2026-11-12T10:30:00'),
    );
  });

  it('skips the weekend', () => {
    expect(addWeekdays(at('2026-11-12T10:00:00'), 2)).toEqual(
      at('2026-11-16T10:00:00'),
    );
  });

  it('counts the first weekday after a weekend start as day one', () => {
    expect(addWeekdays(at('2026-11-14T10:00:00'), 1)).toEqual(
      at('2026-11-16T10:00:00'),
    );
    expect(addWeekdays(at('2026-11-15T10:00:00'), 1)).toEqual(
      at('2026-11-16T10:00:00'),
    );
  });

  it('adds fourteen weekdays as two weeks exactly', () => {
    expect(addWeekdays(at('2026-11-09T08:00:00'), 10)).toEqual(
      at('2026-11-23T08:00:00'),
    );
    expect(addWeekdays(at('2026-11-11T08:00:00'), 14)).toEqual(
      at('2026-12-01T08:00:00'),
    );
  });

  it('returns the same instant for zero and does not mutate its input', () => {
    const from = at('2026-11-13T10:00:00');
    expect(addWeekdays(from, 0)).toEqual(from);
    addWeekdays(from, 5);
    expect(from).toEqual(at('2026-11-13T10:00:00'));
  });
});

describe('subtractWeekdays', () => {
  it('steps back over a weekend', () => {
    expect(subtractWeekdays(at('2026-11-16T10:00:00'), 2)).toEqual(
      at('2026-11-12T10:00:00'),
    );
  });

  it('is the inverse of addWeekdays from a weekday', () => {
    const start = at('2026-11-10T09:00:00');
    expect(subtractWeekdays(addWeekdays(start, 14), 14)).toEqual(start);
  });
});
