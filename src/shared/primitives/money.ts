import { minorUnitExponent } from './currency';

/**
 * The single place integer minor-unit arithmetic happens — see
 * docs/architecture.md §2. Every module doing money math routes through
 * this instead of scattering bigint/number arithmetic through services.
 * Internally always a bigint; never touches `number` or `decimal`.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

  static of(minorUnits: bigint | number, currency: string): Money {
    return new Money(BigInt(minorUnits), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  get amount(): bigint {
    return this.minorUnits;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  /**
   * Applies a ratio (e.g. a fee rate expressed in basis points as
   * `multiplyByRatio(150n, 10000n)` for 1.5%) using integer division only.
   * Rounds toward zero (truncates) — callers needing a different rounding
   * rule round explicitly on the result rather than this method guessing.
   */
  multiplyByRatio(numerator: bigint, denominator: bigint): Money {
    if (denominator === 0n) {
      throw new Error('Money.multiplyByRatio: denominator must not be zero');
    }
    return new Money(
      (this.minorUnits * numerator) / denominator,
      this.currency,
    );
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Decimal display only — logs, emails, UI. Never used for arithmetic. */
  toDecimalString(): string {
    const exponent = minorUnitExponent(this.currency);
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const divisor = 10n ** BigInt(exponent);
    const whole = abs / divisor;
    const fraction = (abs % divisor).toString().padStart(exponent, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON() {
    return { amount: this.minorUnits.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Money currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}
