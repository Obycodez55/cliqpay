import { Injectable } from '@nestjs/common';
import {
  KycProvider,
  KycVerificationResult,
  KycVerifyOptions,
} from './kyc-provider.interface';

// BVNs and NINs are digits-only, so sentinels are prefixes: "0000" is not_found, "1111" is mismatch.
@Injectable()
export class FakeKycProvider implements KycProvider {
  verifyBvn(
    bvn: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult> {
    return this.verify('Bvn Test User', bvn, options);
  }

  verifyNin(
    nin: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult> {
    return this.verify('Nin Test User', nin, options);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async verify(
    legalName: string,
    idNumber: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult> {
    if (idNumber.startsWith('0000')) {
      return { status: 'not_found' };
    }
    if (idNumber.startsWith('1111')) {
      return { status: 'mismatch' };
    }
    return {
      status: 'verified',
      legalName,
      address: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
      livenessPassed: options?.selfie ? true : undefined,
    };
  }
}
