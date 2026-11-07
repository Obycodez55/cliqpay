import { Money } from '../money';

describe('Money', () => {
  it('adds and subtracts within the same currency', () => {
    const a = Money.of(1000n, 'NGN');
    const b = Money.of(250n, 'NGN');

    expect(a.add(b).amount).toBe(1250n);
    expect(a.subtract(b).amount).toBe(750n);
  });

  it('throws on cross-currency arithmetic', () => {
    const ngn = Money.of(1000n, 'NGN');
    const usd = Money.of(1000n, 'USD');

    expect(() => ngn.add(usd)).toThrow(/currency mismatch/);
    expect(() => ngn.subtract(usd)).toThrow(/currency mismatch/);
    expect(() => ngn.greaterThan(usd)).toThrow(/currency mismatch/);
  });

  it('computes a platform fee via integer basis-point ratio, no floats', () => {
    // 1.5% of ₦100,000.00 (10,000,000 kobo) = ₦1,500.00 (150,000 kobo)
    const amount = Money.of(10_000_000n, 'NGN');
    const fee = amount.multiplyByRatio(150n, 10_000n);

    expect(fee.amount).toBe(150_000n);
  });

  it('truncates (rounds toward zero) on non-exact ratios', () => {
    // 1 kobo * 1/3 = 0.33... -> truncates to 0
    const amount = Money.of(1n, 'NGN');
    expect(amount.multiplyByRatio(1n, 3n).amount).toBe(0n);
  });

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = Money.of(9_007_199_254_740_993n, 'NGN'); // MAX_SAFE_INTEGER + 2
    const doubled = huge.add(huge);
    expect(doubled.amount).toBe(18_014_398_509_481_986n);
  });

  it('reports sign correctly', () => {
    expect(Money.zero('NGN').isZero()).toBe(true);
    expect(Money.of(1n, 'NGN').isPositive()).toBe(true);
    expect(Money.of(-1n, 'NGN').isNegative()).toBe(true);
  });

  it('compares amounts', () => {
    const small = Money.of(100n, 'NGN');
    const large = Money.of(200n, 'NGN');
    expect(large.greaterThan(small)).toBe(true);
    expect(small.lessThan(large)).toBe(true);
    expect(small.equals(Money.of(100n, 'NGN'))).toBe(true);
  });

  it('formats as a decimal string using the currency minor-unit exponent', () => {
    expect(Money.of(150_000n, 'NGN').toDecimalString()).toBe('1500.00');
    expect(Money.of(5n, 'NGN').toDecimalString()).toBe('0.05');
    expect(Money.of(-5n, 'NGN').toDecimalString()).toBe('-0.05');
  });

  it('rejects an unknown currency when formatting', () => {
    expect(() => Money.of(100n, 'XYZ').toDecimalString()).toThrow(
      /Unknown currency/,
    );
  });

  it('parses a decimal string into minor units', () => {
    expect(Money.fromDecimalString('1500.00', 'NGN').amount).toBe(150_000n);
    expect(Money.fromDecimalString('0.05', 'NGN').amount).toBe(5n);
    expect(Money.fromDecimalString('-0.05', 'NGN').amount).toBe(-5n);
    expect(Money.fromDecimalString('13.9', 'NGN').amount).toBe(1390n);
    expect(Money.fromDecimalString('13', 'NGN').amount).toBe(1300n);
  });

  it('round-trips through toDecimalString/fromDecimalString', () => {
    const money = Money.of(150_000n, 'NGN');
    expect(Money.fromDecimalString(money.toDecimalString(), 'NGN').amount).toBe(
      money.amount,
    );
  });

  it('rejects a decimal string with too many fractional digits', () => {
    expect(() => Money.fromDecimalString('1.005', 'NGN')).toThrow(
      /more than 2 fractional digits/,
    );
  });

  it('rejects a malformed decimal string', () => {
    expect(() => Money.fromDecimalString('abc', 'NGN')).toThrow(
      /invalid decimal/,
    );
  });

  it('serializes losslessly to JSON as a string, not a float', () => {
    const money = Money.of(9_007_199_254_740_993n, 'NGN');
    expect(JSON.stringify(money)).toBe(
      '{"amount":"9007199254740993","currency":"NGN"}',
    );
  });
  describe('allocate', () => {
    it('splits evenly when the total divides', () => {
      const shares = Money.of(900n, 'NGN').allocate(3);
      expect(shares.map((s) => s.amount)).toEqual([300n, 300n, 300n]);
    });

    it('gives the whole leftover to the first share', () => {
      const shares = Money.of(1000n, 'NGN').allocate(3);
      expect(shares.map((s) => s.amount)).toEqual([334n, 333n, 333n]);
    });

    it('gives a leftover larger than one kobo to the first share', () => {
      const shares = Money.of(109n, 'NGN').allocate(10);
      expect(shares.map((s) => s.amount)).toEqual([
        19n,
        ...Array<bigint>(9).fill(10n),
      ]);
    });

    it('returns the whole amount as a single share', () => {
      expect(
        Money.of(777n, 'NGN')
          .allocate(1)
          .map((s) => s.amount),
      ).toEqual([777n]);
    });

    it('gives the first share everything when the total is below the part count', () => {
      const shares = Money.of(2n, 'NGN').allocate(5);
      expect(shares.map((s) => s.amount)).toEqual([2n, 0n, 0n, 0n, 0n]);
    });

    it('allocates zero as all zero shares', () => {
      const shares = Money.zero('NGN').allocate(3);
      expect(shares.map((s) => s.amount)).toEqual([0n, 0n, 0n]);
    });

    it('keeps the currency and loses no kobo', () => {
      const total = Money.of(9_007_199_254_740_993n, 'NGN');
      const shares = total.allocate(7);
      expect(shares).toHaveLength(7);
      expect(shares.every((s) => s.currency === 'NGN')).toBe(true);
      expect(shares.reduce((sum, s) => sum + s.amount, 0n)).toBe(total.amount);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects %s parts', (parts) => {
      expect(() => Money.of(100n, 'NGN').allocate(parts)).toThrow(
        /positive integer/,
      );
    });

    it('rejects a negative amount', () => {
      expect(() => Money.of(-100n, 'NGN').allocate(2)).toThrow(/negative/);
    });
  });
});
