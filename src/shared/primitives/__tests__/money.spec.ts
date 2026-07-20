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

  it('serializes losslessly to JSON as a string, not a float', () => {
    const money = Money.of(9_007_199_254_740_993n, 'NGN');
    expect(JSON.stringify(money)).toBe(
      '{"amount":"9007199254740993","currency":"NGN"}',
    );
  });
});
