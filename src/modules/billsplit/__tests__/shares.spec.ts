import { Money } from '../../../shared/primitives/money';
import {
  BillSplitParticipantsInvalidException,
  BillSplitSharesInvalidException,
  BillSplitShareTooSmallException,
} from '../internal/errors';
import { computeShares } from '../internal/shares';

const ngn = (n: bigint | number) => Money.of(n, 'NGN');
const min = ngn(10_000);

describe('computeShares', () => {
  describe('equal', () => {
    it('divides the total among the initiator and participants', () => {
      const { initiatorShare, shares } = computeShares(
        'equal',
        ngn(60_000),
        [{ userId: 'a' }, { userId: 'b' }],
        min,
      );
      expect(initiatorShare.amount).toBe(20_000n);
      expect(shares.map((s) => s.amount.amount)).toEqual([20_000n, 20_000n]);
    });

    it('gives the leftover kobo to the initiator', () => {
      const { initiatorShare, shares } = computeShares(
        'equal',
        ngn(100_000),
        [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }],
        min,
      );
      expect(initiatorShare.amount).toBe(25_000n);
      expect(shares.map((s) => s.amount.amount)).toEqual([
        25_000n,
        25_000n,
        25_000n,
      ]);

      const uneven = computeShares(
        'equal',
        ngn(100_002),
        [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }],
        min,
      );
      expect(uneven.initiatorShare.amount).toBe(25_002n);
      expect(uneven.shares.map((s) => s.amount.amount)).toEqual([
        25_000n,
        25_000n,
        25_000n,
      ]);
    });

    it('rejects an equal split whose shares fall below the minimum', () => {
      expect(() =>
        computeShares(
          'equal',
          ngn(25_000),
          [{ userId: 'a' }, { userId: 'b' }],
          min,
        ),
      ).toThrow(BillSplitShareTooSmallException);
    });

    it('rejects amounts sent in equal mode', () => {
      expect(() =>
        computeShares(
          'equal',
          ngn(50_000),
          [{ userId: 'a', amount: 10_000 }],
          min,
        ),
      ).toThrow(BillSplitParticipantsInvalidException);
    });
  });

  describe('custom', () => {
    it('makes the initiator’s share the remainder', () => {
      const { initiatorShare, shares } = computeShares(
        'custom',
        ngn(100_000),
        [
          { userId: 'a', amount: 30_000 },
          { userId: 'b', amount: 20_000 },
        ],
        min,
      );
      expect(initiatorShare.amount).toBe(50_000n);
      expect(shares.map((s) => s.amount.amount)).toEqual([30_000n, 20_000n]);
    });

    it('allows the participants to cover the whole total', () => {
      const { initiatorShare } = computeShares(
        'custom',
        ngn(50_000),
        [
          { userId: 'a', amount: 30_000 },
          { userId: 'b', amount: 20_000 },
        ],
        min,
      );
      expect(initiatorShare.isZero()).toBe(true);
    });

    it('rejects amounts adding up to more than the total', () => {
      expect(() =>
        computeShares(
          'custom',
          ngn(50_000),
          [
            { userId: 'a', amount: 30_000 },
            { userId: 'b', amount: 20_001 },
          ],
          min,
        ),
      ).toThrow(BillSplitSharesInvalidException);
    });

    it('rejects a share below the minimum', () => {
      expect(() =>
        computeShares(
          'custom',
          ngn(50_000),
          [{ userId: 'a', amount: 9_999 }],
          min,
        ),
      ).toThrow(BillSplitShareTooSmallException);
    });

    it('rejects a participant without an amount', () => {
      expect(() =>
        computeShares('custom', ngn(50_000), [{ userId: 'a' }], min),
      ).toThrow(BillSplitParticipantsInvalidException);
    });
  });
});
