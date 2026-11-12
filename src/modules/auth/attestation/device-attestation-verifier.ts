import { AttestationResult } from '../entities/trusted-device.entity';

export const ATTESTATION_PLATFORMS = ['ios', 'android'] as const;
export type AttestationPlatform = (typeof ATTESTATION_PLATFORMS)[number];

export interface DeviceAttestationInput {
  platform: AttestationPlatform;
  // iOS only: the App Attest key identifier (base64).
  keyId?: string;
  // iOS: the base64 App Attest attestation object. Android: the Play
  // Integrity token.
  token: string;
  // The bytes the platform was asked to attest. iOS hashes them into the
  // App Attest clientDataHash; Android passes base64url(SHA-256(clientData))
  // as the Play Integrity nonce.
  clientData: Buffer;
}

export interface DeviceAttestationVerifier {
  verify(input: DeviceAttestationInput): Promise<AttestationResult>;
}

export const DEVICE_ATTESTATION_VERIFIER = Symbol(
  'DEVICE_ATTESTATION_VERIFIER',
);
