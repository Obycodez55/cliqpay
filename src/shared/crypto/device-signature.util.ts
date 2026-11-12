import { createPublicKey, KeyObject, verify } from 'crypto';

const SIGNING_SEPARATOR = '\n';

// DER prefix of an X.509 SubjectPublicKeyInfo for an EC P-256 key, up to and
// including the BIT STRING header; the 65-byte uncompressed point follows.
const P256_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex',
);
const P256_RAW_LENGTH = 65;

export class InvalidDevicePublicKeyError extends Error {}

/**
 * The byte string a device signs: the parts joined with a single LF (0x0A),
 * encoded as UTF-8. Parts are ASCII identifiers or decimal numbers and may
 * not contain LF, so the encoding is unambiguous.
 */
export function buildSigningString(parts: readonly string[]): Buffer {
  for (const part of parts) {
    if (part.includes(SIGNING_SEPARATOR)) {
      throw new Error('Signing string parts must not contain a line feed');
    }
  }
  return Buffer.from(parts.join(SIGNING_SEPARATOR), 'utf8');
}

/**
 * Accepts a base64 P-256 public key as either the raw 65-byte uncompressed
 * point (0x04 ‖ X ‖ Y) or an X.509 SPKI DER, and returns the SPKI DER as
 * base64 — the only form stored.
 */
export function normalizeDevicePublicKey(input: string): string {
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length === 0) {
    throw new InvalidDevicePublicKeyError('Public key is empty');
  }
  const der =
    bytes.length === P256_RAW_LENGTH && bytes[0] === 0x04
      ? Buffer.concat([P256_SPKI_PREFIX, bytes])
      : bytes;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new InvalidDevicePublicKeyError('Public key is not valid');
  }
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new InvalidDevicePublicKeyError(
      'Public key must be an ECDSA P-256 key',
    );
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

/**
 * ECDSA P-256 over SHA-256 of `signingString`; `signatureDerBase64` is the
 * ASN.1 DER signature in standard base64. Never throws on malformed input.
 */
export function verifyDeviceSignature(
  publicKeySpkiBase64: string,
  signingString: Buffer,
  signatureDerBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      'sha256',
      signingString,
      { key, dsaEncoding: 'der' },
      Buffer.from(signatureDerBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
