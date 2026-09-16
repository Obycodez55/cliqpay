import { createHash, randomBytes, randomInt } from 'crypto';

const OPAQUE_TOKEN_BYTES = 32;
const NUMERIC_CODE_MODULUS = 1_000_000;

// A bearer secret (refresh token, trusted-device token, verification code)
// is a high-entropy random value, not a human password — hashed with plain
// SHA-256 (fast, indexable), not bcrypt.
export function generateOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Short enough to read off an SMS and type into a form — unlike the opaque
// token above, hashed the same way via hashOpaqueToken since both are just
// bearer secrets to a lookup-by-hash, regardless of how they're generated.
export function generateNumericCode(): string {
  return randomInt(0, NUMERIC_CODE_MODULUS).toString().padStart(6, '0');
}
