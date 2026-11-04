import { deriveTier, tierRank } from '../internal/tier';

describe('deriveTier', () => {
  it('returns tier0 when nothing is verified', () => {
    expect(
      deriveTier({
        bvnVerified: false,
        ninVerified: false,
        livenessVerified: false,
      }),
    ).toBe('tier0');
  });

  it.each([
    [
      { bvnVerified: true, ninVerified: false, livenessVerified: false },
      'tier1',
    ],
    [
      { bvnVerified: false, ninVerified: true, livenessVerified: false },
      'tier1',
    ],
    [
      { bvnVerified: true, ninVerified: false, livenessVerified: true },
      'tier1',
    ],
  ] as const)('returns tier1 for %j', (state, expected) => {
    expect(deriveTier(state)).toBe(expected);
  });

  it('returns tier2 when both bvn and nin are verified but liveness is not', () => {
    expect(
      deriveTier({
        bvnVerified: true,
        ninVerified: true,
        livenessVerified: false,
      }),
    ).toBe('tier2');
  });

  it('returns tier3 when bvn, nin, and liveness are all verified', () => {
    expect(
      deriveTier({
        bvnVerified: true,
        ninVerified: true,
        livenessVerified: true,
      }),
    ).toBe('tier3');
  });

  it('never reaches tier3 without both bvn and nin, even with liveness passed', () => {
    expect(
      deriveTier({
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: true,
      }),
    ).toBe('tier1');
  });
});

describe('tierRank', () => {
  it('orders tiers strictly ascending', () => {
    expect(tierRank('tier0')).toBeLessThan(tierRank('tier1'));
    expect(tierRank('tier1')).toBeLessThan(tierRank('tier2'));
    expect(tierRank('tier2')).toBeLessThan(tierRank('tier3'));
  });
});
