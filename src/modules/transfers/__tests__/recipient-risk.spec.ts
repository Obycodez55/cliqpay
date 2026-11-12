import {
  NEW_RECIPIENT_ACCOUNT_AGE_MS,
  RecipientRiskFacts,
  recipientRiskWarnings,
} from '../internal/recipient-risk';

const now = new Date('2026-11-11T12:00:00Z');

function facts(
  overrides: Partial<RecipientRiskFacts> = {},
): RecipientRiskFacts {
  return {
    amountMinor: 100_000n,
    firstPaymentThresholdMinor: 2_000_000n,
    isFirstPayment: true,
    recipientCreatedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    recipientHasEnforcedFlag: false,
    now,
    ...overrides,
  };
}

describe('recipientRiskWarnings', () => {
  it('returns nothing for an ordinary payment', () => {
    expect(recipientRiskWarnings(facts())).toEqual([]);
  });

  it('warns on a first payment at the threshold, not just under it', () => {
    expect(recipientRiskWarnings(facts({ amountMinor: 1_999_999n }))).toEqual(
      [],
    );
    expect(recipientRiskWarnings(facts({ amountMinor: 2_000_000n }))).toEqual([
      'FIRST_PAYMENT_LARGE_AMOUNT',
    ]);
  });

  it('does not warn on a large payment to a recipient already paid', () => {
    expect(
      recipientRiskWarnings(
        facts({ amountMinor: 5_000_000n, isFirstPayment: false }),
      ),
    ).toEqual([]);
  });

  it('warns on an account under 7 days old and not at exactly 7 days', () => {
    expect(
      recipientRiskWarnings(
        facts({
          recipientCreatedAt: new Date(
            now.getTime() - NEW_RECIPIENT_ACCOUNT_AGE_MS + 1,
          ),
        }),
      ),
    ).toEqual(['RECIPIENT_NEW_ACCOUNT']);
    expect(
      recipientRiskWarnings(
        facts({
          recipientCreatedAt: new Date(
            now.getTime() - NEW_RECIPIENT_ACCOUNT_AGE_MS,
          ),
        }),
      ),
    ).toEqual([]);
  });

  it('warns on an enforced open flag and reports every code that applies', () => {
    expect(
      recipientRiskWarnings(
        facts({
          amountMinor: 3_000_000n,
          recipientCreatedAt: now,
          recipientHasEnforcedFlag: true,
        }),
      ),
    ).toEqual([
      'FIRST_PAYMENT_LARGE_AMOUNT',
      'RECIPIENT_NEW_ACCOUNT',
      'RECIPIENT_UNUSUAL_ACTIVITY',
    ]);
  });
});
