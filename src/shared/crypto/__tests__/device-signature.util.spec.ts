import { generateKeyPairSync, sign } from 'crypto';
import {
  buildSigningString,
  InvalidDevicePublicKeyError,
  normalizeDevicePublicKey,
  verifyDeviceSignature,
} from '../device-signature.util';

function newKey(namedCurve = 'prime256v1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { spki, privateKey };
}

const signDer = (
  privateKey: ReturnType<typeof newKey>['privateKey'],
  data: Buffer,
) =>
  sign('sha256', data, { key: privateKey, dsaEncoding: 'der' }).toString(
    'base64',
  );

describe('buildSigningString', () => {
  it('joins parts with LF as UTF-8', () => {
    expect(buildSigningString(['login', 'abc', 'dev-1']).toString()).toBe(
      'login\nabc\ndev-1',
    );
  });

  it('refuses a part containing LF', () => {
    expect(() => buildSigningString(['a\nb'])).toThrow();
  });
});

describe('normalizeDevicePublicKey', () => {
  it('stores a raw 65-byte uncompressed point as SPKI', () => {
    const { spki } = newKey();
    const raw = spki.subarray(-65).toString('base64');

    expect(normalizeDevicePublicKey(raw)).toBe(spki.toString('base64'));
  });

  it('keeps an SPKI key as it is', () => {
    const { spki } = newKey();

    expect(normalizeDevicePublicKey(spki.toString('base64'))).toBe(
      spki.toString('base64'),
    );
  });

  it('rejects other curves, garbage and empty input', () => {
    const p384 = newKey('secp384r1').spki.toString('base64');

    expect(() => normalizeDevicePublicKey(p384)).toThrow(
      InvalidDevicePublicKeyError,
    );
    expect(() => normalizeDevicePublicKey('AAAA')).toThrow(
      InvalidDevicePublicKeyError,
    );
    expect(() => normalizeDevicePublicKey('')).toThrow(
      InvalidDevicePublicKeyError,
    );
  });
});

describe('verifyDeviceSignature', () => {
  const data = buildSigningString(['refresh', 'nonce', 'device-1']);

  it('accepts a DER signature from the matching key', () => {
    const { spki, privateKey } = newKey();

    expect(
      verifyDeviceSignature(
        spki.toString('base64'),
        data,
        signDer(privateKey, data),
      ),
    ).toBe(true);
  });

  it('rejects another key, other data and malformed input without throwing', () => {
    const { spki, privateKey } = newKey();
    const other = newKey();
    const key = spki.toString('base64');

    expect(
      verifyDeviceSignature(key, data, signDer(other.privateKey, data)),
    ).toBe(false);
    expect(
      verifyDeviceSignature(
        key,
        buildSigningString(['refresh', 'nonce', 'device-2']),
        signDer(privateKey, data),
      ),
    ).toBe(false);
    expect(verifyDeviceSignature(key, data, 'not-a-signature')).toBe(false);
    expect(
      verifyDeviceSignature('garbage', data, signDer(privateKey, data)),
    ).toBe(false);
  });
});
