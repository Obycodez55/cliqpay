import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const OPAQUE_TOKEN_BYTES = 32;

// TOTP secret compromise is a silent, undetectable MFA bypass — see
// docs/architecture.md §3.8 / issue #4 — so it's encrypted at rest with a
// key from the `encryption` config namespace, distinct from hashing (used
// everywhere else in auth) because the plaintext must be recoverable to
// generate/verify codes.
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptSecret(packed: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = packed.split('.');
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function encryptionKeyFromHex(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

// A bearer secret (refresh token, trusted-device token, verification code) is
// a high-entropy random value, not a human password — see
// docs/architecture.md §3.7 — so it's hashed with plain SHA-256 (fast,
// indexable) rather than bcrypt (deliberately slow, meant for low-entropy
// human secrets). One implementation shared across every caller that needs
// this shape rather than a per-feature copy: the logic never actually
// varies by feature, only the column it ends up hashed into.
export function generateOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
