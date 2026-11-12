import { Injectable } from '@nestjs/common';
import { AttestationResult } from '../entities/trusted-device.entity';
import { AppleAppAttestVerifier } from './apple-app-attest.verifier';
import {
  DeviceAttestationInput,
  DeviceAttestationVerifier,
} from './device-attestation-verifier';
import { GooglePlayIntegrityVerifier } from './google-play-integrity.verifier';

@Injectable()
export class PlatformDeviceAttestationVerifier implements DeviceAttestationVerifier {
  constructor(
    private readonly apple: AppleAppAttestVerifier,
    private readonly google: GooglePlayIntegrityVerifier,
  ) {}

  verify(input: DeviceAttestationInput): Promise<AttestationResult> {
    return input.platform === 'ios'
      ? this.apple.verify(input)
      : Promise.resolve(this.google.verify(input));
  }
}
