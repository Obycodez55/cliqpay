import { createHash, randomBytes } from 'crypto';

// Deliberately parallel to refresh-token.util.ts rather than reusing it —
// same reasoning (high-entropy random value, SHA-256 not bcrypt — see
// docs/architecture.md §3.7), but a separate concern free to evolve its own
// token shape/length without coupling to refresh tokens.
export function generateTrustedDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashTrustedDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
