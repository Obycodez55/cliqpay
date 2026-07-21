import { createHash, randomBytes } from 'crypto';

// A refresh token is a high-entropy random value, not a JWT and not a human
// secret — see docs/architecture.md §3.7. That's why it's hashed with plain
// SHA-256 (fast, indexable) rather than bcrypt (deliberately slow, meant for
// low-entropy human passwords).
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
