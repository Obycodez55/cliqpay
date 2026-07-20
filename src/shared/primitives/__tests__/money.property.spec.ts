import fc from 'fast-check';
import { Money } from '../money';

// Property-based coverage per docs/architecture.md §10: rather than
// hand-picked examples, generate random valid inputs and assert invariants
// that must hold for *any* of them. FC_NUM_RUNS lets CI run a higher
// iteration count nightly than on every PR without changing the test code.
const numRuns = process.env.FC_NUM_RUNS
  ? parseInt(process.env.FC_NUM_RUNS, 10)
  : 100;

// Keep generated amounts within a range that can't overflow Postgres bigint
// (±2^63) even after being added together in a test.
const minorUnitsArb = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

describe('Money — properties', () => {
  it('add is commutative', () => {
    fc.assert(
      fc.property(minorUnitsArb, minorUnitsArb, (a, b) => {
        const x = Money.of(a, 'NGN');
        const y = Money.of(b, 'NGN');
        return x.add(y).equals(y.add(x));
      }),
      { numRuns },
    );
  });

  it('add is associative', () => {
    fc.assert(
      fc.property(minorUnitsArb, minorUnitsArb, minorUnitsArb, (a, b, c) => {
        const x = Money.of(a, 'NGN');
        const y = Money.of(b, 'NGN');
        const z = Money.of(c, 'NGN');
        return x
          .add(y)
          .add(z)
          .equals(x.add(y.add(z)));
      }),
      { numRuns },
    );
  });

  it('subtract is the inverse of add', () => {
    fc.assert(
      fc.property(minorUnitsArb, minorUnitsArb, (a, b) => {
        const x = Money.of(a, 'NGN');
        const y = Money.of(b, 'NGN');
        return x.add(y).subtract(y).equals(x);
      }),
      { numRuns },
    );
  });

  it('adding zero never changes the amount', () => {
    fc.assert(
      fc.property(minorUnitsArb, (a) => {
        const x = Money.of(a, 'NGN');
        return x.add(Money.zero('NGN')).equals(x);
      }),
      { numRuns },
    );
  });
});
