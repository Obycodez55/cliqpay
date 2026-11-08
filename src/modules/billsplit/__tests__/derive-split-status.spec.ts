import { deriveSplitStatus } from '../internal/split-status';

describe('deriveSplitStatus', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const future = new Date('2026-01-20T00:00:00Z');
  const past = new Date('2026-01-01T00:00:00Z');

  it('puts cancelled first, even when every share is paid or the split has expired', () => {
    expect(
      deriveSplitStatus({ cancelledAt: now, expiresAt: future }, ['paid'], now),
    ).toBe('cancelled');
    expect(
      deriveSplitStatus(
        { cancelledAt: now, expiresAt: past },
        ['cancelled', 'paid'],
        now,
      ),
    ).toBe('cancelled');
  });

  it('is completed, then closed, ahead of expired', () => {
    const split = { cancelledAt: null, expiresAt: past };
    expect(deriveSplitStatus(split, ['paid', 'paid'], now)).toBe('completed');
    expect(deriveSplitStatus(split, ['paid', 'declined'], now)).toBe('closed');
  });

  it('is expired past expiresAt with a share unpaid, and open otherwise', () => {
    expect(
      deriveSplitStatus(
        { cancelledAt: null, expiresAt: past },
        ['paid', 'expired'],
        now,
      ),
    ).toBe('expired');
    expect(
      deriveSplitStatus(
        { cancelledAt: null, expiresAt: future },
        ['paid', 'pending'],
        now,
      ),
    ).toBe('open');
  });
});
