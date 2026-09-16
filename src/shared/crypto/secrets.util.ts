import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

// Recoverable encryption for values the app must read back in plaintext
// (a TOTP secret to compute a code, a bank account number to hand to a
// payout provider) — distinct from the one-way hashing used everywhere
// else for bearer secrets, where the plaintext is never needed again. Keyed
// from the `encryption` config namespace.
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

// A deterministic, keyed digest for exact-match lookups against a value
// that's stored encrypted (and therefore non-deterministic, one ciphertext
// per write) — e.g. bank_accounts' uniqueness constraint, which can't be
// enforced against the ciphertext column itself. Not a substitute for
// encryptSecret: this is one-way, for equality checks only, never for
// recovering the original value.
export function hmacHex(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex');
}
