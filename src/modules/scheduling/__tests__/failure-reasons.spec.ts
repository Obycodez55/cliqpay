import { FAILURE_CODES } from '../entities/scheduled-payment-attempt.entity';
import {
  CLIENT_FAILURE_CODES,
  toClientFailureCode,
  toClientFailureReason,
} from '../internal/failure-reasons';

describe('client-facing failure reasons', () => {
  it.each(['blocked', 'recipient_cap', 'recipient_unavailable'])(
    'reports %s as one recipient_unable_to_receive',
    (code) => {
      expect(toClientFailureReason(code)).toBe('recipient_unable_to_receive');
      expect(toClientFailureCode(code as never)).toBe(
        'recipient_unable_to_receive',
      );
    },
  );

  it('leaves every other code, and a missing one, as it is', () => {
    const others = FAILURE_CODES.filter(
      (code) =>
        !['blocked', 'recipient_cap', 'recipient_unavailable'].includes(code),
    );
    for (const code of others) {
      expect(toClientFailureCode(code)).toBe(code);
    }
    expect(toClientFailureReason('consecutive_failures')).toBe(
      'consecutive_failures',
    );
    expect(toClientFailureCode(null)).toBeNull();
  });

  it('lists no precise recipient-side code among the codes a client can see', () => {
    expect(CLIENT_FAILURE_CODES).not.toContain('blocked');
    expect(CLIENT_FAILURE_CODES).not.toContain('recipient_cap');
    expect(CLIENT_FAILURE_CODES).not.toContain('recipient_unavailable');
    expect(CLIENT_FAILURE_CODES).toContain('recipient_unable_to_receive');
  });
});
