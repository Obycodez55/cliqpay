import {
  SELF_LOCK_TOKEN_TTL_MS,
  signSelfLockToken,
  verifySelfLockToken,
} from '../self-lock-token.util';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const USER_ID = '6f1c2f1e-9a3b-4c55-8d0e-2b7c9e1a4d10';
const OTHER_USER_ID = '0a9d8c7b-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
const NOW = new Date('2026-11-10T10:00:00.000Z');

describe('self-lock token', () => {
  it('round-trips the user id', () => {
    const token = signSelfLockToken(KEY, USER_ID, NOW);
    expect(verifySelfLockToken(KEY, token, NOW)).toEqual({ userId: USER_ID });
  });

  it('is valid for 7 days and not beyond', () => {
    const token = signSelfLockToken(KEY, USER_ID, NOW);
    const justBefore = new Date(NOW.getTime() + SELF_LOCK_TOKEN_TTL_MS - 1000);
    const after = new Date(NOW.getTime() + SELF_LOCK_TOKEN_TTL_MS + 1000);
    expect(SELF_LOCK_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(verifySelfLockToken(KEY, token, justBefore)).not.toBeNull();
    expect(verifySelfLockToken(KEY, token, after)).toBeNull();
  });

  it('rejects a token signed with another key', () => {
    const token = signSelfLockToken(OTHER_KEY, USER_ID, NOW);
    expect(verifySelfLockToken(KEY, token, NOW)).toBeNull();
  });

  it('rejects a token whose user id was swapped', () => {
    const [, expiry, signature] = signSelfLockToken(KEY, USER_ID, NOW).split(
      '.',
    );
    const forged = [
      Buffer.from(OTHER_USER_ID).toString('base64url'),
      expiry,
      signature,
    ].join('.');
    expect(verifySelfLockToken(KEY, forged, NOW)).toBeNull();
  });

  it('rejects a token whose expiry was extended', () => {
    const [user, , signature] = signSelfLockToken(KEY, USER_ID, NOW).split('.');
    const farFuture = Math.floor(NOW.getTime() / 1000) + 10 * 365 * 86_400;
    const forged = [user, String(farFuture), signature].join('.');
    expect(verifySelfLockToken(KEY, forged, NOW)).toBeNull();
  });

  it.each(['', 'abc', 'a.b', 'a.b.c.d', '..', 'not a token'])(
    'rejects malformed input %p',
    (input) => {
      expect(verifySelfLockToken(KEY, input, NOW)).toBeNull();
    },
  );
});
