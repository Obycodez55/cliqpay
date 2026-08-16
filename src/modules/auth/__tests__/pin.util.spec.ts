import {
  compareTransactionPin,
  hashTransactionPin,
} from '../internal/pin.util';

const PEPPER_A = 'a'.repeat(64);
const PEPPER_B = 'b'.repeat(64);

describe('pin.util', () => {
  it('round-trips a PIN through hash and compare', async () => {
    const hash = await hashTransactionPin('4837', PEPPER_A);
    expect(await compareTransactionPin('4837', PEPPER_A, hash)).toBe(true);
  });

  it('rejects the wrong PIN against a valid hash', async () => {
    const hash = await hashTransactionPin('4837', PEPPER_A);
    expect(await compareTransactionPin('9999', PEPPER_A, hash)).toBe(false);
  });

  it('rejects the correct PIN hashed/compared under a different pepper', async () => {
    const hash = await hashTransactionPin('4837', PEPPER_A);
    expect(await compareTransactionPin('4837', PEPPER_B, hash)).toBe(false);
  });

  it('never stores the raw PIN or its bare HMAC in the resulting hash', async () => {
    const hash = await hashTransactionPin('4837', PEPPER_A);
    expect(hash).not.toContain('4837');
  });
});
