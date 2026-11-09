import { createPublicKey, generateKeyPairSync, KeyObject, sign } from 'crypto';
import { buildSigningString } from '../../../src/shared/crypto/device-signature.util';
import { TEST_DEVICE_ID } from './device-defaults';

export interface TestDeviceKey {
  deviceId: string;
  publicKeyRawBase64: string;
  publicKeySpkiBase64: string;
  privateKey: KeyObject;
  signChallenge: (purpose: string, nonce: string) => string;
}

export function createTestDeviceKey(deviceId = TEST_DEVICE_ID): TestDeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    deviceId,
    publicKeyRawBase64: spki.subarray(-65).toString('base64'),
    publicKeySpkiBase64: spki.toString('base64'),
    privateKey,
    signChallenge: (purpose, nonce) =>
      signWith(privateKey, buildSigningString([purpose, nonce, deviceId])),
  };
}

export function signWith(privateKey: KeyObject, data: Buffer): string {
  return sign('sha256', data, { key: privateKey, dsaEncoding: 'der' }).toString(
    'base64',
  );
}

export function spkiOf(key: KeyObject): string {
  return createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}
