import { deriveOutcome } from '../internal/split-status';

describe('deriveOutcome', () => {
  it('is completed when every share is paid', () => {
    expect(deriveOutcome(['paid', 'paid'])).toBe('completed');
  });

  it('is closed when every share is settled and some were declined or cancelled', () => {
    expect(deriveOutcome(['paid', 'declined'])).toBe('closed');
    expect(deriveOutcome(['cancelled', 'paid', 'declined'])).toBe('closed');
    expect(deriveOutcome(['declined'])).toBe('closed');
  });

  it('is neither while any share is pending', () => {
    expect(deriveOutcome(['paid', 'pending'])).toBeNull();
    expect(deriveOutcome(['declined', 'pending'])).toBeNull();
  });

  it('is neither while any share has expired unpaid', () => {
    expect(deriveOutcome(['paid', 'expired'])).toBeNull();
    expect(deriveOutcome(['declined', 'expired'])).toBeNull();
  });
});
