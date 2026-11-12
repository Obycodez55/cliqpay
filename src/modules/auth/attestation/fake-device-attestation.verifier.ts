import { Injectable } from '@nestjs/common';
import { AttestationResult } from '../entities/trusted-device.entity';
import {
  DeviceAttestationInput,
  DeviceAttestationVerifier,
} from './device-attestation-verifier';

// The token alone decides the outcome: "pass" passes, "unavailable" reports
// a device that cannot attest, anything else fails.
@Injectable()
export class FakeDeviceAttestationVerifier implements DeviceAttestationVerifier {
  verify(input: DeviceAttestationInput): Promise<AttestationResult> {
    if (input.token === 'pass') return Promise.resolve('passed');
    if (input.token === 'unavailable') return Promise.resolve('unavailable');
    return Promise.resolve('failed');
  }
}
