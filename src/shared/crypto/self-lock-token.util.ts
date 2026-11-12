import { createHmac, timingSafeEqual } from 'crypto';

export const SELF_LOCK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DOMAIN = 'self-lock.v1';

function mac(key: Buffer, userId: string, expiresAtSeconds: string): Buffer {
  return createHmac('sha256', key)
    .update(`${DOMAIN}\n${userId}\n${expiresAtSeconds}`)
    .digest();
}

export function signSelfLockToken(
  key: Buffer,
  userId: string,
  now: Date = new Date(),
): string {
  const expiresAt = String(
    Math.floor((now.getTime() + SELF_LOCK_TOKEN_TTL_MS) / 1000),
  );
  return [
    Buffer.from(userId).toString('base64url'),
    expiresAt,
    mac(key, userId, expiresAt).toString('base64url'),
  ].join('.');
}

export function verifySelfLockToken(
  key: Buffer,
  token: string,
  now: Date = new Date(),
): { userId: string; issuedAtLatest: Date } | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [encodedUser, expiresAt, signature] = parts;
  if (!/^\d{1,12}$/.test(expiresAt)) {
    return null;
  }
  const userId = Buffer.from(encodedUser, 'base64url').toString();
  const expected = mac(key, userId, expiresAt);
  const provided = Buffer.from(signature, 'base64url');
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  if (Number(expiresAt) * 1000 <= now.getTime()) {
    return null;
  }
  return {
    userId,
    issuedAtLatest: new Date(
      Number(expiresAt) * 1000 - SELF_LOCK_TOKEN_TTL_MS + 999,
    ),
  };
}
