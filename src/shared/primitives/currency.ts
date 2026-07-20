// Every currency the system knows about needs a minor-unit exponent —
// see docs/architecture.md §2. Widen this map (and the CHECK constraints
// in the DB, per §5) as currencies are activated in later phases.
export const CURRENCY_MINOR_UNIT_EXPONENTS = {
  NGN: 2,
  USD: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_MINOR_UNIT_EXPONENTS;

export function minorUnitExponent(currency: string): number {
  const exponent = CURRENCY_MINOR_UNIT_EXPONENTS[currency as CurrencyCode];
  if (exponent === undefined) {
    throw new Error(`Unknown currency: ${currency}`);
  }
  return exponent;
}
