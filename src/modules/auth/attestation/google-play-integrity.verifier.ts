import { createDecipheriv, createHash, createPublicKey, verify } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import { AttestationResult } from '../entities/trusted-device.entity';
import { DeviceAttestationInput } from './device-attestation-verifier';

const MAX_TOKEN_AGE_MS = 5 * 60 * 1000;
const AES_KEY_WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

interface IntegrityPayload {
  requestDetails?: {
    requestPackageName?: string;
    nonce?: string;
    timestampMillis?: string;
  };
  appIntegrity?: { appRecognitionVerdict?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

// Decrypts and verifies the standard-request integrity token locally with the
// response-encryption keys from the Play Console: a JWE (A256KW + A256GCM)
// wrapping an ES256 JWS signed by Google.
@Injectable()
export class GooglePlayIntegrityVerifier {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  verify(input: DeviceAttestationInput): AttestationResult {
    const { google } = this.config.device.attestation;
    if (
      !google.packageName ||
      !google.decryptionKey ||
      !google.verificationKey
    ) {
      return 'failed';
    }
    try {
      const payload = this.decode(
        input.token,
        google.decryptionKey,
        google.verificationKey,
      );
      return this.judge(payload, input.clientData, google.packageName)
        ? 'passed'
        : 'failed';
    } catch {
      return 'failed';
    }
  }

  private decode(
    token: string,
    decryptionKey: string,
    verificationKey: string,
  ): IntegrityPayload {
    const [header, wrappedKey, iv, ciphertext, tag] = token.split('.');
    if (!header || !wrappedKey || !iv || !ciphertext || !tag) {
      throw new Error('Malformed JWE');
    }
    const kek = Buffer.from(decryptionKey, 'base64');
    const unwrap = createDecipheriv('id-aes256-wrap', kek, AES_KEY_WRAP_IV);
    const cek = Buffer.concat([
      unwrap.update(Buffer.from(wrappedKey, 'base64url')),
      unwrap.final(),
    ]);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      cek,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(header, 'ascii'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const jws = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    const [jwsHeader, jwsPayload, jwsSignature] = jws.split('.');
    const key = createPublicKey({
      key: Buffer.from(verificationKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const signatureValid = verify(
      'sha256',
      Buffer.from(`${jwsHeader}.${jwsPayload}`, 'ascii'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(jwsSignature, 'base64url'),
    );
    if (!signatureValid) throw new Error('Bad integrity signature');
    return JSON.parse(
      Buffer.from(jwsPayload, 'base64url').toString('utf8'),
    ) as IntegrityPayload;
  }

  private judge(
    payload: IntegrityPayload,
    clientData: Buffer,
    packageName: string,
  ): boolean {
    const details = payload.requestDetails;
    const expectedNonce = createHash('sha256')
      .update(clientData)
      .digest('base64url');
    if (details?.requestPackageName !== packageName) return false;
    if (details.nonce !== expectedNonce) return false;
    const issuedAt = Number(details.timestampMillis);
    if (
      !Number.isFinite(issuedAt) ||
      Date.now() - issuedAt > MAX_TOKEN_AGE_MS
    ) {
      return false;
    }
    if (payload.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
      return false;
    }
    return (
      payload.deviceIntegrity?.deviceRecognitionVerdict?.includes(
        'MEETS_DEVICE_INTEGRITY',
      ) ?? false
    );
  }
}
